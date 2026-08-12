import { env, SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'

import worker, { type Env } from '../src/index'
import { BASE, Leg, machineId, sleep, TEST_SECRET, within } from './harness'

/**
 * The fleet directory: the relay's store of blobs it cannot read
 * (spec/fleet-trust.md, "The fleet directory"). Everything below is written
 * from the outside — through the real Worker, over the real Durable Object —
 * because the contract parts B and C are written against is the HTTP and
 * WebSocket surface, not the class.
 *
 * The invariant every one of these tests is really about: the relay stores and
 * serves, and verifies nothing. A blob that came back changed, or an entry that
 * quietly displaced another, would be a Worker that had formed an opinion about
 * bytes it holds no key for.
 */

/** Mirrors MAX_BLOB_BYTES in src/directory.ts. */
const MAX_BLOB_BYTES = 4096

/**
 * Mirrors DIRECTORY_MAX_ENTRIES in vitest.config.ts, *not* MAX_ENTRIES in
 * src/directory.ts — the cap is a test seam, and this is the bound half of it.
 *
 * Production is 512, and the arithmetic that picks it is written down beside
 * the constant. It is not the number to test against: the only way to test a
 * cap is to reach it, and reaching 512 is 512 sequential round trips through a
 * Durable Object — around five seconds on a quiet machine and past vitest's
 * own five-second deadline on a loaded one, which is how these tests came to
 * fail in CI and pass on a laptop. This reaches the same branch in a fraction
 * of that; what is under test is the refusal, not the size of the number.
 *
 * It has headroom on purpose. The shared directory — the one `SELF` routes to,
 * which nearly every other test in this file writes into — holds ten entries
 * by the end of the run, and a bound it could reach would start refusing PUTs
 * in tests that are not about the cap at all. That failure reads as "the push
 * never came", nowhere near the number that caused it.
 */
const MAX_ENTRIES = 64

/**
 * Mirrors DIRECTORY_MAX_DAEMON_SOCKETS in vitest.config.ts, for the reason
 * MAX_ENTRIES above is bound: production is 256, and reaching it means opening
 * 256 WebSockets one at a time and holding all of them open. What is under
 * test is the refusal at the ceiling, not where the ceiling is.
 */
const MAX_DAEMON_SOCKETS = 8

const DIRECTORY = `${BASE}/directory`

const AUTH = { Authorization: `Bearer ${TEST_SECRET}` }

/**
 * Every test in this file shares the one directory object — `idFromName`
 * ("directory") is a constant, which is the whole point of "one relay is one
 * fleet" — so blobs are made unique per test rather than per run, and the
 * assertions are about *this* blob rather than about the size of the set.
 */
function blob(tag: string, fill = 'x'): Uint8Array {
  return new TextEncoder().encode(`${tag}:${fill}`)
}

function put(body: BodyInit, headers: Record<string, string> = AUTH): Promise<Response> {
  return SELF.fetch(DIRECTORY, { method: 'PUT', body, headers })
}

async function get(): Promise<{ v: number; entries: { key: string; blob: string }[] }> {
  const res = await SELF.fetch(DIRECTORY)
  expect(res.status).toBe(200)
  return (await res.json()) as { v: number; entries: { key: string; blob: string }[] }
}

/** The key the directory files a blob under: SHA-256 of its exact bytes. */
async function digest(bytes: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', bytes as BufferSource)
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** The bytes of one entry of a GET, base64 undone. */
function decode(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
}

/** A daemon's push socket, as a harness Leg. */
async function socket(): Promise<Leg> {
  const res = await SELF.fetch(DIRECTORY, { headers: { Upgrade: 'websocket', ...AUTH } })
  expect(res.status).toBe(101)
  const ws = res.webSocket!
  // The pool's test-side socket defaults to delivering binary as Blob; ask for
  // ArrayBuffer so a push can be compared synchronously.
  ;(ws as unknown as { binaryType: string }).binaryType = 'arraybuffer'
  ws.accept()
  return new Leg(ws)
}

/** A stub env for the router unit tests, shaped like machineid.test.ts's: the
 * directory namespace answers with a status nothing else in the Worker uses,
 * so "reached the object" is unmistakable. */
function stubEnv(overrides: Partial<Env>): Env {
  return {
    DAEMON_SECRET: TEST_SECRET,
    DIRECTORY: {
      idFromName: (name: string) => name,
      get: () => ({ fetch: async () => new Response('reached the directory', { status: 299 }) }),
    },
    ASSETS: { fetch: async () => new Response('spa', { status: 200 }) },
    ...overrides,
  } as unknown as Env
}

const denyAll = { limit: async () => ({ success: false }) }

describe('PUT /directory', () => {
  it('refuses a write without the daemon secret: 401', async () => {
    const res = await put(blob('unauthorized'), {})
    expect(res.status).toBe(401)
  })

  it('refuses a write with the wrong secret: 401', async () => {
    const res = await put(blob('wrong-secret'), { Authorization: 'Bearer nope' })
    expect(res.status).toBe(401)
  })

  it('stores a blob and answers 201 with the key it filed it under', async () => {
    const body = blob('stored')
    const res = await put(body)
    expect(res.status).toBe(201)
    expect(res.headers.get('Content-Type')).toBe('application/json')
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    // Content-addressed: the key is SHA-256 of the exact bytes and nothing
    // else, which is what makes a PUT unable to displace another entry.
    expect(await res.json()).toEqual({ key: await digest(body) })
  })

  it('is idempotent: the same bytes again answer 200 and add no second entry', async () => {
    const body = blob('idempotent')
    expect((await put(body)).status).toBe(201)
    const before = (await get()).entries.length
    const again = await put(body)
    // 200 rather than 201 — same body, so a caller need not branch; the status
    // is the whole of "you were not the first".
    expect(again.status).toBe(200)
    expect(await again.json()).toEqual({ key: await digest(body) })
    expect((await get()).entries.length).toBe(before)
  })

  it('refuses an empty body: 400, and spends no entry on it', async () => {
    const res = await put(new Uint8Array(0))
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'empty blob' })
  })

  it('takes a blob of exactly the cap and refuses one byte more: 413', async () => {
    const at = new Uint8Array(MAX_BLOB_BYTES).fill(0x41)
    expect((await put(at)).status).toBe(201)
    const over = new Uint8Array(MAX_BLOB_BYTES + 1).fill(0x42)
    const res = await put(over)
    expect(res.status).toBe(413)
    expect(await res.json()).toEqual({ error: 'blob too large' })
    // And nothing of the oversized blob was kept.
    const keys = (await get()).entries.map((e) => e.key)
    expect(keys).not.toContain(await digest(over))
  })

  it('refuses an oversized chunked body too, where Content-Length says nothing', async () => {
    // A body streamed without a declared length is the case a Content-Length
    // check alone misses, and buffering it is the memory DoS readCapped
    // exists to stop.
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(MAX_BLOB_BYTES).fill(0x43))
        controller.enqueue(new Uint8Array(64).fill(0x44))
        controller.close()
      },
    })
    const res = await SELF.fetch(DIRECTORY, {
      method: 'PUT',
      body: stream,
      headers: AUTH,
      // Required by the fetch spec for a streaming body.
      duplex: 'half',
    } as RequestInit)
    expect(res.status).toBe(413)
  })
})

