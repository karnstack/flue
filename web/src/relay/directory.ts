/*
 * The fleet directory, as a browser reads it.
 *
 * `GET /directory` is credential-less and answers the whole set of signed
 * blobs the relay is holding — machine certificates, device certificates,
 * revocations (spec/relay-protocol.md, "The fleet directory"). It is how a
 * device paired on one machine learns of every other machine in the fleet
 * without a second ceremony, and how it gets hold of its own certificate to
 * present to them.
 *
 * **Nothing the relay says is trusted here.** The Worker stores and serves and
 * can verify nothing — the fleet key never touches it — so every blob is
 * checked under the pinned fleet public key and dropped if it fails. A hostile
 * relay can serve this stale, cut short, reordered or empty, and all of that
 * costs the same thing: machines this browser does not see. What it cannot do
 * is add one, because adding needs the key Cloudflare never holds.
 *
 * Nor are the relay's own bounds taken on faith. It refuses a blob over 4 KiB
 * and a 513th entry, and this reader enforces both again on the way in: the
 * ceilings that matter are the ones on the side doing the work.
 *
 * Two rules are the reader's and are applied here rather than anywhere else:
 *
 *   - **A revocation outranks a device certificate for the same key, whatever
 *     either one's `iat` says.** Not "the newer wins" — that would let a
 *     device certificate re-issued after a revoke undo it, and `iat` is a
 *     display field a signer chooses. Un-revoking is pairing again under a
 *     fresh key.
 *   - **Order in the answer means nothing.** Storage hands entries back
 *     sorted by digest, so a reader that took the last one for the newest
 *     would be reading a property of SHA-256. Everything is collected first
 *     and ranked afterwards, which is also why a revocation filed before the
 *     certificate it kills still kills it.
 */
import { keyHex, sameKey, verifyCert, type Cert } from '@/crypto/cert'

/**
 * The largest blob this reader will look at, mirroring `MAX_BLOB_BYTES` in
 * relay/src/directory.ts and `maxBlobBytes` in the daemon's leg. A certificate
 * is a couple of hundred bytes; what the bound buys is that a relay cannot
 * make this tab spend an Ed25519 verification per megabyte it feels like
 * sending.
 */
const MAX_BLOB_BYTES = 4096

/**
 * How many entries one answer may carry, mirroring `MAX_ENTRIES` in
 * relay/src/directory.ts and `MaxDirectoryEntries` in the daemon's leg. The
 * Worker refuses to store a 513th — it answers 507 rather than evicting,
 * because evicting could drop a revocation — so a longer answer is not a bigger
 * fleet, it is a relay that has stopped speaking this protocol. The rest go
 * unread.
 *
 * Exported because it is also the number the Remote screen measures a fleet
 * against (routes/remote.tsx, FleetLine): the cap has no gentle failure, so the
 * screen warns before it, and a second copy of 512 over there could drift from
 * the one this reader enforces.
 */
export const MAX_ENTRIES = 512

/**
 * Where a status surface starts saying the directory is filling up: 90% of the
 * cap, the same threshold `flue relay status` uses (internal/transport/relay,
 * DirectoryWarnAt).
 *
 * At the cap the relay refuses every new blob, and refuses it before storing
 * and therefore before pushing — so a revocation made past that point reaches
 * nobody — and nothing frees an entry short of `flue relay reset`. Warning late
 * is the same as not warning.
 */
export const DIRECTORY_WARN_AT = Math.floor((MAX_ENTRIES * 9) / 10)

/**
 * The ceiling on the document itself, in characters.
 *
 * The worst honest case is 512 entries of 4 KiB in base64, four characters per
 * three bytes, plus the JSON around it — about 2.8 MiB — and this is that with
 * room to spare, the same arithmetic `maxDirectorySnapshot` uses in Go.
 *
 * It bounds the *work*, not the bytes received: by the time this is checked
 * the answer has been read, because the seam below is one `text()` call rather
 * than a stream. That is the honest limit of it, and it is the right trade
 * here — the relay serving this page also serves the script reading it, so a
 * tab is not where a hostile relay is held at arm's length. What the check
 * does buy is that a JSON parse and 100 000 base64 decodes are never attempted
 * on an answer nothing honest produces.
 */
