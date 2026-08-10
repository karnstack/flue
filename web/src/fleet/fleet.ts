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
import type { ErrorMsg, Preview, SessionInfo, Welcome } from '@/client/protocol'
import { sameKey, verifyCert } from '@/crypto/cert'
import {
  KEY_BYTES,
  loadOrCreateDeviceKey,
  loadPinnedDaemonKeyFor,
  loadPinnedDeviceCert,
  loadPinnedFleetKey,
  savePinnedDeviceCert,
  savePinnedFleetKey,
  type DeviceKey,
} from '@/crypto/keys'
import { readDirectory, type DirectoryFetch, type FleetView } from '@/relay/directory'
import { listMachines, mergeMachines } from '@/relay/machines'
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

/**
 * How often an open tab asks the fleet directory again.
 *
 * The expansion used to be one-shot per epoch, which was right when the only
 * thing that could change the answer was a record arriving on a welcome. It is
 * not: a machine that runs the join line this afternoon appears in the
 * directory this afternoon, and a tab that has been open since this morning
 * would never hear of it — the fleet's own screens promise "every machine",
 * and a promise kept only across a reload is not one.
 *
 * A minute, and not the three seconds the session poll runs at, because this is
 * a different question with a different rate of change: sessions come and go
 * while somebody watches, machines join a fleet a handful of times in their
 * life. Every read is additive (see `adoptRemotes`), so the cost of being late
 * is bounded and the cost of a failed read is nothing at all.
 */
const DISCOVER_MS = 60_000

/**
 * The shortest gap between two directory reads, whatever asks for them.
 *
 * Focus is the other trigger, and focus is not rationed by anything: a reader
 * alt-tabbing between a terminal and this tab would otherwise spend a directory
 * read per switch. The floor is what makes "ask again when the tab is looked
 * at" safe to offer.
 */
const DISCOVER_FLOOR_MS = 5_000

/** One machine the fleet should hold: its id, its label, its built client. */
export interface FleetSource {
  id: string
  name: string
  client: FlueClient
  /**
   * Whether this client's transport authenticates its daemon against a static
   * key *this browser pinned at a pairing ceremony* — as opposed to one taken
   * from a machine certificate, or no key at all.
   *
   * It travels with the source because only whoever built the transport knows
   * it. By the time a welcome arrives, every session looks alike from the
   * outside: one is Noise against a key a user carried across on a screen they
   * control, another is Noise against a key the fleet vouched for, a third is a
   * session cookie on loopback, and nothing in the message says which.
   *
   * What turns on it is `adoptFleetKey`, and only that. A fleet key is the
   * anchor every machine certificate hangs from, so it may be kept from a peer
   * this browser authenticated out of band and from nobody else. Anything the
   * fleet key itself vouched for is downstream of that anchor and cannot be
   * allowed to move it.
   */
  pinned: boolean
}

/**
 * What an expansion could not build — the fleet this browser is not in.
 *
 * Every skip here was silent, which is exactly the kind of fact a screen has
 * to state rather than leave a reader to infer from a short list. They are
 * counts and a flag rather than machines because there is nothing to act on per
 * row: a machine with no certificate cannot be dialled, retried or named — it
 * is a line in a signed directory this browser cannot present anything to.
 *
 * A snapshot of one expansion, not a verdict. The fleet re-expands the moment a
 * welcome hands over something that changes the answer, so a gap reported at
 * boot may be gone a heartbeat later; see FleetClient.adoptFromWelcome.
 */
export interface FleetGaps {
  /**
   * Machines the fleet directory names that this browser holds neither a
   * pinned key for nor a certificate to present to. Every one of them is a
   * machine the reader believes they are on the fleet with.
   */
  uncertified: number
  /**
   * Whether this browser has a fleet key pinned at all. False is the browser
   * that paired with a machine holding no fleet key — before fleet trust
   * existed, or during the window a daemon could be live on a relay and unable
   * to sign — and it used to be the one gap nothing could repair over the wire.
   *
   * It repairs itself now, from the welcome of any machine this browser paired
   * with by hand (`adoptFleetKey`), so false is usually a browser mid-repair.
   * What it means when it *stays* false is what `pinned` is for.
   */
  fleetKey: boolean
  /**
   * How many machines this browser holds a pinned daemon key for — the
   * ceremonies it actually performed.
   *
   * It is here because it is what tells a false `fleetKey` apart from a stuck
   * one. Above zero, some machine can hand this browser the fleet key as soon
   * as it answers, and a screen has only to say so. At zero there is nobody to
   * ask: the tab is riding a machine it never paired with — a loopback tab is
   * the ordinary case — and another ceremony is the whole of the way out.
   */
  pinned: number
}