describe('GET /directory', () => {
  it('is credential-less: no secret, still the full set', async () => {
    const body = blob('credential-less')
    await put(body)
    const res = await SELF.fetch(DIRECTORY)
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('application/json')
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    const doc = (await res.json()) as { v: number; entries: { key: string; blob: string }[] }
    expect(doc.v).toBe(1)
    expect(doc.entries.map((e) => e.key)).toContain(await digest(body))
  })

  it('round-trips a blob byte for byte, whatever is in it', async () => {
    // The load-bearing test of the whole leg. Parts B and C verify Ed25519
    // signatures over *these* bytes: a relay that re-encoded, trimmed, or
    // ran a blob through UTF-8 anywhere would break every signature over it
    // while believing it had been helpful. So the payload is deliberately not
    // text — a NUL, a lone 0xFF that is not valid UTF-8, and a byte pattern
    // that base64 has to pad.
    const body = Uint8Array.of(0x00, 0xff, 0xfe, 0x0a, 0x7b, 0x22, 0x80, 0x01, 0x02)
    const res = await put(body)
    expect(res.status).toBe(201)
    const key = await digest(body)
    const entry = (await get()).entries.find((e) => e.key === key)
    expect(entry).toBeDefined()
    expect([...decode(entry!.blob)]).toEqual([...body])
    // And the key is still the digest of what came back: bytes the relay had
    // altered could not hash to the name it filed them under.
    expect(await digest(decode(entry!.blob))).toBe(key)
  })

  it('keys every entry by the digest of its own blob', async () => {
    await put(blob('keyed-by-digest'))
    const entries = (await get()).entries
    expect(entries.length).toBeGreaterThan(0)
    for (const e of entries) expect(await digest(decode(e.blob))).toBe(e.key)
  })

  it('carries an ETag and answers a matching If-None-Match with 304', async () => {
    // The largest document this relay serves — 512 × 4 KiB of base64 is about
    // 2.8 MiB — re-read by every daemon on every reconnect, where the usual
    // answer is "nothing has changed".
    const dir = env.DIRECTORY.get(env.DIRECTORY.idFromName(`etag-${crypto.randomUUID()}`))
    const write = (body: Uint8Array): Promise<Response> =>
      dir.fetch(DIRECTORY, { method: 'PUT', body, headers: AUTH })
    expect((await write(blob('etag', 'a'))).status).toBe(201)

    const first = await dir.fetch(DIRECTORY)
    const tag = first.headers.get('ETag')
    expect(tag).toBeTruthy()
    // no-store stays: a directory served from a cache is a revocation served
    // late. The tag is for a client that revalidates on purpose.
    expect(first.headers.get('Cache-Control')).toBe('no-store')

    const again = await dir.fetch(DIRECTORY, { headers: { 'If-None-Match': tag! } })
    expect(again.status).toBe(304)
    expect(again.headers.get('ETag')).toBe(tag)
    expect(await again.text()).toBe('')

    // A duplicate PUT stores nothing, so the set did not change and neither
    // does the tag.
    expect((await write(blob('etag', 'a'))).status).toBe(200)
    expect((await dir.fetch(DIRECTORY, { headers: { 'If-None-Match': tag! } })).status).toBe(304)

    // A PUT that lands does change it.
    expect((await write(blob('etag', 'b'))).status).toBe(201)
    const third = await dir.fetch(DIRECTORY, { headers: { 'If-None-Match': tag! } })
    expect(third.status).toBe(200)
    expect(third.headers.get('ETag')).not.toBe(tag)
  })

  it('never reissues a tag a reader already holds, even across a reset', async () => {
    // The one case a content digest would get wrong and a counter gets right:
    // empty the directory, put the same blob back, and the contents are
    // identical while the reader's picture of the world was empty in between.
    const dir = env.DIRECTORY.get(env.DIRECTORY.idFromName(`etag-reset-${crypto.randomUUID()}`))
    const body = blob('etag-reset', 'a')
    await dir.fetch(DIRECTORY, { method: 'PUT', body, headers: AUTH })
    const tag = (await dir.fetch(DIRECTORY)).headers.get('ETag')

    await dir.fetch(DIRECTORY, { method: 'DELETE', headers: AUTH })
    await dir.fetch(DIRECTORY, { method: 'PUT', body, headers: AUTH })

    const after = await dir.fetch(DIRECTORY, { headers: { 'If-None-Match': tag! } })
    expect(after.status).toBe(200)
    expect(after.headers.get('ETag')).not.toBe(tag)
  })

  it('sits behind the rate rule, like /client and POST /api/pair', async () => {
    const res = await worker.fetch(
      new Request(DIRECTORY),
      stubEnv({ CLIENT_RATE: denyAll }),
    )
    expect(res.status).toBe(429)
    expect(await res.json()).toEqual({ error: 'rate limited' })
  })

  it('does not meter the secret-holding legs: they are gated, not throttled', async () => {
    const upgrade = await worker.fetch(
      new Request(DIRECTORY, { headers: { Upgrade: 'websocket', ...AUTH } }),
      stubEnv({ CLIENT_RATE: denyAll }),
    )
    expect(upgrade.status).toBe(299)
    const write = await worker.fetch(
      new Request(DIRECTORY, { method: 'PUT', body: 'blob', headers: AUTH }),
      stubEnv({ CLIENT_RATE: denyAll }),
    )
    expect(write.status).toBe(299)
  })

  it('meters an anonymous upgrade too: the 401 is not a cheaper road past the rule', async () => {
    // Without this, `Upgrade: websocket` would be a way to spend the Worker's
    // billed requests on /directory without ever presenting a credential.
    const res = await worker.fetch(
      new Request(DIRECTORY, { headers: { Upgrade: 'websocket' } }),
      stubEnv({ CLIENT_RATE: denyAll }),
    )
    expect(res.status).toBe(429)
  })

  it('fails open when the rate binding is absent, as the other routes do', async () => {
    const res = await worker.fetch(new Request(DIRECTORY), stubEnv({ CLIENT_RATE: undefined }))
    expect(res.status).toBe(299)
  })
})

