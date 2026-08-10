import { ed25519 } from '@noble/curves/ed25519.js'
import { describe, expect, it } from 'vitest'

import fixture from '../../../testdata/fleet/certs.json'
import { FLEET_SEED } from '@/testing/fleet'
import { encodeCert, keyHex, verifyCert, type Cert } from './cert'

const unhex = (s: string) => new Uint8Array((s.match(/.{2}/g) ?? []).map((b) => parseInt(b, 16)))

const FLEET_PUB = unhex(fixture.publicKeyHex)

/** The fixture's `cert` object in this module's shape. */
function certOf(c: (typeof fixture.cases)[number]['cert']): Cert {
  switch (c.kind) {
    case 'machine':
      return {
        kind: 'machine',
        id: c.id!,
        name: c.name!,
        noise: unhex(c.noiseHex!),
        iat: c.iat,
      }
    case 'device':
      return {
        kind: 'device',
        device: unhex(c.deviceHex!),
        name: c.name!,
        pairedOn: c.pairedOn!,
        iat: c.iat,
      }
    default:
      return { kind: 'revoke', device: unhex(c.deviceHex!), iat: c.iat }
  }
}

/**
 * The cross-language contract. testdata/fleet/certs.json is generated from
 * internal/fleet (`go test ./internal/fleet/ -update`) and this suite is the
 * other party to it: the same fields must encode to the same canonical bytes,
 * and the same signed blob must verify under the same key. A failure here is
 * not a broken test — it is a browser that would refuse the certificates its
 * own daemons mint, or admit ones they would not.
 */
describe('the fleet certificate encoding against the shared fixture', () => {
  for (const c of fixture.cases) {
    it(`encodes ${c.name} to the canonical bytes Go signs`, () => {
      expect(keyHex(encodeCert(certOf(c.cert)))).toBe(c.canonicalHex)
    })

    it(`verifies ${c.name} under the fleet public key`, () => {
      const cert = verifyCert(FLEET_PUB, unhex(c.signedHex))
      expect(cert).not.toBeNull()
      expect(cert!.kind).toBe(c.cert.kind)
      expect(cert!.iat).toBe(c.cert.iat)
    })

    it(`refuses ${c.name} under another key`, () => {
      // One flipped bit in the verifying key, which is the whole of what
      // "signed by the fleet" means. Everything else about the blob is intact.
      const other = new Uint8Array(FLEET_PUB)
      other[0] = other[0]! ^ 1
      expect(verifyCert(other, unhex(c.signedHex))).toBeNull()
    })

    it(`refuses ${c.name} with a byte cut off the end`, () => {
      const blob = unhex(c.signedHex)
      expect(verifyCert(FLEET_PUB, blob.subarray(0, blob.length - 1))).toBeNull()
    })

    it(`refuses ${c.name} with a byte appended`, () => {
      // The canonical part is self-delimiting, so anything after the 64-byte
      // signature is a signed statement somebody has added to — and the
      // signature covers none of the addition.
      const blob = unhex(c.signedHex)
      const longer = new Uint8Array(blob.length + 1)
      longer.set(blob)
      expect(verifyCert(FLEET_PUB, longer)).toBeNull()
    })

    it(`refuses ${c.name} with one field byte flipped`, () => {
      const blob = unhex(c.signedHex)
      // Byte 20 is inside the fields for every kind: past the 16-byte prefix,
      // the version and the kind byte.
      blob[20] = blob[20]! ^ 1
      expect(verifyCert(FLEET_PUB, blob)).toBeNull()
    })
  }

  it('reads every field of the machine certificate', () => {
    const c = fixture.cases.find((x) => x.name === 'machine')!
    const cert = verifyCert(FLEET_PUB, unhex(c.signedHex))
    expect(cert).toMatchObject({
      kind: 'machine',
      id: c.cert.id,
      name: c.cert.name,
      iat: c.cert.iat,
    })
    expect(keyHex((cert as { noise: Uint8Array }).noise)).toBe(c.cert.noiseHex)
  })

  it('reads every field of the device certificate', () => {
    const c = fixture.cases.find((x) => x.name === 'device')!
    const cert = verifyCert(FLEET_PUB, unhex(c.signedHex))
    expect(cert).toMatchObject({
      kind: 'device',
      name: c.cert.name,
      pairedOn: c.cert.pairedOn,
      iat: c.cert.iat,
    })
    expect(keyHex((cert as { device: Uint8Array }).device)).toBe(c.cert.deviceHex)
  })

  it('round-trips a name with astral characters in it', () => {
    // The unicode case is in the fixture because a length prefix counting
    // UTF-16 units instead of UTF-8 bytes passes every ASCII case there is.
    const c = fixture.cases.find((x) => x.name === 'device-unicode-name')!
    const cert = verifyCert(FLEET_PUB, unhex(c.signedHex))
    expect((cert as { name: string }).name).toBe(c.cert.name)
    expect(keyHex(encodeCert(certOf(c.cert)))).toBe(c.canonicalHex)
  })
})

