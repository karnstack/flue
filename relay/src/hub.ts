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
 * memory — no pending `setTimeout`/`setInterval` (the handshake deadline is a
 * DO alarm), and no outbound sockets from the DO. Everything a handler needs
 * about a socket lives in its serialized attachment, because in-memory state
 * does not survive a hibernation wake.
 */
export class DaemonHub extends DurableObject<Env> {
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
      return new Response('{"error":"relay full"}', {
        status: 503,
        headers: { 'Content-Type': 'application/json' },
      })
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

  private pair(_req: Request): Response {
    if (!this.daemon()) return offline()
    // Task 6 relays the body to the daemon on control channel 0 and writes the
    // pairResult back here.
    return new Response(JSON.stringify({ error: 'pairing not implemented' }), {
      status: 501,
      headers: { 'Content-Type': 'application/json' },
    })
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
    let msg: { type?: string; channel?: number }
    try {
      msg = JSON.parse(decoder.decode(payload)) as { type?: string; channel?: number }
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
    // pairResult resolves the pending /api/pair (Task 6). Anything else is
    // dropped — an unknown type here means the peers disagree about the
    // protocol, and one deaf frame is cheaper than tearing the hub down.
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
}

/** Concurrent client sockets one hub will hold — the DoS bound on the
 * credential-less leg (spec/relay-protocol.md, Auth). */
const MAX_CLIENTS = 64

/** The handshake deadline when HANDSHAKE_TIMEOUT_MS is unbound (production). */
const HANDSHAKE_TIMEOUT_MS = 30_000

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

/** relay → daemon control messages (spec/relay-protocol.md, channel 0). */
type ControlToDaemon =
  | { type: 'open'; channel: number; origin: string }
  | { type: 'closed'; channel: number }

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/** Lays a control message out as a channel-0 frame. */
function controlFrame(msg: ControlToDaemon): ArrayBuffer {
  return encodeFrame(0, encoder.encode(JSON.stringify(msg)))
}

/** WebSocket endpoints answer plain HTTP with 426, upgrade required. */
function refuseNonUpgrade(req: Request): Response | null {
  if (req.headers.get('Upgrade')?.toLowerCase() === 'websocket') return null
  return new Response('expected a WebSocket upgrade', { status: 426 })
}

function offline(): Response {
  return new Response('{"error":"daemon offline"}', {
    status: 503,
    headers: { 'Content-Type': 'application/json' },
  })
}
