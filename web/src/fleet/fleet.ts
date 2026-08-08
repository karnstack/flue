/*
 * Every machine this browser can reach, folded into one sessions list.
 *
 * A tab used to hold exactly one FlueClient, and "which machine?" was
 * answered before the router mounted. The sessions revamp asks the other
 * question — what is running *everywhere* — so this layer owns one client per
 * machine and merges what they say, without teaching FlueClient anything: it
 * still knows one socket, one daemon, and nothing about its siblings.
 *
 * The split of labor is deliberate. `fleetSources` is the production builder
 * and the only part that touches storage — which records exist, which hold a
 * pinned key, how a relay client is constructed (exactly as relayBoot does
 * it, because a second spelling of that construction would be a second place
 * for the wrong-key bug to live). FleetClient takes sources already built, so
 * a test hands it scripted clients and never opens a socket.
 *
 * The asymmetry worth knowing before changing anything: a loopback tab knows
 * its own daemon at boot but not the relay, so it starts with one source and
 * *learns* the relay origin from the daemon's welcome — at which point the
 * remote sources are built, once, and the machine the daemon itself holds on
 * the relay is dropped from them rather than reached twice. A relay tab knows
 * the relay at boot (it is the page's own origin, passed in by the caller;
 * nothing here reads `location`) and has no loopback at all. Both end in the
 * same place: one source per reachable machine, each id appearing once.
 */
import { daemonSocketUrl, FlueClient, type ConnStatus } from '@/client/client'
import type { SessionInfo, Welcome } from '@/client/protocol'
import { loadOrCreateDeviceKey, loadPinnedDaemonKeyFor, type DeviceKey } from '@/crypto/keys'
import { listMachines } from '@/relay/machines'
import { relaySocket, type RawSocket } from '@/relay/socket'
import {
  LOCAL_MACHINE_ID,
  type FleetSession,
  type MachineState,
  type MachineStatus,
} from './types'

/**
 * How often every online source is re-asked for its sessions.
 *
 * The same cadence, for the same reason, as REFRESH_MS in routes/sessions.tsx:
 * the protocol has no push for the session set, so a session started from
 * another tab or by `flue open` appears only because somebody asks again. The
 * fleet owns the asking so the interval count stays one per tab rather than
 * one per machine; refetch-on-focus stays the route's job, as before.
 */
const POLL_MS = 3_000

/**
 * How far apart one tick's asks are spread.
 *
 * Every remote source rides the same relay origin, so a tick that asked all
 * of them in one synchronous burst would land N frames on one Worker in the
 * same millisecond, every three seconds, from every open tab. 150ms is wide
 * enough to space the bursts and narrow enough that the last of a dozen
 * machines still answers well inside one poll period.
 */
const STAGGER_MS = 150

/** One machine the fleet should hold: its id, its label, its built client. */
export interface FleetSource {
  id: string
  name: string
  client: FlueClient
}

/** What onFleet hands its listeners, on any change to either half. */
type FleetListener = (sessions: FleetSession[], machines: MachineState[]) => void

/**
 * A source as the fleet holds it: the client it was given, plus everything
 * learned since. `name` starts as the source's and moves — the local source
 * is born nameless and takes the daemon's word for it. `rows` is the latest
 * `sessions` payload and null when there is none to show, which is both
 * "never answered" and "went unreachable": the spec keeps no stale cache, so
 * the two must render the same.
 */
interface Slot {
  id: string
  name: string
  client: FlueClient
  status: MachineStatus
  rows: SessionInfo[] | null
  unsubs: Array<() => void>
}

function toSlot(source: FleetSource): Slot {
  return {
    id: source.id,
    name: source.name,
    client: source.client,
    status: 'connecting',
    rows: null,
    unsubs: [],
  }
}

/** FlueClient's four connection states, folded to the UI's three words. */
function machineStatus(s: ConnStatus): MachineStatus {
  if (s === 'open') return 'online'
  if (s === 'connecting') return 'connecting'
  return 'unreachable'
}

/**
 * FleetClient owns the merged view: one listener registration for the UI, one
 * poll interval for the tab, and the routing of writes back to the machine
 * they belong to. It builds no clients of its own — sources arrive built —
 * with one exception, spelled out on `localWelcome`: the remote sources a
 * loopback tab cannot know until its daemon's welcome names the relay.
 *
 * Lifecycle mirrors FlueClient's own, because the provider above it will run
 * the same connect/close/connect under StrictMode: `close` stops the poll,
 * unhooks every listener and closes every client, and a later `connect` wires
 * and dials them again. The expansion is epoch-guarded for exactly that
 * window — remote sources whose keys were still loading when the fleet closed
 * belong to the epoch that asked for them, and are discarded rather than
 * adopted into the one that did not.
 */
