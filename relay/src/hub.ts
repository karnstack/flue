import { DurableObject } from 'cloudflare:workers'
import { decodeFrame, encodeFrame } from './frame'
import { JSON_NO_STORE, readCapped } from './http'
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
 * no outbound sockets from the DO. Everything a handler *needs* about a socket
 * lives in its serialized attachment, because in-memory state does not survive
 * a hibernation wake — which is why the memory below is all derived, rebuilt
 * from those attachments on the first frame after a wake and never the source
 * of truth for anything.
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

  /**
   * The live client sockets by channel, and the live daemon socket — this
   * wake's index over what `getWebSockets` would otherwise be walked for on
   * every frame.
   *
   * It is the difference between forwarding costing O(1) and costing O(clients),
   * and that mattered more than it looks. Every chunk of terminal output on
   * every session on this machine is one frame through `daemonMessage`, and the
   * lookup it used to do was a scan of every client socket with a
   * `deserializeAttachment` — a structured-clone read — at each one, plus a
   * second read to check the daemon leg was live. On a hub carrying a handful
   * of browsers that is several V8 deserializations per frame, on the single
   * thread every browser on that machine shares, which is a busy `cat` on one
   * device slowing every other device's terminal.
   *
   * Both fields are derived and both are safe to lose: `null`/`undefined` means
   * "not built this wake", and the builders below reconstruct them from the
   * serialized attachments, which stay the record. Nothing is ever *only* in
   * here.
   */
  private clients: Map<number, WebSocket> | null = null
  /** The live daemon socket: `undefined` until resolved this wake, `null` for
   *  a hub with none. See `daemon`. */
  private live: WebSocket | null | undefined

  /**
   * Per-channel traffic that has not been written into an attachment yet, and
   * when each channel was last heard from.
   *
   * The counters used to be summed straight into the attachment and
   * re-serialized on every forwarded frame; they are diagnostics for one log
   * line at close, and a structured-clone write per keystroke and per output
   * chunk is not what they are worth. They are folded into the attachment at
   * two points instead — when the socket retires, and on each alarm sweep —
   * which leaves one residual worth stating: traffic since the last fold is
   * lost if the object hibernates, so a `channel_closed` line can under-report
   * an idle-then-woken socket. The line is for operators reading Workers Logs,
   * not for billing.
   *
   * `heard` is liveness rather than diagnostics — see `deadline`.
   */
  private readonly traffic = new Map<number, Traffic>()
  private readonly heard = new Map<number, number>()

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    // The edge answers keepalives itself, without waking a hibernated object
    // (spec/relay-protocol.md, Keepalive). It also stamps each answer where
    // `getWebSocketAutoResponseTimestamp` can read it, which is what lets the
    // idle sweep in `alarm` tell a quiet browser from an absent one without
    // ever having been woken by either.
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
   *
   * Resolved once per wake and remembered, because this runs on the forwarding
   * path: every client frame asks for it. The attachment stays the record, so a
   * wake re-finds the same socket the flag names; the field is only what keeps
   * the second and later frames from re-reading it.
   */
  private daemon(): WebSocket | undefined {
    if (this.live === undefined) {
      this.live =
        this.ctx
          .getWebSockets('daemon')
          .find((ws) => (ws.deserializeAttachment() as DaemonAttachment | null)?.live === true) ??
        null
    }
    return this.live ?? undefined
  }

  /**
   * The live client sockets by channel, rebuilt from attachments on the first
   * lookup of each wake. Retired sockets are left out: a `done` attachment is a
   * socket whose close frame is still in flight, and nothing may be forwarded
   * to it.
   */
  private clientIndex(): Map<number, WebSocket> {
    if (this.clients !== null) return this.clients
    const index = new Map<number, WebSocket>()
    for (const ws of this.ctx.getWebSockets('client')) {
      const att = ws.deserializeAttachment() as ClientAttachment | null
      if (att && !att.done) index.set(att.channel, ws)
    }
    this.clients = index
    return index
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
    // The attachment is the record and this is the cache of it, written in the
    // same breath so no frame in between resolves the socket this one replaced.
    this.live = pair[1]
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
    // Arm the handshake deadline, unless something sooner is already armed;
    // alarm() re-arms for whoever remains. The comparison is not decoration: the
    // alarm now also carries the idle sweep, whose deadlines are minutes out, so
    // "an alarm is pending" no longer implies "this client will be looked at in
    // time".
    const deadline = Date.now() + this.handshakeTimeout()
    const armed = await this.ctx.storage.getAlarm()
    if (armed === null || armed > deadline) await this.ctx.storage.setAlarm(deadline)
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
    // Into this wake's index beside the attachment, for the same reason the
    // daemon socket is: the frames start immediately and the lookup is on their
    // path. Only when the index has been built — a wake that has not needed it
    // yet builds it complete when it does, and seeding a half-built one would
    // leave every earlier channel out of it.
    this.clients?.set(channel, pair[1])
    try {
      daemon.send(controlFrame({ type: 'open', channel, origin: new URL(req.url).origin }))
    } catch {
      // The leg died between the check at the door and this send. Unwrapped,
      // this threw out of the handler: the browser got a 500 where it asked for
      // a 101, and the socket accepted two lines above stayed attached to a
      // channel the daemon had never heard of until the handshake alarm reaped
      // it 30 s later. Undo the accept instead and answer what a client that
      // arrives with no daemon at all is answered — `notifyDaemon` false,
      // because there is nothing to tell a daemon about a channel it was never
      // told existed.
      this.retireClient(pair[1], false)
      try {
        pair[1].close(1013, 'daemon offline')
      } catch {
        // Already closing.
      }
      return offline()
    }
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
   * the daemon's attention on the request. None of those refusals wears 403:
   * that status is the daemon's verdict on a token, and the browser reads it as
   * the end of the ceremony (see pairRejected, and REFUSED_STATUS in
   * web/src/routes/pair.tsx).
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
    if (claimed !== null && claimed !== origin) return pairRejected()
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
      // The guard stays; only the status is the relay's own. A malformed body
      // is refused by the daemon too, but this one never got there — see
      // pairRejected.
      return pairRejected()
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

  /**
   * The two deadlines a client socket lives under: the handshake deadline for
   * one that never sent, and the idle deadline for one that has stopped. Reap
   * whoever is overdue, fold the rest's counters in, and re-arm for the earliest
   * deadline left.
   *
   * The idle half is the answer to a browser that goes away without a close
   * frame — a laptop that sleeps, a phone that loses its network, a tab killed
   * with the machine. Nothing else notices it. The daemon cannot: it holds a
   * channel on a socket it opened itself, and a write into a channel whose
   * browser is gone succeeds all the way to this object. The edge cannot either,
   * because a socket this hub is *sending* into is not idle — so precisely the
   * expensive ghost, one attached to a session that is producing output, is the
   * one that would never be collected. What the daemon does about it in the
   * meantime is send every chunk of that session's output down the shared relay
   * socket, sealed, to nobody: bandwidth and CPU taken from the browsers that
   * are still there.
   *
   * The evidence a live browser leaves is the keepalive the edge answers for it
   * (spec/relay-protocol.md, Keepalive), stamped per socket where
   * `getWebSocketAutoResponseTimestamp` can read it without this object ever
   * having been woken. So the sweep costs one wake per idle window per hub with
   * clients on it, and a browser that has pinged inside the window is spared
   * having spent nothing.
   *
   * The window is deliberately many keepalives wide (`CLIENT_IDLE_MS`): a
   * background tab's timers are throttled — Chrome clamps them to about once a
   * minute — so a live-but-hidden browser's 30-second ping can arrive at a
   * fraction of its nominal rate, and reaping it would be this hub closing a
   * session somebody is about to come back to.
   */
  async alarm(): Promise<void> {
    const now = Date.now()
    let next: number | null = null
    for (const ws of this.ctx.getWebSockets('client')) {
      const att = ws.deserializeAttachment() as ClientAttachment | null
      if (!att || att.done) continue
      const { at, code, reason } = this.deadline(ws, att)
      if (at <= now) {
        // It was announced open, so the daemon hears closed.
        this.retireClient(ws, true)
        try {
          ws.close(code, reason)
        } catch {
          // Already closing.
        }
        continue
      }
      // The sweep is also where the counters are folded into the attachment, so
      // a socket that hibernates between one sweep and the next carries at most
      // one window's traffic in memory. See `traffic`.
      this.fold(ws, att)
      next = next === null ? at : Math.min(next, at)
    }
    if (next !== null) await this.ctx.storage.setAlarm(next)
  }

  /**
   * When this client socket is next overdue, and what it would be closed for.
   *
   * A socket that has never sent is on the handshake deadline and nothing else:
   * a browser that opened a channel and did not start a handshake is not made
   * live by keepalives, and the deadline is the DoS bound the spec names.
   * Everything after message A is on the idle deadline, measured from the last
   * of three things — a frame this hub read, a keepalive the edge answered, and
   * the moment the socket was accepted. The last two are what survive
   * hibernation; the first is what covers a client whose build predates the
   * keepalive but is plainly talking.
   */
  private deadline(
    ws: WebSocket,
    att: ClientAttachment,
  ): { at: number; code: number; reason: string } {
    if (!att.seen) {
      return { at: att.opened + this.handshakeTimeout(), code: 4001, reason: 'handshake timeout' }
    }
    const pinged = this.ctx.getWebSocketAutoResponseTimestamp(ws)?.getTime() ?? 0
    const spoke = this.heard.get(att.channel) ?? 0
    const last = Math.max(att.opened, pinged, spoke)
    return { at: last + this.idleTimeout(), code: 4002, reason: 'idle' }
  }

  private daemonMessage(ws: WebSocket, buf: ArrayBuffer): void {
    // Only the live daemon may speak; a replaced socket's last words are dropped.
    // By identity against the socket the `live` flag named, which is the same
    // question the flag answers and asks it without a read per frame.
    if (ws !== this.daemon()) return
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
    const t = this.count(frame.channel)
    t.fwdToClient += 1
    t.bytesToClient += frame.payload.byteLength
    try {
      target.send(frame.payload)
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
      this.retireClient(target, false)
      try {
        target.close(1000, 'daemon closed')
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
    // Refused here rather than forwarded, for the reason MAX_CLIENT_MESSAGE
    // gives: one socket dies, the same blast radius the text-frame refusal
    // above has, instead of the whole machine's.
    if (buf.byteLength > MAX_CLIENT_MESSAGE) {
      this.retireClient(ws, true)
      try {
        ws.close(1009, 'message too big')
      } catch {
        // Already closing.
      }
      return
    }
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
    // `seen` is the one field on this path that has to reach the attachment,
    // because the handshake reaper reads it after a wake — and it flips exactly
    // once, so the write costs one frame per socket rather than every frame.
    if (!att.seen) {
      att.seen = true
      ws.serializeAttachment(att)
    }
    this.heard.set(att.channel, Date.now())
    const t = this.count(att.channel)
    t.fwdToDaemon += 1
    t.bytesToDaemon += buf.byteLength
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
    // Everything this channel is remembered by leaves with it: the counters into
    // the line below, the index entry that would otherwise name a closed socket
    // for a channel id that is never reused, and the liveness stamp.
    this.fold(ws, att, { write: false })
    this.clients?.delete(att.channel)
    this.heard.delete(att.channel)
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
    // The cache follows the flag it caches. Cleared rather than re-resolved:
    // whatever is listed now is this socket and any predecessor, none of them
    // live, and a replacement writes the field itself when it lands.
    if (this.live === ws) this.live = null
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

  /** The live client socket carrying this channel. */
  private clientFor(channel: number): WebSocket | undefined {
    return this.clientIndex().get(channel)
  }

  /** This channel's counters that have not reached its attachment yet. */
  private count(channel: number): Traffic {
    let t = this.traffic.get(channel)
    if (t === undefined) {
      t = { fwdToDaemon: 0, fwdToClient: 0, bytesToDaemon: 0, bytesToClient: 0 }
      this.traffic.set(channel, t)
    }
    return t
  }

  /**
   * Fold a channel's counters into its attachment, so what the attachment holds
   * is the total this hub has seen. `write` is false for a caller that is about
   * to serialize the attachment for its own reasons, which is the one place two
   * writes would be one too many.
   */
  private fold(ws: WebSocket, att: ClientAttachment, opts: { write?: boolean } = {}): void {
    const t = this.traffic.get(att.channel)
    if (t === undefined) return
    this.traffic.delete(att.channel)
    att.fwdToDaemon += t.fwdToDaemon
    att.fwdToClient += t.fwdToClient
    att.bytesToDaemon += t.bytesToDaemon
    att.bytesToClient += t.bytesToClient
    if (opts.write !== false) ws.serializeAttachment(att)
  }

  private handshakeTimeout(): number {
    const n = Number(this.env.HANDSHAKE_TIMEOUT_MS ?? HANDSHAKE_TIMEOUT_MS)
    return Number.isFinite(n) && n > 0 ? n : HANDSHAKE_TIMEOUT_MS
  }

  private idleTimeout(): number {
    const n = Number(this.env.CLIENT_IDLE_TIMEOUT_MS ?? CLIENT_IDLE_MS)
    return Number.isFinite(n) && n > 0 ? n : CLIENT_IDLE_MS
  }

  private pairTimeout(): number {
    const n = Number(this.env.PAIR_TIMEOUT_MS ?? PAIR_TIMEOUT_MS)
    return Number.isFinite(n) && n > 0 ? n : PAIR_TIMEOUT_MS
  }
}

/** Concurrent client sockets one hub will hold — the DoS bound on the
 * credential-less leg (spec/relay-protocol.md, Auth). */
const MAX_CLIENTS = 64

/**
 * The largest binary frame a client may send — the per-message DoS bound on the
 * credential-less client leg (spec/relay-protocol.md, Auth).
 *
 * This is where an oversized frame's blast radius is decided, and it has to be
 * decided here. The Durable Object itself accepts up to 32 MiB, and the daemon
 * reads its end with one read limit over the *shared* socket that carries every
 * browser on that machine — coder/websocket enforces `SetReadLimit` by killing
 * the connection, not the message. A single 2.5 MiB frame forwarded from here
 * would therefore drop the daemon leg, 1012 every other browser, and repeat on
 * every redial. Refusing it confines the fault to the one socket that sent it,
 * which is the blast radius the daemon's own WebSocket transport already has.
 *
 * The ordering matters and must not be inverted: 1 MiB here sits **below** the
 * daemon's 2 MiB `readLimit` (internal/transport/relay/relay.go), so a frame an
 * honest Worker forwards — this payload plus the four-byte channel header —
 * can never trip it. Raising this above that limit re-opens the fault.
 */
const MAX_CLIENT_MESSAGE = 1 << 20

/** The handshake deadline when HANDSHAKE_TIMEOUT_MS is unbound (production). */
const HANDSHAKE_TIMEOUT_MS = 30_000

/**
 * How long a client socket may show no sign of life before the hub closes it,
 * when CLIENT_IDLE_TIMEOUT_MS is unbound (production).
 *
 * Five minutes is ten keepalives (web/src/relay/socket.ts pings every 30 s), and
 * the width is the whole design of the number. A hidden tab's timers are
 * throttled — about once a minute in Chrome, less predictably elsewhere — and a
 * sleeping laptop's do not run at all until it wakes, so the window has to
 * tolerate a live browser pinging at a small fraction of its nominal rate. What
 * it bounds is the other case: a browser that is *gone*, whose channel would
 * otherwise be held open for as long as the daemon keeps writing into it.
 */
const CLIENT_IDLE_MS = 300_000

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

/** What a daemon socket remembers across hibernation. */
interface DaemonAttachment {
  /** False once replaced. `getWebSockets` can still list the dying socket, so
   * this flag — not list position — names the daemon frames go to. */
  live: boolean
}

/**
 * One channel's forwarded frames and bytes as this instance has counted them
 * since the last fold into the attachment. In memory only; see `traffic`.
 */
interface Traffic {
  fwdToDaemon: number
  fwdToClient: number
  bytesToDaemon: number
  bytesToClient: number
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

/** WebSocket endpoints answer plain HTTP with 426, upgrade required. */
function refuseNonUpgrade(req: Request): Response | null {
  if (req.headers.get('Upgrade')?.toLowerCase() === 'websocket') return null
  return new Response('expected a WebSocket upgrade', { status: 426 })
}

function offline(): Response {
  return new Response('{"error":"daemon offline"}', { status: 503, headers: JSON_NO_STORE })
}

/**
 * A pairing attempt the relay rejected on its own, before the daemon heard of
 * it. One status and one body whatever the reason, the same uniformity the
 * daemon's own refusePair keeps and for the same reason: an endpoint reachable
 * without a session token must not be an oracle for anything.
 *
 * 400 and deliberately **not** 403. 403 on this endpoint means the daemon's
 * pairing handler ran — over this leg it can only arrive in a `pairResult`,
 * since `PairDevice` and the daemon's own relay adapter answer 200 or 403 and
 * nothing else (internal/daemon/pairing.go). The browser reads it as exactly
 * that and stops offering Pair, because a token the daemon looked at is a token
 * the ceremony is over for (web/src/routes/pair.tsx, REFUSED_STATUS). Neither
 * refusal here presented a token to anything — a phone on a bad connection can
 * truncate a POST carrying a perfectly live token into a body that will not
 * parse — so wearing the daemon's status would throw away a window that is
 * still open. 400 is free to say so: the daemon never answers a pairing with
 * one, on either transport.
 *
 * The body is not `pairing refused` for the same reason. That phrase is the
 * daemon's verdict, in the exact bytes it writes, and a page that quoted it
 * back would be telling the user the daemon rejected them when the daemon was
 * never asked.
 */
function pairRejected(): Response {
  return new Response('{"error":"pairing request rejected"}', {
    status: 400,
    headers: JSON_NO_STORE,
  })
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
