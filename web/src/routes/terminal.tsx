import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { useNavigate, useParams } from '@tanstack/react-router'

import type { FlueClient } from '@/client/client'
import { FlueClientContext } from '@/client/provider'
import { NewSessionDialog } from '@/components/new-session-dialog'
import { SessionGroup } from '@/components/session-group'
import { Terminal } from '@/components/terminal'
import { useFleet } from '@/fleet/provider'
import type { FleetSession, MachineState } from '@/fleet/types'
import {
  matchNewTabChord,
  matchSplitChord,
  matchTabCycleChord,
  type GroupLayout,
} from '@/lib/split-keys'
import { anchorIdOf, groupMembers } from '@/sessions/groups'
import { useIsMobile } from '@/hooks/use-mobile'
import {
  leafIds,
  loadTabs,
  reconcileTabs,
  saveTabs,
  splitInTabs,
  tabOf,
  topRightLeaf,
  withRatio,
  type PaneTree,
  type TreePath,
} from '@/sessions/pane-tree'
import { useOpenNewSession, type NewSessionOrigin } from '@/sessions/open-new-session'
import { displayName } from '@/sessions/view'
import { isApplePlatform } from '@/switcher/keys'

/**
 * The terminal route.
 *
 * It renders bare and full-bleed on purpose: this route sits outside AppShell,
 * because a terminal session *is* the tab and sidebar chrome around it would
 * contradict the premise of the project. `h-full` on the Terminal's own pane
 * is what carries the height down from #root.
 *
 * The route id is written out rather than imported from src/router.tsx, which
 * exports it as TERMINAL_ROUTE_ID. Importing it would close a cycle — the
 * router imports this component — and the literal is not unchecked: `from`
 * is typed against the registered route tree, so a path that drifts is a
 * compile error rather than an empty params object at runtime.
 *
 * The deviceId param is real now. The fleet holds one client per machine this
 * browser can reach, and the segment names which of them the session lives on:
 * `local` is the machine this tab rides — its client is the very one every
 * other screen shares, so that address behaves exactly as it always has — and
 * any other id is a paired machine reached the long way round. The resolved
 * client is handed down through the client context rather than a prop, so the
 * Terminal component keeps not knowing the fleet exists; providing it here
 * comes with no lifecycle attached, because the fleet owns every one of these
 * clients and an unmounting route must not hang one up.
 */
