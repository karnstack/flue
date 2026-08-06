// Enrolling a daemon: the device-authorization handshake behind `flue enable`.
//
// The shape is RFC 8628's, because the situation is the one it was written
// for: a program on a machine with no browser needs a credential from a
// service the user is logged into somewhere else. Three calls:
//
//   1. `startDeviceAuth`  — the daemon, unauthenticated. Mints a short code for
//      the human and an opaque one for itself, and writes a ten-minute grant.
//   2. `confirmDeviceAuth` — the browser, signed in. The user types the short
//      code and the grant is bound to their account.
//   3. `pollDeviceAuth`   — the daemon, unauthenticated, every few seconds.
//      `pending` until step 2, and then, exactly once, the device's id and its
//      enrollment token.
//
// Three properties are load-bearing, and each is a line you can point at.
//
// **Nothing a caller presents is stored in the clear.** The device code is 32
// CSPRNG bytes and the table holds `sha256(code)`, so a dump of `device_auth`
// cannot be polled with. The enrollment token is the same: `devices.token_hash`
// is a digest and the token itself exists only in the response that carries it.
//
// **The token is minted on the approving poll, not at confirmation.** There is
// nowhere to keep a raw token between two requests — `device_auth` has no
// column for one, deliberately, and `devices.token_hash` is NOT NULL — so
// `confirmDeviceAuth` records *who* approved and *which device*, and the first
// poll that sees an approved grant mints the token, writes the device and
// deletes the grant in a single `db.batch`. One transaction is what makes an
// approved code single-use: split in two, a crash between them either leaves a
// grant that mints a fresh device on every poll or a device the daemon has no
// token for.
//
// **A device's id is its key.** `devices.id` is `sha256(pubkey)[:12]`, the same
// twelve characters the daemon computes for itself (lib/device-id), which
// means it is a *content-derived* primary key: a daemon that enrolls again —
// after a revoke, onto a second account — collides with its own old row. The
// mint step is therefore an upsert on that id, and a re-enrolment replaces the
// previous row wholesale: new owner, new label, new token, and the old row's
// `disabled` and `last_seen` cleared. Anything else would either fail with a
// constraint error or resurrect a revocation.
//
// **But only the account that already owns a device may replace it.** A Noise
// static public key is not a secret — it is printed in the pairing URL's `k=`
// parameter and sent in the clear as `DaemonPub` on the wire — so "presents
// this key" proves nothing, and the upsert above, left unscoped, would let any
// signed-in stranger who knows a key open a grant for it, confirm with their
// own session, poll once, and take the row: the victim's daemon silently
// de-enrolled, its token dead, its id now pointing at somebody else's account.
// The conflict update therefore carries a `where` (`setWhere` below) that
// requires the *existing* row's `user_id` to be the incoming one, and a
// suppressed update is reported to the caller as `conflict`. See the note on
// the mint itself for the residual this leaves.
import { getRequestUrl } from '@tanstack/react-start/server'
import { and, eq, gt, isNotNull, isNull, lt, or, sql } from 'drizzle-orm'
import { db } from '../db/client'
import { deviceAuth, devices } from '../db/schema'
import { decodePublicKey, deviceIdFromKey, encodePublicKey } from '../lib/device-id'
import { randomToken, sha256Hex } from '../lib/tokens'
import { LONGEST_WINDOW_S, SWEEP_ONE_IN, clientIp, withinLimit } from './ratelimit'
import { currentUser } from './sessions'

/**
 * How long a grant lives. Long enough to walk to another machine and sign in,
 * short enough that an abandoned code is not sitting there tomorrow.
 */
export const DEVICE_AUTH_TTL_S = 600

/** What the daemon is told to wait between polls (RFC 8628's `interval`). */
export const POLL_INTERVAL_S = 5

/**
 * The user code's alphabet: the twenty consonants, uppercase.
 *
 * No digits, so there is no 5/S, 2/Z, 0/O or 1/I to misread off a terminal in
 * whatever font it happens to be using — every pair of lookalikes here spans
 * the letter/digit boundary, so dropping the digits removes all of them at
 * once. No vowels, so the generator cannot produce a word.
 */
export const USER_CODE_ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ'