/**
 * The two things only a loopback tab supplies, injected rather than sniffed.
 *
 * Both are facts about the *page's* origin rather than about any machine, and
 * this module deliberately reads no `location` — the relay origin arrives from
 * the caller on a relay tab and from the daemon's welcome on a loopback one,
 * and the same discipline applies to these. They travel from src/main.tsx
 * through the router's context to the provider, which is the one place that
 * knows which of the two ways this page was served.
 */
export interface FleetOptions {
  /**
   * How this browser becomes a device of the fleet, on a tab that never ran a
   * ceremony because it never needed one. Run once per epoch at `connect`; see
   * fleet/enrol.ts, which is where the whole argument for it lives.
   *
   * Absent on a relay tab and in every test that does not say otherwise, which
   * is the honest default: enrolment is a loopback-only endpoint, and a tab
   * that reached this app any other way has already paired.
   */
  enrol?: () => Promise<boolean>
  /**
   * How the default expansion reads the fleet directory. Absent means the
   * plain cross-origin read straight off the relay, which is what a relay tab
   * does and always did; a loopback tab passes the daemon's proxy, because the
   * Worker sends no CORS header and the browser discards its answer.
   */
  directoryFetch?: DirectoryFetch
}

/** What onFleet hands its listeners, on any change to either half. */
type FleetListener = (sessions: FleetSession[], machines: MachineState[]) => void

/** What onError hands its listeners: the machine that raised it, and the error. */
type ErrorListener = (machineId: string, err: ErrorMsg) => void

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
  /** The source's own; see FleetSource.pinned. Never recomputed here, because
   *  the fact is about how the transport was built and nothing later can
   *  observe it. */
  pinned: boolean
  status: MachineStatus
  rows: SessionInfo[] | null
  /**
   * The daemon's reason when it revoked this device, null otherwise. Held
   * beside `status` rather than folded into it because it is what the UI has
   * to say, and because `slotStatus` reads it to keep the close this fleet
   * issues from repainting the verdict as an ordinary outage.
   */
  revoked: string | null
  unsubs: Array<() => void>
}

