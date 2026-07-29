import {
  CAPS,
  decodeBinary,
  encodeBinary,
  FRAME_INPUT,
  FRAME_OUTPUT,
  PROTOCOL_VERSION,
  type Attached,
  type ClientMessage,
  type ErrorMsg,
  type ServerMessage,
  type SessionInfo,
  type SizeChanged,
} from './protocol'

/** The subset of WebSocket the client needs, so tests can substitute one. */
export interface SocketLike {
  send(data: string | ArrayBuffer): void
  close(): void
  onopen: (() => void) | null
  onclose: (() => void) | null
  onmessage: ((data: string | ArrayBuffer) => void) | null
}

export type ConnStatus = 'connecting' | 'open' | 'reconnecting' | 'closed'

/** The daemon's WebSocket endpoint on the origin serving this page. */
export function daemonSocketUrl(
  loc: { protocol: string; host: string } = location,
): string {
  return `${loc.protocol === 'https:' ? 'wss:' : 'ws:'}//${loc.host}/ws`
}

/** One live attachment, keyed by the ref the daemon assigned it. */
interface Attachment {
  id: string
  /** The offset of the next byte this client expects on this ref. */
  lastSeq: number
}

const BACKOFF_BASE_MS = 250
const BACKOFF_MAX_MS = 10_000

/**
 * The most input carried in one frame.
 *
 * The daemon caps a single client frame at 1 MiB (`readLimit` in
 * internal/daemon/conn.go) and closes the connection on anything larger, so a
 * paste is split well under it rather than costing the whole socket.
 */
const MAX_INPUT_BYTES = 1 << 19

/** Round and clamp a terminal dimension into the daemon's uint16 fields. */
function dimension(n: number): number {
  if (!Number.isFinite(n)) return 1
  return Math.min(0xffff, Math.max(1, Math.round(n)))
}

type Listener<T extends unknown[]> = (...args: T) => void

/**
 * A set of listeners. Registration appends and returns an unsubscribe — never
 * a single slot that a second registration would silently overwrite, which is
 * invisible at the call site.
 */
class Emitter<T extends unknown[]> {
  private listeners: Array<Listener<T>> = []

  add(cb: Listener<T>): () => void {
    this.listeners.push(cb)
    let live = true
    return () => {
      if (!live) return
      live = false
      // By identity and once: two registrations of the same function are two
      // subscriptions, and each unsubscribe must retire only its own.
      const at = this.listeners.indexOf(cb)
      if (at >= 0) this.listeners.splice(at, 1)
    }
  }

  emit(...args: T) {
    // Copy first: a listener may unsubscribe itself while we iterate.
    for (const cb of [...this.listeners]) cb(...args)
  }
}

/**
 * FlueClient owns the socket, the reconnect loop, and per-attachment byte
 * offsets. It knows nothing about React or the DOM.
 *
 * Recovery model, which is the part worth understanding before changing
 * anything here: the daemon tears a connection down without a close frame
 * whenever it shuts down, a write fails, or a client stops draining its
 * socket, so an abnormal close is the *ordinary* shape of the daemon going
 * away rather than an exceptional one. Every close therefore takes the same
 * path — back off, reconnect, and reattach each wanted session from the byte
 * offset already consumed. There is no separate signal to react to and none
 * is wanted: `error{code:"lagged"}` is largely unreachable now that a
 * backlogged client loses its whole connection, so it is surfaced as an
 * ordinary error and nothing else.
 *
 * One limit worth knowing before building on this. **The reattach plan holds
 * one entry per session, so one session survives a reconnect as one
 * attachment.** Attaching the same session twice gives two refs while the
 * connection lasts, but the next reconnect sends one `attach` and the daemon
 * answers with one ref; the second view would sit on a dead ref with no error
 * to tell it so. The interface could not support better anyway — `attached`
 * carries a ref and a session ID and nothing that says *which* of two views
 * asked — so the fix is a plan keyed per attachment and a handle returned from
 * `attach`, not a wider map here. Until then: one view per session per tab.
 */
export class FlueClient {
  private sock: SocketLike | null = null
  /** Whether `sock` has opened. Sending before that throws in a browser. */
  private ready = false
  private attempt = 0
  private stopped = true
  private retry: ReturnType<typeof setTimeout> | null = null
  private state: ConnStatus = 'closed'

  private attachments = new Map<number, Attachment>()

  /**
   * Sessions to reattach after a reconnect, keyed by session ID and holding
   * the offset to resume from. Refs are per-connection and do not survive, so
   * the plan is keyed by the one identifier that does.
   */
  private wanted = new Map<string, number>()

  /**
   * Which session each ref named, kept past the connection the ref came from
   * so that `detach` still works during an outage. See `detach`.
   */
  private refOwner = new Map<number, string>()