export class FleetClient {
  private slots: Slot[]
  private listeners: FleetListener[] = []
  private running = false
  private poll: ReturnType<typeof setInterval> | null = null
  /** The stagger timers of the current tick, so close leaves none armed. */
  private staggers = new Set<ReturnType<typeof setTimeout>>()
  /** Whether this epoch has already built remotes from a learned origin. */
  private expanded = false
  /** The slot id the loopback daemon holds on the relay, once known. */
  private twinId: string | null = null
  /** Bumped by close, so an in-flight expansion can tell it was orphaned. */
  private epoch = 0

  constructor(
    sources: FleetSource[],
    /**
     * How remote sources are built when the loopback welcome names a relay.
     * The default is the production builder; a test scripts this the way it
     * scripts a socket factory, because the real one reads storage and dials.
     */
    private readonly expand: (relayOrigin: string) => Promise<FleetSource[]> = (origin) =>
      fleetSources({ loopback: false, relayOrigin: origin }),
  ) {
    this.slots = sources.map(toSlot)
  }

  /** Wire every source and start connecting them, and keep polling until `close`. */
  connect() {
    if (this.running) return
    this.running = true
    // Wired first, connected after, over a copy: a client that reports
    // synchronously must find its listener there, and a welcome that drops a
    // twin mutates the array being walked.
    const slots = [...this.slots]
    for (const slot of slots) this.wire(slot)
    for (const slot of slots) slot.client.connect()
    this.poll = setInterval(() => this.pollTick(), POLL_MS)
  }

  /**
   * Stop, for good or until the next `connect`.
   *
   * Silent on purpose — no final emit. A closing fleet is a tab on its way
   * out or a StrictMode remount; announcing every source as unreachable on
   * the way down would make each unmount flash an empty screen first.
   */
  close() {
    if (!this.running) return
    this.running = false
    this.epoch++
    this.expanded = false
    if (this.poll !== null) {
      clearInterval(this.poll)
      this.poll = null
    }
    for (const t of this.staggers) clearTimeout(t)
    this.staggers.clear()
    for (const slot of this.slots) {
      for (const off of slot.unsubs) off()
      slot.unsubs = []
      // No stale cache across a close either: the next connect starts from
      // "not answered yet", not from whatever the last epoch was showing.
      slot.rows = null
      slot.status = 'connecting'
      slot.client.close()
    }
  }

  /**
   * Fires on any change: fresh rows, a status transition, a learned name.
   * Both arrays are built per delivery, never mutated in place, so a React
   * consumer may hold them as state and trust identity to mean change.
   */
  onFleet(cb: FleetListener): () => void {
    this.listeners.push(cb)
    let live = true
    return () => {
      if (!live) return
      live = false
      const at = this.listeners.indexOf(cb)
      if (at >= 0) this.listeners.splice(at, 1)
    }
  }

  /** The named machine's client, for screens that need the full surface. */
  clientFor(machineId: string): FlueClient | null {
    return this.slots.find((s) => s.id === machineId)?.client ?? null
  }

  /**
   * Ask every online source now. Only online ones: FlueClient holds a `list`
   * asked while down and replays it on open, but the fleet already asks on
   * every open (see `slotStatus`), so an owed one would only double it.
   */
  list() {
    for (const slot of this.slots) {
      if (slot.status === 'online') slot.client.list()
    }
  }

  /**
   * Edit session metadata on the machine that owns the session. The patch is
   * handed through untouched — not copied field by field, not spread into
   * anything wider — for the reason FlueClient.update spells out: `name: ''`,
   * `tags: []` and `pinned: false` are three deliberate clears a truthiness
   * copy would drop, and a spread of a wider object would put keys on the
   * wire nobody meant to send. An unknown machine is a no-op, matching what
   * the wire would do with it: nothing, with nothing to correlate.
   */
  update(machineId: string, patch: { id: string; name?: string; tags?: string[]; pinned?: boolean }) {
    this.clientFor(machineId)?.update(patch)
  }

