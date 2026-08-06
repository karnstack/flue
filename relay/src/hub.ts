import { DurableObject } from 'cloudflare:workers'
import { decodeFrame, encodeFrame } from './frame'
import type { Env } from './index'

/**
 * DaemonHub bridges one daemon socket to any number of client sockets with the
 * framing in spec/relay-protocol.md: daemon frames are `[4B channel][payload]`,
 * client frames are bare payloads, and channel 0 carries the control JSON.
 * Channel ids come from a counter in DO storage, so no id is ever reused
 * within a hub's lifetime — across hibernation and daemon reconnects both.
 *
 * Hibernation rules this class lives by: sockets are accepted with
 * `ctx.acceptWebSocket` — never `ws.accept()`, which pins the object in
 * memory — no pending `setTimeout`/`setInterval` outside a request that is
 * already holding the object awake (the handshake deadline is a DO alarm; the
 * pairing deadline is the one exception, and `awaitPairResult` says why), and
 * no outbound sockets from the DO. Everything a handler needs about a socket
 * lives in its serialized attachment, because in-memory state does not survive
 * a hibernation wake.
 */
export class DaemonHub extends DurableObject<Env> {
  /**
   * Parked `POST /api/pair` requests, by the pair id the daemon will answer
   * with. In memory on purpose: an in-flight `fetch` keeps the object off the
   * hibernation path for exactly as long as an entry here matters, so no wake
   * can find this map emptied out from under a waiting request. Putting it in
   * storage would buy nothing and would outlive the socket the ids belong to,
   * which the spec says they must not (spec/relay-protocol.md, `pair.id`).
   */
  private readonly pending = new Map<number, (outcome: PairOutcome) => void>()

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    // The edge answers keepalives itself, without waking a hibernated object
    // (spec/relay-protocol.md, Keepalive).
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('flue-ping', 'flue-pong'))
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url)
    if (url.pathname === '/daemon') return this.acceptDaemon(req)
    if (url.pathname === '/client') return this.acceptClient(req)
    if (url.pathname === '/api/pair') return this.pair(req)
    return new Response('not found', { status: 404 })
  }

  /**
   * The live daemon socket, if one is attached. Not `getWebSockets('daemon')[0]`:
   * after a replacement the dying socket can still be listed, so the `live`
   * flag in the attachment — not list position — names the socket frames go to.
   */
  private daemon(): WebSocket | undefined {
    return this.ctx
      .getWebSockets('daemon')
      .find((ws) => (ws.deserializeAttachment() as DaemonAttachment | null)?.live === true)
  }

  private acceptDaemon(req: Request): Response {
    const refusal = refuseNonUpgrade(req)
    if (refusal) return refusal
    // One daemon per hub. The newcomer wins — a daemon that reconnects after
    // a network flap must not find its half-dead predecessor squatting on the
    // leg — and the old socket is told why.
    for (const old of this.ctx.getWebSockets('daemon')) {
      const att = old.deserializeAttachment() as DaemonAttachment | null
      if (att?.live) old.serializeAttachment({ live: false } satisfies DaemonAttachment)
      try {
        old.close(4000, 'replaced')
      } catch {
        // Already closing; nothing left to tell it.
      }
    }
    // A replacement is a reconnect, and a reconnect invalidates every live
    // channel (spec/relay-protocol.md, the daemon leg): the old leg's clients
    // go down 1012 now, quietly — the replacement never opened their channels,
    // so it is not told they closed.
    this.dropClients()
    this.failPendingPairs()
    const pair = new WebSocketPair()
    this.ctx.acceptWebSocket(pair[1], ['daemon'])
    pair[1].serializeAttachment({ live: true } satisfies DaemonAttachment)
    return new Response(null, { status: 101, webSocket: pair[0] })
  }

  private async acceptClient(req: Request): Promise<Response> {
    const refusal = refuseNonUpgrade(req)
    if (refusal) return refusal
    // A client without a daemon has nothing to talk to, and accepting it would
    // only manufacture a dead socket to close: refuse at the door instead.
    const daemon = this.daemon()
    if (!daemon) return offline()
    // The cap is the DoS bound the spec leans on for the credential-less
    // client leg (spec/relay-protocol.md, Auth).
    if (this.ctx.getWebSockets('client').length >= MAX_CLIENTS) {
      return new Response('{"error":"relay full"}', { status: 503, headers: JSON_NO_STORE })
    }
    // The counter lives in storage so ids survive hibernation and daemon
    // reconnects: a channel id is never reused within this hub's lifetime.
    const channel = (await this.ctx.storage.get<number>('nextChannel')) ?? 1
    await this.ctx.storage.put('nextChannel', channel + 1)
    // Arm the handshake deadline unless a reap is already pending; alarm()
    // re-arms for whoever remains.
    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(Date.now() + this.handshakeTimeout())
    }
    const pair = new WebSocketPair()
    this.ctx.acceptWebSocket(pair[1], ['client'])
    pair[1].serializeAttachment({
      channel,
      seen: false,
      opened: Date.now(),
      fwdToDaemon: 0,
      fwdToClient: 0,
      bytesToDaemon: 0,
      bytesToClient: 0,
    } satisfies ClientAttachment)
    daemon.send(controlFrame({ type: 'open', channel, origin: new URL(req.url).origin }))
    return new Response(null, { status: 101, webSocket: pair[0] })
  }

  /**
   * `POST /api/pair`, the one part of the ceremony that is an HTTP request
   * rather than a WebSocket message (spec/relay-protocol.md, the control
   * channel). The request is parked here while its body travels to the daemon
   * on channel 0 and the daemon's verdict travels back.
   *
   * The relay refuses what it can judge alone — provenance, size, shape, and
   * how many attempts it is already holding — before it spends a pair id or
   * the daemon's attention on the request.
   */
  private async pair(req: Request): Promise<Response> {
    const origin = new URL(req.url).origin
    // The structural equivalent of the daemon's own provenance check
    // (internal/daemon/pairing.go, handlePair), run where TLS terminates: a
    // cross-origin page must not be able to burn the user's pairing window. A
    // missing Origin is admitted for the reason it is admitted there — a
    // non-browser client never sends one — and costs nothing, because the
    // pairing token is the credential either way.
    const claimed = req.headers.get('Origin')
    if (claimed !== null && claimed !== origin) return pairRefused()
    const raw = await readCapped(req, MAX_PAIR_BYTES)
    if (raw === null) return pairTooLarge()
    const body = decoder.decode(raw)
    // The body reaches the daemon verbatim — the daemon's own pairing handler
    // parses those bytes, so the relay must not reshape them (spec, the control
    // channel). Parsing here is not that reshaping; it is the guard that makes
    // splicing raw bytes into the hub's own JSON safe. A body of
    // `{}, "type":"closed", "channel":1` would otherwise close the `pair`
    // object early and forge a second relay → daemon control message out of
    // its tail. `JSON.parse` accepts exactly one complete value and nothing
    // after it, so a body it accepts cannot escape the slot it is spliced into.
    try {
      JSON.parse(body)
    } catch {
      // What the daemon's own handler answers a malformed request, in the JSON
      // shape this leg carries a refusal in (spec, `pairResult.body`).
      return pairRefused()
    }
    const daemon = this.daemon()
    if (!daemon) return offline()
    // The concurrency bound this leg needs for the reason MAX_CLIENTS bounds
    // the other credential-less one (spec/relay-protocol.md, Auth): the
    // deadline alone lets a caller hold N parked requests — N timers, N storage
    // writes, N control frames at a daemon whose own pairing handler is not
    // rate limited — for as long as it likes. A human ceremony never has more
    // than one in flight; the rest of the cap is for retries and second devices.
    if (this.pending.size >= MAX_PENDING_PAIRS) return tooManyPairs()
    // The counter lives in storage for the reason nextChannel does. The ids it
    // hands out mean nothing across a daemon reconnect, which is why one
    // invalidates every parked request rather than leaving a stale id to be
    // answered late (spec, `pair.id`).
    const id = (await this.ctx.storage.get<number>('nextPairId')) ?? 1
    await this.ctx.storage.put('nextPairId', id + 1)
    try {
      daemon.send(encodeFrame(0, encoder.encode(pairMessage(id, origin, body))))
    } catch {
      // The leg is dying under us and its close event will finish the teardown;
      // this request is one the replacement will never hear about.
      return offline()
    }
    // The waiter is registered synchronously after the send — nothing awaits in
    // between — so the answer, which can only be delivered at an await point,
    // cannot arrive before there is something to receive it.
    const outcome = await this.awaitPairResult(id)
    if (outcome === 'gone') return offline()
    if (outcome === 'timeout') {
      return new Response('{"error":"daemon did not answer"}', {
        status: 504,
        headers: JSON_NO_STORE,
      })
    }
    // By the time a pairResult arrives the daemon is trusted infrastructure,
    // and it guarantees a JSON body (it wraps its own text refusals as
    // {"error":"pairing refused"} — spec, `pairResult.body`). The hub writes
    // the status and the body through without a second opinion about either.
    const status = pairStatus(outcome.status)
    return new Response(
      // 204, 205 and 304 may not carry a body: constructing one that does
      // throws, and a daemon's odd choice of status must not take the request
      // down with it.
      NULL_BODY_STATUS.has(status) ? null : JSON.stringify(outcome.body ?? null),
      { status, headers: JSON_NO_STORE },
    )
  }

  /**
   * Parks the caller until the daemon answers this id or the deadline passes.
   *
   * The `setTimeout` is the one this class otherwise forbids: a pending timer
   * pins the object in memory, which is exactly why the handshake deadline is
   * an alarm. This one is different in kind — it exists only while a request is
   * in flight, and that request is already holding the object awake — and it is
   * cleared the moment the race settles, so it never pins anything by itself.
   */
  private awaitPairResult(id: number): Promise<PairOutcome> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        resolve('timeout')
      }, this.pairTimeout())
      this.pending.set(id, (outcome) => {
        clearTimeout(timer)
        resolve(outcome)
      })
    })
  }

  /**
   * The daemon leg is over, so every parked pair is over with it: a
   * reconnecting daemon must not answer a `pair` it read before the break,
   * because the Worker has forgotten the request it belonged to (spec,
   * `pair.id`). Answering now beats making a browser sit out the whole deadline
   * for a 504 that is already decided.
   */
  private failPendingPairs(): void {
    for (const [id, resolve] of [...this.pending]) {
      this.pending.delete(id)
      resolve('gone')
    }
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message === 'string') {
      // flue-ping never reaches here — the auto-response answers it at the
      // edge — and a stray flue-pong is dropped silently (spec, Keepalive).
      // Every other text frame, on either leg, is a protocol error.
      if (message === 'flue-pong') return
      if (this.ctx.getTags(ws).includes('daemon')) {
        this.dropDaemon(ws, 1002, 'unexpected text frame')
      } else {
        this.retireClient(ws, true)
        try {
          ws.close(1002, 'unexpected text frame')
        } catch {
          // Already closing.
        }
      }
      return
    }
    if (this.ctx.getTags(ws).includes('daemon')) this.daemonMessage(ws, message)
    else this.clientMessage(ws, message)
  }

  async webSocketClose(ws: WebSocket, _code: number, _reason: string, _wasClean: boolean): Promise<void> {
    this.teardown(ws)
  }

  async webSocketError(ws: WebSocket, _error: unknown): Promise<void> {
    // An errored socket is gone without a close frame. Same teardown; the
    // done/live guards make a duplicate pass a no-op.
    this.teardown(ws)
  }

  /** The handshake deadline: reap clients that never sent, re-arm for the rest. */
  async alarm(): Promise<void> {
    const now = Date.now()
    const timeout = this.handshakeTimeout()
    let next: number | null = null
    for (const ws of this.ctx.getWebSockets('client')) {
      const att = ws.deserializeAttachment() as ClientAttachment | null
      if (!att || att.done || att.seen) continue
      const deadline = att.opened + timeout
      if (deadline <= now) {
        // It was announced open, so the daemon hears closed.
        this.retireClient(ws, true)
        try {
          ws.close(4001, 'handshake timeout')
        } catch {
          // Already closing.
        }
      } else {
        next = next === null ? deadline : Math.min(next, deadline)
      }
    }
    if (next !== null) await this.ctx.storage.setAlarm(next)
  }

  private daemonMessage(ws: WebSocket, buf: ArrayBuffer): void {
    // Only the live daemon may speak; a replaced socket's last words are dropped.
    if (!(ws.deserializeAttachment() as DaemonAttachment | null)?.live) return
    let frame: { channel: number; payload: Uint8Array }
    try {
      frame = decodeFrame(buf)
    } catch {
      // Shorter than the header is a protocol error (spec, the daemon leg).
      this.dropDaemon(ws, 1002, 'short frame')
      return
    }
    if (frame.channel === 0) {
      this.control(frame.payload)
      return
    }
    const target = this.clientFor(frame.channel)
    if (!target) return // that browser is already gone; the payload is dropped
    target.att.fwdToClient += 1
    target.att.bytesToClient += frame.payload.byteLength
    target.ws.serializeAttachment(target.att)
    try {
      target.ws.send(frame.payload)
    } catch {
      // Closing under us — the remote close is not yet processed. Its close
      // event finishes the teardown; the payload is dropped like any other
      // payload for a gone browser.
    }
  }

  /** A control payload from the daemon: channel 0, one JSON object per frame. */
  private control(payload: Uint8Array): void {
    let msg: ControlFromDaemon
    try {
      msg = JSON.parse(decoder.decode(payload)) as ControlFromDaemon
    } catch {
      // Not JSON. Dropped: the relay prefers deafness to cascading a whole
      // hub's sockets over one malformed frame.
      return
    }
    if (msg.type === 'close' && typeof msg.channel === 'number') {
      const target = this.clientFor(msg.channel)
      if (!target) return // already gone; a late close crossed a closed in flight
      // The daemon asked for this close; it needs no closed echoed back.
      this.retireClient(target.ws, false)
      try {
        target.ws.close(1000, 'daemon closed')
      } catch {
        // Already closing.
      }
      return
    }
    if (msg.type === 'pairResult' && typeof msg.id === 'number') {
      const waiter = this.pending.get(msg.id)
      // No waiter: the request gave up at its deadline, or this id belongs to a
      // socket that is gone and a hub that has forgotten it (spec, `pair.id`).
      // Either way there is nobody to write the answer to.
      if (!waiter) return
      this.pending.delete(msg.id)
      waiter({ status: msg.status, body: msg.body })
      return
    }
    // Anything else is dropped — an unknown type here means the peers disagree
    // about the protocol, and one deaf frame is cheaper than tearing the hub
    // down.
  }

  private clientMessage(ws: WebSocket, buf: ArrayBuffer): void {
    const att = ws.deserializeAttachment() as ClientAttachment | null
    if (!att || att.done) return // retired; the close frame is still in flight
    const daemon = this.daemon()
    if (!daemon) {
      // The daemon fan-out will not reach this socket twice: retire quiet now.
      this.retireClient(ws, false)
      try {
        ws.close(1013, 'daemon offline')
      } catch {
        // Already closing.
      }
      return
    }
    att.seen = true
    att.fwdToDaemon += 1
    att.bytesToDaemon += buf.byteLength
    ws.serializeAttachment(att)
    try {
      daemon.send(encodeFrame(att.channel, new Uint8Array(buf)))
    } catch {
      // The daemon leg is dying under us; its close event takes this channel
      // down 1012 momentarily, and the frame is lost with the channel.
    }
  }

  /** Close/error arrived for a socket; route it to the right teardown. */
  private teardown(ws: WebSocket): void {
    if (this.ctx.getTags(ws).includes('daemon')) this.dropDaemon(ws, 1012, 'daemon gone')
    else this.retireClient(ws, true)
  }

  /**
   * One exit path for a client socket: log the per-channel counters exactly
   * once and tell the daemon `closed` — unless the close is one the daemon
   * caused (`close` control) or did not outlive (takeover, daemon gone), where
   * `notifyDaemon` is false. The `done` flag makes the second pass a no-op:
   * webSocketClose still fires for sockets the hub closed itself.
   */
  private retireClient(ws: WebSocket, notifyDaemon: boolean): void {
    const att = ws.deserializeAttachment() as ClientAttachment | null
    if (!att || att.done) return
    att.done = true
    ws.serializeAttachment(att)
    console.log(
      JSON.stringify({
        evt: 'channel_closed',
        channel: att.channel,
        fwdToDaemon: att.fwdToDaemon,
        fwdToClient: att.fwdToClient,
        bytesToDaemon: att.bytesToDaemon,
        bytesToClient: att.bytesToClient,
      }),
    )
    if (!notifyDaemon) return
    const daemon = this.daemon()
    if (!daemon) return
    try {
      daemon.send(controlFrame({ type: 'closed', channel: att.channel }))
    } catch {
      // The daemon is dying too; its own teardown finishes the job.
    }
  }

  /**
   * The daemon leg is over. Close the socket, and if it was the live one —
   * not a replaced socket whose death was handled at takeover — take every
   * client down with it: a daemon reconnect invalidates every live channel
   * (spec/relay-protocol.md, the daemon leg).
   */
  private dropDaemon(ws: WebSocket, code: number, reason: string): void {
    const att = ws.deserializeAttachment() as DaemonAttachment | null
    try {
      ws.close(code, reason)
    } catch {
      // Already closed.
    }
    if (!att?.live) return
    ws.serializeAttachment({ live: false } satisfies DaemonAttachment)
    this.dropClients()
    this.failPendingPairs()
  }

  /**
   * Close every client 1012 "daemon gone", sending no `closed` frames: there
   * is either no daemon left to read them, or a replacement that never opened
   * these channels and must not hear about them.
   */
  private dropClients(): void {
    for (const ws of this.ctx.getWebSockets('client')) {
      this.retireClient(ws, false)
      try {
        ws.close(1012, 'daemon gone')
      } catch {
        // Already closing.
      }
    }
  }

  /** The client socket carrying this channel, with its attachment. */
  private clientFor(channel: number): { ws: WebSocket; att: ClientAttachment } | undefined {
    for (const ws of this.ctx.getWebSockets('client')) {
      const att = ws.deserializeAttachment() as ClientAttachment | null
      if (att && !att.done && att.channel === channel) return { ws, att }
    }
    return undefined
  }

  private handshakeTimeout(): number {
    const n = Number(this.env.HANDSHAKE_TIMEOUT_MS ?? HANDSHAKE_TIMEOUT_MS)
    return Number.isFinite(n) && n > 0 ? n : HANDSHAKE_TIMEOUT_MS
  }

  private pairTimeout(): number {
    const n = Number(this.env.PAIR_TIMEOUT_MS ?? PAIR_TIMEOUT_MS)
    return Number.isFinite(n) && n > 0 ? n : PAIR_TIMEOUT_MS
  }
}

