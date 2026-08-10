import { describe, expect, it } from 'vitest'

import { keyHex } from '@/crypto/cert'
import {
  base64,
  deviceCert,
  directoryFetch,
  FLEET_PUB,
  machineCert,
  OTHER_SEED,
  revocation,
} from '@/testing/fleet'
import { readDirectory } from './directory'

const ORIGIN = 'https://relay.example'
const DEVICE = new Uint8Array(32).fill(0x2a)
const OTHER_DEVICE = new Uint8Array(32).fill(0x3b)
const ATTIC_NOISE = new Uint8Array(32).fill(0xa1)
const MESA_NOISE = new Uint8Array(32).fill(0xb2)

const read = (blobs: Uint8Array[], devicePub = DEVICE) =>
  readDirectory({ origin: ORIGIN, fleetPub: FLEET_PUB, devicePub, fetch: directoryFetch(blobs) })

describe('reading the fleet directory', () => {
  it('builds a machine from a certificate that verifies', async () => {
    const view = await read([machineCert('attic-pi', 'Attic Pi', ATTIC_NOISE)])
    expect(view.machines).toHaveLength(1)
    expect(view.machines[0]).toMatchObject({ id: 'attic-pi', name: 'Attic Pi' })
    // The `noise` key is the whole point: it is what the browser pins for the
    // IK handshake with a machine it has never met.
    expect(keyHex(view.machines[0]!.noise)).toBe(keyHex(ATTIC_NOISE))
    expect(view).toMatchObject({ entries: 1, verified: 1, revoked: false })
  })

  it('asks the relay origin for /directory, with no id in the path', async () => {
    // One relay is one fleet, so the object's name is a constant and the
    // route names no machine.
    const fetch = directoryFetch([])
    await readDirectory({ origin: ORIGIN, fleetPub: FLEET_PUB, devicePub: DEVICE, fetch })
    expect(fetch.calls).toEqual(['https://relay.example/directory'])
  })

  it('never makes a machine out of a certificate signed by another key', async () => {
    // The negative the whole leg exists for. The relay stores blobs it cannot
    // read, so anything can be in there; what makes a machine is a signature
    // under the key this browser pinned at pairing, and nothing else.
    const view = await read([
      machineCert('attic-pi', 'Attic Pi', ATTIC_NOISE, 1_754_700_000, OTHER_SEED),
    ])
    expect(view.machines).toEqual([])
    expect(view).toMatchObject({ entries: 1, verified: 0 })
  })

  it('never makes a machine out of a certificate with a byte flipped', async () => {
    const blob = machineCert('attic-pi', 'Attic Pi', ATTIC_NOISE)
    // Inside the fields, past the prefix, the version and the kind byte.
    blob[20] = blob[20]! ^ 1
    expect((await read([blob])).machines).toEqual([])
  })

  it('refuses a blob cut short, and one with a byte appended', async () => {
    const blob = machineCert('attic-pi', 'Attic Pi', ATTIC_NOISE)
    const longer = new Uint8Array(blob.length + 1)
    longer.set(blob)
    const view = await read([blob.subarray(0, blob.length - 1), longer])
    expect(view.machines).toEqual([])
    expect(view.verified).toBe(0)
  })

  it('keeps the later certificate when a machine has re-minted', async () => {
    // A daemon reinstalled, its static key regenerated. Both were signed by
    // the fleet, so this is freshness, not trust — and a browser left on the
    // older key would dial a machine it can never handshake with.
    const view = await read([
      machineCert('attic-pi', 'Attic Pi', ATTIC_NOISE, 1_754_700_000),
      machineCert('attic-pi', 'Attic Pi II', MESA_NOISE, 1_754_700_900),
    ])
    expect(view.machines).toHaveLength(1)
    expect(view.machines[0]!.name).toBe('Attic Pi II')
    expect(keyHex(view.machines[0]!.noise)).toBe(keyHex(MESA_NOISE))
  })

  it('sorts machines by id, so two reads build the same list', async () => {
    // The answer promises no order — storage sorts by digest, which is to say
    // by nothing — so the reader imposes one of its own.
    const view = await read([
      machineCert('mesa-1a2b', 'Mesa', MESA_NOISE),
      machineCert('attic-pi', 'Attic Pi', ATTIC_NOISE),
    ])
    expect(view.machines.map((m) => m.id)).toEqual(['attic-pi', 'mesa-1a2b'])
  })
})

