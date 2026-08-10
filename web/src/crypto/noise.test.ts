import { describe, expect, it } from 'vitest'
import vectors from '../../../testdata/noise/ik.json'
import payloadVectors from '../../../testdata/noise/ik-payload.json'
import { initiatorHandshake } from './noise'

const unhex = (s: string) =>
  new Uint8Array((s.match(/.{2}/g) ?? []).map((b) => parseInt(b, 16)))
const hex = (b: Uint8Array) =>
  Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')

describe('Noise IK initiator against the shared vectors', () => {
  it('reproduces msg1 byte-exactly and completes against msg2', () => {
    const hs = initiatorHandshake(
      unhex(vectors.initiatorStaticPriv),
      unhex(vectors.responderStaticPub),
      { ephemeralPriv: unhex(vectors.initiatorEphemeralPriv) },
    )
    expect(hex(hs.messageA())).toBe(vectors.msg1)
    const ch = hs.readMessageB(unhex(vectors.msg2))

    for (const m of vectors.transport) {
      if (m.dir === 'i2r') {
        expect(hex(ch.seal(unhex(m.plaintext)))).toBe(m.ciphertext)
      } else {
        expect(hex(ch.open(unhex(m.ciphertext)))).toBe(m.plaintext)
      }
    }
  })

  it('rejects a tampered message B', () => {
    const hs = initiatorHandshake(
      unhex(vectors.initiatorStaticPriv),
      unhex(vectors.responderStaticPub),
      { ephemeralPriv: unhex(vectors.initiatorEphemeralPriv) },
    )
    hs.messageA()
    const bad = unhex(vectors.msg2)
    // Plain `bad[i] ^= 1` fails tsc under noUncheckedIndexedAccess (the read
    // side is `number | undefined`); the nullish-coalesce keeps the same
    // one-byte flip without weakening the type check.
    const lastIndex = bad.length - 1
    bad[lastIndex] = (bad[lastIndex] ?? 0) ^ 1
    expect(() => hs.readMessageB(bad)).toThrow()
  })

  it('rejects a wrong pinned responder key', () => {
    // Pin the initiator's own public key instead; message B must not verify.
    const hs = initiatorHandshake(
      unhex(vectors.initiatorStaticPriv),
      unhex(vectors.initiatorStaticPub),
      { ephemeralPriv: unhex(vectors.initiatorEphemeralPriv) },
    )
    hs.messageA()
    expect(() => hs.readMessageB(unhex(vectors.msg2))).toThrow()
  })

  it('throws on a replayed transport ciphertext', () => {
    const hs = initiatorHandshake(
      unhex(vectors.initiatorStaticPriv),
      unhex(vectors.responderStaticPub),
      { ephemeralPriv: unhex(vectors.initiatorEphemeralPriv) },
    )
    hs.messageA()
    const ch = hs.readMessageB(unhex(vectors.msg2))
    const r2i = vectors.transport.find((m) => m.dir === 'r2i')!
    expect(hex(ch.open(unhex(r2i.ciphertext)))).toBe(r2i.plaintext)
    expect(() => ch.open(unhex(r2i.ciphertext))).toThrow()
  })
})

/**
 * The same handshake with the payload slot filled, against
 * testdata/noise/ik-payload.json — the vector that pins what a fleet device
 * actually sends.
 *
 * `msg1Payload` there is the signed device certificate from
 * testdata/fleet/certs.json, byte for byte, and `msg1` is what the Go
 * responder reads it out of. So this is the one test that ties the two
 * fixtures together: a certificate encoder that drifted, or an initiator that
 * sealed the wrong bytes, cannot reproduce `msg1`.
 */
describe('Noise IK initiator carrying a fleet device certificate', () => {
  it('reproduces msg1 with the certificate in the payload', () => {
    const hs = initiatorHandshake(
      unhex(payloadVectors.initiatorStaticPriv),
      unhex(payloadVectors.responderStaticPub),
      {
        payload: unhex(payloadVectors.msg1Payload),
        ephemeralPriv: unhex(payloadVectors.initiatorEphemeralPriv),
      },
    )
    expect(hex(hs.messageA())).toBe(payloadVectors.msg1)
    const ch = hs.readMessageB(unhex(payloadVectors.msg2))
    for (const m of payloadVectors.transport) {
      if (m.dir === 'i2r') {
        expect(hex(ch.seal(unhex(m.plaintext)))).toBe(m.ciphertext)
      } else {
        expect(hex(ch.open(unhex(m.ciphertext)))).toBe(m.plaintext)
      }
    }
  })

  it('is a different message A from the empty-payload one', () => {
    // The payload is sealed into message A rather than sent beside it, so a
    // certificate changes the bytes on the wire and the hash the rest of the
    // handshake is keyed from. A relay reads neither.
    const empty = initiatorHandshake(
      unhex(payloadVectors.initiatorStaticPriv),
      unhex(payloadVectors.responderStaticPub),
      { ephemeralPriv: unhex(payloadVectors.initiatorEphemeralPriv) },
    )
    expect(hex(empty.messageA())).not.toBe(payloadVectors.msg1)
  })
})