/** Concurrent client sockets one hub will hold — the DoS bound on the
 * credential-less leg (spec/relay-protocol.md, Auth). */
const MAX_CLIENTS = 64

/** The handshake deadline when HANDSHAKE_TIMEOUT_MS is unbound (production). */
const HANDSHAKE_TIMEOUT_MS = 30_000

/** How long a parked /api/pair waits when PAIR_TIMEOUT_MS is unbound. */
const PAIR_TIMEOUT_MS = 10_000

/** The pairing body cap, the same 4 KiB the daemon's own handler bounds it to
 * (internal/daemon/pairing.go, maxPairBytes): the whole document is a token, a
 * 32-byte key in base64 and a human label. */
const MAX_PAIR_BYTES = 4096

/** Parked `POST /api/pair` requests one hub will hold at once — the DoS bound
 * on the credential-less pairing endpoint (spec/relay-protocol.md, Auth). A
 * ceremony a human is driving never has more than one in flight. */
const MAX_PENDING_PAIRS = 8

/** Statuses a `Response` may not carry a body for. */
const NULL_BODY_STATUS = new Set([204, 205, 304])

/** What every JSON answer this hub writes carries. `no-store` because all of
 * them are about the state of one live ceremony: a refusal that got cached by
 * anything in the path would outlive the condition that caused it. */
