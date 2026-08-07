import { SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'

import { authorizeDaemon, machineIdFrom, type Env } from '../src/index'

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

  it('serves the asset placeholder for unknown paths', async () => {
    const res = await SELF.fetch(`${BASE}/some/unknown/path`)
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toContain('text/html')
    expect(await res.text()).toContain('flue relay')
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
 * `connect-src` is the directive with the interesting history. It read
 * `'self'` alone, and `'self'` does not cover the one cross-origin request the
 * bundle makes: a channel token lives sixty seconds, so every reconnect past
 * the first minute POSTs to the control plane at `app.flue.sh` from a document
 * on the relay origin. The browser refused it before the network, the dial had
 * no token, and every hosted session died at its first reconnect past a minute
 * and retried into the identical silence. Named exactly, and never as `https:`
 * or a wildcard: this is the outer bound on where a tab's session cookie can
 * be sent, and the fragment's `a=` is pinned same-site against the same threat
 * (web/src/relay/session.ts).
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

  it('lets the token refresh through to the control plane, and to nothing else', async () => {
    // Both halves matter. Without the origin every hosted session dies at its
    // first reconnect past a minute; with a wildcard the directive stops being
    // a bound at all, and a crafted `#a=` in the fragment would have somewhere
    // to send a POST that carries this account's session cookie.
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
