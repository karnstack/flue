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
  type DeviceList,
  type DevicesMsg,
  type ErrorMsg,
  type Exit,
  type HelloMsg,
  type ListMsg,
  type PairCancelMsg,
  type Pairing,
  type PairStartMsg,
  type ResizeMsg,
  type Revoked,
  type RevokeMsg,
  type Sessions,
  type SignalMsg,
  type SizeChanged,
  type SpawnMsg,
  type UpdateMsg,
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
      'update',
      'updateTagsAndPinned',
      'updateClearTags',
      'updateClearName',
      'devices',
      'revoke',
      'pairStart',
      'pairCancel',
      'welcome',
      'welcomeRelay',
      'welcomeRelayConnecting',
      'sessions',
      'attached',
      'attachedTrunc',
      'exit',
      'sizeChanged',
      'error',
      'errorForRequest',
      'deviceList',
      'deviceListEmpty',
      'pairing',
      'revoked',
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
      reqId: 6,
    }
    expect(fixture('spawn')).toStrictEqual(want)
  })

  it('decodes attach', () => {
    const want: AttachMsg = {
      type: 'attach',
      id: 'a1b2c3d4e5f60718',
      lastSeq: 4096,
      reqId: 7,
    }
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

  // The four update cases exist to pin partiality in both directions. An
  // absent field means "leave this alone", so a decoder that filled the gap
  // with a zero value would rename a session every time somebody pinned it.
  it('decodes an update carrying one field, the other two absent', () => {
    const want: UpdateMsg = { type: 'update', id: 'a1b2c3d4e5f60708', name: 'api server' }
    expect(fixture('update')).toStrictEqual(want)
  })

  it('decodes an update carrying tags and pinned together', () => {
    const want: UpdateMsg = {
      type: 'update',
      id: 'a1b2c3d4e5f60708',
      tags: ['api', 'feat-x'],
      pinned: true,
    }
    expect(fixture('updateTagsAndPinned')).toStrictEqual(want)
  })

  it('decodes an update clearing tags as [], not as an absent field', () => {
    // The distinction the whole message rests on: `[]` says the user removed
    // the last tag, absent says this edit was never about tags. A codec that
    // let the empty array fall out on either side would make the last tag
    // impossible to remove, silently.
    const want: UpdateMsg = { type: 'update', id: 'a1b2c3d4e5f60708', tags: [] }
    const got = fixture('updateClearTags') as UpdateMsg
    expect(got).toStrictEqual(want)
    expect(got.tags).toEqual([])
    expect('tags' in got).toBe(true)
  })

  it('decodes an update clearing a name and unpinning', () => {
    // The same hazard as an empty `tags`, in the two shapes JSON makes easy to
    // drop: `""` and `false`. Both are edits a user asks for by hand, so both
    // have to survive a round trip that an omitempty on the wrong side of the
    // Go struct would quietly eat.
    const want: UpdateMsg = { type: 'update', id: 'a1b2c3d4e5f60708', name: '', pinned: false }
    const got = fixture('updateClearName') as UpdateMsg
    expect(got).toStrictEqual(want)
    expect(got.name).toBe('')
    expect(got.pinned).toBe(false)
  })

  it('decodes devices', () => {
    const want: DevicesMsg = { type: 'devices' }
    expect(fixture('devices')).toStrictEqual(want)
  })

  it('decodes revoke', () => {
    const want: RevokeMsg = { type: 'revoke', deviceId: 'd1b2c3d4e5f60718' }
    expect(fixture('revoke')).toStrictEqual(want)
  })

  it('decodes pairStart', () => {
    const want: PairStartMsg = { type: 'pairStart' }
    expect(fixture('pairStart')).toStrictEqual(want)
  })

  it('decodes pairCancel', () => {
    const want: PairCancelMsg = { type: 'pairCancel' }
    expect(fixture('pairCancel')).toStrictEqual(want)
  })

  it('decodes welcome', () => {
    // `caps` is omitempty on the Go side and absent here, which is why the
    // interface must declare it optional rather than required.
    const want: Welcome = { type: 'welcome', daemonId: 'local', host: 'macbook', ver: '0.1.0' }
    expect(fixture('welcome')).toStrictEqual(want)
  })

  it('decodes welcome with a live relay', () => {
    const want: Welcome = {
      type: 'welcome',
      daemonId: 'local',
      host: 'macbook',
      ver: '0.1.0',
      relay: {
        status: 'connected',
        origin: 'https://flue-relay.karn.workers.dev',
        machineId: 'karns-macbook-pro-a1b2',
        machineName: "Karn's MacBook Pro",
      },
    }
    expect(fixture('welcomeRelay')).toStrictEqual(want)
  })

  it('decodes welcome while the relay is still dialling', () => {
    // `origin` is omitempty on the Go side and absent here: nothing is
    // reachable through a socket that is not up, so there is no address to
    // name. The interface must declare it optional for the same reason `caps`
    // is.
    const want: Welcome = {
      type: 'welcome',
      daemonId: 'local',
      host: 'macbook',
      ver: '0.1.0',
      relay: { status: 'connecting' },
    }
    expect(fixture('welcomeRelayConnecting')).toStrictEqual(want)
  })

  // The two records are deliberately unalike in their metadata: one named,
  // tagged and pinned, one carrying the empty values a freshly spawned
  // session has. An empty `tags` is the case worth pinning — a daemon that
  // let it marshal as null would put a guard in every consumer.
  it('decodes sessions, including all thirteen fields of every record', () => {
    const want: Sessions = {
      type: 'sessions',
      sessions: [
        {
          id: 's1',
          title: 'zsh',
          name: 'api server',
          tags: ['api', 'prod'],
          pinned: true,
          cwd: '/home/karn/code',
          cmd: ['zsh', '-l'],
          state: 'running',
          exitCode: 0,
          cols: 120,
          rows: 40,
          createdAt: '2026-07-28T08:00:00Z',
          lastActive: '2026-07-28T10:30:00Z',
        },
        {
          id: 's2',
          title: 'vim',
          name: '',
          tags: [],
          pinned: false,
          cwd: '/home/karn/work',
          cmd: ['vim', 'file.txt'],
          state: 'exited',
          exitCode: 1,
          cols: 80,
          rows: 24,
          createdAt: '2026-07-28T07:15:00Z',
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
      head: 8192,
      truncated: false,
      primary: true,
      reqId: 7,
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
      head: 99512,
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

  it('decodes an error answering a request', () => {
    const want: ErrorMsg = {
      type: 'error',
      code: 'not_found',
      msg: 'no such session',
      reqId: 7,
    }
    expect(fixture('errorForRequest')).toStrictEqual(want)
  })

  it('decodes deviceList, including all four fields of every record', () => {
    const want: DeviceList = {
      type: 'deviceList',
      devices: [
        {
          id: 'd1b2c3d4e5f60718',
          label: 'iPhone',
          pairedAt: 1754380800,
          lastSeen: 1754384400,
        },
        {
          id: 'd9a8b7c6d5e4f302',
          label: 'iPad',
          pairedAt: 1754294400,
          lastSeen: 1754298000,
        },
      ],
    }
    expect(fixture('deviceList')).toStrictEqual(want)
  })

  it('decodes an empty deviceList as [], not null', () => {
    // `devices` is not omitempty on the Go side, and a daemon with nothing
    // paired sends `[]`: a nil slice would marshal to null and every consumer
    // that maps over the list would throw. This case pins the shape; what
    // enforces it for values a producer builds rather than writes down is
    // `DeviceList.MarshalJSON`, covered by TestDeviceListEncodesEmptyAsArray.
    const want: DeviceList = { type: 'deviceList', devices: [] }
    expect(fixture('deviceListEmpty')).toStrictEqual(want)
  })

  it('decodes pairing', () => {
    const want: Pairing = {
      type: 'pairing',
      token: 'Zm91cnRlZW4tY2hhcnM',
      url: 'https://macbook.local:7717/pair?t=Zm91cnRlZW4tY2hhcnM&k=3p7bfXt9wbTTW2HC7OQ1Nz-DQ8hG6YwjhyZxaYQpb8k',
      daemonPub: '3p7bfXt9wbTTW2HC7OQ1Nz+DQ8hG6YwjhyZxaYQpb8k=',
      expiresAt: 1754384520,
    }
    expect(fixture('pairing')).toStrictEqual(want)
  })

  it('decodes revoked', () => {
    const want: Revoked = { type: 'revoked', reason: 'revoked by another device' }
    expect(fixture('revoked')).toStrictEqual(want)
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
      head: 100,
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
      head: 5000,
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
      head: 0,
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
    expect(attach).toStrictEqual({ type: 'attach', id: 's1', lastSeq: 5, reqId: 2 })
  })

  it('sends attach exactly once when it is issued before the socket opens', () => {
    const { c, sockets } = harness()
    c.connect()
    expect(() => c.attach('s1', 12)).not.toThrow()
    sockets[0]!.open()

    expect(sockets[0]!.sentControl().filter((m) => m.type === 'attach')).toStrictEqual([
      { type: 'attach', id: 's1', lastSeq: 12, reqId: 1 },
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
      head: 0,
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
      head: 0,
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
      head: 0,
      truncated: false,
      primary: true,
    })
    sockets[0]!.emitBinary(FRAME_OUTPUT, 1, '$ ')

    sockets[0]!.close()
    await vi.advanceTimersByTimeAsync(125)
    sockets[1]!.open()

    expect(sockets[1]!.sentControl().filter((m) => m.type === 'attach')).toStrictEqual([
      { type: 'attach', id: 'fresh', lastSeq: 2, reqId: 2 },
    ])
    // And the spawn is not replayed, or the reconnect would leave two shells.
    expect(sockets[1]!.sentControl().filter((m) => m.type === 'spawn')).toEqual([])
  })

  it('retires a session detached while the socket was down', async () => {
    // The refs are gone by then, so the ref -> session mapping has to outlive
    // the connection it came from. Without it the plan keeps the session for
    // the life of the tab: every reconnect reattaches something nobody is
    // watching, and no later call can name it, because the only handle the
    // view ever had was that ref.
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
      head: 0,
      truncated: false,
      primary: true,
    })

    sockets[0]!.close()
    c.detach(1) // the view unmounts mid-outage, holding only its ref
    await vi.advanceTimersByTimeAsync(125)
    sockets[1]!.open()

    expect(sockets[1]!.sentControl().filter((m) => m.type === 'attach')).toEqual([])
  })

  it('retires a session by name, for a view that never got a ref', async () => {
    // An attach answered with not_found leaves nothing to detach, and the
    // error carries no id to match it against, so the plan would otherwise ask
    // for a session that no longer exists on every reconnect, forever.
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const { c, sockets } = harness()

    c.connect()
    sockets[0]!.open()
    c.attach('gone', 0)
    sockets[0]!.emitControl({ type: 'error', code: 'not_found', msg: 'no such session', reqId: 1 })
    c.forget('gone')

    sockets[0]!.close()
    await vi.advanceTimersByTimeAsync(125)
    sockets[1]!.open()

    expect(sockets[1]!.sentControl().filter((m) => m.type === 'attach')).toEqual([])
  })

  it('ignores a detach naming a ref the session has since been renumbered off', async () => {
    // The daemon numbers from 1 again each connection and skips the sessions
    // that have gone, so a session can come back under a ref another session
    // used to hold. A view still holding the old number must not be able to
    // retire the live attachment with it.
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const { c, sockets } = harness()

    c.connect()
    sockets[0]!.open()
    c.attach('s1', 0)
    c.attach('s2', 0)
    sockets[0]!.emitControl({
      type: 'attached',
      ref: 1,
      id: 's1',
      cols: 80,
      rows: 24,
      title: '',
      seq: 0,
      head: 0,
      truncated: false,
      primary: true,
    })
    sockets[0]!.emitControl({
      type: 'attached',
      ref: 2,
      id: 's2',
      cols: 80,
      rows: 24,
      title: '',
      seq: 0,
      head: 0,
      truncated: false,
      primary: false,
    })
    c.detach(1) // s1 is let go, so the reconnect only asks for s2

    sockets[0]!.close()
    await vi.advanceTimersByTimeAsync(125)
    sockets[1]!.open()
    sockets[1]!.emitControl({
      type: 'attached',
      ref: 1, // s2, renumbered
      id: 's2',
      cols: 80,
      rows: 24,
      title: '',
      seq: 0,
      head: 0,
      truncated: false,
      primary: true,
    })

    c.detach(2) // a view that never noticed the reconnect
    expect(sockets[1]!.sentControl()).not.toContainEqual({ type: 'detach', ref: 2 })

    sockets[1]!.close()
    await vi.advanceTimersByTimeAsync(250)
    sockets[2]!.open()
    expect(sockets[2]!.sentControl().filter((m) => m.type === 'attach')).toStrictEqual([
      { type: 'attach', id: 's2', lastSeq: 0, reqId: 4 },
    ])
  })

  it('refuses an attached that lands after the session was forgotten', async () => {
    // A view unmounting inside the attach round-trip follows the documented
    // cleanup and calls forget. If the reply then re-seeded the plan, the tab
    // would reattach that session on every reconnect with nothing behind it —
    // the exact abandoned attachment forget exists to prevent.
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const { c, sockets } = harness()
    const seen: string[] = []

    c.connect()
    sockets[0]!.open()
    c.onAttached((a) => seen.push(a.id))
    c.attach('s1', 0)
    c.forget('s1')
    sockets[0]!.emitControl({
      type: 'attached',
      ref: 1,
      id: 's1',
      cols: 80,
      rows: 24,
      title: '',
      seq: 0,
      head: 0,
      truncated: false,
      primary: true,
      reqId: 1,
    })

    // Adopted by nobody, and handed straight back.
    expect(seen).toEqual([])
    expect(c.lastSeqFor(1)).toBeUndefined()
    expect(sockets[0]!.sentControl()).toContainEqual({ type: 'detach', ref: 1 })

    sockets[0]!.close()
    await vi.advanceTimersByTimeAsync(125)
    sockets[1]!.open()
    expect(sockets[1]!.sentControl().filter((m) => m.type === 'attach')).toEqual([])
  })

  it('adopts only the second reply when a view re-attaches inside the round-trip', () => {
    // React's StrictMode runs every mount effect twice — mount, clean up,
    // mount — so attach / forget / attach inside one round-trip is not an edge
    // case, it is what development does on every single mount.
    //
    // The daemon answers each attach, so two replies come back. Refusing "the
    // session" rather than "one outstanding reply" adopted both: onAttached
    // fired twice for one view, and the first ref stayed attached and stayed
    // primary on the daemon until the socket dropped.
    const { c, sock } = connected()
    const seen: number[] = []
    c.onAttached((a) => seen.push(a.ref))

    c.attach('s1', 0)
    c.forget('s1')
    c.attach('s1', 0)
    for (const ref of [1, 2]) {
      sock.emitControl({
        type: 'attached',
        ref,
        id: 's1',
        cols: 80,
        rows: 24,
        title: '',
        seq: 0,
        head: 0,
        truncated: false,
        primary: ref === 1,
        reqId: ref,
      })
    }

    expect(seen).toEqual([2])
    expect(c.lastSeqFor(1)).toBeUndefined()
    expect(c.lastSeqFor(2)).toBe(0)
    expect(sock.sentControl()).toContainEqual({ type: 'detach', ref: 1 })
    expect(sock.sentControl()).not.toContainEqual({ type: 'detach', ref: 2 })
  })

  it('does not let a forget with nothing outstanding refuse a later reply', () => {
    // forget names a session, not a reply, so a count that simply grew on
    // every call would eat the answer to an attach issued long afterwards —
    // a terminal that silently never attaches, with no error anywhere.
    const { c, sock } = connected()
    const seen: number[] = []
    c.onAttached((a) => seen.push(a.ref))

    c.attach('s1', 0)
    sock.emitControl({
      type: 'attached',
      ref: 1,
      id: 's1',
      cols: 80,
      rows: 24,
      title: '',
      seq: 0,
      head: 0,
      truncated: false,
      primary: true,
    })
    c.forget('s1') // nothing in flight: the reply already landed

    c.attach('s1', 0)
    sock.emitControl({
      type: 'attached',
      ref: 2,
      id: 's1',
      cols: 80,
      rows: 24,
      title: '',
      seq: 0,
      head: 0,
      truncated: false,
      primary: true,
    })

    expect(seen).toEqual([1, 2])
  })

  it('drops an unanswered refusal when the connection goes', async () => {
    // Refusals are counted against replies that are still on the wire. A
    // socket that drops takes every one of them with it, so a count carried
    // into the next connection would refuse an entirely unrelated attach.
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const { c, sockets } = harness()
    const seen: number[] = []

    c.connect()
    sockets[0]!.open()
    c.onAttached((a) => seen.push(a.ref))
    c.attach('s1', 0)
    c.forget('s1') // one reply owed a refusal, and it never arrives

    sockets[0]!.close()
    await vi.advanceTimersByTimeAsync(125)
    sockets[1]!.open()

    c.attach('s1', 0)
    sockets[1]!.emitControl({
      type: 'attached',
      ref: 1,
      id: 's1',
      cols: 80,
      rows: 24,
      title: '',
      seq: 0,
      head: 0,
      truncated: false,
      primary: true,
      reqId: 2,
    })

    expect(seen).toEqual([1])
  })

  it('plans one attachment per session, however many refs it holds', async () => {
    // Documented limit rather than an accident: `attached` says which session
    // and which ref, never which of two views asked, so a second view could
    // not be told which reply was its own even if two were sent.
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const { c, sockets } = harness()

    c.connect()
    sockets[0]!.open()
    c.attach('s1', 0)
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
        head: 0,
        truncated: false,
        primary: ref === 1,
      })
    }
    sockets[0]!.emitBinary(FRAME_OUTPUT, 1, 'abcd')
    expect(c.lastSeqFor(1)).toBe(4)
    expect(c.lastSeqFor(2)).toBe(0)

    sockets[0]!.close()
    await vi.advanceTimersByTimeAsync(125)
    sockets[1]!.open()

    expect(sockets[1]!.sentControl().filter((m) => m.type === 'attach')).toStrictEqual([
      { type: 'attach', id: 's1', lastSeq: 4, reqId: 3 },
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

  it('caps the delay at ten seconds however long the outage runs', async () => {
    vi.useFakeTimers()
    // The top of the jitter range, so the delay is the ceiling exactly and the
    // assertions below pin the cap rather than merely bounding it.
    vi.spyOn(Math, 'random').mockReturnValue(1)
    const { c, sockets } = harness()

    c.connect()
    for (let i = 0; i < 40; i++) {
      sockets[sockets.length - 1]!.close()
      await vi.advanceTimersByTimeAsync(10_000)
      expect(sockets).toHaveLength(i + 2)
    }

    // Grown past the cap, the delay is still exactly ten seconds — not less,
    // which a cap of one millisecond would also satisfy, and not more.
    sockets[sockets.length - 1]!.close()
    await vi.advanceTimersByTimeAsync(9_999)
    expect(sockets).toHaveLength(41)
    await vi.advanceTimersByTimeAsync(1)
    expect(sockets).toHaveLength(42)
  })

  it('restarts the backoff after a connection that was kept', async () => {
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

    // Kept for five seconds, which is what "succeeded" has to mean here — see
    // the flapping test below for why opening is not enough.
    sockets[2]!.open()
    await vi.advanceTimersByTimeAsync(5_000)
    sockets[2]!.close()
    await vi.advanceTimersByTimeAsync(125)
    expect(sockets).toHaveLength(4)
  })

  it('keeps escalating through a channel that opens and dies immediately', async () => {
    // The bug: the backoff reset on `onopen`, and opening is not the same as
    // being kept. A channel that establishes and dies — the relay hub handing
    // the daemon leg to a newcomer and closing the incumbent, a daemon
    // reconnecting in a loop — reset the exponent every cycle, so the tab sat
    // at the 125 ms floor forever: dials by the half-dozen per second against
    // a Worker someone pays for. The Go transport already required a socket to
    // have lasted (`minStableConn`); this is the same rule on the other leg.
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const { c, sockets } = harness()

    c.connect()
    // Four flaps, each one opening and closing within the same instant. The
    // delays double rather than pinning at the floor.
    for (const delay of [125, 250, 500, 1000]) {
      const sock = sockets[sockets.length - 1]!
      sock.open()
      sock.close()
      await vi.advanceTimersByTimeAsync(delay - 1)
      const before = sockets.length
      await vi.advanceTimersByTimeAsync(1)
      expect(sockets).toHaveLength(before + 1)
    }
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
  /** Attach `ref` on `sock` so ref-bearing sends have somewhere to land. */
  function attachRef(sock: FakeSocket, ref: number, id = 's1') {
    sock.emitControl({
      type: 'attached',
      ref,
      id,
      cols: 80,
      rows: 24,
      title: '',
      seq: 0,
      head: 0,
      truncated: false,
      primary: true,
    })
  }

  it('encodes input as a binary frame', () => {
    const { c, sock } = connected()
    attachRef(sock, 3)
    c.sendInput(3, utf8.encode('k'))

    const bin = sock.sentBinary()[0]
    expect(bin).toBeDefined()
    const got = decodeBinary(bin!)
    expect(got.type).toBe(FRAME_INPUT)
    expect(got.ref).toBe(3)
    expect(text(got.payload)).toBe('k')
  })

  it('refuses to aim a ref-bearing message at a ref it does not hold', async () => {
    // The daemon numbers refs from 1 again on every connection and skips the
    // ones whose attach failed, so a view that has not yet noticed the
    // reconnect holds a number that may now name a different session. Sending
    // to it would put a stale pane's keystrokes into a live shell.
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const { c, sockets } = harness()

    c.connect()
    sockets[0]!.open()
    attachRef(sockets[0]!, 1, 's1')
    sockets[0]!.close()
    await vi.advanceTimersByTimeAsync(125)
    sockets[1]!.open()
    attachRef(sockets[1]!, 1, 's2') // ref 1 now names a different session

    // The stale view still thinks it owns ref 1 — and it does not, but the
    // client cannot tell those apart, so what it enforces is the weaker and
    // checkable rule: never send to a ref with no live attachment.
    c.sendInput(7, utf8.encode('rm -rf /\r'))
    c.resize(7, 80, 24, true)
    c.signal(7, 'SIGINT')
    c.closeSession(7)

    expect(sockets[1]!.sentBinary()).toEqual([])
    expect(sockets[1]!.sentControl().map((m) => m.type)).toEqual(['hello', 'attach'])
  })

  it('splits a paste under the daemon per-frame read limit', () => {
    const { c, sock } = connected()
    attachRef(sock, 1)
    c.sendInput(1, new Uint8Array(1_500_000).fill(0x61))

    const frames = sock.sentBinary()
    expect(frames.length).toBeGreaterThan(1)
    let total = 0
    for (const f of frames) {
      // 1 MiB is readLimit in internal/daemon/conn.go; over it the daemon
      // closes the connection and the paste vanishes with no diagnosis.
      expect(f.byteLength).toBeLessThan(1 << 20)
      total += decodeBinary(f).payload.length
    }
    expect(total).toBe(1_500_000)
  })

  it('sends an empty input frame rather than nothing at all', () => {
    const { c, sock } = connected()
    attachRef(sock, 1)
    c.sendInput(1, new Uint8Array())
    expect(sock.sentBinary()).toHaveLength(1)
  })

  it('rounds and clamps dimensions into the daemon uint16 fields', () => {
    // Columns come from a layout measurement, so a fraction is the realistic
    // way in — and Go's uint16 refuses one at json.Unmarshal, which answers
    // bad_message and drops the whole request.
    const { c, sock } = connected()
    attachRef(sock, 1)
    c.resize(1, 80.4, 23.6, true)
    c.spawn({ cols: 0, rows: 1e9 })

    expect(sock.sentControl().slice(1)).toStrictEqual([
      { type: 'resize', ref: 1, cols: 80, rows: 24, primary: true },
      { type: 'spawn', cols: 1, rows: 65535, reqId: 1 },
    ])
  })

  it('drops keystrokes typed while the socket is down instead of replaying them', async () => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const { c, sockets } = harness()

    c.connect()
    attachRef(sockets[0]!, 1) // ignored: the socket is not open yet
    expect(() => c.sendInput(1, utf8.encode('rm -rf /\r'))).not.toThrow()
    sockets[0]!.open()
    expect(sockets[0]!.sentBinary()).toEqual([])

    attachRef(sockets[0]!, 1)
    sockets[0]!.close()
    expect(() => c.sendInput(1, utf8.encode('more\r'))).not.toThrow()
    await vi.advanceTimersByTimeAsync(125)
    sockets[1]!.open()
    expect(sockets[1]!.sentBinary()).toEqual([])
  })

  it('holds a list asked for before the socket opens', () => {
    const { c, sockets } = harness()
    c.connect()
    expect(() => c.list()).not.toThrow()
    sockets[0]!.open()

    expect(sockets[0]!.sentControl()).toStrictEqual([
      { type: 'hello', ver: PROTOCOL_VERSION, caps: ['binary'] },
      { type: 'list' },
    ])
  })

  it('asks once however many times a list was asked for while down', () => {
    const { c, sockets } = harness()
    c.connect()
    for (let i = 0; i < 500; i++) c.list()
    sockets[0]!.open()
    expect(sockets[0]!.sentControl().map((m) => m.type)).toEqual(['hello', 'list'])
  })

  it('reports whether a spawn went, so the caller need not infer it', () => {
    const { c, sockets } = harness()
    c.connect()
    expect(c.spawn({ cols: 80, rows: 24 })).toBeNull()
    sockets[0]!.open()
    expect(c.spawn({ cols: 80, rows: 24 })).toBe(1)
  })

  it('drops rather than holds a spawn issued while the socket is down', async () => {
    // A held spawn would surface behind a ten-second backoff as a shell
    // nobody asked for at a screen nobody is looking at.
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const { c, sockets } = harness()

    c.connect()
    sockets[0]!.open()
    sockets[0]!.close()
    c.spawn({ cols: 80, rows: 24 })
    await vi.advanceTimersByTimeAsync(125)
    sockets[1]!.open()

    expect(sockets[1]!.sentControl().map((m) => m.type)).toEqual(['hello'])
  })

  it('does not carry a held list across a close', () => {
    const { c, sockets } = harness()
    c.connect()
    c.list()
    c.close()
    c.connect()
    sockets[1]!.open()
    expect(sockets[1]!.sentControl().map((m) => m.type)).toEqual(['hello'])
  })

  it('sends the device and pairing requests the protocol defines', () => {
    const { c, sock } = connected()
    c.listDevices()
    c.revokeDevice('d1b2c3d4e5f6')
    c.startPairing()
    c.cancelPairing()

    expect(sock.sentControl().slice(1)).toStrictEqual([
      { type: 'devices' },
      { type: 'revoke', deviceId: 'd1b2c3d4e5f6' },
      { type: 'pairStart' },
      { type: 'pairCancel' },
    ])
  })

  it('holds a device list asked for before the socket opens', () => {
    // Same hazard as `list`, and worse: `deviceList` is otherwise only pushed
    // when a pairing or a revoke happens, so a request dropped on a cold mount
    // leaves the screen empty until somebody changes something.
    const { c, sockets } = harness()
    c.connect()
    expect(() => c.listDevices()).not.toThrow()
    sockets[0]!.open()

    expect(sockets[0]!.sentControl()).toStrictEqual([
      { type: 'hello', ver: PROTOCOL_VERSION, caps: ['binary'] },
      { type: 'devices' },
    ])
  })

  it('asks once however many times the device list was asked for while down', () => {
    const { c, sockets } = harness()
    c.connect()
    for (let i = 0; i < 500; i++) c.listDevices()
    sockets[0]!.open()
    expect(sockets[0]!.sentControl().map((m) => m.type)).toEqual(['hello', 'devices'])
  })

  it('asks for the device list again on every connection, not only the first', async () => {
    // The list is push-on-change and nothing polls it, so an answer received
    // before an outage is the last word the tab will ever get. A device
    // revoked while the socket was down would go on showing, with a Revoke
    // button aimed at an id the daemon no longer knows, until the tab is
    // reloaded. Nobody asks again here: the client re-asks on the consumer's
    // behalf, exactly as it replays the reattach plan.
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const { c, sockets } = harness()
    const seen: string[][] = []
    c.onDeviceList((devices) => seen.push(devices.map((d) => d.id)))

    c.connect()
    sockets[0]!.open()
    c.listDevices()
    sockets[0]!.emitControl({
      type: 'deviceList',
      devices: [
        { id: 'd1b2c3d4e5f6', label: 'iPhone', pairedAt: 1754380800, lastSeen: 1754384400 },
        { id: 'd9a8b7c6d5e4', label: 'iPad', pairedAt: 1754294400, lastSeen: 1754298000 },
      ],
    })

    sockets[0]!.close()
    await vi.advanceTimersByTimeAsync(125)
    sockets[1]!.open()

    expect(sockets[1]!.sentControl().filter((m) => m.type === 'devices')).toStrictEqual([
      { type: 'devices' },
    ])

    // And the answer reaches the same listener, which is what actually closes
    // the gap: the iPhone was revoked during the outage.
    sockets[1]!.emitControl({
      type: 'deviceList',
      devices: [{ id: 'd9a8b7c6d5e4', label: 'iPad', pairedAt: 1754294400, lastSeen: 1754298000 }],
    })
    expect(seen).toEqual([['d1b2c3d4e5f6', 'd9a8b7c6d5e4'], ['d9a8b7c6d5e4']])
  })

  it('asks for no device list on a connection where none was ever wanted', async () => {
    // The re-ask is a standing intent, not something every connection does.
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const { c, sockets } = harness()

    c.connect()
    sockets[0]!.open()
    sockets[0]!.close()
    await vi.advanceTimersByTimeAsync(125)
    sockets[1]!.open()

    expect(sockets[1]!.sentControl().map((m) => m.type)).toEqual(['hello'])
  })

  it('does not carry the device-list intent across a close', () => {
    // `close` is the tab letting go for good, so the standing re-ask goes with
    // it — a later `connect` on the same client starts wanting nothing.
    const { c, sockets } = harness()
    c.connect()
    c.listDevices()
    c.close()
    c.connect()
    sockets[1]!.open()
    expect(sockets[1]!.sentControl().map((m) => m.type)).toEqual(['hello'])
  })

  it('drops rather than holds a pairing or a revoke issued while the socket is down', async () => {
    // Neither is idempotent the way a list is. A pairing token is good for two
    // minutes, so one that surfaced behind a ten-second backoff would show a
    // dead token at a screen that had moved on; and a revoke replayed after an
    // outage could unpair a device the user had paired again in between.
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const { c, sockets } = harness()

    c.connect()
    sockets[0]!.open()
    sockets[0]!.close()
    c.startPairing()
    c.cancelPairing()
    c.revokeDevice('d1b2c3d4e5f6')
    await vi.advanceTimersByTimeAsync(125)
    sockets[1]!.open()

    expect(sockets[1]!.sentControl().map((m) => m.type)).toEqual(['hello'])
  })

  it('sends the remaining control messages the protocol defines', () => {
    const { c, sock } = connected()
    attachRef(sock, 3)
    c.list()
    c.spawn({ cwd: '/tmp', cmd: ['zsh', '-l'], cols: 120, rows: 40 })
    c.resize(3, 200, 50, true)
    c.signal(3, 'SIGINT')
    c.closeSession(3)
    c.detach(3)

    expect(sock.sentControl().slice(1)).toStrictEqual([
      { type: 'list' },
      { type: 'spawn', cwd: '/tmp', cmd: ['zsh', '-l'], cols: 120, rows: 40, reqId: 1 },
      { type: 'resize', ref: 3, cols: 200, rows: 50, primary: true },
      { type: 'signal', ref: 3, sig: 'SIGINT' },
      { type: 'close', ref: 3 },
      { type: 'detach', ref: 3 },
    ])
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

  it('exposes the device list, asked for or not', () => {
    // The daemon broadcasts `deviceList` to every remaining connection after a
    // pairing or a revoke, so one arrives with no request of this tab's behind
    // it. Nothing here correlates it with a `devices`, which is what makes the
    // pushed copy and the answered one the same event.
    const { c, sock } = connected()
    const seen: string[][] = []
    c.onDeviceList((devices) => seen.push(devices.map((d) => d.id)))
    sock.emitControl({
      type: 'deviceList',
      devices: [
        { id: 'd1b2c3d4e5f6', label: 'iPhone', pairedAt: 1754380800, lastSeen: 1754384400 },
      ],
    })
    sock.emitControl({ type: 'deviceList', devices: [] })

    expect(seen).toEqual([['d1b2c3d4e5f6'], []])
  })

  it('hands on the pairing message whole', () => {
    // Every field is load-bearing at a different place on the pairing screen:
    // the QR encodes `url` — which carries the token and the key the second
    // device pins — and the countdown reads `expiresAt`. A client that
    // projected one of them would drop the rest silently.
    const { c, sock } = connected()
    const seen: Pairing[] = []
    c.onPairing((p) => seen.push(p))

    const pairing: Pairing = {
      type: 'pairing',
      token: 'Zm91cnRlZW4tY2hhcnM',
      url: 'https://macbook.local:7717/pair?t=Zm91cnRlZW4tY2hhcnM&k=3p7bfXt9wbTTW2HC7OQ1Nz-DQ8hG6YwjhyZxaYQpb8k',
      daemonPub: '3p7bfXt9wbTTW2HC7OQ1Nz+DQ8hG6YwjhyZxaYQpb8k=',
      expiresAt: 1754384520,
    }
    sock.emitControl(pairing)

    expect(seen).toStrictEqual([pairing])
  })

  it('reports why a revocation ended this connection', () => {
    const { c, sock } = connected()
    const seen: string[] = []
    c.onRevoked((reason) => seen.push(reason))
    sock.emitControl({ type: 'revoked', reason: 'revoked by another device' })
    expect(seen).toEqual(['revoked by another device'])
  })

  it('reports a revocation before the close that follows it', () => {
    // The daemon sends `revoked` and then ends the connection — the frame
    // rides the same queue as the goodbye, so it always arrives first. If the
    // client reordered them, every consumer would see a bare disconnect and
    // the reason would land against a socket that was already reconnecting.
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const { c, sock } = connected()
    const seen: string[] = []
    c.onRevoked((reason) => seen.push(`revoked:${reason}`))
    c.onStatus((s) => seen.push(`status:${s}`))

    sock.emitControl({ type: 'revoked', reason: 'revoked' })
    sock.close()

    expect(seen).toEqual(['revoked:revoked', 'status:reconnecting'])
  })

  it('lets a consumer stop the client from inside onRevoked', async () => {
    // What the ordering buys: a revoked device that kept reconnecting would
    // hammer a daemon whose registry no longer holds its key, and each attempt
    // would fail with no reason attached. Stopping is the consumer's call, and
    // it can only make it because the reason arrives before the close does.
    vi.useFakeTimers()
    const { c, sock, sockets } = connected()
    c.onRevoked(() => c.close())

    sock.emitControl({ type: 'revoked', reason: 'revoked' })
    sock.close()
    await vi.advanceTimersByTimeAsync(120_000)

    expect(sockets).toHaveLength(1)
    expect(c.status).toBe('closed')
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
      head: 0,
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

  it('ignores a message type it does not know', () => {
    const { c, sock } = connected()
    const errs: string[] = []
    c.onError((e) => errs.push(e.code))
    expect(() => sock.emitControl({ type: 'somethingNewer', x: 1 })).not.toThrow()
    expect(errs).toEqual([])
  })

  it('hands the welcome to onWelcome and remembers its relay leg', () => {
    const { c, sock } = connected()
    const seen: Welcome[] = []
    c.onWelcome((w) => seen.push(w))

    const welcome: Welcome = {
      type: 'welcome',
      daemonId: 'local',
      host: 'mb',
      ver: '0.1.0',
      relay: { status: 'connected', origin: 'https://r.example' },
    }
    sock.emitControl(welcome)

    expect(seen).toStrictEqual([welcome])
    expect(c.relay).toStrictEqual({ status: 'connected', origin: 'https://r.example' })
    expect(c.relay.origin).toBe('https://r.example')
  })

  it('reports the relay off before any welcome has arrived', () => {
    // The getter exists for consumers that mount between welcomes, so before
    // the first one it must answer something — and "off" is the only claim a
    // client with no daemon's word yet can honestly make.
    const { c } = connected()
    expect(c.relay).toStrictEqual({ status: 'off' })
    expect(c.relay.origin).toBeUndefined()
  })

  it('reads a welcome that omits relay as off', () => {
    // A daemon with no relay omits the field entirely; `off` never arrives on
    // the wire. The getter folds the two spellings together so no consumer
    // ever has to know there are two.
    const { c, sock } = connected()
    sock.emitControl({ type: 'welcome', daemonId: 'local', host: 'mb', ver: '0.1.0' })
    expect(c.relay).toStrictEqual({ status: 'off' })
  })

  it('holds only the latest welcome, so a reconnect can change the answer', async () => {
    // The welcome is a snapshot taken as each connection is accepted, so the
    // one from the connection before it is exactly the stale claim to drop.
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const { c, sockets } = harness()

    c.connect()
    sockets[0]!.open()
    sockets[0]!.emitControl({
      type: 'welcome',
      daemonId: 'local',
      host: 'mb',
      ver: '0.1.0',
      relay: { status: 'connected', origin: 'https://r.example' },
    })
    expect(c.relay.status).toBe('connected')

    sockets[0]!.close()
    await vi.advanceTimersByTimeAsync(125)
    sockets[1]!.open()
    sockets[1]!.emitControl({ type: 'welcome', daemonId: 'local', host: 'mb', ver: '0.1.0' })

    expect(c.relay).toStrictEqual({ status: 'off' })
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

describe('FlueClient correlation', () => {
  it('numbers attach and spawn requests in send order', () => {
    const { c, sock } = connected()
    c.attach('s1', 0)
    const reqId = c.spawn({ cols: 80, rows: 24 })

    expect(sock.sentControl().slice(1)).toStrictEqual([
      { type: 'attach', id: 's1', lastSeq: 0, reqId: 1 },
      { type: 'spawn', cols: 80, rows: 24, reqId: 2 },
    ])
    expect(reqId).toBe(2)
  })

  it('returns null for a spawn the socket could not carry', () => {
    const { c } = harness()
    c.connect()
    expect(c.spawn({ cols: 80, rows: 24 })).toBeNull()
  })

  it('hands back an abandoned reply and adopts nothing', () => {
    const { c, sock } = connected()
    const seen: number[] = []
    c.onAttached((a) => seen.push(a.ref))

    const reqId = c.spawn({ cols: 80, rows: 24 })!
    c.abandon(reqId)
    sock.emitControl({
      type: 'attached',
      ref: 5,
      id: 'orphan',
      cols: 80,
      rows: 24,
      title: '',
      seq: 0,
      head: 0,
      truncated: false,
      primary: true,
      reqId,
    })

    expect(seen).toEqual([])
    expect(c.lastSeqFor(5)).toBeUndefined()
    expect(sock.sentControl()).toContainEqual({ type: 'detach', ref: 5 })
  })

  it('abandons once: a second reply for the session is adopted normally', () => {
    const { c, sock } = connected()
    const seen: number[] = []
    c.onAttached((a) => seen.push(a.ref))

    c.attach('s1', 0) // reqId 1
    c.forget('s1') // abandons reqId 1
    c.attach('s1', 0) // reqId 2
    for (const [ref, reqId] of [
      [1, 1],
      [2, 2],
    ] as const) {
      sock.emitControl({
        type: 'attached',
        ref,
        id: 's1',
        cols: 80,
        rows: 24,
        title: '',
        seq: 0,
        head: 0,
        truncated: false,
        primary: ref === 1,
        reqId,
      })
    }

    expect(seen).toEqual([2])
    expect(sock.sentControl()).toContainEqual({ type: 'detach', ref: 1 })
    expect(sock.sentControl()).not.toContainEqual({ type: 'detach', ref: 2 })
  })

  it('announces a session the daemon does not know, by id', () => {
    const { c, sock } = connected()
    const gone: string[] = []
    c.onSessionGone((id) => gone.push(id))

    c.attach('dead', 0) // reqId 1
    sock.emitControl({ type: 'error', code: 'not_found', msg: 'no such session', reqId: 1 })

    expect(gone).toEqual(['dead'])
  })

  it('drops a not_found session from the plan without a forget', async () => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const { c, sockets } = harness()

    c.connect()
    sockets[0]!.open()
    c.attach('dead', 0) // reqId 1
    sockets[0]!.emitControl({ type: 'error', code: 'not_found', msg: 'no such session', reqId: 1 })

    sockets[0]!.close()
    await vi.advanceTimersByTimeAsync(125)
    sockets[1]!.open()

    expect(sockets[1]!.sentControl().filter((m) => m.type === 'attach')).toEqual([])
  })

  it('announces not_found for a reattach replayed after a reconnect', async () => {
    // A daemon restart forgets every session; the replayed attach carries a
    // reqId nothing in the tab holds, so the client itself has to resolve it
    // back to the session. This is the case the old ref-is-null heuristic in
    // the terminal could not cover exactly.
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const { c, sockets } = harness()
    const gone: string[] = []
    c.onSessionGone((id) => gone.push(id))

    c.connect()
    sockets[0]!.open()
    c.attach('s1', 0) // reqId 1
    sockets[0]!.emitControl({
      type: 'attached',
      ref: 1,
      id: 's1',
      cols: 80,
      rows: 24,
      title: '',
      seq: 0,
      head: 0,
      truncated: false,
      primary: true,
      reqId: 1,
    })

    sockets[0]!.close()
    await vi.advanceTimersByTimeAsync(125)
    sockets[1]!.open() // the plan replays attach with reqId 2
    sockets[1]!.emitControl({ type: 'error', code: 'not_found', msg: 'no such session', reqId: 2 })

    expect(gone).toEqual(['s1'])
  })

  it('does not abandon a request that was already answered', () => {
    const { c, sock } = connected()
    const seen: number[] = []
    c.onAttached((a) => seen.push(a.ref))

    c.attach('s1', 0) // reqId 1
    sock.emitControl({
      type: 'attached',
      ref: 1,
      id: 's1',
      cols: 80,
      rows: 24,
      title: '',
      seq: 0,
      head: 0,
      truncated: false,
      primary: true,
      reqId: 1,
    })
    c.forget('s1') // nothing in flight: must arm nothing

    c.attach('s1', 0) // reqId 2
    sock.emitControl({
      type: 'attached',
      ref: 2,
      id: 's1',
      cols: 80,
      rows: 24,
      title: '',
      seq: 0,
      head: 0,
      truncated: false,
      primary: true,
      reqId: 2,
    })

    expect(seen).toEqual([1, 2])
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

  it('keeps reconnecting when a status listener throws', async () => {
    // The status change is announced inside onclose, one line before the retry
    // is armed. An exception escaping delivery would abort the handler with no
    // socket and no timer: a tab stuck at `reconnecting` for good.
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { c, sockets } = harness()

    c.onStatus(() => {
      throw new Error('consumer bug')
    })
    c.connect()
    sockets[0]!.open()
    sockets[0]!.close()

    await vi.advanceTimersByTimeAsync(125)
    expect(sockets).toHaveLength(2)
    sockets[1]!.open()
    expect(c.status).toBe('open')
    expect(logged).toHaveBeenCalled()
  })

  it('completes the handshake when a status listener throws on open', () => {
    // Same shape as above, ahead of hello and the reattach replay instead.
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { c, sockets } = harness()

    c.attach('s1', 9)
    c.onStatus(() => {
      throw new Error('consumer bug')
    })
    c.connect()
    sockets[0]!.open()

    expect(sockets[0]!.sentControl().map((m) => m.type)).toEqual(['hello', 'attach'])
  })

  it('still delivers to the listeners behind one that threw', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { c, sock } = connected()
    const seen: string[] = []
    c.onError(() => {
      throw new Error('consumer bug')
    })
    c.onError((e) => seen.push(e.code))

    sock.emitControl({ type: 'error', code: 'not_found', msg: '' })
    expect(seen).toEqual(['not_found'])
  })

  it('stops delivering devices, pairing and revocation after unsubscribe', () => {
    const { c, sock } = connected()
    const seen: string[] = []
    const offs = [
      c.onDeviceList((devices) => seen.push(`devices:${devices.length}`)),
      c.onPairing((p) => seen.push(`pairing:${p.token}`)),
      c.onRevoked((reason) => seen.push(`revoked:${reason}`)),
    ]

    const push = () => {
      sock.emitControl({ type: 'deviceList', devices: [] })
      sock.emitControl({ type: 'pairing', token: 't', url: 'u', daemonPub: 'k', expiresAt: 1 })
      sock.emitControl({ type: 'revoked', reason: 'r' })
    }
    push()
    for (const off of offs) off()
    push()

    expect(seen).toEqual(['devices:0', 'pairing:t', 'revoked:r'])
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
      c.onDeviceList(() => {}),
      c.onPairing(() => {}),
      c.onRevoked(() => {}),
      c.onWelcome(() => {}),
    ]) {
      expect(typeof off).toBe('function')
      off()
    }
  })
})
