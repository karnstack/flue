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
 */
const DAEMON_RECORD = 'daemon-static'

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
  const db = await openDb(factory)
  try {
    const existing = await tx<{ publicKey: Uint8Array } | undefined>(db, 'readonly', (s) =>
      s.get(DAEMON_RECORD),
    )
    // Copied out rather than handed back as it was read: the value structured
    // clone returns is this caller's own, and the next reader deserves the
    // stored bytes rather than whatever the last one did to theirs.
    return existing ? new Uint8Array(existing.publicKey) : null
  } finally {
    db.close()
  }
}
