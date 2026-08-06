import { runInDurableObject } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'

import { BASE, controlFrame, decoder, dial, encoder, freshHub, type Leg } from './harness'

/** Mirrors the PAIR_TIMEOUT_MS binding in vitest.config.ts. */
const PAIR_TIMEOUT_MS = 250

/** The body cap, matching the daemon's own maxPairBytes (internal/daemon/pairing.go). */
const MAX_BODY = 4096

/** A pairing POST. Not awaited by the caller until the daemon has answered. */
function post(
  hub: DurableObjectStub,
  body: string,
  headers: Record<string, string> = {},
): Promise<Response> {
  return hub.fetch(`${BASE}/api/pair`, { method: 'POST', body, headers })
}

/** Reads the daemon's `pair` frame and answers it. Returns what it read. */
async function answer(
  daemon: Leg,
  status: number,
  body: unknown,
): Promise<Record<string, unknown>> {
  const pair = await daemon.nextControl()
  daemon.ws.send(controlFrame({ type: 'pairResult', id: pair.id, status, body }))
  return pair
}

/** A JSON body of exactly `n` bytes. */
function bodyOfSize(n: number): string {
  const body = `{"token":"${'x'.repeat(n - 12)}"}`
  if (body.length !== n) throw new Error(`built ${body.length} bytes, wanted ${n}`)
  return body
}

describe('POST /api/pair', () => {
  it('refuses with 503 daemon offline when no daemon is attached', async () => {
    const res = await post(freshHub(), '{"token":"t"}')
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ error: 'daemon offline' })
  })

  it('sends pair{id, origin, body} to the daemon and writes back its pairResult', async () => {
    const hub = freshHub()
    const daemon = await dial(hub, '/daemon')
    const res = post(hub, '{"token":"t","publicKey":"k","label":"iPhone"}')
    const pair = await answer(daemon, 403, { error: 'pairing refused' })
    expect(pair).toEqual({
      type: 'pair',
      id: 1,
      origin: BASE,
      body: { token: 't', publicKey: 'k', label: 'iPhone' },
    })
    const got = await res
    expect(got.status).toBe(403)
    expect(await got.json()).toEqual({ error: 'pairing refused' })
  })

  it('answers a success verbatim, as no-store application/json', async () => {
    const hub = freshHub()
    const daemon = await dial(hub, '/daemon')
    const res = post(hub, '{"token":"t"}')
    await answer(daemon, 200, { deviceId: 'd1b2c3d4e5f60718', daemonPub: 'AAAA' })
    const got = await res
    expect(got.status).toBe(200)
    expect(got.headers.get('Content-Type')).toBe('application/json')
    expect(got.headers.get('Cache-Control')).toBe('no-store')
    expect(await got.json()).toEqual({ deviceId: 'd1b2c3d4e5f60718', daemonPub: 'AAAA' })
  })

  it('forwards the browser JSON byte for byte, unreshaped', async () => {
    const hub = freshHub()
    const daemon = await dial(hub, '/daemon')
    // Key order, inner whitespace and characters a re-encoder would escape:
    // the daemon parses these bytes itself, so the relay must not touch them.
    const body = '{"z":  1,\n  "a": "<&>é", "token":"t"}'
    const res = post(hub, body)
    const payload = await daemon.nextControlBytes()
    expect(decoder.decode(payload)).toBe(`{"type":"pair","id":1,"origin":"${BASE}","body":${body}}`)
    daemon.ws.send(controlFrame({ type: 'pairResult', id: 1, status: 200, body: {} }))
    expect((await res).status).toBe(200)
  })

  // The counter is read back from storage rather than driven across an
  // eviction: `evictDurableObject` leaves this hub's hibernated legs unusable
  // once any plain HTTP request has gone through the stub (a pool artifact —
  // "read end of pipe was aborted" — reproducible with a bare 404 and no
  // pairing code at all). hub.test.ts already proves storage survives a wake.
  it('assigns pair ids from a counter it keeps in storage', async () => {
    const hub = freshHub()
    const daemon = await dial(hub, '/daemon')
    const first = post(hub, '{"token":"a"}')
    expect((await answer(daemon, 200, {})).id).toBe(1)
    await first
    const second = post(hub, '{"token":"b"}')
    expect((await answer(daemon, 200, {})).id).toBe(2)
    await second
    expect(await runInDurableObject(hub, (_i, state) => state.storage.get('nextPairId'))).toBe(3)
  })
})

describe('the pairing provenance check', () => {
  it('admits a same-origin Origin', async () => {
    const hub = freshHub()
    const daemon = await dial(hub, '/daemon')
    const res = post(hub, '{"token":"t"}', { Origin: BASE })
    await answer(daemon, 200, { ok: true })
    expect((await res).status).toBe(200)
  })

  it('refuses a cross-origin Origin with 403, telling the daemon nothing', async () => {
    const hub = freshHub()
    const daemon = await dial(hub, '/daemon')
    const res = await post(hub, '{"token":"secret"}', { Origin: 'https://evil.example' })
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'pairing refused' })
    // The daemon heard nothing: the next frame it sees is a later, honest pair.
    const honest = post(hub, '{"token":"honest"}')
    expect((await answer(daemon, 200, {})).body).toEqual({ token: 'honest' })
    await honest
  })
})

