import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useSearch } from '@tanstack/react-router'
import { AdjustmentsHorizontalIcon, MagnifyingGlassIcon } from '@heroicons/react/16/solid'

import { Heatmap, RankChart, ToolDayChart } from '@/agents/charts'
import {
  AGENT_GROUPING_LABELS,
  AGENT_GROUPINGS,
  AGENT_ORDERING_LABELS,
  AGENT_ORDERINGS,
  AGENT_TOOLS,
  applyAgentView,
  byModel,
  byProject,
  compactCost,
  compactTokens,
  DEFAULT_AGENT_VIEW,
  filterRows,
  fmtDuration,
  groupHits,
  heatmapWeeks,
  insightTotals,
  INSIGHT_RANGE_LABELS,
  INSIGHT_RANGES,
  rangeFilter,
  sessionsByDay,
  shortModel,
  splitSnippet,
  tokensByDay,
  TOOL_LABELS,
  usageStats,
  type AgentHitRow,
  type AgentRow,
  type AgentViewConfig,
  type InsightRange,
} from '@/agents/view'
import { AgentEmptyState, AgentList, AgentSkeleton, ToolDot } from '@/components/agent-rows'
import { PageHeader } from '@/components/page-header'
import { since } from '@/components/session-table'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import type { AgentSummary, AgentTool } from '@/client/protocol'
import { useFleet } from '@/fleet/provider'
import type { MachineState } from '@/fleet/types'
import { useRefetchOnFocus } from '@/hooks/use-refetch-on-focus'
import { cn } from '@/lib/utils'

/** The viewer's path, written out for the row component's reason. */
const VIEWER_PATH = '/agents/$machineId/$tool/$sessionId' as const

/** How often a machine still building its index is asked again. */
const BUILD_POLL_MS = 2_000

/** How long the building re-poll keeps going before settling for what it
 *  has. A sweep that has not finished in a minute is not about to; the
 *  partial answer is on screen either way. */
const BUILD_POLL_BUDGET_MS = 60_000

/** What one machine has said about its transcripts, or not yet. */
type MachineAgents =
  | { at: 'loading' }
  | { at: 'ready'; rows: AgentSummary[]; building: boolean }
  | { at: 'failed' }

/** Everything a finished fan-out search has to say. */
type SearchState =
  | { at: 'loading' }
  | { at: 'ready'; hits: AgentHitRow[]; building: boolean; truncated: boolean }

/** The two presentations of the one route, when no search is on. */
type Mode = 'sessions' | 'insights'

/** Each tool's dot colour, for the legend and the tool chips. */
const TOOL_DOT_BG: Record<AgentTool, string> = {
  claude: 'bg-tool-claude',
  codex: 'bg-tool-codex',
  pi: 'bg-tool-pi',
}

/**
 * The agents browser: every reachable machine's agent transcripts, merged,
 * arranged, aggregated and searched.
 *
 * The route owns all of the state, exactly as the sessions route does, and
 * everything it computes runs through agents/view.ts so the arithmetic stays
 * arguable in unit tests. The wire model is per machine: each online daemon
 * that declares the `agents` capability answers for its own disk, and this
 * screen merges the answers — including partial ones, since a daemon still
 * sweeping says `building: true` and is simply asked again in a moment.
 */