/**
 * Eight characters: 20^8, a little under 35 bits.
 *
 * RFC 8628 §5.1 asks for at least 20 bits on a user code *and* a rate limit on
 * the endpoint that consumes it, because the code is short enough to guess at
 * if guessing is free. Both are here — see `CONFIRMS_PER_USER`. What a guess
 * would buy is worth being clear about: `confirmDeviceAuth` binds a grant to
 * whoever confirms it, so a stranger who guessed a live code would attach
 * someone else's daemon to their own account and hold a token for a machine
 * they do not own.
 */
export const USER_CODE_LENGTH = 8

/** Grants one caller may open per window. See the note in `startDeviceAuth`. */
export const GRANTS_PER_IP = 30

/**
 * Codes one signed-in user may try per window.
 *
 * The other half of RFC 8628 §5.1. Twenty is more wrong guesses than anyone
 * copying a code off their own screen will make, and it puts the expected work
 * for a stranger's grant at 20^8 / 20 windows — millennia, and noisy.
 */
export const CONFIRMS_PER_USER = 20

/**
 * The window both caps are measured over.
 *
 * Bound to ratelimit.ts's constant rather than chosen here: `sweepRateLimits`
 * deletes counters older than `LONGEST_WINDOW_S`, so a bucket measured over
 * anything longer would be swept mid-window and silently reset — a cap that
 * looks like a cap and is not one.
 */
const ENROLL_WINDOW_S = LONGEST_WINDOW_S

/** The longest label kept, and the longest input read before giving up on it. */
const MAX_LABEL = 64
const MAX_LABEL_INPUT = 1024
/** A user code is 8 characters; the slack is for dashes, spaces and paste noise. */
const MAX_USER_CODE_INPUT = 64
/** A device code is 43 base64url characters. Nothing longer is worth hashing. */
const MAX_DEVICE_CODE_INPUT = 128

/** How many user codes to draw before giving up on finding a free one. */
const USER_CODE_TRIES = 5

/** The label used when a daemon sends nothing usable. */
const FALLBACK_LABEL = 'flue daemon'

const nowSeconds = () => Math.floor(Date.now() / 1000)

export interface StartDeviceAuthInput {
  /** The name the daemon gives itself — usually its hostname. */
  label: string
  /** The daemon's Noise static public key, 32 bytes, base64. */
  publicKey: string
}

export interface DeviceGrant {
  /** What the human reads and types, formatted `XXXX-XXXX`. */
  userCode: string
  /** The daemon's bearer secret for this grant. Never stored, never logged. */
  deviceCode: string
  /** Where to send the human. */
  verificationUrl: string
  /** The same page with the code filled in. Filling it in approves nothing. */
  verificationUrlComplete: string
  expiresIn: number
  interval: number
}

export type PollResult =
  | { status: 'pending' }
  | { status: 'expired' }
  /**
   * This key is already some *other* account's device, and nothing was
   * written. A daemon that sees this should stop and say so: the machine has
   * to be removed from the account that holds it before it can move.
   */
  | { status: 'conflict'; deviceId: string }
  /** `deviceToken` is present on the first approved poll and never again. */
  | { status: 'approved'; deviceId: string; deviceToken?: string }

export type ConfirmResult = { ok: true; deviceId: string; label: string } | { ok: false }

/**
 * A refusal from `startDeviceAuth`, carrying the status the daemon should see.
 *
 * The two ways to be turned away are genuinely different — "that is not a key"
 * is the caller's bug and retrying is pointless, "too many enrolments from this
 * address" is temporary and retrying is the whole answer — and a client that
 * cannot tell them apart either hammers a cap or gives up on a typo. An
 * ordinary `Error` subclass, so every existing `rejects.toThrow()` still holds
 * and a caller that does not care can ignore the distinction.
 */
export class DeviceAuthError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = 'DeviceAuthError'
  }
}

/**
 * Open a grant. Unauthenticated: the daemon has no credential yet — that is
 * what it is here for.
 *
 * Everything a caller supplies is checked before anything is written. The key
 * has to be a 32-byte Noise static, because the device's id is derived from
 * its bytes and a key of some other length is not a key; the label is trimmed
 * of control characters and bounded, because it is chosen by whoever runs the
 * daemon and is later printed into other people's terminals.
 *
 * Throws when the caller is over its cap or its key is not a key. Unlike the
 * login endpoints there is nothing to be coy about here: no account is
 * involved, nothing is enumerable, and the daemon's operator is better served
 * by an error they can read.
 */
