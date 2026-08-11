/*
 * The browser's static Noise key, in IndexedDB per the design's key-storage
 * decision. Raw bytes rather than a CryptoKey: WebCrypto's X25519 coverage
 * is still patchy (the reason the design picked noble), and a non-extractable
 * key cannot feed a userland Noise implementation anyway. The compensating
 * control is the strict CSP on every origin that serves the UI — a stored
 * key is a persistent grant to a shell, and XSS would be key theft.
 *
 * "Every origin" is two, and they carry the policy by different means: the
 * daemon sets it as a response header (`internal/daemon`, `LocalCSP` through
 * `securityHeaders`), and a relay serves the bundle from Cloudflare's asset
 * router, which is configured with the `_headers` document `flue relay setup`
 * sends (`RelayCSP`, cmd/flue/relay.go). The relay origin is the one reachable
 * from the internet, so it is the one where this sentence has to be true rather
 * than aspirational — relay/test/routing.test.ts is where that is checked.
 */
import { x25519 } from '@noble/curves/ed25519.js'

export interface DeviceKey {
  publicKey: Uint8Array
  privateKey: Uint8Array
}

const DB_NAME = 'flue'
const STORE = 'keys'
const DEVICE_RECORD = 'device-static'

/**
 * An X25519 key, in bytes. Anything else is not one — and the Ed25519 fleet
 * public key is the same width, which is why one constant serves both.
 *
 * Exported because the check moved out of this module's reach. A key arriving
 * on a connection (fleet/fleet.ts, adoptFleetKey) has to be measured before it
 * is written, not only when it is read back: `read` below refuses a record of
 * the wrong width, so a bad write would be a browser that silently holds no
 * fleet key at all rather than one that fails at the moment it was handed
 * nonsense.
 */
export const KEY_BYTES = 32

/**
 * Where the daemon's static public key is pinned, once pairing has handed one
 * over.
 *
 * Same store as the device's own key, because the two are one fact: this
 * browser is paired to that daemon. A key here is what the Noise IK initiator
 * will be given as the responder's static — the pattern authenticates the
 * daemon by proving it holds the private half — so a record that could be
 * replaced silently would be the whole of the trust decision, made once at
 * pairing time and never asked about again.
 *
 * **One record, and that is a statement about the deployment.** A self-hosted
 * relay is one origin in front of one machine, so "the daemon this browser is
 * paired to" is a fact about the origin and this is where it lives. A hosted
 * relay is one origin in front of every machine on every account, where that
 * sentence is not true of anything — see `DEVICE_RECORD_PREFIX`.
 */
const DAEMON_RECORD = 'daemon-static'

/**
 * Where a hosted relay's per-machine keys live: one record per device id.
 *
 * The bug this exists to close: with one slot per origin, opening machine B's
 * session overwrites machine A's pinned key, and A's next session builds its
 * IK handshake against B's static. `readMessageB` throws, the socket reports
 * an ordinary close, and FlueClient reconnects into the identical failure for
 * as long as the tab is open — with nothing on screen to say why.
 *
 * The prefix is deliberately *not* the self-host record's own name, so the two
 * schemes cannot collide: `daemon-static` and `daemon-static:<id>` are
 * different strings for every id, including the empty one. A browser that
 * paired with a self-hosted daemon before any of this existed keeps its pin
 * exactly where it left it, and does not have to pair again.
 */
const DEVICE_RECORD_PREFIX = 'daemon-static:'