export function AgentsRoute() {
  const fleet = useFleet()
  const navigate = useNavigate()
  // Non-strict for the viewer's reason: the registered route id wears the
  // shell layout's prefix, and the test harness mounts this under a bare
  // path, so a lookup pinned to either id would fail under the other.
  const search = useSearch({ strict: false }) as { q?: string; view?: 'insights' }
  const q = search.q ?? ''

  const [machines, setMachines] = useState<MachineState[] | null>(null)
  const [byMachine, setByMachine] = useState<ReadonlyMap<string, MachineAgents>>(new Map())

  const [view, setView] = useState<AgentViewConfig>(DEFAULT_AGENT_VIEW)
  // The presentation toggle lives in the URL (`?view=insights`) so a reload
  // lands where the reader was; written with replace, so flipping it never
  // stacks history the back button has to unwind.
  const mode: Mode = search.view === 'insights' ? 'insights' : 'sessions'
  const setMode = (next: Mode) => {
    void navigate({
      to: '/agents',
      search: { q: search.q, view: next === 'insights' ? ('insights' as const) : undefined },
      replace: true,
    })
  }
  const [range, setRange] = useState<InsightRange>('30d')
  const [toolFilter, setToolFilter] = useState<ReadonlySet<AgentTool>>(() => new Set())
  const [machineFilter, setMachineFilter] = useState<ReadonlySet<string>>(() => new Set())

  const [results, setResults] = useState<SearchState | null>(null)

  /**
   * Which fetch cycle is current. Bumped on unmount so an answer landing
   * after the screen has gone sets nothing — the same one-counter guard
   * session-preview.tsx uses, and for its reason: the machine list arrives as
   * fresh arrays every few seconds, and none of the async work below may hang
   * its identity on them.
   */
  const generation = useRef(0)
  const searchGeneration = useRef(0)
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>())
  const buildingSince = useRef(new Map<string, number>())

  useEffect(() => {
    const off = fleet.onFleet((_sessions, ms) => setMachines(ms))
    fleet.list()
    return off
  }, [fleet])

  useEffect(
    () => () => {
      generation.current++
      searchGeneration.current++
      for (const t of timers.current.values()) clearTimeout(t)
      timers.current.clear()
    },
    [],
  )

  /**
   * The machines this screen may ask: online, greeted, and declaring the
   * capability. `hasCap` is false before the welcome lands, so a machine mid
   * handshake is skipped for one delivery rather than mislabelled too old —
   * the next fleet delivery re-evaluates.
   */
  const capIds = useMemo(
    () =>
      (machines ?? [])
        .filter((m) => m.status === 'online' && (fleet.clientFor(m.id)?.hasCap('agents') ?? false))
        .map((m) => m.id)
        .sort(),
    [machines, fleet],
  )
  const capKey = capIds.join('\n')

  const askMachine = useCallback(
    (id: string) => {
      const mine = generation.current
      fleet.agentsOn(id).then(
        (msg) => {
          if (generation.current !== mine) return
          setByMachine((prev) =>
            new Map(prev).set(id, { at: 'ready', rows: msg.sessions, building: msg.building }),
          )
          const armed = timers.current.get(id)
          if (armed !== undefined) {
            clearTimeout(armed)
            timers.current.delete(id)
          }
          if (!msg.building) {
            buildingSince.current.delete(id)
            return
          }
          // Still sweeping: ask again shortly, but not forever — after the
          // budget the partial snapshot stands until the next focus refetch.
          const startedAt = buildingSince.current.get(id) ?? Date.now()
          buildingSince.current.set(id, startedAt)
          if (Date.now() - startedAt < BUILD_POLL_BUDGET_MS) {
            const t = setTimeout(() => {
              timers.current.delete(id)
              askMachine(id)
            }, BUILD_POLL_MS)
            timers.current.set(id, t)
          }
        },
        () => {
          if (generation.current !== mine) return
          // A refetch that failed must not wipe rows already on screen; only
          // a machine that never answered lands on the failed state.
          setByMachine((prev) => {
            const had = prev.get(id)
            if (had !== undefined && had.at === 'ready') return prev
            return new Map(prev).set(id, { at: 'failed' })
          })
        },
      )
    },
    [fleet],
  )

  useEffect(() => {
    const ids = capKey === '' ? [] : capKey.split('\n')
    // A machine that left takes its build re-poll with it: an orphan timer
    // would fire against a machine the screen dropped, and the rejection
    // handler would write a failed entry back for an id nothing tracks. The
    // budget stamp goes too, so a machine that returns starts a fresh one.
    for (const [id, t] of timers.current) {
      if (ids.includes(id)) continue
      clearTimeout(t)
      timers.current.delete(id)
      buildingSince.current.delete(id)
    }
    setByMachine((prev) => {
      const kept = [...prev].filter(([id]) => ids.includes(id))
      const next = new Map(kept)
      for (const id of ids) if (!next.has(id)) next.set(id, { at: 'loading' })
      return next
    })
    for (const id of ids) askMachine(id)
  }, [capKey, askMachine])

  useRefetchOnFocus(
    useCallback(() => {
      fleet.list()
      for (const id of capKey === '' ? [] : capKey.split('\n')) askMachine(id)
    }, [fleet, capKey, askMachine]),
  )

  /** Machine names for stamping, read through a ref where an effect needs
   *  them without re-running on every delivery. */
  const names = useMemo(
    () => new Map((machines ?? []).map((m) => [m.id, m.name])),
    [machines],
  )
  const namesRef = useRef(names)
  namesRef.current = names

  // The fan-out search, re-run when the query or the reachable set changes.
  useEffect(() => {
    if (q === '') {
      setResults(null)
      return
    }
    const mine = ++searchGeneration.current
    setResults({ at: 'loading' })
    const ids = capKey === '' ? [] : capKey.split('\n')
    void Promise.allSettled(
      ids.map((id) => fleet.agentSearchOn(id, q).then((msg) => ({ id, msg }))),
    ).then((settled) => {
      if (searchGeneration.current !== mine) return
      const hits: AgentHitRow[] = []
      let building = false
      let truncated = false
      for (const outcome of settled) {
        if (outcome.status === 'rejected') continue
        const { id, msg } = outcome.value
        building ||= msg.building
        truncated ||= msg.truncated
        for (const h of msg.hits) {
          hits.push({ ...h, machineId: id, machineName: namesRef.current.get(id) ?? id })
        }
      }
      setResults({ at: 'ready', hits, building, truncated })
    })
  }, [q, capKey, fleet])

  const rows: AgentRow[] = useMemo(() => {
    const out: AgentRow[] = []
    for (const [id, state] of byMachine) {
      if (state.at !== 'ready') continue
      for (const s of state.rows) {
        out.push({ ...s, machineId: id, machineName: names.get(id) ?? id })
      }
    }
    return out
  }, [byMachine, names])

  const filters = useMemo(
    () => ({ tools: toolFilter, machines: machineFilter }),
    [toolFilter, machineFilter],
  )
  const groups = useMemo(
    () => applyAgentView(rows, view, filters, Date.now()),
    [rows, view, filters],
  )

  const online = (machines ?? []).filter((m) => m.status === 'online')
  const unreachable = (machines ?? []).filter((m) => m.status === 'unreachable')
  /** Online, greeted, and without the capability: a daemon too old for this
   *  screen, which is a fact worth a sentence rather than a blank. */
  const tooOld = online.filter((m) => {
    const client = fleet.clientFor(m.id)
    return client !== null && client.version !== null && !client.hasCap('agents')
  })

  const anyBuilding = [...byMachine.values()].some((s) => s.at === 'ready' && s.building)
  const anyLoading = capIds.some((id) => (byMachine.get(id)?.at ?? 'loading') === 'loading')
  const connecting = (machines ?? []).filter((m) => m.status === 'connecting')
  const showSkeleton = machines === null || connecting.length > 0 || anyLoading
  const showEmpty = !showSkeleton && capIds.length > 0 && rows.length === 0 && !anyBuilding

  const toggleTool = (tool: AgentTool) =>
    setToolFilter((prev) => {
      const next = new Set(prev)
      if (!next.delete(tool)) next.add(tool)
      return next
    })

  const toggleMachine = (id: string) =>
    setMachineFilter((prev) => {
      const next = new Set(prev)
      if (!next.delete(id)) next.add(id)
      return next
    })

  const submitSearch = (value: string) => {
    // The view survives a search and its clearing — a reader who searched
    // from the insights comes back to the insights.
    void navigate({
      to: '/agents',
      search:
        value.trim() === '' ? { view: search.view } : { q: value.trim(), view: search.view },
    })
  }

  const searching = q !== ''

  return (
    <div className="flex flex-col gap-y-6 p-4 sm:p-6 lg:p-8">
      <PageHeader
        crumbs={[{ label: 'Agents' }]}
        actions={
          <>
            <AgentSearchBox key={q} initial={q} onSubmit={submitSearch} />
            <AgentDisplayOptions view={view} onChange={setView} />
          </>
        }
      />

      {tooOld.length > 0 && (
        <div className="flex flex-col gap-y-1 rounded-md bg-row-hover px-3 py-2">
          {tooOld.map((m) => (
            <p
              key={m.id}
              className="text-base/6 text-zinc-500 sm:text-sm/6 dark:text-zinc-400"
            >
              <span className="font-medium text-zinc-950 dark:text-white">{m.name || m.id}</span>{' '}
              runs a flue too old to index agent transcripts. Update it there to see them here.
            </p>
          ))}
        </div>
      )}

      {unreachable.length > 0 && (
        <div className="flex flex-col gap-y-1 rounded-md bg-row-hover px-3 py-2">
          {unreachable.map((m) => (
            <p
              key={m.id}
              className="flex items-center gap-x-1.5 text-base/6 text-zinc-500 sm:text-sm/6 dark:text-zinc-400"
            >
              <span className="font-medium text-zinc-950 dark:text-white">{m.name || m.id}</span>
              is unreachable
              <span aria-hidden="true">·</span>
              <Button
                variant="ghost"
                size="sm"
                aria-label={`Retry ${m.name || m.id}`}
                onClick={() => fleet.clientFor(m.id)?.connect()}
              >
                Retry
              </Button>
            </p>
          ))}
        </div>
      )}

      {searching ? (
        <SearchResults q={q} results={results} />
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <div role="group" aria-label="View" className="flex items-center gap-x-1">
              <ModeTab pressed={mode === 'sessions'} onPress={() => setMode('sessions')}>
                Sessions
              </ModeTab>
              <ModeTab pressed={mode === 'insights'} onPress={() => setMode('insights')}>
                Insights
              </ModeTab>
            </div>

            <div role="group" aria-label="Tools" className="flex flex-wrap items-center gap-1.5">
              <FilterChip pressed={toolFilter.size === 0} onPress={() => setToolFilter(new Set())}>
                All
              </FilterChip>
              {AGENT_TOOLS.map((tool) => (
                <FilterChip
                  key={tool}
                  pressed={toolFilter.has(tool)}
                  onPress={() => toggleTool(tool)}
                  dotClass={TOOL_DOT_BG[tool]}
                >
                  {TOOL_LABELS[tool]}
                </FilterChip>
              ))}
            </div>

            {online.length > 1 && (
              <div
                role="group"
                aria-label="Machines"
                className="flex flex-wrap items-center gap-1.5"
              >
                {online.map((m) => (
                  <FilterChip
                    key={m.id}
                    pressed={machineFilter.has(m.id)}
                    onPress={() => toggleMachine(m.id)}
                  >
                    {m.name || m.id}
                  </FilterChip>
                ))}
              </div>
            )}
          </div>

          {mode === 'insights' ? (
            <Insights rows={rows} filters={filters} range={range} onRange={setRange} />
          ) : (
            <>
              {groups.length > 0 && <AgentList groups={groups} showMachine={online.length > 1} />}
              {!showSkeleton && rows.length > 0 && groups.length === 0 && (
                <p className="text-base/6 text-zinc-500 sm:text-sm/6 dark:text-zinc-400">
                  Nothing matches these filters.
                </p>
              )}
              {showEmpty && <AgentEmptyState />}
              {showSkeleton && <AgentSkeleton />}
            </>
          )}
        </>
      )}
    </div>
  )
}

