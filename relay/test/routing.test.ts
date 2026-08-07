import { SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'

import { authorizeDaemon, machineIdFrom, type Env } from '../src/index'
import { controlFrame, decoder, Leg } from './harness'

const BASE = 'https://relay.example'

/** The two machines this suite talks about: alpha gets a daemon, beta never does. */
const ALPHA = 'alpha-1a2b'
const BETA = 'beta-9f8e'

function open(path: string, headers: Record<string, string> = {}): Promise<Response> {
  return SELF.fetch(`${BASE}${path}`, { headers: { Upgrade: 'websocket', ...headers } })
}

function openDaemon(machine = ALPHA): Promise<Response> {
  return open(`/daemon/${machine}`, { Authorization: 'Bearer test-secret' })
}

/** Resolves with the next event of the given type on an accepted socket. */
function once<T>(ws: WebSocket, type: keyof WebSocketEventMap): Promise<T> {
  return new Promise((resolve) => {
    ws.addEventListener(type, (e) => resolve(e as T), { once: true })
  })
}

/** The daemon leg as a harness Leg, dialed through the Worker rather than a stub. */
async function daemonLeg(machine: string): Promise<Leg> {
  const res = await openDaemon(machine)
  expect(res.status).toBe(101)
  const ws = res.webSocket!
  // The pool's test-side socket defaults to delivering binary as Blob; ask for
  // ArrayBuffer so frames can be decoded synchronously.
  ;(ws as unknown as { binaryType: string }).binaryType = 'arraybuffer'
  ws.accept()
  return new Leg(ws)
}

describe('machineIdFrom', () => {
  it('reads the id out of <prefix>/<id>', () => {
    expect(machineIdFrom('/daemon/alpha-1a2b', '/daemon')).toBe('alpha-1a2b')
    expect(machineIdFrom('/api/pair/x0', '/api/pair')).toBe('x0')
  })

  it('refuses the bare prefix and the empty id', () => {
    expect(machineIdFrom('/daemon', '/daemon')).toBeNull()
    expect(machineIdFrom('/daemon/', '/daemon')).toBeNull()
  })

  it('refuses uppercase — ids are minted lowercase, never case-folded here', () => {
    expect(machineIdFrom('/daemon/ALPHA-1A2B', '/daemon')).toBeNull()
  })

  it('takes 63 characters and refuses 65: the hostname bound', () => {
    expect(machineIdFrom(`/daemon/${'a'.repeat(63)}`, '/daemon')).toBe('a'.repeat(63))
    expect(machineIdFrom(`/daemon/${'a'.repeat(65)}`, '/daemon')).toBeNull()
  })

  it('refuses a trailing slash', () => {
    expect(machineIdFrom('/daemon/alpha-1a2b/', '/daemon')).toBeNull()
  })

  it('refuses an embedded slash: one segment, not a subtree', () => {
    expect(machineIdFrom('/daemon/a/b', '/daemon')).toBeNull()
  })
})

describe('the relay Worker routes by machine id', () => {
  it('404s /daemon with no id: no such machine, never an asset', async () => {
    const res = await open('/daemon')
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'no such machine' })
  })

  it('404s an id the grammar refuses: /daemon/UPPER', async () => {
    const res = await open('/daemon/UPPER')
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'no such machine' })
  })

  it('404s a path with an embedded slash: /daemon/a/b', async () => {
    const res = await open('/daemon/a/b')
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'no such machine' })
  })

  it('404s /client with no id', async () => {
    const res = await open('/client')
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'no such machine' })
  })

  it('404s POST /api/pair with no id: the id-less route did not survive', async () => {
    const res = await SELF.fetch(`${BASE}/api/pair`, { method: 'POST', body: '{}' })
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'no such machine' })
  })

  it('refuses /daemon/<id> without the bearer secret: 401', async () => {
    const res = await open(`/daemon/${ALPHA}`)
    expect(res.status).toBe(401)
  })

  it('refuses /daemon/<id> with the wrong bearer secret: 401', async () => {
    const res = await open(`/daemon/${ALPHA}`, { Authorization: 'Bearer wrong-secret' })
    expect(res.status).toBe(401)
  })

  it('refuses an authorized /daemon/<id> request that is not an upgrade: 426', async () => {
    const res = await SELF.fetch(`${BASE}/daemon/${ALPHA}`, {
      headers: { Authorization: 'Bearer test-secret' },
    })
    expect(res.status).toBe(426)
  })

  it('answers a client whose machine has no daemon from that hub: 503 offline', async () => {
    // The 503 is the hub's own refusal (src/hub.ts, offline), so the id
    // picked an object and the object ran. An asset answer would be a 200.
    const res = await open('/client/lonely-0a0a')
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ error: 'daemon offline' })
  })

  it('parks no pairing for a machine with no daemon: 503 offline', async () => {
    const res = await SELF.fetch(`${BASE}/api/pair/lonely-0b0b`, { method: 'POST', body: '{}' })
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ error: 'daemon offline' })
  })

  it('upgrades an authorized daemon on /daemon/<id>: 101', async () => {
    const res = await openDaemon()
    expect(res.status).toBe(101)
    expect(res.webSocket).not.toBeNull()
    res.webSocket!.accept()
    res.webSocket!.close()
  })

  it('answers flue-ping with flue-pong from the auto-response, without the DO', async () => {
    const res = await openDaemon()
    const ws = res.webSocket!
    ws.accept()
    const pong = once<MessageEvent>(ws, 'message')
    ws.send('flue-ping')
    expect((await pong).data).toBe('flue-pong')
    ws.close()
  })

  it('closes a replaced daemon socket with 4000 "replaced"', async () => {
    const first = (await openDaemon()).webSocket!
    first.accept()
    const closed = once<CloseEvent>(first, 'close')
    const second = (await openDaemon()).webSocket!
    second.accept()
    const e = await closed
    expect(e.code).toBe(4000)
    expect(e.reason).toBe('replaced')
    second.close()
  })

  it("upgrades /client/<id> while that machine's daemon is connected: 101", async () => {
    const daemon = (await openDaemon(ALPHA)).webSocket!
    daemon.accept()
    const res = await open(`/client/${ALPHA}`)
    expect(res.status).toBe(101)
    expect(res.webSocket).not.toBeNull()
    res.webSocket!.accept()
    res.webSocket!.close()
    daemon.close()
  })

  it("isolates machines: a client for beta never reaches alpha's daemon", async () => {
    // Alpha has a live daemon; beta has never seen one. If the id in the path
    // did not pick the hub — every machine on one object, as before — this
    // dial would ride alpha's daemon to a 101. The offline answer is the
    // proof it landed on beta's own, empty hub.
    const daemon = (await openDaemon(ALPHA)).webSocket!
    daemon.accept()
    const res = await open(`/client/${BETA}`)
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ error: 'daemon offline' })
    daemon.close()
  })

  it('carries a pairing body byte for byte through the Worker to the daemon', async () => {
    // The stub suites prove the hub forwards these bytes unreshaped
    // (pair.test.ts) — but they dial the object directly. This is the same
    // claim made of the Worker path: the re-wrap in toHub (a new Request on
    // the bare prefix) must hand the hub the exact body that was POSTed.
    // Key order, inner whitespace and characters a re-encoder would escape.
    const daemon = await daemonLeg('pairful-3c4d')
    const body = '{"z":  1,\n  "a": "<&>é", "token":"t"}'
    const res = SELF.fetch(`${BASE}/api/pair/pairful-3c4d`, { method: 'POST', body })
    const payload = await daemon.nextControlBytes()
    expect(decoder.decode(payload)).toBe(`{"type":"pair","id":1,"origin":"${BASE}","body":${body}}`)
    daemon.ws.send(controlFrame({ type: 'pairResult', id: 1, status: 200, body: { ok: true } }))
    const got = await res
    expect(got.status).toBe(200)
    expect(await got.json()).toEqual({ ok: true })
    daemon.ws.close()
  })

  it('serves the asset placeholder for unknown paths', async () => {
    const res = await SELF.fetch(`${BASE}/some/unknown/path`)
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toContain('text/html')
    expect(await res.text()).toContain('flue relay')
  })

  it('answers GET /api/health with 200 ok, from the Worker alone', async () => {
    // Liveness of the Worker, nothing else: no machine id, no Durable Object
    // woken, nothing about any daemon. An uptime monitor pointed here costs
    // hibernation nothing and learns nothing a public URL does not already
    // say. Per-machine liveness is deliberately NOT here — that is the
    // presence oracle RELAY.md documents, and adding it to an endpoint
    // monitors poll would turn an accepted observation into an advertised API.
    const res = await SELF.fetch(`${BASE}/api/health`)
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toContain('application/json')
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    expect(await res.json()).toEqual({ ok: true })
  })

})

