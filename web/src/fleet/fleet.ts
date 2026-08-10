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
  loadOrCreateDeviceKey,
  loadPinnedDaemonKeyFor,
  loadPinnedDeviceCert,
  loadPinnedFleetKey,
  savePinnedDeviceCert,
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

/** One machine the fleet should hold: its id, its label, its built client. */
export interface FleetSource {
  id: string
  name: string
  client: FlueClient
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
   * Whether a re-supplied certificate has already forced that second
   * expansion. Once per epoch: a browser gains machines the first time it
   * holds a certificate at all, and re-running on every later welcome would
   * be a directory read per reconnect for a set that cannot have changed.
   */
  private certExpanded = false
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
    this.certExpanded = false
    this.relayOrigin = null
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
    // Every welcome may carry this device's own fleet certificate, whichever
    // machine sent it: the daemon hands one to the device it has just
    // authenticated, so any machine this browser can still reach re-supplies
    // the blob it needs for the machines it cannot. Deliberately not gated on
    // which slot: the local daemon is as good a source as a remote one, and a
    // browser that has lost its certificate is usually a browser that can only
    // reach one machine.
    slot.unsubs.push(slot.client.onWelcome((w) => void this.adoptCert(w)))
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
   * A welcome's certificate, kept — and the machines it unlocks, taken now
   * rather than on the next page load.
   *
   * The order this repairs: a browser that boots holding no certificate builds
   * sources for the machines it pinned by hand and skips every machine it can
   * only reach on the fleet's word (`fleetSources` reads the stored
   * certificate once). The first welcome then hands it one. Without this, that
   * certificate sits in IndexedDB unused until something reloads the tab —
   * which is exactly the case the re-supply path exists for, since a browser
   * that lost its certificate is a browser that is missing machines.
   *
   * Only a certificate this browser did not already hold re-expands, so the
   * usual welcome — the same blob it has had all along — costs one IndexedDB
   * read and nothing else. `certExpanded` bounds it to one rebuild per epoch
   * even if several slots say hello at once.
   *
   * The rebuild is `adoptRemotes` unchanged, which is why this is safe to run
   * a second time: it is idempotent by id, skips the twin, and discards
   * everything if the fleet closed while it was reading the directory.
   */
  private async adoptCert(w: Welcome) {
    if (!(await adoptFleetCert(w))) return
    if (this.certExpanded || !this.running) return
    const origin = this.relayOrigin
    if (origin === null) return
    this.certExpanded = true
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
 * A row nothing can reach is skipped in silence rather than surfaced: a
 * pairing record whose key is gone and which the fleet does not name, or a
 * fleet machine this device has no certificate to present to. The fleet lists
 * machines that can be reached, and re-pairing is the picker's business, not a
 * status row's.
 */
export async function fleetSources(opts: {
  loopback: boolean
  relayOrigin: string | null
  wsFactory?: (url: string) => RawSocket
  /** How the directory is read. Production passes nothing; a test hands over
   *  an answer the way it hands over a socket factory. */
  directoryFetch?: DirectoryFetch
}): Promise<FleetSource[]> {
  const sources: FleetSource[] = []
  if (opts.loopback) {
    sources.push({ id: LOCAL_MACHINE_ID, name: '', client: new FlueClient(daemonSocketUrl()) })
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

  for (const machine of mergeMachines(listMachines(), view.machines)) {
    let pinned: Uint8Array | null = null
    try {
      pinned = await loadPinnedDaemonKeyFor(machine.id)
    } catch {
      // A key store that will not open answers as a missing pin does, and the
      // fleet's own key may still name this machine.
    }
    const certified = view.machines.find((m) => m.id === machine.id) ?? null
    const daemonPub = pinned ?? certified?.noise ?? null
    if (daemonPub === null) continue
    // A machine this browser never paired with admits it on the device
    // certificate and on nothing else (channel.go, rule 2). Without one there
    // is no handshake to attempt, only a row that would sit at unreachable.
    if (pinned === null && deviceCert === null) continue
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
    })
  }
  return sources
}

/**
 * What the fleet directory says, or nothing at all.
 *
 * Nothing is the answer for a browser with no pinned fleet key — one that
 * paired before the key existed, or with a daemon that holds none — and it is
 * an ordinary answer: that browser reaches the machines it paired with
 * directly, exactly as it always did. Reading the directory *without* the key
 * would be worse than not reading it, because an unverifiable machine list is
 * a relay naming whatever machines it likes.
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
