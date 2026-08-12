import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { ChevronDownIcon } from '@heroicons/react/16/solid'

import type { FlueClient } from '@/client/client'
import { BulkBar } from '@/components/bulk-bar'
import { DisplayOptions } from '@/components/display-options'
import { NewSessionDialog } from '@/components/new-session-dialog'
import { PageHeader } from '@/components/page-header'
import { RenameDialog } from '@/components/rename-dialog'
import { SessionSearch } from '@/components/session-search'
import { SessionTable, type RowAction } from '@/components/session-table'
import { TagEditor } from '@/components/tag-editor'
import { ViewTabs } from '@/components/view-tabs'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useSidebar } from '@/components/ui/sidebar'
import { Skeleton } from '@/components/ui/skeleton'
import type { FleetGaps } from '@/fleet/fleet'
import { useFleet } from '@/fleet/provider'
import { keyOf, LOCAL_MACHINE_ID, type FleetSession, type MachineState } from '@/fleet/types'
import { useRefetchOnFocus } from '@/hooks/use-refetch-on-focus'
import { takeCwd } from '@/lib/url'
import { cn } from '@/lib/utils'
import { useOpenNewSession, type NewSessionOrigin } from '@/sessions/open-new-session'
import {
  applyView,
  DEFAULT_VIEW,
  displayName,
  spawnFromGroup,
  type Group,
  type ViewConfig,
} from '@/sessions/view'
import {
  deleteView,
  listViews,
  loadCurrent,
  saveCurrent,
  saveView,
  type SavedView,
} from '@/sessions/views-store'

/**
 * The terminal's path, written out rather than imported from src/router.tsx.
 *
 * Importing TERMINAL_ROUTE_ID from there would close a cycle, since the router
 * imports this component. The literal is not unchecked: `to` is typed against
 * the registered route tree, so a path that drifts is a compile error.
 *
 * The deviceId segment carries the fleet's machineId — `local` for the machine
 * this tab rides, exactly as the fleet stamps every row. Never a relay slot id
 * resolved by hand: the fleet already folded the daemon's own slot into
 * `local`, and re-deriving it here would undo that.
 */
const TERMINAL_PATH = '/d/$deviceId/s/$sessionId' as const

/**
 * The error a spawn is answered with when it is not answered with a session.
 *
 * A spawn is settled by exactly one of three things: the `attached` or the
 * `error` echoing its reqId, or the connection going away.
 *
 * `internal/daemon/conn.go`, `case wire.Spawn`: the error path returns before
 * `attachTo`, so a failed spawn produces this and nothing else, ever.
 */
const SPAWN_FAILED = 'spawn_failed'

/** A fresh copy of the default arrangement — DEFAULT_VIEW is frozen, and a
 *  bare spread would share its frozen columns array with the first edit. */
function defaultView(): ViewConfig {
  return { ...DEFAULT_VIEW, columns: [...DEFAULT_VIEW.columns] }
}

/** A caller's own copy of a saved arrangement, columns array included. */
function configOf(v: SavedView): ViewConfig {
  return {
    grouping: v.grouping,
    ordering: v.ordering,
    search: v.search,
    columns: [...v.columns],
    showExited: v.showExited,
  }
}

/**
 * Whether two arrangements say the same thing, field by field.
 *
 * By value and never by identity, because the controls upstream re-report a
 * whole ViewConfig on every touch — a Select re-picking the word it already
 * held, a search echoing its own string back — and identity would light the
 * dirty flag on edits that changed nothing.
 */
function sameArrangement(a: ViewConfig, b: ViewConfig): boolean {
  return (
    a.grouping === b.grouping &&
    a.ordering === b.ordering &&
    a.search === b.search &&
    a.showExited === b.showExited &&
    a.columns.length === b.columns.length &&
    a.columns.every((c, at) => c === b.columns[at])
  )
}

/** What to say about the ridden machine when it is not carrying anything. */
function localNotice(machines: MachineState[] | null): string | null {
  if (machines === null) return 'Connecting to the flue daemon…'
  const local = machines.find((m) => m.id === LOCAL_MACHINE_ID)
  if (local === undefined) return null
  if (local.status === 'connecting') return 'Connecting to the flue daemon…'
  if (local.status === 'unreachable') return 'Lost the flue daemon. Reconnecting…'
  // Not the reconnect line, which would be a promise nothing is keeping: the
  // fleet stopped the redialling the moment the daemon said why. The band
  // below carries the reason and the way back; this line is what the live
  // region announces.
  if (local.status === 'revoked') return "This device's access was revoked."
  return null
}

/** One spawn this screen has asked for and not yet seen answered. */
interface PendingSpawn {
  reqId: number
  client: FlueClient
  offs: Array<() => void>
}