describe('the device certificates a browser no longer reads out of the directory', () => {
  it('counts one as verified and takes nothing from it', async () => {
    // A device certificate here is an anomaly: nothing in a fleet publishes
    // one, and no released flue has a directory to have published it from. It
    // verifies, so it is counted — the number is "how much of this did our
    // fleet key sign" — and it is otherwise ignored: this browser holds its
    // own certificate (crypto/keys.ts, from the pairing answer and every
    // relayed welcome) and was never owed anybody else's.
    const view = await read([deviceCert(DEVICE, 'my phone'), deviceCert(OTHER_DEVICE, 'somebody')])
    expect(view.verified).toBe(2)
    expect(view.machines).toEqual([])
    expect(view.revoked).toBe(false)
  })
})

describe('a revocation is what the reader still owes a stored certificate', () => {
  it('reports this device as revoked however much fresher any certificate is', async () => {
    // The rule with its own sentence in the spec: `iat` is display, never
    // precedence. A reader that took the newer of the two would let a
    // certificate minted after the revoke undo it — and un-revoking is
    // pairing again under a fresh key, not re-issuing under the dead one.
    const view = await read([
      revocation(DEVICE, 1_754_700_000),
      deviceCert(DEVICE, 'phone', 'attic-pi', 1_759_999_999),
    ])
    expect(view.revoked).toBe(true)
  })

  it('whichever order the answer happens to list them in', async () => {
    // Storage hands entries back sorted by digest, so the revocation may come
    // first or last and nothing may depend on which.
    const rev = revocation(DEVICE, 1_754_700_000)
    const cert = deviceCert(DEVICE, 'phone', 'attic-pi', 1_759_999_999)
    expect((await read([cert, rev])).revoked).toBe(true)
    expect((await read([rev, cert])).revoked).toBe(true)
  })

  it('and does not touch another device', async () => {
    const view = await read([revocation(OTHER_DEVICE), deviceCert(DEVICE)])
    expect(view.revoked).toBe(false)
  })

  it('unless the revocation was signed by another key', async () => {
    // A revocation only subtracts authority, which is why daemons honour one
    // from an untrusted channel — but it still has to be *the fleet's*. A
    // stranger able to revoke devices would be a denial of service anybody
    // with write access to the directory could mount.
    const view = await read([revocation(DEVICE, 1_754_700_000, OTHER_SEED), deviceCert(DEVICE)])
    expect(view.revoked).toBe(false)
  })
})

describe('what the reader will not take from the relay on faith', () => {
  it('reads at most 512 entries, whatever the relay claims to hold', async () => {
    // The Worker refuses to store a 513th (507, rather than evicting), so a
    // longer answer is not a bigger fleet — it is a relay that has stopped
    // speaking this protocol. The rest go unread rather than unverified.
    const blobs = [machineCert('attic-pi', 'Attic Pi', ATTIC_NOISE)]
    for (let i = 0; i < 600; i++) blobs.push(deviceCert(OTHER_DEVICE, `d${i}`))
    blobs.push(machineCert('mesa-1a2b', 'Mesa', MESA_NOISE))

    const view = await read(blobs)
    expect(view.entries).toBe(602)
    expect(view.verified).toBe(512)
    expect(view.machines.map((m) => m.id)).toEqual(['attic-pi'])
  })

  it('refuses a blob over the 4 KiB ceiling before verifying it', async () => {
    const huge = new Uint8Array(4097).fill(1)
    const view = await read([huge, machineCert('attic-pi', 'Attic Pi', ATTIC_NOISE)])
    expect(view.verified).toBe(1)
    expect(view.machines).toHaveLength(1)
  })

  it('refuses an empty blob and one that is not base64', async () => {
    const body = JSON.stringify({
      v: 1,
      entries: [{ key: '', blob: '' }, { key: '', blob: '!!!!' }, { key: '', blob: 42 }],
    })
    const view = await readDirectory({
      origin: ORIGIN,
      fleetPub: FLEET_PUB,
      devicePub: DEVICE,
      fetch: directoryFetch([], { body }),
    })
    expect(view.verified).toBe(0)
    expect(view.machines).toEqual([])
  })
})

