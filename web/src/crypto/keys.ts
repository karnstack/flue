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
    const privateKey = crypto.getRandomValues(new Uint8Array(32))
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
 * Pin the static key of one machine, under its device id —
 * `hex(sha256(publicKey))[:12]`, the name a machine carries everywhere.
 *
 * The per-machine counterpart of `savePinnedDaemonKey`, kept for the relay
 * that fronts more than one machine on one origin: each pairing ceremony pins
 * its machine's key under that machine's id, so two machines are two records
 * and neither can overwrite the other.
 *
 * Which is why it overwrites without asking. A device id *is*
 * `hex(sha256(publicKey))[:12]`, so a different key under the same id is not a
 * second opinion about one machine, it is a 48-bit collision or a stale cache —
 * and refusing to overwrite would turn a crafted link into a permanent denial
 * of service for that machine in this browser. What the record buys is a
 * reload: the fragment carrying the key is scrubbed the moment it is read, so
 * without this a refreshed tab would have no key to hand the handshake.
 *
 * Which puts the whole weight on the caller: *only* a key that hashes to
 * `deviceId` may be written here, because a record failing that is exactly the
 * lasting denial of service the overwrite was meant not to be. `relay/session.ts`
 * (`namesItsOwnKey`) is where that is checked — before this is called, and
 * before anything else is written down.
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

/** One record out of the key store, copied out of whatever IndexedDB returned. */
async function read(record: string, factory: IDBFactory): Promise<Uint8Array | null> {
  const db = await openDb(factory)
  try {
    const existing = await tx<{ publicKey: Uint8Array } | undefined>(db, 'readonly', (s) =>
      s.get(record),
    )
    // Copied out rather than handed back as it was read: the value structured
    // clone returns is this caller's own, and the next reader deserves the
    // stored bytes rather than whatever the last one did to theirs.
    return existing ? new Uint8Array(existing.publicKey) : null
  } finally {
    db.close()
  }
}