/**
 * The search field, submit-to-URL rather than filter-as-you-type: a query
 * costs every machine a scan of its transcripts, so it is sent when the
 * reader says so and the URL carries it, which is what makes the back button
 * undo a search.
 */
function AgentSearchBox({
  initial,
  onSubmit,
}: {
  initial: string
  onSubmit(value: string): void
}) {
  const [draft, setDraft] = useState(initial)
  return (
    <form
      className="relative min-w-0 flex-1 sm:flex-none"
      onSubmit={(event) => {
        event.preventDefault()
        onSubmit(draft)
      }}
    >
      <MagnifyingGlassIcon
        aria-hidden="true"
        className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
      />
      <Input
        type="search"
        name="q"
        aria-label="Search transcripts"
        placeholder="Search transcripts"
        autoComplete="off"
        spellCheck={false}
        value={draft}
        onChange={(event) => {
          setDraft(event.target.value)
          // The field's own clear control fires a change with an empty value
          // and no submit; an emptied search should fall back to the list.
          if (event.target.value === '' && initial !== '') onSubmit('')
        }}
        className="w-full pl-8 sm:w-56"
      />
    </form>
  )
}

/** One of the two presentation tabs — pressed toggles, as ViewTabs argues. */
function ModeTab({
  pressed,
  onPress,
  children,
}: {
  pressed: boolean
  onPress(): void
  children: string
}) {
  return (
    <Button
      variant={pressed ? 'secondary' : 'ghost'}
      size="sm"
      aria-pressed={pressed}
      onClick={onPress}
    >
      {children}
    </Button>
  )
}

