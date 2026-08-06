import { describe, expect, it } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import {
  loadOrCreateDeviceKey,
  loadPinnedDaemonKey,
  loadPinnedDaemonKeyFor,
  savePinnedDaemonKey,
  savePinnedDaemonKeyFor,
} from './keys'

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

describe('a daemon key pinned per device', () => {
  const KEY_A = new Uint8Array(32).fill(0xaa)
  const KEY_B = new Uint8Array(32).fill(0xbb)

  it('is absent for a machine this browser has never opened', async () => {
    expect(await loadPinnedDaemonKeyFor('b5d05f15398a', new IDBFactory())).toBeNull()
  })

  it('round-trips the bytes it was pinned with', async () => {
    const db = new IDBFactory()
    await savePinnedDaemonKeyFor('b5d05f15398a', KEY_A, db)
    expect(await loadPinnedDaemonKeyFor('b5d05f15398a', db)).toEqual(KEY_A)
  })

  it('holds two machines’ keys at once, and hands back the right one', async () => {
    // The whole reason this exists. A SaaS relay is ONE origin in front of
    // every machine on every account, so a store with one slot per origin
    // means opening machine B overwrites machine A's key — and the *next*
    // session on A builds its Noise IK handshake against B's static, fails
    // silently, and reconnects into the same failure forever.
    const db = new IDBFactory()
    await savePinnedDaemonKeyFor('aaaaaaaaaaaa', KEY_A, db)
    await savePinnedDaemonKeyFor('bbbbbbbbbbbb', KEY_B, db)

    expect(await loadPinnedDaemonKeyFor('aaaaaaaaaaaa', db)).toEqual(KEY_A)
    expect(await loadPinnedDaemonKeyFor('bbbbbbbbbbbb', db)).toEqual(KEY_B)
  })

  it('does not disturb the single key a self-hosted browser pinned', async () => {
    // Self-host keeps the record it has always used — one origin, one daemon,
    // pinned by the /pair ceremony. A browser that had paired before this
    // existed must not have to pair again.
    const db = new IDBFactory()
    const selfHosted = new Uint8Array(32).fill(7)
    await savePinnedDaemonKey(selfHosted, db)
    await savePinnedDaemonKeyFor('aaaaaaaaaaaa', KEY_A, db)

    expect(await loadPinnedDaemonKey(db)).toEqual(selfHosted)
    expect(await loadPinnedDaemonKeyFor('aaaaaaaaaaaa', db)).toEqual(KEY_A)
    // And the reverse: the self-host record is not some device's record under
    // another name.
    expect(await loadPinnedDaemonKeyFor('', db)).toBeNull()
  })

  it('leaves the browser’s own device key alone', async () => {
    const db = new IDBFactory()
    const before = await loadOrCreateDeviceKey(db)
    await savePinnedDaemonKeyFor('aaaaaaaaaaaa', KEY_A, db)
    expect((await loadOrCreateDeviceKey(db)).privateKey).toEqual(before.privateKey)
  })

  it('replaces a machine’s key when the control plane hands over a new one', async () => {
    // The control plane is the authority on which key belongs to which
    // machine: the id *is* `sha256(key)[:12]`, so a differing key under the
    // same id cannot be a legitimate second opinion. Write-through, so a
    // browser can never be stuck on bytes it once cached.
    const db = new IDBFactory()
    await savePinnedDaemonKeyFor('aaaaaaaaaaaa', KEY_A, db)
    await savePinnedDaemonKeyFor('aaaaaaaaaaaa', KEY_B, db)
    expect(await loadPinnedDaemonKeyFor('aaaaaaaaaaaa', db)).toEqual(KEY_B)
  })
})