  /** A `list` asked for while the socket was down. See `list`. */
  private listOwed = false

  private outputListeners = new Emitter<[number, Uint8Array]>()
  private attachedListeners = new Emitter<[Attached]>()
  private exitListeners = new Emitter<[number, number]>()
  private sizeListeners = new Emitter<[SizeChanged]>()
  private sessionsListeners = new Emitter<[SessionInfo[]]>()
  private errorListeners = new Emitter<[ErrorMsg]>()
  private statusListeners = new Emitter<[ConnStatus]>()

  constructor(
    private url: string,
    private factory: (url: string) => SocketLike = defaultFactory,
  ) {}

  // Every registration appends and returns an unsubscribe. Callers in React
  // effects must call it on cleanup.
  onOutput(cb: (ref: number, bytes: Uint8Array) => void) {
    return this.outputListeners.add(cb)
  }
  onAttached(cb: (a: Attached) => void) {
    return this.attachedListeners.add(cb)
  }
  onExit(cb: (ref: number, code: number) => void) {
    return this.exitListeners.add(cb)
  }
  onSizeChanged(cb: (m: SizeChanged) => void) {
    return this.sizeListeners.add(cb)
  }
  onSessions(cb: (s: SessionInfo[]) => void) {
    return this.sessionsListeners.add(cb)
  }
  onError(cb: (e: ErrorMsg) => void) {
    return this.errorListeners.add(cb)
  }
  onStatus(cb: (s: ConnStatus) => void) {
    return this.statusListeners.add(cb)
  }

  /**
   * The current connection state.
   *
   * `onStatus` only reports changes, so anything mounting mid-connection would
   * otherwise have no way to learn where things stand until the next one.
   */
  get status(): ConnStatus {
    return this.state
  }

  /** The offset of the next byte expected on `ref`, if it is still attached. */
  lastSeqFor(ref: number): number | undefined {
    return this.attachments.get(ref)?.lastSeq
  }

  /** Start connecting, and keep reconnecting until `close`. */
  connect() {
    this.stopped = false
    if (this.sock || this.retry !== null) return
    this.openSocket()
  }

  /**
   * Stop, for good.
   *
   * The pending retry is cancelled too. Without that, a close issued during
   * the backoff wait would be undone by a timer that had already been armed —
   * and a React effect cleanup lands in exactly that window.
   *
   * The reattach plan is kept: a tab that closes and reopens the same client,
   * which is what StrictMode's double-mount does, should come back where it
   * left off.
   */
  close() {
    this.stopped = true
    this.clearRetry()
    this.attempt = 0
    this.listOwed = false
    this.teardown()
    this.setStatus('closed')
  }

  /**
   * Ask for the session list.
   *
   * The one request held while the socket is down, because it is idempotent
   * and because a `list()` in a mount effect that silently did nothing would
   * leave the sessions screen permanently empty. One is held, not a queue: two
   * answers to the same question are one answer.
   */
  list() {
    if (!this.send({ type: 'list' })) this.listOwed = true
  }

  /**
   * Ask for a new session.
   *
   * Dropped rather than held when the socket is down: unlike `list` this
   * starts a process, and one queued behind a ten-second backoff would appear
   * minutes later at a screen nobody was looking at. Check `status` and
   * disable the control instead.
   */
  spawn(opts: { cwd?: string; cmd?: string[]; cols: number; rows: number }) {
    const { cols, rows, ...rest } = opts
    this.send({ type: 'spawn', ...rest, cols: dimension(cols), rows: dimension(rows) })
  }

  /**
   * Attach to a session and keep it attached across reconnects.
   *
   * Recorded before it is sent, so a socket that is not ready yet — or that
   * drops before `attached` comes back — still replays this on open.
   *
   * One entry per session: attaching the same session twice gives two refs on
   * the live connection but one plan entry, so only one survives a reconnect.
   * See the class doc.
   */
  attach(id: string, lastSeq = 0) {
    this.wanted.set(id, lastSeq)
    this.send({ type: 'attach', id, lastSeq })
  }

  /**
   * Let go of an attachment.
   *
   * Works whether or not the socket is up, which is the point: a view that
   * unmounts during an outage has only the ref it was given, and if that did
   * not retire the session then the next reconnect would attach something
   * nobody is watching — for the life of the tab, since no later call could
   * name it. Hence `refOwner`, which outlives the connection the ref came
   * from. The `detach` frame itself is only worth sending on a live socket;
   * a dropped connection already retired every ref on the daemon's side.
   */
  detach(ref: number) {
    const id = this.refOwner.get(ref)
    this.refOwner.delete(ref)
    const live = this.attachments.delete(ref)
    if (id !== undefined) this.wanted.delete(id)
    if (live) this.send({ type: 'detach', ref })
  }

