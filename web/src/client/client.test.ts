import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  decodeBinary,
  encodeBinary,
  FRAME_INPUT,
  FRAME_OUTPUT,
  PROTOCOL_VERSION,
  type AttachMsg,
  type Attached,
  type CloseMsg,
  type DetachMsg,
  type ErrorMsg,
  type Exit,
  type HelloMsg,
  type ListMsg,
  type ResizeMsg,
  type Sessions,
  type SignalMsg,
  type SizeChanged,
  type SpawnMsg,
  type Welcome,
} from './protocol'
import { daemonSocketUrl, FlueClient, type ConnStatus, type SocketLike } from './client'

const URL_ = 'ws://127.0.0.1:7717/ws'

const utf8 = new TextEncoder()
const text = (b: Uint8Array) => new TextDecoder().decode(b)

/**
 * A scriptable stand-in for WebSocket.
 *
 * Two behaviours are modelled deliberately, because FlueClient has to cope
 * with both and a laxer double would hide it:
 *
 *   - `send` throws while the socket is still connecting, exactly as a real
 *     WebSocket raises InvalidStateError.
 *   - `close` reports at most once, and reports nothing after the peer has
 *     already gone.
 */
class FakeSocket implements SocketLike {
  sent: Array<string | ArrayBuffer> = []
  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onmessage: ((data: string | ArrayBuffer) => void) | null = null

  opened = false
  shut = false

  send(data: string | ArrayBuffer) {
    if (!this.opened) throw new Error('InvalidStateError: the socket is still connecting')
    if (this.shut) return
    this.sent.push(data)
  }

  close() {
    if (this.shut) return
    this.shut = true
    this.onclose?.()
  }

  open() {
    this.opened = true
    this.onopen?.()
  }

  emitControl(msg: unknown) {
    this.onmessage?.(JSON.stringify(msg))
  }

  emitRaw(data: string | ArrayBuffer) {
    this.onmessage?.(data)
  }

  emitBinary(type: number, ref: number, body: string) {
    this.onmessage?.(encodeBinary(type, ref, utf8.encode(body)))
  }

  sentControl(): Array<Record<string, unknown>> {
    return this.sent
      .filter((s): s is string => typeof s === 'string')
      .map((s) => JSON.parse(s) as Record<string, unknown>)
  }

  sentBinary(): ArrayBuffer[] {
    return this.sent.filter((s): s is ArrayBuffer => typeof s !== 'string')
  }
}

function harness() {
  const sockets: FakeSocket[] = []
  const c = new FlueClient(URL_, () => {
    const s = new FakeSocket()
    sockets.push(s)
    return s
  })
  return { c, sockets, last: () => sockets[sockets.length - 1]! }
}

