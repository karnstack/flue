/**
 * The flue wire protocol, client side.
 *
 * Text frames carry JSON control messages, binary frames carry data, and
 * there is no framing layer beyond that. Everything here mirrors
 * `spec/protocol.md` and `internal/wire`; the shared golden fixture in
 * `testdata/wire/control.json` is decoded by both suites so the two cannot
 * drift.
 */

/** The protocol version this client announces in `hello`. */
export const PROTOCOL_VERSION = '0.1.0'

/** Capabilities this client announces in `hello`. */
export const CAPS: readonly string[] = ['binary']

/** Binary frame types. Layout is [1 byte type][4 bytes ref BE][payload]. */
export const FRAME_OUTPUT = 0x00 // daemon -> client
export const FRAME_INPUT = 0x01 // client -> daemon

const HEADER_LEN = 5
const MAX_REF = 0xffffffff

export interface BinaryFrame {
  type: number
  ref: number
  payload: Uint8Array
}

/**
 * Build a binary data frame.
 *
 * `ref` is validated rather than masked: `DataView.setUint32` truncates
 * silently, so an out-of-range ref would reach the daemon as some other
 * client's attachment.
 */
export function encodeBinary(type: number, ref: number, payload: Uint8Array): ArrayBuffer {
  if (!Number.isInteger(ref) || ref < 0 || ref > MAX_REF) {
    throw new Error(`flue: ref ${ref} is outside uint32`)
  }
  const out = new Uint8Array(HEADER_LEN + payload.length)
  out[0] = type
  new DataView(out.buffer).setUint32(1, ref, false) // big-endian, as in Go
  out.set(payload, HEADER_LEN)
  return out.buffer
}

/**
 * Parse a binary data frame.
 *
 * The payload is a view over `buf`, not a copy, matching `wire.DecodeBinary`.
 * That is safe because every WebSocket message owns its own ArrayBuffer, so
 * nothing else will write over the bytes an emulator has yet to parse.
 */
export function decodeBinary(buf: ArrayBuffer): BinaryFrame {
  if (buf.byteLength < HEADER_LEN) throw new Error('flue: frame shorter than header')
  const view = new DataView(buf)
  const type = view.getUint8(0)
  if (type !== FRAME_OUTPUT && type !== FRAME_INPUT) {
    throw new Error(`flue: unknown frame type 0x${type.toString(16)}`)
  }
  return {
    type,
    ref: view.getUint32(1, false),
    payload: new Uint8Array(buf, HEADER_LEN),
  }
}

// ---------------------------------------------------------------------------
// Control messages
// ---------------------------------------------------------------------------

/** A session's lifecycle state, as `session.Info.State` reports it. */
export type SessionState = 'running' | 'exited'

/** One record of `session.Info`. All nine fields, in the daemon's spelling. */
export interface SessionInfo {
  id: string
  title: string
  cwd: string
  cmd: string[]
  state: SessionState
  exitCode: number
  cols: number
  rows: number
  /** RFC 3339, as Go marshals a time.Time. */
  lastActive: string
}

// Client -> server.

export interface HelloMsg {
  type: 'hello'
  ver: string
  caps?: string[]
}

export interface ListMsg {
  type: 'list'
}

export interface SpawnMsg {
  type: 'spawn'
  cwd?: string
  cmd?: string[]
  cols: number
  rows: number
}

export interface AttachMsg {
  type: 'attach'
  id: string
  /**
   * The byte offset to resume from — the offset of the first byte the client
   * wants, not of the last one it has.
   */
  lastSeq: number
}

export interface DetachMsg {
  type: 'detach'
  ref: number
}

export interface ResizeMsg {
  type: 'resize'
  ref: number
  cols: number
  rows: number
  /** Whether this client is claiming ownership of the PTY's dimensions. */
  primary: boolean
}

export interface SignalMsg {
  type: 'signal'
  ref: number
  /** A name the daemon's table knows: SIGINT, INT, SIGTERM, TERM, and so on. */
  sig: string
}

export interface CloseMsg {
  type: 'close'
  ref: number
}

export type ClientMessage =
  | HelloMsg
  | ListMsg
  | SpawnMsg
  | AttachMsg
  | DetachMsg
  | ResizeMsg
  | SignalMsg
  | CloseMsg

// Server -> client.

export interface Welcome {
  type: 'welcome'
  daemonId: string
  host: string
  ver: string
  /** `omitempty` on the daemon side, so genuinely absent rather than empty. */
  caps?: string[]
}

export interface Sessions {
  type: 'sessions'
  sessions: SessionInfo[]
}

export interface Attached {
  type: 'attached'
  ref: number
  id: string
  cols: number
  rows: number
  title: string
  /**
   * The offset of the first byte about to arrive on this ref — for a delta
   * and for a post-eviction snapshot alike.
   */
  seq: number
  /**
   * True when `seq` is later than what was asked for, because the scrollback
   * had already dropped it. What follows is a fresh snapshot rather than a
   * continuation, so the consumer must clear its emulator before writing it.
   */
  truncated: boolean
  primary: boolean
}

export interface Exit {
  type: 'exit'
  ref: number
  code: number
}

export interface SizeChanged {
  type: 'sizeChanged'
  ref: number
  cols: number
  rows: number
  primary: boolean
}

export interface ErrorMsg {
  type: 'error'
  code: string
  msg: string
}

export type ServerMessage = Welcome | Sessions | Attached | Exit | SizeChanged | ErrorMsg