/**
 * Where the fleet public key is pinned: one record, because one relay origin
 * is one fleet (spec/fleet-trust.md, "The fleet directory").
 *
 * This is the anchor the whole of auto-pairing hangs from. A machine
 * certificate that verifies under this key is a machine this browser will
 * dial, pinning the `noise` key that certificate names — so a record that
 * could be replaced silently would be every machine's static key, decided
 * once and never asked about again.
 *
 * **Two writers, and the second is narrower than the first.** The pairing
 * ceremony writes the value that arrived in the QR — the one leg no
 * intermediary can sit in — and that is still where a browser meets a fleet.
 * The other is fleet/fleet.ts's adoptFleetKey, for the browser the QR reached
 * before its machine had a key to put in one: it keeps a key off a welcome,
 * and only from a session this browser opened against a daemon static key it
 * pinned at a ceremony of its own. That is an authenticated statement from a
 * party it already trusts rather than an assertion from an unknown peer — the
 * relay cannot forge the Noise session, and a daemon that could lie holds the
 * fleet seed already. It refuses to overwrite; see below.
 *
 * The Ed25519 *public* half only. The seed rides the join line between
 * machines and never reaches a browser — a browser holding it could mint
 * certificates for the fleet, which is the one thing the layering in
 * spec/fleet-trust.md exists to keep out of Cloudflare's reach and out of a
 * tab's.
 *
 * Per origin rather than per machine, unlike `DEVICE_RECORD_PREFIX`, and the
 * difference is not an inconsistency: a daemon's static key is a fact about
 * one machine, and the fleet key is a fact about the relay in front of all of
 * them. IndexedDB is already scoped to the origin, so one record here is one
 * fleet key per relay.
 */
const FLEET_RECORD = 'fleet-public'

/**
 * This device's own fleet certificate, per origin like the fleet key that
 * verifies it. See `savePinnedDeviceCert` for why it is kept rather than read
 * off the relay.
 */
const DEVICE_CERT_RECORD = 'fleet-device-cert'

const openDb = (factory: IDBFactory) =>
  new Promise<IDBDatabase>((resolve, reject) => {
    const req = factory.open(DB_NAME, 1)
    req.onupgradeneeded = () => req.result.createObjectStore(STORE)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })

const tx = <T>(db: IDBDatabase, mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    const req = run(db.transaction(STORE, mode).objectStore(STORE))
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })

export async function loadOrCreateDeviceKey(factory: IDBFactory = indexedDB): Promise<DeviceKey> {
  const db = await openDb(factory)
  try {
    const existing = await tx<{ privateKey: Uint8Array } | undefined>(db, 'readonly', (s) =>
      s.get(DEVICE_RECORD),
    )
    if (existing) {
      const privateKey = new Uint8Array(existing.privateKey)
      return { privateKey, publicKey: x25519.getPublicKey(privateKey) }
    }
    const privateKey = crypto.getRandomValues(new Uint8Array(KEY_BYTES))
    await tx(db, 'readwrite', (s) => s.put({ privateKey }, DEVICE_RECORD))
    return { privateKey, publicKey: x25519.getPublicKey(privateKey) }
  } finally {
    db.close()
  }
}

/**
 * Pin the daemon this browser has just paired with.
 *
 * Called once, from the /pair page, with the key the daemon returned over the
 * one connection the user themselves established by carrying a token across
 * from an already-trusted screen. That moment is the entire basis of the trust:
 * from here on the initiator names this key as the responder's static, and a
 * daemon that cannot prove it holds the private half fails the handshake.
 *
 * Overwrites whatever was there, because re-pairing is how a browser is meant
 * to move to another daemon — and doing that from the pairing ceremony is the
 * one place a user has said so.
 */
export async function savePinnedDaemonKey(
  publicKey: Uint8Array,
  factory: IDBFactory = indexedDB,
): Promise<void> {
  const db = await openDb(factory)
  try {
    await tx(db, 'readwrite', (s) => s.put({ publicKey }, DAEMON_RECORD))
  } finally {
    db.close()
  }
}

/** The pinned daemon key, or null in a browser that has never paired. */
export async function loadPinnedDaemonKey(
  factory: IDBFactory = indexedDB,
): Promise<Uint8Array | null> {
  return read(DAEMON_RECORD, factory)
}