  /**
   * Stop trying to reattach a session, without naming a ref.
   *
   * The escape hatch for a view that never got one — an `attach` answered with
   * `error{code:"not_found"}` leaves nothing to `detach`, and the error itself
   * carries no id to match it to. Without this the plan would ask for that
   * session on every reconnect, forever.
   */
  forget(id: string) {
    this.wanted.delete(id)
  }

  sendInput(ref: number, bytes: Uint8Array) {
    // Never held. Keystrokes typed at a screen that has stopped responding
    // were meant for the state the shell was in then; replaying them into a
    // reconnected shell seconds later runs something nobody asked for.
    if (!this.ready || !this.sock || !this.attachments.has(ref)) return
    // Split against the daemon's per-frame read limit. Over it, coder/websocket
    // drops the connection, and the uniform recovery path would show that as an
    // ordinary blink and reattach — a large paste vanishing with no diagnosis.
    for (let at = 0; at < bytes.length || at === 0; at += MAX_INPUT_BYTES) {
      this.sock.send(encodeBinary(FRAME_INPUT, ref, bytes.subarray(at, at + MAX_INPUT_BYTES)))
    }
  }

  resize(ref: number, cols: number, rows: number, primary: boolean) {
    // Rounded and clamped, because these come from a layout measurement and
    // the daemon's fields are uint16: a fractional width fails json.Unmarshal
    // on the Go side, which answers bad_message and drops the whole resize.
    this.sendForRef(ref, {
      type: 'resize',
      ref,
      cols: dimension(cols),
      rows: dimension(rows),
      primary,
    })
  }

  signal(ref: number, sig: string) {
    this.sendForRef(ref, { type: 'signal', ref, sig })
  }

  /** Ask the daemon to end the session behind `ref`. */
  closeSession(ref: number) {
    this.sendForRef(ref, { type: 'close', ref })
  }

  // -------------------------------------------------------------------------

  private openSocket() {
    this.setStatus(this.attempt === 0 ? 'connecting' : 'reconnecting')

    const sock = this.factory(this.url)
    this.sock = sock
    this.ready = false

    // Every handler ignores a socket this client has already moved on from. A
    // replaced socket still reports its own close, and without this guard that
    // report would schedule a second reconnect against a live connection.
    sock.onopen = () => {
      if (this.sock !== sock) return
      this.ready = true
      this.attempt = 0
      this.setStatus('open')

      this.send({ type: 'hello', ver: PROTOCOL_VERSION, caps: [...CAPS] })
      for (const [id, lastSeq] of this.wanted) {
        this.send({ type: 'attach', id, lastSeq })
      }
      if (this.listOwed) {
        this.listOwed = false
        this.send({ type: 'list' })
      }
    }

    sock.onclose = () => {
      if (this.sock !== sock) return
      this.teardown()
      if (this.stopped) {
        this.setStatus('closed')
        return
      }
      this.setStatus('reconnecting')
      this.scheduleRetry()
    }

    sock.onmessage = (data) => {
      if (this.sock !== sock) return
      this.receive(data)
    }
  }

  private receive(data: string | ArrayBuffer) {
    if (typeof data === 'string') {
      let msg: ServerMessage
      try {
        msg = JSON.parse(data) as ServerMessage
      } catch (err) {
        this.reportLocal(`control message: ${describe(err)}`)
        return
      }
      this.handleControl(msg)
      return
    }

    let frame
    try {
      frame = decodeBinary(data)
    } catch (err) {
      this.reportLocal(`data frame: ${describe(err)}`)
      return
    }
    if (frame.type !== FRAME_OUTPUT) return

    // Offsets are only tracked for refs this client knows, but the bytes are
    // handed on regardless: dropping output that arrived a moment after a
    // detach would be a terminal that silently swallowed part of its own
    // scrollback, which is worse than an event with nowhere to go.
    const a = this.attachments.get(frame.ref)
    if (a) a.lastSeq += frame.payload.length
    this.outputListeners.emit(frame.ref, frame.payload)
  }