/**
 * The relay serves the same bundle the daemon does, from an origin that is
 * reachable from the internet rather than from loopback, and for a while it
 * served it with none of the daemon's security headers — including the
 * `script-src 'self'` that web/src/crypto/keys.ts names as its reason for
 * being willing to keep a raw private key in IndexedDB.
 *
 * The policy is a `_headers` document, which is configuration rather than an
 * asset: public/_headers is what `wrangler dev` and this suite read, and
 * `flue relay setup` sends the identical string in the script metadata
 * (cmd/flue/relay.go, checked byte for byte by
 * TestRelayAssetHeadersMatchTheWranglerCopy). The literal below is spelled out
 * rather than imported so that a change to it has to be made twice, in two
 * languages, on purpose.
 *
 * `connect-src` is the directive that says where this bundle may speak, and
 * on a relay origin it reads `'self'` and grants nothing more — which is
 * exactly true of the app: the one connection a relay-served tab opens is the
 * same-origin `wss://` to its own Worker, which `'self'` covers on an https
 * origin (internal/daemon/server.go, RelayCSP; the daemon's loopback build is
 * the one that needs more). Never `https:` or a wildcard: this directive is
 * the outer bound on where an injected script could send what it read, and a
 * bound that names everywhere is not one.
 */
describe('the security headers on served assets', () => {
  const CSP =
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data:; connect-src 'self'; " +
    "object-src 'none'; base-uri 'none'; frame-ancestors 'none'"

  it('serves the app shell under the same CSP the daemon does, minus the loopback sockets', async () => {
    const res = await SELF.fetch(`${BASE}/`)
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Security-Policy')).toBe(CSP)
    expect(res.headers.get('Referrer-Policy')).toBe('no-referrer')
  })

  it('covers the SPA fallback the Worker itself reaches for', async () => {
    // /api/* is run-worker-first, so a GET lands in the Worker and falls
    // through to env.ASSETS.fetch — a different path to the same bytes, and
    // the one a `_headers` file would miss if the binding did not apply it.
    // Not /api/pair: that prefix now belongs to the machine router, which
    // answers its id-less form with a 404 rather than an asset.
    const res = await SELF.fetch(`${BASE}/api/anything-else`)
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Security-Policy')).toBe(CSP)
  })

  it('grants the network to the origin itself, and to nothing else', async () => {
    // Both halves matter. `'self'` is what lets the tab dial its own
    // same-origin wss:// socket; anything wider stops the directive being a
    // bound at all, and hands whatever got injected somewhere to send what
    // it stole.
    const res = await SELF.fetch(`${BASE}/`)
    const connect = res.headers
      .get('Content-Security-Policy')!
      .split('; ')
      .find((d) => d.startsWith('connect-src '))
    expect(connect).toBe("connect-src 'self'")
  })

  it('does not publish the header document as an asset', async () => {
    const res = await SELF.fetch(`${BASE}/_headers`)
    expect(await res.text()).not.toContain('Content-Security-Policy')
  })
})

describe('authorizeDaemon', () => {
  // The SELF worker always has DAEMON_SECRET bound (vitest.config.ts), so the
  // unbound-secret case is a direct unit test: with no secret in the env,
  // `Bearer ${undefined}` must not become an accepted credential.
  it('fails closed when DAEMON_SECRET is not bound: Bearer "undefined" is refused', () => {
    const req = new Request(`${BASE}/daemon/${ALPHA}`, {
      headers: { Authorization: 'Bearer undefined', Upgrade: 'websocket' },
    })
    expect(authorizeDaemon(req, {} as Env)).toBe(false)
  })

  it('fails closed on an empty-string secret: "Bearer " is refused', () => {
    const req = new Request(`${BASE}/daemon/${ALPHA}`, {
      headers: { Authorization: 'Bearer ', Upgrade: 'websocket' },
    })
    expect(authorizeDaemon(req, { DAEMON_SECRET: '' } as Env)).toBe(false)
  })
})