/** A client with one open socket, which is what most cases start from. */
function connected() {
  const h = harness()
  h.c.connect()
  h.sockets[0]!.open()
  return { c: h.c, sock: h.sockets[0]!, sockets: h.sockets, last: h.last }
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('binary framing', () => {
  it('round-trips', () => {
    const buf = encodeBinary(FRAME_OUTPUT, 7, utf8.encode('hi'))
    const got = decodeBinary(buf)
    expect(got.type).toBe(FRAME_OUTPUT)
    expect(got.ref).toBe(7)
    expect(text(got.payload)).toBe('hi')
  })

  it('writes ref big-endian, matching the Go implementation', () => {
    const buf = encodeBinary(FRAME_INPUT, 0x01020304, new Uint8Array())
    expect([...new Uint8Array(buf)]).toEqual([FRAME_INPUT, 1, 2, 3, 4])
  })

  it('carries an empty payload', () => {
    const got = decodeBinary(encodeBinary(FRAME_OUTPUT, 1, new Uint8Array()))
    expect(got.payload.length).toBe(0)
  })

  it('carries the full uint32 ref range', () => {
    const got = decodeBinary(encodeBinary(FRAME_OUTPUT, 0xffffffff, new Uint8Array()))
    expect(got.ref).toBe(0xffffffff)
  })

  it('refuses a ref outside uint32 rather than silently wrapping', () => {
    expect(() => encodeBinary(FRAME_OUTPUT, 0x1_0000_0000, new Uint8Array())).toThrow(/ref/)
    expect(() => encodeBinary(FRAME_OUTPUT, -1, new Uint8Array())).toThrow(/ref/)
  })

  it('rejects a short frame', () => {
    expect(() => decodeBinary(new Uint8Array([0, 1, 2]).buffer)).toThrow()
  })

  it('rejects an unknown frame type, as the Go decoder does', () => {
    expect(() => decodeBinary(new Uint8Array([0x09, 0, 0, 0, 1]).buffer)).toThrow(/frame type/)
  })
})

describe('control message golden file', () => {
  // The same fixture the Go suite decodes, so the two cannot drift. Each case
  // below rebuilds the message as a typed literal and compares it whole:
  //
  //   - a field the fixture has and the interface does not fails toStrictEqual
  //   - a field the interface has and the fixture does not fails the same way
  //   - a field renamed on the TypeScript side fails to compile, because an
  //     object literal may not carry a property its annotation lacks
  //
  // Which is the entire reason the fixture exists.
  //
  // Resolved in two steps rather than with `new URL(..., import.meta.url)`:
  // Vite rewrites that exact expression into an asset reference at transform
  // time, and the fixture lives outside the web project, so it comes back as
  // something readFileSync cannot open.
  const here = dirname(fileURLToPath(import.meta.url))
  const cases: Array<{ name: string; json: unknown }> = JSON.parse(
    readFileSync(resolve(here, '../../../testdata/wire/control.json'), 'utf8'),
  )

  const fixture = (name: string): unknown => {
    const found = cases.find((c) => c.name === name)
    if (!found) throw new Error(`no fixture case named ${name}`)
    return found.json
  }

  it('covers every message the protocol defines, and nothing else', () => {
    expect(cases.map((c) => c.name)).toEqual([
      'hello',
      'list',
      'spawn',
      'attach',
      'detach',
      'resize',
      'signal',
      'close',
      'welcome',
      'sessions',
      'attached',
      'attachedTrunc',
      'exit',
      'sizeChanged',
      'error',
    ])
  })

  it('decodes hello', () => {
    const want: HelloMsg = { type: 'hello', ver: '0.1.0', caps: ['binary'] }
    expect(fixture('hello')).toStrictEqual(want)
  })

  it('decodes list', () => {
    const want: ListMsg = { type: 'list' }
    expect(fixture('list')).toStrictEqual(want)
  })

  it('decodes spawn', () => {
    const want: SpawnMsg = {
      type: 'spawn',
      cwd: '/home/karn/code',
      cmd: ['zsh', '-l'],
      cols: 120,
      rows: 40,
    }
    expect(fixture('spawn')).toStrictEqual(want)
  })

  it('decodes attach', () => {
    const want: AttachMsg = { type: 'attach', id: 'a1b2c3d4e5f60718', lastSeq: 4096 }
    expect(fixture('attach')).toStrictEqual(want)
  })

  it('decodes detach', () => {
    const want: DetachMsg = { type: 'detach', ref: 3 }
    expect(fixture('detach')).toStrictEqual(want)
  })

  it('decodes the dimension-change request', () => {
    const want: ResizeMsg = { type: 'resize', ref: 3, cols: 200, rows: 50, primary: true }
    expect(fixture('resize')).toStrictEqual(want)
  })

  it('decodes signal', () => {
    const want: SignalMsg = { type: 'signal', ref: 3, sig: 'SIGINT' }
    expect(fixture('signal')).toStrictEqual(want)
  })

  it('decodes close', () => {
    const want: CloseMsg = { type: 'close', ref: 3 }
    expect(fixture('close')).toStrictEqual(want)
  })

  it('decodes welcome', () => {
    // `caps` is omitempty on the Go side and absent here, which is why the
    // interface must declare it optional rather than required.
    const want: Welcome = { type: 'welcome', daemonId: 'local', host: 'macbook', ver: '0.1.0' }
    expect(fixture('welcome')).toStrictEqual(want)
  })

  it('decodes sessions, including all nine fields of every record', () => {
    const want: Sessions = {
      type: 'sessions',
      sessions: [
        {
          id: 's1',
          title: 'zsh',
          cwd: '/home/karn/code',
          cmd: ['zsh', '-l'],
          state: 'running',
          exitCode: 0,
          cols: 120,
          rows: 40,
          lastActive: '2026-07-28T10:30:00Z',
        },
        {
          id: 's2',
          title: 'vim',
          cwd: '/home/karn/work',
          cmd: ['vim', 'file.txt'],
          state: 'exited',
          exitCode: 1,
          cols: 80,
          rows: 24,
          lastActive: '2026-07-28T09:00:00Z',
        },
      ],
    }
    expect(fixture('sessions')).toStrictEqual(want)
  })

  it('decodes attached', () => {
    const want: Attached = {
      type: 'attached',
      ref: 3,
      id: 'a1b2c3d4e5f60718',
      cols: 120,
      rows: 40,
      title: 'zsh',
      seq: 4096,
      truncated: false,
      primary: true,
    }
    expect(fixture('attached')).toStrictEqual(want)
  })

  it('decodes a truncated attached', () => {
    const want: Attached = {
      type: 'attached',
      ref: 4,
      id: 'a1b2c3d4e5f60718',
      cols: 120,
      rows: 40,
      title: 'zsh',
      seq: 99000,
      truncated: true,
      primary: false,
    }
    expect(fixture('attachedTrunc')).toStrictEqual(want)
  })

  it('decodes exit', () => {
    const want: Exit = { type: 'exit', ref: 3, code: 130 }
    expect(fixture('exit')).toStrictEqual(want)
  })

  it('decodes a dimension-change notification', () => {
    const want: SizeChanged = { type: 'sizeChanged', ref: 4, cols: 200, rows: 50, primary: false }
    expect(fixture('sizeChanged')).toStrictEqual(want)
  })

  it('decodes error', () => {
    const want: ErrorMsg = {
      type: 'error',
      code: 'unauthenticated',
      msg: 'spawn requires an authenticated connection',
    }
    expect(fixture('error')).toStrictEqual(want)
  })
})

describe('daemonSocketUrl', () => {
  it('follows the page scheme', () => {
    expect(daemonSocketUrl({ protocol: 'http:', host: '127.0.0.1:7717' })).toBe(
      'ws://127.0.0.1:7717/ws',
    )
    expect(daemonSocketUrl({ protocol: 'https:', host: 'flue.example' })).toBe(
      'wss://flue.example/ws',
    )
  })
})

describe('FlueClient handshake', () => {
  it('sends hello on connect', () => {
    const { sock } = connected()
    expect(sock.sentControl()[0]).toStrictEqual({
      type: 'hello',
      ver: PROTOCOL_VERSION,
      caps: ['binary'],
    })
  })

  it('opens one socket even if connect is called twice', () => {
    const { c, sockets } = harness()
    c.connect()
    c.connect()
    expect(sockets).toHaveLength(1)
  })

  it('reports its status without a listener having to be there first', () => {
    const { c, sockets } = harness()
    expect(c.status).toBe('closed')
    c.connect()
    expect(c.status).toBe('connecting')
    sockets[0]!.open()
    expect(c.status).toBe('open')
    c.close()
    expect(c.status).toBe('closed')
  })

  it('announces each status change once', () => {
    const { c, sockets } = harness()
    const seen: ConnStatus[] = []
    c.onStatus((s) => seen.push(s))

    c.connect()
    sockets[0]!.open()
    c.close()

    expect(seen).toEqual(['connecting', 'open', 'closed'])
  })
})

describe('FlueClient output and sequencing', () => {
  it('emits output and tracks lastSeq', () => {
    const { c, sock } = connected()
    const chunks: string[] = []
    c.onOutput((_ref, bytes) => chunks.push(text(bytes)))

    sock.emitControl({
      type: 'attached',
      ref: 1,
      id: 's1',
      cols: 80,
      rows: 24,
      title: '',
      seq: 100,
      truncated: false,
      primary: true,
    })
    sock.emitBinary(FRAME_OUTPUT, 1, 'abc')

    expect(chunks).toEqual(['abc'])
    expect(c.lastSeqFor(1)).toBe(103)
  })

  it('reports truncated so the view can reset the emulator', () => {
    const { c, sock } = connected()
    const seen: boolean[] = []
    c.onAttached((a) => seen.push(a.truncated))

    sock.emitControl({
      type: 'attached',
      ref: 1,
      id: 's1',
      cols: 80,
      rows: 24,
      title: '',
      seq: 5000,
      truncated: true,
      primary: false,
    })

    expect(seen).toEqual([true])
    // seq is the offset of the first byte about to arrive, snapshot or delta
    // alike, so it is the starting point either way.
    expect(c.lastSeqFor(1)).toBe(5000)
  })

  it('ignores an input frame arriving from the daemon', () => {
    const { c, sock } = connected()
    const chunks: string[] = []
    c.onOutput((_ref, bytes) => chunks.push(text(bytes)))
    sock.emitBinary(FRAME_INPUT, 1, 'nope')
    expect(chunks).toEqual([])
  })
})

describe('FlueClient reconnect', () => {
  it('reattaches with lastSeq after a reconnect', async () => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const { c, sockets } = harness()

    c.connect()
    sockets[0]!.open()
    c.attach('s1', 0)
    sockets[0]!.emitControl({
      type: 'attached',
      ref: 1,
      id: 's1',
      cols: 80,
      rows: 24,
      title: '',
      seq: 0,
      truncated: false,
      primary: true,
    })
    sockets[0]!.emitBinary(FRAME_OUTPUT, 1, 'hello')
    expect(c.lastSeqFor(1)).toBe(5)

    // An abnormal close with no close frame is the ordinary shape of the
    // daemon going away, so it takes the same path as any other close.
    sockets[0]!.close()
    await vi.advanceTimersByTimeAsync(2000)
    expect(sockets.length).toBeGreaterThan(1)
    sockets[1]!.open()

    const attach = sockets[1]!.sentControl().find((m) => m.type === 'attach')
    expect(attach).toStrictEqual({ type: 'attach', id: 's1', lastSeq: 5 })
  })

  it('sends attach exactly once when it is issued before the socket opens', () => {
    const { c, sockets } = harness()
    c.connect()
    expect(() => c.attach('s1', 12)).not.toThrow()
    sockets[0]!.open()

    expect(sockets[0]!.sentControl().filter((m) => m.type === 'attach')).toStrictEqual([
      { type: 'attach', id: 's1', lastSeq: 12 },
    ])
  })

  it('does not resurrect an attachment whose session already exited', async () => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const { c, sockets } = harness()

    c.connect()
    sockets[0]!.open()
    c.attach('s1', 0)
    sockets[0]!.emitControl({
      type: 'attached',
      ref: 1,
      id: 's1',
      cols: 80,
      rows: 24,
      title: '',
      seq: 0,
      truncated: false,
      primary: true,
    })
    const exits: Array<[number, number]> = []
    c.onExit((ref, code) => exits.push([ref, code]))
    sockets[0]!.emitControl({ type: 'exit', ref: 1, code: 130 })
    expect(exits).toEqual([[1, 130]])
    expect(c.lastSeqFor(1)).toBeUndefined()

    sockets[0]!.close()
    await vi.advanceTimersByTimeAsync(2000)
    sockets[1]!.open()

    expect(sockets[1]!.sentControl().filter((m) => m.type === 'attach')).toEqual([])
  })

  it('drops a detached session from the reattach plan', async () => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const { c, sockets } = harness()

    c.connect()
    sockets[0]!.open()
    c.attach('s1', 0)
    sockets[0]!.emitControl({
      type: 'attached',
      ref: 1,
      id: 's1',
      cols: 80,
      rows: 24,
      title: '',
      seq: 0,
      truncated: false,
      primary: true,
    })
    c.detach(1)
    expect(sockets[0]!.sentControl()).toContainEqual({ type: 'detach', ref: 1 })

    sockets[0]!.close()
    await vi.advanceTimersByTimeAsync(2000)
    sockets[1]!.open()

    expect(sockets[1]!.sentControl().filter((m) => m.type === 'attach')).toEqual([])
  })

  it('reattaches a session it spawned, which it never called attach for', async () => {
    // The daemon answers spawn with attached and no attach was ever sent, so
    // the reattach plan can only learn about the session from that reply.
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const { c, sockets } = harness()

    c.connect()
    sockets[0]!.open()
    c.spawn({ cols: 80, rows: 24 })
    sockets[0]!.emitControl({
      type: 'attached',
      ref: 1,
      id: 'fresh',
      cols: 80,
      rows: 24,
      title: 'zsh',
      seq: 0,
      truncated: false,
      primary: true,
    })
    sockets[0]!.emitBinary(FRAME_OUTPUT, 1, '$ ')

    sockets[0]!.close()
    await vi.advanceTimersByTimeAsync(125)
    sockets[1]!.open()

    expect(sockets[1]!.sentControl().filter((m) => m.type === 'attach')).toStrictEqual([
      { type: 'attach', id: 'fresh', lastSeq: 2 },
    ])
    // And the spawn is not replayed, or the reconnect would leave two shells.
    expect(sockets[1]!.sentControl().filter((m) => m.type === 'spawn')).toEqual([])
  })

  it('keeps a session in the reattach plan while another ref still holds it', async () => {
    // Two panes on one session is legal, and the plan is keyed by session ID
    // rather than by ref. Letting go of one pane must not strand the other.
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const { c, sockets } = harness()

    c.connect()
    sockets[0]!.open()
    c.attach('s1', 0)
    for (const ref of [1, 2]) {
      sockets[0]!.emitControl({
        type: 'attached',
        ref,
        id: 's1',
        cols: 80,
        rows: 24,
        title: '',
        seq: 0,
        truncated: false,
        primary: ref === 1,
      })
    }
    sockets[0]!.emitBinary(FRAME_OUTPUT, 1, 'abcd')
    c.detach(2)

    sockets[0]!.close()
    await vi.advanceTimersByTimeAsync(125)
    sockets[1]!.open()

    expect(sockets[1]!.sentControl().filter((m) => m.type === 'attach')).toStrictEqual([
      { type: 'attach', id: 's1', lastSeq: 4 },
    ])
  })

  it('backs off exponentially between reconnect attempts', async () => {
    vi.useFakeTimers()
    // Full jitter multiplies the delay by 0.5..1.0; pinning the low end makes
    // the schedule exact, so this measures the backoff rather than sampling it.
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const { c, sockets } = harness()

    c.connect()
    sockets[0]!.open()
    sockets[0]!.close()

    // First delay: 250 * 2^0 * 0.5.
    await vi.advanceTimersByTimeAsync(124)
    expect(sockets).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(sockets).toHaveLength(2)

    // Second: 250 * 2^1 * 0.5, strictly longer than the first.
    sockets[1]!.close()
    await vi.advanceTimersByTimeAsync(249)
    expect(sockets).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(sockets).toHaveLength(3)
  })

  it('caps the delay so a long outage still retries about every ten seconds', async () => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(1)
    const { c, sockets } = harness()

    c.connect()
    for (let i = 0; i < 40; i++) {
      sockets[sockets.length - 1]!.close()
      await vi.advanceTimersByTimeAsync(10_000)
      expect(sockets).toHaveLength(i + 2)
    }
  })

  it('restarts the backoff after a connection that succeeded', async () => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const { c, sockets } = harness()

    c.connect()
    sockets[0]!.open()
    sockets[0]!.close()
    await vi.advanceTimersByTimeAsync(125)
    sockets[1]!.close() // never opened, so this attempt is the second
    await vi.advanceTimersByTimeAsync(250)
    expect(sockets).toHaveLength(3)

    sockets[2]!.open() // a good connection resets the run of failures
    sockets[2]!.close()
    await vi.advanceTimersByTimeAsync(125)
    expect(sockets).toHaveLength(4)
  })

  it('stops reconnecting when close lands during the backoff wait', async () => {
    vi.useFakeTimers()
    const { c, sockets } = harness()

    c.connect()
    sockets[0]!.open()
    sockets[0]!.close()
    expect(c.status).toBe('reconnecting')

    c.close()
    await vi.advanceTimersByTimeAsync(120_000)

    expect(sockets).toHaveLength(1)
    expect(c.status).toBe('closed')
  })

  it('ignores a socket it has already replaced', async () => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const { c, sockets } = harness()

    c.connect()
    sockets[0]!.open()
    sockets[0]!.close()
    await vi.advanceTimersByTimeAsync(125)
    sockets[1]!.open()
    expect(sockets).toHaveLength(2)

    // A late event from the abandoned socket must not schedule a second
    // reconnect, nor be mistaken for traffic on the live one.
    const errs: string[] = []
    c.onError((e) => errs.push(e.code))
    sockets[0]!.onclose?.()
    sockets[0]!.onmessage?.(JSON.stringify({ type: 'error', code: 'ghost', msg: '' }))
    await vi.advanceTimersByTimeAsync(120_000)

    expect(sockets).toHaveLength(2)
    expect(errs).toEqual([])
  })

  it('reconnects again after a close followed by a fresh connect', () => {
    const { c, sockets } = harness()
    c.connect()
    sockets[0]!.open()
    c.close()
    c.connect()
    expect(sockets).toHaveLength(2)
    expect(c.status).toBe('connecting')
  })

  it('connects at once after a close made mid-backoff, on no leftover timer', async () => {
    vi.useFakeTimers()
    const { c, sockets } = harness()

    c.connect()
    sockets[0]!.open()
    sockets[0]!.close()
    expect(c.status).toBe('reconnecting')

    c.close()
    c.connect()

    // A retry left armed across the close would both delay this and, once it
    // finally fired, open a second socket alongside the live one.
    expect(sockets).toHaveLength(2)
    expect(c.status).toBe('connecting')
    await vi.advanceTimersByTimeAsync(120_000)
    expect(sockets).toHaveLength(2)
  })
})

