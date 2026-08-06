/*
 * The kind byte that survives the trip through Noise:
 *
 *   [1 byte kind][wire protocol bytes]
 *
 * Byte-for-byte the layout of `internal/relaywire`'s EncodePlain/DecodePlain,
 * pinned by testdata/relay/frames.json.
 *
 * The wire protocol distinguishes text frames (JSON control) from binary ones
 * (terminal data), a distinction the WebSocket gives us on the daemon's own
 * origin and encryption erases: through the relay every message is one binary
 * WebSocket frame of ciphertext. This byte carries it, so the layer above the
 * relay — FlueClient, which knows nothing about any of this — reads the same
 * `(text, data)` pair it reads locally.
 */

const KIND_TEXT = 0x00
const KIND_BINARY = 0x01

/** Prefixes the kind byte, in a fresh buffer: the caller may keep mutating
 *  the data it passed. */
export function encodePlain(text: boolean, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(1 + data.byteLength)
  out[0] = text ? KIND_TEXT : KIND_BINARY
  out.set(data, 1)
  return out
}

/**
 * Splits a decrypted payload into its kind and its bytes. The data is a view
 * over `buf`, not a copy — the caller hands it straight on — so anything that
 * outlives the decrypted buffer must copy it.
 *
 * An empty payload, or a kind byte other than 0x00 or 0x01, throws: the peer
 * is not speaking this protocol (spec/relay-protocol.md, inside a decrypted
 * payload), and guessing would hand FlueClient a frame of the wrong sort.
 */
export function decodePlain(buf: Uint8Array): { text: boolean; data: Uint8Array } {
  if (buf.byteLength === 0) {
    throw new RangeError('relay frame: a plain payload has no kind byte')
  }
  const kind = buf[0]
  if (kind !== KIND_TEXT && kind !== KIND_BINARY) {
    throw new RangeError(`relay frame: unknown kind byte 0x${(kind ?? 0).toString(16)}`)
  }
  return { text: kind === KIND_TEXT, data: buf.subarray(1) }
}
