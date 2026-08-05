import { describe, expect, it } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import { loadOrCreateDeviceKey, loadPinnedDaemonKey, savePinnedDaemonKey } from './keys'

describe('the browser device key', () => {
  it('creates once and returns the same key thereafter', async () => {
    const db = new IDBFactory()
    const k1 = await loadOrCreateDeviceKey(db)
    expect(k1.publicKey).toHaveLength(32)
    expect(k1.privateKey).toHaveLength(32)
    const k2 = await loadOrCreateDeviceKey(db)
    expect(k2.privateKey).toEqual(k1.privateKey)
    expect(k2.publicKey).toEqual(k1.publicKey)
  })

  it('keys are isolated per database', async () => {
    const k1 = await loadOrCreateDeviceKey(new IDBFactory())
    const k2 = await loadOrCreateDeviceKey(new IDBFactory())
    expect(k1.privateKey).not.toEqual(k2.privateKey)
  })
})

describe('the pinned daemon key', () => {
  it('is absent until a pairing has handed one over', async () => {
    expect(await loadPinnedDaemonKey(new IDBFactory())).toBeNull()
  })

  it('round-trips the bytes it was pinned with', async () => {
    const db = new IDBFactory()
    const pub = Uint8Array.from({ length: 32 }, (_, i) => i * 7)
    await savePinnedDaemonKey(pub, db)
    expect(await loadPinnedDaemonKey(db)).toEqual(pub)
  })

  it('is replaced when this browser pairs with another daemon', async () => {
    const db = new IDBFactory()
    await savePinnedDaemonKey(new Uint8Array(32).fill(1), db)
    await savePinnedDaemonKey(new Uint8Array(32).fill(2), db)
    expect(await loadPinnedDaemonKey(db)).toEqual(new Uint8Array(32).fill(2))
  })

  it('shares a store with the device key without disturbing it', async () => {
    // Same database and same object store, two records. A pin that overwrote
    // the device's own private key would cost this browser its identity — and
    // would look exactly like a successful pairing until the first handshake.
    const db = new IDBFactory()
    const before = await loadOrCreateDeviceKey(db)
    await savePinnedDaemonKey(new Uint8Array(32).fill(3), db)

    const after = await loadOrCreateDeviceKey(db)
    expect(after.privateKey).toEqual(before.privateKey)
    expect(await loadPinnedDaemonKey(db)).toEqual(new Uint8Array(32).fill(3))
  })
})
