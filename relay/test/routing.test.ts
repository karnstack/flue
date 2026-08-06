import { SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'

import { authorizeDaemon, type Env } from '../src/index'

const BASE = 'https://relay.example'

function open(path: string, headers: Record<string, string> = {}): Promise<Response> {
  return SELF.fetch(`${BASE}${path}`, { headers: { Upgrade: 'websocket', ...headers } })
}

function openDaemon(): Promise<Response> {
  return open('/daemon', { Authorization: 'Bearer test-secret' })
}

/** Resolves with the next event of the given type on an accepted socket. */
function once<T>(ws: WebSocket, type: keyof WebSocketEventMap): Promise<T> {
  return new Promise((resolve) => {
    ws.addEventListener(type, (e) => resolve(e as T), { once: true })
  })
}

describe('the relay Worker routes', () => {
  // This test must run before any daemon has connected: the shared hub keeps
  // its accepted sockets for the life of the test worker.
  it('refuses /client when no daemon is connected: 503 daemon offline', async () => {
    const res = await open('/client')
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ error: 'daemon offline' })
  })

  it('refuses POST /api/pair when no daemon is connected: 503 daemon offline', async () => {
    const res = await SELF.fetch(`${BASE}/api/pair`, { method: 'POST', body: '{}' })
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ error: 'daemon offline' })
  })

  it('refuses /daemon without the bearer secret: 401', async () => {
    const res = await open('/daemon')
    expect(res.status).toBe(401)
  })

  it('refuses /daemon with the wrong bearer secret: 401', async () => {
    const res = await open('/daemon', { Authorization: 'Bearer wrong-secret' })
    expect(res.status).toBe(401)
  })

  it('refuses an authorized /daemon request that is not an upgrade: 426', async () => {
    const res = await SELF.fetch(`${BASE}/daemon`, {
      headers: { Authorization: 'Bearer test-secret' },
    })
    expect(res.status).toBe(426)
  })

  it('upgrades an authorized /daemon request: 101', async () => {
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

  it('upgrades /client while a daemon is connected: 101', async () => {
    const daemon = (await openDaemon()).webSocket!
    daemon.accept()
    const res = await open('/client')
    expect(res.status).toBe(101)
    expect(res.webSocket).not.toBeNull()
    res.webSocket!.accept()
    res.webSocket!.close()
    daemon.close()
  })

  it('serves the asset placeholder for unknown paths', async () => {
    const res = await SELF.fetch(`${BASE}/some/unknown/path`)
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toContain('text/html')
    expect(await res.text()).toContain('flue relay')
  })
})

describe('authorizeDaemon', () => {
  // The SELF worker always has DAEMON_SECRET bound (vitest.config.ts), so the
  // unbound-secret case is a direct unit test: with no secret in the env,
  // `Bearer ${undefined}` must not become an accepted credential.
  it('fails closed when DAEMON_SECRET is not bound: Bearer "undefined" is refused', () => {
    const req = new Request(`${BASE}/daemon`, {
      headers: { Authorization: 'Bearer undefined', Upgrade: 'websocket' },
    })
    expect(authorizeDaemon(req, {} as Env)).toBe(false)
  })

  it('fails closed on an empty-string secret: "Bearer " is refused', () => {
    const req = new Request(`${BASE}/daemon`, {
      headers: { Authorization: 'Bearer ', Upgrade: 'websocket' },
    })
    expect(authorizeDaemon(req, { DAEMON_SECRET: '' } as Env)).toBe(false)
  })
})