describe('the directory socket', () => {
  it('refuses an upgrade without the daemon secret: 401', async () => {
    const res = await SELF.fetch(DIRECTORY, { headers: { Upgrade: 'websocket' } })
    expect(res.status).toBe(401)
  })

  it('pushes a stored blob to every connected daemon, byte for byte', async () => {
    const a = await socket()
    const b = await socket()
    const body = Uint8Array.of(0x00, 0xff, 0x10, 0x20, 0x30)
    expect((await put(body)).status).toBe(201)
    // One binary message of exactly the blob's bytes: no envelope, because an
    // envelope is a chance to reshape something the relay cannot read.
    expect([...new Uint8Array((await a.next('a push')) as ArrayBuffer)]).toEqual([...body])
    expect([...new Uint8Array((await b.next('a push')) as ArrayBuffer)]).toEqual([...body])
    a.ws.close()
    b.ws.close()
  })

  it('pushes nothing for a duplicate PUT: the set did not change', async () => {
    const body = blob('pushed-once')
    await put(body)
    const daemon = await socket()
    // The socket is opened after the first PUT, so the only push it could see
    // is one the duplicate produced.
    await put(body)
    // A blob that *does* change the set, sent second, is the fence: if the
    // duplicate had pushed, this assertion would read its bytes instead.
    const fresh = blob('pushed-once-fence')
    await put(fresh)
    expect([...new Uint8Array((await daemon.next('the fence push')) as ArrayBuffer)]).toEqual([
      ...fresh,
    ])
    daemon.ws.close()
  })

  it('holds MAX_DAEMON_SOCKETS of them and refuses the next with 503', async () => {
    // Not the DoS cap MAX_CLIENTS is on the hub's credential-less leg — this
    // one is secret-gated. It bounds what a single PUT costs, which is one
    // send per socket, against a fleet that has left half-dead sockets behind
    // or a secret-holder opening them in a loop. Untested until now, and an
    // untested bound is a number rather than a limit.
    const dir = env.DIRECTORY.get(env.DIRECTORY.idFromName(`sockets-${crypto.randomUUID()}`))
    const open = (): Promise<Response> =>
      dir.fetch(DIRECTORY, { headers: { Upgrade: 'websocket', ...AUTH } })

    const held: WebSocket[] = []
    for (let i = 0; i < MAX_DAEMON_SOCKETS; i++) {
      const res = await open()
      expect(res.status).toBe(101)
      // Accepted on this side too: an unaccepted pair is not what a real
      // daemon leaves behind, and the object counts what it accepted.
      res.webSocket!.accept()
      held.push(res.webSocket!)
    }

    const over = await open()
    expect(over.status).toBe(503)
    expect(await over.json()).toEqual({ error: 'too many directory sockets' })

    // And there is no reaper: the cap is a ceiling on concurrency, not a
    // queue, so room appears when a socket closes and not before.
    held[0]!.close()
    // The close has to reach the object before the next upgrade is judged; a
    // fresh request is the fence the pool gives us.
    for (let attempt = 0; attempt < 20; attempt++) {
      const retry = await open()
      if (retry.status === 101) {
        retry.webSocket!.accept()
        held.push(retry.webSocket!)
        break
      }
      expect(retry.status).toBe(503)
      await sleep(25)
    }
    for (const ws of held) {
      try {
        ws.close()
      } catch {
        // Already closed by the assertions above.
      }
    }
  })

  it('closes a daemon that speaks on it: the socket is push-only', async () => {
    const daemon = await socket()
    daemon.ws.send('hello')
    expect(await within(daemon.closed, 'the socket to close')).toEqual({
      code: 1002,
      reason: 'the directory socket is push-only',
    })
  })

  it('survives a flue-pong without closing', async () => {
    const daemon = await socket()
    daemon.ws.send('flue-pong')
    const body = blob('after-a-pong')
    await put(body)
    expect([...new Uint8Array((await daemon.next('a push')) as ArrayBuffer)]).toEqual([...body])
    daemon.ws.close()
  })

  it('answers flue-ping from the edge auto-response, without waking the object', async () => {
    const daemon = await socket()
    daemon.ws.send('flue-ping')
    expect(await daemon.next('the pong')).toBe('flue-pong')
    daemon.ws.close()
  })
})

