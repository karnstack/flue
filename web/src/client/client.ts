import {
  CAPS,
  decodeBinary,
  encodeBinary,
  FRAME_INPUT,
  FRAME_OUTPUT,
  PROTOCOL_VERSION,
  type Attached,
  type ClientMessage,
  type DeviceInfo,
  type ErrorMsg,
  type Pairing,
  type Preview,
  type RelayInfo,
  type ServerMessage,
  type SessionInfo,
  type SizeChanged,
  type Welcome,
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
 * How long a `peek` waits before giving up on the daemon.
 *
 * Generous against a busy daemon on a slow relay leg, and short enough that a
 * hover card resolves to "no preview right now" while the pointer is plausibly
 * still on the row. See `peek` for why this one request needs a deadline when
 * none of the others do.
 */
const PEEK_TIMEOUT_MS = 5_000

/**
 * How long a connection has to last before the backoff forgets it ever failed.
 *
 * "Reset on open" is not enough, because opening is not the same as being kept.
 * A channel that establishes and dies immediately — the Durable Object handing
 * the daemon leg to a newcomer and closing the incumbent with 4000 "replaced"
 * (relay/src/hub.ts), a daemon that reconnects in a loop, an edge that drops
 * the socket at the upgrade — used to reset the exponent on every cycle, so the
 * tab sat at the 125–250 ms floor forever: four to eight dials a second against
 * a Worker someone pays for, with nothing on screen to say why.
 *
 * Requiring the socket to have *lasted* lets a flapping channel escalate to the
 * ten-second ceiling and sit there instead. Five seconds, and the same five as
 * `minStableConn` in internal/transport/relay — the two legs of the same relay
 * meet the same failure and there is no reason for them to disagree about it.
 */
const MIN_STABLE_MS = 5_000

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
    for (const cb of [...this.listeners]) {
      try {
        cb(...args)
      } catch (err) {
        // Reported, never rethrown. Delivery is not a place a consumer's bug
        // may reach: `setStatus('reconnecting')` runs inside `onclose` one
        // line before the retry is armed, so one throwing listener would
        // otherwise abort the handler with nothing scheduled — a tab stuck at
        // `reconnecting` forever, no socket, no timer, and nothing logged.
        // The same shape sits in `onopen`, ahead of `hello` and the reattach
        // replay. Isolating it here rather than at each call site is what
        // makes that invariant hold for every emitter at once.
        console.error('flue: a listener threw; delivery continues', err)
      }
    }
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
 *
 * Replies are matched to requests by `reqId`, so StrictMode's
 * attach/forget/attach inside one round-trip settles each reply against the
 * exact request that asked.
 */
export class FlueClient {
  private sock: SocketLike | null = null
  /** Whether `sock` has opened. Sending before that throws in a browser. */
  private ready = false
  private attempt = 0
  /**
   * When the live socket opened, or null while there is none.
   *
   * Read once, on close, to decide whether this connection counts as one that
   * was kept — see `MIN_STABLE_MS`.
   */
  private openedAt: number | null = null
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

  /** The next request id; allocated per sent attach/spawn, never reused. */
  private nextReqId = 1

  /**
   * Requests on the wire, reqId -> the session asked for (`null` for a
   * spawn, whose session does not exist yet). Cleared by `teardown`:
   * replies do not survive their socket.
   */
  private pending = new Map<number, string | null>()

  /**
   * Requests whose reply should be handed straight back rather than adopted
   * — a view let go before the answer arrived. See `abandon` and `forget`.
   */
  private abandoned = new Set<number>()

  /**
   * The peeks on the wire, reqId -> whoever is waiting for the answer.
   *
   * A promise per request rather than an emitter, because a peek is the one
   * question this client asks that has exactly one asker and exactly one
   * answer: a hover wants *this* session's tail, and an emitter would hand
   * every preview to every listener and make each of them filter by id. Kept
   * apart from `pending` because the two are settled by different messages and
   * `pending`'s values are session ids used for the not-found sweep.
   *
   * Every entry is settled, one way or another. `teardown` rejects what is
   * left, for the reason it clears `pending`: a reply the outage carried away
   * is never coming, and a hover card waiting forever on it would sit at a
   * spinner until the pointer moved.
   */
  private peeks = new Map<number, { resolve: (p: Preview) => void; reject: (e: Error) => void }>()

  /** A `list` asked for while the socket was down. See `list`. */
  private listOwed = false

  /**
   * Whether this tab wants the paired-device list. Unlike `listOwed`, this
   * outlives the connection it was set on and is replayed on every one after
   * it, for the reason spelled out on `listDevices`.
   */
  private devicesWanted = false

  private outputListeners = new Emitter<[number, Uint8Array]>()
  private attachedListeners = new Emitter<[Attached]>()
  private exitListeners = new Emitter<[number, number]>()
  private sizeListeners = new Emitter<[SizeChanged]>()
  private sessionsListeners = new Emitter<[SessionInfo[]]>()
  private errorListeners = new Emitter<[ErrorMsg]>()
  private statusListeners = new Emitter<[ConnStatus]>()
  private goneListeners = new Emitter<[string]>()
  private deviceListeners = new Emitter<[DeviceInfo[]]>()
  private pairingListeners = new Emitter<[Pairing]>()
  private revokedListeners = new Emitter<[string]>()
  private welcomeListeners = new Emitter<[Welcome]>()

  /**
   * The last welcome this client was handed, kept across reconnects rather
   * than dropped in `teardown`: what it carries is a claim about the daemon,
   * not about the connection it rode in on, and each new connection's welcome
   * replaces it whole. Null only before the very first one.
   */
  private lastWelcome: Welcome | null = null

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
   * A session the daemon answered `not_found` for. The client has already
   * dropped it from the reattach plan; consumers only need to stop showing
   * it. Fired for the mount-time attach and for a reattach replayed after a
   * reconnect alike — the client resolves the reqId, so consumers never
   * have to.
   */
  onSessionGone(cb: (id: string) => void) {
    return this.goneListeners.add(cb)
  }

  /**
   * The paired devices, as of the daemon's last word on them.
   *
   * Answers a `listDevices`, and also arrives unasked: the daemon broadcasts
   * the new list to every remaining connection after a pairing or a revoke,
   * including ones it happened on behalf of. Nothing here tells the two apart,
   * so a screen that renders whatever it was last handed is always current.
   */
  onDeviceList(cb: (devices: DeviceInfo[]) => void) {
    return this.deviceListeners.add(cb)
  }

  /**
   * A pairing window the daemon has opened, answering `startPairing`. Handed
   * on whole: the second device needs the token, the URL, and the daemon's
   * public key, and the screen showing it needs the deadline.
   */
  onPairing(cb: (p: Pairing) => void) {
    return this.pairingListeners.add(cb)
  }

  /**
   * This device has been unpaired, and the connection is about to end.
   *
   * The daemon sends this immediately before it closes, so it always arrives
   * ahead of the status change — which is the point of it: without the reason,
   * a revoked device shows an ordinary blink and then reconnects forever
   * against a registry that no longer holds its key. What to do about it is
   * the consumer's: this client keeps its usual recovery, and a consumer that
   * wants the retries to stop calls `close` from here.
   */
  onRevoked(cb: (reason: string) => void) {
    return this.revokedListeners.add(cb)
  }

  /**
   * The daemon's greeting, one per connection.
   *
   * What it carries — and why anyone listens — is the state of the daemon's
   * relay leg, which is a snapshot taken as the connection was accepted, not
   * a stream: nothing pushes an update when the relay drops or comes back, so
   * a reconnect's welcome is the only event that ever refreshes it. Anything
   * gating on the relay re-evaluates here, or it is gating on history.
   */
  onWelcome(cb: (w: Welcome) => void) {
    return this.welcomeListeners.add(cb)
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

  /**
   * The relay leg of the last welcome — `onWelcome`'s counterpart for a
   * consumer that mounts between welcomes, as `status` is for `onStatus`.
   *
   * A daemon with no relay omits `welcome.relay` entirely and `off` never
   * arrives on the wire, so the absent field and a client no welcome has
   * reached yet both land on the same `{ status: 'off' }` here, rather than
   * every consumer folding three spellings of "no relay" into one.
   */
  get relay(): RelayInfo {
    return this.lastWelcome?.relay ?? { status: 'off' }
  }

  /** The offset of the next byte expected on `ref`, if it is still attached. */
  lastSeqFor(ref: number): number | undefined {
    return this.attachments.get(ref)?.lastSeq
  }

  /**
   * Start connecting, and keep reconnecting until `close`.
   *
   * A socket already in hand — dialling or open — makes this nothing: a second
   * connect must never leave two sockets where the client tracks one.
   *
   * An armed retry is the other case, and it is not the same one. The dial is
   * already owed, so returning here looks harmless, but the wait it is owed
   * behind runs to ten seconds, and the one caller that asks during that wait
   * is a human pressing Retry at a machine the screen says is unreachable. So
   * the timer is stood down and the socket opened now. The escalation is left
   * where it stands — `attempt` is untouched — because being asked again says
   * nothing about whether the machine has come back, and a held-down button
   * must not walk the backoff down to its floor.
   */
  connect() {
    this.stopped = false
    if (this.sock) return
    this.clearRetry()
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
    this.openedAt = null
    this.listOwed = false
    this.devicesWanted = false
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
   * Edit the metadata a human owns on a session — its name, its tags, whether
   * it is pinned. Answered by a fresh `sessions` to this connection, which
   * reaches `onSessions` like any other, so nothing here returns anything and
   * nothing correlates: a failure comes back as an uncorrelated
   * `error{code:"not_found"}` and surfaces through `onError`.
   *
   * The patch is spread whole rather than assembled field by field, and that
   * is the whole of the implementation on purpose. `name: ''`, `tags: []` and
   * `pinned: false` are three edits a user makes by hand and all three are
   * falsy, so a builder that copied each field only when it was truthy would
   * send an update carrying nothing at all — the last tag impossible to
   * remove, with no error to say so. Absence is the other half of the same
   * rule: a field the caller left out is a field this edit leaves alone, which
   * is what lets two views on one session edit it without overwriting each
   * other.
   *
   * Dropped rather than held while the socket is down, unlike `list`. A rename
   * is not the idempotent question a list is: replayed from behind a
   * ten-second backoff it would land on whatever the metadata had become
   * meanwhile, undoing another view's edit — the exact case partiality exists
   * to protect. Losing it costs a retry and little else, since the sessions
   * screen re-lists on reconnect and the row visibly snaps back.
   */
  update(patch: { id: string; name?: string; tags?: string[]; pinned?: boolean }) {
    this.send({ type: 'update', ...patch })
  }

  /**
   * Ask for the tail of a session's scrollback, without attaching to it.
   *
   * The one request on this client that answers with a promise, because it is
   * the one whose reply has exactly one asker: a hover card wants *this*
   * session's bytes and nothing else, and threading that through an emitter
   * would make every consumer filter by id and invent its own timeout.
   *
   * Dropped rather than held while the socket is down — the rejection is the
   * point. A preview is a thing somebody is looking at right now; one that
   * surfaced from behind a ten-second backoff would draw output that is ten
   * seconds stale into a card over a row the pointer left long ago. Callers
   * are expected to catch and show nothing.
   */
  peek(id: string, bytes?: number): Promise<Preview> {
    if (!this.ready || !this.sock) {
      return Promise.reject(new Error('flue: not connected'))
    }
    const reqId = this.nextReqId++
    return new Promise<Preview>((resolve, reject) => {
      /*
       * The one request on this client with a deadline of its own, and it
       * earns it: `peek` is newer than the protocol's other verbs, so a daemon
       * older than this page answers it with an *uncorrelated*
       * `error{bad_message}` — a refusal that names no reqId and therefore
       * reaches no asker. Without this the card would sit at "Reading…" for as
       * long as the pointer stayed on the row, on every row, forever. The same
       * timer covers a daemon that simply dropped the request.
       *
       * Nothing else here needs one: every other reply either arrives or dies
       * with its socket, and `teardown` settles that case.
       */
      const deadline = setTimeout(() => {
        if (!this.peeks.delete(reqId)) return
        reject(new Error('flue: the daemon did not answer'))
      }, PEEK_TIMEOUT_MS)
      const settle = <T,>(cb: (v: T) => void) => (v: T) => {
        clearTimeout(deadline)
        cb(v)
      }
      this.peeks.set(reqId, { resolve: settle(resolve), reject: settle(reject) })
      // After the entry exists, so a send that throws synchronously — a socket
      // that closed between the readiness check and here — cannot leave a
      // promise nothing will ever settle.
      if (!this.send({ type: 'peek', id, bytes, reqId })) {
        clearTimeout(deadline)
        this.peeks.delete(reqId)
        reject(new Error('flue: not connected'))
      }
    })
  }

  /**
   * Ask for the paired-device list, and keep asking on every connection after
   * this one.
   *
   * The only request that goes further than `list`'s hold-while-down, and it
   * has to. `deviceList` is pushed only when a pairing or a revoke happens, so
   * nothing else will ever correct a stale list — and a reconnect is precisely
   * when it is likely to *be* stale, because a device revoked during the
   * outage leaves the tab showing an entry that no longer exists, for as long
   * as the tab stays open. `list` needs no such thing only because the
   * sessions screen re-asks every few seconds; a devices screen has no reason
   * to poll and should not have to.
   *
   * The intent is one flag rather than a queue, because the question is
   * idempotent, and it lasts until `close`: one `devices` per connection
   * thereafter, alongside the reattach replay that connection already carries.
   */
  listDevices() {
    this.devicesWanted = true
    this.send({ type: 'devices' })
  }

  /**
   * Unpair a device.
   *
   * Dropped rather than held while the socket is down: replayed after an
   * outage this could unpair a device that had been paired again in the
   * meantime. There is no reply to correlate — the daemon answers by
   * broadcasting the new `deviceList` to every connection left, which reaches
   * `onDeviceList` like any other.
   */
  revokeDevice(deviceId: string) {
    this.send({ type: 'revoke', deviceId })
  }

  /**
   * Open a pairing window, answered by `pairing`.
   *
   * Dropped while the socket is down, as `spawn` is: the token is good for two
   * minutes, so one that surfaced from behind a ten-second backoff would show
   * an expiring token at a screen that had long since moved on.
   */
  startPairing() {
    this.send({ type: 'pairStart' })
  }

  /**
   * Close the pairing window, invalidating any outstanding token.
   *
   * Dropped while the socket is down, and safely so: the daemon leaves pairing
   * mode on the deadline as well as on this, so a cancel the outage swallowed
   * costs at most the rest of that two-minute window.
   */
  cancelPairing() {
    this.send({ type: 'pairCancel' })
  }

  /**
   * Ask for a new session. Returns the reqId the reply will echo, or null
   * when the socket was down — dropped rather than held, as before: a shell
   * that appears minutes later at a screen nobody is looking at is worse
   * than none.
   */
  spawn(opts: { cwd?: string; cmd?: string[]; cols: number; rows: number }): number | null {
    if (!this.ready || !this.sock) return null
    const { cols, rows, ...rest } = opts
    const reqId = this.nextReqId++
    this.send({ type: 'spawn', ...rest, cols: dimension(cols), rows: dimension(rows), reqId })
    this.pending.set(reqId, null)
    return reqId
  }

  /**
   * Attach to a session and keep it attached across reconnects.
   *
   * Recorded before it is sent, so a socket that is not ready yet — or that
   * drops before `attached` comes back — still replays this on open. Each
   * sent attach carries a fresh reqId; the daemon echoes it on the reply.
   */
  attach(id: string, lastSeq = 0) {
    this.wanted.set(id, lastSeq)
    this.sendAttach(id, lastSeq)
  }

  private sendAttach(id: string, lastSeq: number) {
    if (!this.ready || !this.sock) return
    const reqId = this.nextReqId++
    this.send({ type: 'attach', id, lastSeq, reqId })
    this.pending.set(reqId, id)
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
   * Disown one in-flight request. Its reply, when it arrives, is handed
   * straight back (`detach`) and adopted by nobody — the exact mechanism
   * that used to be a per-session refusal count, now naming the one reply
   * it means. A reqId that is not in flight abandons nothing.
   */
  abandon(reqId: number) {
    if (!this.pending.delete(reqId)) return
    this.abandoned.add(reqId)
  }

  /**
   * Stop trying to reattach a session, without naming a ref. Final: the
   * plan entry goes, and every in-flight request for the session is
   * abandoned, so a reply already on the wire cannot re-seed the plan.
   */
  forget(id: string) {
    this.wanted.delete(id)
    for (const [reqId, sid] of this.pending) {
      if (sid === id) {
        this.pending.delete(reqId)
        this.abandoned.add(reqId)
      }
    }
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

  /**
   * Ask the daemon to end a session by its id, with no attachment in hand —
   * how the sessions list closes a row it never attached to.
   *
   * Dropped rather than held while the socket is down, for `update`'s reason
   * with sharper teeth: a close replayed from behind a ten-second backoff
   * would kill whatever the session had become in the meantime, and unlike a
   * rename there is no snapping back from it. The list keeps showing the row,
   * so the user retries with the truth in front of them.
   *
   * Nothing to correlate: success has no reply — the exit reaches attached
   * views and the next list — and a failure comes back as an uncorrelated
   * `error{not_found}` through `onError`.
   */
  closeById(id: string) {
    this.send({ type: 'close', id })
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
      // Noted, not acted on: the backoff is reset on *close*, and only for a
      // connection that lasted. See `MIN_STABLE_MS`.
      this.openedAt = Date.now()
      this.setStatus('open')

      this.send({ type: 'hello', ver: PROTOCOL_VERSION, caps: [...CAPS] })
      for (const [id, lastSeq] of this.wanted) this.sendAttach(id, lastSeq)
      if (this.listOwed) {
        this.listOwed = false
        this.send({ type: 'list' })
      }
      // Not cleared, unlike the owed list: what this replays is a standing
      // intent, and the answer is what corrects a list the outage invalidated.
      if (this.devicesWanted) this.send({ type: 'devices' })
    }

    sock.onclose = () => {
      if (this.sock !== sock) return
      // Before teardown, because this is the only thing that knows how long
      // the socket was up. A connection that was kept says nothing about how
      // long to wait for the next one, so the run of failures starts over; one
      // that was taken away immediately says the opposite and keeps its place
      // in the escalation.
      const lasted = this.openedAt === null ? 0 : Date.now() - this.openedAt
      this.openedAt = null
      if (lasted >= MIN_STABLE_MS) this.attempt = 0

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
        if (msg.reqId !== undefined && this.abandoned.delete(msg.reqId)) {
          // Asked for, then let go of before the answer arrived. Hand the
          // ref straight back rather than adopting an attachment nobody is
          // behind. Named by reqId, so a second attach issued in the
          // meantime — a StrictMode remount — is answered normally.
          this.send({ type: 'detach', ref: msg.ref })
          break
        }
        if (msg.reqId !== undefined) this.pending.delete(msg.reqId)
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

      case 'preview': {
        if (msg.reqId === undefined) break
        const waiting = this.peeks.get(msg.reqId)
        if (waiting === undefined) break
        this.peeks.delete(msg.reqId)
        waiting.resolve(msg)
        break
      }

      case 'error': {
        if (msg.reqId !== undefined) {
          // A peek's own refusal, before the attach bookkeeping below looks at
          // it: `not_found` answers both, and only the peek's asker should
          // hear about a session the sessions list has already reaped. It is
          // deliberately not folded into `pending` — that map's not-found
          // sweep retires a reattach plan, which a peek never made.
          const waiting = this.peeks.get(msg.reqId)
          if (waiting !== undefined) {
            this.peeks.delete(msg.reqId)
            waiting.reject(new Error(msg.msg || msg.code))
            this.errorListeners.emit(msg)
            break
          }
          this.abandoned.delete(msg.reqId)
          const sid = this.pending.get(msg.reqId)
          this.pending.delete(msg.reqId)
          if (msg.code === 'not_found' && typeof sid === 'string') {
            // The daemon does not know the session, so the plan must stop
            // asking for it — on this connection and every next one.
            this.wanted.delete(sid)
            this.goneListeners.emit(sid)
          }
        }
        this.errorListeners.emit(msg)
        break
      }

      case 'deviceList':
        this.deviceListeners.emit(msg.devices)
        break

      case 'pairing':
        this.pairingListeners.emit(msg)
        break

      case 'revoked':
        // Delivered here and nowhere else. The daemon writes this frame ahead
        // of the goodbye on the same queue, so the reason reaches consumers
        // before `onclose` announces the outage — anything deferred past this
        // point would arrive after the client had already begun reconnecting.
        this.revokedListeners.emit(msg.reason)
        break

      case 'welcome':
        // Stored before it is announced, so a listener that reads `relay`
        // inside its callback sees the welcome it is being told about.
        this.lastWelcome = msg
        this.welcomeListeners.emit(msg)
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
    // All three name replies that were on the wire, and this socket was the
    // wire. The peeks are rejected rather than merely dropped: a promise
    // nothing settles is a hover card spinning until the pointer moves.
    this.pending.clear()
    this.abandoned.clear()
    const orphaned = [...this.peeks.values()]
    this.peeks.clear()
    for (const p of orphaned) p.reject(new Error('flue: connection lost'))
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
