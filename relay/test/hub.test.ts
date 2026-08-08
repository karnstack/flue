import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  BASE,
  bytes,
  controlFrame,
  dial,
  encoder,
  frame,
  freshHub,
  handshakeDeadline,
  MACHINE,
  open,
  sleep,
  within,
} from './harness'

/**
 * The handshake deadline the tests below bind for themselves with
 * `handshakeDeadline()`. It is not what vitest.config.ts binds — that is ten
 * minutes, so the reaper only ever fires where a test asked it to.
 */
const TIMEOUT_MS = 50

afterEach(() => {
  vi.restoreAllMocks()
})

describe('channel assignment', () => {
  it('announces a client to the daemon: open{channel: 1, origin} on channel 0', async () => {
    const hub = freshHub()
    const daemon = await dial(hub, `/daemon/${MACHINE}`)
    await dial(hub, `/client/${MACHINE}`)
    expect(await daemon.nextControl()).toEqual({ type: 'open', channel: 1, origin: BASE })
  })

  it('assigns sequential channel ids', async () => {
    const hub = freshHub()
    const daemon = await dial(hub, `/daemon/${MACHINE}`)
    await dial(hub, `/client/${MACHINE}`)
    await dial(hub, `/client/${MACHINE}`)
    expect((await daemon.nextControl()).channel).toBe(1)
    expect((await daemon.nextControl()).channel).toBe(2)
  })
})

describe('forwarding', () => {
  it('wraps client bytes in the channel header on the way to the daemon', async () => {
    const hub = freshHub()
    const daemon = await dial(hub, `/daemon/${MACHINE}`)
    const client = await dial(hub, `/client/${MACHINE}`)
    await daemon.nextControl()
    client.ws.send(Uint8Array.of(0xde, 0xad))
    const f = await daemon.nextFrame()
    expect(f.channel).toBe(1)
    expect(Array.from(f.payload)).toEqual([0xde, 0xad])
  })

  it('strips the header from daemon bytes on the way to the client', async () => {
    const hub = freshHub()
    const daemon = await dial(hub, `/daemon/${MACHINE}`)
    const client = await dial(hub, `/client/${MACHINE}`)
    await daemon.nextControl()
    daemon.ws.send(frame(1, Uint8Array.of(1, 2, 3)))
    expect(bytes(await client.next('bare bytes'))).toEqual([1, 2, 3])
  })

  it('routes a daemon frame to the client that owns the channel', async () => {
    const hub = freshHub()
    const daemon = await dial(hub, `/daemon/${MACHINE}`)
    const c1 = await dial(hub, `/client/${MACHINE}`)
    const c2 = await dial(hub, `/client/${MACHINE}`)
    await daemon.nextControl()
    await daemon.nextControl()
    daemon.ws.send(frame(2, Uint8Array.of(9)))
    daemon.ws.send(frame(1, Uint8Array.of(7)))
    expect(bytes(await c2.next('channel 2 payload'))).toEqual([9])
    expect(bytes(await c1.next('channel 1 payload'))).toEqual([7])
  })

  it('drops a daemon payload for a channel with no socket', async () => {
    const hub = freshHub()
    const daemon = await dial(hub, `/daemon/${MACHINE}`)
    const client = await dial(hub, `/client/${MACHINE}`)
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
    const daemon = await dial(hub, `/daemon/${MACHINE}`)
    const client = await dial(hub, `/client/${MACHINE}`)
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
    const daemon = await dial(hub, `/daemon/${MACHINE}`)
    const client = await dial(hub, `/client/${MACHINE}`)
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
    const daemon = await dial(hub, `/daemon/${MACHINE}`)
    const client = await dial(hub, `/client/${MACHINE}`)
    await daemon.nextControl()
    daemon.ws.send(frame(0, encoder.encode('not json')))
    daemon.ws.send(frame(1, Uint8Array.of(5)))
    expect(bytes(await client.next('the probe after the garbage'))).toEqual([5])
  })
})

