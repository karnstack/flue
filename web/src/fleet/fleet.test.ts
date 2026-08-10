import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import { x25519 } from '@noble/curves/ed25519.js'

import vectors from '../../../testdata/noise/ik.json'
import type { ConnStatus, FlueClient } from '@/client/client'
import type { ErrorMsg, SessionInfo, Welcome } from '@/client/protocol'
import {
  loadOrCreateDeviceKey,
  loadPinnedDeviceCert,
  loadPinnedFleetKey,
  savePinnedDaemonKeyFor,
  savePinnedDeviceCert,
  savePinnedFleetKey,
} from '@/crypto/keys'
import { saveMachine } from '@/relay/machines'
import type { RawSocket } from '@/relay/socket'
import {
  base64,
  deviceCert,
  directoryFetch,
  FLEET_PUB,
  machineCert,
  OTHER_PUB,
  OTHER_SEED,
  revocation,
} from '@/testing/fleet'
import { responderHandshake } from '@/testing/noise-daemon'
import {
  adoptFleetCert,
  adoptFleetKey,
  FleetClient,
  fleetSources,
  type FleetGaps,
  type FleetSource,
} from './fleet'
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
 * the fleet consumes — connect, close, list, update, spawn, and the listener
 * registrations — is recorded or replayable, and nothing else exists.
 */
class FakeClient {
  connects = 0
  closes = 0
  lists = 0
  updates: Array<{ id: string; name?: string; tags?: string[]; pinned?: boolean }> = []
  closedIds: string[] = []
  spawns: Array<{ cwd?: string; cmd?: string[]; cols: number; rows: number }> = []
  spawnReply: number | null = 7

  private sessionsCbs: Array<(s: SessionInfo[]) => void> = []
  private statusCbs: Array<(s: ConnStatus) => void> = []
  private welcomeCbs: Array<(w: Welcome) => void> = []
  private errorCbs: Array<(e: ErrorMsg) => void> = []
  private revokedCbs: Array<(reason: string) => void> = []

