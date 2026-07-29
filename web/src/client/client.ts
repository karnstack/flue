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
 * How many session-free requests are held while the socket is down. A daemon
 * that never comes back must not turn a retrying screen into a leak.
 */
const PENDING_LIMIT = 64

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

  /** Session-free requests issued before the socket was ready to carry them. */
  private pending: ClientMessage[] = []

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
    this.teardown()
    this.setStatus('closed')
  }

  list() {
    this.request({ type: 'list' })
  }

  spawn(opts: { cwd?: string; cmd?: string[]; cols: number; rows: number }) {
    this.request({ type: 'spawn', ...opts })
  }

  /**
   * Attach to a session and keep it attached across reconnects.
   *
   * Recorded before it is sent, so a socket that is not ready yet — or that
   * drops before `attached` comes back — still replays this on open.
   */
  attach(id: string, lastSeq = 0) {
    this.wanted.set(id, lastSeq)
    this.send({ type: 'attach', id, lastSeq })
  }

  detach(ref: number) {
    const a = this.attachments.get(ref)
    if (a) {
      this.attachments.delete(ref)
      this.forgetIfLastRef(a.id)
    }
    this.send({ type: 'detach', ref })
  }

  sendInput(ref: number, bytes: Uint8Array) {
    // Never queued. Keystrokes typed at a screen that has stopped responding
    // are meant for the state the shell was in then; replaying them into a
    // reconnected shell seconds later runs something nobody asked for.
    if (!this.ready || !this.sock) return
    this.sock.send(encodeBinary(FRAME_INPUT, ref, bytes))
  }

  resize(ref: number, cols: number, rows: number, primary: boolean) {
    this.send({ type: 'resize', ref, cols, rows, primary })
  }

  signal(ref: number, sig: string) {
    this.send({ type: 'signal', ref, sig })
  }

  /** Ask the daemon to end the session behind `ref`. */
  closeSession(ref: number) {
    this.send({ type: 'close', ref })
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
      const held = this.pending
      this.pending = []
      for (const msg of held) this.send(msg)
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
        // The daemon retires the ref alongside this, and the session is over,
        // so it is dropped from the reattach plan too.
        this.forgetIfLastRef(a.id)
        this.exitListeners.emit(msg.ref, msg.code)
        break
      }

      case 'sizeChanged':
        // The daemon registers a ref before it enqueues that ref's `attached`,
        // so another connection broadcasting new dimensions can overtake it.
        // Known and accepted daemon-side; the `attached` that follows carries
        // the current dimensions anyway, so an unknown ref is dropped rather
        // than raised.
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

  /**
   * Send now, or drop.
   *
   * Ref-bearing messages are never held: a ref belongs to one connection, so
   * replaying `resize{ref:1}` after a reconnect would aim it at whatever the
   * daemon numbered 1 the second time round.
   */
  private send(msg: ClientMessage): boolean {
    if (!this.ready || !this.sock) return false
    this.sock.send(JSON.stringify(msg))
    return true
  }

  /** Send now, or hold until the socket opens. Session-free messages only. */
  private request(msg: ClientMessage) {
    if (this.send(msg)) return
    if (this.pending.length >= PENDING_LIMIT) return
    this.pending.push(msg)
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
    this.attachments.clear()
    sock?.close()
  }

  /**
   * Drop `id` from the reattach plan once no ref refers to it any more.
   *
   * The check is not decoration: one session may legitimately be held by two
   * refs, and letting go of one of them must not strand the other.
   */
  private forgetIfLastRef(id: string) {
    for (const a of this.attachments.values()) {
      if (a.id === id) return
    }
    this.wanted.delete(id)
  }

  private scheduleRetry() {
    const ceiling = Math.min(BACKOFF_BASE_MS * 2 ** this.attempt, BACKOFF_MAX_MS)
    // Capped, so a long outage cannot overflow the exponent into Infinity and
    // so the count stays meaningful if it is ever reported.
    if (this.attempt < 30) this.attempt++
    // Full jitter, so many tabs reconnecting do not synchronise.
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
