/*
 * The browser's transport when the page came from a relay rather than the
 * daemon itself.
 *
 * It is a `SocketLike` and nothing more: FlueClient is handed one of these
 * instead of a WebSocket wrapper and never learns that anything changed. What
 * sits between the two is the whole point —
 *
 *   wss://<origin>/client        bare payloads; the Worker adds the channel
 *                                header on the daemon's side, so nothing here
 *                                ever writes one
 *   Noise IK, browser initiator  pinning the daemon's static key, which is the
 *                                entire basis of trusting the far end
 *   [1 byte kind][wire bytes]    the text/binary distinction the WebSocket used
 *                                to carry for free (./frame)
 *
 * `onopen` fires only after the handshake completes, so FlueClient's "open"
 * means end-to-end established rather than "a socket reached the relay". Every
 * failure — a daemon that cannot prove it holds the pinned key, a frame that
 * does not decrypt, a text frame that is not a keepalive — is surfaced as an
 * ordinary `onclose`, because that is the one thing FlueClient already knows
 * how to recover from. Telling the user they are not paired is the shell's
 * job, not this file's.
 *
 * See spec/relay-protocol.md, the browser leg.
 */
import type { SocketLike } from '@/client/client'
import type { DeviceKey } from '@/crypto/keys'
import { initiatorHandshake, type NoiseChannel } from '@/crypto/noise'
import { decodePlain, encodePlain } from './frame'

/**
 * The keepalive pair. Either leg may send the ping; the Cloudflare edge answers
 * it from the Durable Object's auto-response without waking the object, which
 * is what buys an idle terminal a sleeping, almost-free hub. A pong is dropped
 * silently, and it is the only text frame this socket tolerates.
 */
export const RELAY_PING = 'flue-ping'
export const RELAY_PONG = 'flue-pong'

/** How often the ping goes out. Well inside Cloudflare's idle timeouts, and
 *  cheap: the object stays asleep through every one of them. */
const KEEPALIVE_MS = 30_000

/**
 * How many silent intervals mean this socket is open on one end only.
 *
 * The same number, for the same reason, as `staleFactor` in
 * internal/transport/relay/relay.go. Sending a ping nothing has to answer buys
 * nothing: the edge answers every `flue-ping` immediately and without waking
 * the Durable Object, so three intervals of total silence is not a busy relay,
 * it is a socket whose far end stopped existing — a NAT mapping a sleeping
 * phone lost, an edge that blackholed the connection. Nothing else would
 * notice. A browser reads from an event handler that simply never fires again,
 * so the tab sits at `open` in front of a dead terminal until the user reloads.
 */
const STALE_INTERVALS = 3

/**
 * The subprotocol the relay answers a browser with, and the one the credential
 * hides beside it.
 *
 * A browser cannot set a header on a WebSocket upgrade. It can name
 * subprotocols — the second argument to `new WebSocket(url, protocols)` — and
 * those travel as `Sec-WebSocket-Protocol`, which is a header, which is how a
 * channel token reaches the relay without being in the URL. In the URL it
 * would be in the request line and therefore in the Worker's logs.
 *
 * Two values go out: `flue.v1`, which the relay echoes on the 101 (a browser
 * that offered subprotocols and is answered without one fails the connection
 * itself), and `flue.token.<token>`, which it never echoes. Spelled out here
 * rather than imported because the relay is another package in another
 * runtime; spec/relay-protocol.md is where the two agree.
 */
export const RELAY_SUBPROTOCOL = 'flue.v1'
export const RELAY_TOKEN_SUBPROTOCOL_PREFIX = 'flue.token.'

export interface RelayIdentity {
  /** This browser's static Noise key, from `@/crypto/keys`. */
  deviceKey: DeviceKey
  /**
   * The daemon's static public key.
   *
   * Pinned at pairing time on a self-hosted relay, and handed over with the
   * session on a hosted one — where it is per *device*, because one origin
   * fronts every machine on every account (see ./session).
   */
  daemonPub: Uint8Array
  /**
   * How this dial gets its channel token, or null on a self-hosted relay,
   * which authorizes no browser at all — and where offering a subprotocol
   * nobody will echo would break the connection rather than secure it.
   *
   * A function, not a string, and that is the whole fix for the second half of
   * the SaaS bug. A token lives sixty seconds; a captured one covers the first
   * dial and nothing after it, so the first reconnect past a minute was refused
   * and the tab reconnected into the identical refusal forever. Asking per dial
   * is what makes a reconnect an hour later work — and it is also where
   * revocation lands, since a machine that has been switched off stops being
   * given tokens (app/src/server/refresh-token.ts).
   *
   * A rejection is an ordinary close: the socket never opens, FlueClient backs
   * off, and the next attempt asks again. That is right for every reason the
   * call can fail — an expired session, a revoked machine, a network that is
   * simply down — and telling them apart here would only move the decision.
   *
   * Required rather than optional, and explicitly null: a call site that forgot
   * the field would compile clean and dial a hosted relay with no credential,
   * which presents as a silent 401 reconnect loop. Making the caller write
   * `null` makes the caller decide.
   */
  token: (() => Promise<string>) | null
}

