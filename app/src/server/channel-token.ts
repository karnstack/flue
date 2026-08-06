// Minting channel tokens: the control plane's half of the relay handshake.
//
// The relay never calls this service to authorize a channel. It holds one
// shared secret, verifies a token offline (lib/tokens.ts `verifyChannelToken`,
// ported into relay/src/channel-auth.ts) and bridges whoever the claims name.
// That is what keeps a session from paying for a control-plane round trip on
// every dial — and it is also why this file is the *entire* authorization
// decision. Once a token is signed, nothing downstream asks a second question.
//
// So the two functions here are gates, and each one states its whole predicate
// in a single SQL `where`:
//
//   - `mintClientToken` — the browser. A session, a device that belongs to
//     that session's user, and neither the user nor the device disabled.
//   - `mintDaemonToken` — the daemon. Its enrollment token, matched by digest
//     against the device row it names, and the same two kill switches.
//
// Three properties worth pointing at:
//
// **The kill switch is checked here, not inherited.** `users.disabled` and
// `devices.disabled` ride in the same predicate as ownership, so revoking
// either one stops the *next* mint immediately. What it cannot do is cut a
// live channel: a token already in flight stays valid until it expires, which
// is why the TTLs below are 60 and 300 seconds and not an hour. That window is
// how long a revoked subject can still *open* a channel — and, because the
// relay verifies at the upgrade and never again, a channel opened inside it
// outlives the token. See the note in server/kill-switch.ts for what that means
// for an operator with an incident on their hands.
//
// **The daemon never holds the signing secret.** It holds an enrollment token
// and asks for a channel token; `RELAY_SIGNING_SECRET` exists on exactly two
// Workers, this one and the relay. A daemon that could sign its own tokens
// could name any account it liked.
//
// **Nothing here logs a token.** Not the enrollment token it is given, not the
// channel token it returns. They are bearer credentials; a log line is a copy.
//
// One requirement for whoever exposes these over HTTP — `openSessionFn` in
// routes/devices.tsx for the browser, `daemonTokenFn` in routes/enroll.tsx for
// the daemon, and anything added later: wrap the call the way
// routes/enroll.tsx's `refusal` does. The refusals below are static
// strings and safe to surface, but a *drizzle* failure underneath is raised as
// `Failed query: <SQL>\nparams: <every bound value>` — which on this path means
// the device id and the `sha256(enrollmentToken)` digest. Log it, answer with a
// fixed string.
import { env } from 'cloudflare:workers'
import { and, eq } from 'drizzle-orm'
import { db } from '../db/client'
import { devices, users } from '../db/schema'
import { sha256Hex, signChannelToken } from '../lib/tokens'
import { currentUser } from './sessions'

/**
 * How long a browser's token lives.
 *
 * One minute is enough to carry a token from a click on "open a session" to a
 * WebSocket upgrade, and it is the only bound on replaying one that leaked —
 * through a URL (`openSession` puts it in the *fragment*, which keeps it out of
 * server logs and referrers but not out of history), a screenshot, a shared
 * link. The browser asks for a new one per dial; nothing caches these.
 */
export const CLIENT_TOKEN_TTL_S = 60

/**
 * How long a daemon's token lives.
 *
 * Five minutes rather than one because a daemon dials on its own schedule —
 * boot, network flap, backoff — and a token that expires between "mint" and
 * "reconnect" turns a transient network failure into a permanent one. It
 * refreshes ahead of expiry (Go: internal/controlplane.DaemonTokens), so this
 * is a ceiling on how stale a revocation can be for a machine that is already
 * connected.
 */
export const DAEMON_TOKEN_TTL_S = 300

/** A device id is 12 hex characters; nothing longer is worth a query. */
const MAX_DEVICE_ID_INPUT = 64
/** An enrollment token is 43 base64url characters. Nothing longer is hashed. */
const MAX_ENROLLMENT_TOKEN_INPUT = 128

const nowSeconds = () => Math.floor(Date.now() / 1000)

/** What a caller gets: the token, and where to present it. */
export interface ChannelGrant {
  /** The signed token. Bearer credential — never log it, never store it. */
  token: string
  /** The relay to dial, e.g. `wss://relay.flue.sh`. */
  relayUrl: string
}

/**
 * The signing key, read per request (module scope would be `undefined` on
 * Workers).
 *
 * Missing means stop, exactly as `codeSecret` does in server/codes.ts. Falling
 * through to `signChannelToken(undefined, ...)` would sign every token under
 * the literal string "undefined" — one well-known key shared by every
 * deployment that forgot `wrangler secret put`, which is the same as handing
 * out unsigned tokens and asking the relay to trust them.
 */
function relaySigningSecret(): string {
  const secret = env.RELAY_SIGNING_SECRET
  if (!secret) {
    throw new Error('RELAY_SIGNING_SECRET is not set: refusing to mint relay channel tokens')
  }
  return secret
}

/**
 * Where the token is to be presented, read per request.
 *
 * Fail-closed rather than defaulted, and the default is what makes it worth
 * saying: hardcoding `wss://relay.flue.sh` here would mean a dev machine, a
 * staging deployment or a self-hosted control plane that forgot this variable
 * quietly hands its users a token addressed to production. A token is only
 * meaningful to the relay that shares the secret; naming the wrong one is a
 * misconfiguration, not a fallback.
 */
