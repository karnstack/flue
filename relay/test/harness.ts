// The shared rig for the Durable Object suites: a fresh hub per test, fake
// legs over real WebSockets, and the frame helpers both suites decode with.
//
// Not a `.test.ts` file, so vitest does not collect it — importing one test
// file from another would re-register its describe blocks.

import { env, runInDurableObject } from 'cloudflare:test'
import { expect } from 'vitest'

import { decodeFrame, encodeFrame } from '../src/frame'
// Aliased: workers-types also declares a global `Env`, which would shadow a
// bare `Env` inside the augmentation below.
import { machineIdFrom, machineTag, type Env as RelayEnv } from '../src/index'

// vitest-pool-workers 0.20 types `env` as `Cloudflare.Env`; teach it our bindings.
declare global {
  namespace Cloudflare {
    interface Env extends RelayEnv {}
  }
}

export const BASE = 'https://relay.example'

/** The DAEMON_SECRET the vitest pool binds (vitest.config.ts). Ids the Worker
 * suites dial must carry tags minted under it, or the router 404s them the
 * way it 404s any forged id. */
export const TEST_SECRET = 'test-secret'

/**
 * A MAC-valid machine id for a slug, tagged under the pool's secret — the
 * shared helper every suite mints its ids through, exactly as `flue relay
 * setup`/`join` mint real ones (internal/config, MintMachineID).
 */
export async function machineId(slug: string): Promise<string> {
  return `${slug}-${await machineTag(TEST_SECRET, slug)}`
}

/**
 * The one machine the DO suites live on. Which id is irrelevant to hub
 * internals — the Worker has already picked the object by the time the hub
 * runs — but every dial spells the public shape, so the suites read like the
 * traffic they stand in for: slug, then the MAC tag the router would have
 * verified before any real request reached the hub.
 */
export const MACHINE = await machineId('test-machine-0a1b')

/**
 * The path the hub itself receives for a public machine path. The Worker owns
 * the id: it picks the object with `idFromName(id)` and forwards the bare
 * prefix (src/index.ts). A stub dial skips the Worker, so the harness replays
 * that strip — through the real `machineIdFrom`, so a path the router would
 * 404 fails loudly here instead of as a hub 404 two asserts later.
 */
export function hubPath(path: string): '/daemon' | '/client' | '/api/pair' {
  for (const prefix of ['/daemon', '/client', '/api/pair'] as const) {
    if (machineIdFrom(path, prefix) !== null) return prefix
  }
  throw new Error(`not a machine path: ${path}`)
}

export const encoder = new TextEncoder()
export const decoder = new TextDecoder()

/**
 * Each test dials its own hub: a fresh DO name sidesteps shared-instance
 * state between tests, and lets a test start from "no daemon attached"
 * whenever it wants to. (The Worker suite isolates the same way from the
 * other side of the router: a test that needs an empty hub names a machine
 * id — lonely-0a0a, beta-9f8e — that nothing else in its file dials.)
 */
export function freshHub(): DurableObjectStub {
  return env.HUB.get(env.HUB.idFromName(crypto.randomUUID()))
}

/**
 * Bind one hub's handshake deadline, for the tests that are about reaping.
 *
 * vitest.config.ts binds a deadline no test can outlive, so the reaper never
 * fires behind a test's back; a test that wants it to fire asks here. See that
 * file for why the default runs that way round.
 *
 * Call this *before* anything dials the hub. The deadline is read twice — once
 * to arm the alarm as each client is accepted, once inside `alarm()` to decide
 * who is overdue — and only the second would see a later change, which leaves
 * an alarm armed minutes out and a test waiting on a reap that never lands.
 */
export async function handshakeDeadline(hub: DurableObjectStub, ms: number): Promise<void> {
  await runInDurableObject(hub, (instance) => {
    const withEnv = instance as unknown as { env: Record<string, unknown> }
    withEnv.env = { ...withEnv.env, HANDSHAKE_TIMEOUT_MS: ms }
  })
}

/**
 * Bind one hub's client idle window, for the tests that are about the sweep.
 *
 * The same shape as `handshakeDeadline` above and armed by the same rule: the
 * pool binds a window no test can outlive, so the sweep only ever fires where a
 * test asked for it. Call it before anything dials — the window is read when the
 * alarm runs, and an alarm already armed minutes out is one no later change
 * pulls forward.
 */
export async function idleTimeout(hub: DurableObjectStub, ms: number): Promise<void> {
  await runInDurableObject(hub, (instance) => {
    const withEnv = instance as unknown as { env: Record<string, unknown> }
    withEnv.env = { ...withEnv.env, CLIENT_IDLE_TIMEOUT_MS: ms }
  })
}