describe('the pairing body cap', () => {
  it('forwards a body of exactly the cap', async () => {
    const hub = freshHub()
    const daemon = await dial(hub, '/daemon')
    const body = bodyOfSize(MAX_BODY)
    const res = post(hub, body)
    expect(decoder.decode(await daemon.nextControlBytes())).toContain(body)
    daemon.ws.send(controlFrame({ type: 'pairResult', id: 1, status: 200, body: {} }))
    expect((await res).status).toBe(200)
  })

  it('refuses one byte over the cap with 413, telling the daemon nothing', async () => {
    const hub = freshHub()
    const daemon = await dial(hub, '/daemon')
    const res = await post(hub, bodyOfSize(MAX_BODY + 1))
    expect(res.status).toBe(413)
    expect(await res.json()).toEqual({ error: 'pairing body too large' })
    const honest = post(hub, '{"token":"honest"}')
    expect((await answer(daemon, 200, {})).body).toEqual({ token: 'honest' })
    await honest
  })

  it('refuses an oversized streamed body, whose length no header declares', async () => {
    const hub = freshHub()
    const daemon = await dial(hub, '/daemon')
    const chunk = encoder.encode('x'.repeat(1024))
    let left = 8
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (left-- <= 0) controller.close()
        else controller.enqueue(chunk)
      },
    })
    const res = await hub.fetch(`${BASE}/api/pair`, {
      method: 'POST',
      body: stream,
      // Undici/workerd want the half-duplex opt-out spelled out for a stream body.
      duplex: 'half',
    } as RequestInit)
    expect(res.status).toBe(413)
    const honest = post(hub, '{"token":"honest"}')
    expect((await answer(daemon, 200, {})).body).toEqual({ token: 'honest' })
    await honest
  })
})

describe('a pairing body that is not JSON', () => {
  it('is refused rather than spliced into the control frame', async () => {
    const hub = freshHub()
    const daemon = await dial(hub, '/daemon')
    const res = await post(hub, 'not json at all')
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'pairing refused' })
    const honest = post(hub, '{"token":"honest"}')
    expect((await answer(daemon, 200, {})).body).toEqual({ token: 'honest' })
    await honest
  })

  it('cannot smuggle a second control message past the splice', async () => {
    const hub = freshHub()
    const daemon = await dial(hub, '/daemon')
    // Verbatim splicing is only safe because this is refused: a body that
    // closes the pair object early would forge a relay → daemon control
    // message — here, a `closed` for somebody else's channel.
    const res = await post(hub, '{}, "type": "closed", "channel": 1')
    expect(res.status).toBe(403)
    const honest = post(hub, '{"token":"honest"}')
    const pair = await answer(daemon, 200, {})
    expect(pair.type).toBe('pair')
    expect(pair.body).toEqual({ token: 'honest' })
    await honest
  })
})

describe('a daemon that does not answer', () => {
  it('times out with 504 daemon did not answer', async () => {
    const hub = freshHub()
    const daemon = await dial(hub, '/daemon')
    const started = Date.now()
    const res = await post(hub, '{"token":"t"}')
    expect(res.status).toBe(504)
    expect(await res.json()).toEqual({ error: 'daemon did not answer' })
    expect(Date.now() - started).toBeGreaterThanOrEqual(PAIR_TIMEOUT_MS - 25)
    // The leg is untouched: a later pair still goes out.
    const honest = post(hub, '{"token":"honest"}')
    await daemon.nextControl() // the timed-out pair
    expect((await answer(daemon, 200, {})).body).toEqual({ token: 'honest' })
    await honest
  })

  it('fails a pair in flight when the daemon leg drops, without waiting it out', async () => {
    const hub = freshHub()
    const daemon = await dial(hub, '/daemon')
    const res = post(hub, '{"token":"t"}')
    await daemon.nextControl()
    daemon.ws.close(1000, 'bye')
    const got = await res
    expect(got.status).toBe(503)
    expect(await got.json()).toEqual({ error: 'daemon offline' })
  })
})

describe('a pairResult the hub did not ask for', () => {
  it('is dropped, and the control channel keeps working', async () => {
    const hub = freshHub()
    const daemon = await dial(hub, '/daemon')
    daemon.ws.send(controlFrame({ type: 'pairResult', id: 987, status: 200, body: {} }))
    const honest = post(hub, '{"token":"honest"}')
    expect((await answer(daemon, 200, { ok: true })).id).toBe(1)
    expect(await (await honest).json()).toEqual({ ok: true })
  })

  it('carrying a status no HTTP response can hold answers 502', async () => {
    const hub = freshHub()
    const daemon = await dial(hub, '/daemon')
    const res = post(hub, '{"token":"t"}')
    await answer(daemon, 0, { error: 'nonsense' })
    expect((await res).status).toBe(502)
  })

  it('carrying a status that forbids a body drops the body instead of throwing', async () => {
    const hub = freshHub()
    const daemon = await dial(hub, '/daemon')
    const res = post(hub, '{"token":"t"}')
    await answer(daemon, 204, { ignored: true })
    const got = await res
    expect(got.status).toBe(204)
    expect(await got.text()).toBe('')
  })
})