/** A filter chip: a badge wearing a button, as the display options' are. */
function FilterChip({
  pressed,
  onPress,
  dotClass,
  children,
}: {
  pressed: boolean
  onPress(): void
  dotClass?: string
  children: string
}) {
  return (
    <Badge asChild variant={pressed ? 'secondary' : 'outline'}>
      <button type="button" aria-pressed={pressed} onClick={onPress} className="cursor-pointer">
        {dotClass !== undefined && (
          <span aria-hidden="true" className={cn('size-1.5 shrink-0 rounded-full', dotClass)} />
        )}
        {children}
      </button>
    </Badge>
  )
}

/** The ⚙ panel: grouping and ordering, nothing else worth a control yet. */
function AgentDisplayOptions({
  view,
  onChange,
}: {
  view: AgentViewConfig
  onChange(view: AgentViewConfig): void
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="icon" aria-label="Display options">
          <AdjustmentsHorizontalIcon aria-hidden="true" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" aria-label="Display options" className="w-72">
        <AgentChoice
          label="Grouping"
          value={view.grouping}
          options={AGENT_GROUPINGS}
          labels={AGENT_GROUPING_LABELS}
          onPick={(grouping) => onChange({ ...view, grouping })}
        />
        <AgentChoice
          label="Ordering"
          value={view.ordering}
          options={AGENT_ORDERINGS}
          labels={AGENT_ORDERING_LABELS}
          onPick={(ordering) => onChange({ ...view, ordering })}
        />
      </PopoverContent>
    </Popover>
  )
}