/**
 * Pin the static key of one machine, under the machine id it holds on the
 * relay — the `<id>` in `/client/<id>`, minted by `flue relay setup` and
 * `join`, carried into the ceremony by the pairing link.
 *
 * The per-machine counterpart of `savePinnedDaemonKey`, kept for the relay
 * that fronts more than one machine on one origin: each pairing ceremony pins
 * its machine's key under that machine's id, so two machines are two records
 * and neither can overwrite the other.
 *
 * Which is why it overwrites without asking. Pairing the same id again is the
 * ordinary way this browser learns that a machine's key changed — a daemon
 * reinstalled, its identity reminted — and refusing to overwrite would strand
 * the browser on the stale pin forever, with forgetting the machine by hand
 * as the only way back. What the record buys is a reload: the key travels in
 * the link's `?k=` query parameter, and the pairing page scrubs `t` and `k`
 * from the address bar once it has read them (routes/pair.tsx, via
 * lib/url.ts's scrubPairingParams) — so without this a refreshed tab would
 * have no key to hand the handshake.
 *
 * Which puts the whole weight on the caller: *only* a key the ceremony proved
 * is the machine's — taken from the QR, and matched against the daemon's own
 * answer — may be written here, because a record failing that is exactly the
 * lasting denial of service the overwrite was meant not to be. routes/pair.tsx
 * is where that is checked — before this is called, and before anything else
 * is written down.
 */
export async function savePinnedDaemonKeyFor(
  deviceId: string,
  publicKey: Uint8Array,
  factory: IDBFactory = indexedDB,
): Promise<void> {
  const db = await openDb(factory)
  try {
    await tx(db, 'readwrite', (s) => s.put({ publicKey }, `${DEVICE_RECORD_PREFIX}${deviceId}`))
  } finally {
    db.close()
  }
}

/** The key pinned for one machine, or null if this browser holds none. */
export async function loadPinnedDaemonKeyFor(
  deviceId: string,
  factory: IDBFactory = indexedDB,
): Promise<Uint8Array | null> {
  return read(`${DEVICE_RECORD_PREFIX}${deviceId}`, factory)
}

/**
 * Pin the fleet this browser has just joined: from the `f=` in the pairing
 * link, or from a welcome that came in over a pinned daemon key.
 *
 * The link is the original and the stronger of the two. The user carried a code
 * across from a screen they physically control and both keys were read out of
 * it, which is the same moment and the same evidence as
 * `savePinnedDaemonKeyFor`. What this one buys is every *other* machine — the
 * directory names them, this key is what makes their certificates mean
 * anything, and neither the relay nor anything sitting in front of it can
 * produce one.
 *
 * Overwrites, for the reason the daemon pin does: re-pairing is how a browser
 * moves to another fleet, and re-setup (`flue relay setup`) mints a fresh
 * fleet key that every device then pairs against. A browser that refused the
 * overwrite would be stranded on a key nothing signs under any more, with
 * clearing site data as the only way back.
 *
 * Which puts the weight on the caller, and the three callers carry it
 * differently. The ceremony writes what the QR said, unconditionally.
 * fleet/fleet.ts's adoptFleetKey writes only into an empty record, and only a
 * key that reached this browser over a Noise session keyed to a daemon static
 * key it pinned at a ceremony of its own. fleet/enrol.ts writes what this
 * machine's own daemon answered on loopback, overwriting if it differs, because
 * there the answer comes from the process that owns the key over a socket with
 * no room in it for anybody else — and because a loopback tab has no ceremony
 * to be sent back to.
 *
 * None of the three is trust-on-first-use: the first learned the key out of
 * band, the second from a party it had already authenticated out of band, the
 * third from the machine the page itself came from. What would be is a key
 * taken off a connection to a peer this browser never pinned — whoever supplied
 * it could then mint a machine certificate for every machine this browser will
 * ever dial — and there is no path here that does that.
 */