describe('text frames', () => {
  it('answers flue-ping on a client leg from the auto-response, socket kept', async () => {
    const hub = freshHub()
    const daemon = await dial(hub, `/daemon/${MACHINE}`)
    const client = await dial(hub, `/client/${MACHINE}`)
    await daemon.nextControl()
    client.ws.send('flue-ping')
    expect(await client.next('the pong')).toBe('flue-pong')
    // Still bridged: the ping was not a protocol error.
    client.ws.send(Uint8Array.of(1))
    expect((await daemon.nextFrame()).channel).toBe(1)
  })

  it('closes a client that sends any other text frame: 1002, daemon hears closed', async () => {
    const hub = freshHub()
    const daemon = await dial(hub, `/daemon/${MACHINE}`)
    const client = await dial(hub, `/client/${MACHINE}`)
    await daemon.nextControl()
    client.ws.send('hello')
    expect((await within(client.closed, 'the client to close')).code).toBe(1002)
    expect(await daemon.nextControl()).toEqual({ type: 'closed', channel: 1 })
  })

  it('closes a daemon that sends a stray text frame: 1002; clients go down 1012', async () => {
    const hub = freshHub()
    const daemon = await dial(hub, `/daemon/${MACHINE}`)
    const client = await dial(hub, `/client/${MACHINE}`)
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
    const daemon = await dial(hub, `/daemon/${MACHINE}`)
    daemon.ws.send(Uint8Array.of(1, 2))
    expect((await within(daemon.closed, 'the daemon to close')).code).toBe(1002)
  })
})

describe('daemon loss and takeover', () => {
  it('daemon disconnect closes every client 1012 "daemon gone"', async () => {
    const hub = freshHub()
    const daemon = await dial(hub, `/daemon/${MACHINE}`)
    const c1 = await dial(hub, `/client/${MACHINE}`)
    const c2 = await dial(hub, `/client/${MACHINE}`)
    daemon.ws.close(1000, 'bye')
    expect(await within(c1.closed, 'c1 to close')).toEqual({ code: 1012, reason: 'daemon gone' })
    expect(await within(c2.closed, 'c2 to close')).toEqual({ code: 1012, reason: 'daemon gone' })
    // And the hub is empty again: the next client is refused at the door.
    const res = await open(hub, `/client/${MACHINE}`)
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ error: 'daemon offline' })
  })

  it('a replacement takes over cleanly: old leg 4000, its clients 1012, no stray closed', async () => {
    const hub = freshHub()
    const first = await dial(hub, `/daemon/${MACHINE}`)
    const c1 = await dial(hub, `/client/${MACHINE}`)
    await first.nextControl()
    const second = await dial(hub, `/daemon/${MACHINE}`)
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
    const c2 = await dial(hub, `/client/${MACHINE}`)
    expect(await second.nextControl()).toEqual({ type: 'open', channel: 2, origin: BASE })
    // Forwarding targets the live daemon, not whichever socket the runtime
    // happens to list first while the old one dies.
    c2.ws.send(Uint8Array.of(42))
    const f = await second.nextFrame()
    expect(f.channel).toBe(2)
    expect(Array.from(f.payload)).toEqual([42])
  })
})

