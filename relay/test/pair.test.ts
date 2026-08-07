import { runInDurableObject } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'

import {
  BASE,
  controlFrame,
  decoder,
  dial,
  encoder,
  freshHub,
  hubPath,
  MACHINE,
  type Leg,
} from './harness'

/** Mirrors the PAIR_TIMEOUT_MS binding in vitest.config.ts. */
const PAIR_TIMEOUT_MS = 250

/** The body cap, matching the daemon's own maxPairBytes (internal/daemon/pairing.go). */
const MAX_BODY = 4096

/** Mirrors MAX_PENDING_PAIRS in src/hub.ts. */
const MAX_PENDING = 8

/** Where a stub-side pairing POST lands. The test spells the public path;
 * hubPath strips it to the bare one the hub receives behind the Worker. */
const PAIR_URL = `${BASE}${hubPath(`/api/pair/${MACHINE}`)}`

/** A pairing POST. Not awaited by the caller until the daemon has answered. */
function post(
  hub: DurableObjectStub,
  body: string,
  headers: Record<string, string> = {},
): Promise<Response> {
  return hub.fetch(PAIR_URL, { method: 'POST', body, headers })
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
    const daemon = await dial(hub, `/daemon/${MACHINE}`)
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
    const daemon = await dial(hub, `/daemon/${MACHINE}`)
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
    const daemon = await dial(hub, `/daemon/${MACHINE}`)
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
    const daemon = await dial(hub, `/daemon/${MACHINE}`)
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
    const daemon = await dial(hub, `/daemon/${MACHINE}`)
    const res = post(hub, '{"token":"t"}', { Origin: BASE })
    await answer(daemon, 200, { ok: true })
    expect((await res).status).toBe(200)
  })

  it('refuses a cross-origin Origin with 400, telling the daemon nothing', async () => {
    // 400 rather than 403 on purpose: this request never reached the daemon, so
    // no token was presented and the user's window is still open. 403 is the
    // daemon's own verdict and the browser reads it as one — see REFUSED_STATUS
    // in web/src/routes/pair.tsx.
    const hub = freshHub()
    const daemon = await dial(hub, `/daemon/${MACHINE}`)
    const res = await post(hub, '{"token":"secret"}', { Origin: 'https://evil.example' })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'pairing request rejected' })
    // The daemon heard nothing: the next frame it sees is a later, honest pair.
    const honest = post(hub, '{"token":"honest"}')
    expect((await answer(daemon, 200, {})).body).toEqual({ token: 'honest' })
    await honest
  })
})

describe('the pairing body cap', () => {
  it('forwards a body of exactly the cap', async () => {
    const hub = freshHub()
    const daemon = await dial(hub, `/daemon/${MACHINE}`)
    const body = bodyOfSize(MAX_BODY)
    const res = post(hub, body)
    expect(decoder.decode(await daemon.nextControlBytes())).toContain(body)
    daemon.ws.send(controlFrame({ type: 'pairResult', id: 1, status: 200, body: {} }))
    expect((await res).status).toBe(200)
  })

  it('refuses one byte over the cap with 413, telling the daemon nothing', async () => {
    const hub = freshHub()
    const daemon = await dial(hub, `/daemon/${MACHINE}`)
    const res = await post(hub, bodyOfSize(MAX_BODY + 1))
    expect(res.status).toBe(413)
    expect(await res.json()).toEqual({ error: 'pairing body too large' })
    const honest = post(hub, '{"token":"honest"}')
    expect((await answer(daemon, 200, {})).body).toEqual({ token: 'honest' })
    await honest
  })

  it('refuses an oversized streamed body, whose length no header declares', async () => {
    const hub = freshHub()
    const daemon = await dial(hub, `/daemon/${MACHINE}`)
    const chunk = encoder.encode('x'.repeat(1024))
    let left = 8
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (left-- <= 0) controller.close()
        else controller.enqueue(chunk)
      },
    })
    const res = await hub.fetch(PAIR_URL, {
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
  it('is rejected rather than spliced into the control frame', async () => {
    const hub = freshHub()
    const daemon = await dial(hub, `/daemon/${MACHINE}`)
    const res = await post(hub, 'not json at all')
    // 400: the guard is the relay's own and it ran before the daemon heard
    // anything, so the token in that body — a truncated POST from a phone on a
    // bad connection carries a real one — was never presented to anything.
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'pairing request rejected' })
    const honest = post(hub, '{"token":"honest"}')
    expect((await answer(daemon, 200, {})).body).toEqual({ token: 'honest' })
    await honest
  })

  it('cannot smuggle a second control message past the splice', async () => {
    const hub = freshHub()
    const daemon = await dial(hub, `/daemon/${MACHINE}`)
    // Verbatim splicing is only safe because this is refused: a body that
    // closes the pair object early would forge a relay → daemon control
    // message — here, a `closed` for somebody else's channel.
    const res = await post(hub, '{}, "type": "closed", "channel": 1')
    expect(res.status).toBe(400)
    const honest = post(hub, '{"token":"honest"}')
    const pair = await answer(daemon, 200, {})
    expect(pair.type).toBe('pair')
    expect(pair.body).toEqual({ token: 'honest' })
    await honest
  })
})