function relayUrl(): string {
  const url = env.RELAY_URL
  if (!url) throw new Error('RELAY_URL is not set: refusing to mint a token for an unknown relay')
  return url
}

/**
 * A client channel token for a device the signed-in user owns.
 *
 * Throws when there is no session, and throws the *same* error for a device
 * that does not exist and one that belongs to somebody else — the two are one
 * refusal on purpose, or this becomes an existence oracle for other people's
 * device ids (which are derived from public keys and are not secret, but the
 * mapping id → "is a real device on this service" is not something to hand
 * out).
 *
 * Resolves the session itself rather than taking a user, and refuses without
 * one, the same way `confirmDeviceAuth` does. The route's server function
 * composes `requireUser` on top — that is what turns an expired session into a
 * redirect rather than an error — but a guard that lives only in the wiring is
 * a guard the next caller can forget to wire.
 *
 * **Where this token is allowed to travel**, because it is a bearer credential
 * and every hop that writes it down is a copy of one. `server/devices.ts`
 * hands the browser `https://<relay>/#t=<token>`; the relay's own Worker
 * (which serves that page) must complete the other half:
 *
 *   - read it from `location.hash`, never from `location.search`;
 *   - present it on the `/client` upgrade in **`Sec-WebSocket-Protocol`**, not
 *     as a query parameter — the upgrade *is* a request to the relay, and a
 *     query parameter on it goes straight into Workers Logs;
 *   - `history.replaceState` the fragment away as soon as it is read.
 *
 * A query string on either hop would put a live credential into a log store,
 * and on the first hop into the `Referer` of everything that page loads.
 */
export async function mintClientToken(deviceId: string): Promise<ChannelGrant> {
  // Configuration before authorization: a deployment that cannot sign must
  // say so rather than get as far as a database read and then throw anyway.
  const secret = relaySigningSecret()
  const url = relayUrl()

  // `currentUser` already refuses a disabled account (it re-reads the flag on
  // every call, which is what makes the switch immediate). The join below
  // re-states it anyway: this function's guarantee should not depend on a
  // property of a function two files away.
  const user = await currentUser()
  if (!user) throw new Error('mintClientToken: no session')

  if (!deviceId || deviceId.length > MAX_DEVICE_ID_INPUT) {
    throw new Error('mintClientToken: no such device')
  }

  // One statement, four questions: is this device real, is it this user's, is
  // it enabled, and is its owner enabled. There are no foreign keys (see
  // schema.ts), so the join is also what rules out a device whose user row has
  // been deleted — `acc` would name nobody.
  const [device] = await db()
    .select({ id: devices.id })
    .from(devices)
    .innerJoin(users, eq(users.id, devices.userId))
    .where(
      and(
        eq(devices.id, deviceId),
        eq(devices.userId, user.id),
        eq(devices.disabled, false),
        eq(users.disabled, false),
      ),
    )
    .limit(1)

  if (!device) throw new Error('mintClientToken: no such device')

  const token = await signChannelToken(secret, {
    acc: user.id,
    dev: device.id,
    role: 'client',
    exp: nowSeconds() + CLIENT_TOKEN_TTL_S,
  })
  return { token, relayUrl: url }
}

/**
 * A daemon channel token for a daemon presenting its enrollment token.
 *
 * Null for every refusal, undistinguished: no such device, the wrong token,
 * the right token for a different device, a revoked device, a disabled or
 * deleted owner. A daemon does the same thing about all of them — stop, and
 * tell its operator to enroll again — and saying which would answer questions
 * for whoever is holding a token they should not have.
 *
 * Unauthenticated in the session sense: the enrollment token *is* the
 * credential. It is looked up by digest (`devices.token_hash`, a unique index)
 * rather than compared in constant time, and the argument is the same one
 * sessions.ts makes: what is compared is a digest of 256 CSPRNG bits, so there
 * is no keyspace to walk one byte at a time even if an index leaked timing.
 *
 * The device id is required to match too, not merely the token. The digest
 * alone would identify the device — the index is unique — but requiring both
 * means a caller cannot hand device A's token to a call that names device B
 * and find out that way which id the token belongs to.
 */
export async function mintDaemonToken(
  deviceId: string,
  enrollmentToken: string,
): Promise<ChannelGrant | null> {
  const secret = relaySigningSecret()
  const url = relayUrl()

  if (!deviceId || deviceId.length > MAX_DEVICE_ID_INPUT) return null
  if (!enrollmentToken || enrollmentToken.length > MAX_ENROLLMENT_TOKEN_INPUT) return null

  const [device] = await db()
    .select({ id: devices.id, userId: devices.userId })
    .from(devices)
    .innerJoin(users, eq(users.id, devices.userId))
    .where(
      and(
        eq(devices.id, deviceId),
        eq(devices.tokenHash, await sha256Hex(enrollmentToken)),
        eq(devices.disabled, false),
        eq(users.disabled, false),
      ),
    )
    .limit(1)

  if (!device) return null

  const token = await signChannelToken(secret, {
    acc: device.userId,
    dev: device.id,
    role: 'daemon',
    exp: nowSeconds() + DAEMON_TOKEN_TTL_S,
  })
  return { token, relayUrl: url }
}