describe('FlueClient sending', () => {
  it('encodes input as a binary frame', () => {
    const { c, sock } = connected()
    c.sendInput(3, utf8.encode('k'))

    const bin = sock.sentBinary()[0]
    expect(bin).toBeDefined()
    const got = decodeBinary(bin!)
    expect(got.type).toBe(FRAME_INPUT)
    expect(got.ref).toBe(3)
    expect(text(got.payload)).toBe('k')
  })

  it('drops keystrokes typed while the socket is down instead of replaying them', async () => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const { c, sockets } = harness()

    c.connect()
    expect(() => c.sendInput(1, utf8.encode('rm -rf /\r'))).not.toThrow()
    sockets[0]!.open()
    expect(sockets[0]!.sentBinary()).toEqual([])

    sockets[0]!.close()
    expect(() => c.sendInput(1, utf8.encode('more\r'))).not.toThrow()
    await vi.advanceTimersByTimeAsync(125)
    sockets[1]!.open()
    expect(sockets[1]!.sentBinary()).toEqual([])
  })

  it('holds a session-free request issued before the socket opens', () => {
    const { c, sockets } = harness()
    c.connect()
    expect(() => c.list()).not.toThrow()
    expect(() => c.spawn({ cols: 80, rows: 24 })).not.toThrow()
    sockets[0]!.open()

    expect(sockets[0]!.sentControl()).toStrictEqual([
      { type: 'hello', ver: PROTOCOL_VERSION, caps: ['binary'] },
      { type: 'list' },
      { type: 'spawn', cols: 80, rows: 24 },
    ])
  })

  it('drops a ref-bearing request issued while the socket is down', async () => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const { c, sockets } = harness()

    c.connect()
    sockets[0]!.open()
    sockets[0]!.close()
    // Refs belong to one connection. Replaying these after a reconnect would
    // aim them at whatever the daemon numbered 1 the second time round.
    expect(() => c.resize(1, 80, 24, true)).not.toThrow()
    expect(() => c.signal(1, 'SIGINT')).not.toThrow()
    expect(() => c.closeSession(1)).not.toThrow()
    expect(() => c.detach(1)).not.toThrow()

    await vi.advanceTimersByTimeAsync(125)
    sockets[1]!.open()
    expect(sockets[1]!.sentControl().map((m) => m.type)).toEqual(['hello'])
  })

  it('sends the remaining control messages the protocol defines', () => {
    const { c, sock } = connected()
    c.list()
    c.spawn({ cwd: '/tmp', cmd: ['zsh', '-l'], cols: 120, rows: 40 })
    c.resize(3, 200, 50, true)
    c.signal(3, 'SIGINT')
    c.closeSession(3)

    expect(sock.sentControl().slice(1)).toStrictEqual([
      { type: 'list' },
      { type: 'spawn', cwd: '/tmp', cmd: ['zsh', '-l'], cols: 120, rows: 40 },
      { type: 'resize', ref: 3, cols: 200, rows: 50, primary: true },
      { type: 'signal', ref: 3, sig: 'SIGINT' },
      { type: 'close', ref: 3 },
    ])
  })

  it('bounds how much it will hold for a daemon that never comes back', () => {
    const { c, sockets } = harness()
    c.connect()
    for (let i = 0; i < 500; i++) c.list()
    sockets[0]!.open()
    // hello plus a bounded queue, not five hundred.
    expect(sockets[0]!.sentControl().length).toBeLessThanOrEqual(65)
  })
})