const JSON_NO_STORE = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }

/** What a daemon socket remembers across hibernation. */
interface DaemonAttachment {
  /** False once replaced. `getWebSockets` can still list the dying socket, so
   * this flag — not list position — names the daemon frames go to. */
  live: boolean
}

/** What a client socket remembers across hibernation. */
interface ClientAttachment {
  channel: number
  /** Has this socket sent anything yet? The alarm reaps those that never do. */
  seen: boolean
  opened: number
  fwdToDaemon: number
  fwdToClient: number
  bytesToDaemon: number
  bytesToClient: number
  /** Teardown ran: counters logged, daemon told if it was to be told. Set
   * before the hub closes a socket itself, so the close event's second pass
   * through retireClient is a no-op. */
  done?: boolean
}

/** How a parked /api/pair ends: the daemon answered, gave up on us, or left. */
type PairOutcome = { status: unknown; body: unknown } | 'timeout' | 'gone'

/** relay → daemon control messages (spec/relay-protocol.md, channel 0). `pair`
 * is not here: its body must reach the daemon unreshaped, so it is written by
 * `pairMessage` rather than round-tripped through an object. */
type ControlToDaemon =
  | { type: 'open'; channel: number; origin: string }
  | { type: 'closed'; channel: number }

/** daemon → relay control messages, as they arrive: off the wire, so every
 * field is a claim rather than a fact. */
