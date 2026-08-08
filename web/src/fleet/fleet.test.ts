import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import { x25519 } from '@noble/curves/ed25519.js'

import vectors from '../../../testdata/noise/ik.json'
import type { ConnStatus, FlueClient } from '@/client/client'
import type { SessionInfo, Welcome } from '@/client/protocol'
import { savePinnedDaemonKeyFor } from '@/crypto/keys'
import { saveMachine } from '@/relay/machines'
import type { RawSocket } from '@/relay/socket'
import { responderHandshake } from '@/testing/noise-daemon'
import { FleetClient, fleetSources, type FleetSource } from './fleet'
import { LOCAL_MACHINE_ID, type FleetSession, type MachineState } from './types'

const unhex = (s: string) => new Uint8Array((s.match(/.{2}/g) ?? []).map((b) => parseInt(b, 16)))

/** A daemon key pair the Noise vectors carry, so the responder half can prove
 *  a built client sealed message A to the key pinned for its machine. */
const DAEMON_PRIV = unhex(vectors.responderStaticPriv)
const DAEMON_PUB = x25519.getPublicKey(DAEMON_PRIV)

const MESA = { id: 'blue-mesa', name: 'Blue Mesa', pairedAt: 1_700_000_000_000 }
const ATTIC = { id: 'attic-pi', name: 'Attic Pi', pairedAt: 1_700_000_001_000 }

/**
 * A FlueClient-shaped script. The FleetClient constructor takes built sources,
 * which is exactly so a test can hand it these instead of sockets: everything
 * the fleet consumes — connect, close, list, update, spawn, and the three
 * listener registrations — is recorded or replayable, and nothing else exists.
 */
class FakeClient {
  connects = 0
  closes = 0
  lists = 0
  updates: Array<{ id: string; name?: string; tags?: string[]; pinned?: boolean }> = []
  spawns: Array<{ cwd?: string; cmd?: string[]; cols: number; rows: number }> = []
  spawnReply: number | null = 7

  private sessionsCbs: Array<(s: SessionInfo[]) => void> = []
  private statusCbs: Array<(s: ConnStatus) => void> = []
  private welcomeCbs: Array<(w: Welcome) => void> = []

  onSessions(cb: (s: SessionInfo[]) => void) {
    return listen(this.sessionsCbs, cb)
  }
  onStatus(cb: (s: ConnStatus) => void) {
    return listen(this.statusCbs, cb)
  }
  onWelcome(cb: (w: Welcome) => void) {
    return listen(this.welcomeCbs, cb)
  }

  connect() {
    this.connects++
  }
  close() {
    this.closes++
  }
  list() {
    this.lists++
  }
  update(patch: { id: string; name?: string; tags?: string[]; pinned?: boolean }) {
    this.updates.push(patch)
  }
  spawn(opts: { cwd?: string; cmd?: string[]; cols: number; rows: number }): number | null {
    this.spawns.push(opts)
    return this.spawnReply
  }

  emitSessions(rows: SessionInfo[]) {
    for (const cb of [...this.sessionsCbs]) cb(rows)
  }
  emitStatus(s: ConnStatus) {
    for (const cb of [...this.statusCbs]) cb(s)
  }
  emitWelcome(w: Welcome) {
    for (const cb of [...this.welcomeCbs]) cb(w)
  }
  open() {
    this.emitStatus('open')
  }
}

function listen<T>(arr: T[], cb: T): () => void {
  arr.push(cb)
  return () => {
    const at = arr.indexOf(cb)
    if (at >= 0) arr.splice(at, 1)
  }
}

function src(id: string, name: string, fake: FakeClient): FleetSource {
  return { id, name, client: fake as unknown as FlueClient }
}

/** All thirteen SessionInfo fields, so a stamped row is checked whole. */
function info(id: string): SessionInfo {
  return {
    id,
    title: 'zsh',
    name: '',
    tags: [],
    pinned: false,
    cwd: '/home',
    cmd: ['zsh'],
    state: 'running',
    exitCode: 0,
    cols: 80,
    rows: 24,
    createdAt: '2026-08-08T00:00:00Z',
    lastActive: '2026-08-08T00:00:01Z',
  }
}