const MAX_DOCUMENT_CHARS = 4 << 20

/** The route, on the relay origin. One relay is one fleet, so it names no
 *  machine. */
const DIRECTORY_PATH = '/directory'

/** One machine the fleet has vouched for, from a certificate that verified. */
export interface DirectoryMachine {
  /** The machine id: its slot on the relay, the `<id>` in `/client/<id>`. */
  id: string
  /** The machine's own display name, as it signed it. */
  name: string
  /** The daemon's static X25519 public key, to pin for the IK handshake. */
  noise: Uint8Array
  /** When the machine minted this certificate. Display, never precedence. */
  iat: number
}

/** What one read of the directory came back with. */
export interface FleetView {
  /** Every machine whose certificate verified, by id, newest certificate per
   *  id. Sorted by id so two reads of one directory build the same list. */
  machines: DirectoryMachine[]
  /**
   * This device's own certificate, to seal into message A — null when the
   * fleet has never certified this key, and null when it has been revoked.
   * Without one, a machine this browser has not paired with will not admit it.
   */
  deviceCert: Uint8Array | null
  /**
   * Whether this device's key is revoked. Distinct from "no certificate":
   * one is a device that was never enrolled, the other is one the operator
   * cut off, and only the second means every machine in the fleet has been
   * told to close its channels.
   */
  revoked: boolean
  /** What the relay claimed to be holding, and how much of it this fleet key
   *  signed. The gap is a relay serving another fleet's blobs, or a fleet key
   *  that has rotated; it is reported rather than acted on. */
  entries: number
  verified: number
}

/** The narrow slice of `fetch` this module uses, so a test can hand it an
 *  answer without a Response implementation jsdom does not have. */
export interface DirectoryAnswer {
  ok: boolean
  status: number
  text(): Promise<string>
}

export type DirectoryFetch = (url: string) => Promise<DirectoryAnswer>

/** The empty view: what a relay that answered nothing usable amounts to. */
const NOTHING: FleetView = {
  machines: [],
  deviceCert: null,
  revoked: false,
  entries: 0,
  verified: 0,
}

/**
 * Read the directory at `origin` and keep what verifies under `fleetPub`.
 *
 * `devicePub` is this browser's own static key: the certificate hunted for is
 * the one naming it, and the revocation looked for is the one killing it.
 *
 * It never rejects. Every way this can fail — the relay unreachable, a 503
 * from a relay that has not been updated, a document that is not the shape the
 * spec fixes, a set with nothing in it that verifies — is the same fact to a
 * caller: this browser has not learned of any machines it did not already
 * know. The sources built from pairing records stand either way, which is the
 * whole point of `GET /directory` being availability and nothing else.
 */
export async function readDirectory(opts: {
  origin: string
  fleetPub: Uint8Array
  devicePub: Uint8Array
  fetch?: DirectoryFetch
}): Promise<FleetView> {
  const get = opts.fetch ?? browserFetch
  let body: string
  let entries: unknown
  try {
    const res = await get(new URL(DIRECTORY_PATH, opts.origin).toString())
    if (!res.ok) return NOTHING
    body = await res.text()
    if (body.length > MAX_DOCUMENT_CHARS) return NOTHING
    const doc: unknown = JSON.parse(body)
    entries = (doc as { entries?: unknown } | null)?.entries
  } catch {
    // A network error, a body that is not JSON, a relay answering HTML. All
    // of them are "not caught up", never "refuse to work".
    return NOTHING
  }
  if (!Array.isArray(entries)) return NOTHING

  // Collected first, ranked second. No order is promised in the answer, so a
  // revocation may arrive before the certificate it kills — and must still
  // kill it.
  const machines = new Map<string, DirectoryMachine>()
  const mine: { blob: Uint8Array; iat: number }[] = []
  const revoked = new Set<string>()
  let verified = 0

  for (const entry of entries.slice(0, MAX_ENTRIES)) {
    const blob = decodeBlob((entry as { blob?: unknown } | null)?.blob)
    if (blob === null) continue
    const cert = verifyCert(opts.fleetPub, blob)
    if (cert === null) continue
    verified++
    ingest(cert, blob, opts.devicePub, machines, mine, revoked)
  }

  const isRevoked = revoked.has(keyHex(opts.devicePub))
  return {
    machines: [...machines.values()].sort((a, b) => a.id.localeCompare(b.id)),
    // The reader's rule, in one line: a revocation outranks every device
    // certificate for the same key, whatever their timestamps. Presenting a
    // revoked certificate would be refused by any daemon that has heard of
    // the revocation (AddFromFleetCert checks the list inside its own write),
    // so carrying one would buy nothing but a channel that closes — and
    // building on it here would be this browser deciding it knows better.
    deviceCert: isRevoked ? null : newest(mine),
    revoked: isRevoked,
    entries: entries.length,
    verified,
  }
}

