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

/** An X25519 key, in bytes. Anything else is not one. */
const KEY_BYTES = 32

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
 * once and never asked about again. It is written from the pairing ceremony
 * and from nowhere else, with a value that arrived in the QR: the one leg no
 * intermediary can sit in.
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
 * Pin the fleet this browser has just joined, from the `f=` in the pairing
 * link.
 *
 * Called from the same moment, and on the same evidence, as
 * `savePinnedDaemonKeyFor`: the user carried a code across from a screen they
 * physically control, and both keys were read out of it. What this one buys is
 * every *other* machine — the directory names them, this key is what makes
 * their certificates mean anything, and neither the relay nor anything sitting
 * in front of it can produce one.
 *
 * Overwrites, for the reason the daemon pin does: re-pairing is how a browser
 * moves to another fleet, and re-setup (`flue relay setup`) mints a fresh
 * fleet key that every device then pairs against. A browser that refused the
 * overwrite would be stranded on a key nothing signs under any more, with
 * clearing site data as the only way back.
 *
 * Which puts the same weight on the caller: only a key that arrived in the
 * link may be written here. A fleet key taken from an answer over the wire
 * would be the trust-on-first-use the pinning exists to end, one level up —
 * whoever supplied it could then mint a machine certificate for every machine
 * this browser will ever dial.
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
 */
export async function loadPinnedFleetKey(
  factory: IDBFactory = indexedDB,
): Promise<Uint8Array | null> {
  return read(FLEET_RECORD, factory)
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
