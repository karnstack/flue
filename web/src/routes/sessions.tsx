import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { ChevronDownIcon } from '@heroicons/react/16/solid'

import type { FlueClient } from '@/client/client'
import { BulkBar } from '@/components/bulk-bar'
import { DisplayOptions } from '@/components/display-options'
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
import { useFleet } from '@/fleet/provider'
import { keyOf, LOCAL_MACHINE_ID, type FleetSession, type MachineState } from '@/fleet/types'
import { useRefetchOnFocus } from '@/hooks/use-refetch-on-focus'
import { takeCwd } from '@/lib/url'
import { cn } from '@/lib/utils'
import { applyView, DEFAULT_VIEW, displayName, type ViewConfig } from '@/sessions/view'
import { deleteView, listViews, saveView, type SavedView } from '@/sessions/views-store'

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

  const [view, setView] = useState<ViewConfig>(defaultView)
  const [views, setViews] = useState<SavedView[]>(() => listViews())
  const [active, setActive] = useState<string | null>(null)

  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set())
  const [folded, setFolded] = useState<ReadonlySet<string>>(() => new Set())

  const [renaming, setRenaming] = useState<FleetSession | null>(null)
  const [tagging, setTagging] = useState<FleetSession | null>(null)
  const [bulkTagging, setBulkTagging] = useState(false)

  const [notice, setNotice] = useState<string | null>(null)

  /**
   * The spawns this screen asked for and has not yet seen answered. A ref,
   * because their listeners settle them without re-rendering anything but
   * `starting`, which shadows its emptiness for the one button that renders.
   */
  const pending = useRef(new Set<PendingSpawn>())
  const [starting, setStarting] = useState(false)

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
   */
  const adopt = useCallback(
    (client: FlueClient, machineId: string, reqId: number) => {
      const entry: PendingSpawn = { reqId, client, offs: [] }
      const settle = () => {
        if (!pending.current.delete(entry)) return
        for (const off of entry.offs) off()
        setStarting(pending.current.size > 0)
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
      setStarting(true)
    },
    [navigate],
  )

  const spawnOn = useCallback(
    (machineId: string | undefined) => {
      setNotice(null)
      const client = machineId === undefined ? null : fleet.clientFor(machineId)
      // 80x24 is a starting point, not a decision; the terminal corrects it
      // the moment it can measure a pane.
      const reqId = client?.spawn({ cols: 80, rows: 24 }) ?? null
      if (client === null || reqId === null || machineId === undefined) {
        setNotice('Not connected to the flue daemon, so nothing was started.')
        return
      }
      adopt(client, machineId, reqId)
    },
    [adopt, fleet],
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

  /**
   * Where the primary button spawns: the machine this tab rides when it is
   * up, else the first machine that is. The chevron beside it names the rest.
   */
  const primaryTarget = online.some((m) => m.id === LOCAL_MACHINE_ID)
    ? LOCAL_MACHINE_ID
    : online[0]?.id

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

  const saveCurrent = (name: string) => {
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
              primary half spawns where a new session most likely belongs —
              the machine this tab rides, else the first one up — and the
              chevron half names the rest of the fleet. It takes its teal
              from --primary rather than naming a colour.

              Held shut while a spawn is unanswered. Without it, a second
              click starts a second shell whose `attached` arrives after this
              screen has navigated away on the first.
            */}
            <div className="flex items-center">
              <Button
                size="sm"
                disabled={starting}
                onClick={() => spawnOn(primaryTarget)}
                className="rounded-r-none"
              >
                New session
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    size="sm"
                    disabled={starting}
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
                      <DropdownMenuItem key={m.id} onSelect={() => spawnOn(m.id)}>
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
          onSaveCurrent={saveCurrent}
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

      {view.grouping !== 'machine' && unreachable.length > 0 && (
        <UnreachableBand machines={unreachable} onRetry={retry} />
      )}

      {showTable && (
        <SessionTable
          groups={groups}
          columns={view.columns}
          selected={selected}
          onToggleSelect={toggleSelect}
          onToggleGroup={toggleGroup}
          collapsed={folded}
          onAction={onAction}
          onSpawnIn={
            view.grouping === 'machine'
              ? (groupKey) => spawnOn(groupKey.replace(/^machine:/, ''))
              : undefined
          }
        />
      )}

      {showSkeleton && <LoadingRows />}

      {view.grouping === 'machine' &&
        unreachable.map((m) => <UnreachableBand key={m.id} machines={[m]} onRetry={retry} />)}

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
    <div className="flex flex-col gap-y-1 rounded-lg bg-zinc-950/[0.03] px-3 py-2 dark:bg-white/[0.04]">
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