describe('what the fleet certificate reader refuses', () => {
  const signed = unhex(fixture.cases[0]!.signedHex)

  it('an empty blob', () => {
    expect(verifyCert(FLEET_PUB, new Uint8Array(0))).toBeNull()
  })

  it('a blob that does not open with the domain separator', () => {
    const blob = new Uint8Array(signed)
    blob[0] = blob[0]! ^ 1
    expect(verifyCert(FLEET_PUB, blob)).toBeNull()
  })

  it('a version this reader does not speak', () => {
    const blob = new Uint8Array(signed)
    blob[16] = 2
    expect(verifyCert(FLEET_PUB, blob)).toBeNull()
  })

  it('a kind byte with no meaning', () => {
    const blob = new Uint8Array(signed)
    blob[17] = 9
    expect(verifyCert(FLEET_PUB, blob)).toBeNull()
  })

  it('a fleet key that is not 32 bytes', () => {
    expect(verifyCert(FLEET_PUB.subarray(0, 31), signed)).toBeNull()
  })

  it('a string field whose length reaches past the blob', () => {
    // The machine cert opens with str(id). A length of 0xFFFF is inside the
    // encoder's own ceiling only if the ceiling is not applied; either way it
    // reaches past the bytes that carried it.
    const blob = new Uint8Array(signed)
    blob[18] = 0xff
    blob[19] = 0xff
    expect(verifyCert(FLEET_PUB, blob)).toBeNull()
  })
})

describe('the encoder refuses what it cannot faithfully sign', () => {
  const key = new Uint8Array(32).fill(7)

  it('a key that is not 32 bytes', () => {
    expect(() => encodeCert({ kind: 'revoke', device: key.subarray(0, 31), iat: 1 })).toThrow()
  })

  it('a negative timestamp', () => {
    expect(() => encodeCert({ kind: 'revoke', device: key, iat: -1 })).toThrow()
  })

  it('a string over the shared ceiling', () => {
    expect(() =>
      encodeCert({ kind: 'machine', id: 'a'.repeat(513), name: '', noise: key, iat: 1 }),
    ).toThrow()
  })

  it('a name carrying an unpaired surrogate', () => {
    // TextEncoder would write U+FFFD for it — different bytes than the caller
    // named, under a signature that would then cover them.
    expect(() =>
      encodeCert({ kind: 'machine', id: 'm', name: '\uD800', noise: key, iat: 1 }),
    ).toThrow()
  })

  it('a timestamp past 2^53, which Go would sign and a number cannot carry', () => {
    // The one place the two encoders deliberately disagree. Go's appendIAT
    // takes anything up to 2^62; a JavaScript number stops being exact at
    // 2^53, so a value above it has already been rounded by the time it
    // arrives here and signing it would cover bytes nobody named. Refusing is
    // the safe direction, and it costs nothing: the browser signs nothing, and
    // 2^53 seconds is nine million years out.
    expect(() =>
      encodeCert({ kind: 'revoke', device: key, iat: Number.MAX_SAFE_INTEGER + 2 }),
    ).toThrow(/2\^53/)
    // The boundary itself still encodes.
    expect(() =>
      encodeCert({ kind: 'revoke', device: key, iat: Number.MAX_SAFE_INTEGER }),
    ).not.toThrow()
  })
})

describe('the reader and Go agree about iat exactly', () => {
  // The asymmetry above is in the *encoders* only. The decoders share one
  // ceiling — 2^62, Go's maxIAT — and they have to: a reader that refused what
  // a daemon accepts would drop real certificates off the directory, and one
  // that accepted more would hand a caller a value Go's own Verify rejects.
  //
  // Signed properly, because this is about what a reader *accepts*, and a blob
  // that fails the signature would answer null for the wrong reason. The
  // canonical bytes are built with a placeholder iat and the field overwritten
  // before signing, which is the only way to reach values this module's own
  // encoder refuses to write.
  const key = new Uint8Array(32).fill(7)

  function signedWithIAT(raw: bigint): Uint8Array {
    const canonical = encodeCert({ kind: 'revoke', device: key, iat: 1 })
    new DataView(canonical.buffer, canonical.byteOffset, canonical.length).setBigUint64(
      canonical.length - 8,
      raw,
    )
    const sig = ed25519.sign(canonical, FLEET_SEED)
    const blob = new Uint8Array(canonical.length + sig.length)
    blob.set(canonical)
    blob.set(sig, canonical.length)
    return blob
  }

  it('accepts an iat far above 2^53, which the encoder here would not write', () => {
    const cert = verifyCert(FLEET_PUB, signedWithIAT(1n << 60n))
    expect(cert?.kind).toBe('revoke')
    // Read back as a Number, which is lossy above 2^53 and documented to be:
    // iat is display, never precedence — a revocation outranks a device
    // certificate whatever either one says.
    expect(cert?.iat).toBe(Number(1n << 60n))
  })

  it('accepts exactly 2^62 and refuses one more, as Go does', () => {
    expect(verifyCert(FLEET_PUB, signedWithIAT(1n << 62n))?.kind).toBe('revoke')
    expect(verifyCert(FLEET_PUB, signedWithIAT((1n << 62n) + 1n))).toBeNull()
  })
})