export async function startDeviceAuth(input: StartDeviceAuthInput): Promise<DeviceGrant> {
  const bytes = decodePublicKey(input.publicKey.slice(0, 128))
  if (!bytes) throw new DeviceAuthError('enroll: the device key must be 32 bytes, base64', 400)
  const publicKey = encodePublicKey(bytes)
  const label = normalizeLabel(input.label)

  // Before the write, not after. This endpoint is unauthenticated and every
  // call mints a row, so without a cap the size of `device_auth` is whatever
  // an unauthenticated caller feels like making it — and rows here are not
  // free: each one holds a live user code, and a table full of live codes is a
  // larger target for the guessing that `CONFIRMS_PER_USER` bounds.
  const withinCap = await withinLimit('device-auth:ip', clientIp(), GRANTS_PER_IP, ENROLL_WINDOW_S)
  if (!withinCap) {
    throw new DeviceAuthError(
      'enroll: too many enrolments from this address — wait a few minutes',
      429,
    )
  }

  // Expired grants are dead the moment their TTL passes, and nothing reads
  // them (every lookup below carries the TTL in its predicate), so collecting
  // them is storage and can ride on the traffic that creates them. Same coin
  // flip as the rate-limit sweep, and for the same reason: there is no cron
  // yet. Task 10's scheduled handler should call `sweepDeviceAuth` directly.
  await maybeSweepDeviceAuth()

  const createdAt = nowSeconds()
  const deviceCode = randomToken()
  // The digest is what the row holds. `pollDeviceAuth` hashes what it is given
  // and looks up by that, so the raw code exists only in this function's
  // return value and in the daemon's memory.
  const deviceCodeHash = await sha256Hex(deviceCode)

  // A user code is 20^8, and the live population is tiny, so a collision is
  // vanishingly unlikely — but it is a primary key, and "vanishingly unlikely"
  // is not "impossible" when the alternative is a 500 for an enrolment that
  // did nothing wrong. `do nothing` + `returning` makes the insert its own
  // collision test: no row back means that code was taken, so draw another.
  // The conflict target is the user code alone; a collision on `device_code`
  // (32 random bytes) is a broken CSPRNG and should be heard, not retried.
  for (let attempt = 0; attempt < USER_CODE_TRIES; attempt++) {
    const userCode = randomUserCode()
    const inserted = await db()
      .insert(deviceAuth)
      .values({
        userCode,
        deviceCode: deviceCodeHash,
        label,
        createdAt,
        expiresAt: createdAt + DEVICE_AUTH_TTL_S,
        publicKey,
      })
      .onConflictDoNothing({ target: deviceAuth.userCode })
      .returning({ userCode: deviceAuth.userCode })

    if (inserted.length === 1) {
      const formatted = formatUserCode(userCode)
      const verificationUrl = new URL('/enroll', requestOrigin()).toString()
      return {
        userCode: formatted,
        deviceCode,
        verificationUrl,
        verificationUrlComplete: `${verificationUrl}?code=${encodeURIComponent(formatted)}`,
        expiresIn: DEVICE_AUTH_TTL_S,
        interval: POLL_INTERVAL_S,
      }
    }
  }

  throw new DeviceAuthError('enroll: could not mint a free user code — try again', 503)
}

/**
 * Ask what happened to a grant. Unauthenticated, and the device code is the
 * only credential: it is 32 CSPRNG bytes, so the lookup is a primary-key-shaped
 * read on a digest rather than a constant-time compare — there is no keyspace
 * to walk one byte at a time.
 *
 * `expired` covers every dead end without distinguishing them: no such grant,
 * an aged-out one, one that was already spent. There is nothing useful in the
 * difference and the daemon's behaviour is the same for all three.
 *
 * Deliberately *not* rate-limited. A daemon polls every few seconds for up to
 * ten minutes, and several daemons behind one NAT are ordinary; a per-IP cap
 * tight enough to matter would break a household before it inconvenienced
 * anyone, and what it would protect is a single indexed read.
 */
