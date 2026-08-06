// The channel framing on the daemon↔relay socket:
//
//   [4-byte big-endian channel][payload]
//
// Byte-for-byte the same layout as internal/relaywire, pinned by
// testdata/relay/frames.json. A frame that is exactly a header is well formed
// and carries an empty payload; a frame shorter than four bytes is a protocol
// error (spec/relay-protocol.md).

/** The width of the channel header. */
const HEADER_LEN = 4

/** Lays out [4-byte big-endian channel][payload] in a fresh buffer. */
export function encodeFrame(channel: number, payload: Uint8Array): ArrayBuffer {
  if (!Number.isInteger(channel) || channel < 0 || channel > 0xffff_ffff) {
    throw new RangeError(`relay frame: channel ${channel} is not an unsigned 32-bit integer`)
  }
  const buf = new ArrayBuffer(HEADER_LEN + payload.byteLength)
  // DataView rather than shifts: setUint32 writes big-endian unsigned, so
  // channel 4294967295 comes out as ff ff ff ff instead of going negative.
  new DataView(buf).setUint32(0, channel, false)
  new Uint8Array(buf, HEADER_LEN).set(payload)
  return buf
}

/**
 * Splits a framed message into its channel and payload. The payload is a view
 * over `buf`, not a copy — the hub forwards it straight on, and a caller that
 * outlives the buffer must copy.
 */
export function decodeFrame(buf: ArrayBuffer): { channel: number; payload: Uint8Array } {
  if (buf.byteLength < HEADER_LEN) {
    throw new RangeError(`relay frame: ${buf.byteLength} bytes is shorter than the channel header`)
  }
  return {
    channel: new DataView(buf).getUint32(0, false),
    payload: new Uint8Array(buf, HEADER_LEN),
  }
}