/** The subset of WebSocket this socket drives, so tests can substitute one. */
export interface RawSocket {
  send(data: string | ArrayBuffer | Uint8Array): void
  close(): void
  onopen: (() => void) | null
  onclose: (() => void) | null
  onmessage: ((data: string | ArrayBuffer) => void) | null
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/**
 * A SocketLike that reaches the daemon through the relay at `origin` — the
 * origin serving the page, in production.
 */
export function relaySocket(
  origin: string,
  identity: RelayIdentity,
  wsFactory: (url: string, protocols?: string[]) => RawSocket = browserSocket,
): SocketLike {
  const hs = initiatorHandshake(identity.deviceKey.privateKey, identity.daemonPub)

  /**
   * Null until the transport exists.
   *
   * Which is immediately on a self-hosted relay, and one microtask later on a
   * hosted one, because that dial has to fetch a token first (see
   * `identity.token`). Nothing else in this file may assume it is there: a
   * consumer can `close()` inside the same tick it asked for the socket, and a
   * React effect cleanup does exactly that.
   */
  let ws: RawSocket | null = null
  /** Null until message B verifies; that is also what `onopen` waits for. */
  let channel: NoiseChannel | null = null
  let ping: ReturnType<typeof setInterval> | null = null
  /** When something last arrived on this socket — a pong counts, which is the
   *  point of sending the ping. Read by the keepalive, never by anything else. */
  let lastRead = Date.now()
  /** Set once the close has been reported. Nothing is delivered after it: a
   *  socket the consumer has been told is over must stay over. */
  let dead = false

  const wrapper: SocketLike = {
    send(data) {
      // FlueClient sends nothing before `onopen`, so reaching this without a
      // channel is a bug in the caller — surfaced, not swallowed into a frame
      // that silently never left.
      if (!channel || !ws) {
        throw new Error('relay socket: send before the Noise handshake completed')
      }
      const plain =
        typeof data === 'string'
          ? encodePlain(true, encoder.encode(data))
          : encodePlain(false, new Uint8Array(data))
      ws.send(channel.seal(plain))
    },
    close() {
      shutdown()
    },
    onopen: null,
    onclose: null,
    onmessage: null,
  }

  const stopPing = () => {
    if (ping === null) return
    clearInterval(ping)
    ping = null
  }

  /**
   * End this socket and report it, at most once.
   *
   * The report does not wait for the transport's own close event. A real
   * WebSocket always follows `close()` with one, but a channel we have given up
   * on is over whether or not the layer below agrees, and a consumer left
   * waiting for an event that never came would sit at `reconnecting` with no
   * socket and no retry armed.
   */
  const shutdown = () => {
    stopPing()
    // `dead` before the close, so a `close()` that lands while the token is
    // still in flight stops `dial` from opening a socket nobody is behind.
    ws?.close()
    if (dead) return
    dead = true
    wrapper.onclose?.()
  }

  /**
   * Open the transport with the credential this dial is to present, and wire
   * every handler onto it.
   *
   * Called once per `relaySocket`, either synchronously or after the token
   * resolves. It is never called after `shutdown` — the guard is the first
   * line, because a consumer that gave up while the fetch was in flight would
   * otherwise get a live socket it has already been told is closed.
   */
  const dial = (token: string | null) => {
    if (dead) return
    const sock = wsFactory(clientUrl(origin), subprotocols(token))
    ws = sock

    sock.onopen = () => {
      // A socket this wrapper has already given up on. A real WebSocket does
      // not fire `open` after `close()`, but this is an interface and the
      // consequence of being wrong is a 30-second interval armed on a dead
      // socket for the life of the tab — `stopPing` has already run by then.
      if (dead) return
      // The transport is up; the channel is not. Message A goes out now and
      // `onopen` waits for the answer.
      try {
        sock.send(hs.messageA())
      } catch {
        shutdown()
        return
      }
      // Armed on the transport rather than on the channel: the ping is a
      // transport-level text frame the edge answers, and a handshake that
      // stalls is reaped by the Durable Object's own deadline, not by silence
      // here.
      lastRead = Date.now()
      ping = setInterval(() => {
        // The ping is also the check. Reported as an ordinary close, because
        // that is the one thing FlueClient already knows how to recover from:
        // its reconnect is what actually brings the terminal back.
        if (Date.now() - lastRead > STALE_INTERVALS * KEEPALIVE_MS) {
          shutdown()
          return
        }
        sock.send(RELAY_PING)
      }, KEEPALIVE_MS)
    }

    sock.onclose = () => {
      stopPing()
      if (dead) return
      dead = true
      wrapper.onclose?.()
    }

    sock.onmessage = (data) => {
      if (dead) return
      // Before the pong is dropped, not after: a pong carries nothing except
      // the fact that this socket still has two ends, and that fact is the
      // whole reason the ping was sent.
      lastRead = Date.now()

      if (typeof data === 'string') {
        if (data === RELAY_PONG) return
        // Everything else on this socket is binary. A peer sending text is not
        // speaking this protocol (spec/relay-protocol.md, the browser leg), and
        // a base64'd ciphertext read as one would be worse than a dead channel.
        shutdown()
        return
      }

      if (!channel) {
        try {
          channel = hs.readMessageB(new Uint8Array(data))
        } catch {
          // The daemon could not prove it holds the pinned static key, or the
          // message was corrupted on the way. Either way this socket carries no
          // channel and never will: IK spends the initiator's ephemeral on
          // message A, so there is nothing to retry here — only a new socket.
          shutdown()
          return
        }
        wrapper.onopen?.()
        return
      }

      let frame: { text: boolean; data: Uint8Array }
      try {
        frame = decodePlain(channel.open(new Uint8Array(data)))
      } catch {
        // A frame that will not decrypt, or one that decrypts to something that
        // is not a plain frame. Both mean the stream is out of step with the
        // daemon's — a nonce cannot be re-tried, and a peer speaking garbage
        // will keep speaking it — so the channel is dead and FlueClient's
        // reconnect takes it from here.
        shutdown()
        return
      }

      if (frame.text) {
        wrapper.onmessage?.(decoder.decode(frame.data))
        return
      }
      // Copied out of the decrypted buffer, because `frame.data` is a view over
      // it and FlueClient hands terminal output on to consumers that keep it.
      const out = new ArrayBuffer(frame.data.byteLength)
      new Uint8Array(out).set(frame.data)
      wrapper.onmessage?.(out)
    }
  }

  // Self-host dials in this tick, exactly as it always did: there is no
  // credential to fetch, and a socket that only appeared a microtask later
  // would be a behaviour change for a deployment this task must not touch.
  if (identity.token === null) {
    dial(null)
  } else {
    // `.then(dial).catch(...)`, never `.then(dial, onRejected)`: the two-arm
    // form does not catch a throw from `dial` itself, and `wsFactory` can throw
    // — `new WebSocket` raises SyntaxError for a subprotocol value that is not
    // a token. That would be an unhandled rejection with no `onclose` behind
    // it, which is the one failure FlueClient cannot recover from: it parks at
    // `reconnecting` with no socket and no retry armed, for the life of the tab.
    identity
      .token()
      .then(dial)
      .catch(() => {
        // No token, no dial. Reported as an ordinary close rather than a
        // special state, because that is what FlueClient recovers from — and
        // its next attempt asks for a token again, which is how a tab whose
        // session outlived a control-plane blip comes back on its own.
        shutdown()
      })
  }

  return wrapper
}

/**
 * The relay's client endpoint on an origin: `wss` for an https origin, `ws` for
 * an http one, which is what a local `wrangler dev` serves.
 */
function clientUrl(origin: string): string {
  const url = new URL('/client', origin)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  return url.toString()
}

/**
 * What to offer as `Sec-WebSocket-Protocol`, or nothing.
 *
 * Nothing, and not `['flue.v1']`, when this browser holds no token: a
 * self-hosted relay (Plan 1) echoes no subprotocol, and by RFC 6455 §4.1 a
 * client that offered one and was answered without it must fail the
 * connection. Offering unconditionally would break every self-hosted deployment
 * to no purpose.
 */
function subprotocols(token: string | null): string[] | undefined {
  if (!token) return undefined
  return [RELAY_SUBPROTOCOL, `${RELAY_TOKEN_SUBPROTOCOL_PREFIX}${token}`]
}

/** The default transport: a real WebSocket, in the shape this file drives. */
function browserSocket(url: string, protocols?: string[]): RawSocket {
  const ws = protocols ? new WebSocket(url, protocols) : new WebSocket(url)
  ws.binaryType = 'arraybuffer'
  const raw: RawSocket = {
    send: (d) => ws.send(d),
    close: () => ws.close(),
    onopen: null,
    onclose: null,
    onmessage: null,
  }
  ws.onopen = () => raw.onopen?.()
  // No error handler, for the reason FlueClient's own factory gives: an error
  // is always followed by a close, and the close path already does everything
  // there is to do.
  ws.onclose = () => raw.onclose?.()
  ws.onmessage = (e: MessageEvent<string | ArrayBuffer>) => raw.onmessage?.(e.data)
  return raw
}