export async function savePinnedFleetKey(
  publicKey: Uint8Array,
  factory: IDBFactory = indexedDB,
): Promise<void> {
  const db = await openDb(factory)
  try {
    await tx(db, 'readwrite', (s) => s.put({ publicKey }, FLEET_RECORD))
  } finally {
    db.close()
  }
}

/**
 * The pinned fleet public key, or null in a browser that has never paired
 * with a fleet.
 *
 * Null is an ordinary answer, not a fault: a browser paired before the fleet
 * key existed, or with a daemon that holds none, reaches every machine it
 * paired with directly and learns of no others. What it must never do is read
 * the directory without one — an unverifiable machine list is a relay naming
 * whatever machines it likes.
 *
 * Nor is null necessarily the last word any more. A browser that pinned a
 * daemon key takes a fleet key off that machine's next welcome
 * (fleet/fleet.ts, adoptFleetKey), so null here often means "not yet, and this
 * tab is about to fix it" rather than "not ever". Every reader must go on
 * treating it as the answer for now — the callers are all `await`ed at the
 * moment they ask, and a fleet re-read after adoption is what turns the corner.
 */
export async function loadPinnedFleetKey(
  factory: IDBFactory = indexedDB,
): Promise<Uint8Array | null> {
  return read(FLEET_RECORD, factory)
}

/**
 * Keep this device's own fleet certificate — the signed blob it presents to
 * every machine it has not paired with by hand.
 *
 * Stored rather than fetched, and that is the change this record represents.
 * The certificate used to be read out of the relay's credential-less
 * `GET /directory`, which meant every device's public key and human label sat
 * in a document anybody could read, and every pairing ceremony ever performed
 * spent one of the directory's 512 permanent entries. It now arrives over
 * channels that are already private and already authenticated — in the pairing
 * answer, and again in the welcome of every *relayed* connection — so the
 * public copy buys nothing.
 *
 * The second delivery is a relay-tab property and not a universal one, which
 * is worth knowing before relying on it: a loopback connection authenticates a
 * machine-local session token rather than a device key, so the daemon does not
 * know whose certificate to send and sends none (internal/daemon/server.go,
 * fleetCertFor). What a loopback tab has instead is the third writer,
 * fleet/enrol.ts: it names its device key over `POST /api/fleet/enrol` and the
 * daemon signs one for it, which is how a browser that never ran a ceremony
 * comes to hold a certificate at all.
 *
 * It is public data either way: a certificate is a signed statement about a
 * public key, and holding one grants nothing without the private half of the
 * device key beside it in this same store. What this record protects is not
 * secrecy but *supply* — a browser that cannot produce its certificate cannot
 * reach a machine it never paired with.
 *
 * Per origin, like the fleet key it verifies under: a certificate signed by one
 * fleet means nothing to another, and the two records are only ever read
 * together.
 *
 * Callers must verify it under the pinned fleet key before writing it. This
 * function does not, deliberately — it is storage, and crypto/cert.ts is where
 * signatures are checked — but a caller that skipped the check would be keeping
 * whatever the far end said, and presenting it later to a machine that will
 * check it properly and refuse.
 */
export async function savePinnedDeviceCert(
  cert: Uint8Array,
  factory: IDBFactory = indexedDB,
): Promise<void> {
  const db = await openDb(factory)
  try {
    await tx(db, 'readwrite', (s) => s.put({ publicKey: cert }, DEVICE_CERT_RECORD))
  } finally {
    db.close()
  }
}

/**
 * This device's fleet certificate, or null when it has none.
 *
 * Null is an ordinary answer and not a fault: a browser paired with a daemon
 * that held no fleet key, or before this machine had a place on the relay, has
 * none — and reaches every machine it paired with directly, exactly as it
 * always did. What it cannot do without one is walk into a machine it has never
 * met, which is the thing a certificate is for.
 */
