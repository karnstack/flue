// The shared rig for the Durable Object suites: a fresh hub per test, fake
// legs over real WebSockets, and the frame helpers both suites decode with.
//
// Not a `.test.ts` file, so vitest does not collect it — importing one test
// file from another would re-register its describe blocks.

import { env } from 'cloudflare:test'
import { expect } from 'vitest'

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

export const BASE = 'https://relay.example'

export const encoder = new TextEncoder()
export const decoder = new TextDecoder()

/**
 * Each test dials its own hub: a fresh DO name sidesteps the shared-instance
 * declaration-order trap the routing tests live with, and lets a test start
 * from "no daemon attached" whenever it wants to.
 */
export function freshHub(): DurableObjectStub {
  return env.HUB.get(env.HUB.idFromName(crypto.randomUUID()))
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

export async function dial(stub: DurableObjectStub, path: '/daemon' | '/client'): Promise<Leg> {
  const res = await stub.fetch(`${BASE}${path}`, { headers: { Upgrade: 'websocket' } })
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