function welcome(relay?: Welcome['relay']): Welcome {
  return { type: 'welcome', daemonId: 'd1', host: 'mesa.local', ver: '0.1.0', ...(relay ? { relay } : {}) }
}

function harness(
  entries: Array<[id: string, name: string]>,
  expand?: (origin: string) => Promise<FleetSource[]>,
) {
  const fakes = new Map<string, FakeClient>()
  const sources = entries.map(([id, name]) => {
    const f = new FakeClient()
    fakes.set(id, f)
    return src(id, name, f)
  })
  const fleet = new FleetClient(sources, expand)
  const calls: Array<{ sessions: FleetSession[]; machines: MachineState[] }> = []
  const off = fleet.onFleet((sessions, machines) => calls.push({ sessions, machines }))
  return {
    fleet,
    calls,
    off,
    fake: (id: string) => fakes.get(id)!,
    last: () => calls[calls.length - 1]!,
  }
}

const flush = () => new Promise((r) => setTimeout(r, 0))

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('FleetClient', () => {
  it('stamps every row with its machine and concatenates in source order', () => {
    const h = harness([
      ['attic-pi', 'Attic Pi'],
      ['blue-mesa', 'Blue Mesa'],
    ])
    h.fleet.connect()
    h.fake('attic-pi').open()
    h.fake('blue-mesa').open()

    // Arrival order is mesa first; the merged list still leads with attic,
    // because concatenation follows source order, not whoever answered last.
    h.fake('blue-mesa').emitSessions([info('s2'), info('s3')])
    h.fake('attic-pi').emitSessions([info('s1')])

    expect(h.last().sessions).toEqual([
      { ...info('s1'), machineId: 'attic-pi', machineName: 'Attic Pi' },
      { ...info('s2'), machineId: 'blue-mesa', machineName: 'Blue Mesa' },
      { ...info('s3'), machineId: 'blue-mesa', machineName: 'Blue Mesa' },
    ])
    expect(h.last().machines).toEqual([
      { id: 'attic-pi', name: 'Attic Pi', status: 'online' },
      { id: 'blue-mesa', name: 'Blue Mesa', status: 'online' },
    ])
    h.fleet.close()
  })

  it('a fresh payload replaces only its own source’s rows', () => {
    const h = harness([
      ['attic-pi', 'Attic Pi'],
      ['blue-mesa', 'Blue Mesa'],
    ])
    h.fleet.connect()
    h.fake('attic-pi').open()
    h.fake('blue-mesa').open()
    h.fake('attic-pi').emitSessions([info('s1')])
    h.fake('blue-mesa').emitSessions([info('s2')])

    h.fake('attic-pi').emitSessions([info('s4')])

    expect(h.last().sessions).toEqual([
      { ...info('s4'), machineId: 'attic-pi', machineName: 'Attic Pi' },
      { ...info('s2'), machineId: 'blue-mesa', machineName: 'Blue Mesa' },
    ])
    h.fleet.close()
  })

  it('a source going unreachable drops its rows at once and says so', () => {
    const h = harness([
      ['attic-pi', 'Attic Pi'],
      ['blue-mesa', 'Blue Mesa'],
    ])
    h.fleet.connect()
    h.fake('attic-pi').open()
    h.fake('blue-mesa').open()
    h.fake('attic-pi').emitSessions([info('s1')])
    h.fake('blue-mesa').emitSessions([info('s2')])

    h.fake('attic-pi').emitStatus('reconnecting')

    expect(h.last().sessions).toEqual([
      { ...info('s2'), machineId: 'blue-mesa', machineName: 'Blue Mesa' },
    ])
    expect(h.last().machines).toEqual([
      { id: 'attic-pi', name: 'Attic Pi', status: 'unreachable' },
      { id: 'blue-mesa', name: 'Blue Mesa', status: 'online' },
    ])
    h.fleet.close()
  })

  it('a source coming back starts empty and is asked again, not replayed', () => {
    const h = harness([['attic-pi', 'Attic Pi']])
    h.fleet.connect()
    h.fake('attic-pi').open()
    expect(h.fake('attic-pi').lists).toBe(1) // the fresh ask on open
    h.fake('attic-pi').emitSessions([info('s1')])

    h.fake('attic-pi').emitStatus('reconnecting')
    h.fake('attic-pi').open()

    // Online again, asked again — and nothing from before the outage shows.
    expect(h.fake('attic-pi').lists).toBe(2)
    expect(h.last().sessions).toEqual([])
    expect(h.last().machines).toEqual([{ id: 'attic-pi', name: 'Attic Pi', status: 'online' }])

    h.fake('attic-pi').emitSessions([info('s1')])
    expect(h.last().sessions).toEqual([
      { ...info('s1'), machineId: 'attic-pi', machineName: 'Attic Pi' },
    ])
    h.fleet.close()
  })

  it('closes the relay twin the loopback welcome names, and takes its name', () => {
    const h = harness([
      [LOCAL_MACHINE_ID, ''],
      ['blue-mesa', 'Blue Mesa'],
    ])
    h.fleet.connect()
    h.fake('blue-mesa').open()
    h.fake('blue-mesa').emitSessions([info('r1')])
    h.fake(LOCAL_MACHINE_ID).open()
    h.fake(LOCAL_MACHINE_ID).emitSessions([info('l1')])

    h.fake(LOCAL_MACHINE_ID).emitWelcome(
      welcome({ status: 'connected', machineId: 'blue-mesa', machineName: 'Blue Mesa' }),
    )

    // Loopback wins: the twin is closed and dropped whole — rows, status, row.
    expect(h.fake('blue-mesa').closes).toBe(1)
    expect(h.last().machines).toEqual([
      { id: LOCAL_MACHINE_ID, name: 'Blue Mesa', status: 'online' },
    ])
    expect(h.last().sessions).toEqual([
      { ...info('l1'), machineId: LOCAL_MACHINE_ID, machineName: 'Blue Mesa' },
    ])

    h.fleet.close()
    // Dropped means gone: the fleet's own close must not close it a second time.
    expect(h.fake('blue-mesa').closes).toBe(1)
  })

  it('names the local source from the welcome host when no relay is configured', () => {
    const h = harness([[LOCAL_MACHINE_ID, '']])
    h.fleet.connect()
    h.fake(LOCAL_MACHINE_ID).open()

    h.fake(LOCAL_MACHINE_ID).emitWelcome(welcome())

    expect(h.last().machines).toEqual([
      { id: LOCAL_MACHINE_ID, name: 'mesa.local', status: 'online' },
    ])
    h.fleet.close()
  })

  it('learns the relay origin from the loopback welcome and builds the remotes once', async () => {
    const remote = new FakeClient()
    const twin = new FakeClient()
    const expand = vi.fn((origin: string) => {
      void origin
      return Promise.resolve([src('blue-mesa', 'Blue Mesa', twin), src('attic-pi', 'Attic Pi', remote)])
    })
    const h = harness([[LOCAL_MACHINE_ID, '']], expand)
    h.fleet.connect()
    h.fake(LOCAL_MACHINE_ID).open()

    const w = welcome({
      status: 'connected',
      origin: 'https://relay.example',
      machineId: 'blue-mesa',
      machineName: 'Blue Mesa',
    })
    h.fake(LOCAL_MACHINE_ID).emitWelcome(w)
    await flush()

    expect(expand).toHaveBeenCalledTimes(1)
    expect(expand).toHaveBeenCalledWith('https://relay.example')
    // The twin the welcome named never joins: loopback already covers it.
    expect(twin.connects).toBe(0)
    expect(remote.connects).toBe(1)
    expect(h.last().machines).toEqual([
      { id: LOCAL_MACHINE_ID, name: 'Blue Mesa', status: 'online' },
      { id: 'attic-pi', name: 'Attic Pi', status: 'connecting' },
    ])

    // A reconnect replays the welcome; the fleet must not rebuild on it.
    h.fake(LOCAL_MACHINE_ID).emitWelcome(w)
    await flush()
    expect(expand).toHaveBeenCalledTimes(1)

    h.fleet.close()
    expect(remote.closes).toBe(1)
  })

  it('routes update to the named machine and forwards the patch untouched', () => {
    const h = harness([
      ['attic-pi', 'Attic Pi'],
      ['blue-mesa', 'Blue Mesa'],
    ])

    // Every field falsy on purpose: a fleet that copied fields would drop all
    // three clears, and one that spread a wider object would add keys.
    const patch = { id: 's1', name: '', tags: [], pinned: false }
    h.fleet.update('blue-mesa', patch)

    expect(h.fake('blue-mesa').updates).toHaveLength(1)
    expect(h.fake('blue-mesa').updates[0]).toBe(patch)
    expect(h.fake('blue-mesa').updates[0]).toEqual({ id: 's1', name: '', tags: [], pinned: false })
    expect(h.fake('attic-pi').updates).toEqual([])

    h.fleet.update('nope', patch)
    expect(h.fake('attic-pi').updates).toEqual([])
    expect(h.fake('blue-mesa').updates).toHaveLength(1)
  })

  it('routes spawnOn to the named machine and answers null for an unknown one', () => {
    const h = harness([
      ['attic-pi', 'Attic Pi'],
      ['blue-mesa', 'Blue Mesa'],
    ])
    h.fake('blue-mesa').spawnReply = 42

    const opts = { cwd: '/tmp', cols: 80, rows: 24 }
    expect(h.fleet.spawnOn('blue-mesa', opts)).toBe(42)
    expect(h.fake('blue-mesa').spawns[0]).toBe(opts)
    expect(h.fake('attic-pi').spawns).toEqual([])

    expect(h.fleet.spawnOn('nope', opts)).toBeNull()
  })

  it('clientFor answers the machine’s client, and null for a machine nobody holds', () => {
    const attic = new FakeClient()
    const fleet = new FleetClient([src('attic-pi', 'Attic Pi', attic)])

    expect(fleet.clientFor('attic-pi')).toBe(attic as unknown as FlueClient)
    expect(fleet.clientFor('nope')).toBeNull()
  })

  it('list asks every online source and nobody else', () => {
    const h = harness([
      ['attic-pi', 'Attic Pi'],
      ['blue-mesa', 'Blue Mesa'],
    ])
    h.fleet.connect()
    h.fake('attic-pi').open()
    const before = h.fake('attic-pi').lists

    h.fleet.list()

    expect(h.fake('attic-pi').lists).toBe(before + 1)
    expect(h.fake('blue-mesa').lists).toBe(0)
    h.fleet.close()
  })

  it('an unsubscribed listener hears nothing more', () => {
    const h = harness([['attic-pi', 'Attic Pi']])
    h.fleet.connect()
    h.fake('attic-pi').open()
    const heard = h.calls.length

    h.off()
    h.fake('attic-pi').emitSessions([info('s1')])
    h.fake('attic-pi').emitStatus('reconnecting')

    expect(h.calls.length).toBe(heard)
    h.fleet.close()
  })

  it('polls each online source every 3s, 150ms apart, and stops with close', () => {
    vi.useFakeTimers()
    const h = harness([
      ['attic-pi', 'Attic Pi'],
      ['blue-mesa', 'Blue Mesa'],
      ['cold-cellar', 'Cold Cellar'],
    ])
    h.fleet.connect()
    h.fake('attic-pi').open()
    h.fake('blue-mesa').open()
    // cold-cellar never opens: still connecting, never asked.
    const attic0 = h.fake('attic-pi').lists
    const mesa0 = h.fake('blue-mesa').lists

    vi.advanceTimersByTime(3_000)
    expect(h.fake('attic-pi').lists).toBe(attic0 + 1)
    expect(h.fake('blue-mesa').lists).toBe(mesa0) // its turn is 150ms away

    vi.advanceTimersByTime(150)
    expect(h.fake('blue-mesa').lists).toBe(mesa0 + 1)
    expect(h.fake('cold-cellar').lists).toBe(0)

    h.fleet.close()
    vi.advanceTimersByTime(30_000)
    expect(h.fake('attic-pi').lists).toBe(attic0 + 1)
    expect(h.fake('blue-mesa').lists).toBe(mesa0 + 1)
  })
})