describe('403 on this endpoint', () => {
  it('is the daemon’s verdict and nothing the relay says on its own', async () => {
    // The invariant the browser leans on. A device that reads 403 stops
    // offering Pair, because a token that reached the daemon's pairing handler
    // is a token that ceremony is over for; every refusal the relay reaches on
    // its own leaves the window open, so none of them may wear that status.
    // Kept in one test because the rule is one rule — the individual paths have
    // their own assertions above.
    const hub = freshHub()
    const noDaemon = await post(freshHub(), '{"token":"t"}')
    const daemon = await dial(hub, `/daemon/${MACHINE}`)
    const relayOwn = [
      noDaemon,
      await post(hub, '{"token":"t"}', { Origin: 'https://evil.example' }),
      await post(hub, 'not json at all'),
      await post(hub, bodyOfSize(MAX_BODY + 1)),
    ]
    expect(relayOwn.map((res) => res.status)).toEqual([503, 400, 400, 413])

    // And the one that does come from the daemon still arrives as a 403.
    const forwarded = post(hub, '{"token":"t"}')
    await answer(daemon, 403, { error: 'pairing refused' })
    expect((await forwarded).status).toBe(403)
  })
})

describe('the cap on concurrent pairing attempts', () => {
  it('refuses the 9th parked attempt with 429, spending neither an id nor a frame', async () => {
    const hub = freshHub()
    const daemon = await dial(hub, `/daemon/${MACHINE}`)
    // Park the cap's worth against a daemon that says nothing yet. Concurrent
    // POSTs reach the object in whatever order the runtime delivers them, so
    // each answer is routed back by the id the daemon read for that token
    // rather than by the order the requests were made in.
    const parked = Array.from({ length: MAX_PENDING }, (_, i) => post(hub, `{"token":"t${i}"}`))
    const idFor = new Map<string, number>()
    for (let i = 1; i <= MAX_PENDING; i += 1) {
      const pair = await daemon.nextControl()
      expect(pair.id).toBe(i) // ids are spent in the order the hub reads them
      idFor.set((pair.body as { token: string }).token, i)
    }
    expect(idFor.size).toBe(MAX_PENDING)
    // The one over the cap. 429, not the 503 a missing daemon gets: the daemon
    // is right there, and it is the caller's own concurrency that is in the way.
    const over = await post(hub, '{"token":"over"}')
    expect(over.status).toBe(429)
    expect(await over.json()).toEqual({ error: 'too many pairing attempts' })
    expect(over.headers.get('Content-Type')).toBe('application/json')
    expect(over.headers.get('Cache-Control')).toBe('no-store')
    // Let the parked ones go, then prove the refusal never reached the daemon:
    // the next frame it sees is the honest attempt after it, and it carries the
    // id the refused one would have spent.
    for (const [token, id] of idFor) {
      daemon.ws.send(controlFrame({ type: 'pairResult', id, status: 200, body: { token } }))
    }
    for (const [i, res] of (await Promise.all(parked)).entries()) {
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ token: `t${i}` })
    }
    const honest = post(hub, '{"token":"honest"}')
    const pair = await answer(daemon, 200, {})
    expect(pair.id).toBe(MAX_PENDING + 1)
    expect(pair.body).toEqual({ token: 'honest' })
    expect((await honest).status).toBe(200)
  })
})

describe('a daemon that does not answer', () => {
  it('times out with 504 daemon did not answer', async () => {
    const hub = freshHub()
    const daemon = await dial(hub, `/daemon/${MACHINE}`)
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
    const daemon = await dial(hub, `/daemon/${MACHINE}`)
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
    const daemon = await dial(hub, `/daemon/${MACHINE}`)
    daemon.ws.send(controlFrame({ type: 'pairResult', id: 987, status: 200, body: {} }))
    const honest = post(hub, '{"token":"honest"}')
    expect((await answer(daemon, 200, { ok: true })).id).toBe(1)
    expect(await (await honest).json()).toEqual({ ok: true })
  })

  it('carrying a status no HTTP response can hold answers 502', async () => {
    const hub = freshHub()
    const daemon = await dial(hub, `/daemon/${MACHINE}`)
    const res = post(hub, '{"token":"t"}')
    await answer(daemon, 0, { error: 'nonsense' })
    expect((await res).status).toBe(502)
  })

  it('carrying a status that forbids a body drops the body instead of throwing', async () => {
    const hub = freshHub()
    const daemon = await dial(hub, `/daemon/${MACHINE}`)
    const res = post(hub, '{"token":"t"}')
    await answer(daemon, 204, { ignored: true })
    const got = await res
    expect(got.status).toBe(204)
    expect(await got.text()).toBe('')
  })
})