describe('FlueClient control messages', () => {
  it('surfaces server errors', () => {
    const { c, sock } = connected()
    const errs: string[] = []
    c.onError((e) => errs.push(e.code))
    sock.emitControl({ type: 'error', code: 'not_found', msg: 'no such session' })
    expect(errs).toEqual(['not_found'])
  })

  it('exposes the session list', () => {
    const { c, sock } = connected()
    const seen: string[][] = []
    c.onSessions((list) => seen.push(list.map((s) => s.id)))
    sock.emitControl({
      type: 'sessions',
      sessions: [
        {
          id: 's1',
          title: 'zsh',
          cwd: '/tmp',
          cmd: ['zsh'],
          state: 'running',
          exitCode: 0,
          cols: 80,
          rows: 24,
          lastActive: '2026-07-28T00:00:00Z',
        },
      ],
    })
    expect(seen).toEqual([['s1']])
  })

  it('delivers a dimension change for a ref it knows', () => {
    const { c, sock } = connected()
    const seen: SizeChanged[] = []
    c.onSizeChanged((m) => seen.push(m))
    sock.emitControl({
      type: 'attached',
      ref: 4,
      id: 's1',
      cols: 80,
      rows: 24,
      title: '',
      seq: 0,
      truncated: false,
      primary: false,
    })
    sock.emitControl({ type: 'sizeChanged', ref: 4, cols: 200, rows: 50, primary: true })

    expect(seen).toHaveLength(1)
    expect(seen[0]!.cols).toBe(200)
  })

  it('ignores a dimension change that overtakes its own attached', () => {
    // The daemon registers a ref before it enqueues attached, so another
    // connection broadcasting new dimensions can reach this one first. The
    // attached that follows carries the current dimensions anyway.
    const { c, sock } = connected()
    const seen: SizeChanged[] = []
    c.onSizeChanged((m) => seen.push(m))
    expect(() =>
      sock.emitControl({ type: 'sizeChanged', ref: 9, cols: 200, rows: 50, primary: true }),
    ).not.toThrow()
    expect(seen).toEqual([])
  })

  it('ignores an exit for a ref it does not hold', () => {
    const { c, sock } = connected()
    const seen: number[] = []
    c.onExit((ref) => seen.push(ref))
    expect(() => sock.emitControl({ type: 'exit', ref: 9, code: 0 })).not.toThrow()
    expect(seen).toEqual([])
  })

  it('ignores welcome and any message type it does not know', () => {
    const { c, sock } = connected()
    const errs: string[] = []
    c.onError((e) => errs.push(e.code))
    expect(() =>
      sock.emitControl({ type: 'welcome', daemonId: 'local', host: 'mb', ver: '0.1.0' }),
    ).not.toThrow()
    expect(() => sock.emitControl({ type: 'somethingNewer', x: 1 })).not.toThrow()
    expect(errs).toEqual([])
  })

  it('reports a frame it cannot parse instead of throwing out of the socket', () => {
    const { c, sock } = connected()
    const errs: ErrorMsg[] = []
    c.onError((e) => errs.push(e))

    expect(() => sock.emitRaw('{ not json')).not.toThrow()
    expect(() => sock.emitRaw(new Uint8Array([1, 2]).buffer)).not.toThrow()

    expect(errs.map((e) => e.code)).toEqual(['bad_payload', 'bad_payload'])
  })

  it('surfaces lagged as an ordinary error, not a signal of its own', () => {
    // The daemon drops a whole backlogged connection now, so this arrives
    // rarely if ever; recovery is the reconnect path, not a special case here.
    const { c, sock } = connected()
    const errs: string[] = []
    c.onError((e) => errs.push(e.code))
    sock.emitControl({ type: 'error', code: 'lagged', msg: 'fell behind' })
    expect(errs).toEqual(['lagged'])
  })
})

