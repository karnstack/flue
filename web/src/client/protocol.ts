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

/** One record of `session.Info`. All thirteen fields, in the daemon's spelling. */
export interface SessionInfo {
  id: string
  /** What the program running inside says it is, scraped from OSC 0/2. */
  title: string
  /** What a human called it. Empty until someone does; it outranks `title`. */
  name: string
  /** Trimmed, deduped and sorted by the daemon. Empty, never absent. */
  tags: string[]
  pinned: boolean
  cwd: string
  cmd: string[]
  state: SessionState
  exitCode: number
  cols: number
  rows: number
  /** RFC 3339. The one timestamp output cannot move, so it sorts stably. */
  createdAt: string
  /** RFC 3339, as Go marshals a time.Time. */
  lastActive: string
}

/**
 * One paired device, as `deviceList` reports it.
 *
 * Both timestamps are unix **seconds**, not milliseconds — `wire.DeviceInfo`
 * flattens the registry's `time.Time` on the way out, so a consumer building a
 * `Date` must multiply by 1000.
 */
export interface DeviceInfo {
  id: string
  label: string
  pairedAt: number
  lastSeen: number
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
  /**
   * Correlates a request with the `attached` or `error` that answers it.
   * Client-chosen and echoed by the daemon; absent when no correlation was
   * asked for. Mirrors `reqId,omitempty` on the Go side.
   */
  reqId?: number
}

export interface AttachMsg {
  type: 'attach'
  id: string
  /**
   * The byte offset to resume from — the offset of the first byte the client
   * wants, not of the last one it has.
   */
  lastSeq: number
  /**
   * Correlates a request with the `attached` or `error` that answers it.
   * Client-chosen and echoed by the daemon; absent when no correlation was
   * asked for. Mirrors `reqId,omitempty` on the Go side.
   */
  reqId?: number
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

/** Ask for the paired-device list. Answered by `deviceList`. */
export interface DevicesMsg {
  type: 'devices'
}

/**
 * Remove a paired device. The requester gets a fresh `deviceList`; the revoked
 * device's own connections get `revoked` and are then closed.
 */
export interface RevokeMsg {
  type: 'revoke'
  deviceId: string
}

/** Enter pairing mode. Answered by `pairing`. */
export interface PairStartMsg {
  type: 'pairStart'
}

/** Leave pairing mode, invalidating any outstanding token. */
export interface PairCancelMsg {
  type: 'pairCancel'
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
  | DevicesMsg
  | RevokeMsg
  | PairStartMsg
  | PairCancelMsg

// Server -> client.

/**
 * The state of the daemon's relay leg, as of the moment this connection was
 * accepted.
 *
 * `connecting` means the daemon is dialling and nothing is reachable through
 * it yet; `connected` carries the https origin the relay serves browsers on,
 * which is the address a pairing URL names while the relay is up.
 *
 * `off` is in the union because it is the third state the daemon models, but
 * it never arrives: a daemon with no relay omits `welcome.relay` entirely. A
 * consumer must therefore treat an absent `relay` and `status: 'off'` the same
 * way rather than assuming one of the two spellings.
 *
 * It is not a stream. Nothing pushes an update when the relay reconnects, so
 * what a client holds is what was true when it arrived — which is also when it
 * decides what to render.
 */
export interface RelayInfo {
  status: 'off' | 'connecting' | 'connected'
  /** Absent unless `status` is `connected`. */
  origin?: string
  /**
   * The slot this daemon holds on the relay — the `<id>` of the
   * `/client/<id>` URL a browser opens to reach this machine. From the
   * daemon's relay.json rather than the socket, so it is present whenever a
   * relay is configured, `connecting` and `connected` alike.
   */
  machineId?: string
  /**
   * The machine's human label, free text from the same file. For lists and
   * titles, never for URLs — that is what `machineId` is for.
   */
  machineName?: string
}

export interface Welcome {
  type: 'welcome'
  daemonId: string
  host: string
  ver: string
  /** `omitempty` on the daemon side, so genuinely absent rather than empty. */
  caps?: string[]
  /** Absent when this daemon is not configured for a relay. See RelayInfo. */
  relay?: RelayInfo
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
  /**
   * The offset one past the replayed backlog. Bytes below `head` are
   * history; bytes at or after it are live. `head === seq` means the
   * backlog is empty and there is nothing to mute.
   */
  head: number
  primary: boolean
  /**
   * Correlates a request with the `attached` or `error` that answers it.
   * Client-chosen and echoed by the daemon; absent when no correlation was
   * asked for. Mirrors `reqId,omitempty` on the Go side.
   */
  reqId?: number
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
  /**
   * Correlates a request with the `attached` or `error` that answers it.
   * Client-chosen and echoed by the daemon; absent when no correlation was
   * asked for. Mirrors `reqId,omitempty` on the Go side.
   */
  reqId?: number
}

export interface DeviceList {
  type: 'deviceList'
  /** Empty rather than absent when nothing is paired. */
  devices: DeviceInfo[]
}

/** Answers `pairStart` with everything the second device needs to pair. */
export interface Pairing {
  type: 'pairing'
  /** Single-use, and good for two minutes. */
  token: string
  /**
   * Absolute: the `/pair` page on this origin, carrying the token in `?t=` and
   * the daemon's static public key in `?k=` (URL-safe base64, unpadded). This
   * is what the QR encodes, and `?k=` is what the second device pins — the code
   * is drawn on a screen the user controls, which no intermediary can reach.
   */
  url: string
  /**
   * The daemon's static public key, standard base64. The same key `url` carries
   * in `?k=`, for the browser that is already paired; the device being paired
   * takes its copy from the URL rather than from here or from `POST /api/pair`.
   */
  daemonPub: string
  /** Unix **seconds**, matching the Go side. */
  expiresAt: number
}

/**
 * This device was revoked. Arrives just before the daemon closes the
 * connection, so the tab can say why rather than showing a bare disconnect.
 */
export interface Revoked {
  type: 'revoked'
  reason: string
}

export type ServerMessage =
  | Welcome
  | Sessions
  | Attached
  | Exit
  | SizeChanged
  | ErrorMsg
  | DeviceList
  | Pairing
  | Revoked
