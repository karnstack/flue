import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import { x25519 } from '@noble/curves/ed25519.js'

import {
  loadOrCreateDeviceKey,
  loadPinnedDeviceCert,
  loadPinnedFleetKey,
  savePinnedDeviceCert,
  savePinnedFleetKey,
} from '@/crypto/keys'
import {
  base64,
  deviceCert,
  enrolAnswer,
  enrolFetch,
  FLEET_PUB,
  machineCert,
  OTHER_PUB,
  OTHER_SEED,
} from '@/testing/fleet'
import { ENROL_PATH, enrolThisBrowser, FLEET_DIRECTORY_PATH, readDirectoryViaDaemon } from './enrol'

/** The machine this daemon holds on the relay, as its answer names it. */
const MACHINE = 'blue-mesa-1a2b'

/** Some other machine's Noise key, for the certificate that is not this
 *  browser's to hold. */
const LOFT_PUB = x25519.getPublicKey(new Uint8Array(32).fill(0x5c))

/** The daemon's answer for `cert`, under this fleet's key unless a case is
 *  about one that is not. */
const answerWith = (cert: Uint8Array, fleetPub: Uint8Array = FLEET_PUB) =>
  enrolAnswer(cert, fleetPub, MACHINE)

describe('enrolThisBrowser', () => {
  beforeEach(() => {
    vi.stubGlobal('indexedDB', new IDBFactory())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('posts this browser’s own key and keeps what the machine signed for it', async () => {
    const key = await loadOrCreateDeviceKey()
    const cert = deviceCert(key.publicKey, 'mesa — this machine’s browser', MACHINE)
    const post = enrolFetch(answerWith(cert))

    expect(await enrolThisBrowser(post)).toBe(true)

    // The two records a browser needs to be on a fleet rather than on one
    // machine, from the process that owns both.
    expect(await loadPinnedFleetKey()).toEqual(FLEET_PUB)
    expect(await loadPinnedDeviceCert()).toEqual(cert)
    expect(post.calls).toEqual([
      { path: ENROL_PATH, body: JSON.stringify({ publicKey: base64(key.publicKey) }) },
    ])
  })

  it('is idempotent across reloads: the second answer changes nothing', async () => {
    // The browser has no way to know whether this daemon has seen it before, so
    // it asks on every load; the daemon answers a known key with the same id
    // and the same certificate bytes. What must not happen is a browser that
    // reports a gain — and re-reads the directory — once per page load.
    const key = await loadOrCreateDeviceKey()
    const cert = deviceCert(key.publicKey, 'mesa', MACHINE)
    const post = enrolFetch(answerWith(cert))

    expect(await enrolThisBrowser(post)).toBe(true)
    expect(await enrolThisBrowser(post)).toBe(false)
    expect(await enrolThisBrowser(post)).toBe(false)

    expect(await loadPinnedFleetKey()).toEqual(FLEET_PUB)
    expect(await loadPinnedDeviceCert()).toEqual(cert)
    // Asked every time, which is the endpoint's own contract: idempotent by
    // lookup, so asking is how a browser finds out.
    expect(post.calls).toHaveLength(3)
  })

  it('keeps nothing when this machine holds no fleet key', async () => {
    // 409, the honest refusal from a machine that has not joined a relay. The
    // tab it leaves behind is the tab loopback has always been.
    const post = enrolFetch('this machine holds no fleet key', { ok: false, status: 409 })

    expect(await enrolThisBrowser(post)).toBe(false)

    expect(await loadPinnedFleetKey()).toBeNull()
    expect(await loadPinnedDeviceCert()).toBeNull()
    // Once. A tab that polled a 409 would be a request every few seconds for as
    // long as it stayed open, and the cure is a change on the machine.
    expect(post.calls).toHaveLength(1)
  })

  it('keeps nothing for a revoked key, an old daemon, or a fetch that failed', async () => {
    for (const status of [403, 404, 401, 503]) {
      expect(await enrolThisBrowser(enrolFetch('no', { ok: false, status }))).toBe(false)
    }
    const thrown = () => Promise.reject(new Error('network'))
    expect(await enrolThisBrowser(thrown)).toBe(false)
    expect(await loadPinnedFleetKey()).toBeNull()
    expect(await loadPinnedDeviceCert()).toBeNull()
  })

  it('refuses a certificate that does not verify under the key beside it', async () => {
    // Consistency, not trust — the trust here is the origin. What the check
    // buys is that a browser never stores a blob it could only be refused for
    // presenting to a sibling machine.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const key = await loadOrCreateDeviceKey()
    const cert = deviceCert(key.publicKey, 'mesa', MACHINE, 1_754_700_000, OTHER_SEED)

    expect(await enrolThisBrowser(enrolFetch(answerWith(cert)))).toBe(false)

    expect(await loadPinnedFleetKey()).toBeNull()
    expect(await loadPinnedDeviceCert()).toBeNull()
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('refuses a certificate for another device, and one that is not a device certificate', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const someoneElse = x25519.getPublicKey(new Uint8Array(32).fill(0x77))

    expect(await enrolThisBrowser(enrolFetch(answerWith(deviceCert(someoneElse))))).toBe(false)
    expect(await enrolThisBrowser(enrolFetch(answerWith(machineCert('loft-9f9f', 'Loft', LOFT_PUB))))).toBe(
      false,
    )

    expect(await loadPinnedFleetKey()).toBeNull()
    expect(await loadPinnedDeviceCert()).toBeNull()
  })

  it('refuses a fleet key that is not 32 bytes, and an answer that is not the shape', async () => {
    const key = await loadOrCreateDeviceKey()
    const cert = deviceCert(key.publicKey, 'mesa', MACHINE)

    expect(await enrolThisBrowser(enrolFetch(answerWith(cert, FLEET_PUB.slice(0, 31))))).toBe(false)
    expect(await enrolThisBrowser(enrolFetch({ deviceId: 'x' }))).toBe(false)
    expect(await enrolThisBrowser(enrolFetch('<!doctype html>'))).toBe(false)

    expect(await loadPinnedFleetKey()).toBeNull()
    expect(await loadPinnedDeviceCert()).toBeNull()
  })

  it('takes this machine’s key over a stale pin, and the certificate with it', async () => {
    // `flue relay setup` run again mints a fresh fleet key. adoptFleetKey
    // refuses that overwrite because a welcome brings no certificate to go with
    // it and a ceremony is the way out; on loopback both halves arrive together
    // from the machine that minted them, and there is no ceremony to go back to
    // — a pairing link points at the relay's address, another origin and
    // another storage partition.
    const key = await loadOrCreateDeviceKey()
    await savePinnedFleetKey(OTHER_PUB)
    await savePinnedDeviceCert(deviceCert(key.publicKey, 'old', MACHINE, 1_700_000_000, OTHER_SEED))
    const cert = deviceCert(key.publicKey, 'mesa', MACHINE)

    expect(await enrolThisBrowser(enrolFetch(answerWith(cert)))).toBe(true)

    expect(await loadPinnedFleetKey()).toEqual(FLEET_PUB)
    expect(await loadPinnedDeviceCert()).toEqual(cert)
  })

  it('reports the first certificate under a key it already held', async () => {
    // A browser that pinned the fleet key some other way and holds no
    // certificate has every machine on the fleet to gain, so this is a gain.
    await savePinnedFleetKey(FLEET_PUB)
    const key = await loadOrCreateDeviceKey()
    const cert = deviceCert(key.publicKey, 'mesa', MACHINE)

    expect(await enrolThisBrowser(enrolFetch(answerWith(cert)))).toBe(true)
    expect(await loadPinnedDeviceCert()).toEqual(cert)
  })

  it('keeps a replacement certificate without calling it a gain', async () => {
    // Every machine that ever certified this device signed a blob of its own,
    // all equally admitted everywhere and differing only in name and pairedOn.
    // So a new one is written down — the machine that just answered is as good
    // a source as any — and changes no machine's reachability.
    await savePinnedFleetKey(FLEET_PUB)
    const key = await loadOrCreateDeviceKey()
    await savePinnedDeviceCert(deviceCert(key.publicKey, 'mesa', 'attic-pi'))
    const fresh = deviceCert(key.publicKey, 'mesa', MACHINE, 1_759_999_999)

    expect(await enrolThisBrowser(enrolFetch(answerWith(fresh)))).toBe(false)
    expect(await loadPinnedDeviceCert()).toEqual(fresh)
  })
})

describe('readDirectoryViaDaemon', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('reads the daemon’s own path, uncached, with the session cookie', async () => {
    // And ignores the relay URL it is handed: that origin is precisely the one
    // this tab cannot fetch from — the Worker sends no CORS header — which is
    // the whole reason the seam exists.
    const calls: Array<[string, RequestInit | undefined]> = []
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
      calls.push([url, init])
      return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve('{}') })
    })

    await readDirectoryViaDaemon('https://relay.example/directory')

    expect(calls).toEqual([
      [FLEET_DIRECTORY_PATH, { cache: 'no-store', credentials: 'same-origin' }],
    ])
  })
})