describe('the directory routes', () => {
  it('404s a path under the prefix: the Worker owns it, the SPA does not answer', async () => {
    const res = await SELF.fetch(`${BASE}/directory/anything`)
    expect(res.status).toBe(404)
    // Not the machine 404: nothing here names a machine, and saying so would
    // be a lie about what was asked.
    expect(await res.json()).toEqual({ error: 'not found' })
  })

  it('405s a method the leg does not have', async () => {
    const res = await SELF.fetch(DIRECTORY, { method: 'PATCH', headers: AUTH })
    expect(res.status).toBe(405)
    expect(res.headers.get('Allow')).toBe('GET, PUT, DELETE')
    expect(await res.json()).toEqual({ error: 'method not allowed' })
  })

  it('never confuses the directory with a machine: /directory is not an id', async () => {
    // The two prefixes cannot collide — "directory" carries no MAC tag and
    // could not be a machine id — but the check is cheap and the failure mode
    // (a fleet's certs served out of a machine hub) would be silent.
    const res = await SELF.fetch(`${BASE}/client/${await machineId('notdir-0a0a')}`, {
      headers: { Upgrade: 'websocket' },
    })
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ error: 'daemon offline' })
  })

  it('503s when the directory binding is absent: an older deploy than this script', async () => {
    const res = await worker.fetch(new Request(DIRECTORY), stubEnv({ DIRECTORY: undefined }))
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ error: 'directory unavailable' })
  })

  it('binds one directory for the whole relay', async () => {
    // One relay is one fleet: the name is a constant in the router, so two
    // reads of it are two reads of the same object. The binding has to exist
    // in the pool for that to mean anything.
    expect(env.DIRECTORY).toBeDefined()
    expect(typeof env.DIRECTORY.idFromName).toBe('function')
  })
})