function toSlot(source: FleetSource): Slot {
  return {
    id: source.id,
    name: source.name,
    client: source.client,
    pinned: source.pinned,
    status: 'connecting',
    rows: null,
    revoked: null,
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
  private errorListeners: ErrorListener[] = []
  private running = false
  private poll: ReturnType<typeof setInterval> | null = null
  /** The slower interval that re-reads the directory; see DISCOVER_MS. */
  private discovery: ReturnType<typeof setInterval> | null = null
  /** When the last directory read was asked for, for DISCOVER_FLOOR_MS. */
  private lastDiscover = 0
  /** The focus handler, held so close can take it off the window again. */
  private readonly onFocus = () => this.discover()
  /** The stagger timers of the current tick, so close leaves none armed. */
  private staggers = new Set<ReturnType<typeof setTimeout>>()
  /** Whether this epoch has already built remotes from a learned origin. */
  private expanded = false
  /**
   * The relay origin the expansion ran against, kept so a certificate that
   * arrives after it can ask for a second one. Null on a tab whose welcome
   * has not named a relay, which is a tab with nothing to expand into.
   */
  private relayOrigin: string | null = null
  /**
   * Whether records that arrived mid-epoch have already forced that second
   * expansion — a fleet key, a certificate, or the two together, off a welcome
   * or out of an enrolment.
   *
   * Once per epoch: a browser gains machines the first time it holds each of
   * them, and re-running on every later welcome would be a directory read per
   * reconnect for a set that cannot have changed. One flag covers all of them
   * because they cannot arrive apart in a way that would strand the last — a
   * certificate is verified under the fleet key, so a browser missing both
   * gains them in that order, on the one welcome or in the one enrolment
   * answer, before this is consulted.
   *
   * It bounds the *repair*, not discovery: `discover` below re-reads on its own
   * schedule for machines that join later, and is not gated on this.
   */
  private resupplied = false
  /** The slot id the loopback daemon holds on the relay, once known. */
  private twinId: string | null = null
  /** Bumped by close, so an in-flight expansion can tell it was orphaned. */
  private epoch = 0

  /**
   * What the last expansion could not build, or null before one has run.
   * Held so a screen can say it; see FleetGaps.
   */
  private gapsState: FleetGaps | null = null

  /**
   * How remote sources are built when the loopback welcome names a relay.
   * The default is the production builder; a test scripts this the way it
   * scripts a socket factory, because the real one reads storage and dials.
   */
  private readonly expand: (relayOrigin: string) => Promise<FleetSource[]>

  /** This tab's way of becoming a fleet device, or null where there is none
   *  to be had. See FleetOptions.enrol. */
  private readonly enrol: (() => Promise<boolean>) | null

  constructor(
    sources: FleetSource[],
    expand?: (relayOrigin: string) => Promise<FleetSource[]>,
    opts: FleetOptions = {},
  ) {
    this.slots = sources.map(toSlot)
    this.enrol = opts.enrol ?? null
    // Assigned in the body rather than as a parameter default because the
    // production builder reports back into this instance: what it could not
    // build is as much a part of the fleet as what it could.
    this.expand =
      expand ??
      ((origin) =>
        fleetSources({
          loopback: false,
          relayOrigin: origin,
          onGaps: (g) => this.noteGaps(g),
          // Passed through rather than decided down there, because which read
          // works is a fact about the origin serving this page and fleetSources
          // is handed a relay origin and nothing else.
          ...(opts.directoryFetch !== undefined && { directoryFetch: opts.directoryFetch }),
        }))
  }

  /**
   * What this browser could not reach, as of the last expansion, or null on a
   * tab that has not run one — a loopback tab before its welcome names a
   * relay, or a test driving scripted sources.
   *
   * Read after an onFleet delivery: noteGaps emits, so a screen holding this
   * as state is told when it changes for the same reason it is told when a
   * machine goes offline.
   */
  gaps(): FleetGaps | null {
    return this.gapsState
  }

  /** Record what the builder skipped, and tell the screens if it changed. */
  private noteGaps(g: FleetGaps) {
    const held = this.gapsState
    if (
      held !== null &&
      held.uncertified === g.uncertified &&
      held.fleetKey === g.fleetKey &&
      held.pinned === g.pinned
    ) {
      return
    }
    this.gapsState = g
    this.emit()
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
    this.discovery = setInterval(() => this.discover(), DISCOVER_MS)
    // A background tab's timers are throttled to a crawl, so the interval alone
    // would mean a machine that joined an hour ago appears some time after the
    // reader comes back rather than as they arrive. Same trade, same reason, as
    // useRefetchOnFocus on the sessions screen.
    if (typeof window !== 'undefined') window.addEventListener('focus', this.onFocus)
    // Before anything is expanded, and not awaited: the records it may bring
    // back are what the expansion reads, but the welcome that names a relay has
    // not arrived either, and the two orders both end in one rebuild — see
    // `runEnrolment`.
    if (this.enrol !== null) void this.runEnrolment(this.enrol)
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
    this.resupplied = false
    this.relayOrigin = null
    this.lastDiscover = 0
    if (this.poll !== null) {
      clearInterval(this.poll)
      this.poll = null
    }
    if (this.discovery !== null) {
      clearInterval(this.discovery)
      this.discovery = null
    }
    if (typeof window !== 'undefined') window.removeEventListener('focus', this.onFocus)
    for (const t of this.staggers) clearTimeout(t)
    this.staggers.clear()
    for (const slot of this.slots) {
      for (const off of slot.unsubs) off()
      slot.unsubs = []
      // No stale cache across a close either: the next connect starts from
      // "not answered yet", not from whatever the last epoch was showing.
      // The revocation verdict goes with the rest for the same reason — the
      // next epoch dials again and re-learns it, which is also the honest
      // answer for a device that was paired again in the meantime.
      slot.rows = null
      slot.status = 'connecting'
      slot.revoked = null
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

  /**
   * Every machine's errors, on one registration, each stamped with the machine
   * that raised it.
   *
   * This belongs to the fleet rather than to the screens above it because a
   * screen cannot enumerate the machines: a loopback tab learns its remote
   * sources from its daemon's welcome, some way into the session, so anything
   * that subscribed to the clients it could see at mount would be deaf on
   * exactly the machines it gained afterwards. Wiring it beside the status and
   * sessions listeners means a slot adopted mid-epoch is heard from the moment
   * it is wired and unhooked with the rest on close.
   *
   * A passthrough, deliberately: the message is handed on whole and nothing
   * here reads `code` or `reqId`. Which errors matter — the correlated ones
   * belong to whoever holds the reqId, the uncorrelated ones to whichever
   * screen last asked for something — is a judgement the consumer makes, and
   * the fleet has no standing to make it for them.
   */
  onError(cb: ErrorListener): () => void {
    this.errorListeners.push(cb)
    let live = true
    return () => {
      if (!live) return
      live = false
      const at = this.errorListeners.indexOf(cb)
      if (at >= 0) this.errorListeners.splice(at, 1)
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
   * The tail of one session's scrollback, from the machine that owns it.
   *
   * Routed exactly as `update` and `closeOn` route their verbs, with one
   * difference the promise makes plain: a machine the fleet does not hold is
   * a rejection rather than a silent no-op. The other two aim at a row the
   * reader just acted on and can retry; this one is asked *for* the reader, by
   * a card that has to decide between showing bytes and showing why it cannot,
   * and a promise that never settled would leave it deciding neither.
   */
  peekOn(machineId: string, id: string, bytes?: number): Promise<Preview> {
    const client = this.clientFor(machineId)
    if (client === null) return Promise.reject(new Error('flue: no such machine'))
    return client.peek(id, bytes)
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
      slot.client.onError((err) => this.emitError(slot.id, err)),
      slot.client.onRevoked((reason) => this.slotRevoked(slot, reason)),
    ]
    // Every welcome may carry the two records a browser needs to be on a fleet
    // rather than on one machine: this device's own certificate, and the fleet
    // key that verifies it. The slot is passed because the second is gated on
    // it — see adoptFromWelcome — while the first is not.
    slot.unsubs.push(slot.client.onWelcome((w) => void this.adoptFromWelcome(slot, w)))
    // The rest of the welcome is the loopback daemon's alone — its host name,
    // its relay slot, the relay origin. A remote source's welcome names the
    // machine the record already names.
    if (slot.id === LOCAL_MACHINE_ID) {
      slot.unsubs.push(slot.client.onWelcome((w) => this.localWelcome(w)))
    }
  }

  private slotStatus(slot: Slot, s: ConnStatus) {
    if (slot.revoked !== null) {
      // The `closed` this fleet's own slotRevoked issued reports itself here,
      // and must not repaint the verdict as an ordinary outage: revoked is a
      // final state, and `unreachable` would put a Retry on it that can only
      // fail the handshake.
      if (s === 'closed' || s === 'reconnecting') return
      // Anything else means somebody deliberately reconnected this client —
      // FlueClient.connect cleared its own copy for the same reason — so the
      // verdict is re-tested rather than remembered.
      slot.revoked = null
    }
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
   * The daemon on this slot revoked this device and is about to hang up.
   *
   * This is the consumer FlueClient.onRevoked's contract names: the client
   * keeps its usual recovery unless whoever owns it stops it, and the fleet
   * owns every client. Left running, a revoked device redials a daemon whose
   * registry no longer holds its key every ten seconds for the life of the
   * tab, each attempt failing as a bare close with nothing on screen to say
   * why. So: close the client — which also stands down any armed retry — and
   * report the slot as revoked, reason attached, for the screens to say so.
   */
  private slotRevoked(slot: Slot, reason: string) {
    slot.revoked = reason
    slot.status = 'revoked'
    // No stale rows: same grounds as the unreachable case above, with less
    // appeal — nothing from this machine is coming back without a re-pair.
    slot.rows = null
    // Ordered after the verdict is written down, because close reports
    // `closed` synchronously and slotStatus reads `slot.revoked` to know
    // that report is this fleet's own doing.
    slot.client.close()
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
    if (origin !== undefined) {
      // Remembered whether or not it triggers a build, because the *other*
      // trigger — a certificate arriving after the expansion already ran —
      // has no welcome of its own to read an origin from.
      this.relayOrigin = origin
      if (!this.expanded) {
        this.expanded = true
        void this.adoptRemotes(origin)
      }
    }

    if (changed) this.emit()
  }

  /**
   * A welcome's fleet key and certificate, kept — and the machines they unlock,
   * taken now rather than on the next page load.
   *
   * The order this repairs: a browser that boots holding neither builds sources
   * for the machines it pinned by hand and skips every machine it can only
   * reach on the fleet's word — without the key it does not even read the
   * directory that names them. The first welcome then hands both over. Without
   * this they would sit in IndexedDB unused until something reloaded the tab,
   * which is exactly the case the re-supply path exists for: a browser missing
   * either record is a browser missing machines.
   *
   * **The key first, and that ordering is load-bearing.** `adoptFleetCert`
   * verifies under the pinned fleet key, so a browser holding no key would
   * refuse the certificate riding the very welcome that brought it one. Taken
   * in this order, the browser that has been stuck longest — no key, no
   * certificate, one machine — is whole again from a single welcome.
   *
   * Only records this browser did not already hold re-expand, so the usual
   * welcome — the same blobs it has had all along — costs two IndexedDB reads
   * and nothing else. `resupplied` bounds it to one rebuild per epoch even if
   * several slots say hello at once.
   *
   * The rebuild is `adoptRemotes` unchanged, which is why this is safe to run
   * a second time: it is idempotent by id, skips the twin, and discards
   * everything if the fleet closed while it was reading the directory.
   */
  private async adoptFromWelcome(slot: Slot, w: Welcome) {
    const key = await adoptFleetKey(w, slot.pinned)
    const cert = await adoptFleetCert(w)
    if (!key && !cert) return
    if (this.resupplied || !this.running) return
    const origin = this.relayOrigin
    if (origin === null) return
    this.resupplied = true
    await this.adoptRemotes(origin)
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
    // Every expansion counts against the discovery floor, whoever asked for it:
    // a tab that has just read the directory on a welcome has no more to learn
    // from reading it again because somebody clicked back into the window.
    this.lastDiscover = Date.now()
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

  /**
   * Become a device of this fleet, on the one kind of tab that has to ask.
   *
   * The two orders this has to survive, because the enrolment and the daemon's
   * welcome race and neither wins reliably:
   *
   *   - **Records first.** `relayOrigin` is still null — the welcome that names
   *     it has not landed — so there is nothing to expand into and nothing to
   *     do. The welcome arrives a moment later and `localWelcome` expands with
   *     the fleet key and the certificate already in the store.
   *   - **Welcome first.** The expansion has already run, and ran blind: with
   *     no fleet key it read no directory at all and built the machines this
   *     browser had pinned, which on a loopback tab is none. So this rebuilds,
   *     through the same `resupplied` gate the welcome path uses, which is what
   *     bounds the pair to one extra directory read per epoch.
   *
   * Nothing is retried and nothing is scheduled. A daemon that cannot enrol
   * this browser — no fleet key, no machine id, a registry it cannot write —
   * will not be able to a second later either, and the tab it leaves behind is
   * the tab loopback has always been: this machine, listed and working.
   */
  private async runEnrolment(enrol: () => Promise<boolean>) {
    const epoch = this.epoch
    let gained: boolean
    try {
      gained = await enrol()
    } catch {
      // enrolThisBrowser answers rather than throws; a caller's seam might not.
      return
    }
    if (!gained || epoch !== this.epoch || !this.running) return
    if (this.resupplied) return
    const origin = this.relayOrigin
    if (origin === null) return
    this.resupplied = true
    await this.adoptRemotes(origin)
  }

  /**
   * Ask the fleet directory again, for the machines that were not in it last
   * time.
   *
   * **Additive, and that is the whole contract.** `adoptRemotes` adds ids it
   * does not already hold and removes nothing, so a read that comes back empty,
   * short, or as a 502 from a relay having a bad minute costs exactly nothing —
   * every machine already on screen keeps its client, its rows and its status.
   * A machine that genuinely left the fleet is a slot that goes unreachable,
   * which is a thing the screens already say, and re-reading a directory is not
   * where that verdict belongs.
   *
   * Silent before a relay origin is known: a tab whose daemon has named no
   * relay has no directory to read and nothing to discover.
   */
  private discover() {
    if (!this.running) return
    const origin = this.relayOrigin
    if (origin === null) return
    const now = Date.now()
    if (now - this.lastDiscover < DISCOVER_FLOOR_MS) return
    this.lastDiscover = now
    void this.adoptRemotes(origin)
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

  /** One machine's error, to every listener. Copied and caught, as `emit` is. */
  private emitError(machineId: string, err: ErrorMsg) {
    for (const cb of [...this.errorListeners]) {
      try {
        cb(machineId, err)
      } catch (e) {
        console.error('flue: a fleet error listener threw; delivery continues', e)
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
    // The reason rides along only when there is one, so the three ordinary
    // states keep the exact shape every consumer already compares against.
    return this.slots.map((s) => ({
      id: s.id,
      name: s.name,
      status: s.status,
      ...(s.revoked !== null && { revokedReason: s.revoked }),
    }))
  }
}

/**
 * Keep the fleet's public key when a welcome offers one — but only from a
 * machine this browser paired with itself.
 *
 * **What was wrong with "a fleet key cannot be re-supplied".** The claim used
 * to be that a key learned from a connection is a key the connection chose, so
 * pinning it would be trust-on-first-use one level up. That is true of an
 * arbitrary connection and it was too strong for this one. A browser that
 * pinned a machine's daemon static key at a ceremony has an authenticated
 * channel to that machine: the Noise IK session names the pinned key as the
 * responder's static, so message B only decrypts for a peer holding its private
 * half (crypto/noise.ts, and internal/crypto/handshake.go on the other side).
 * A key arriving there is an authenticated statement from a party this browser
 * already trusts out of band, not an assertion from an unknown peer.
 *
 * Three things follow, and they are the whole safety argument:
 *
 *   - A hostile relay cannot inject one. It carries ciphertext and cannot forge
 *     the session; a welcome it wrote never decrypts.
 *   - A compromised daemon gains nothing. The fleet seed sits in relay.json on
 *     every machine, so a machine that could lie about this key can already
 *     mint a device certificate for any key it likes — it holds fleet power
 *     already, and handing over a wrong key is not an escalation.
 *   - A browser with no pinned daemon key anywhere still has only the QR, which
 *     is unchanged and correct.
 *
 * Which is why `pinnedDaemon` is a parameter and not an inference. The key may
 * be taken from a session keyed to a *pinned* daemon key and from no other:
 * never from one whose daemon key came out of a machine certificate, because
 * that certificate verified under the very key being replaced and the anchor
 * cannot be moved by what it anchors; and never from loopback, which
 * authenticates a session cookie rather than any key at all. FleetSource.pinned
 * is where the fact is recorded, at the one place that knows it.
 *
 * **An existing pin is never overwritten**, and that is a deliberate choice
 * rather than caution. Two keys can differ only if the fleet was set up again
 * (`flue relay setup` mints a fresh one), and in that world this browser's
 * device certificate is signed by a key nothing honours any more: adopting the
 * new key would leave it verifying machine certificates it still cannot present
 * anything to, so it would list machines it cannot reach instead of machines it
 * can. Keeping the old pin leaves it exactly as it was, with the ceremony — the
 * one thing that mints a certificate — as the way out. The mismatch goes to the
 * console rather than being swallowed, because a browser and a fleet disagreeing
 * about which key signs is not something to discover by watching a list stay
 * short.
 *
 * Returns whether this browser gained a key it did not have, which is the one
 * case the caller can act on: without one it read no directory at all, so it
 * has every machine on the fleet to gain.
 */
export async function adoptFleetKey(w: Welcome, pinnedDaemon: boolean): Promise<boolean> {
  if (!pinnedDaemon) return false
  if (w.fleetPub === undefined || w.fleetPub === '') return false
  const key = decodeBase64(w.fleetPub)
  // The same width every reader in crypto/keys.ts enforces. A record of any
  // other length is one that module could never have written, and a verifier
  // handed it refuses every certificate — a browser listing no machines rather
  // than one listing the wrong ones, which is a silent version of the state
  // this whole path exists to end.
  if (key === null || key.length !== KEY_BYTES) return false
  try {
    const held = await loadPinnedFleetKey()
    if (held !== null) {
      if (!sameKey(held, key)) {
        console.warn(
          'flue: this machine signs under a different fleet key than the one this browser pinned; keeping the pin. Pair again from a machine on the new fleet.',
        )
      }
      return false
    }
    await savePinnedFleetKey(key)
    return true
  } catch {
    // A key store that will not open. This browser keeps what it had, which is
    // the same answer it has for a daemon that offered nothing.
    return false
  }
}

/**
 * Keep this device's fleet certificate when a welcome offers one.
 *
 * This is the re-supply path, and the reason a certificate no longer has to
 * live in the relay's public directory. The ceremony hands one over in its
 * answer; every relayed connection after that offers the same blob again,
 * inside Noise, to a device that has already proved it holds the key the
 * certificate names. So a browser that never stored one, or lost it, or was
 * paired before its machine had a fleet key, picks one up from any machine it
 * can still reach that way. A loopback welcome carries none — a session-token
 * connection has named no device key — so this listener earns its keep on the
 * relay sources, and a tab that only ever paired over loopback re-pairs.
 *
 * Unlike the fleet key above, this is not gated on which machine sent it. It
 * does not have to be: a certificate is checked against a signature, so the
 * sender's standing adds nothing a bad blob could not fail on its own.
 *
 * Verified before it is kept, under the fleet key pinned at pairing and against
 * this browser's own device key — the same three checks the pairing page makes,
 * for the same reason: a certificate arriving over a channel is a claim until
 * a signature says otherwise, and one naming another device's key is not this
 * browser's to present. Everything else is dropped in silence, because a
 * certificate is what reaches *other* machines and its absence costs nothing on
 * the machine that just said hello.
 *
 * The new blob is written even when one is already stored, and the two are
 * usually different bytes rather than the same ones. Every machine that has
 * ever paired this device holds a certificate of its own, all of them equally
 * valid and differing only in `name` and `pairedOn`, so a browser paired on
 * two machines keeps whichever welcome landed last. That is not a problem to
 * solve: any of them admits it everywhere, and the machine that just
 * authenticated this device is as good a source as any.
 *
 * **Returns whether this browser gained a certificate it did not have**, which
 * is the one case the caller can act on: the set of machines a browser can
 * reach is computed from the certificate it holds, so a browser that had none
 * has machines to gain. A replacement changes nothing about reachability, so
 * it reports false — see FleetClient.adoptCert.
 */
export async function adoptFleetCert(w: Welcome): Promise<boolean> {
  if (w.fleetCert === undefined || w.fleetCert === '') return false
  try {
    const fleetPub = await loadPinnedFleetKey()
    if (fleetPub === null) return false
    const blob = decodeBase64(w.fleetCert)
    if (blob === null) return false
    const cert = verifyCert(fleetPub, blob)
    if (cert === null || cert.kind !== 'device') return false
    const key = await loadOrCreateDeviceKey()
    if (!sameKey(cert.device, key.publicKey)) return false
    // Read before the write, because "was there one before this" is the answer
    // the caller wants and the write destroys it.
    const held = await loadPinnedDeviceCert()
    await savePinnedDeviceCert(blob)
    return held === null
  } catch {
    // A key store that will not open, a welcome that carried nonsense. Both
    // mean this browser keeps whatever it already had, which is the same
    // answer it has for a daemon that offered nothing.
    return false
  }
}

/** Standard base64 with padding, which is how Go's encoding/json writes the
 *  `[]byte` this field is. Null for anything that is not. */
function decodeBase64(text: string): Uint8Array | null {
  try {
    return Uint8Array.from(atob(text), (c) => c.charCodeAt(0))
  } catch {
    return null
  }
}

/**
 * Build the sources a tab starts from — the production builder behind
 * FleetClient, and the only place fleet code touches storage, reads the
 * directory or constructs a transport.
 *
 * `loopback` says whether this origin serves /ws at all: true on a page the
 * daemon itself served, where the local source is built nameless and the
 * welcome will name it. `relayOrigin` is where remote slots dial — the page's
 * own origin on a relay tab, null on a loopback tab that has not heard from
 * its daemon yet (FleetClient learns it there; see `localWelcome`).
 *
 * **Two ways a machine gets here, and one way it is reached.** A pairing
 * record with a pinned key is the original: a ceremony this browser performed,
 * whose key the user witnessed. A machine certificate out of the fleet
 * directory is the other, and it is what makes a machine joined last week
 * appear in this list without anybody scanning anything — verified under the
 * fleet key pinned at pairing, then trusted for exactly one thing, the `noise`
 * key to hand the handshake. Either way the source is built as relayBoot
 * builds its client — same identity shape, same relaySocket, same factory seam
 * — so the wrong-key bug class has one spelling to be tested against.
 *
 * The pinned key wins where a machine has both. It is the stronger fact — a
 * user carried it across on a screen they physically control — and it outlives
 * a fleet key that rotates away, which is the same reason the daemon's rule 1
 * never looks at a certificate. The directory still gets the last word on the
 * machine's *name*, which is its own to state.
 *
 * A row nothing can reach is not built: a pairing record whose key is gone and
 * which the fleet does not name, or a fleet machine this device has no
 * certificate to present to. The fleet lists machines that can be reached, and
 * re-pairing is the picker's business, not a status row's.
 *
 * Not built is not the same as not mentioned, and it used to be. The second of
 * those — a machine the fleet names that this browser cannot present anything
 * to — is counted and reported through `onGaps`, along with whether this
 * browser pinned a fleet key at all and how many ceremonies it has performed,
 * because a reader cannot tell any of them apart from a short list. See
 * FleetGaps.
 */
export async function fleetSources(opts: {
  loopback: boolean
  relayOrigin: string | null
  wsFactory?: (url: string) => RawSocket
  /** How the directory is read. Production passes nothing; a test hands over
   *  an answer the way it hands over a socket factory. */
  directoryFetch?: DirectoryFetch
  /**
   * Told what this build could *not* reach, once, at the end. Every skip
   * below used to be silent, and each of them is a machine the reader thinks
   * they are on a fleet with; see FleetGaps. Not called at all on a tab with
   * no relay origin, which has no fleet to be missing from.
   */
  onGaps?: (gaps: FleetGaps) => void
}): Promise<FleetSource[]> {
  const sources: FleetSource[] = []
  if (opts.loopback) {
    sources.push({
      id: LOCAL_MACHINE_ID,
      name: '',
      client: new FlueClient(daemonSocketUrl()),
      // A session cookie on the daemon's own origin authenticates this one, and
      // no key of any kind. Whatever else that is worth, it is not the pinned
      // ceremony `adoptFleetKey` asks for — so a loopback tab still learns its
      // fleet key from a pairing link and nowhere else.
      pinned: false,
    })
  }
  const origin = opts.relayOrigin
  if (origin === null) return sources

  // One device key serves every machine — it is this browser's identity, not
  // a machine's — loaded at most once.
  let deviceKey: DeviceKey | null = null
  const device = async (): Promise<DeviceKey | null> => {
    if (deviceKey === null) {
      try {
        deviceKey = await loadOrCreateDeviceKey()
      } catch {
        // A key store that will not open is a tab with no identity to spend
        // on any handshake. Nothing here can be built; the picker's empty
        // state is the way back.
        return null
      }
    }
    return deviceKey
  }

  // Whether this browser holds the fleet key at all, asked before the
  // directory read because that read is the first thing the absence costs:
  // without the key there is no machine list this browser may believe.
  const fleetKey = await hasPinnedFleetKey()
  const view = await fleetView(origin, device, opts.directoryFetch)
  // This device's own certificate, from this browser's store rather than from
  // the relay: the machine that minted it handed it over at pairing and hands
  // it over again on every welcome (fleet.ts, adoptFleetCert), so the public
  // directory never has to carry one.
  //
  // Dropped when the directory says this key is revoked. That is the reader's
  // rule and it is enforced here rather than in storage: a revocation outranks
  // a certificate whatever either one's `iat` says, so a browser that went on
  // presenting a stored certificate after the fleet cut it off would be
  // deciding it knows better than the fleet — and would be refused by any
  // daemon that had heard, which is a channel that opens and closes.
  const deviceCert = view.revoked ? null : await storedDeviceCert()

  // Machines the fleet names that this browser can present nothing to. Counted
  // rather than skipped in silence: to the reader they are the machines they
  // set up and cannot see, and nothing on any screen would otherwise say the
  // list is short.
  let uncertified = 0
  // And how many machines this browser actually paired with, which is who it
  // could still be handed a fleet key by; see FleetGaps.pinned.
  let ceremonies = 0
  for (const machine of mergeMachines(listMachines(), view.machines)) {
    let pinned: Uint8Array | null = null
    try {
      pinned = await loadPinnedDaemonKeyFor(machine.id)
    } catch {
      // A key store that will not open answers as a missing pin does, and the
      // fleet's own key may still name this machine.
    }
    if (pinned !== null) ceremonies++
    const certified = view.machines.find((m) => m.id === machine.id) ?? null
    const daemonPub = pinned ?? certified?.noise ?? null
    if (daemonPub === null) continue
    // A machine this browser never paired with admits it on the device
    // certificate and on nothing else (channel.go, rule 2). Without one there
    // is no handshake to attempt, only a row that would sit at unreachable.
    if (pinned === null && deviceCert === null) {
      uncertified++
      continue
    }
    const key = await device()
    if (key === null) break
    const identity = {
      deviceKey: key,
      daemonPub,
      ...(deviceCert !== null && { deviceCert }),
    }
    sources.push({
      id: machine.id,
      name: machine.name,
      client: new FlueClient(origin, (o) => relaySocket(o, identity, machine.id, opts.wsFactory)),
      // Exactly the distinction two lines up: a key a ceremony pinned, or a key
      // a machine certificate named. Both dial, and only the first may hand
      // this browser a fleet key (adoptFleetKey).
      pinned: pinned !== null,
    })
  }
  opts.onGaps?.({ uncertified, fleetKey, pinned: ceremonies })
  return sources
}

/** Whether this browser pinned a fleet key at pairing. A key store that will
 *  not open answers as no key does: nothing this browser can verify with. */
async function hasPinnedFleetKey(): Promise<boolean> {
  try {
    return (await loadPinnedFleetKey()) !== null
  } catch {
    return false
  }
}

/**
 * What the fleet directory says, or nothing at all.
 *
 * Nothing is the answer for a browser with no pinned fleet key — one that
 * paired before the key existed, or with a daemon that holds none — and it is
 * a correct answer rather than an error: that browser reaches the machines it
 * paired with directly, exactly as it always did. Reading the directory
 * *without* the key would be worse than not reading it, because an unverifiable
 * machine list is a relay naming whatever machines it likes.
 *
 * It is no longer a *silent* answer, nor usually a lasting one. The caller
 * reports it (FleetGaps.fleetKey) and the sessions screen says so, because "the
 * fleet is a list this browser cannot read" is not something a reader can work
 * out from a list with one machine in it. And a browser that pinned a machine's
 * daemon key is handed a fleet key by that machine's next welcome, which
 * re-runs this with a key in hand — so the empty view is the answer for now,
 * not the shape of the tab.
 *
 * Everything else it can go wrong with is inside readDirectory, which never
 * rejects: a relay that has not been updated answers 503 on this route, an
 * unreachable one answers nothing, and both mean "no machines learned" rather
 * than "no fleet".
 */
async function fleetView(
  origin: string,
  device: () => Promise<DeviceKey | null>,
  fetch: DirectoryFetch | undefined,
): Promise<FleetView> {
  let fleetPub: Uint8Array | null
  try {
    fleetPub = await loadPinnedFleetKey()
  } catch {
    return EMPTY_FLEET
  }
  if (fleetPub === null) return EMPTY_FLEET
  const key = await device()
  if (key === null) return EMPTY_FLEET
  return readDirectory({
    origin,
    fleetPub,
    devicePub: key.publicKey,
    ...(fetch !== undefined && { fetch }),
  })
}

const EMPTY_FLEET: FleetView = {
  machines: [],
  revoked: false,
  entries: 0,
  verified: 0,
}

/** This device's stored fleet certificate, or null — including when the key
 *  store will not open, which is a browser with no identity to spend anyway. */
async function storedDeviceCert(): Promise<Uint8Array | null> {
  try {
    return await loadPinnedDeviceCert()
  } catch {
    return null
  }
}
