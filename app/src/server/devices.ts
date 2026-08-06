// The device directory: one login, all your machines.
//
// Four calls, one guard, and the guard is the same sentence in every one of
// them — **ownership lives in the SQL predicate**. Not `select` then `if
// (row.userId !== user.id) throw` then `delete`: that shape has a race in it
// (the row can move between the read and the write) and, worse, it is a shape
// where deleting three lines leaves code that still reads as if it checks.
// `where id = ? and user_id = ?` cannot be half-applied. A device that is not
// yours matches no rows, the statement writes nothing, and `returning` says so
// — which is both the authorization decision and the proof it was made, in one
// statement. It is the same construction `mintClientToken` uses, for the same
// reason, and the kill switches ride along in the same `where`.
//
// Each function resolves the session itself and refuses without one, exactly as
// `confirmDeviceAuth` and `mintClientToken` do. The route composes `requireUser`
// on top — that is what turns an expired session into a redirect rather than an
// error — but a guard that lives only in the wiring is a guard the next caller
// can forget to wire.
//
// One refusal, `DeviceError`, for everything a caller is allowed to be told:
// "no such machine" covers a device that does not exist and one that belongs to
// somebody else, undistinguished, or this becomes an existence oracle for other
// people's device ids. (Ids are derived from public keys and are not secret,
// but the mapping id → "is a real device on this service" is not something to
// hand out.) Anything else that throws here is ours, and routes/devices.tsx
// turns it into a fixed string — drizzle raises a failed statement as
// `Failed query: <SQL>\nparams: <every bound value>`, which on these paths is
// the device id and the account id.
import { and, asc, desc, eq } from 'drizzle-orm'
import { db } from '../db/client'
import { devices } from '../db/schema'
import { MAX_LABEL_INPUT, normalizeLabel } from '../lib/label'
import { mintClientToken } from './channel-token'
import { currentUser } from './sessions'

export { MAX_LABEL } from '../lib/label'

/** A device id is 12 hex characters; nothing longer is worth a query. */
const MAX_DEVICE_ID_INPUT = 64

/**
 * A refusal the caller is meant to read.
 *
 * Every message on this class is written for the person looking at the screen
 * and is safe to surface verbatim; everything else that escapes these functions
 * is an internal failure the route answers with a fixed string. Same split as
 * `DeviceAuthError` in server/enroll.ts.
 */
export class DeviceError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DeviceError'
  }
}

/** What the directory shows for one machine. Deliberately four fields. */
export interface DeviceSummary {
  id: string
  label: string
  lastSeen: number | null
  disabled: boolean
}

/** The session, or a refusal. Never a caller-supplied user id. */
async function requireSession(): Promise<{ id: string }> {
  const user = await currentUser()
  if (!user) throw new Error('devices: no session')
  return user
}

/** A device id worth spending a query on, or the standard refusal. */
function readDeviceId(deviceId: string): string {
  if (!deviceId || deviceId.length > MAX_DEVICE_ID_INPUT) {
    throw new DeviceError('devices: no such machine')
  }
  return deviceId
}

/**
 * Every machine on the caller's account.
 *
 * Four columns, named explicitly rather than `select()`: the row also holds
 * `token_hash` — the digest of a live bearer credential — and `public_key`, and
 * a list endpoint that returned the row would put both into the RPC payload of
 * every dashboard load, where they are one `view-source` away from anyone
 * looking over a shoulder.
 *
 * Ordered here rather than in the component, so the list does not reshuffle
 * between loads. Most recently seen first, which is also "the machines you can
 * reach right now, at the top"; SQLite sorts NULL below everything, so `desc`
 * puts a machine that has never connected last, where it belongs. `created_at`
 * then `id` break the tie, so two machines with the same stamp — the common
 * case, since nothing has stamped `last_seen` yet — hold a stable order.
 */
export async function listDevices(): Promise<Array<DeviceSummary>> {
  const user = await requireSession()

  return db()
    .select({
      id: devices.id,
      label: devices.label,
      lastSeen: devices.lastSeen,
      disabled: devices.disabled,
    })
    .from(devices)
    .where(eq(devices.userId, user.id))
    .orderBy(desc(devices.lastSeen), desc(devices.createdAt), asc(devices.id))
}

/**
 * Take a machine off the account, for good.
 *
 * The row is deleted rather than flagged, and that is the whole revocation
 * mechanism: the relay never calls this service — it verifies a channel token
 * offline and bridges whoever the claims name — so "revoked" means *no more
 * tokens get minted*. A device with no row cannot be found by `mintClientToken`
 * or `mintDaemonToken`, so the daemon's next refresh fails and it drops on its
 * next reconnect. What that cannot do is cut a channel already open: a token in
 * flight stays valid until it expires, which is why those TTLs are 60 and 300
 * seconds. That window is the revocation latency of the whole system.
 *
 * Deleting also means re-enrolling the same machine works: `devices.id` is
 * derived from the daemon's public key, so `flue enable` on that machine
 * collides with nothing and writes a fresh row (`enroll.ts`'s upsert is scoped
 * to the owner, and there is now no owner to conflict with).
 *
 * The enrollment token dies with the row — it was only ever stored as a digest
 * — so there is nothing else to clean up.
 */