  /**
   * End a session on the machine that owns it, addressed by id — the
   * attach-free close the sessions list needs, routed exactly as `update`
   * routes an edit. An unknown machine is a no-op for the same reason: there
   * is nothing on the wire to correlate a refusal to, and the row this would
   * have acted on is not on screen either.
   */
  closeOn(machineId: string, id: string) {
    this.clientFor(machineId)?.closeById(id)
  }

  /**
   * Spawn on the named machine. Null for a machine the fleet does not hold,
   * exactly as FlueClient answers null for a socket that is down — to the
   * caller both mean "nothing was started", and both surface immediately.
   */
  spawnOn(
    machineId: string,
    opts: { cwd?: string; cmd?: string[]; cols: number; rows: number },
  ): number | null {
    return this.clientFor(machineId)?.spawn(opts) ?? null
  }

  // -------------------------------------------------------------------------

  private wire(slot: Slot) {
    slot.unsubs = [
      slot.client.onStatus((s) => this.slotStatus(slot, s)),
      slot.client.onSessions((rows) => {
        slot.rows = rows
        this.emit()
      }),
    ]
    // Only the loopback daemon's welcome carries facts the fleet acts on —
    // its host name, its relay slot, the relay origin. A remote source's
    // welcome names the machine the record already names.
    if (slot.id === LOCAL_MACHINE_ID) {
      slot.unsubs.push(slot.client.onWelcome((w) => this.localWelcome(w)))
    }
  }

  private slotStatus(slot: Slot, s: ConnStatus) {
    const mapped = machineStatus(s)
    if (mapped === slot.status) return
    slot.status = mapped
    // The fresh ask on open, so a source shows rows the moment it can rather
    // than on the next poll tick — and the *only* rows it shows are fresh:
    if (mapped === 'online') slot.client.list()
    // a source that went away drops its rows the same moment it is reported.
    // No stale cache: rows from a machine nobody can reach are a claim the
    // fleet cannot stand behind, and reconnection re-asks anyway.
    if (mapped === 'unreachable') slot.rows = null
    this.emit()
  }

  /**
   * The loopback daemon's greeting, and the one place the fleet reshapes
   * itself. Three facts arrive together, each idempotent because a reconnect
   * replays the welcome:
   *
   *   - the local display name: `relay.machineName` when the daemon holds a
   *     relay slot, its host otherwise — the machine's own word beats the
   *     empty string the source was built with.
   *   - the twin: when the daemon names the slot it holds on the relay, any
   *     remote source under that id is this same machine reached the long way
   *     round. Loopback wins — closed, dropped, and its id remembered so the
   *     expansion below never rebuilds it.
   *   - the relay origin: the fact a loopback tab cannot know at boot. Learned
   *     here, it triggers the one deferred source construction — once per
   *     epoch, because the welcome that carries it will arrive again on every
   *     reconnect and the machines it names are already held.
   */
  private localWelcome(w: Welcome) {
    const slot = this.slots.find((s) => s.id === LOCAL_MACHINE_ID)
    if (slot === undefined) return
    let changed = false

    const name = w.relay?.machineName ?? w.host
    if (name !== slot.name) {
      slot.name = name
      changed = true
    }

    const twin = w.relay?.machineId
    if (twin !== undefined) {
      this.twinId = twin
      const dupe = this.slots.find((s) => s.id === twin)
      if (dupe !== undefined) {
        this.drop(dupe)
        changed = true
      }
    }

    const origin = w.relay?.origin
    if (origin !== undefined && !this.expanded) {
      this.expanded = true
      void this.adoptRemotes(origin)
    }

    if (changed) this.emit()
  }

  /**
   * Build and adopt the remote sources a learned relay origin unlocks.
   *
   * Everything after the await is guarded twice. The epoch check discards a
   * build the fleet closed out from under — those clients were never
   * connected, so dropping them on the floor leaks nothing. The id checks
   * make adoption idempotent against whatever changed during the key loads:
   * the twin the welcome named, or a source something else already holds.
   */
  private async adoptRemotes(origin: string) {
    const epoch = this.epoch
    let built: FleetSource[]
    try {
      built = await this.expand(origin)
    } catch {
      // A key store that will not open reads as nothing paired, exactly as
      // the picker treats it; the loopback source still stands on its own.
      return
    }
    if (epoch !== this.epoch || !this.running) return
    let changed = false
    for (const source of built) {
      if (source.id === this.twinId) continue
      if (this.slots.some((s) => s.id === source.id)) continue
      const slot = toSlot(source)
      this.slots.push(slot)
      this.wire(slot)
      slot.client.connect()
      changed = true
    }
    if (changed) this.emit()
  }

