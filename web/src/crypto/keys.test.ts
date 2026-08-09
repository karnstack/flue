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

describe('a malformed pinned record', () => {
  // Why absent rather than as-stored: a pin that is not 32 bytes is not an
  // X25519 static key, and a boot that hands it to the handshake anyway
  // throws inside messageA — a shutdown the client answers by reconnecting
  // into the identical throw, forever, with nothing on screen to say why.
  // Read as absent, the same wrong bytes fail closed into the picker and the
  // pairing ceremony, which is the one path that can replace them.

  it('reads as absent when the stored key is not 32 bytes', async () => {
    const db = new IDBFactory()
    await savePinnedDaemonKey(new Uint8Array(31), db)
    expect(await loadPinnedDaemonKey(db)).toBeNull()
  })

  it('reads as absent whichever way the length is wrong', async () => {
    const db = new IDBFactory()
    await savePinnedDaemonKey(new Uint8Array(33), db)
    expect(await loadPinnedDaemonKey(db)).toBeNull()

    await savePinnedDaemonKey(new Uint8Array(0), db)
    expect(await loadPinnedDaemonKey(db)).toBeNull()
  })

  it('reads as absent for a per-machine pin too', async () => {
    const db = new IDBFactory()
    await savePinnedDaemonKeyFor('b5d05f15398a', new Uint8Array(16), db)
    expect(await loadPinnedDaemonKeyFor('b5d05f15398a', db)).toBeNull()
  })

  it('does not shadow a well-formed pin beside it', async () => {
    // One machine's corrupt record is that machine's problem alone.
    const db = new IDBFactory()
    const good = new Uint8Array(32).fill(9)
    await savePinnedDaemonKeyFor('aaaaaaaaaaaa', good, db)
    await savePinnedDaemonKeyFor('bbbbbbbbbbbb', new Uint8Array(31), db)

    expect(await loadPinnedDaemonKeyFor('aaaaaaaaaaaa', db)).toEqual(good)
    expect(await loadPinnedDaemonKeyFor('bbbbbbbbbbbb', db)).toBeNull()
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
    // The whole reason this exists. One relay origin fronts every machine
    // you own, so a store with one slot per origin means opening machine B
    // overwrites machine A's key — and the *next* session on A builds its
    // Noise IK handshake against B's static, fails silently, and reconnects
    // into the same failure forever.
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

  it('replaces a machine’s key when a later pairing pins a different one', async () => {
    // The pairing ceremony is the authority on which key belongs to which
    // machine: the key is taken from the QR and matched against the daemon's
    // own answer before this is ever called (routes/pair.tsx), so a differing
    // key under the same id is that slot re-paired, not a second opinion to
    // referee. Write-through, so a browser can never be stuck on bytes it
    // once cached.
    const db = new IDBFactory()
    await savePinnedDaemonKeyFor('aaaaaaaaaaaa', KEY_A, db)
    await savePinnedDaemonKeyFor('aaaaaaaaaaaa', KEY_B, db)
    expect(await loadPinnedDaemonKeyFor('aaaaaaaaaaaa', db)).toEqual(KEY_B)
  })
})