/**
 * The reset, which is the only way out of a full directory.
 *
 * Like the cap below, these run against objects of their own: a wipe of the
 * shared directory would pull the ground out from under every other test in
 * this file. The one test here that *is* about the router — who may ask for a
 * wipe — goes through SELF, and is refused before it reaches any object.
 */
describe('DELETE /directory', () => {
  /** A directory nothing else in this file touches. */
  function own(): DurableObjectStub {
    return env.DIRECTORY.get(env.DIRECTORY.idFromName(`reset-${crypto.randomUUID()}`))
  }
  const write = (dir: DurableObjectStub, body: Uint8Array): Promise<Response> =>
    dir.fetch(DIRECTORY, { method: 'PUT', body, headers: AUTH })
  const wipe = (dir: DurableObjectStub): Promise<Response> =>
    dir.fetch(DIRECTORY, { method: 'DELETE', headers: AUTH })
  const read = async (dir: DurableObjectStub): Promise<{ key: string; blob: string }[]> =>
    ((await (await dir.fetch(DIRECTORY)).json()) as { entries: { key: string; blob: string }[] })
      .entries

  it('refuses a wipe without the daemon secret: 401', async () => {
    // The gate is the router's, and it is the same secret PUT and the socket
    // present. A credential-less caller can read this store; emptying it is a
    // write, and the largest one there is.
    expect((await SELF.fetch(DIRECTORY, { method: 'DELETE' })).status).toBe(401)
    expect(
      (await SELF.fetch(DIRECTORY, { method: 'DELETE', headers: { Authorization: 'Bearer nope' } }))
        .status,
    ).toBe(401)
  })

  it('empties the store and reports what it removed', async () => {
    const dir = own()
    expect((await write(dir, blob('wipe', 'a'))).status).toBe(201)
    expect((await write(dir, blob('wipe', 'b'))).status).toBe(201)
    expect((await read(dir)).length).toBe(2)

    const res = await wipe(dir)
    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    expect(await res.json()).toEqual({ reset: true, removed: 2 })
    expect(await read(dir)).toEqual([])
  })

  it('takes the count with the blobs: a re-publish repopulates from zero', async () => {
    const dir = own()
    const first = blob('repopulate', 'a')
    expect((await write(dir, first)).status).toBe(201)
    await wipe(dir)
    // 201 rather than 200: the entry is genuinely gone, not merely hidden from
    // the snapshot, so the daemon that re-offers it is filing it afresh.
    expect((await write(dir, first)).status).toBe(201)
    expect((await read(dir)).map((e) => e.key)).toEqual([await digest(first)])
    // And the counter went with it — a count that survived the wipe would
    // refuse the 513th write into an empty store.
    expect((await wipe(dir)).status).toBe(200)
    expect(await (await wipe(dir)).json()).toEqual({ reset: true, removed: 0 })
  })

  it('lets a revocation that was refused at the cap be published after a reset', async () => {
    // The whole point, end to end. A full directory refuses the fleet-wide kill
    // switch with 507 — and refuses it permanently, because nothing evicts and
    // Durable Object storage outlives every redeploy. This is the way back.
    const dir = own()
    for (let i = 0; i < MAX_ENTRIES; i++) {
      expect((await write(dir, blob('fullcap', String(i)))).status).toBe(201)
    }
    const revocation = blob('fullcap', 'revocation')
    expect((await write(dir, revocation)).status).toBe(507)

    expect((await wipe(dir)).status).toBe(200)

    const after = await write(dir, revocation)
    expect(after.status).toBe(201)
    expect(await after.json()).toEqual({ key: await digest(revocation) })
    expect((await read(dir)).map((e) => e.key)).toEqual([await digest(revocation)])
  })

  it('closes every daemon socket, so the fleet re-publishes in seconds not in half an hour', async () => {
    const dir = own()
    const res = await dir.fetch(DIRECTORY, { headers: { Upgrade: 'websocket', ...AUTH } })
    expect(res.status).toBe(101)
    const ws = res.webSocket!
    ws.accept()
    const leg = new Leg(ws)

    expect((await wipe(dir)).status).toBe(200)

    // The close is the message: this leg carries nothing but raw blobs daemon-
    // ward, so there is no in-band way to say "re-publish" — and a daemon's
    // reconnect is a snapshot read followed by a full re-offer of everything it
    // holds, which is exactly what an emptied directory needs.
    const closed = await within(leg.closed, 'the reset to close the daemon socket')
    expect(closed.code).toBe(1012)
    expect(closed.reason).toBe('the directory was reset; reconnect and republish')
  })
})