/** One labelled select over a fixed set of words — DisplayOptions' shape. */
function AgentChoice<T extends string>({
  label,
  value,
  options,
  labels,
  onPick,
}: {
  label: string
  value: T
  options: readonly T[]
  labels: Record<T, string>
  onPick(value: T): void
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-muted-foreground">{label}</span>
      <Select value={value} onValueChange={(next) => onPick(next as T)}>
        <SelectTrigger size="sm" aria-label={label} className="w-40">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option} value={option}>
              {labels[option]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}

/**
 * The results presentation: hits folded into per-session runs, each headed by
 * what identifies the session, each hit a link that lands the viewer on the
 * matched line.
 */
function SearchResults({ q, results }: { q: string; results: SearchState | null }) {
  if (results === null || results.at === 'loading') return <AgentSkeleton />
  const groups = groupHits(results.hits)
  return (
    <div className="flex flex-col gap-y-4">
      {results.building && (
        <p className="rounded-md bg-row-hover px-3 py-2 text-base/6 text-zinc-500 sm:text-sm/6 dark:text-zinc-400">
          Some machines are still indexing, so results may be partial.
        </p>
      )}

      {groups.length === 0 ? (
        <p className="text-base/6 text-zinc-500 sm:text-sm/6 dark:text-zinc-400">
          No matches for &ldquo;{q}&rdquo;.
        </p>
      ) : (
        groups.map((g) => (
          <section key={g.key} className="flex flex-col">
            <div className="flex min-w-0 items-center gap-x-2 px-2 py-1">
              <ToolDot tool={g.tool} />
              <h2 className="min-w-0 truncate text-control font-medium text-zinc-950 dark:text-white">
                {g.title || basenameOf(g.cwd) || g.id}
              </h2>
              <Badge variant="outline" className="text-zinc-500 dark:text-zinc-400">
                {g.machineName || g.machineId}
              </Badge>
              {g.ts !== undefined && (
                <span className="ml-auto shrink-0 text-xs text-zinc-500 tabular-nums dark:text-zinc-400">
                  {since(g.ts)}
                </span>
              )}
            </div>
            <ul role="list" className="mt-1 flex flex-col">
              {/* Keyed past the offset alone: one line can match twice — two
                  messages share the line's offset — and hits stay in file
                  order, so the index disambiguates without reordering risk. */}
              {g.hits.map((h, i) => (
                <li key={`${h.tool}:${h.id}:${h.offset}:${i}`}>
                  <Link
                    to={VIEWER_PATH}
                    params={{ machineId: h.machineId, tool: h.tool, sessionId: h.id }}
                    search={{ at: h.offset }}
                    className="flex min-w-0 items-baseline gap-x-2 rounded-md px-2 py-1.5 outline-none hover:bg-row-hover focus-visible:outline-2 focus-visible:-outline-offset-1 focus-visible:outline-ring active:bg-row-press"
                  >
                    <span className="shrink-0 text-xs text-zinc-500 dark:text-zinc-400">
                      {h.role}
                    </span>
                    <Snippet snippet={h.snippet} q={q} />
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ))
      )}

      {results.truncated && (
        <p className="text-base/6 text-zinc-500 sm:text-sm/6 dark:text-zinc-400">
          More matches than shown; narrow the query.
        </p>
      )}
    </div>
  )
}

/** The matched span lit, when the snippet visibly contains the query. */
function Snippet({ snippet, q }: { snippet: string; q: string }) {
  const parts = splitSnippet(snippet, q)
  if (parts === null) {
    return <span className="min-w-0 truncate text-sm text-zinc-950 dark:text-white">{snippet}</span>
  }
  return (
    <span className="min-w-0 truncate text-sm text-zinc-950 dark:text-white">
      {parts.before}
      <mark className="rounded-xs bg-accent-bg/20 px-0.5 text-inherit">{parts.match}</mark>
      {parts.after}
    </span>
  )
}

/** A path's last segment, for a hit group with no better name. */
function basenameOf(path: string): string {
  const trimmed = path.replace(/\/+$/, '')
  return trimmed === '' ? '' : trimmed.slice(trimmed.lastIndexOf('/') + 1)
}

/**
 * The insights presentation: a range, a stat strip, the activity year, four
 * charts. Every number comes out of agents/view.ts; this renders and nothing
 * else.
 */
function Insights({
  rows,
  filters,
  range,
  onRange,
}: {
  rows: AgentRow[]
  filters: { tools: ReadonlySet<AgentTool>; machines: ReadonlySet<string> }
  range: InsightRange
  onRange(range: InsightRange): void
}) {
  // One memo for all of the arithmetic, keyed on what actually changes: the
  // fleet re-emits every few seconds and re-renders this route, and a fresh
  // Date.now() per render was minting brand-new chart arrays each time —
  // which Recharts read as new data and re-animated, so the rank labels
  // blinked every poll. The clock is sampled when the inputs change, not
  // when React happens to run.
  const { everything, ranged, totals, tokens, sessions, projects, models, heat, usage } =
    useMemo(() => {
      const now = Date.now()
      const everything = filterRows(rows, filters)
      const ranged = rangeFilter(everything, range, now)
      return {
        everything,
        ranged,
        totals: insightTotals(ranged),
        tokens: tokensByDay(ranged, now),
        sessions: sessionsByDay(ranged, now),
        projects: byProject(ranged),
        models: byModel(ranged),
        // The Activity section — heatmap and streaks — is computed from ALL
        // rows regardless of the 7d/30d/90d/All range chips: a year of
        // context is the section's whole point. The chips keep driving the
        // stat strip and the day charts.
        heat: heatmapWeeks(everything, now),
        usage: usageStats(everything, now),
      }
    }, [rows, filters, range])

  const stats: Array<{ label: string; value: string }> = [
    { label: 'Sessions', value: String(totals.sessions) },
    { label: 'Input tokens', value: compactTokens(totals.input) },
    { label: 'Output tokens', value: compactTokens(totals.output) },
    { label: 'Cache read', value: compactTokens(totals.cacheRead) },
  ]
  if (totals.costUsd !== null) {
    stats.push({ label: 'Recorded cost', value: compactCost(totals.costUsd) })
  }

  // The quiet label/value rows beside the heatmap; a row whose value would
  // read as null or zero is left out rather than printed empty.
  const days = (n: number) => `${n} ${n === 1 ? 'day' : 'days'}`
  const usageRows: Array<{ label: string; value: string }> = []
  if (usage.activeDays > 0) {
    usageRows.push({ label: 'Active days', value: `${usage.activeDays} of ${usage.spanDays}` })
  }
  if (usage.longestStreak > 0) {
    usageRows.push({ label: 'Longest streak', value: days(usage.longestStreak) })
  }
  if (usage.currentStreak > 0) {
    usageRows.push({ label: 'Current streak', value: days(usage.currentStreak) })
  }
  if (usage.mostActiveDay !== null) {
    usageRows.push({ label: 'Most active day', value: usage.mostActiveDay })
  }
  if (usage.favoriteModel !== null) {
    usageRows.push({ label: 'Favorite model', value: usage.favoriteModel })
  }
  if (usage.longestSessionMs > 0) {
    usageRows.push({ label: 'Longest session', value: fmtDuration(usage.longestSessionMs) })
  }

  // One centred, bounded column carries the whole story in reading order —
  // the year of activity, then the numbers, then the charts. Unbounded, the
  // page kept growing a dead right margin on wide screens: every block set
  // its own width and none agreed.
  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-y-10">
      <div role="group" aria-label="Range" className="flex items-center gap-1.5">
        {INSIGHT_RANGES.map((r) => (
          <FilterChip key={r} pressed={range === r} onPress={() => onRange(r)}>
            {INSIGHT_RANGE_LABELS[r]}
          </FilterChip>
        ))}
      </div>

      {ranged.length === 0 && (
        <p className="text-base/6 text-zinc-500 sm:text-sm/6 dark:text-zinc-400">
          No agent activity in this range.
        </p>
      )}

      {ranged.length > 0 && (
        <div className="@container">
          {/* Cards rather than a ruled strip: each figure is an independent
              claim, and on the dark canvas the panel-plus-inset-ring is what
              gives the row a shape the hairlines never quite did. */}
          <dl
            className={cn(
              'grid grid-cols-2 gap-3',
              stats.length === 5 ? '@2xl:grid-cols-5' : '@2xl:grid-cols-4',
            )}
          >
            {stats.map((stat) => (
              // Reversed visually: the value reads above its label, while
              // the markup keeps dt before dd as a dl requires.
              <div
                key={stat.label}
                className="flex flex-col-reverse gap-y-0.5 rounded-xl border border-hairline bg-card px-4 py-3.5 shadow-low dark:shadow-none dark:inset-ring dark:inset-ring-white/5"
              >
                <dt className="truncate text-control text-muted-foreground">{stat.label}</dt>
                <dd className="text-2xl font-semibold tracking-tight text-zinc-950 tabular-nums dark:text-white">
                  {stat.value}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      )}

      {everything.length > 0 && <ActivitySection heat={heat} usageRows={usageRows} />}

      {ranged.length > 0 && (
        <div className="@container">
          <div className="flex flex-col gap-y-10">
            <div className="flex min-w-0 flex-col gap-y-2">
              <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
                <h3 className="text-sm font-medium text-zinc-950 dark:text-white">
                  Tokens per day
                </h3>
                <span className="flex items-center gap-x-3">
                  {AGENT_TOOLS.map((tool) => (
                    <span
                      key={tool}
                      className="flex items-center gap-x-1.5 text-control text-muted-foreground"
                    >
                      <span
                        aria-hidden="true"
                        className={cn('size-1.5 shrink-0 rounded-full', TOOL_DOT_BG[tool])}
                      />
                      {TOOL_LABELS[tool]}
                    </span>
                  ))}
                </span>
              </div>
              <ToolDayChart
                label="Tokens per day, by tool"
                format={compactTokens}
                data={tokens.map((d) => ({ label: d.label, ...d.byTool }))}
              />
            </div>

            <div className="flex min-w-0 flex-col gap-y-2">
              <h3 className="text-sm font-medium text-zinc-950 dark:text-white">
                Sessions per day
              </h3>
              {/* The same tool bands as the tokens chart beside it — one
                  legend serves both — with the y scale in plain counts. */}
              <ToolDayChart
                label="Sessions per day, by tool"
                format={(n) => String(Math.round(n))}
                data={sessions.map((d) => ({ label: d.label, ...d.byTool }))}
              />
            </div>

            <div className="flex min-w-0 flex-col gap-y-2">
              <h3 className="text-sm font-medium text-zinc-950 dark:text-white">Top projects</h3>
              <RankChart
                label="Top projects by tokens"
                rows={projects.map((p) => ({
                  key: p.cwd,
                  label: p.label,
                  title: p.cwd,
                  value: p.tokens,
                }))}
              />
            </div>

            <div className="flex min-w-0 flex-col gap-y-2">
              <h3 className="text-sm font-medium text-zinc-950 dark:text-white">Models</h3>
              <RankChart
                label="Models by tokens"
                rows={models.map((m) => ({
                  key: m.model,
                  label: shortModel(m.model),
                  title: m.model,
                  value: m.tokens,
                }))}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * The activity year: the heatmap across the full row, then its numbers as a
 * quiet divider-separated strip beneath — the same vocabulary as the big
 * strip at the top of the screen, one step smaller. A side column was tried
 * and flung the numbers to the pane's far edge with a gulf between; as a
 * footer the stats read as a caption to the year, at every width.
 */
function ActivitySection({
  heat,
  usageRows,
}: {
  heat: ReturnType<typeof heatmapWeeks>
  usageRows: Array<{ label: string; value: string }>
}) {
  return (
    <div className="@container">
      <div className="flex flex-col items-center gap-y-5">
        <Heatmap
          label="Activity: tokens per day over the last year"
          weeks={heat.weeks}
          months={heat.months}
        />
        <div className="flex flex-wrap justify-center gap-y-4">
          {usageRows.map((s, at) => (
            <div
              key={s.label}
              className={cn(
                'flex flex-col gap-y-0.5 pr-8',
                at > 0 && 'border-l border-hairline pl-8',
              )}
            >
              <span className="text-sm font-medium text-zinc-950 tabular-nums dark:text-white">
                {s.value}
              </span>
              <span className="truncate text-control text-muted-foreground">{s.label}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