export async function pollDeviceAuth(input: { deviceCode: string }): Promise<PollResult> {
  const presented = input.deviceCode
  if (!presented || presented.length > MAX_DEVICE_CODE_INPUT) return { status: 'expired' }

  const d = db()
  const now = nowSeconds()
  const [grant] = await d
    .select({
      userCode: deviceAuth.userCode,
      expiresAt: deviceAuth.expiresAt,
      approvedUserId: deviceAuth.approvedUserId,
      deviceId: deviceAuth.deviceId,
      publicKey: deviceAuth.publicKey,
    })
    .from(deviceAuth)
    .where(eq(deviceAuth.deviceCode, await sha256Hex(presented)))
    .limit(1)

  if (!grant) return { status: 'expired' }

  if (grant.expiresAt <= now) {
    // Sweep the row that just answered rather than re-judge it on every future
    // poll. Its user code goes back into circulation with it.
    await d.delete(deviceAuth).where(eq(deviceAuth.userCode, grant.userCode))
    return { status: 'expired' }
  }

  if (!grant.approvedUserId || !grant.deviceId || !grant.publicKey) return { status: 'pending' }

  const deviceToken = randomToken()
  const tokenHash = await sha256Hex(deviceToken)

  // The whole of approval, in one transaction.
  //
  // Both statements carry the same predicate — the grant exists and is
  // approved — so if a concurrent poll got here first, the insert matches no
  // rows and the delete returns none, and this call finds out by looking at
  // what the delete returned. Written the obvious way instead (delete the
  // device row, then insert it), a second poll arriving after the first had
  // finished would delete the device it had just created.
  //
  // The INSERT's source is written as raw SQL because it selects from the very
  // row it is about to delete — one statement, so the values cannot change
  // between being read and being written. Its column order is the order
  // `devices` declares (drizzle emits the full column list for an
  // insert-from-select), and `enroll.test.ts` would notice if that drifted.
  const mintDevice = d
    .insert(devices)
    .select(
      sql`select device_id, approved_user_id, label, public_key, ${tokenHash}, ${now}, null, 0
            from ${deviceAuth}
           where user_code = ${grant.userCode}
             and approved_user_id is not null
             and device_id is not null
             and public_key is not null
             and expires_at > ${now}`,
    )
    .onConflictDoUpdate({
      target: devices.id,
      set: {
        userId: sql`excluded.user_id`,
        label: sql`excluded.label`,
        publicKey: sql`excluded.public_key`,
        tokenHash: sql`excluded.token_hash`,
        createdAt: sql`excluded.created_at`,
        // A re-enrolment is a fresh device, not a resumed one: it must not
        // inherit the previous row's kill switch or its last-seen stamp.
        lastSeen: sql`null`,
        disabled: sql`0`,
      },
      // Who may replace an existing device row: only the account that already
      // owns it. Inside `do update`, the bare table name is the row already in
      // the table and `excluded` is the one proposed — so this reads "the
      // owner is not changing".
      //
      // Without it the upsert is an account-takeover primitive. The daemon's
      // Noise static is a *public* key: it is printed in the pairing URL's
      // `k=` parameter and sent in the clear as `DaemonPub` during the
      // handshake, so knowing one proves nothing about owning the machine.
      // Any signed-in stranger could open a grant for somebody else's key,
      // confirm it with their own session, poll once, and walk off with the
      // row — the victim's daemon silently de-enrolled (its token replaced),
      // its id now resolving to the stranger's account. Noise still keeps the
      // stranger off the machine, but a working device must not be hijackable
      // from the registry either.
      //
      // The residual, stated plainly: a *first* enrolment of a key nobody has
      // claimed hits no conflict, so somebody who learns a key before its
      // owner enrolls can land-grab the id and force the real owner to a
      // `conflict` — denial of service on a not-yet-enrolled device, not a
      // takeover of a live one. Closing it needs proof that the caller holds
      // the private key, and an X25519 static cannot sign; the shapes that
      // work are a challenge the daemon answers over a Noise handshake, or an
      // explicit device-transfer flow on the owning account. Both are their
      // own piece of work — see FOLLOW-UPS in the task report.
      setWhere: sql`${devices.userId} = excluded.user_id`,
    })
    // The claim that the mint actually happened. A suppressed conflict update
    // returns no row, which is the only way to tell it apart from an update
    // that ran.
    .returning({ id: devices.id })

  const burnGrant = d
    .delete(deviceAuth)
    .where(
      and(
        eq(deviceAuth.userCode, grant.userCode),
        // The same predicate the insert's source carries, term for term. The
        // two statements have to agree about which grants are mintable, or a
        // later change that splits them apart could burn a grant — and hand
        // out its token — for a device that was never written.
        isNotNull(deviceAuth.approvedUserId),
        isNotNull(deviceAuth.deviceId),
        isNotNull(deviceAuth.publicKey),
        gt(deviceAuth.expiresAt, now),
      ),
    )
    .returning({ userCode: deviceAuth.userCode })

  const [minted, burned] = await d.batch([mintDevice, burnGrant])

  // The delete is the claim: whoever removed the row is the one that minted
  // the device in the same transaction, and is the only caller told the token.
  // Zero rows means another poll had already taken it — in which case this
  // batch wrote nothing either, and there is no token here to hand over.
  if (burned.length !== 1) return { status: 'approved', deviceId: grant.deviceId }

  // The grant was ours to burn and the device still did not move: the only
  // thing that suppresses the write once the delete has matched is `setWhere`,
  // so this key belongs to another account. Said out loud rather than answered
  // with a tokenless `approved`, which the daemon would have to guess at.
  if (minted.length !== 1) return { status: 'conflict', deviceId: grant.deviceId }

  return { status: 'approved', deviceId: grant.deviceId, deviceToken }
}

