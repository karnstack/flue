import { describe, expect, it } from 'vitest'
import fixture from '../../../testdata/relay/frames.json'
import { decodePlain, encodePlain } from './frame'

const fromB64 = (s: string): Uint8Array => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))

describe('kind-byte framing against the shared fixture', () => {
  for (const c of fixture.plainFrames) {
    it(`encodes ${c.name} byte-exactly`, () => {
      expect(encodePlain(c.text, fromB64(c.dataB64))).toEqual(fromB64(c.encodedB64))
    })

    it(`decodes ${c.name} back to (text, data)`, () => {
      const got = decodePlain(fromB64(c.encodedB64))
      expect(got.text).toBe(c.text)
      expect(new Uint8Array(got.data)).toEqual(fromB64(c.dataB64))
    })
  }
})

describe('frame errors the fixture cannot carry', () => {
  // The fixture is a table of valid frames, so the two protocol errors in
  // spec/relay-protocol.md ("an empty payload, or any kind byte other than
  // 0x00 or 0x01, is a protocol error") are pinned in Go only — they are
  // asserted here so the web side cannot quietly guess instead.
  it('rejects an empty payload, which has no kind byte', () => {
    expect(() => decodePlain(new Uint8Array(0))).toThrow()
  })

  it('rejects every kind byte above 0x01', () => {
    for (const kind of [2, 3, 0x7f, 0xff]) {
      expect(() => decodePlain(new Uint8Array([kind, 1, 2, 3]))).toThrow()
    }
  })
})

describe('what the returned buffers are', () => {
  it('encodes into a fresh buffer, so the caller may keep mutating its data', () => {
    const data = new Uint8Array([1, 2, 3])
    const encoded = encodePlain(false, data)
    data[0] = 9
    expect(encoded).toEqual(new Uint8Array([1, 1, 2, 3]))
  })

  it('decodes to a view of the payload, without the kind byte', () => {
    const got = decodePlain(new Uint8Array([0, 7, 8]))
    expect(got.data.byteLength).toBe(2)
    expect(Array.from(got.data)).toEqual([7, 8])
  })
})