// ---------------------------------------------------------------------------
// fleetSources, against real storage seams: localStorage holds the records
// and fake-indexeddb the pins, exactly as boot.test.ts drives relayBoot.
// ---------------------------------------------------------------------------

/** The least transport that lets a built client dial and speak once. */
class FakeRaw implements RawSocket {
  sent: Array<string | ArrayBuffer | Uint8Array> = []
  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onmessage: ((data: string | ArrayBuffer) => void) | null = null
  send(data: string | ArrayBuffer | Uint8Array) {
    this.sent.push(data)
  }
  close() {}
  open() {
    this.onopen?.()
  }
}

function recordingFactory() {
  const urls: string[] = []
  const raws: FakeRaw[] = []
  const factory = (url: string): RawSocket => {
    urls.push(url)
    const raw = new FakeRaw()
    raws.push(raw)
    return raw
  }
  return { urls, raws, factory }
}

describe('fleetSources', () => {
  beforeEach(() => {
    localStorage.clear()
    sessionStorage.clear()
    vi.stubGlobal('indexedDB', new IDBFactory())
  })

  it('is empty when neither loopback nor a relay origin is known', async () => {
    expect(await fleetSources({ loopback: false, relayOrigin: null })).toEqual([])
  })

  it('a loopback tab starts with the local placeholder alone', async () => {
    saveMachine(ATTIC) // a record, but no relay origin to dial it through
    const sources = await fleetSources({ loopback: true, relayOrigin: null })
    expect(sources.map(({ id, name }) => ({ id, name }))).toEqual([
      { id: LOCAL_MACHINE_ID, name: '' },
    ])
  })

  it('builds a client per pinned machine and skips records without keys', async () => {
    saveMachine(MESA) // written down, never pinned — skipped silently
    saveMachine(ATTIC)
    await savePinnedDaemonKeyFor(ATTIC.id, DAEMON_PUB)

    const { urls, raws, factory } = recordingFactory()
    const sources = await fleetSources({
      loopback: false,
      relayOrigin: 'https://relay.example',
      wsFactory: factory,
    })

    expect(sources.map(({ id, name }) => ({ id, name }))).toEqual([
      { id: 'attic-pi', name: 'Attic Pi' },
    ])

    // The client dials the machine's own slot, and seals message A to the key
    // pinned under it — the responder holding that key's private half proves
    // the construction reached for the right record on both axes.
    const client = sources[0]!.client
    client.connect()
    expect(urls).toEqual(['wss://relay.example/client/attic-pi'])
    const raw = raws[0]!
    raw.open()
    const msgA = raw.sent.find((d): d is Uint8Array => typeof d !== 'string')
    expect(msgA).toBeDefined()
    expect(responderHandshake(DAEMON_PRIV).readMessageA(new Uint8Array(msgA!))).toHaveLength(32)
    client.close()
  })

  it('puts the local source first when a tab has both', async () => {
    saveMachine(ATTIC)
    await savePinnedDaemonKeyFor(ATTIC.id, DAEMON_PUB)
    const sources = await fleetSources({ loopback: true, relayOrigin: 'https://relay.example' })
    expect(sources.map((s) => s.id)).toEqual([LOCAL_MACHINE_ID, 'attic-pi'])
  })
})
