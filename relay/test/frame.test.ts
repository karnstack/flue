import { describe, expect, it } from 'vitest'
import fixture from '../../testdata/relay/frames.json'
import { decodeFrame, encodeFrame } from '../src/frame'

const fromB64 = (s: string): Uint8Array => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))

describe('channel framing against the shared fixture', () => {
  for (const c of fixture.channelFrames) {
    it(`encodes ${c.name} byte-exactly`, () => {
      const got = encodeFrame(c.channel, fromB64(c.payloadB64))
      expect(new Uint8Array(got)).toEqual(fromB64(c.encodedB64))
    })

    it(`decodes ${c.name} back to (channel, payload)`, () => {
      const encoded = fromB64(c.encodedB64)
      const buf = new ArrayBuffer(encoded.byteLength)
      new Uint8Array(buf).set(encoded)
      const got = decodeFrame(buf)
      expect(got.channel).toBe(c.channel)
      expect(new Uint8Array(got.payload)).toEqual(fromB64(c.payloadB64))
    })
  }
})

describe('frame errors the fixture does not carry', () => {
  // spec/relay-protocol.md: a frame that is exactly a header is well formed;
  // a frame shorter than four bytes is a protocol error.
  it('rejects every frame shorter than the 4-byte header', () => {
    for (const len of [0, 1, 2, 3]) {
      expect(() => decodeFrame(new ArrayBuffer(len))).toThrow()
    }
  })

  it('rejects a channel that is not an unsigned 32-bit integer', () => {
    for (const channel of [-1, 4294967296, 1.5, NaN]) {
      expect(() => encodeFrame(channel, new Uint8Array(0))).toThrow(RangeError)
    }
  })
})
