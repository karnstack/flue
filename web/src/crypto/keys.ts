/*
 * The browser's static Noise key, in IndexedDB per the design's key-storage
 * decision. Raw bytes rather than a CryptoKey: WebCrypto's X25519 coverage
 * is still patchy (the reason the design picked noble), and a non-extractable
 * key cannot feed a userland Noise implementation anyway. The compensating
 * control is the strict CSP on every origin that serves the UI — a stored
 * key is a persistent grant to a shell, and XSS would be key theft.
 */
import { x25519 } from '@noble/curves/ed25519.js'

export interface DeviceKey {
  publicKey: Uint8Array
  privateKey: Uint8Array
}

const DB_NAME = 'flue'
const STORE = 'keys'
const RECORD = 'device-static'

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
    const existing = await tx<{ privateKey: Uint8Array } | undefined>(db, 'readonly', (s) => s.get(RECORD))
    if (existing) {
      const privateKey = new Uint8Array(existing.privateKey)
      return { privateKey, publicKey: x25519.getPublicKey(privateKey) }
    }
    const privateKey = crypto.getRandomValues(new Uint8Array(32))
    await tx(db, 'readwrite', (s) => s.put({ privateKey }, RECORD))
    return { privateKey, publicKey: x25519.getPublicKey(privateKey) }
  } finally {
    db.close()
  }
}