export async function loadPinnedDeviceCert(
  factory: IDBFactory = indexedDB,
): Promise<Uint8Array | null> {
  return readBlob(DEVICE_CERT_RECORD, factory)
}

/**
 * Drop the key pinned for one machine.
 *
 * The other half of forgetting a machine (relay/machines.ts): a record without
 * its key is a row the boot can never connect, and a key without its record is
 * a credential the UI no longer admits to holding. Deleting a record that was
 * never there succeeds, as IndexedDB's own delete does — forget is idempotent.
 */
export async function deletePinnedDaemonKeyFor(
  deviceId: string,
  factory: IDBFactory = indexedDB,
): Promise<void> {
  const db = await openDb(factory)
  try {
    await tx(db, 'readwrite', (s) => s.delete(`${DEVICE_RECORD_PREFIX}${deviceId}`))
  } finally {
    db.close()
  }
}

/** One record out of the key store, copied out of whatever IndexedDB returned. */
async function read(record: string, factory: IDBFactory): Promise<Uint8Array | null> {
  const db = await openDb(factory)
  try {
    const existing = await tx<{ publicKey: Uint8Array } | undefined>(db, 'readonly', (s) =>
      s.get(record),
    )
    if (!existing) return null
    // Copied out rather than handed back as it was read: the value structured
    // clone returns is this caller's own, and the next reader deserves the
    // stored bytes rather than whatever the last one did to theirs.
    const key = new Uint8Array(existing.publicKey)
    // A pin that is not 32 bytes is not an X25519 static key, and handing it
    // to the handshake anyway throws inside messageA — a shutdown FlueClient
    // answers by reconnecting into the identical throw, silently and forever.
    // Absent is the honest reading of a record this module could never have
    // written: the boot fails closed into the picker, where pairing again is
    // on offer, instead of open into a loop nothing on screen explains.
    //
    // The fleet key is the same 32 bytes and fails the same way closed: a
    // verifier handed a key of the wrong width refuses every certificate,
    // which is a browser that lists no machines rather than one that trusts
    // the wrong ones.
    return key.length === KEY_BYTES ? key : null
  } finally {
    db.close()
  }
}

/**
 * One record read as an opaque blob: no width check, because a certificate is
 * not a key and has no fixed length.
 *
 * It shares `read`'s copy-out rule for the same reason, and stops there. What
 * makes a stored certificate trustworthy is its signature under the pinned
 * fleet key, which crypto/cert.ts checks every time it is used — so there is
 * nothing this function could usefully refuse that the verifier would not.
 */
async function readBlob(record: string, factory: IDBFactory): Promise<Uint8Array | null> {
  const db = await openDb(factory)
  try {
    const existing = await tx<{ publicKey: Uint8Array } | undefined>(db, 'readonly', (s) =>
      s.get(record),
    )
    if (!existing) return null
    const blob = new Uint8Array(existing.publicKey)
    return blob.length === 0 ? null : blob
  } finally {
    db.close()
  }
}

/**
 * This browser's device id: the identity the daemon files it under, derived
 * from the key itself so an entry cannot claim to be a key it does not hold.
 *
 * The same derivation as `crypto.DeviceID` in internal/crypto/devices.go —
 * SHA-256 of the raw public key, hex, first twelve characters — and it has to
 * stay the same, because matching against it is how a Devices screen picks out
 * the row that is the browser reading it. That row must not be offered a
 * revoke: revoking it publishes a revocation the whole fleet honours and the
 * enrolment endpoint then refuses that key forever, so the button would cut
 * this browser off every machine with no way back short of clearing storage.
 *
 * Derived here rather than kept from the enrolment answer, which does return a
 * deviceId: a value computed from the key in hand cannot go stale, and a
 * browser that enrolled before this existed has nothing stored to read.
 */
export async function deviceIdOf(publicKey: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', publicKey as BufferSource)
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 12)
}