/**
 * The all-machines sessions screen: every reachable daemon's rows, merged,
 * arranged, and acted on.
 *
 * The route owns all of the state — the arrangement, the saved views, the
 * selection, which dialog is open over which session — and the components
 * around it own none: they report clicks and render what they are told, which
 * is what keeps each of them testable without a fleet behind it.
 *
 * Creation lives here rather than in `<Terminal>` because `spawn` carries no
 * key the daemon could deduplicate on: a view that fired one on every mount
 * would start two shells under StrictMode and could only ever detach one.
 * Every session but one is started by a click; the terminal is reached by
 * navigating to a session that already exists.
 *
 * The one exception is the directory `flue open` hands over in `?cwd=`, sent
 * from this screen's own mount effect by `spawnPendingCwd` — and it survives
 * the double mount on two separate guards. The URL param behind `pendingCwd`
 * is consumed on the very first render, so whichever of the two mounts
 * StrictMode runs second finds the ref already holding the answer; and the
 * ref is emptied the instant a spawn reaches the daemon, on whichever mount
 * that turns out to be. The mount that does not get to send one either finds
 * the ref already emptied, or — cold, with the socket still connecting — has
 * had its status listener removed by cleanup before the socket ever opens.
 */
export function SessionsRoute() {
  const fleet = useFleet()
  const navigate = useNavigate()
  const openNewSession = useOpenNewSession()

  /**
   * The fleet's last word: null until it has said anything at all, which is
   * not the same as an empty fleet — every cold load passes through this on
   * its way to a screen full of rows, and it renders as placeholders rather
   * than as a claim that nothing is running anywhere.
   */
  const [fleetState, setFleetState] = useState<{
    sessions: FleetSession[]
    machines: MachineState[]
  } | null>(null)

  /**
   * What the fleet could not build for this browser: machines it has no
   * certificate for, and whether it pinned a fleet key at all. Null until an
   * expansion has run, which is every tab before its welcome names a relay —
   * and null again the moment its machine says it is on none, because there is
   * then no fleet for any of it to be a fact about (FleetClient.gaps).
   *
   * Read off the fleet on each delivery rather than carried in the payload,
   * because it changes once per expansion and the payload is delivered several
   * times a second; the fleet emits when it changes, which is what makes this
   * read enough (FleetClient.noteGaps).
   */
  const [gaps, setGaps] = useState<FleetGaps | null>(null)

  /**
   * Whether an online machine has answered its first list. The fleet reports
   * "a machine came up" and "here are its rows" as two deliveries and nothing
   * in the payload tells them apart, so this reads the one difference there
   * is: a delivery that changed no machine — same ids, same statuses, same
   * names — can only have been sent for its rows. Until one arrives, an
   * empty merge renders as placeholders rather than as "No sessions yet";
   * that sentence is a claim about the fleet, and making it before anyone
   * has answered invents it.
   */
  const [settled, setSettled] = useState(false)
  const lastMachines = useRef<MachineState[] | null>(null)

  /**
   * The arrangement and the pressed tab open where the last visit left them —
   * change the grouping, reload, and it used to snap back to machine. Read
   * once, lazily, and validated by the store: a corrupt record, a storage the
   * browser will not open, or a tab whose view was deleted elsewhere all land
   * on the default arrangement under All.
   */
  const [restored] = useState(loadCurrent)
  const [view, setView] = useState<ViewConfig>(restored.view)
  const [views, setViews] = useState<SavedView[]>(() => listViews())
  const [active, setActive] = useState<string | null>(restored.active)

  // Written down on every change, tab included, so a reload opens on what the
  // reader was looking at. Persistence is orthogonal to the dirty flag below,
  // which stays a value-compare against the active saved view.
  useEffect(() => {
    saveCurrent(view, active)
  }, [view, active])

  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set())
  const [folded, setFolded] = useState<ReadonlySet<string>>(() => new Set())

  const [renaming, setRenaming] = useState<FleetSession | null>(null)
  const [tagging, setTagging] = useState<FleetSession | null>(null)
  const [bulkTagging, setBulkTagging] = useState(false)

  const [notice, setNotice] = useState<string | null>(null)

  /**
   * What the new-session dialog is open on, or null for closed. The value is
   * whatever the press implied — a machine, a directory, a tag — and it is the
   * dialog's starting point rather than its answer.
   */
  const [creating, setCreating] = useState<NewSessionOrigin | null>(null)

  /**
   * The spawns this screen asked for and has not yet seen answered. A ref,
   * because their listeners settle them without re-rendering anything: this
   * screen no longer spawns from a button, so the only entry that ever lands
   * here is the one `flue open` hands over in `?cwd=`, and nothing on screen
   * is waiting on it.
   */
  const pending = useRef(new Set<PendingSpawn>())

  /**
   * The directory flue open asked for, taken from the URL exactly once —
   * `undefined` before the first render has looked. Held until the socket can
   * carry the spawn: a cold load from flue open mounts this screen while the
   * ridden machine's client is still connecting.
   */
  const pendingCwd = useRef<string | null | undefined>(undefined)
  if (pendingCwd.current === undefined) pendingCwd.current = takeCwd()

  /**
   * Adopt one in-flight spawn: navigate on its `attached`, report its error,
   * and write it off when its connection goes. The listeners are registered
   * per spawn, on the client that carries it, because the fleet grows machines
   * over time and a single mount-time subscription could not name them all.
   *
   * The one caller left is `flue open`'s handover below. Every spawn a *press*
   * asks for is made by the new-session page instead, in the tab it opens —
   * see sessions/new-session.ts for why that has to be a page and not a reply
   * this screen waits on.
   */
  const adopt = useCallback(
    (client: FlueClient, machineId: string, reqId: number) => {
      const entry: PendingSpawn = { reqId, client, offs: [] }
      const settle = () => {
        if (!pending.current.delete(entry)) return
        for (const off of entry.offs) off()
      }
      entry.offs.push(
        client.onAttached((a) => {
          if (a.reqId !== reqId) return
          settle()
          // Hand the ref straight back: this screen renders no terminal, and
          // the route it navigates to attaches on its own.
          client.detach(a.ref)
          void navigate({
            to: TERMINAL_PATH,
            params: { deviceId: machineId, sessionId: a.id },
          })
        }),
        client.onError((e) => {
          if (e.reqId !== reqId) return
          settle()
          if (e.code === SPAWN_FAILED) setNotice(`Could not start a session: ${e.msg}`)
        }),
        client.onStatus((s) => {
          // Replies do not survive their socket: an answer the outage carried
          // away is never coming, and the client cleared its own bookkeeping
          // the same way.
          if (s !== 'open') settle()
        }),
      )
      pending.current.add(entry)
    },
    [navigate],
  )

  const spawnPendingCwd = useCallback(() => {
    const cwd = pendingCwd.current
    if (typeof cwd !== 'string') return
    const client = fleet.clientFor(LOCAL_MACHINE_ID)
    if (client === null) return
    const reqId = client.spawn({ cwd, cols: 80, rows: 24 })
    if (reqId === null) return // still down; the next open retries
    pendingCwd.current = null
    adopt(client, LOCAL_MACHINE_ID, reqId)
  }, [adopt, fleet])

  useEffect(() => {
    const local = fleet.clientFor(LOCAL_MACHINE_ID)
    const offs = [
      fleet.onFleet((sessions, machines) => {
        setFleetState({ sessions, machines })
        setGaps(fleet.gaps())
        const prev = lastMachines.current
        if (
          prev !== null &&
          prev.length === machines.length &&
          prev.every((m, at) => {
            const now = machines[at]!
            return m.id === now.id && m.status === now.status && m.name === now.name
          })
        ) {
          setSettled(true)
        }
        lastMachines.current = machines
        // Prune the selection to the rows that still exist: a session that
        // exited and was reaped must not linger in the count, or a later bulk
        // act would aim at it.
        setSelected((prev) => {
          if (prev.size === 0) return prev
          const live = new Set(sessions.map(keyOf))
          const next = new Set([...prev].filter((k) => live.has(k)))
          return next.size === prev.size ? prev : next
        })
      }),
      /*
       * The refusals nobody is waiting on.
       *
       * An `update` and a `close` by id are answered by nothing when they
       * work — the next list carries the truth — so the daemon's only reply
       * to either is a bare `error{not_found}` with no reqId to hand it back
       * by. Every correlated error already belongs to someone: a spawn's to
       * the per-spawn listeners in `adopt`, an attach's to the client, which
       * resolves it into `onSessionGone`. What is left would otherwise fall
       * on the floor, and the act it refused is one the reader just performed
       * on a row that stays exactly where it was.
       *
       * Which machine it came from is not said. The screen is a fleet, but
       * the sentence is about one session the reader named a moment ago, and
       * naming a machine they never chose would explain less than it asks.
       * Codes other than not_found are left alone: `bad_payload` is the
       * client talking to itself about a frame it could not read, and
       * `lagged` is a connection fact the status line already carries.
       */
      fleet.onError((_machineId, e) => {
        if (e.reqId !== undefined) return
        if (e.code === 'not_found') setNotice('That session is gone.')
      }),
      ...(local === null
        ? []
        : [
            local.onStatus((s) => {
              setNotice(null)
              if (s === 'open') spawnPendingCwd()
            }),
          ]),
    ]

    fleet.list()
    spawnPendingCwd()

    return () => {
      for (const off of offs) off()
      // Whatever this screen asked for and did not live to see answered: the
      // client hands each reply back when it lands.
      for (const entry of pending.current) {
        entry.client.abandon(entry.reqId)
        for (const off of entry.offs) off()
      }
      pending.current.clear()
    }
  }, [fleet, spawnPendingCwd])

  // Browsers throttle background tabs to a crawl; asking again the moment the
  // tab is looked at beats waiting out a stretched poll tick.
  useRefetchOnFocus(useCallback(() => fleet.list(), [fleet]))

  const sessions = fleetState?.sessions ?? []
  const machines = fleetState?.machines ?? null

  const groups = useMemo(() => applyView(sessions, view), [sessions, view])
  const byKey = useMemo(() => new Map(sessions.map((s) => [keyOf(s), s])), [sessions])
  const knownTags = useMemo(
    () => [...new Set(sessions.flatMap((s) => s.tags))].sort(),
    [sessions],
  )

  /** The selected keys resolved to their rows, once, for every bulk act. */
  const chosen = useMemo(
    () =>
      [...selected]
        .map((k) => byKey.get(k))
        .filter((s): s is FleetSession => s !== undefined),
    [selected, byKey],
  )

  /** The tags every selected session carries — what the bulk editor opens on. */
  const sharedTags = useMemo(() => {
    const first = chosen[0]
    if (first === undefined) return []
    return first.tags.filter((t) => chosen.every((s) => s.tags.includes(t)))
  }, [chosen])

  const online = machines?.filter((m) => m.status === 'online') ?? []
  const connecting = machines?.filter((m) => m.status === 'connecting') ?? []
  const unreachable = machines?.filter((m) => m.status === 'unreachable') ?? []
  const revoked = machines?.filter((m) => m.status === 'revoked') ?? []

  /**
   * Where the primary button spawns: the machine this tab rides when it is
   * up, else the first machine that is. The chevron beside it names the rest.
   */
  const primaryTarget = online.some((m) => m.id === LOCAL_MACHINE_ID)
    ? LOCAL_MACHINE_ID
    : online[0]?.id

  /**
   * The `+` on a group's heading: make one of *these*.
   *
   * What "these" means is `spawnFromGroup`'s to decide and it is a pure
   * function of the grouping and the key, so the rule is arguable in a unit
   * test rather than by clicking headings. Only the machine is resolved here,
   * because only this screen knows which machine a heading that names none
   * should fall back to — the same `primaryTarget` the toolbar's own button
   * opens on.
   *
   * What the heading implies is a prefill and not a decision: the dialog opens
   * on it and the reader may edit any of it, which is how a `+` under "api"
   * can still start something tagged `api` and `staging`.
   */
  const spawnInGroup = (group: Group) => {
    const want = spawnFromGroup(view.grouping, group.key)
    if (want === null) return
    setCreating({
      machineId: want.machineId ?? primaryTarget,
      cwd: want.cwd,
      tags: want.tag === undefined ? [] : [want.tag],
    })
  }

  /**
   * What that control is called, in the words of the thing it inherits.
   *
   * Undefined is how a heading says it has no `+` at all, and it is read
   * straight off the same rule the click uses, so the control cannot be
   * offered for a group the click would refuse.
   */
  const spawnLabel = (group: Group): string | undefined => {
    const want = spawnFromGroup(view.grouping, group.key)
    if (want === null) return undefined
    if (want.tag !== undefined) return `New session tagged ${want.tag}`
    if (want.cwd !== undefined) return `New session in ${want.cwd}`
    if (want.machineId !== undefined) return `New session on ${group.label}`
    return 'New session'
  }

  /**
   * How a row asks what it is doing, for the hover preview.
   *
   * Routed through the fleet by the row's own machine, so a preview of a
   * session on a second laptop asks that laptop rather than this one. A
   * machine the fleet no longer holds rejects, which the card renders as "no
   * preview right now" — the honest answer, and the same one it gives for a
   * daemon mid-reconnect.
   */
  const peek = useCallback(
    (s: FleetSession, bytes: number) => fleet.peekOn(s.machineId, s.id, bytes),
    [fleet],
  )

  /**
   * The columns the rows actually carry, which is the reader's choice minus
   * the one that can have nothing to say.
   *
   * A machine chip on every row of a browser that reaches one machine is the
   * same word repeated down the screen. It costs nothing on a desktop and it
   * costs the *name* on a phone: at 390px the chip and the stamp take half the
   * row, and a session called after a long path truncates to "karn@karn:…"
   * with the useful half gone. So a fleet of one drops it.
   *
   * Keyed on how many machines this browser holds rather than on how many
   * appear in the current rows, and deliberately: the row set changes with
   * every search and every filter, and a column that came and went as the
   * reader typed would be worse than one that is merely redundant. The
   * preference itself is untouched — pair a second machine and the chip is
   * back, still ticked in the display options where it never stopped being.
   */
  const columns = useMemo(
    () =>
      (machines?.length ?? 0) > 1 ? view.columns : view.columns.filter((c) => c !== 'machine'),
    [machines, view.columns],
  )

  const dirty = !sameArrangement(
    view,
    active === null ? DEFAULT_VIEW : (views.find((v) => v.name === active) ?? DEFAULT_VIEW),
  )

  const selectView = (name: string | null) => {
    setActive(name)
    if (name === null) {
      // "All" is the absence of a saved view: the built-in arrangement.
      setView(defaultView())
      return
    }
    const found = views.find((v) => v.name === name)
    if (found !== undefined) setView(configOf(found))
  }

  const saveViewAs = (name: string) => {
    try {
      saveView({ name, ...view, columns: [...view.columns] })
    } catch (err) {
      // The store throws on a blank name and on a write the browser refused;
      // either way the tab the reader expects is not there after a reload, so
      // the refusal has to be said rather than swallowed.
      setNotice(`Could not save the view: ${err instanceof Error ? err.message : String(err)}`)
      return
    }
    setViews(listViews())
    setActive(name)
  }

  const removeView = (name: string) => {
    deleteView(name)
    setViews(listViews())
    // The arrangement on screen stays: deleting a view takes nothing off the
    // list, it only forgets the name — so only the pressed tab moves to All.
    if (name === active) setActive(null)
  }

  /**
   * The row's ⋯ menu. Close asks nothing first, matching the exit overlay's
   * own Close: one session the reader just named is not the bulk sweep the
   * bar's confirm exists for, and the row visibly leaves within a poll.
   *
   * Every act here can only aim at a reachable machine, because rows from an
   * unreachable one were dropped the moment it fell — there is nothing left
   * on screen to act on. The one dishonest window is a machine that drops
   * between render and click: the client swallows the frame, the next poll
   * takes the rows away, and the reader retries against the truth. Three
   * seconds of ghost, accepted over a queue that would replay a close later.
   */
  const onAction = (action: RowAction, s: FleetSession) => {
    switch (action) {
      case 'rename':
        setRenaming(s)
        break
      case 'tags':
        setTagging(s)
        break
      case 'pin':
        fleet.update(s.machineId, { id: s.id, pinned: true })
        break
      case 'unpin':
        fleet.update(s.machineId, { id: s.id, pinned: false })
        break
      case 'close':
        fleet.closeOn(s.machineId, s.id)
        setNotice(`Closing ${displayName(s)}.`)
        break
    }
  }

  const toggleSelect = (key: string) =>
    setSelected((prev) => {
      const next = new Set(prev)
      if (!next.delete(key)) next.add(key)
      return next
    })

  const toggleGroup = (groupKey: string) =>
    setFolded((prev) => {
      const next = new Set(prev)
      if (!next.delete(groupKey)) next.add(groupKey)
      return next
    })

  const clearSelection = () => setSelected(new Set())

  const bulkPin = () => {
    for (const s of chosen) fleet.update(s.machineId, { id: s.id, pinned: true })
    clearSelection()
  }

  const bulkClose = () => {
    for (const s of chosen) fleet.closeOn(s.machineId, s.id)
    setNotice(`Closing ${chosen.length} ${chosen.length === 1 ? 'session' : 'sessions'}.`)
    clearSelection()
  }

  /**
   * The bulk tag editor opens on the intersection of the selection's tags and
   * writes the edited list back to every selected session whole. Replacement,
   * not merge, and deliberately: the editor shows a set and the reader edits
   * that set, so a tag one session carried that the editor never showed is
   * gone after a save. Merging instead would make removal impossible — the
   * one edit a shared editor is opened for.
   */
  const bulkTag = (tags: string[]) => {
    for (const s of chosen) fleet.update(s.machineId, { id: s.id, tags })
    clearSelection()
  }

  const retry = (machineId: string) => fleet.clientFor(machineId)?.connect()

  const message = notice ?? localNotice(machines)

  /**
   * Whether the sessions list itself renders. With rows, always. Empty, only
   * once the emptiness is a fact rather than a race: an answered fleet, no
   * machine still dialling, and at least one machine actually online — "No
   * sessions yet" from a screen whose machines are all down would be a lie
   * the placeholders and the unreachable bands are there to avoid telling.
   */
  const showTable =
    fleetState !== null &&
    (groups.length > 0 || (settled && connecting.length === 0 && online.length > 0))

  /** Placeholder rows, for machines that have not had the chance to answer. */
  const showSkeleton =
    fleetState === null ||
    connecting.length > 0 ||
    (online.length > 0 && !settled && groups.length === 0)

  return (
    <div
      className={cn(
        'flex flex-col gap-y-6 p-4 sm:p-6 lg:p-8',
        // Room for the bulk bar while it is up, so it can never sit over the
        // last row's controls for good — the list scrolls out from under it.
        selected.size > 0 && 'pb-24',
      )}
    >
      <PageHeader
        crumbs={[{ label: 'Sessions' }]}
        actions={
          <>
            <SessionSearch
              value={view.search}
              onChange={(search) => setView((v) => ({ ...v, search }))}
            />
            <DisplayOptions view={view} onChange={setView} />
            {/*
              The one filled control on this screen, and a split one: the
              primary half opens on the machine a new session most likely
              belongs to — the one this tab rides, else the first one up — and
              the chevron half names the rest of the fleet. It takes its teal
              from --primary rather than naming a colour.

              Neither half starts anything by itself any more. Both open the
              dialog, which is where a name and a tag can be chosen while
              there is still a form to choose them on; the session itself is
              started by the page that dialog opens.
            */}
            {/*
              The default size, not `sm`, and that is a fact about the row
              rather than a preference: the search field is an Input (h-8) and
              the display-options trigger is an icon button (size-8), so a
              28px control between them sat four pixels short at the top and
              the bottom of a line whose other two members agreed. A toolbar
              is read as one object, and one member of it being a different
              height reads as a rendering fault rather than as emphasis.
            */}
            <div className="flex items-center">
              <Button
                onClick={() => setCreating({ machineId: primaryTarget })}
                className="rounded-r-none"
              >
                New session
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    aria-label="Choose a machine for the new session"
                    className="-ml-px rounded-l-none px-1"
                  >
                    <ChevronDownIcon aria-hidden="true" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-auto">
                  {online.length === 0 ? (
                    <DropdownMenuItem disabled>No machine is reachable</DropdownMenuItem>
                  ) : (
                    online.map((m) => (
                      <DropdownMenuItem key={m.id} onSelect={() => setCreating({ machineId: m.id })}>
                        {m.name || m.id}
                      </DropdownMenuItem>
                    ))
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </>
        }
      >
        <ViewTabs
          views={views}
          active={active}
          dirty={dirty}
          onSelect={selectView}
          onSaveCurrent={saveViewAs}
          onDelete={removeView}
        />
        {/*
          Always rendered, never mounted with its text. Several screen readers
          announce only changes to a live region that was already in the
          accessibility tree, so a region that appears alongside its first
          message is a message nobody hears — which is also why this is not
          display-none when empty. Empty it contributes no line box, and
          `empty:mt-0` takes the margin with it.
        */}
        <p
          role="status"
          className="mt-3 max-w-[65ch] text-base/7 text-pretty text-zinc-600 empty:mt-0 sm:text-sm/6 dark:text-zinc-400"
        >
          {message}
        </p>
      </PageHeader>

      {/*
        Above the per-machine bands, and unlike them not tied to any row: this
        is about the machines that are *not* on the screen. It renders under
        every grouping for the same reason — there is no group it could sit in.
      */}
      {gaps !== null && <FleetGapBand gaps={gaps} />}

      {view.grouping !== 'machine' && unreachable.length > 0 && (
        <UnreachableBand machines={unreachable} onRetry={retry} />
      )}

      {view.grouping !== 'machine' && revoked.length > 0 && <RevokedBand machines={revoked} />}

      {showTable && (
        <SessionTable
          groups={groups}
          columns={columns}
          selected={selected}
          onToggleSelect={toggleSelect}
          onToggleGroup={toggleGroup}
          collapsed={folded}
          onAction={onAction}
          onSpawnIn={spawnInGroup}
          spawnLabel={spawnLabel}
          peek={peek}
        />
      )}

      {showSkeleton && <LoadingRows />}

      {view.grouping === 'machine' &&
        unreachable.map((m) => <UnreachableBand key={m.id} machines={[m]} onRetry={retry} />)}

      {view.grouping === 'machine' &&
        revoked.map((m) => <RevokedBand key={m.id} machines={[m]} />)}

      {/*
        One dialog for every way of asking, and it takes the whole fleet's
        online machines rather than the one a press implied: the press is a
        prefill, and a reader who opened it under the wrong heading should not
        have to close it to fix that.
      */}
      <NewSessionDialog
        open={creating !== null}
        initial={creating ?? {}}
        machines={online.map((m) => ({ id: m.id, name: m.name }))}
        known={knownTags}
        onSubmit={openNewSession}
        onClose={() => setCreating(null)}
      />

      <RenameDialog
        open={renaming !== null}
        initial={renaming?.name ?? ''}
        onSubmit={(name) => {
          if (renaming === null) return
          // The patch travels as a literal, so an emptied name survives to
          // the wire as the clear it is.
          fleet.update(renaming.machineId, { id: renaming.id, name })
        }}
        onClose={() => setRenaming(null)}
      />

      <TagEditor
        open={tagging !== null}
        current={tagging?.tags ?? []}
        known={knownTags}
        onSubmit={(tags) => {
          if (tagging === null) return
          fleet.update(tagging.machineId, { id: tagging.id, tags })
        }}
        onClose={() => setTagging(null)}
      />

      <TagEditor
        open={bulkTagging}
        current={sharedTags}
        known={knownTags}
        onSubmit={bulkTag}
        onClose={() => setBulkTagging(false)}
      />

      <PlacedBulkBar
        count={selected.size}
        anyRunning={chosen.some((s) => s.state !== 'exited')}
        onTag={() => setBulkTagging(true)}
        onPin={bulkPin}
        onClose={bulkClose}
        onClear={clearSelection}
      />
    </div>
  )
}

/**
 * The bulk bar, offset past the sidebar while there is a sidebar to be past.
 *
 * The bar is pinned to the viewport and centred between its own edges, and
 * the viewport knows nothing about the sidebar taking `--sidebar-width` off
 * the left of the content from md up — centred on the window, the bar reads
 * left of the list it acts on. The offset is read from useSidebar rather
 * than from a peer selector because this renders inside SidebarInset, where
 * the sibling relationship a peer class needs does not exist. And only while
 * expanded: past a folded-away sidebar there is nothing to be offset by.
 */
function PlacedBulkBar(props: {
  count: number
  anyRunning: boolean
  onTag(): void
  onPin(): void
  onClose(): void
  onClear(): void
}) {
  const { state } = useSidebar()
  return (
    <BulkBar
      {...props}
      className={state === 'expanded' ? 'md:left-(--sidebar-width)' : undefined}
    />
  )
}

/**
 * The fleet this browser is not in, in the same muted band the unreachable
 * machines get — because to the reader it is the same kind of fact, and one
 * they otherwise have no way of learning at all.
 *
 * Three sentences, at most one of which is ever true at a time, and none with a
 * button: nothing on this screen can fix any of them. A browser with no
 * certificate for a machine cannot be given one from here — it comes from a
 * daemon, over a connection that machine will not accept without it.
 *
 * The missing-fleet-key case used to read "pair again from any machine on the
 * fleet and they all appear", which was true and is not any more: a browser
 * that paired with a machine by hand is handed the fleet key by that machine's
 * next welcome, and the list fills in without anybody scanning anything
 * (fleet/fleet.ts, adoptFleetKey). So what is left to say is why *this* browser
 * has not been handed one, and there are exactly two answers. Above zero
 * ceremonies there is a machine that can hand it over and has not yet — it is
 * out of reach, or it holds no fleet key of its own — and the sentence says so
 * without pretending to know which; while it is still on its way, that same
 * sentence is the honest description of a repair in progress.
 *
 * At zero ceremonies the tab is riding a machine it never paired with, which in
 * practice is the loopback tab: a relay tab boots from a pinned key and cannot
 * get here. That case used to be told to go and pair at the relay's address,
 * and it is now the one case with a local answer — the machine's own daemon
 * enrols its browser on every load (fleet/enrol.ts), so a browser still without
 * a key is one whose machine has none to give. The sentence names that, because
 * it is the only thing anybody can act on: join the relay from this machine.
 *
 * Silent when there is nothing to say, which is now the ordinary case
 * everywhere — including on loopback, where enrolment is what closes the last
 * two gaps. A band reading "everything is fine" is a band nobody reads.
 *
 * And silent before any of that on a machine with no relay, which is what a
 * fresh install is and the first screen anybody ever opens. Every sentence
 * below is addressed to a reader who is on a fleet: there are no others to be
 * missing from a list, and nothing anywhere to pair against, so all three would
 * be false at once. The fleet is what makes that hold rather than a fourth
 * branch here — it hands over no gaps at all while this tab knows no relay
 * (fleet/fleet.ts, FleetClient.gaps) — and the invitation to set up remote
 * access is the Remote screen's to make, on the screen that can carry it out.
 */
function FleetGapBand({ gaps }: { gaps: FleetGaps }) {
  if (!gaps.fleetKey && gaps.pinned === 0) {
    return (
      <div className="flex flex-col gap-y-1 rounded-md bg-row-hover px-3 py-2">
        <p className="text-base/6 text-zinc-500 sm:text-sm/6 dark:text-zinc-400">
          This tab is talking to{' '}
          <span className="font-medium text-zinc-950 dark:text-white">one machine</span> and holds
          no key for the fleet, so it cannot see the rest of it. A machine hands its own browser
          one as soon as it has joined a relay — check <code className="font-mono">flue status</code>{' '}
          on this machine, then reload.
        </p>
      </div>
    )
  }
  if (!gaps.fleetKey) {
    return (
      <div className="flex flex-col gap-y-1 rounded-md bg-row-hover px-3 py-2">
        <p className="text-base/6 text-zinc-500 sm:text-sm/6 dark:text-zinc-400">
          This browser holds{' '}
          <span className="font-medium text-zinc-950 dark:text-white">no key for the fleet</span>{' '}
          yet, so it lists only what it paired with. It takes one from a machine it paired with as
          soon as that machine answers — if this stays, that machine is out of reach or has no
          fleet key itself.
        </p>
      </div>
    )
  }
  if (gaps.uncertified === 0) return null
  /*
    The way back used to be one sentence — pair again from any machine on the
    fleet — and it is the wrong instruction for half the readers now. A tab on a
    machine's own address cannot act on it at all: a pairing link points at the
    relay, which is another origin and another storage partition, so the
    ceremony would admit a browser that is not this one. What that tab has
    instead is enrolment on every load, and reaching this band despite it means
    the certificate this machine signed has been taken away — a revocation,
    which is permanent for the key it names. Hence the clearing: a fresh key is
    what gets enrolled next time. Both doors are named because the band cannot
    see which side of it the reader is on.
  */
  return (
    <div className="flex flex-col gap-y-1 rounded-md bg-row-hover px-3 py-2">
      <p className="text-base/6 text-zinc-500 sm:text-sm/6 dark:text-zinc-400">
        <span className="font-medium text-zinc-950 dark:text-white">
          {gaps.uncertified === 1 ? '1 machine' : `${gaps.uncertified} machines`}
        </span>{' '}
        in this fleet {gaps.uncertified === 1 ? 'has' : 'have'} no certificate this browser can
        present, so {gaps.uncertified === 1 ? 'it is' : 'they are'} not listed here. On this
        machine’s own address, clearing this site’s storage and reloading gets a fresh one. From
        anywhere else, pair this browser again from a machine on the fleet.
      </p>
    </div>
  )
}

/**
 * A machine the fleet cannot reach right now, said in a muted band where its
 * rows would have been. Retry redials that one machine's client, and does it
 * at once: a client waiting out its backoff stands the timer down and opens
 * the socket on the press rather than making the reader sit out the rest of a
 * wait that runs to ten seconds. Only the wait is skipped — the escalation
 * behind it is kept, so a machine that stays down is not hammered.
 */
function UnreachableBand({
  machines,
  onRetry,
}: {
  machines: MachineState[]
  onRetry(machineId: string): void
}) {
  return (
    <div className="flex flex-col gap-y-1 rounded-md bg-row-hover px-3 py-2">
      {machines.map((m) => {
        const name = m.name || m.id
        return (
          <p
            key={m.id}
            className="flex items-center gap-x-1.5 text-base/6 text-zinc-500 sm:text-sm/6 dark:text-zinc-400"
          >
            <span className="font-medium text-zinc-950 dark:text-white">{name}</span>
            is unreachable
            <span aria-hidden="true">·</span>
            <Button
              variant="ghost"
              size="sm"
              aria-label={`Retry ${name}`}
              onClick={() => onRetry(m.id)}
            >
              Retry
            </Button>
          </p>
        )
      })}
    </div>
  )
}

/**
 * A machine that revoked this device, in the unreachable band's own clothes —
 * the same muted band where its rows would have been — because to the reader
 * it is the same kind of fact: nothing from there is current. What it must
 * not share is the Retry, or the reconnect promise behind it: the daemon
 * deleted this device's key, the fleet stopped the redialling the moment the
 * daemon said why, and every dial a button offered would fail the handshake
 * as a bare close. The reason is the daemon's own words, handed on whole the
 * way the Devices screen hands on a refusal, and the way back is named
 * instead of a button: pairing again, which can only start from a device
 * that machine still trusts.
 */
function RevokedBand({ machines }: { machines: MachineState[] }) {
  return (
    <div className="flex flex-col gap-y-1 rounded-md bg-row-hover px-3 py-2">
      {machines.map((m) => {
        const name = m.name || m.id
        return (
          <p key={m.id} className="text-base/6 text-zinc-500 sm:text-sm/6 dark:text-zinc-400">
            <span className="font-medium text-zinc-950 dark:text-white">{name}</span> revoked this
            device&rsquo;s access{m.revokedReason ? <> — {m.revokedReason}</> : null}. Pair this
            device again from that machine&rsquo;s Devices screen to get back in.
          </p>
        )
      })}
    </div>
  )
}

/** Placeholder rows while a machine is still being dialled or asked. */
function LoadingRows() {
  return (
    <div className="flex flex-col gap-y-3">
      <Skeleton className="h-5 w-40" />
      <Skeleton className="h-8 w-full" />
      <Skeleton className="h-8 w-full" />
    </div>
  )
}
