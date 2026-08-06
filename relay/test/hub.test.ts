import { env, evictDurableObject, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { decodeFrame, encodeFrame } from '../src/frame'
// Aliased: workers-types also declares a global `Env`, which would shadow a
// bare `Env` inside the augmentation below.
import type { Env as RelayEnv } from '../src/index'

// vitest-pool-workers 0.20 types `env` as `Cloudflare.Env`; teach it our bindings.
declare global {
  namespace Cloudflare {
    interface Env extends RelayEnv {}
  }
}

const BASE = 'https://relay.example'

/** Mirrors the HANDSHAKE_TIMEOUT_MS binding in vitest.config.ts. */
const TIMEOUT_MS = 50

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/**
 * Each test dials its own hub: a fresh DO name sidesteps the shared-instance
 * declaration-order trap the routing tests live with, and lets a test start
 * from "no daemon attached" whenever it wants to.
 */
function freshHub(): DurableObjectStub {
  return env.HUB.get(env.HUB.idFromName(crypto.randomUUID()))
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function within<T>(p: Promise<T>, what: string, ms = 2000): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), ms),
    ),
  ])
}

/** One test-side leg of the relay: buffers messages, exposes the close event. */
class Leg {
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
    const f = await this.nextFrame()
    expect(f.channel).toBe(0)
    return JSON.parse(decoder.decode(f.payload)) as Record<string, unknown>
  }
}

async function dial(stub: DurableObjectStub, path: '/daemon' | '/client'): Promise<Leg> {
  const res = await stub.fetch(`${BASE}${path}`, { headers: { Upgrade: 'websocket' } })
  if (res.status !== 101 || !res.webSocket) throw new Error(`${path} upgrade answered ${res.status}`)
  // The pool's test-side socket defaults to delivering binary as Blob; ask for
  // ArrayBuffer so frames can be decoded synchronously.
  ;(res.webSocket as unknown as { binaryType: string }).binaryType = 'arraybuffer'
  res.webSocket.accept()
  return new Leg(res.webSocket)
}

/** Bytes as the daemon leg lays them out: [4B channel][payload]. */
function frame(channel: number, payload: Uint8Array): ArrayBuffer {
  return encodeFrame(channel, payload)
}

function controlFrame(msg: object): ArrayBuffer {
  return frame(0, encoder.encode(JSON.stringify(msg)))
}

/** A received binary message as a tight ArrayBuffer — the test-side socket
 * may deliver a Uint8Array view rather than the buffer itself. */