/**
 * Bind one hub's pairing deadline, for the tests that are about the 504.
 *
 * Same shape and same rule as the two above. The pairing deadline was the
 * last one still bound short for the whole pool — 250 ms, on the bet that a
 * test's daemon always answers a round trip faster than that — and a loaded
 * CI runner eventually collected on the bet: four pair tests 504ed at once
 * while the runner stalled. Now the pool binds a deadline no test can
 * outlive, and the one test about the timeout binds its own short one here.
 */
export async function pairTimeout(hub: DurableObjectStub, ms: number): Promise<void> {
  await runInDurableObject(hub, (instance) => {
    const withEnv = instance as unknown as { env: Record<string, unknown> }
    withEnv.env = { ...withEnv.env, PAIR_TIMEOUT_MS: ms }
  })
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function within<T>(p: Promise<T>, what: string, ms = 2000): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), ms),
    ),
  ])
}

/** One test-side leg of the relay: buffers messages, exposes the close event. */
export class Leg {
  readonly ws: WebSocket
  readonly closed: Promise<{ code: number; reason: string }>
  private queue: (string | ArrayBuffer)[] = []
  private waiters: ((m: string | ArrayBuffer) => void)[] = []

  constructor(ws: WebSocket) {
    this.ws = ws
    ws.addEventListener('message', (e) => {
      const m = (e as MessageEvent).data as string | ArrayBuffer
      const w = this.waiters.shift()
      if (w) w(m)
      else this.queue.push(m)
    })
    this.closed = new Promise((resolve) => {
      ws.addEventListener('close', (e) => {
        const c = e as CloseEvent
        resolve({ code: c.code, reason: c.reason })
      })
    })
  }

  next(what = 'a message'): Promise<string | ArrayBuffer> {
    const head = this.queue.shift()
    if (head !== undefined) return Promise.resolve(head)
    return within(
      new Promise<string | ArrayBuffer>((resolve) => this.waiters.push(resolve)),
      what,
    )
  }

  async nextFrame(): Promise<{ channel: number; payload: Uint8Array }> {
    return decodeFrame(binary(await this.next('a channel frame')))
  }

  /** The next frame, asserted onto channel 0 and parsed as control JSON. */
  async nextControl(): Promise<Record<string, unknown>> {
    return JSON.parse(decoder.decode(await this.nextControlBytes())) as Record<string, unknown>
  }

  /** The next channel-0 payload, unparsed — for assertions on the exact bytes. */
  async nextControlBytes(): Promise<Uint8Array> {
    const f = await this.nextFrame()
    expect(f.channel).toBe(0)
    return f.payload
  }
}

/** The raw upgrade Response for a machine path — for tests about refusals,
 * where dial's 101-or-throw is the wrong shape. */
export function open(stub: DurableObjectStub, path: string): Promise<Response> {
  return stub.fetch(`${BASE}${hubPath(path)}`, { headers: { Upgrade: 'websocket' } })
}

export async function dial(
  stub: DurableObjectStub,
  path: `/daemon/${string}` | `/client/${string}`,
): Promise<Leg> {
  const res = await open(stub, path)
  if (res.status !== 101 || !res.webSocket) throw new Error(`${path} upgrade answered ${res.status}`)
  // The pool's test-side socket defaults to delivering binary as Blob; ask for
  // ArrayBuffer so frames can be decoded synchronously.
  ;(res.webSocket as unknown as { binaryType: string }).binaryType = 'arraybuffer'
  res.webSocket.accept()
  return new Leg(res.webSocket)
}

/** Bytes as the daemon leg lays them out: [4B channel][payload]. */
export function frame(channel: number, payload: Uint8Array): ArrayBuffer {
  return encodeFrame(channel, payload)
}

export function controlFrame(msg: object): ArrayBuffer {
  return frame(0, encoder.encode(JSON.stringify(msg)))
}

/** A received binary message as a tight ArrayBuffer — the test-side socket
 * may deliver a Uint8Array view rather than the buffer itself. */
export function binary(m: string | ArrayBuffer): ArrayBuffer {
  if (typeof m === 'string') throw new Error(`expected binary, got text ${JSON.stringify(m)}`)
  if (m instanceof ArrayBuffer) return m
  if (ArrayBuffer.isView(m)) {
    const v = m as ArrayBufferView
    return v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength) as ArrayBuffer
  }
  throw new Error(
    `unexpected binary type: ${Object.prototype.toString.call(m)} / ${(m as { constructor?: { name?: string } })?.constructor?.name}`,
  )
}

export function bytes(m: string | ArrayBuffer): number[] {
  return Array.from(new Uint8Array(binary(m)))
}