/** File one verified certificate under whichever of the three rules it is. */
function ingest(
  cert: Cert,
  blob: Uint8Array,
  devicePub: Uint8Array,
  machines: Map<string, DirectoryMachine>,
  mine: { blob: Uint8Array; iat: number }[],
  revoked: Set<string>,
): void {
  switch (cert.kind) {
    case 'machine': {
      // Two certificates for one machine is a machine that re-minted — a
      // daemon reinstalled, a static key regenerated — and both were signed
      // by the fleet, so this is a freshness question rather than a trust
      // one. The later `iat` wins; a tie keeps the first seen, which is
      // arbitrary and says so.
      const held = machines.get(cert.id)
      if (held === undefined || cert.iat > held.iat) {
        machines.set(cert.id, { id: cert.id, name: cert.name, noise: cert.noise, iat: cert.iat })
      }
      break
    }
    case 'device':
      // Only this device's own. Everybody else's certificates are the
      // daemons' business — this browser cannot present them, and holding a
      // roster of the fleet's devices is not something a tab is owed.
      if (sameKey(cert.device, devicePub)) mine.push({ blob, iat: cert.iat })
      break
    case 'revoke':
      revoked.add(keyHex(cert.device))
      break
  }
}

/** The newest of this device's certificates, or null when it has none. */
function newest(mine: { blob: Uint8Array; iat: number }[]): Uint8Array | null {
  let best: { blob: Uint8Array; iat: number } | null = null
  for (const c of mine) {
    if (best === null || c.iat > best.iat) best = c
  }
  return best?.blob ?? null
}

/**
 * One entry's `blob`: standard base64 with padding — the alphabet Go's
 * `encoding/json` reads a `[]byte` in, which is why the Worker writes it.
 *
 * The entry's `key` is deliberately not checked. It is the digest of these
 * bytes and the relay's own filing name; recomputing it would prove the relay
 * can hash, which is not a question anything here turns on. What decides
 * whether these bytes mean anything is the signature over them.
 */
function decodeBlob(value: unknown): Uint8Array | null {
  if (typeof value !== 'string' || value === '') return null
  // Four base64 characters per three bytes, so the ceiling on the encoding is
  // the ceiling on the bytes — checked before `atob` allocates anything.
  if (value.length > Math.ceil(MAX_BLOB_BYTES / 3) * 4) return null
  let raw: string
  try {
    raw = atob(value)
  } catch {
    return null
  }
  if (raw.length === 0 || raw.length > MAX_BLOB_BYTES) return null
  return Uint8Array.from(raw, (c) => c.charCodeAt(0))
}

/**
 * The real read: credential-less, uncached, and with no cookies on it.
 *
 * `credentials: 'omit'` because there is nothing to present and nothing this
 * route would do with it — the directory holds signed, public artifacts, and
 * the secret is what says who may *write*. `cache: 'no-store'` because a
 * revocation the browser learns of an hour late is an hour of a device that
 * should have been cut off; the Worker sends no-store too, and this is the
 * half that does not depend on the relay being honest about it.
 */
function browserFetch(url: string): Promise<DirectoryAnswer> {
  return fetch(url, { cache: 'no-store', credentials: 'omit' })
}