describe('a directory that cannot be read costs visibility and nothing else', () => {
  const empty = { machines: [], revoked: false, entries: 0, verified: 0 }

  it('answers empty for a relay that has not been updated (503)', async () => {
    // `/directory` on a relay deployed before the FleetDirectory object
    // exists. The fix is `flue relay update`; until then this browser sees
    // the machines it paired with and no others.
    const view = await readDirectory({
      origin: ORIGIN,
      fleetPub: FLEET_PUB,
      devicePub: DEVICE,
      fetch: directoryFetch([], { ok: false, status: 503 }),
    })
    expect(view).toEqual(empty)
  })

  it('answers empty for a body that is not a directory', async () => {
    for (const body of ['<!doctype html>', '{}', '{"entries":"nope"}', 'null']) {
      const view = await readDirectory({
        origin: ORIGIN,
        fleetPub: FLEET_PUB,
        devicePub: DEVICE,
        fetch: directoryFetch([], { body }),
      })
      expect(view).toEqual(empty)
    }
  })

  it('answers empty when the fetch itself throws', async () => {
    const view = await readDirectory({
      origin: ORIGIN,
      fleetPub: FLEET_PUB,
      devicePub: DEVICE,
      fetch: () => Promise.reject(new Error('offline')),
    })
    expect(view).toEqual(empty)
  })

  it('refuses a document past the size ceiling without parsing it', async () => {
    const view = await readDirectory({
      origin: ORIGIN,
      fleetPub: FLEET_PUB,
      devicePub: DEVICE,
      fetch: directoryFetch([], { body: `{"v":1,"entries":[${' '.repeat(5 << 20)}]}` }),
    })
    expect(view).toEqual(empty)
  })

  it('shows what a relay serving half the set left out, and nothing worse', async () => {
    // A hostile or lagging relay can serve this stale, cut short or empty —
    // it could always refuse to route. The cost is machines this browser does
    // not see; what it cannot do is add one.
    const whole = [
      machineCert('attic-pi', 'Attic Pi', ATTIC_NOISE),
      machineCert('mesa-1a2b', 'Mesa', MESA_NOISE),
      revocation(OTHER_DEVICE),
    ]
    const full = await read(whole)
    expect(full.machines.map((m) => m.id)).toEqual(['attic-pi', 'mesa-1a2b'])
    expect(full.verified).toBe(3)

    const half = await read(whole.slice(0, 1))
    expect(half.machines.map((m) => m.id)).toEqual(['attic-pi'])
    // Fewer machines this browser can open, never a machine it should not —
    // and the withheld revocation is the exception the spec now names, since
    // omitting one is the one direction that *adds* rather than subtracts
    // (spec/relay-protocol.md, "What withholding costs").
    expect(half.verified).toBe(1)
  })

  it('answers empty for a fleet key that is not 32 bytes', async () => {
    const view = await readDirectory({
      origin: ORIGIN,
      fleetPub: FLEET_PUB.subarray(0, 31),
      devicePub: DEVICE,
      fetch: directoryFetch([machineCert('attic-pi', 'Attic Pi', ATTIC_NOISE)]),
    })
    expect(view.machines).toEqual([])
    expect(view.verified).toBe(0)
  })
})

describe('the entry key the relay files a blob under', () => {
  it('is not what decides anything', async () => {
    // Content addressing is the relay's filing system. What decides whether
    // an entry means something is the signature over its bytes, so a key that
    // is wrong, absent or a lie changes nothing.
    const blob = machineCert('attic-pi', 'Attic Pi', ATTIC_NOISE)
    const body = JSON.stringify({
      v: 1,
      entries: [{ key: 'not-a-digest', blob: base64(blob) }],
    })
    const view = await readDirectory({
      origin: ORIGIN,
      fleetPub: FLEET_PUB,
      devicePub: DEVICE,
      fetch: directoryFetch([], { body }),
    })
    expect(view.machines).toHaveLength(1)
  })
})