/**
 * The cap, tested against its own object rather than the shared one: filling
 * the fleet directory would leave every other test in this file reading 512
 * entries. This dials the Durable Object directly, which is the one place in
 * this suite the router is not the thing under test.
 */
describe('the entry cap', () => {
  it('refuses a PUT past MAX_ENTRIES with 507, and keeps taking duplicates', async () => {
    const full = env.DIRECTORY.get(env.DIRECTORY.idFromName(`full-${crypto.randomUUID()}`))
    const write = (body: Uint8Array): Promise<Response> =>
      full.fetch(DIRECTORY, { method: 'PUT', body, headers: AUTH })
    // Fill it. Small blobs — the cap under test is the count, not the bytes.
    const first = blob('cap', '0')
    expect((await write(first)).status).toBe(201)
    for (let i = 1; i < MAX_ENTRIES; i++) expect((await write(blob('cap', String(i)))).status).toBe(201)
    // One more distinct blob is refused, with a status nothing else on this
    // leg wears: a daemon has to tell "your blob is fine and I will not keep
    // it" from 413 (this blob is wrong) and 401 (this caller is wrong).
    const over = blob('cap', 'over')
    const res = await write(over)
    expect(res.status).toBe(507)
    expect(await res.json()).toEqual({ error: 'directory full' })
    // Refused, not evicted — a directory that dropped an old entry to take a
    // new one could drop a revocation, and a forgotten revocation re-admits
    // the device it revoked.
    const doc = (await (await full.fetch(DIRECTORY)).json()) as {
      entries: { key: string; blob: string }[]
    }
    expect(doc.entries.length).toBe(MAX_ENTRIES)
    expect(doc.entries.map((e) => e.key)).toContain(await digest(first))
    expect(doc.entries.map((e) => e.key)).not.toContain(await digest(over))
    // And a re-PUT of something already stored still succeeds at the cap: it
    // asks for no room, so refusing it would strand a daemon that re-announces
    // on every reconnect.
    expect((await write(first)).status).toBe(200)
  })

  it('pushes nothing at all for a refused blob: the 507 comes before the fan-out', async () => {
    // The exact failure mode, pinned, because it is the one an operator has to
    // be told the truth about. A refused blob is not stored, and the push
    // socket carries *new entries* — so a revocation refused here reaches
    // nobody, not "everybody who happened to be connected". It has taken effect
    // on the machine it was typed on and on no other.
    const full = env.DIRECTORY.get(env.DIRECTORY.idFromName(`nopush-${crypto.randomUUID()}`))
    const write = (body: Uint8Array): Promise<Response> =>
      full.fetch(DIRECTORY, { method: 'PUT', body, headers: AUTH })
    for (let i = 0; i < MAX_ENTRIES; i++) {
      expect((await write(blob('nopush', String(i)))).status).toBe(201)
    }

    const res = await full.fetch(DIRECTORY, { headers: { Upgrade: 'websocket', ...AUTH } })
    expect(res.status).toBe(101)
    const ws = res.webSocket!
    ;(ws as unknown as { binaryType: string }).binaryType = 'arraybuffer'
    ws.accept()
    const daemon = new Leg(ws)

    let pushed: unknown = null
    // The caught tail is only to keep the harness's own 2 s deadline from
    // rejecting into nobody after this test has passed.
    void daemon
      .next('a push that must not come')
      .then((m) => {
        pushed = m
      })
      .catch(() => {})

    expect((await write(blob('nopush', 'revocation'))).status).toBe(507)
    await sleep(50)
    expect(pushed).toBeNull()
    ws.close()
  })
})
