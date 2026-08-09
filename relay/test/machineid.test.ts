import { env, SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'

import fixture from '../../testdata/relay/machine-ids.json'
import worker, { machineTag, verifyMachineId, type Env } from '../src/index'
import { machineId, TEST_SECRET } from './harness'

const BASE = 'https://relay.example'

/**
 * The machine-id MAC against the shared fixture: internal/config generates
 * testdata/relay/machine-ids.json from the Go mint (`go test
 * ./internal/config/ -update`) and this suite is the other party to the
 * contract — the Worker must derive the same tag from the same (secret, slug)
 * or a daemon's minted id would 404 on its own relay forever.
 */
describe('the machine-id tag against the shared fixture', () => {
  for (const c of fixture.cases) {
    it(`derives ${c.name}: ${c.slug} → ${c.tag}`, async () => {
      expect(await machineTag(c.secret, c.slug)).toBe(c.tag)
      expect(`${c.slug}-${await machineTag(c.secret, c.slug)}`).toBe(c.id)
    })

    it(`verifies ${c.name} as routable under its own secret only`, async () => {
      expect(await verifyMachineId(c.id, c.secret)).toBe(true)
      expect(await verifyMachineId(c.id, `${c.secret}x`)).toBe(false)
    })
  }
})

/** A stub env for router unit tests: every request the rate rule admits ends
 * at a recognisable canned response instead of a real Durable Object. */
function stubEnv(overrides: Partial<Env>): Env {
  return {
    DAEMON_SECRET: TEST_SECRET,
    HUB: {
      idFromName: (name: string) => name,
      get: () => ({ fetch: async () => new Response('reached the hub', { status: 299 }) }),
    },
    ASSETS: { fetch: async () => new Response('spa', { status: 200 }) },
    ...overrides,
  } as unknown as Env
}

const denyAll = { limit: async () => ({ success: false }) }

describe('the rate rule on the credential-less routes', () => {
  it('is bound by wrangler.jsonc for the pool, as it is by the deploy for users', () => {
    // The binding must exist in the test env: wrangler.jsonc's `ratelimits`
    // is the dev twin of the ratelimit binding internal/relaydeploy sends,
    // and a pool without it would be exercising a Worker users never run.
    expect(env.CLIENT_RATE).toBeDefined()
    expect(typeof env.CLIENT_RATE?.limit).toBe('function')
  })

  it('answers 429 on /client when the limiter refuses', async () => {
    const id = await machineId('limited-0a0a')
    const res = await worker.fetch(
      new Request(`${BASE}/client/${id}`, { headers: { Upgrade: 'websocket' } }),
      stubEnv({ CLIENT_RATE: denyAll }),
    )
    expect(res.status).toBe(429)
    expect(await res.json()).toEqual({ error: 'rate limited' })
  })

  it('answers 429 on POST /api/pair when the limiter refuses', async () => {
    const id = await machineId('limited-0b0b')
    const res = await worker.fetch(
      new Request(`${BASE}/api/pair/${id}`, { method: 'POST', body: '{}' }),
      stubEnv({ CLIENT_RATE: denyAll }),
    )
    expect(res.status).toBe(429)
    expect(await res.json()).toEqual({ error: 'rate limited' })
  })

  it('spends no limiter token on a malformed id: the regex reject is free', async () => {
    let calls = 0
    const counting = {
      limit: async () => {
        calls += 1
        return { success: true }
      },
    }
    const res = await worker.fetch(
      new Request(`${BASE}/client/NOT-AN-ID`, { headers: { Upgrade: 'websocket' } }),
      stubEnv({ CLIENT_RATE: counting }),
    )
    expect(res.status).toBe(404)
    expect(calls).toBe(0)
  })

  it('keys the limiter by the connecting IP', async () => {
    const keys: string[] = []
    const recording = {
      limit: async ({ key }: { key: string }) => {
        keys.push(key)
        return { success: true }
      },
    }
    const id = await machineId('keyed-0c0c')
    const res = await worker.fetch(
      new Request(`${BASE}/client/${id}`, {
        headers: { Upgrade: 'websocket', 'CF-Connecting-IP': '203.0.113.9' },
      }),
      stubEnv({ CLIENT_RATE: recording }),
    )
    expect(res.status).toBe(299)
    expect(keys).toEqual(['203.0.113.9'])
  })

  it('does not meter GET /api/pair: a browser following a pairing link is an asset request', async () => {
    const id = await machineId('linked-0d0d')
    const res = await worker.fetch(
      new Request(`${BASE}/api/pair/${id}`),
      stubEnv({ CLIENT_RATE: denyAll }),
    )
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('spa')
  })

  it('does not meter the daemon leg: it is secret-gated, one socket per machine', async () => {
    const id = await machineId('exempt-0e0e')
    const res = await worker.fetch(
      new Request(`${BASE}/daemon/${id}`, {
        headers: { Upgrade: 'websocket', Authorization: `Bearer ${TEST_SECRET}` },
      }),
      stubEnv({ CLIENT_RATE: denyAll }),
    )
    expect(res.status).toBe(299)
  })

  it('fails open when the binding is absent: the rule bounds cost, it is not auth', async () => {
    const id = await machineId('unbound-0f0f')
    const res = await worker.fetch(
      new Request(`${BASE}/client/${id}`, { headers: { Upgrade: 'websocket' } }),
      stubEnv({ CLIENT_RATE: undefined }),
    )
    expect(res.status).toBe(299)
  })
})

describe('the tag check through the real Worker', () => {
  it('routes a fixture id minted under the pool secret', async () => {
    // "test-secret" cases in the fixture are minted under the same secret the
    // pool binds, so the real router accepts them end to end: this is the Go
    // mint dialling the TS verifier. 503 is the empty hub's own refusal —
    // past the router, an object woken, no daemon attached.
    const minted = fixture.cases.find((c) => c.secret === TEST_SECRET)
    expect(minted).toBeDefined()
    const res = await SELF.fetch(`${BASE}/client/${minted?.id}`, {
      headers: { Upgrade: 'websocket' },
    })
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ error: 'daemon offline' })
  })

  it('404s the same slug under the fixture’s other secret: rotation, end to end', async () => {
    const foreign = fixture.cases.find((c) => c.secret !== TEST_SECRET)
    expect(foreign).toBeDefined()
    const res = await SELF.fetch(`${BASE}/client/${foreign?.id}`, {
      headers: { Upgrade: 'websocket' },
    })
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'no such machine' })
  })
})