export function TerminalRoute() {
  const { deviceId, sessionId } = useParams({ from: '/d/$deviceId/s/$sessionId' })
  const navigate = useNavigate()
  const fleet = useFleet()
  const openNewSession = useOpenNewSession()
  /**
   * What the `+` in the terminal's control strip is asking for, or null for
   * closed. The dialog is hosted here rather than inside `<Terminal>` because
   * it needs the fleet's machines and the fleet's tags, and that component is
   * deliberately built to work without knowing a fleet exists.
   */
  const [creating, setCreating] = useState<NewSessionOrigin | null>(null)
  // Resolved through a subscription, not read once, because the answer moves:
  // a direct load of a remote machine's session renders before the fleet has
  // adopted its remote sources — those are built only after the local
  // daemon's welcome names the relay — so the first look legitimately finds
  // nothing, and the moment of adoption has to reach this route as a
  // re-render, or a reload of a remote terminal would sit on the not-paired
  // pill for ever. onFleet fires on any reshaping of the fleet, and the
  // snapshot is the slot's own client, whose identity only changes when the
  // answer genuinely has.
  const client = useSyncExternalStore(
    useCallback((onChange: () => void) => fleet.onFleet(onChange), [fleet]),
    () => fleet.clientFor(deviceId),
  )
  // What the dialog needs to fill its machine picker and its tag suggestions.
  const fleetForForm = useFormFleet(fleet)

  // This machine's rows, for the group view: which sessions share the URL
  // session's group, and what to call their tabs. Empty until the fleet's
  // poll lands, which renders exactly one pane — the session the URL names —
  // and that is the degenerate case a plain session must stay.
  const rows = useMachineRows(fleet, deviceId)

  // The multiplex affordances are drawn only once this daemon's welcome has
  // claimed the capability; an older daemon would drop the group field and
  // spawn a stranger next to the session instead of a pane in it.
  const canMultiplex = useHasCap(client, 'multiplex')

  // Panes whose shells exited while this view watched, folded away. The row
  // lingers in the daemon's list for the exited retention, so "closed" has
  // to be this view's own fact. Never reset — session ids do not recur, a
  // stale entry for a reaped session matches nothing, and a reset keyed on
  // the anchor was measured resurrecting dismissed panes when navigation
  // made the anchor flap for a beat.
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(() => new Set())

  // The URL keeps naming the session that was opened; the group is resolved
  // from it. A member's URL resolves the same group, so a link to any pane
  // opens the whole surface. It holds steady across a beat where the rows do not
  // name the URL session yet — a Restart navigates to an id the next list
  // has not delivered — so the group surface does not collapse and rebuild
  // around a fact that is merely in flight. A genuinely different session
  // (the ref remembers which id it answered for) starts from itself.
  const anchorRef = useRef({ resolvedFor: sessionId, anchor: sessionId })
  const own = rows.find((s) => s.id === sessionId)
  const anchorId =
    own !== undefined
      ? anchorIdOf(own)
      : anchorRef.current.resolvedFor === sessionId
        ? anchorRef.current.anchor
        : sessionId
  anchorRef.current = { resolvedFor: sessionId, anchor: anchorId }

  // Which members this view has seen alive. An exited member keeps its pane
  // — the exit overlay is owed to whoever watched it die — but only for a
  // death witnessed here: a fresh load must not dredge the retention
  // window's corpses back onto the surface. Written during render, which is
  // safe for a ref because adding to a set is idempotent.
  const seenRunning = useRef(new Set<string>())
  for (const s of rows) if (s.state === 'running') seenRunning.current.add(s.id)

  const members = groupMembers(rows, anchorId).filter(
    (s) =>
      !dismissed.has(s.id) &&
      (s.id === sessionId || s.state !== 'exited' || seenRunning.current.has(s.id)),
  )
  const havePanes = members.length > 0
  const panes = havePanes
    ? members.map((s) => ({ id: s.id, label: displayName(s) }))
    : [{ id: sessionId, label: '' }]

  // The mobile tab in front. Falls back inside SessionGroup when it names a
  // pane that has gone, and follows the URL when the URL moves.
  const [active, setActive] = useState(sessionId)
  useEffect(() => setActive(sessionId), [sessionId])
  const isMobile = useIsMobile()

  // The desktop arrangement: one split tree per tab, owned here rather than
  // in SessionGroup because the verbs that change it (the menu rows, the
  // chords) live here; persisted per group and per device. Every setTabTrees
  // writes through saveTabs inside the updater, which is idempotent, so
  // StrictMode's double-invoke costs a duplicate write and nothing else.
  const storageKey = `flue.group.${deviceId}.${anchorId}`
  const [tabTrees, setTabTrees] = useState<PaneTree[]>(() => loadTabs(storageKey))
  useEffect(() => setTabTrees(loadTabs(storageKey)), [storageKey])

  const paneIds = panes.map((p) => p.id)

  // The tabs follow the members: panes that closed leave their tree, tabs
  // that emptied fold away, and a member that appeared without a recorded
  // placement — a split made from another device — gets a tab of its own.
  // Keyed on the id list's spelling, so the fleet's poll ticks cost nothing
  // while nothing changes. Gated on real members: before the fleet's first
  // answer the pane list is a placeholder for the URL session, and
  // reconciling against that would prune a freshly loaded layout to one
  // leaf — and persist the damage — on every reload.
  const paneKey = paneIds.join(',')
  useEffect(() => {
    if (!havePanes) return
    setTabTrees((t) => {
      const next = reconcileTabs(t, paneKey.split(','))
      if (next !== t) saveTabs(storageKey, next)
      return next
    })
  }, [havePanes, paneKey, storageKey])

  // Which pane last held the keyboard, for the chord to target: ⇧⌘D splits
  // the pane being typed in, not the URL's. Written by a passive focus
  // listener over the data attribute every Terminal pane carries.
  const focusedPane = useRef<string | null>(null)
  useEffect(() => {
    const onFocus = (e: FocusEvent) => {
      const el = e.target instanceof Element ? e.target.closest('[data-flue-session]') : null
      const id = el?.getAttribute('data-flue-session')
      if (id != null && id !== '') focusedPane.current = id
    }
    window.addEventListener('focusin', onFocus)
    return () => window.removeEventListener('focusin', onFocus)
  }, [])
  const goTo = useCallback(
    (id: string) =>
      void navigate({
        to: '/d/$deviceId/s/$sessionId',
        params: { deviceId, sessionId: id },
        replace: true,
      }),
    [navigate, deviceId],
  )

  /*
   * Split: another session in this group, in the directory of the pane that
   * asked — and, for the two split verbs, placed beside that very pane in
   * the tree, so ⇧⌘D over the right column of an A|B split stacks inside
   * that column rather than rearranging the whole surface. "New tab" is the
   * third verb: same spawn, tabs rendering. Click/chord-driven, like every
   * spawn in this app — StrictMode runs mount effects twice and a spawning
   * effect can only ever detach one of its shells. The ref is handed
   * straight back; the pane mounts through the refreshed list.
   */
  const rowsRef = useRef(rows)
  rowsRef.current = rows
  const split = useCallback(
    (paneId: string, cwd: string | null, verb: GroupLayout) => {
      if (client === null) return
      const reqId = client.spawn({
        cwd: cwd ?? rowsRef.current.find((s) => s.id === paneId)?.cwd,
        cols: 80,
        rows: 24,
        group: anchorId,
      })
      if (reqId === null) return
      const offs: Array<() => void> = []
      const settle = () => {
        for (const off of offs) off()
      }
      offs.push(
        client.onAttached((a) => {
          if (a.reqId !== reqId) return
          settle()
          client.detach(a.ref)
          // Place the new pane now, so the layout is settled before the
          // refreshed list mounts it — the reconcile effect would otherwise
          // guess and give it a tab of its own. A split lands beside the
          // pane that asked, inside that pane's tab; a new tab is appended
          // whole. splitInTabs declines when the target has meanwhile gone,
          // and the reconcile pass then adopts the newcomer anyway.
          setTabTrees((t) => {
            const base = t.length === 0 ? [{ leaf: anchorId } as PaneTree] : t
            const next =
              verb === 'tabs'
                ? [...base, { leaf: a.id } as PaneTree]
                : splitInTabs(base, paneId, verb, a.id)
            saveTabs(storageKey, next)
            return next
          })
          // The pane appears when the rows say so; asking now is what makes
          // that a beat rather than the fleet's next three-second poll.
          client.list()
          setActive(a.id)
        }),
        client.onError((e) => {
          if (e.reqId === reqId) settle()
        }),
        client.onStatus((s) => {
          if (s !== 'open') settle()
        }),
      )
    },
    [client, storageKey, anchorId],
  )

  // A divider settled: commit the ratio into its tab's tree and persist,
  // once per drag.
  const onRatio = useCallback(
    (tab: number, path: TreePath, ratio: number) => {
      setTabTrees((t) => {
        const tree = t[tab]
        if (tree === undefined) return t
        const nextTree = withRatio(tree, path, ratio)
        if (nextTree === tree) return t
        const next = [...t]
        next[tab] = nextTree
        saveTabs(storageKey, next)
        return next
      })
    },
    [storageKey],
  )

  // The split chords: ⌘D / ⇧⌘D on a Mac, the Ctrl+Shift family elsewhere
  // (lib/split-keys.ts). Capture phase for the switcher's reason — left to
  // bubble, xterm turns the keystroke into bytes first. The target is the
  // pane holding the keyboard, or the URL's when none does; everything is
  // read through refs so the listener mounts once.
  const splitRef = useRef(split)
  splitRef.current = split
  const paneIdsRef = useRef(paneIds)
  paneIdsRef.current = paneIds
  const urlPaneRef = useRef(sessionId)
  urlPaneRef.current = sessionId
  useEffect(() => {
    if (!canMultiplex) return
    const apple = isApplePlatform()
    const onKey = (e: KeyboardEvent) => {
      const dir = matchSplitChord(e, apple)
      const newTab = dir === null && matchNewTabChord(e, apple)
      if (dir === null && !newTab) return
      e.preventDefault()
      e.stopPropagation()
      const focused = focusedPane.current
      const target =
        focused !== null && paneIdsRef.current.includes(focused) ? focused : urlPaneRef.current
      splitRef.current(target, null, dir ?? 'tabs')
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [canMultiplex])

  /*
   * Walking the tabs: ⌥⌘←/→ (Ctrl+Alt+←/→ off a Mac) steps to the
   * neighbouring tab — of trees on a desktop, of panes on a phone. Purely
   * client-side, so it works against any daemon, and mounted once with every
   * moving part behind a ref.
   */
  const tabsRef = useRef(tabTrees)
  tabsRef.current = tabTrees
  const shownRef = useRef(sessionId)
  const mobileRef = useRef(isMobile)
  mobileRef.current = isMobile
  useEffect(() => {
    const apple = isApplePlatform()
    const onKey = (e: KeyboardEvent) => {
      const step = matchTabCycleChord(e, apple)
      if (step === null) return
      const ids = paneIdsRef.current
      if (ids.length <= 1) return
      e.preventDefault()
      e.stopPropagation()
      if (mobileRef.current) {
        const at = Math.max(0, ids.indexOf(shownRef.current))
        setActive(ids[(at + step + ids.length) % ids.length]!)
        return
      }
      const tabs = tabsRef.current
      if (tabs.length <= 1) return
      const at = Math.max(0, tabOf(tabs, shownRef.current))
      setActive(leafIds(tabs[(at + step + tabs.length) % tabs.length]!)[0]!)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  // Which pane wears the control strip. The chips belong to the surface,
  // not to a pane — a strip on every pane is four chips times N, and one
  // pinned to the URL pane floats mid-screen and dies with it. So they sit
  // on whichever pane owns the surface's top-right corner — of the tab in
  // front, on a desktop — and pass along when that pane goes.
  const shownTab = panes.some((p) => p.id === active) ? active : panes[0]!.id
  shownRef.current = shownTab
  const activeTree = tabTrees[Math.max(0, tabOf(tabTrees, shownTab))]
  const chipsPane = isMobile || activeTree === undefined ? shownTab : topRightLeaf(activeTree)

  // A machine the fleet does not hold: never paired on this browser, or its
  // pinned key gone. Said in a pill, the way the terminal answers a session
  // the daemon has never heard of — though unlike that answer this one is
  // provisional for a breath at boot, which is what the subscription above
  // exists to notice.
  if (client === null) return <MachineNotPaired />
  return (
    <FlueClientContext.Provider value={client}>
      <SessionGroup
        tabs={tabTrees}
        panes={panes}
        onRatio={onRatio}
        active={active}
        onActivate={setActive}
        onNewTab={canMultiplex ? () => split(shownTab, null, 'tabs') : undefined}
        renderPane={(id, viewportInset, fit) => (
          // Keyed by machine, session, inset and pinning, so navigating
          // between two sessions — or the tab strip appearing above one, or
          // a pane moving between a split and a lone rendering — builds a
          // new terminal rather than feeding one emulator two sessions'
          // scrollback. The key also resets the state React holds: the
          // phase pill, the keyboard mode.
          <Terminal
            key={`${deviceId}:${id}:${viewportInset}:${fit ? 'fit' : 'free'}`}
            sessionId={id}
            viewportInset={viewportInset}
            fitViewport={fit}
            ownsTitle={id === sessionId}
            // One set of chips per surface, not per pane — see chipsPane.
            // Every other pane keeps only its status pill. The chord still
            // splits whichever pane holds the keyboard, so the chips'
            // placement costs a sibling nothing but the pointer route.
            chrome={id === chipsPane ? 'full' : 'minimal'}
            onClosed={() => {
              // Fired by the exit itself — there is no overlay any more. A
              // session that was already over when this view opened is being
              // *read*, which is what the daemon's exited-retention window
              // is for, so only a shell seen alive here folds its pane away.
              if (!seenRunning.current.has(id)) return
              const remaining = paneIds.filter((p) => p !== id)
              // The chord must never aim at this pane again. Its ref is
              // cleared now rather than left to the next focusin, because a
              // chord in the gap would read the dead pane's id and fall
              // through to whatever the paneIds guard makes of it.
              if (focusedPane.current === id) focusedPane.current = remaining[0] ?? null
              if (remaining.length === 0) {
                // replace: a dead session's URL is not worth a Back stop.
                void navigate({ to: '/', replace: true })
                return
              }
              setDismissed((prev) => new Set(prev).add(id))
              if (id === sessionId) goTo(remaining[0]!)
              else if (id === active) setActive(remaining[0]!)
            }}
            // This machine and this directory, because that is what a `+`
            // inside a session means. Both are only a prefill — the dialog
            // offers the rest of the fleet, and a session started from here
            // need not be a sibling.
            onNewSession={(cwd) => setCreating({ machineId: deviceId, cwd: cwd ?? '' })}
            onSplit={canMultiplex ? (cwd, verb) => split(id, cwd, verb) : undefined}
          />
        )}
      />
      <NewSessionDialog
        open={creating !== null}
        initial={creating ?? {}}
        machines={fleetForForm.machines}
        known={fleetForForm.tags}
        onSubmit={openNewSession}
        onClose={() => setCreating(null)}
      />
    </FlueClientContext.Provider>
  )
}

/**
 * This machine's session rows, updated only when something a pane layout
 * reads has genuinely changed. The fleet emits every poll tick with fresh
 * object identities, and the terminal is the one screen that has to stay
 * smooth — so the rows are reduced to a signature and compared before any
 * state moves.
 */
function useMachineRows(fleet: ReturnType<typeof useFleet>, machineId: string): FleetSession[] {
  const [rows, setRows] = useState<FleetSession[]>([])
  useEffect(() => {
    setRows([])
    return fleet.onFleet((sessions) => {
      const mine = sessions.filter((s) => s.machineId === machineId)
      // An empty answer while rows are held is kept out: the fleet nulls a
      // machine's rows on every socket blip, and adopting that emptiness
      // would collapse the group layout — unmounting and rebuilding every
      // pane's emulator — for a one-second Wi-Fi hiccup. Holding the last
      // known rows costs nothing real: a session that genuinely ended
      // announces itself to its own pane (exit, or the not-found reply on
      // reattach), and the rows refresh the moment the machine answers.
      if (mine.length === 0) return
      setRows((prev) => (sameRows(prev, mine) ? prev : mine))
    })
  }, [fleet, machineId])
  return rows
}

/** Whether two row lists would render the same group view. */
function sameRows(a: FleetSession[], b: FleetSession[]): boolean {
  return a.length === b.length && a.every((s, i) => rowSig(s) === rowSig(b[i]!))
}

function rowSig(s: FleetSession): string {
  return `${s.id}|${s.group ?? ''}|${s.state}|${s.cwd}|${displayName(s)}`
}

/** Whether `client` has announced a capability, kept current across welcomes. */
function useHasCap(client: FlueClient | null, cap: string): boolean {
  const [has, setHas] = useState(() => client?.hasCap(cap) ?? false)
  const capRef = useRef(cap)
  capRef.current = cap
  useEffect(() => {
    if (client === null) {
      setHas(false)
      return
    }
    setHas(client.hasCap(capRef.current))
    return client.onWelcome(() => setHas(client.hasCap(capRef.current)))
  }, [client])
  return has
}

/** What the new-session form needs off the fleet, and nothing else. */
interface FormFleet {
  machines: Array<{ id: string; name: string }>
  tags: string[]
}

const NO_FLEET: FormFleet = { machines: [], tags: [] }

/** Whether two of those say the same thing, machine for machine and tag for tag. */
function sameFleet(a: FormFleet, b: FormFleet): boolean {
  return (
    a.machines.length === b.machines.length &&
    a.tags.length === b.tags.length &&
    a.machines.every((m, at) => m.id === b.machines[at]?.id && m.name === b.machines[at]?.name) &&
    a.tags.every((t, at) => t === b.tags[at])
  )
}

/**
 * The fleet's online machines and every tag in use across it.
 *
 * Subscribed from mount rather than while the dialog is open, and the
 * comparison above is what makes that affordable: the fleet emits every poll
 * tick, three seconds apart, and almost none of those change either list — so
 * holding the previous object turns a steady drip of re-renders into one per
 * genuine change. The terminal is under this route, and it is the one screen
 * in the app that has to stay smooth.
 *
 * Subscribing early is not merely cheaper than the alternative, it is the only
 * thing that makes the picker correct: a listener wired when the dialog opens
 * would have nothing to show until the next tick, because the fleet replays
 * nothing at subscribe time — and an empty picker reads as "no machine is
 * reachable", which would be a lie told at exactly the wrong moment.
 *
 * The machines are narrowed to the online ones for the same reason the
 * dashboard narrows them: offering a machine that cannot answer is a choice
 * that fails after the form has closed.
 */
function useFormFleet(fleet: ReturnType<typeof useFleet>): FormFleet {
  const [state, setState] = useState<FormFleet>(NO_FLEET)

  useEffect(
    () =>
      fleet.onFleet((sessions, machines: MachineState[]) => {
        const next: FormFleet = {
          machines: machines
            .filter((m) => m.status === 'online')
            .map((m) => ({ id: m.id, name: m.name })),
          tags: [...new Set(sessions.flatMap((s) => s.tags))].sort(),
        }
        setState((prev) => (sameFleet(prev, next) ? prev : next))
      }),
    [fleet],
  )

  return state
}

/**
 * The missing-machine treatment, matched to the missing-session one: the same
 * full-bleed pane the terminal renders, the same pill in the same corner, a
 * dot that holds still because the state is final. Dark in both themes, as
 * the pill is when it floats over a terminal.
 */
function MachineNotPaired() {
  return (
    <div className="relative h-full w-full overflow-hidden bg-white dark:bg-zinc-950">
      <div className="absolute top-3 right-3 z-10">
        <div
          role="status"
          className="rounded-lg bg-zinc-900/90 px-3 py-1.5 text-base/4 font-medium text-zinc-100 shadow-lg ring-1 ring-white/10 backdrop-blur-sm sm:text-sm/4"
        >
          <span className="flex items-center gap-x-2">
            <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-zinc-500" />
            Machine not paired on this browser
          </span>
        </div>
      </div>
    </div>
  )
}