describe('FlueClient listeners', () => {
  it('delivers to every registered listener, never just the last one', () => {
    const { c, sock } = connected()
    const first: string[] = []
    const second: string[] = []
    c.onError((e) => first.push(e.code))
    c.onError((e) => second.push(e.code))

    sock.emitControl({ type: 'error', code: 'not_found', msg: 'no such session' })

    expect(first).toEqual(['not_found'])
    expect(second).toEqual(['not_found'])
  })

  it('stops delivering after unsubscribe', () => {
    const { c, sock } = connected()
    const seen: string[] = []
    const off = c.onError((e) => seen.push(e.code))

    sock.emitControl({ type: 'error', code: 'first', msg: '' })
    off()
    sock.emitControl({ type: 'error', code: 'second', msg: '' })

    expect(seen).toEqual(['first'])
  })

  it('lets a listener unsubscribe itself mid-delivery', () => {
    const { c, sock } = connected()
    const seen: string[] = []
    const off = c.onError((e) => {
      seen.push(e.code)
      off()
    })
    c.onError((e) => seen.push(`b:${e.code}`))

    sock.emitControl({ type: 'error', code: 'one', msg: '' })
    sock.emitControl({ type: 'error', code: 'two', msg: '' })

    expect(seen).toEqual(['one', 'b:one', 'b:two'])
  })

  it('unsubscribes only the listener that asked, even if two are identical', () => {
    const { c, sock } = connected()
    let calls = 0
    const cb = () => {
      calls++
    }
    const off = c.onError(cb)
    c.onError(cb)
    off()

    sock.emitControl({ type: 'error', code: 'x', msg: '' })
    expect(calls).toBe(1)
  })

  it('registers every kind of listener and hands back an unsubscribe', () => {
    const { c } = connected()
    for (const off of [
      c.onOutput(() => {}),
      c.onAttached(() => {}),
      c.onExit(() => {}),
      c.onSizeChanged(() => {}),
      c.onSessions(() => {}),
      c.onError(() => {}),
      c.onStatus(() => {}),
    ]) {
      expect(typeof off).toBe('function')
      off()
    }
  })
})
