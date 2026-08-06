import { DurableObject } from 'cloudflare:workers'
import type { Env } from './index'

/**
 * DaemonHub bridges one daemon socket to any number of client sockets with the
 * framing in spec/relay-protocol.md. This is the skeleton: it accepts sockets
 * through the hibernation API and enforces who may hold which leg; the actual
 * forwarding (channel assignment, control channel 0, /api/pair relay) lands in
 * the next task.
 *
 * Hibernation rules this class lives by: sockets are accepted with
 * `ctx.acceptWebSocket` — never `ws.accept()`, which pins the object in
 * memory — no pending `setTimeout`/`setInterval` (DO alarms when the time
 * comes), and no outbound sockets from the DO.
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

  /** The live daemon socket, if one is attached. */
  private daemon(): WebSocket | undefined {
    return this.ctx.getWebSockets('daemon')[0]
  }

  private acceptDaemon(req: Request): Response {
    const refusal = refuseNonUpgrade(req)
    if (refusal) return refusal
    // One daemon per hub. The newcomer wins — a daemon that reconnects after
    // a network flap must not find its half-dead predecessor squatting on the
    // leg — and the old socket is told why.
    for (const old of this.ctx.getWebSockets('daemon')) {
      try {
        old.close(4000, 'replaced')
      } catch {
        // Already closing; nothing left to tell it.
      }
    }
    const pair = new WebSocketPair()
    this.ctx.acceptWebSocket(pair[1], ['daemon'])
    return new Response(null, { status: 101, webSocket: pair[0] })
  }

  private acceptClient(req: Request): Response {
    const refusal = refuseNonUpgrade(req)
    if (refusal) return refusal
    // A client without a daemon has nothing to talk to, and accepting it would
    // only manufacture a dead socket to close: refuse at the door instead.
    if (!this.daemon()) return offline()
    const pair = new WebSocketPair()
    this.ctx.acceptWebSocket(pair[1], ['client'])
    return new Response(null, { status: 101, webSocket: pair[0] })
  }

  private pair(_req: Request): Response {
    if (!this.daemon()) return offline()
    // Task 5 relays the body to the daemon on control channel 0 and writes the
    // pairResult back here.
    return new Response(JSON.stringify({ error: 'pairing not implemented' }), {
      status: 501,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  async webSocketMessage(_ws: WebSocket, _message: string | ArrayBuffer): Promise<void> {
    // Task 5: channel framing between the legs.
  }

  async webSocketClose(_ws: WebSocket, _code: number, _reason: string, _wasClean: boolean): Promise<void> {
    // Task 5: control `closed` for a client, 1012 "daemon gone" fan-out for
    // the daemon.
  }
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