function binary(m: string | ArrayBuffer): ArrayBuffer {
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

function bytes(m: string | ArrayBuffer): number[] {
  return Array.from(new Uint8Array(binary(m)))
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('channel assignment', () => {
  it('announces a client to the daemon: open{channel: 1, origin} on channel 0', async () => {
    const hub = freshHub()
    const daemon = await dial(hub, '/daemon')
    await dial(hub, '/client')
    expect(await daemon.nextControl()).toEqual({ type: 'open', channel: 1, origin: BASE })
  })

  it('assigns sequential channel ids', async () => {
    const hub = freshHub()
    const daemon = await dial(hub, '/daemon')
    await dial(hub, '/client')
    await dial(hub, '/client')
    expect((await daemon.nextControl()).channel).toBe(1)
    expect((await daemon.nextControl()).channel).toBe(2)
  })
})

describe('forwarding', () => {
  it('wraps client bytes in the channel header on the way to the daemon', async () => {
    const hub = freshHub()
    const daemon = await dial(hub, '/daemon')
    const client = await dial(hub, '/client')
    await daemon.nextControl()
    client.ws.send(Uint8Array.of(0xde, 0xad))
    const f = await daemon.nextFrame()
    expect(f.channel).toBe(1)
    expect(Array.from(f.payload)).toEqual([0xde, 0xad])
  })

  it('strips the header from daemon bytes on the way to the client', async () => {
    const hub = freshHub()
    const daemon = await dial(hub, '/daemon')
    const client = await dial(hub, '/client')
    await daemon.nextControl()
    daemon.ws.send(frame(1, Uint8Array.of(1, 2, 3)))
    expect(bytes(await client.next('bare bytes'))).toEqual([1, 2, 3])
  })

  it('routes a daemon frame to the client that owns the channel', async () => {
    const hub = freshHub()
    const daemon = await dial(hub, '/daemon')
    const c1 = await dial(hub, '/client')
    const c2 = await dial(hub, '/client')
    await daemon.nextControl()
    await daemon.nextControl()
    daemon.ws.send(frame(2, Uint8Array.of(9)))
    daemon.ws.send(frame(1, Uint8Array.of(7)))
    expect(bytes(await c2.next('channel 2 payload'))).toEqual([9])
    expect(bytes(await c1.next('channel 1 payload'))).toEqual([7])
  })

  it('drops a daemon payload for a channel with no socket', async () => {
    const hub = freshHub()
    const daemon = await dial(hub, '/daemon')
    const client = await dial(hub, '/client')
    await daemon.nextControl()
    daemon.ws.send(frame(99, Uint8Array.of(1)))
    // The leg survives the stray and the next frame still lands.
    daemon.ws.send(frame(1, Uint8Array.of(2)))
    expect(bytes(await client.next('the probe after the stray'))).toEqual([2])
  })
})

describe('the control channel', () => {
  it('close{channel} closes that client: 1000 "daemon closed"', async () => {
    const hub = freshHub()
    const daemon = await dial(hub, '/daemon')
    const client = await dial(hub, '/client')
    await daemon.nextControl()
    daemon.ws.send(controlFrame({ type: 'close', channel: 1 }))
    expect(await within(client.closed, 'the client to close')).toEqual({
      code: 1000,
      reason: 'daemon closed',
    })
  })

  it('a client disconnect tells the daemon closed{channel} and logs the counters', async () => {
    const spy = vi.spyOn(console, 'log')
    const hub = freshHub()
    const daemon = await dial(hub, '/daemon')
    const client = await dial(hub, '/client')
    await daemon.nextControl()
    client.ws.send(Uint8Array.of(1, 2))
    client.ws.send(Uint8Array.of(3, 4, 5))
    await daemon.nextFrame()
    await daemon.nextFrame()
    daemon.ws.send(frame(1, Uint8Array.of(9, 9, 9)))
    await client.next('the daemon payload')
    client.ws.close(1000, 'done')
    expect(await daemon.nextControl()).toEqual({ type: 'closed', channel: 1 })
    const logged = spy.mock.calls
      .map((args) => args[0])
      .filter((a): a is string => typeof a === 'string' && a.startsWith('{'))
      .map((line) => {
        try {
          return JSON.parse(line) as unknown
        } catch {
          return null
        }
      })
    expect(logged).toContainEqual({
      evt: 'channel_closed',
      channel: 1,
      fwdToDaemon: 2,
      fwdToClient: 1,
      bytesToDaemon: 5,
      bytesToClient: 3,
    })
  })

  it('drops malformed control JSON without killing the leg', async () => {
    const hub = freshHub()
    const daemon = await dial(hub, '/daemon')
    const client = await dial(hub, '/client')
    await daemon.nextControl()
    daemon.ws.send(frame(0, encoder.encode('not json')))
    daemon.ws.send(frame(1, Uint8Array.of(5)))
    expect(bytes(await client.next('the probe after the garbage'))).toEqual([5])
  })
})

describe('text frames', () => {
  it('answers flue-ping on a client leg from the auto-response, socket kept', async () => {
    const hub = freshHub()
    const daemon = await dial(hub, '/daemon')
    const client = await dial(hub, '/client')
    await daemon.nextControl()
    client.ws.send('flue-ping')
    expect(await client.next('the pong')).toBe('flue-pong')
    // Still bridged: the ping was not a protocol error.
    client.ws.send(Uint8Array.of(1))
    expect((await daemon.nextFrame()).channel).toBe(1)
  })

  it('closes a client that sends any other text frame: 1002, daemon hears closed', async () => {
    const hub = freshHub()
    const daemon = await dial(hub, '/daemon')
    const client = await dial(hub, '/client')
    await daemon.nextControl()
    client.ws.send('hello')
    expect((await within(client.closed, 'the client to close')).code).toBe(1002)
    expect(await daemon.nextControl()).toEqual({ type: 'closed', channel: 1 })
  })

  it('closes a daemon that sends a stray text frame: 1002; clients go down 1012', async () => {
    const hub = freshHub()
    const daemon = await dial(hub, '/daemon')
    const client = await dial(hub, '/client')
    await daemon.nextControl()
    daemon.ws.send('hello')
    expect((await within(daemon.closed, 'the daemon to close')).code).toBe(1002)
    expect(await within(client.closed, 'the client to close')).toEqual({
      code: 1012,
      reason: 'daemon gone',
    })
  })

  it('closes a daemon that sends a binary frame shorter than the header: 1002', async () => {
    const hub = freshHub()
    const daemon = await dial(hub, '/daemon')
    daemon.ws.send(Uint8Array.of(1, 2))
    expect((await within(daemon.closed, 'the daemon to close')).code).toBe(1002)
  })
})

describe('daemon loss and takeover', () => {
  it('daemon disconnect closes every client 1012 "daemon gone"', async () => {
    const hub = freshHub()
    const daemon = await dial(hub, '/daemon')
    const c1 = await dial(hub, '/client')
    const c2 = await dial(hub, '/client')
    daemon.ws.close(1000, 'bye')
    expect(await within(c1.closed, 'c1 to close')).toEqual({ code: 1012, reason: 'daemon gone' })
    expect(await within(c2.closed, 'c2 to close')).toEqual({ code: 1012, reason: 'daemon gone' })
    // And the hub is empty again: the next client is refused at the door.
    const res = await hub.fetch(`${BASE}/client`, { headers: { Upgrade: 'websocket' } })
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ error: 'daemon offline' })
  })

  it('a replacement takes over cleanly: old leg 4000, its clients 1012, no stray closed', async () => {
    const hub = freshHub()
    const first = await dial(hub, '/daemon')
    const c1 = await dial(hub, '/client')
    await first.nextControl()
    const second = await dial(hub, '/daemon')
    expect(await within(first.closed, 'the old daemon to close')).toEqual({
      code: 4000,
      reason: 'replaced',
    })
    expect(await within(c1.closed, 'the old client to close')).toEqual({
      code: 1012,
      reason: 'daemon gone',
    })
    // The channel counter survives the takeover, and the replacement's first
    // frame is the new client's open — not a stray closed for channel 1, which
    // it never opened.
    const c2 = await dial(hub, '/client')
    expect(await second.nextControl()).toEqual({ type: 'open', channel: 2, origin: BASE })
    // Forwarding targets the live daemon, not whichever socket the runtime
    // happens to list first while the old one dies.
    c2.ws.send(Uint8Array.of(42))
    const f = await second.nextFrame()
    expect(f.channel).toBe(2)
    expect(Array.from(f.payload)).toEqual([42])
  })
})

