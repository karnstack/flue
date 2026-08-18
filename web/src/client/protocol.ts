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
export const FRAME_FILE = 0x02 // daemon -> client, one chunk of a file being read

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
  if (type !== FRAME_OUTPUT && type !== FRAME_INPUT && type !== FRAME_FILE) {
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
  /**
   * The id of the anchor session this one is grouped under — a split pane on
   * a desktop, a tab on a phone. Absent for every session that stands alone,
   * which is every session from before the field. Metadata only: the daemon
   * records it and nothing else, so folding a group is this side's decision.
   */
  group?: string
  /**
   * A scratch terminal: hidden by this client's lists, reaped fast once
   * exited, and closed by the daemon when its `group` parent ends. Dismissing
   * its UI detaches — the shell keeps running until then. Absent means false.
   */
  ephemeral?: boolean
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
  /**
   * The machine that ran the ceremony this device came from, read by the daemon
   * off the row's signed fleet certificate.
   *
   * It is what lets a Devices screen tell its two kinds of row apart. A machine
   * on a fleet lists everything it admitted, and it admits two ways: devices it
   * paired itself, and devices it took on the fleet's word when they arrived
   * over the relay holding a certificate. Those read identically without this,
   * and they are not the same thing to revoke — cutting off the second
   * publishes a revocation every machine in the fleet honours, for good.
   *
   * Absent when nothing signed says: no certificate, or one that does not
   * verify under the fleet key the daemon holds now. Read that as this
   * machine's own, which is the direction that does not offer a fleet-wide
   * revoke on the strength of a blob that proved nothing.
   */
  pairedOn?: string
  /**
   * Where the device first reached the daemon from — the Origin header on its
   * enrolment POST, e.g. "http://localhost:7719" — recorded on the daemon's
   * local row and never minted into the certificate.
   *
   * It exists because several loopback tabs enrol as several devices, one per
   * browser origin (IndexedDB scopes the device key to the origin), and their
   * rows are otherwise identical. A hint, not an identity: absent is the
   * ordinary state of a device paired by ceremony, admitted on a fleet cert,
   * or enrolled before origins were recorded, and a screen must render absent
   * as unremarkable rather than suspicious.
   */
  origin?: string
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
  /**
   * Group the new session under an anchor session — a split, or a tab in the
   * anchor's group. Only sent to a daemon whose welcome caps include
   * `multiplex`; an older daemon would ignore it and spawn an orphan.
   */
  group?: string
  /** Mark a scratch terminal. Same caps gate as `group`. */
  ephemeral?: boolean
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

/**
 * End a session, addressed one of two ways.
 *
 * `ref` is the original spelling: an attachment handle, for a view that is
 * looking at the session it closes. `id` is the attach-free spelling the
 * sessions list uses — it acts on rows it never attached to, and attaching
 * just to earn a ref would cost a subscribe, a backlog replay and a detach to
 * deliver one verb. A message carries one address or the other; the daemon
 * lets a non-zero ref win when both appear, so ref semantics never move.
 *
 * No reply on success. The session's end announces itself: attached views get
 * `exit`, and the list sees state `exited` on its next poll. An unknown id is
 * answered with `error{not_found}` exactly as `update` answers one; a ref the
 * connection does not hold with `error{bad_ref}`.
 */
export interface CloseMsg {
  type: 'close'
  ref?: number
  id?: string
}

/**
 * Edit the metadata a human owns on a session — its name, its tags, whether it
 * is pinned. Nothing the program inside the session says can reach these
 * fields, and nothing here touches what that program says.
 *
 * Partial by construction: a field this message does not carry is a field the
 * edit leaves alone. Two views on one session is the ordinary case, so a
 * message that had to restate everything would undo whatever the other view
 * changed in between. Which makes the empty values load-bearing rather than
 * skippable — `tags: []` clears the tags and `name: ''` clears the name, where
 * omitting either says only that this edit was not about it.
 *
 * Mirrors `wire.Update`. Answered by a fresh `sessions` to the connection that
 * asked, or by `error` with code `not_found`. Only that connection: nothing
 * broadcasts the edit, so a second browser sees it on its next list rather than
 * the instant it lands.
 */
export interface UpdateMsg {
  type: 'update'
  id: string
  name?: string
  tags?: string[]
  pinned?: boolean
  /**
   * One edit only: `false` keeps a scratch terminal, promoting it to an
   * ordinary member of its group. Absent leaves the flag alone, like every
   * other field here.
   */
  ephemeral?: boolean
}

/**
 * Ask for the tail of a session's scrollback without attaching to it.
 *
 * A look, not an attachment: no ref is minted, no stream starts, and the
 * session's `lastActive` is left alone — reading a preview is not activity
 * inside the session, and moving the stamp would reshuffle the very list the
 * preview is drawn for.
 *
 * `bytes` caps the answer; absent means the daemon's default, and anything
 * over its ceiling is clamped rather than refused. Answered by `preview`
 * echoing `reqId`, or by `error{not_found}` for an id the daemon has reaped.
 */
export interface PeekMsg {
  type: 'peek'
  id: string
  bytes?: number
  reqId?: number
}

/**
 * Ask whether paths exist, resolved against a session's working directory.
 *
 * Plural because of who asks: a hovered terminal line carries several
 * candidates, and a message per candidate would be a round trip per candidate.
 * Answered by `stats`, whose entries echo these paths in this order.
 */
export interface StatMsg {
  type: 'stat'
  id: string
  paths: string[]
  reqId?: number
}

/**
 * Start reading one file, resolved the way `stat` resolves a path.
 *
 * Answered by `file`, which mints the ref the content arrives under, or by an
 * error. The content itself is binary frames, not this reply.
 */
export interface ReadMsg {
  type: 'read'
  id: string
  path: string
  reqId?: number
}

/** Abandon a read in flight. Addressed by the ref `file` handed out. */
export interface CancelMsg {
  type: 'cancel'
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

/**
 * Which agent CLI wrote a transcript — the three stores the daemon indexes.
 * A name rather than a path, because paths never cross this wire: the daemon
 * resolves each tool's own directory layout and hands back ids.
 */
export type AgentTool = 'claude' | 'codex' | 'pi'

/**
 * Ask for the daemon's index of agent transcripts. Answered by `agentIndex`
 * echoing `reqId`, which is required rather than optional here: this request
 * answers a promise with exactly one asker, so a copy with no reqId would be
 * an answer with no one to give it to. The two filters narrow rather than
 * page — the index is summaries only, small enough to send whole.
 */
export interface AgentsMsg {
  type: 'agents'
  /** Only these tools' transcripts. Absent means all of them. */
  tools?: AgentTool[]
  /** Only sessions recorded under this working directory. Absent means all. */
  cwd?: string
  reqId: number
}

/**
 * Read one window of a transcript, addressed by tool and id the way the index
 * reported them. Answered by `agentPage` echoing `reqId`, or by
 * `error{not_found}` for a file that has vanished since the index saw it.
 *
 * `offset` is a byte offset into the transcript file, not a message count —
 * it is what `agentPage.next` and `agentPage.start` hand back, so paging is
 * offset-in, offset-out and never drifts when the file grows. An offset that
 * lands mid-line is aligned to the next newline by the daemon rather than
 * refused, which is what makes `fileSize` a valid place to start reading
 * backward from.
 */
export interface AgentReadMsg {
  type: 'agentRead'
  tool: AgentTool
  id: string
  offset: number
  /**
   * Which way to parse from `offset`. Absent means forward. Backward reads
   * the window that *ends* at `offset` — the "load earlier" gesture, and,
   * aimed at `fileSize`, the jump straight to a transcript's end.
   */
  dir?: 'forward' | 'backward'
  /** The most messages wanted back. Absent means the daemon's default. */
  limit?: number
  reqId: number
}

/**
 * Search every indexed transcript for a substring, case-insensitively.
 * Answered by `agentHits` echoing `reqId`. The filters are `agents`'s two,
 * for the same narrowing; `limit` caps the hits, absent meaning the daemon's
 * default, and the daemon bounds its own scan besides — see `agentHits`.
 */
export interface AgentSearchMsg {
  type: 'agentSearch'
  query: string
  tools?: AgentTool[]
  cwd?: string
  limit?: number
  reqId: number
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
  | UpdateMsg
  | PeekMsg
  | StatMsg
  | ReadMsg
  | CancelMsg
  | DevicesMsg
  | RevokeMsg
  | PairStartMsg
  | PairCancelMsg
  | AgentsMsg
  | AgentReadMsg
  | AgentSearchMsg

// Server -> client.

/**
 * The state of the daemon's relay leg.
 *
 * `connecting` means the daemon is dialling and nothing is reachable through
 * it yet; `connected` carries the https origin the relay serves browsers on,
 * which is the address a pairing URL names while the relay is up.
 *
 * `off` arrives on a `relay` push and never on a welcome, where a daemon with
 * no relay omits the field entirely. A consumer must treat an absent `relay`
 * and `status: 'off'` the same way rather than assuming one of the spellings —
 * which is also what makes the push able to say a relay went away.
 *
 * It arrives twice over: on the welcome, because a client has to decide what to
 * render the moment it is greeted, and on every `relay` message after that, so
 * a tab open across a `flue relay setup` — or a `leave`, or a socket lost and
 * regained — is not left holding the greeting forever.
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
  /**
   * This daemon is on a relay and cannot sign for its fleet: no fleet key in
   * its relay.json, one it cannot parse, or no machine id for a certificate
   * to name.
   *
   * A device paired while it is true pins no fleet key and is minted no
   * certificate, so it reaches that one machine for the life of the pairing —
   * both records are written once, by the ceremony, and nothing repairs them.
   * Devices refuses to draw a QR in that state (routes/devices.tsx).
   *
   * Absent means the daemon said nothing about it, which is what a build from
   * before this field says, so absent is never read as a refusal.
   */
  noFleetKey?: boolean
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
  /**
   * This device's own fleet certificate, base64 — the blob it presents to
   * machines it has never paired with (spec/fleet-trust.md, rule 2).
   *
   * It rides every welcome rather than being fetched, and that is the whole of
   * how a browser gets one after the ceremony that minted it: the socket is
   * inside Noise and the far end has already proved it holds the key the
   * certificate names, so this is the private, authenticated channel the public
   * `GET /directory` used to stand in for. Absent on a loopback connection
   * (no device identity), on a daemon with no fleet key, and for a device
   * paired before that key existed.
   */
  fleetCert?: string
  /**
   * The fleet's Ed25519 public key, base64 — what every certificate in the
   * fleet verifies under. Absent from a daemon that holds none.
   *
   * The QR is still where a browser learns this key for the first time. This
   * is the second delivery, and it exists for the browser the first one never
   * reached: one that paired while its machine could not sign pinned nothing,
   * and could reach nothing but that machine until somebody ran the ceremony
   * again. Kept only from a session this browser opened against a daemon key
   * it pinned itself — see fleet/fleet.ts, adoptFleetKey, which is where that
   * condition lives and why it is not trust-on-first-use.
   */
  fleetPub?: string
}

/**
 * The relay leg's state, pushed because it changed under a connection that was
 * already open.
 *
 * It carries the whole of `RelayInfo` rather than the field that moved, so a
 * client applies it wholesale and cannot end up holding half of one state and
 * half of another. That is exactly the bug it was written for: the screens used
 * to poll `/api/relay/info`, which answers for the transport alone, so a tab
 * that watched a relay come up learned the status and the origin and never the
 * machine id — and handed out pairing links that named no machine, which is a
 * link /pair can only refuse.
 *
 * The daemon sends one whenever this state stops matching what it last sent, so
 * a transport redialling in a loop is not a message per attempt.
 */
export interface RelayState {
  type: 'relay'
  relay: RelayInfo
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

/**
 * Answers `peek` with raw terminal output — escape sequences and all, exactly
 * as the daemon's ring holds them.
 *
 * Raw rather than rendered, because rendering is this side's job and it
 * already owns an emulator. `data` is base64 (as encoding/json carries every
 * Go `[]byte`) and is the *tail*, so it will usually begin mid-escape-sequence:
 * a consumer must expect to discard a partial sequence at the front rather
 * than read it as content.
 */
export interface Preview {
  type: 'preview'
  id: string
  /** Base64. Empty string, never absent, for a session with no output yet. */
  data: string
  /** The dimensions the bytes were drawn at. */
  cols: number
  rows: number
  reqId?: number
}

/** What one path turned out to be. `path` echoes what was asked, not what it resolved to. */
export interface PathEntry {
  path: string
  exists: boolean
  kind?: 'file' | 'dir' | 'other'
  size?: number
  mtime?: number
}

/** Answers `stat`, one entry per path asked about, in order. */
export interface StatsMsg {
  type: 'stats'
  entries: PathEntry[]
  reqId?: number
}

/**
 * Answers `read`: the stream is open and these are its terms.
 *
 * `path` is the resolved path, unlike `PathEntry.path`. `size` is the file's
 * real size, which is not always how much arrives — see `truncated`.
 */
export interface FileMsg {
  type: 'file'
  ref: number
  path: string
  size: number
  mime: string
  kind: 'text' | 'image'
  truncated?: boolean
  reqId?: number
}

/** Every byte of a read has been sent. The only way a stream ends rather than stalls. */
export interface EofMsg {
  type: 'eof'
  ref: number
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

/**
 * Token counts summed over one transcript, in the four buckets every tool's
 * accounting reduces to. Whole rather than optional field by field: a tool
 * that reports no usage sums to zeros, so no consumer guards a bucket.
 */
export interface AgentTokenUsage {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

/**
 * One transcript as the daemon's index summarises it — everything a list row
 * needs without opening the file. Derived entirely from what the tool wrote
 * to disk; nothing here was ever this daemon's own session.
 */
export interface AgentSummary {
  /** The tool's own id for the session — a filename or a recorded field. */
  id: string
  tool: AgentTool
  /** The directory the agent was working in, which is how sessions group. */
  cwd: string
  /**
   * The best name the transcript offers — a title the user or the tool set.
   * Absent when it offers none; `firstPrompt` is the fallback a row shows.
   */
  title?: string
  /** The first thing the user asked, when a transcript records one. */
  firstPrompt?: string
  /** RFC 3339, the first and last message timestamps. */
  startedAt: string
  endedAt: string
  messageCount: number
  toolCallCount: number
  /** Every model the session touched. Empty, never absent. */
  models: string[]
  tokens: AgentTokenUsage
  /** Absent unless the transcript records cost itself — Pi's do. */
  costUsd?: number
  /** Bytes on disk — what `agentRead` offsets are measured against. */
  fileSize: number
  /**
   * The command that picks this conversation back up in its own tool, and
   * the directory to run it in. Absent when the cwd is unknown, because a
   * resume launched from the wrong directory is worse than none.
   */
  resume?: { cmd: string[]; cwd: string }
}

/**
 * One message of a transcript, normalised across the three tools' formats.
 * `text` carries whatever the kind implies: prose, thinking, a tool call's
 * input JSON, or a tool result's body.
 */
export interface AgentMessage {
  role: 'user' | 'assistant' | 'system'
  kind: 'text' | 'thinking' | 'tool_call' | 'tool_result'
  /** RFC 3339. Absent when the source line carries no timestamp. */
  ts?: string
  /** Absent except on assistant messages whose line names one. */
  model?: string
  text: string
  /** Set for a tool_call, and for a tool_result when the source says. */
  toolName?: string
  /** A subagent's line rather than the main conversation's. Absent is false. */
  sidechain?: boolean
  /** `text` was cut at the daemon's per-block cap. Absent is false. */
  truncated?: boolean
  /**
   * The byte offset of the source line — the stable anchor: a paging key for
   * `agentRead`, a stable list key for a renderer, and where a search hit
   * jumps to.
   */
  offset: number
}

/**
 * One search match. `offset` addresses the matched message exactly as
 * `AgentMessage.offset` does, so a hit is also the `agentRead` that shows it
 * in context.
 */
export interface AgentHit {
  tool: AgentTool
  id: string
  cwd: string
  /** The summary's title, when it has one, so a hit can name its session. */
  title?: string
  /** The matched message's timestamp, when it has one. */
  ts?: string
  role: 'user' | 'assistant' | 'system'
  /** The match with ~80 chars of context each side, one line, no markup. */
  snippet: string
  offset: number
}

/**
 * Answers `agents` with the index as it stands right now. `building` true
 * means a sweep is still in flight and the snapshot may be short — the answer
 * arrives immediately either way, and a caller that wants the rest asks
 * again rather than waiting on a fuller one.
 */
export interface AgentIndexMsg {
  type: 'agentIndex'
  building: boolean
  /** Empty rather than absent when nothing is indexed. */
  sessions: AgentSummary[]
  reqId: number
}

/**
 * Answers `agentRead` with one window of messages. `start` is the offset of
 * the first returned message's line and `next` the offset after the last
 * consumed one, so the two directions page with the same two numbers. `eof`
 * means the parse reached the end of the file *at parse time* — not that the
 * transcript is complete, since a live agent is still appending; the same
 * doctrine as reading files.
 */
export interface AgentPageMsg {
  type: 'agentPage'
  tool: AgentTool
  id: string
  /** Empty rather than absent for a window with nothing in it. */
  messages: AgentMessage[]
  start: number
  next: number
  eof: boolean
  /** The file's size at parse time — where a jump-to-end reads back from. */
  fileSize: number
  reqId: number
}

/**
 * Answers `agentSearch`. `truncated` true means the daemon's own cap on the
 * scan was hit and there may be more; `building` means the index sweep was
 * incomplete when the scan ran, exactly as on `agentIndex`, so a caller may
 * ask again for a fuller answer.
 */
export interface AgentHitsMsg {
  type: 'agentHits'
  building: boolean
  truncated: boolean
  /** Empty rather than absent when nothing matched. */
  hits: AgentHit[]
  reqId: number
}

export type ServerMessage =
  | Welcome
  | RelayState
  | Sessions
  | Attached
  | Exit
  | SizeChanged
  | ErrorMsg
  | Preview
  | StatsMsg
  | FileMsg
  | EofMsg
  | DeviceList
  | Pairing
  | Revoked
  | AgentIndexMsg
  | AgentPageMsg
  | AgentHitsMsg