  onSessions(cb: (s: SessionInfo[]) => void) {
    return listen(this.sessionsCbs, cb)
  }
  onStatus(cb: (s: ConnStatus) => void) {
    return listen(this.statusCbs, cb)
  }
  onWelcome(cb: (w: Welcome) => void) {
    return listen(this.welcomeCbs, cb)
  }
  onError(cb: (e: ErrorMsg) => void) {
    return listen(this.errorCbs, cb)
  }
  onRevoked(cb: (reason: string) => void) {
    return listen(this.revokedCbs, cb)
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
  closeById(id: string) {
    this.closedIds.push(id)
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
  emitError(e: ErrorMsg) {
    for (const cb of [...this.errorCbs]) cb(e)
  }
  emitRevoked(reason: string) {
    for (const cb of [...this.revokedCbs]) cb(reason)
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

/**
 * A scripted source. `pinned` defaults to false — the safe answer, and the one
 * that keeps a case that says nothing about pinning from silently exercising
 * the fleet-key adoption path.
 */
function src(id: string, name: string, fake: FakeClient, pinned = false): FleetSource {
  return { id, name, client: fake as unknown as FlueClient, pinned }
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
  /** Whether the sources are keyed to daemon keys this browser pinned. Off by
   *  default, so only the cases about that say anything about it. */
  pinned = false,
) {
  const fakes = new Map<string, FakeClient>()
  const sources = entries.map(([id, name]) => {
    const f = new FakeClient()
    fakes.set(id, f)
    return src(id, name, f, pinned)
  })
  const fleet = new FleetClient(sources, expand)
  const calls: Array<{ sessions: FleetSession[]; machines: MachineState[] }> = []
  const off = fleet.onFleet((sessions, machines) => calls.push({ sessions, machines }))
  const errs: Array<{ machineId: string; err: ErrorMsg }> = []
  const offErr = fleet.onError((machineId, err) => errs.push({ machineId, err }))
  return {
    fleet,
    calls,
    off,
    errs,
    offErr,
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

  it('closes a revoked source and reports it revoked, reason attached', () => {
    // The consumer FlueClient.onRevoked's doc names: the client keeps its
    // usual recovery unless whoever owns it stops it, and the fleet owns
    // every client. Left alone, a revoked device would redial a daemon whose
    // registry no longer holds its key every ten seconds forever.
    const h = harness([
      ['attic-pi', 'Attic Pi'],
      ['blue-mesa', 'Blue Mesa'],
    ])
    h.fleet.connect()
    h.fake('attic-pi').open()
    h.fake('attic-pi').emitSessions([info('s1')])

    h.fake('attic-pi').emitRevoked('revoked from Blue Mesa')

    expect(h.fake('attic-pi').closes).toBe(1)
    // Its rows go the way an unreachable source's do — nothing from a machine
    // this device can no longer speak for — and the other machine is untouched.
    expect(h.last().sessions).toEqual([])
    expect(h.last().machines).toEqual([
      {
        id: 'attic-pi',
        name: 'Attic Pi',
        status: 'revoked',
        revokedReason: 'revoked from Blue Mesa',
      },
      { id: 'blue-mesa', name: 'Blue Mesa', status: 'connecting' },
    ])
    h.fleet.close()
  })

  it('holds the revoked verdict through the close it issued itself', () => {
    // With a real client the close inside slotRevoked reports `closed`
    // synchronously, and `closed` ordinarily maps to unreachable — which
    // would repaint the verdict as an outage, Retry button and all. The fake
    // emits the same report by hand.
    const h = harness([['attic-pi', 'Attic Pi']])
    h.fleet.connect()
    h.fake('attic-pi').open()

    h.fake('attic-pi').emitRevoked('revoked')
    h.fake('attic-pi').emitStatus('closed')

    expect(h.last().machines).toEqual([
      { id: 'attic-pi', name: 'Attic Pi', status: 'revoked', revokedReason: 'revoked' },
    ])
    h.fleet.close()
  })

  it('a deliberate reconnect re-tests the verdict rather than remembering it', () => {
    // Nothing in the app redials a revoked slot today — that is the point of
    // the state — but a client someone reconnects by hand reports
    // `connecting`, and a fleet that kept saying revoked over a live dial
    // would be describing history.
    const h = harness([['attic-pi', 'Attic Pi']])
    h.fleet.connect()
    h.fake('attic-pi').open()
    h.fake('attic-pi').emitRevoked('revoked')

    h.fake('attic-pi').emitStatus('connecting')
    h.fake('attic-pi').open()

    expect(h.last().machines).toEqual([{ id: 'attic-pi', name: 'Attic Pi', status: 'online' }])
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

  /*
   * The re-supply path, end to end and in one session.
   *
   * A browser that boots without its certificate builds sources for the
   * machines it pinned by hand and skips every machine it can only reach on
   * the fleet's word. The welcome then hands it one. Before this, that
   * certificate sat unused until something reloaded the tab — which is
   * precisely the case re-supply exists for, since a browser missing its
   * certificate is a browser missing machines.
   *
   * `expand` here models the one thing about the real builder that matters:
   * a machine this browser never paired with is only reachable once there is
   * a certificate to present to it (fleetSources skips it otherwise).
   */
  function certExpand(loft: FakeClient) {
    return vi.fn(async (origin: string) => {
      void origin
      return (await loadPinnedDeviceCert()) === null ? [] : [src('loft-9f9f', 'Loft', loft)]
    })
  }

  it('takes the machines a re-supplied certificate unlocks, without a reload', async () => {
    vi.stubGlobal('indexedDB', new IDBFactory())
    await savePinnedFleetKey(FLEET_PUB)
    const key = await loadOrCreateDeviceKey()
    const cert = deviceCert(key.publicKey, 'phone', 'attic-pi')

    const loft = new FakeClient()
    const expand = certExpand(loft)
    const h = harness([[LOCAL_MACHINE_ID, '']], expand)
    h.fleet.connect()
    h.fake(LOCAL_MACHINE_ID).open()

    const relay = { status: 'connected' as const, origin: 'https://relay.example' }
    h.fake(LOCAL_MACHINE_ID).emitWelcome(welcome(relay))
    await vi.waitFor(() => expect(expand).toHaveBeenCalledTimes(1))
    // Nothing unlocked: this browser holds no certificate yet.
    expect(h.last().machines.map((m) => m.id)).toEqual([LOCAL_MACHINE_ID])

    // A later welcome — a reconnect, or another machine saying hello — carries
    // the blob this device is owed.
    h.fake(LOCAL_MACHINE_ID).emitWelcome({ ...welcome(relay), fleetCert: base64(cert) })
    await vi.waitFor(() => expect(expand).toHaveBeenCalledTimes(2))
    expect(await loadPinnedDeviceCert()).toEqual(cert)
    expect(loft.connects).toBe(1)
    expect(h.last().machines.map((m) => m.id)).toEqual([LOCAL_MACHINE_ID, 'loft-9f9f'])

    // And the welcome after that is the same blob again: no third read of the
    // directory, no second Loft.
    h.fake(LOCAL_MACHINE_ID).emitWelcome({ ...welcome(relay), fleetCert: base64(cert) })
    await flush()
    expect(expand).toHaveBeenCalledTimes(2)
    expect(loft.connects).toBe(1)
    h.fleet.close()
  })

  it('unlocks them even when the certificate rides the welcome that names the relay', async () => {
    // The ordinary case, and the one that used to pass by luck: both facts
    // arrive on one welcome, and the expansion is kicked off synchronously
    // while the certificate is still going through IndexedDB. Whichever wins
    // that race, the second expansion is what makes the outcome the same.
    vi.stubGlobal('indexedDB', new IDBFactory())
    await savePinnedFleetKey(FLEET_PUB)
    const key = await loadOrCreateDeviceKey()
    const cert = deviceCert(key.publicKey, 'phone', 'attic-pi')

    const loft = new FakeClient()
    const expand = certExpand(loft)
    const h = harness([[LOCAL_MACHINE_ID, '']], expand)
    h.fleet.connect()
    h.fake(LOCAL_MACHINE_ID).open()
    h.fake(LOCAL_MACHINE_ID).emitWelcome({
      ...welcome({ status: 'connected', origin: 'https://relay.example' }),
      fleetCert: base64(cert),
    })

    await vi.waitFor(() => expect(loft.connects).toBe(1))
    expect(h.last().machines.map((m) => m.id)).toEqual([LOCAL_MACHINE_ID, 'loft-9f9f'])
    h.fleet.close()
  })

  it('does not rebuild for a certificate this browser already held', async () => {
    // A browser that boots *with* one already had every machine it unlocks, so
    // the welcome that re-offers it is a read and nothing more. This is what
    // keeps a reconnect from costing a directory fetch.
    vi.stubGlobal('indexedDB', new IDBFactory())
    await savePinnedFleetKey(FLEET_PUB)
    const key = await loadOrCreateDeviceKey()
    const cert = deviceCert(key.publicKey, 'phone', 'attic-pi')
    await savePinnedDeviceCert(cert)

    const loft = new FakeClient()
    const expand = certExpand(loft)
    const h = harness([[LOCAL_MACHINE_ID, '']], expand)
    h.fleet.connect()
    h.fake(LOCAL_MACHINE_ID).open()
    h.fake(LOCAL_MACHINE_ID).emitWelcome({
      ...welcome({ status: 'connected', origin: 'https://relay.example' }),
      fleetCert: base64(cert),
    })

    await vi.waitFor(() => expect(loft.connects).toBe(1))
    await flush()
    expect(expand).toHaveBeenCalledTimes(1)
    h.fleet.close()
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

  it('routes closeOn to the named machine and no-ops for an unknown one', () => {
    const h = harness([
      ['attic-pi', 'Attic Pi'],
      ['blue-mesa', 'Blue Mesa'],
    ])

    h.fleet.closeOn('blue-mesa', 's1')

    expect(h.fake('blue-mesa').closedIds).toEqual(['s1'])
    expect(h.fake('attic-pi').closedIds).toEqual([])

    // An unknown machine is a no-op, as update treats one: there is nothing
    // on the wire to correlate a refusal to, and the row it would have acted
    // on is not on screen either.
    h.fleet.closeOn('nope', 's1')
    expect(h.fake('blue-mesa').closedIds).toEqual(['s1'])
    expect(h.fake('attic-pi').closedIds).toEqual([])
  })

  it('hands on every machine’s errors, saying which machine raised each', () => {
    const h = harness([
      ['attic-pi', 'Attic Pi'],
      ['blue-mesa', 'Blue Mesa'],
    ])
    h.fleet.connect()

    const gone: ErrorMsg = { type: 'error', code: 'not_found', msg: 'no such session' }
    h.fake('blue-mesa').emitError(gone)
    h.fake('attic-pi').emitError({ type: 'error', code: 'bad_message', msg: 'nope', reqId: 4 })

    // Whole and untouched, because the fleet is a passthrough here and nothing
    // it could add would be more than the screen already knows.
    expect(h.errs).toEqual([
      { machineId: 'blue-mesa', err: gone },
      { machineId: 'attic-pi', err: { type: 'error', code: 'bad_message', msg: 'nope', reqId: 4 } },
    ])
    expect(h.errs[0]!.err).toBe(gone)
    h.fleet.close()
  })

  it('hears a machine adopted after the fleet was already up', async () => {
    // The reason this belongs to the fleet rather than to a screen: the remote
    // sources a loopback tab holds do not exist at mount, so a route that had
    // subscribed to the clients it could see would be deaf on every one of them.
    const remote = new FakeClient()
    const expand = vi.fn(() => Promise.resolve([src('attic-pi', 'Attic Pi', remote)]))
    const h = harness([[LOCAL_MACHINE_ID, '']], expand)
    h.fleet.connect()
    h.fake(LOCAL_MACHINE_ID).open()
    h.fake(LOCAL_MACHINE_ID).emitWelcome(
      welcome({ status: 'connected', origin: 'https://relay.example' }),
    )
    await flush()

    remote.emitError({ type: 'error', code: 'not_found', msg: 'no such session' })

    expect(h.errs).toEqual([
      { machineId: 'attic-pi', err: { type: 'error', code: 'not_found', msg: 'no such session' } },
    ])
    h.fleet.close()
  })

  it('stops delivering errors after unsubscribe, and after close', () => {
    const h = harness([['attic-pi', 'Attic Pi']])
    h.fleet.connect()

    h.offErr()
    h.fake('attic-pi').emitError({ type: 'error', code: 'not_found', msg: '' })
    expect(h.errs).toEqual([])

    // And the source-side registration goes with the rest on close: a closed
    // fleet is a screen on its way out, and it speaks for nobody.
    const after: string[] = []
    h.fleet.onError((machineId) => after.push(machineId))
    h.fleet.close()
    h.fake('attic-pi').emitError({ type: 'error', code: 'not_found', msg: '' })
    expect(after).toEqual([])
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

// ---------------------------------------------------------------------------
// fleetSources against the fleet directory: a machine that joined the relay
// long after this browser paired, appearing without a ceremony.
// ---------------------------------------------------------------------------

/** The machine nobody here ever paired with, and the key its certificate
 *  names — the whole of what a browser needs to reach it. */
const LOFT_PRIV = new Uint8Array(32).fill(0x5c)
const LOFT_PUB = x25519.getPublicKey(LOFT_PRIV)

/** A second such machine, for the cases that count more than one of them. */
const MESA_PUB = x25519.getPublicKey(new Uint8Array(32).fill(0x33))

describe('fleetSources with a fleet directory', () => {
  beforeEach(() => {
    localStorage.clear()
    sessionStorage.clear()
    vi.stubGlobal('indexedDB', new IDBFactory())
  })

  /** This browser's own device key, as the pairing ceremony would have made
   *  it — the key the fleet's device certificate has to name. */
  const devicePub = async () => (await loadOrCreateDeviceKey()).publicKey

  /**
   * The certificate this browser holds, put where it now comes from: its own
   * key store, written by the pairing answer or by a welcome
   * (fleet.ts, adoptFleetCert). It used to be fished out of `GET /directory`,
   * and taking it off that credential-less route is what stopped the directory
   * being a public roster of the operator's devices and growing by one
   * permanent entry per ceremony.
   */
  const holdCert = async (...args: Parameters<typeof deviceCert>) => {
    const cert = deviceCert(...args)
    await savePinnedDeviceCert(cert)
    return cert
  }

  it('builds a source for a machine it never paired with', async () => {
    await savePinnedFleetKey(FLEET_PUB)
    await holdCert(await devicePub())
    const fetch = directoryFetch([machineCert('loft-9f9f', 'Loft', LOFT_PUB)])

    const { urls, raws, factory } = recordingFactory()
    const sources = await fleetSources({
      loopback: false,
      relayOrigin: 'https://relay.example',
      wsFactory: factory,
      directoryFetch: fetch,
    })

    expect(sources.map(({ id, name }) => ({ id, name }))).toEqual([
      { id: 'loft-9f9f', name: 'Loft' },
    ])

    // It dials the machine's own slot and seals message A to the key the
    // certificate named — and carries the device certificate in the payload,
    // which is the only thing that will admit it there (channel.go, rule 2).
    const client = sources[0]!.client
    client.connect()
    expect(urls).toEqual(['wss://relay.example/client/loft-9f9f'])
    const raw = raws[0]!
    raw.open()
    const msgA = raw.sent.find((d): d is Uint8Array => typeof d !== 'string')
    const daemon = responderHandshake(LOFT_PRIV)
    expect(daemon.readMessageA(new Uint8Array(msgA!))).toEqual(await devicePub())
    expect(daemon.payload()).toEqual(deviceCert(await devicePub()))
    client.close()
  })

  it('never builds a source from a machine certificate signed by another key', async () => {
    // The negative this whole leg turns on. The relay holds blobs it cannot
    // read, so a hostile one can serve anything; what makes a machine is a
    // signature under the key pinned at pairing.
    await savePinnedFleetKey(FLEET_PUB)
    const sources = await fleetSources({
      loopback: false,
      relayOrigin: 'https://relay.example',
      directoryFetch: directoryFetch([
        machineCert('loft-9f9f', 'Loft', LOFT_PUB, 1_754_700_000, OTHER_SEED),
      ]),
    })
    expect(sources).toEqual([])
  })

  it('builds nothing from the fleet for a device the fleet revoked', async () => {
    // A revocation outranks the device certificate beside it however much
    // fresher that is, so the browser has nothing to present — and every
    // daemon would refuse it anyway. What it keeps is the machine it paired
    // with directly, whose registry row the revoke on another machine has not
    // reached.
    await savePinnedFleetKey(FLEET_PUB)
    saveMachine(ATTIC)
    await savePinnedDaemonKeyFor(ATTIC.id, DAEMON_PUB)
    const pub = await devicePub()
    await holdCert(pub, 'phone', 'attic-pi', 1_759_999_999)

    const sources = await fleetSources({
      loopback: false,
      relayOrigin: 'https://relay.example',
      directoryFetch: directoryFetch([
        machineCert('loft-9f9f', 'Loft', LOFT_PUB),
        machineCert(ATTIC.id, 'Attic Pi', DAEMON_PUB),
        revocation(pub, 1_754_700_000),
      ]),
    })

    expect(sources.map((s) => s.id)).toEqual(['attic-pi'])
  })

  it('does not send a revoked certificate to a machine it did pair with', async () => {
    await savePinnedFleetKey(FLEET_PUB)
    saveMachine(ATTIC)
    await savePinnedDaemonKeyFor(ATTIC.id, DAEMON_PUB)
    const pub = await devicePub()
    await holdCert(pub, 'phone', 'attic-pi', 1_759_999_999)

    const { raws, factory } = recordingFactory()
    const sources = await fleetSources({
      loopback: false,
      relayOrigin: 'https://relay.example',
      wsFactory: factory,
      directoryFetch: directoryFetch([revocation(pub, 1_754_700_000)]),
    })
    sources[0]!.client.connect()
    raws[0]!.open()
    const msgA = raws[0]!.sent.find((d): d is Uint8Array => typeof d !== 'string')
    const daemon = responderHandshake(DAEMON_PRIV)
    daemon.readMessageA(new Uint8Array(msgA!))
    expect(daemon.payload()).toHaveLength(0)
    sources[0]!.client.close()
  })

  it('keeps the key the ceremony pinned when the fleet names another', async () => {
    // The pin is the stronger fact — a user carried it across on a screen
    // they physically control — and it outlives a fleet key that rotates
    // away, which is the same reason the daemon's rule 1 never looks at a
    // certificate. A stale certificate must not repoint a paired machine.
    await savePinnedFleetKey(FLEET_PUB)
    saveMachine(ATTIC)
    await savePinnedDaemonKeyFor(ATTIC.id, DAEMON_PUB)

    const { raws, factory } = recordingFactory()
    const sources = await fleetSources({
      loopback: false,
      relayOrigin: 'https://relay.example',
      wsFactory: factory,
      directoryFetch: directoryFetch([machineCert(ATTIC.id, 'Attic Pi', LOFT_PUB)]),
    })

    sources[0]!.client.connect()
    raws[0]!.open()
    const msgA = raws[0]!.sent.find((d): d is Uint8Array => typeof d !== 'string')
    // Sealed to the pinned key: the responder holding LOFT_PRIV cannot read it.
    expect(() => responderHandshake(LOFT_PRIV).readMessageA(new Uint8Array(msgA!))).toThrow()
    expect(responderHandshake(DAEMON_PRIV).readMessageA(new Uint8Array(msgA!))).toHaveLength(32)
    sources[0]!.client.close()
  })

  it('takes the fleet’s name for a machine it paired with under another', async () => {
    await savePinnedFleetKey(FLEET_PUB)
    saveMachine(ATTIC)
    await savePinnedDaemonKeyFor(ATTIC.id, DAEMON_PUB)
    const sources = await fleetSources({
      loopback: false,
      relayOrigin: 'https://relay.example',
      directoryFetch: directoryFetch([machineCert(ATTIC.id, 'Attic Pi II', DAEMON_PUB)]),
    })
    expect(sources.map(({ id, name }) => ({ id, name }))).toEqual([
      { id: 'attic-pi', name: 'Attic Pi II' },
    ])
  })

  it('reaches a paired machine whose pin has gone missing, on the fleet’s word', async () => {
    // A record without its key was a row the picker could only offer to pair
    // again. With a fleet key and a certificate it is a machine that works.
    await savePinnedFleetKey(FLEET_PUB)
    saveMachine(ATTIC) // written down, never pinned
    await holdCert(await devicePub())
    const sources = await fleetSources({
      loopback: false,
      relayOrigin: 'https://relay.example',
      directoryFetch: directoryFetch([machineCert(ATTIC.id, 'Attic Pi', DAEMON_PUB)]),
    })
    expect(sources.map((s) => s.id)).toEqual(['attic-pi'])
  })

  it('reads no directory at all without a pinned fleet key', async () => {
    // An unverifiable machine list is a relay naming whatever machines it
    // likes, so a browser with no fleet key does not ask for one.
    saveMachine(ATTIC)
    await savePinnedDaemonKeyFor(ATTIC.id, DAEMON_PUB)
    const fetch = directoryFetch([machineCert('loft-9f9f', 'Loft', LOFT_PUB)])

    const sources = await fleetSources({
      loopback: false,
      relayOrigin: 'https://relay.example',
      directoryFetch: fetch,
    })

    expect(fetch.calls).toEqual([])
    expect(sources.map((s) => s.id)).toEqual(['attic-pi'])
  })

  it('leaves the paired machines standing when the relay serves nothing', async () => {
    // A relay that has not run `flue relay update` answers 503 on this route.
    // The cost is machines this browser does not learn of, never machines it
    // already had.
    await savePinnedFleetKey(FLEET_PUB)
    saveMachine(ATTIC)
    await savePinnedDaemonKeyFor(ATTIC.id, DAEMON_PUB)
    const sources = await fleetSources({
      loopback: false,
      relayOrigin: 'https://relay.example',
      directoryFetch: directoryFetch([], { ok: false, status: 503 }),
    })
    expect(sources.map((s) => s.id)).toEqual(['attic-pi'])
  })

  it('skips a fleet machine when this device holds no certificate for it', async () => {
    // Nothing would admit it: rule 2 is the only door for a machine this
    // browser never paired with, and the certificate is the key to it. A row
    // here would sit at unreachable forever with nothing on screen to say why.
    await savePinnedFleetKey(FLEET_PUB)
    const sources = await fleetSources({
      loopback: false,
      relayOrigin: 'https://relay.example',
      directoryFetch: directoryFetch([machineCert('loft-9f9f', 'Loft', LOFT_PUB)]),
    })
    expect(sources).toEqual([])
  })

  it('counts the machines it skipped instead of only skipping them', async () => {
    // The skip above is correct and used to be the whole story, which left a
    // reader looking at a short list with nothing anywhere to say it was
    // short. The count is what the sessions screen puts on the page.
    await savePinnedFleetKey(FLEET_PUB)
    saveMachine(ATTIC)
    await savePinnedDaemonKeyFor(ATTIC.id, DAEMON_PUB)
    const gaps: FleetGaps[] = []
    const sources = await fleetSources({
      loopback: false,
      relayOrigin: 'https://relay.example',
      onGaps: (g) => gaps.push(g),
      directoryFetch: directoryFetch([
        machineCert('loft-9f9f', 'Loft', LOFT_PUB),
        machineCert('blue-mesa-1a2b', 'Blue Mesa', MESA_PUB),
        machineCert(ATTIC.id, 'Attic Pi', DAEMON_PUB),
      ]),
    })
    expect(sources.map((s) => s.id)).toEqual(['attic-pi'])
    expect(gaps).toEqual([{ uncertified: 2, fleetKey: true, pinned: 1 }])
  })

  it('reports a browser that pinned no fleet key at all', async () => {
    // A browser here reads no directory, so it reaches the machine it paired
    // with and knows of no others — which is worth a sentence on screen,
    // because the alternative is a fleet that silently consists of one
    // machine. `pinned` is what says whether anything can still repair it:
    // one ceremony means one machine that can hand a key over.
    saveMachine(ATTIC)
    await savePinnedDaemonKeyFor(ATTIC.id, DAEMON_PUB)
    const gaps: FleetGaps[] = []
    const sources = await fleetSources({
      loopback: false,
      relayOrigin: 'https://relay.example',
      onGaps: (g) => gaps.push(g),
      directoryFetch: directoryFetch([machineCert('loft-9f9f', 'Loft', LOFT_PUB)]),
    })
    expect(sources.map((s) => s.id)).toEqual(['attic-pi'])
    expect(gaps).toEqual([{ uncertified: 0, fleetKey: false, pinned: 1 }])
  })

  it('reports no ceremonies at all for a tab that pinned nothing', async () => {
    // The other side of that: a loopback tab, whose pairing links point at the
    // relay's address rather than its own. Nothing here can be handed a fleet
    // key, so the screen says something different (routes/sessions.tsx).
    const gaps: FleetGaps[] = []
    await fleetSources({
      loopback: true,
      relayOrigin: 'https://relay.example',
      onGaps: (g) => gaps.push(g),
      directoryFetch: directoryFetch([machineCert('loft-9f9f', 'Loft', LOFT_PUB)]),
    })
    expect(gaps).toEqual([{ uncertified: 0, fleetKey: false, pinned: 0 }])
  })

  it('marks a source by how it learned the daemon key it dials', async () => {
    // The security condition adoptFleetKey turns on, recorded at the one place
    // that knows it. Attic's key came from a ceremony this browser performed;
    // Loft's came from a machine certificate, which verified under the very
    // fleet key a welcome would be offering to replace.
    await savePinnedFleetKey(FLEET_PUB)
    saveMachine(ATTIC)
    await savePinnedDaemonKeyFor(ATTIC.id, DAEMON_PUB)
    await holdCert(await devicePub())

    const sources = await fleetSources({
      loopback: true,
      relayOrigin: 'https://relay.example',
      directoryFetch: directoryFetch([
        machineCert(ATTIC.id, 'Attic Pi', DAEMON_PUB),
        machineCert('loft-9f9f', 'Loft', LOFT_PUB),
      ]),
    })

    expect(sources.map((s) => ({ id: s.id, pinned: s.pinned }))).toEqual([
      // The loopback ride authenticates a session cookie and no key at all.
      { id: LOCAL_MACHINE_ID, pinned: false },
      { id: ATTIC.id, pinned: true },
      { id: 'loft-9f9f', pinned: false },
    ])
  })
})

// ---------------------------------------------------------------------------
// adoptFleetCert: how a browser gets its certificate after the ceremony that
// minted it, now that the relay's public directory does not carry one.
// ---------------------------------------------------------------------------

describe('adoptFleetCert', () => {
  beforeEach(() => {
    localStorage.clear()
    sessionStorage.clear()
    vi.stubGlobal('indexedDB', new IDBFactory())
  })

  /** A welcome carrying `cert`, base64, as the daemon sends one. */
  function welcomeWith(cert: Uint8Array | undefined): Welcome {
    return {
      type: 'welcome',
      daemonId: 'local',
      host: 'mbp',
      ver: 'test',
      ...(cert !== undefined && { fleetCert: base64(cert) }),
    }
  }

  it('keeps a certificate that verifies under the pinned fleet key and names this device', async () => {
    await savePinnedFleetKey(FLEET_PUB)
    const key = await loadOrCreateDeviceKey()
    const cert = deviceCert(key.publicKey, 'phone', 'attic-pi')

    await adoptFleetCert(welcomeWith(cert))
    expect(await loadPinnedDeviceCert()).toEqual(cert)
  })

  it('refuses a certificate signed by another fleet', async () => {
    // The pin is the whole check: a relay that served the page could offer a
    // certificate signed by a key it holds, and this browser would present it
    // to a machine that will refuse it.
    await savePinnedFleetKey(FLEET_PUB)
    const key = await loadOrCreateDeviceKey()
    await adoptFleetCert(welcomeWith(deviceCert(key.publicKey, 'phone', 'attic-pi', 1_754_700_000, OTHER_SEED)))
    expect(await loadPinnedDeviceCert()).toBeNull()
  })

  it('refuses a certificate for another device, however well it verifies', async () => {
    await savePinnedFleetKey(FLEET_PUB)
    const someoneElse = x25519.getPublicKey(new Uint8Array(32).fill(0x77))
    await adoptFleetCert(welcomeWith(deviceCert(someoneElse, 'someone else', 'attic-pi')))
    expect(await loadPinnedDeviceCert()).toBeNull()
  })

  it('refuses a machine certificate offered where a device one belongs', async () => {
    await savePinnedFleetKey(FLEET_PUB)
    await adoptFleetCert(welcomeWith(machineCert('loft-9f9f', 'Loft', LOFT_PUB)))
    expect(await loadPinnedDeviceCert()).toBeNull()
  })

  it('keeps nothing when this browser pinned no fleet key', async () => {
    // Nothing to check it against, so nothing that could be checked. A browser
    // in this state reaches the machines it paired with and no others, which
    // is what it did before the fleet key existed.
    const key = await loadOrCreateDeviceKey()
    await adoptFleetCert(welcomeWith(deviceCert(key.publicKey, 'phone', 'attic-pi')))
    expect(await loadPinnedDeviceCert()).toBeNull()
  })

  it('leaves what it holds alone when a welcome offers nothing', async () => {
    await savePinnedFleetKey(FLEET_PUB)
    const key = await loadOrCreateDeviceKey()
    const cert = deviceCert(key.publicKey, 'phone', 'attic-pi')
    await adoptFleetCert(welcomeWith(cert))

    await adoptFleetCert(welcomeWith(undefined))
    expect(await loadPinnedDeviceCert()).toEqual(cert)
  })

  it('reports only the certificate that arrived where there was none', async () => {
    // What the fleet acts on. Gaining a first certificate can grow the set of
    // machines this browser can reach; replacing one cannot — every machine
    // that ever paired this device minted a certificate of its own, all of
    // them equally admitted everywhere, differing only in name and pairedOn.
    await savePinnedFleetKey(FLEET_PUB)
    const key = await loadOrCreateDeviceKey()

    expect(await adoptFleetCert(welcomeWith(deviceCert(key.publicKey, 'phone', 'attic-pi')))).toBe(
      true,
    )
    const second = deviceCert(key.publicKey, 'phone', 'blue-mesa')
    expect(await adoptFleetCert(welcomeWith(second))).toBe(false)
    // Reported or not, the newer blob is the one kept.
    expect(await loadPinnedDeviceCert()).toEqual(second)
  })

  it('reports nothing for a certificate it refused', async () => {
    await savePinnedFleetKey(FLEET_PUB)
    const someoneElse = x25519.getPublicKey(new Uint8Array(32).fill(0x77))
    expect(await adoptFleetCert(welcomeWith(deviceCert(someoneElse, 'someone else', 'attic-pi')))).toBe(
      false,
    )
    expect(await adoptFleetCert(welcomeWith(undefined))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// adoptFleetKey: the anchor itself, and the one condition it may be moved
// under. Every case here is adversarial on purpose — the refusals are the
// feature, and each of them is a way a browser could be pointed at a fleet
// somebody else chose.
// ---------------------------------------------------------------------------

describe('adoptFleetKey', () => {
  beforeEach(() => {
    localStorage.clear()
    sessionStorage.clear()
    vi.stubGlobal('indexedDB', new IDBFactory())
  })

  /** A welcome offering `pub` as the fleet key, base64, as a daemon sends it. */
  function offering(pub: Uint8Array | string | undefined): Welcome {
    return {
      type: 'welcome',
      daemonId: 'local',
      host: 'mbp',
      ver: 'test',
      ...(pub !== undefined && { fleetPub: typeof pub === 'string' ? pub : base64(pub) }),
    }
  }

  it('keeps a key handed over by a machine this browser pinned', async () => {
    // The whole point. This session is Noise IK against a static key a user
    // carried across on a screen they control, so what arrives on it is an
    // authenticated statement from a party this browser already trusts.
    expect(await adoptFleetKey(offering(FLEET_PUB), true)).toBe(true)
    expect(await loadPinnedFleetKey()).toEqual(FLEET_PUB)
  })

  it('refuses one from a machine this browser never pinned', async () => {
    // No ceremony, no pin, no standing to name the fleet. This is the case the
    // parameter exists for: a loopback ride, a scripted client, anything whose
    // daemon key this browser did not witness.
    expect(await adoptFleetKey(offering(FLEET_PUB), false)).toBe(false)
    expect(await loadPinnedFleetKey()).toBeNull()
  })

  it('refuses one from a machine reached on a certificate alone', async () => {
    // The circular case, and the reason `pinned` is carried on the source
    // rather than inferred from the session. A machine whose Noise key came out
    // of the directory was vouched for *by* the fleet key; letting it hand over
    // a fleet key would let a certificate move the anchor it hangs from.
    await savePinnedFleetKey(FLEET_PUB)
    saveMachine(ATTIC) // a record whose pin is gone; the fleet still names it
    await savePinnedDeviceCert(deviceCert((await loadOrCreateDeviceKey()).publicKey))
    const sources = await fleetSources({
      loopback: false,
      relayOrigin: 'https://relay.example',
      directoryFetch: directoryFetch([machineCert(ATTIC.id, 'Attic Pi', DAEMON_PUB)]),
    })
    const certified = sources.find((s) => s.id === ATTIC.id)!
    expect(certified.pinned).toBe(false)

    // Which is exactly what the adoption then refuses, whatever it offers.
    expect(await adoptFleetKey(offering(OTHER_PUB), certified.pinned)).toBe(false)
    expect(await loadPinnedFleetKey()).toEqual(FLEET_PUB)
  })

  it('refuses a key that is not 32 bytes', async () => {
    // A pin of the wrong width fails closed on every later read (crypto/keys.ts),
    // so a browser that wrote one would hold no fleet key and have spent the
    // one chance a welcome gives it to notice.
    expect(await adoptFleetKey(offering(FLEET_PUB.slice(0, 31)), true)).toBe(false)
    expect(await adoptFleetKey(offering(new Uint8Array(64).fill(3)), true)).toBe(false)
    expect(await loadPinnedFleetKey()).toBeNull()
  })

  it('refuses a key that is not base64 at all, and an empty one', async () => {
    expect(await adoptFleetKey(offering('not base64 !!'), true)).toBe(false)
    expect(await adoptFleetKey(offering(''), true)).toBe(false)
    expect(await adoptFleetKey(offering(undefined), true)).toBe(false)
    expect(await loadPinnedFleetKey()).toBeNull()
  })

  it('keeps the pin it already holds when a machine names another fleet', async () => {
    // Deliberate, not cautious. Two keys differ only if the fleet was set up
    // again, and this browser's certificate is signed by the old one — so
    // adopting the new key would leave it listing machines it cannot present
    // anything to. Pairing again is what mints a certificate, and until then
    // the old pin is the one that describes what this browser can do.
    await savePinnedFleetKey(FLEET_PUB)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    expect(await adoptFleetKey(offering(OTHER_PUB), true)).toBe(false)
    expect(await loadPinnedFleetKey()).toEqual(FLEET_PUB)
    // Surfaced rather than swallowed: a browser and a fleet disagreeing about
    // which key signs is not something to discover from a list staying short.
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })

  it('reports nothing for the key it already had, and warns about nothing', async () => {
    // The ordinary welcome, on every reconnect, from a browser that is already
    // whole. Nothing is gained, so nothing re-expands.
    await savePinnedFleetKey(FLEET_PUB)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await adoptFleetKey(offering(FLEET_PUB), true)).toBe(false)
    expect(await loadPinnedFleetKey()).toEqual(FLEET_PUB)
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })
})

// ---------------------------------------------------------------------------
// The heal, end to end: the state a real fleet put a real browser in, and what
// one welcome now does about it.
// ---------------------------------------------------------------------------

describe('a browser paired before its machine had a fleet key', () => {
  beforeEach(() => {
    localStorage.clear()
    sessionStorage.clear()
    vi.stubGlobal('indexedDB', new IDBFactory())
  })

  it('sees the whole fleet from one welcome, with no ceremony', async () => {
    // The maintainer's own tab. It pinned Attic's daemon key at a ceremony
    // that minted no fleet key and no certificate, because Attic held none at
    // the time — so it read no directory, listed one machine, and the only
    // cure was scanning another code.
    //
    // Attic has a fleet key now (`flue relay join --fleet`, or the daemon
    // re-reading relay.json), so its welcome carries both records. Nothing is
    // stubbed here but the transport and the directory response: the real
    // builder, the real key store, the real certificate verification.
    saveMachine(ATTIC)
    await savePinnedDaemonKeyFor(ATTIC.id, DAEMON_PUB)
    expect(await loadPinnedFleetKey()).toBeNull()

    const { factory } = recordingFactory()
    const fetch = directoryFetch([
      machineCert(ATTIC.id, 'Attic Pi', DAEMON_PUB),
      machineCert('loft-9f9f', 'Loft', LOFT_PUB),
      machineCert('blue-mesa-1a2b', 'Blue Mesa', MESA_PUB),
    ])
    const expand = vi.fn((origin: string) =>
      fleetSources({
        loopback: false,
        relayOrigin: origin,
        wsFactory: factory,
        directoryFetch: fetch,
      }),
    )

    // The ride: Attic, over the relay, keyed to the pin — which is what
    // relayBoot builds and what makes this welcome worth listening to.
    const h = harness([[LOCAL_MACHINE_ID, '']], expand, true)
    h.fleet.connect()
    h.fake(LOCAL_MACHINE_ID).open()

    const key = await loadOrCreateDeviceKey()
    h.fake(LOCAL_MACHINE_ID).emitWelcome({
      ...welcome({
        status: 'connected',
        origin: 'https://relay.example',
        machineId: ATTIC.id,
        machineName: 'Attic Pi',
      }),
      fleetPub: base64(FLEET_PUB),
      fleetCert: base64(deviceCert(key.publicKey, 'phone', ATTIC.id)),
    })

    // Both siblings appear in this session. Attic itself does not appear twice:
    // the ride is that machine, reached the way it always was.
    await vi.waitFor(() =>
      expect(h.last().machines.map((m) => m.id).sort()).toEqual([
        'blue-mesa-1a2b',
        LOCAL_MACHINE_ID,
        'loft-9f9f',
      ]),
    )
    expect(await loadPinnedFleetKey()).toEqual(FLEET_PUB)
    h.fleet.close()

    // And the band goes with it. Asked of the real builder in the state this
    // browser is now in — the same question the fleet asks it on every
    // expansion — there is no gap left to put on the screen.
    const gaps: FleetGaps[] = []
    await fleetSources({
      loopback: false,
      relayOrigin: 'https://relay.example',
      wsFactory: factory,
      directoryFetch: fetch,
      onGaps: (g) => gaps.push(g),
    })
    expect(gaps).toEqual([{ uncertified: 0, fleetKey: true, pinned: 1 }])
  })

  it('stays on its one machine when the ride is not a machine it paired with', async () => {
    // The same welcome, the same fleet key, a ride this browser never pinned —
    // a loopback tab, or any client built from a machine certificate. Nothing
    // is kept and no directory is read, which is the refusal that keeps a fleet
    // key from being whatever the connection said it was.
    saveMachine(ATTIC)
    await savePinnedDaemonKeyFor(ATTIC.id, DAEMON_PUB)

    const fetch = directoryFetch([machineCert('loft-9f9f', 'Loft', LOFT_PUB)])
    const expand = vi.fn((origin: string) =>
      fleetSources({ loopback: false, relayOrigin: origin, directoryFetch: fetch }),
    )
    const h = harness([[LOCAL_MACHINE_ID, '']], expand, false)
    h.fleet.connect()
    h.fake(LOCAL_MACHINE_ID).open()

    const key = await loadOrCreateDeviceKey()
    h.fake(LOCAL_MACHINE_ID).emitWelcome({
      ...welcome({ status: 'connected', origin: 'https://relay.example' }),
      fleetPub: base64(FLEET_PUB),
      fleetCert: base64(deviceCert(key.publicKey, 'phone', ATTIC.id)),
    })

    // The expansion still runs and still builds what this browser pinned by
    // hand — that is the anchor the negatives below hang on, so they are not
    // just an assertion made too early.
    await vi.waitFor(() =>
      expect(h.last().machines.map((m) => m.id)).toEqual([LOCAL_MACHINE_ID, ATTIC.id]),
    )
    expect(await loadPinnedFleetKey()).toBeNull()
    // No key, so no directory: an unverifiable machine list is a relay naming
    // whatever machines it likes, and Loft never appears.
    expect(fetch.calls).toEqual([])
    h.fleet.close()
  })
})