export async function revokeDevice(deviceId: string): Promise<void> {
  const user = await requireSession()
  const id = readDeviceId(deviceId)

  const removed = await db()
    .delete(devices)
    .where(and(eq(devices.id, id), eq(devices.userId, user.id)))
    .returning({ id: devices.id })

  // No rows means one of: no such device, or somebody else's. The same
  // sentence for both, on purpose.
  if (removed.length !== 1) throw new DeviceError('devices: no such machine')

  // Logged because it is the one destructive thing this screen does, and
  // because "my machine vanished" is a support question that needs an answer.
  // The ids and nothing else: the row held a digest of a bearer credential, and
  // a log line is a copy.
  console.log(JSON.stringify({ evt: 'device_revoked', userId: user.id, deviceId: removed[0]?.id }))
}

/**
 * Rename a machine, as its owner.
 *
 * The label is normalized by the same function `startDeviceAuth` uses on the
 * name a daemon gives itself (lib/label.ts) — one column, one set of rules. A
 * name that normalizes to nothing is refused rather than substituted: unlike
 * the enrolment path, there is a person here to tell.
 *
 * Returns what was stored, not what was typed. The two differ whenever the
 * normalizer did anything, and a screen that echoed the input would show a name
 * the database does not have.
 */
export async function renameDevice(deviceId: string, label: string): Promise<string> {
  const user = await requireSession()
  const id = readDeviceId(deviceId)

  // Bounded before it is normalized, so a megabyte "name" is not a megabyte of
  // regex — and before it is a bound parameter in D1. The refusal does not
  // quote a number: what is refused here is `MAX_LABEL_INPUT` (1024), while
  // what is *kept* is `MAX_LABEL` (64) — anything between the two is trimmed
  // rather than turned down, and the dashboard's field caps typing at 64, so a
  // person never meets this path at all.
  if (label.length > MAX_LABEL_INPUT) {
    throw new DeviceError('devices: that name is too long')
  }
  const cleaned = normalizeLabel(label)
  if (!cleaned) throw new DeviceError('devices: a machine needs a name')

  const renamed = await db()
    .update(devices)
    .set({ label: cleaned })
    .where(and(eq(devices.id, id), eq(devices.userId, user.id)))
    .returning({ label: devices.label })

  const row = renamed[0]
  if (!row) throw new DeviceError('devices: no such machine')
  return row.label
}

/**
 * Open a session on a machine: the handoff from the control plane to the relay.
 *
 * What comes back is a URL for the *browser* to go to, and the two edits it
 * makes to what `mintClientToken` returns are both load-bearing.
 *
 * **`wss:` becomes `https:`.** `RELAY_URL` is the address a WebSocket dials,
 * because that is what every other consumer of it needs; a document navigation
 * cannot use that scheme. Same host, same port, swapped scheme — not a second
 * environment variable, which would be one more thing a deployment can get
 * inconsistent with itself.
 *
 * **The token rides in `?t=`.** That is the parameter Task 9's relay reads off
 * the `/client` upgrade, and the relay origin serves the terminal app itself
 * (its Worker falls through to `ASSETS`), so landing there with `?t=` hands the
 * token to the page that is about to dial. Its cost is stated plainly in
 * channel-token.ts: a URL is the leakiest place to put a credential — history,
 * proxy logs, a screenshot, a shared link — and a 60-second TTL is the whole
 * mitigation.
 *
 * Note what this does *not* do: navigate. The caller decides that (see the
 * route), because "where a browser goes" is not a decision to make on the
 * server.
 */
export async function openSession(deviceId: string): Promise<{ url: string }> {
  const user = await requireSession()
  const id = readDeviceId(deviceId)

  // `mintClientToken` re-states ownership and both kill switches in its own
  // predicate and throws the same undistinguished refusal this module does. The
  // session read above is not redundant with it: it is what makes "no session"
  // a session error rather than a mint error.
  let grant: { token: string; relayUrl: string }
  try {
    grant = await mintClientToken(id)
  } catch (err) {
    // A refusal from the mint is about this device and is safe to pass on as
    // one; a configuration failure (`RELAY_URL is not set`) is not the caller's
    // to read, and travels on to the route's fixed-string handler.
    if (err instanceof Error && err.message === 'mintClientToken: no such device') {
      throw new DeviceError('devices: no such machine')
    }
    throw err
  }

  const url = new URL(grant.relayUrl)
  url.protocol = url.protocol === 'ws:' ? 'http:' : 'https:'
  url.searchParams.set('t', grant.token)

  // Not logged, here or anywhere: `url` contains a bearer credential. What is
  // worth recording is that a session was opened, and by whom.
  console.log(JSON.stringify({ evt: 'session_opened', userId: user.id, deviceId: id }))

  return { url: url.toString() }
}