describe('the message-size cap', () => {
  /** Mirrors MAX_CLIENT_MESSAGE in src/hub.ts. */
  const CAP = 1 << 20

  it('closes only the client that sent an oversized frame: 1009, socket kept', async () => {
    const hub = freshHub()
    const daemon = await dial(hub, `/daemon/${MACHINE}`)
    const fat = await dial(hub, `/client/${MACHINE}`)
    const other = await dial(hub, `/client/${MACHINE}`)
    expect((await daemon.nextControl()).channel).toBe(1)
    expect((await daemon.nextControl()).channel).toBe(2)

    fat.ws.send(new Uint8Array(CAP + 1))
    expect(await within(fat.closed, 'the oversized client to close')).toEqual({
      code: 1009,
      reason: 'message too big',
    })
    // The daemon hears the channel go and nothing else — the payload itself was
    // never forwarded, which is the whole point: forwarding it would trip the
    // adapter's read limit and take the shared socket down.
    expect(await daemon.nextControl()).toEqual({ type: 'closed', channel: 1 })

    // The daemon leg and every other browser on it carry on.
    other.ws.send(Uint8Array.of(7))
    const f = await daemon.nextFrame()
    expect(f.channel).toBe(2)
    expect(Array.from(f.payload)).toEqual([7])
    daemon.ws.send(frame(2, Uint8Array.of(8)))
    expect(bytes(await other.next('the payload after the refusal'))).toEqual([8])
  })

  it('forwards a frame exactly at the cap', async () => {
    const hub = freshHub()
    const daemon = await dial(hub, `/daemon/${MACHINE}`)
    const client = await dial(hub, `/client/${MACHINE}`)
    await daemon.nextControl()

    const payload = new Uint8Array(CAP)
    payload[CAP - 1] = 0x5a
    client.ws.send(payload)
    const f = await daemon.nextFrame()
    expect(f.channel).toBe(1)
    expect(f.payload.byteLength).toBe(CAP)
    expect(f.payload[CAP - 1]).toBe(0x5a)
  })
})

describe('the channel cap', () => {
  it('refuses the 65th concurrent client: 503 relay full', async () => {
    const hub = freshHub()
    // None of the 64 clients below ever handshakes. Were the reaper live they
    // would be reaped before the 65th dial, the cap check would find free slots
    // and hand out a 101, and this test would fail for a reason that has nothing
    // to do with the cap — reap-then-accept is the hub behaving correctly. It
    // needs no opt-out to say so any more: the default deadline outlasts every
    // test. The sleep stays as the assertion that it does.
    const daemon = await dial(hub, `/daemon/${MACHINE}`)
    await Promise.all(Array.from({ length: 64 }, () => dial(hub, `/client/${MACHINE}`)))
    await sleep(TIMEOUT_MS + 30)
    const res = await open(hub, `/client/${MACHINE}`)
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ error: 'relay full' })
    daemon.ws.close()
  })
})

describe('hibernation', () => {
  it('bridges across an eviction: attachments and the counter carry the state', async () => {
    const hub = freshHub()
    const daemon = await dial(hub, `/daemon/${MACHINE}`)
    const client = await dial(hub, `/client/${MACHINE}`)
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
    await dial(hub, `/client/${MACHINE}`)
    expect(await daemon.nextControl()).toEqual({ type: 'open', channel: 2, origin: BASE })
  })
})

describe('the handshake deadline', () => {
  it('reaps a client that never sends, tells the daemon, spares one that did', async () => {
    const hub = freshHub()
    await handshakeDeadline(hub, TIMEOUT_MS)
    const daemon = await dial(hub, `/daemon/${MACHINE}`)
    const seen = await dial(hub, `/client/${MACHINE}`) // channel 1
    seen.ws.send(Uint8Array.of(1))
    // Wait for the byte to come out the daemon side before dialing the idle
    // client: the send and the dial travel different paths to the hub, and on
    // a loaded runner the dial can overtake it — the daemon then sees `open 2`
    // before this frame, and the strictly-ordered queue below misreads both.
    await daemon.nextControl()
    await daemon.nextFrame()
    const idle = await dial(hub, `/client/${MACHINE}`) // channel 2
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
    await handshakeDeadline(hub, TIMEOUT_MS)
    const daemon = await dial(hub, `/daemon/${MACHINE}`)
    const b1 = await dial(hub, `/client/${MACHINE}`)
    await sleep(40)
    const b2 = await dial(hub, `/client/${MACHINE}`) // rides b1's pending alarm
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
