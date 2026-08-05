import { describe, expect, it } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import { loadOrCreateDeviceKey } from './keys'

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