/**
 * Approve a grant, as the signed-in user who is looking at the code.
 *
 * This does not create the device — see the note at the top of the file. What
 * it writes is who approved and which device the key names, and that is the
 * whole of the authorization decision: the poll that follows only carries it
 * out.
 *
 * `{ok:false}` is every refusal, undistinguished: no such code, an expired
 * one, one somebody else has already approved, too many tries. Saying which
 * would turn this into an oracle for whether a given code is live, which is
 * exactly the thing the guess cap exists to make expensive.
 *
 * Resolves the session itself rather than taking a user, and throws without
 * one. The route's server function composes `requireUser` too — that is what
 * turns an expired session into a redirect instead of an error — but a guard
 * that lives only in the wiring is a guard the next caller can forget to wire.
 */
export async function confirmDeviceAuth(input: { userCode: string }): Promise<ConfirmResult> {
  const user = await currentUser()
  if (!user) throw new Error('confirmDeviceAuth: no session')

  const userCode = normalizeUserCode(input.userCode)
  if (!userCode) return { ok: false }

  // Counted before the lookup and whatever the lookup finds, so a wrong code
  // and a right one cost the same attempt. A limiter that only counted misses
  // would let a guesser run free by mixing in codes they already hold.
  const withinCap = await withinLimit('device-confirm:user', user.id, CONFIRMS_PER_USER, ENROLL_WINDOW_S)
  if (!withinCap) return { ok: false }

  const d = db()
  const now = nowSeconds()
  const [grant] = await d
    .select({
      label: deviceAuth.label,
      publicKey: deviceAuth.publicKey,
      approvedUserId: deviceAuth.approvedUserId,
    })
    .from(deviceAuth)
    .where(and(eq(deviceAuth.userCode, userCode), gt(deviceAuth.expiresAt, now)))
    .limit(1)

  if (!grant?.publicKey) return { ok: false }
  // Defensive: `startDeviceAuth` is the only writer and it validates, so a key
  // that will not decode means the row was written by something else.
  const key = decodePublicKey(grant.publicKey)
  if (!key) return { ok: false }
  const deviceId = await deviceIdFromKey(key)

  // The predicate is the race: `approved_user_id is null or = me` means two
  // people confirming the same code serialize in SQLite, and the second one
  // updates nothing and is told no. Confirming twice yourself updates the same
  // two values again and is a no-op, which is what makes a double-click and a
  // reloaded tab harmless.
  const claimed = await d
    .update(deviceAuth)
    .set({ approvedUserId: user.id, deviceId })
    .where(
      and(
        eq(deviceAuth.userCode, userCode),
        gt(deviceAuth.expiresAt, now),
        or(isNull(deviceAuth.approvedUserId), eq(deviceAuth.approvedUserId, user.id)),
      ),
    )
    .returning({ label: deviceAuth.label })

  const row = claimed[0]
  if (!row) return { ok: false }
  return { ok: true, deviceId, label: row.label }
}