  private handleControl(msg: ServerMessage) {
    switch (msg.type) {
      case 'attached': {
        // seq is the offset of the first byte about to arrive, so it is the
        // right starting point whether this is a delta or a post-eviction
        // snapshot. `truncated` is passed through untouched; deciding to clear
        // an emulator belongs to whatever owns one.
        this.attachments.set(msg.ref, { id: msg.id, lastSeq: msg.seq })
        // Retire any ref this session was reached by on a connection that is
        // gone. The daemon numbers refs from 1 again each time, so the usual
        // case is this same key; a session that lands on a different number
        // would otherwise leave the old one behind on every reconnect.
        for (const [ref, id] of this.refOwner) {
          if (id === msg.id && !this.attachments.has(ref)) this.refOwner.delete(ref)
        }
        this.refOwner.set(msg.ref, msg.id)
        // Seeds the plan for a session created by spawn, which was never
        // attached to explicitly and so appears nowhere else.
        this.wanted.set(msg.id, msg.seq)
        this.attachedListeners.emit(msg)
        break
      }

      case 'sessions':
        this.sessionsListeners.emit(msg.sessions)
        break

      case 'exit': {
        const a = this.attachments.get(msg.ref)
        if (!a) break
        this.attachments.delete(msg.ref)
        this.refOwner.delete(msg.ref)
        // The daemon retires the ref alongside this, and the session is over,
        // so it leaves the reattach plan too.
        this.wanted.delete(a.id)
        this.exitListeners.emit(msg.ref, msg.code)
        break
      }

      case 'sizeChanged':
        // The daemon registers a ref before it enqueues that ref's `attached`,
        // so another connection broadcasting new dimensions can overtake it.
        // Known and accepted daemon-side, and an unknown ref is dropped rather
        // than raised. Note the `attached` behind it is not a guaranteed
        // repair: `attachTo` reads `s.Info()` before enqueuing, so it can
        // carry pre-resize dimensions and the view then holds stale ones until
        // the next real change.
        if (!this.attachments.has(msg.ref)) break
        this.sizeListeners.emit(msg)
        break

      case 'error':
        this.errorListeners.emit(msg)
        break

      case 'welcome':
        break

      // Anything newer is ignored rather than raised, so a daemon may add a
      // message type without breaking an older tab.
    }
  }

  private send(msg: ClientMessage): boolean {
    if (!this.ready || !this.sock) return false
    this.sock.send(JSON.stringify(msg))
    return true
  }

  /**
   * Send, but only while `ref` still names a live attachment.
   *
   * Refs belong to one connection and the daemon numbers them from 1 again on
   * the next, skipping the ones whose attach failed. So a ref held by a view
   * that has not yet noticed the reconnect does not merely miss — it can name
   * a different session, and `resize` or `sendInput` would then reach a shell
   * the user is not looking at.
   */
  private sendForRef(ref: number, msg: ClientMessage): boolean {
    if (!this.attachments.has(ref)) return false
    return this.send(msg)
  }

  /**
   * Drop the socket and fold each attachment's progress into the plan.
   *
   * Progress is only folded into sessions the plan already lists, never added
   * back. `wanted` is what this client intends to hold; a session it let go of,
   * or one the daemon reported as exited, must not be resurrected here by an
   * attachment that had not been swept up yet.
   */
  private teardown() {
    const sock = this.sock
    this.sock = null
    this.ready = false
    for (const a of this.attachments.values()) {
      const planned = this.wanted.get(a.id)
      if (planned === undefined) continue
      this.wanted.set(a.id, Math.max(planned, a.lastSeq))
    }
    // refOwner is deliberately left alone: it is what lets a view that unmounts
    // during the outage still name the session its ref stood for.
    this.attachments.clear()
    sock?.close()
  }

  private scheduleRetry() {
    const ceiling = Math.min(BACKOFF_BASE_MS * 2 ** this.attempt, BACKOFF_MAX_MS)
    // Capped, so a long outage cannot overflow the exponent into Infinity and
    // so the count stays meaningful if it is ever reported.
    if (this.attempt < 30) this.attempt++
    // Equal jitter — half the delay fixed, half random — so a daemon restart
    // does not bring every open tab back in the same millisecond, while still
    // leaving a floor under the retry rate.
    const delay = ceiling * (0.5 + Math.random() * 0.5)
    this.retry = setTimeout(() => {
      this.retry = null
      if (this.stopped) return
      this.openSocket()
    }, delay)
  }

  private clearRetry() {
    if (this.retry === null) return
    clearTimeout(this.retry)
    this.retry = null
  }

  private setStatus(s: ConnStatus) {
    if (this.state === s) return
    this.state = s
    this.statusListeners.emit(s)
  }

  /** Report a fault this client hit locally, keeping it out of the socket. */
  private reportLocal(msg: string) {
    this.errorListeners.emit({ type: 'error', code: 'bad_payload', msg })
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function defaultFactory(url: string): SocketLike {
  const ws = new WebSocket(url)
  ws.binaryType = 'arraybuffer'
  const wrapper: SocketLike = {
    send: (d) => ws.send(d),
    close: () => ws.close(),
    onopen: null,
    onclose: null,
    onmessage: null,
  }
  ws.onopen = () => wrapper.onopen?.()
  // A WebSocket error is always followed by a close, and the daemon's own
  // teardown produces a close with no frame at all, so there is nothing an
  // error handler could usefully do that the close path does not already.
  ws.onclose = () => wrapper.onclose?.()
  ws.onmessage = (e: MessageEvent<string | ArrayBuffer>) => wrapper.onmessage?.(e.data)
  return wrapper
}