  /** Remove one slot outright: unhooked, closed, and out of every next emit. */
  private drop(slot: Slot) {
    for (const off of slot.unsubs) off()
    slot.unsubs = []
    slot.client.close()
    const at = this.slots.indexOf(slot)
    if (at >= 0) this.slots.splice(at, 1)
  }

  private pollTick() {
    const online = this.slots.filter((s) => s.status === 'online')
    online.forEach((slot, at) => {
      if (at === 0) {
        slot.client.list()
        return
      }
      const t = setTimeout(() => {
        this.staggers.delete(t)
        // The world may have moved during the wait: a closed fleet asks
        // nothing, a dropped or fallen source is not asked either.
        if (!this.running) return
        if (!this.slots.includes(slot) || slot.status !== 'online') return
        slot.client.list()
      }, at * STAGGER_MS)
      this.staggers.add(t)
    })
  }

  private emit() {
    const sessions = this.merged()
    const machines = this.machines()
    // Copy first, and report rather than rethrow, for Emitter's reason in
    // client/client.ts: delivery runs inside other clients' handlers, and one
    // throwing listener must not sever another machine's event path.
    for (const cb of [...this.listeners]) {
      try {
        cb(sessions, machines)
      } catch (err) {
        console.error('flue: a fleet listener threw; delivery continues', err)
      }
    }
  }

  /**
   * The merged list: each source's latest payload stamped and concatenated in
   * source order. Stamped at delivery rather than at arrival, so a name
   * learned after rows landed — the local welcome always arrives after the
   * source was built — reaches rows already held.
   */
  private merged(): FleetSession[] {
    const out: FleetSession[] = []
    for (const slot of this.slots) {
      if (slot.rows === null) continue
      for (const row of slot.rows) {
        out.push({ ...row, machineId: slot.id, machineName: slot.name })
      }
    }
    return out
  }

  private machines(): MachineState[] {
    return this.slots.map((s) => ({ id: s.id, name: s.name, status: s.status }))
  }
}

/**
 * Build the sources a tab starts from — the production builder behind
 * FleetClient, and the only place fleet code touches storage or constructs a
 * transport.
 *
 * `loopback` says whether this origin serves /ws at all: true on a page the
 * daemon itself served, where the local source is built nameless and the
 * welcome will name it. `relayOrigin` is where remote slots dial — the page's
 * own origin on a relay tab, null on a loopback tab that has not heard from
 * its daemon yet (FleetClient learns it there; see `localWelcome`).
 *
 * Each listMachines record with a pinned key becomes a source built exactly
 * as relayBoot builds its client — same identity, same relaySocket, same
 * factory seam — so the wrong-key bug class has one spelling to be tested
 * against. A record without a key is skipped silently rather than surfaced:
 * the fleet lists machines that can be reached, and re-pairing the missing
 * one is the picker's business, not a status row's.
 */
export async function fleetSources(opts: {
  loopback: boolean
  relayOrigin: string | null
  wsFactory?: (url: string) => RawSocket
}): Promise<FleetSource[]> {
  const sources: FleetSource[] = []
  if (opts.loopback) {
    sources.push({ id: LOCAL_MACHINE_ID, name: '', client: new FlueClient(daemonSocketUrl()) })
  }
  const origin = opts.relayOrigin
  if (origin === null) return sources

  // One device key serves every machine — it is this browser's identity, not
  // a machine's — loaded once and only once a pinned record proves the tab
  // has any handshake to spend it on.
  let deviceKey: DeviceKey | null = null
  for (const record of listMachines()) {
    let daemonPub: Uint8Array | null
    try {
      daemonPub = await loadPinnedDaemonKeyFor(record.id)
    } catch {
      // A key store that will not open answers as a missing pin does: this
      // record cannot be handshaken for, and the fleet lists what it can reach.
      continue
    }
    if (daemonPub === null) continue
    if (deviceKey === null) {
      try {
        deviceKey = await loadOrCreateDeviceKey()
      } catch {
        break
      }
    }
    const identity = { deviceKey, daemonPub }
    sources.push({
      id: record.id,
      name: record.name,
      client: new FlueClient(origin, (o) => relaySocket(o, identity, record.id, opts.wsFactory)),
    })
  }
  return sources
}