interface ControlFromDaemon {
  type?: string
  channel?: number
  id?: number
  status?: unknown
  body?: unknown
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/** Lays a control message out as a channel-0 frame. */
function controlFrame(msg: ControlToDaemon): ArrayBuffer {
  return encodeFrame(0, encoder.encode(JSON.stringify(msg)))
}

/**
 * The `pair` control message, with the browser's JSON spliced in where
 * re-encoding it would have reshaped it. Field order is the one
 * testdata/relay/frames.json pins. Safe only for a `body` that `JSON.parse`
 * has already accepted — see the guard in `pair`.
 */
function pairMessage(id: number, origin: string, body: string): string {
  return `{"type":"pair","id":${id},"origin":${JSON.stringify(origin)},"body":${body}}`
}

/**
 * The status to answer a pairResult with. The daemon is trusted about the
 * pairing decision, not about arithmetic: a status `Response` cannot hold would
 * throw out of the request handler, and 502 is what a gateway says when its
 * upstream hands it something it cannot pass on.
 */
function pairStatus(status: unknown): number {
  return typeof status === 'number' && Number.isInteger(status) && status >= 200 && status <= 599
    ? status
    : 502
}

/**
 * The request body, or null if it runs past `max`.
 *
 * Content-Length is consulted first so an honestly-labelled oversized POST is
 * refused without being read, and the stream is then counted as it arrives:
 * a chunked body declares no length at all, and buffering an undeclared one
 * would hand the credential-less pairing endpoint a memory DoS — the same
 * exposure the channel cap and the handshake deadline bound on the client leg
 * (spec/relay-protocol.md, Auth).
 */
async function readCapped(req: Request, max: number): Promise<Uint8Array | null> {
  const declared = Number(req.headers.get('Content-Length'))
  if (Number.isFinite(declared) && declared > max) return null
  if (!req.body) return new Uint8Array(0)
  const reader = req.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > max) return null
      chunks.push(value)
    }
  } finally {
    // Releases the leg of an oversized body we stopped reading; a no-op once
    // the stream has ended on its own.
    await reader.cancel().catch(() => {})
  }
  const out = new Uint8Array(total)
  let at = 0
  for (const chunk of chunks) {
    out.set(chunk, at)
    at += chunk.byteLength
  }
  return out
}