describe('the channel cap', () => {
  it('refuses the 65th concurrent client: 503 relay full', async () => {
    const hub = freshHub()
    const daemon = await dial(hub, '/daemon')
    await Promise.all(Array.from({ length: 64 }, () => dial(hub, '/client')))
    const res = await hub.fetch(`${BASE}/client`, { headers: { Upgrade: 'websocket' } })
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ error: 'relay full' })
    daemon.ws.close()
  })
})

describe('hibernation', () => {
  it('bridges across an eviction: attachments and the counter carry the state', async () => {
    const hub = freshHub()
    const daemon = await dial(hub, '/daemon')
    const client = await dial(hub, '/client')
    expect(await daemon.nextControl()).toEqual({ type: 'open', channel: 1, origin: BASE })
    client.ws.send(Uint8Array.of(1))
    expect((await daemon.nextFrame()).channel).toBe(1)
    // Tear the instance down with its sockets hibernating: everything the wake
    // needs must come back from attachments and storage, not memory.
    await evictDurableObject(hub)
    client.ws.send(Uint8Array.of(2, 3))
    const f = await daemon.nextFrame()
    expect(f.channel).toBe(1)
    expect(Array.from(f.payload)).toEqual([2, 3])
    daemon.ws.send(frame(1, Uint8Array.of(4)))
    expect(bytes(await client.next('the payload after eviction'))).toEqual([4])
    // The wake re-found the live daemon from its attachment and the next id
    // from the persisted counter.
    await dial(hub, '/client')
    expect(await daemon.nextControl()).toEqual({ type: 'open', channel: 2, origin: BASE })
  })
})

describe('the handshake deadline', () => {
  it('reaps a client that never sends, tells the daemon, spares one that did', async () => {
    const hub = freshHub()
    const daemon = await dial(hub, '/daemon')
    const seen = await dial(hub, '/client') // channel 1
    seen.ws.send(Uint8Array.of(1))
    const idle = await dial(hub, '/client') // channel 2
    await daemon.nextControl()
    await daemon.nextFrame()
    await daemon.nextControl()
    await sleep(TIMEOUT_MS + 30)
    await runDurableObjectAlarm(hub) // a no-op if the real alarm already fired
    expect(await within(idle.closed, 'the idle client to close')).toEqual({
      code: 4001,
      reason: 'handshake timeout',
    })
    expect(await daemon.nextControl()).toEqual({ type: 'closed', channel: 2 })
    // The seen client is spared and still bridged.
    daemon.ws.send(frame(1, Uint8Array.of(7)))
    expect(bytes(await seen.next('the payload after the reap'))).toEqual([7])
    // Nothing unseen remains, so the alarm is not re-armed.
    expect(await runInDurableObject(hub, (_instance, state) => state.storage.getAlarm())).toBeNull()
  })

  it('re-arms while unseen clients remain, then reaps them too', async () => {
    const hub = freshHub()
    const daemon = await dial(hub, '/daemon')
    const b1 = await dial(hub, '/client')
    await sleep(40)
    const b2 = await dial(hub, '/client') // rides b1's pending alarm
    await daemon.nextControl()
    await daemon.nextControl()
    await sleep(25) // past b1's deadline, well before b2's
    await runDurableObjectAlarm(hub)
    expect(await within(b1.closed, 'b1 to close')).toEqual({
      code: 4001,
      reason: 'handshake timeout',
    })
    // b2 is still unseen, so the alarm was re-armed for it.
    expect(
      await runInDurableObject(hub, (_instance, state) => state.storage.getAlarm()),
    ).not.toBeNull()
    await sleep(60)
    await runDurableObjectAlarm(hub)
    expect(await within(b2.closed, 'b2 to close')).toEqual({
      code: 4001,
      reason: 'handshake timeout',
    })
  })
})