/** Delete every grant whose ten minutes are up. Safe from anywhere, any time. */
export async function sweepDeviceAuth(now: number = nowSeconds()): Promise<void> {
  await db().delete(deviceAuth).where(lt(deviceAuth.expiresAt, now))
}

/** Sweep on roughly one call in `SWEEP_ONE_IN`; see `maybeSweepRateLimits`. */
async function maybeSweepDeviceAuth(): Promise<void> {
  if (Math.random() * SWEEP_ONE_IN >= 1) return
  await sweepDeviceAuth()
}

/**
 * The origin to send the human to, taken from the request the daemon made.
 *
 * Neither forwarded header is trusted: `x-forwarded-host` and
 * `x-forwarded-proto` are client-supplied, and honouring them would let the
 * caller choose the URL that gets printed in a terminal. On Workers the
 * request's own URL is the host the client actually connected to, and in
 * `vite dev` it is localhost, so this needs no configuration to be right in
 * both places.
 */
function requestOrigin(): string {
  return getRequestUrl({ xForwardedHost: false, xForwardedProto: false }).origin
}

/** `BCDFGHJK` → `BCDF-GHJK`: four at a time is what people can hold in their head. */
export function formatUserCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`
}

/**
 * The one spelling of a user code the database ever sees.
 *
 * `device_auth.user_code` is a TEXT primary key and SQLite compares TEXT byte
 * for byte, so `bcdf-ghjk` and `BCDFGHJK` are two different rows — and this
 * code is read off a terminal and typed into a browser by a person, who will
 * lowercase it, keep the dash, drop the dash, or paste it with a space on
 * either end. Uppercase, then keep only the letters.
 *
 * Dropping the non-letters cannot turn one valid code into a different valid
 * one: every character of the result was typed, in order. It can only turn
 * something that was not a code into something that might be, which is
 * guessing, and guessing is capped.
 *
 * Returns '' for anything that is not the right length or steps outside the
 * alphabet — a string that cannot be a code is refused without a query.
 */
export function normalizeUserCode(raw: string): string {
  const letters = raw.slice(0, MAX_USER_CODE_INPUT).toUpperCase().replace(/[^A-Z]/g, '')
  if (letters.length !== USER_CODE_LENGTH) return ''
  for (const c of letters) if (!USER_CODE_ALPHABET.includes(c)) return ''
  return letters
}

/**
 * The label, made safe to store and to print.
 *
 * Control characters go first: this string is chosen by whoever runs the
 * daemon, and it is later printed into a terminal by `flue devices` on some
 * other machine — an escape sequence there is somebody else's cursor. Runs of
 * whitespace collapse so the dashboard's list stays a list, and the result is
 * bounded because `devices.label` is shown, not searched.
 */
function normalizeLabel(raw: string): string {
  const cleaned = raw
    .slice(0, MAX_LABEL_INPUT)
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_LABEL)
    .trim()
  return cleaned || FALLBACK_LABEL
}

/**
 * A user code from the CSPRNG, uniformly distributed.
 *
 * 256 is not a multiple of 20, so `byte % 20` alone would make the first
 * sixteen letters of the alphabet likelier than the last four — a measurable
 * dent in a keyspace whose entire job is to be flat. Draws at or above 240 are
 * discarded and redrawn; that is 6% of them, so the loop ends immediately.
 */
function randomUserCode(): string {
  const alphabet = USER_CODE_ALPHABET
  const limit = Math.floor(256 / alphabet.length) * alphabet.length
  const buf = new Uint8Array(USER_CODE_LENGTH * 2)
  let out = ''
  while (out.length < USER_CODE_LENGTH) {
    crypto.getRandomValues(buf)
    for (const byte of buf) {
      if (byte >= limit) continue
      out += alphabet.charAt(byte % alphabet.length)
      if (out.length === USER_CODE_LENGTH) break
    }
  }
  return out
}