/** WebSocket endpoints answer plain HTTP with 426, upgrade required. */
function refuseNonUpgrade(req: Request): Response | null {
  if (req.headers.get('Upgrade')?.toLowerCase() === 'websocket') return null
  return new Response('expected a WebSocket upgrade', { status: 426 })
}

function offline(): Response {
  return new Response('{"error":"daemon offline"}', { status: 503, headers: JSON_NO_STORE })
}

/**
 * A pairing attempt the relay refused on its own. One status and one body,
 * whatever the reason — the same uniformity the daemon's own refusePair keeps,
 * for the same reason: an endpoint reachable without a session token must not
 * be an oracle for the state of the user's live ceremony.
 */
function pairRefused(): Response {
  return new Response('{"error":"pairing refused"}', { status: 403, headers: JSON_NO_STORE })
}

function pairTooLarge(): Response {
  return new Response('{"error":"pairing body too large"}', {
    status: 413,
    headers: JSON_NO_STORE,
  })
}

/**
 * Too many pairing attempts parked at once (`MAX_PENDING_PAIRS`). 429 rather
 * than the 503 a missing daemon gets: the daemon is there and the caller's own
 * concurrency is what is in the way, and a caller told "offline" would retry
 * the wrong thing. It leaks only how busy this hub is, which a caller filling
 * the cap itself already knows.
 */
function tooManyPairs(): Response {
  return new Response('{"error":"too many pairing attempts"}', {
    status: 429,
    headers: JSON_NO_STORE,
  })
}
