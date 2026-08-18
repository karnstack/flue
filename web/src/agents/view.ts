/*
 * What the agents screen shows, worked out with nothing on screen.
 *
 * Every question the agents browser asks of its rows — which of them the chip
 * filters admit, what sequence they read in, where the headings fall, what the
 * insights add up to — is answered here, by functions that take an array and
 * return one. No React, no storage, and no ambient clock: everything that
 * reads time takes `now` as an argument, so the same rows and the same instant
 * give the same answer twice, which is what lets the whole of it be pinned by
 * cheap unit tests instead of by rendering a screen and squinting at it.
 *
 * The split with the components above mirrors sessions/view.ts, and for the
 * same reason: a row's markup should be able to change without touching a
 * single arrangement rule, and an arrangement rule should be arguable without
 * reading any markup at all.
 */
import type {
  AgentHistoryDay,
  AgentHit,
  AgentMessage,
  AgentSummary,
  AgentTool,
} from '@/client/protocol'

/**
 * One transcript stamped with the machine whose disk it lives on. The stamp is
 * this side's, exactly as FleetSession's is: no daemon knows the browser holds
 * several of it side by side, and `machineName` rides every row because the
 * screen groups and labels by it constantly.
 */
export interface AgentRow extends AgentSummary {
  machineId: string
  machineName: string
}

/** A search hit stamped the same way, so a click knows which machine to ask. */
export interface AgentHitRow extends AgentHit {
  machineId: string
  machineName: string
}

/**
 * One backfill day stamped with its machine, exactly as AgentRow is. The
 * merge with the transcript rows is per (machine, tool, day) — see
 * mergedSessionCounts — so the stamp is load-bearing, not a label.
 */
export interface HistoryDayRow extends AgentHistoryDay {
  machineId: string
}

/**
 * The three stores the daemon indexes, in the order their chips read. The
 * array is the source and the labels map over it, as sessions/view.ts keeps
 * its unions: a hand-kept second copy would one day be missing the newest
 * member with nothing to say so.
 */
export const AGENT_TOOLS = ['claude', 'codex', 'pi'] as const satisfies readonly AgentTool[]

export const TOOL_LABELS: Record<AgentTool, string> = {
  claude: 'Claude',
  codex: 'Codex',
  pi: 'Pi',
}

/** The ways the list can be cut into headed runs. */
export const AGENT_GROUPINGS = ['day', 'project', 'tool', 'machine'] as const
export type AgentGrouping = (typeof AGENT_GROUPINGS)[number]

export const AGENT_GROUPING_LABELS: Record<AgentGrouping, string> = {
  day: 'Day',
  project: 'Project',
  tool: 'Tool',
  machine: 'Machine',
}

/** The ways the rows can be arranged inside whatever they are grouped by. */
export const AGENT_ORDERINGS = ['recent', 'tokens', 'messages'] as const
export type AgentOrdering = (typeof AGENT_ORDERINGS)[number]

export const AGENT_ORDERING_LABELS: Record<AgentOrdering, string> = {
  recent: 'Recent',
  tokens: 'Tokens',
  messages: 'Messages',
}

/** One arrangement of the agents list. */
export interface AgentViewConfig {
  grouping: AgentGrouping
  ordering: AgentOrdering
}

/**
 * The arrangement a browser that has never chosen one gets: by day, newest
 * first, because "what did the agents do today" is the first question this
 * screen answers. Frozen for DEFAULT_VIEW's reason in sessions/view.ts — one
 * shared object, and an edit against it would rewrite the default for every
 * screen until reload.
 */
export const DEFAULT_AGENT_VIEW: AgentViewConfig = Object.freeze<AgentViewConfig>({
  grouping: 'day',
  ordering: 'recent',
})

/**
 * A row's identity across the whole screen. The id alone will not do — two
 * machines index each other's nothing, and two tools may mint the same
 * filename — so machine and tool both qualify it.
 */
export const rowKey = (r: AgentRow) => `${r.machineId}/${r.tool}/${r.id}`

/**
 * What to call a transcript, from the best evidence it has: a title somebody
 * or something set, else the first thing the user asked, else the tool's own
 * id — always present, never informative, but honest.
 */
export function displayTitle(r: Pick<AgentRow, 'title' | 'firstPrompt' | 'id'>): string {
  return r.title || r.firstPrompt || r.id
}

/** The last segment of a path, with `/` naming itself and `''` naming nothing. */
export function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, '')
  if (trimmed === '') return path === '' ? '' : '/'
  return trimmed.slice(trimmed.lastIndexOf('/') + 1)
}

/**
 * A model id cut down to the part a person says out loud. Provider prefixes
 * fall away (`anthropic/claude-x` and `claude-x` are the same claim), the
 * family prefix goes for the one family whose ids all carry it, and a
 * trailing eight-digit date stamp is versioning nobody reads in a row.
 */
export function shortModel(model: string): string {
  return model
    .slice(model.lastIndexOf('/') + 1)
    .replace(/^claude-/, '')
    .replace(/-\d{8}$/, '')
}

/** The model a row's badge shows: the last one the session touched. */
export function latestModel(r: Pick<AgentRow, 'models'>): string | null {
  return r.models.length === 0 ? null : r.models[r.models.length - 1]!
}

/**
 * The token figure a row and the charts agree on: input plus output. Cache
 * reads are excluded on purpose — a long Claude session re-reads its own
 * context thousands of times over, and a figure they dominated would say
 * "how long has this run" rather than "how much work was done". The cache
 * buckets keep their own columns on the insights strip.
 */
export function rowTokens(r: Pick<AgentRow, 'tokens'>): number {
  return r.tokens.input + r.tokens.output
}

/**
 * A count in the coarsest unit that still says something: 850, 9.9K, 12K,
 * 1.2M. One decimal below ten of a unit, none above — 12.4K reads as false
 * precision at the widths these are printed in.
 */
export function compactTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0'
  if (n < 1000) return String(Math.round(n))
  for (const { div, mark } of [
    { div: 1e9, mark: 'B' },
    { div: 1e6, mark: 'M' },
    { div: 1e3, mark: 'K' },
  ]) {
    const v = n / div
    // 0.9995 rather than 1, so 999_999 says 1M rather than the 1000K a naive
    // threshold prints on its way past the unit boundary.
    if (v < 0.9995) continue
    return (v >= 9.95 ? String(Math.round(v)) : (Math.round(v * 10) / 10).toString()) + mark
  }
  return String(Math.round(n))
}

/**
 * A recorded cost, in dollars: $0.42, $12.30, $123. Two decimals while cents
 * are legible, whole dollars once they are noise.
 */
export function compactCost(usd: number): string {
  if (!Number.isFinite(usd) || usd < 0) return '$0.00'
  return usd < 100 ? `$${usd.toFixed(2)}` : `$${Math.round(usd)}`
}

/**
 * The rows the chip filters admit, in the order they arrived. An empty set is
 * "All" — no narrowing — rather than "none", because the chips toggle members
 * and an emptied selection means the reader turned everything off, which as a
 * filter would show a blank screen with every chip lit off.
 */
export function filterRows(
  rows: AgentRow[],
  opts: { tools?: ReadonlySet<AgentTool>; machines?: ReadonlySet<string> } = {},
): AgentRow[] {
  const { tools, machines } = opts
  return rows.filter(
    (r) =>
      (tools === undefined || tools.size === 0 || tools.has(r.tool)) &&
      (machines === undefined || machines.size === 0 || machines.has(r.machineId)),
  )
}

/** How coarsely `endedAt` is read, for orderSessions' reason: transcripts a
 *  poll re-reports must not swap places under the pointer. */
const RECENT_BUCKET_MS = 30_000

const DAY_MS = 86_400_000

/** Which half-minute a transcript last moved in. NaN for an unreadable stamp,
 *  which every comparison treats as a tie. */
function recentBucket(r: AgentRow): number {
  const at = Date.parse(r.endedAt)
  return Math.floor((Number.isNaN(at) ? Date.parse(r.startedAt) : at) / RECENT_BUCKET_MS)
}

const COMPARE: Record<AgentOrdering, (a: AgentRow, b: AgentRow) => number> = {
  recent: (a, b) => recentBucket(b) - recentBucket(a),
  tokens: (a, b) => rowTokens(b) - rowTokens(a),
  messages: (a, b) => b.messageCount - a.messageCount,
}

/**
 * The rows in reading order: the chosen key, then cwd and id to hold the
 * remainder still. The tiebreak is inherited from orderSessions along with
 * its reason — a NaN from two unreadable stamps is falsy, so no row can
 * vanish into a comparison that failed.
 */
export function orderRows(rows: AgentRow[], ordering: AgentOrdering): AgentRow[] {
  const by = COMPARE[ordering]
  return [...rows].sort(
    (a, b) => by(a, b) || a.cwd.localeCompare(b.cwd) || a.id.localeCompare(b.id),
  )
}

/** A run of rows under one heading, exactly sessions/view.ts's shape. */
export interface AgentGroup {
  key: string
  label: string
  rows: AgentRow[]
}

/** The local start of the day `ms` falls in. Local rather than UTC because
 *  "Today" is a claim about the reader's calendar, not the meridian's. */
export function dayStartMs(ms: number): number {
  const d = new Date(ms)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** `Aug 12`, with the year on when it is not this year's. Exported for the
 *  heatmap's hover sentences, which name days a year back without a clock. */
export function monthDay(dayMs: number, now?: number): string {
  const d = new Date(dayMs)
  const base = `${MONTHS[d.getMonth()]} ${d.getDate()}`
  if (now !== undefined && d.getFullYear() !== new Date(now).getFullYear()) {
    return `${base}, ${d.getFullYear()}`
  }
  return base
}

/**
 * What a day's heading says: Today, Yesterday, a weekday for the rest of the
 * week, a date beyond it. Fixed English names rather than the locale's, as
 * `ago` fixes its own units — two screens describing the same instant must
 * not disagree by locale.
 */
export function dayLabel(dayMs: number, now: number): string {
  const today = dayStartMs(now)
  if (dayMs === today) return 'Today'
  // Rounded rather than divided exactly, so a daylight-saving hour cannot
  // make yesterday read as two days ago.
  const d = new Date(dayMs)
  const daysApart = Math.round((today - dayMs) / DAY_MS)
  if (daysApart === 1) return 'Yesterday'
  if (daysApart > 1 && daysApart < 7) return WEEKDAYS[d.getDay()]!
  return monthDay(dayMs, now)
}

/**
 * The stamp a row's day heading buckets on: when the transcript last moved.
 * The same stamp Recent orders by, so the headings and the order inside them
 * cannot point in different directions. Null for a row with no readable
 * stamp at all, which lands under one Undated heading at the very end.
 */
function rowDay(r: AgentRow): number | null {
  const at = Date.parse(r.endedAt)
  const fallback = Number.isNaN(at) ? Date.parse(r.startedAt) : at
  return Number.isNaN(fallback) ? null : dayStartMs(fallback)
}

interface Bucket {
  key: string
  label: string
  rank: number
}

/**
 * The rows cut into headed runs. A cut and never a re-sort, for
 * groupSessions' reason: rows keep the order they were handed inside each
 * run, so a caller that ordered first gets that order honoured under every
 * heading. Only groups with something in them are returned.
 */
export function groupRows(rows: AgentRow[], grouping: AgentGrouping, now: number): AgentGroup[] {
  const bucketOf = (r: AgentRow): Bucket => {
    switch (grouping) {
      case 'day': {
        const day = rowDay(r)
        if (day === null) return { key: 'day:none', label: 'Undated', rank: Number.MAX_SAFE_INTEGER }
        // Newest day first: the rank is the day's distance into the past.
        return { key: `day:${day}`, label: dayLabel(day, now), rank: -day }
      }
      case 'project':
        return { key: `dir:${r.cwd}`, label: basename(r.cwd) || r.cwd, rank: 0 }
      case 'tool':
        return { key: `tool:${r.tool}`, label: TOOL_LABELS[r.tool], rank: AGENT_TOOLS.indexOf(r.tool) }
      case 'machine':
        return { key: `machine:${r.machineId}`, label: r.machineName || r.machineId, rank: 0 }
    }
  }
  const found = new Map<string, Bucket & { rows: AgentRow[] }>()
  for (const r of rows) {
    const bucket = bucketOf(r)
    const already = found.get(bucket.key)
    if (already) already.rows.push(r)
    else found.set(bucket.key, { ...bucket, rows: [r] })
  }
  return [...found.values()]
    .sort(
      (a, b) => a.rank - b.rank || a.label.localeCompare(b.label) || a.key.localeCompare(b.key),
    )
    .map(({ key, label, rows: members }) => ({ key, label, rows: members }))
}

/**
 * The whole pipeline, in the one direction it runs: chip filters, then the
 * order, then the cut into headed runs. One function so no caller re-derives
 * the sequence. Tombstones — summaries whose transcript the tool has pruned
 * — are dropped here and only here: the list is the openable transcripts,
 * and a row that cannot open is a broken promise; the insights, which they
 * still count toward, take the unfiltered rows.
 */
export function applyAgentView(
  rows: AgentRow[],
  view: AgentViewConfig,
  filters: { tools?: ReadonlySet<AgentTool>; machines?: ReadonlySet<string> },
  now: number,
): AgentGroup[] {
  const openable = rows.filter((r) => !r.missing)
  return groupRows(orderRows(filterRows(openable, filters), view.ordering), view.grouping, now)
}

// ---------------------------------------------------------------------------
// Insights.

export const INSIGHT_RANGES = ['7d', '30d', '90d', 'all'] as const
export type InsightRange = (typeof INSIGHT_RANGES)[number]

export const INSIGHT_RANGE_LABELS: Record<InsightRange, string> = {
  '7d': '7d',
  '30d': '30d',
  '90d': '90d',
  all: 'All',
}

const RANGE_DAYS: Record<Exclude<InsightRange, 'all'>, number> = {
  '7d': 7,
  '30d': 30,
  '90d': 90,
}

/**
 * The rows a range admits, by when they started — the insights' own stamp,
 * per the daemon's attribution: a session belongs to the day it began. `7d`
 * means today and the six days before it, counted on the calendar rather
 * than in hours, so a chip pressed at 9am and at 11pm draws the same chart.
 */
export function rangeFilter(rows: AgentRow[], range: InsightRange, now: number): AgentRow[] {
  if (range === 'all') return [...rows]
  const from = shiftDay(dayStartMs(now), -(RANGE_DAYS[range] - 1))
  return rows.filter((r) => {
    const at = Date.parse(r.startedAt)
    return !Number.isNaN(at) && at >= from && at <= now
  })
}

/**
 * The local start of the day a backfill date names. The date is a bare
 * YYYY-MM-DD in the serving machine's calendar; read in the viewer's, the
 * honest simplification every cross-machine day bucket here already makes.
 * The one sharp edge: a viewer in a different timezone can land a backfill
 * day beside the indexed day it describes, and the max-merge then counts
 * both — a same-sessions double count across midnight, bounded to the two
 * days either side of the offset. Accepted for the same reason the bucketing
 * is: a per-machine timezone negotiation would cost far more than one
 * boundary day's drift. NaN for a date that will not parse, which every
 * consumer skips.
 */
export function historyDayMs(date: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
  if (m === null) return Number.NaN
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime()
}

/** The backfill days the chip filters admit — filterRows for HistoryDayRow. */
export function filterHistory(
  history: HistoryDayRow[],
  opts: { tools?: ReadonlySet<AgentTool>; machines?: ReadonlySet<string> } = {},
): HistoryDayRow[] {
  const { tools, machines } = opts
  return history.filter(
    (h) =>
      (tools === undefined || tools.size === 0 || tools.has(h.tool)) &&
      (machines === undefined || machines.size === 0 || machines.has(h.machineId)),
  )
}

/** The backfill days a range admits — rangeFilter for HistoryDayRow. */
export function rangeFilterHistory(
  history: HistoryDayRow[],
  range: InsightRange,
  now: number,
): HistoryDayRow[] {
  const today = dayStartMs(now)
  const from = range === 'all' ? Number.NEGATIVE_INFINITY : shiftDay(today, -(RANGE_DAYS[range] - 1))
  return history.filter((h) => {
    const day = historyDayMs(h.date)
    return !Number.isNaN(day) && day >= from && day <= today
  })
}

/**
 * Sessions per (machine, tool, day), transcripts and backfill merged by
 * taking the larger of the two claims for each key. Larger, not summed: on a
 * day both witness, the backfill's count and the indexed count are the same
 * sessions told twice — the backfill even counts stubs the index hides, so
 * it may honestly say more — while summing would bill every session double.
 * Rows with no readable start stamp merge with nothing and are counted as
 * themselves under one NaN key per machine and tool.
 */
function mergedSessionCounts(rows: AgentRow[], history: HistoryDayRow[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const r of rows) {
    const at = Date.parse(r.startedAt)
    const day = Number.isNaN(at) ? 'undated' : String(dayStartMs(at))
    const key = mergeKey(r.machineId, r.tool, day)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  for (const h of history) {
    const day = historyDayMs(h.date)
    if (Number.isNaN(day)) continue
    const key = mergeKey(h.machineId, h.tool, String(day))
    counts.set(key, Math.max(counts.get(key) ?? 0, h.sessions))
  }
  return counts
}

/** A merge key whose tool and day always read back out — the machine id is
 *  user-adjacent text and may hold the separator, so it goes last-resistant:
 *  splitMergeKey parses from the right. */
function mergeKey(machineId: string, tool: AgentTool, day: string): string {
  return `${machineId}|${tool}|${day}`
}

function splitMergeKey(key: string): { tool: AgentTool; day: string } {
  const parts = key.split('|')
  const day = parts.pop()!
  const tool = parts.pop() as AgentTool
  return { tool, day }
}

/** The merged session total — mergedSessionCounts, summed. */
export function mergedSessions(rows: AgentRow[], history: HistoryDayRow[]): number {
  let total = 0
  for (const n of mergedSessionCounts(rows, history).values()) total += n
  return total
}

/** The day `days` calendar days away from `dayMs`, DST-proof. */
function shiftDay(dayMs: number, days: number): number {
  const d = new Date(dayMs)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + days).getTime()
}

/** What the stat strip says about a set of rows. `costUsd` is null when no
 *  row records one, which is how the screen knows to drop the column whole. */
export interface InsightTotals {
  sessions: number
  input: number
  output: number
  cacheRead: number
  costUsd: number | null
}

export function insightTotals(rows: AgentRow[], history: HistoryDayRow[] = []): InsightTotals {
  let input = 0
  let output = 0
  let cacheRead = 0
  let costUsd: number | null = null
  for (const r of rows) {
    input += r.tokens.input
    output += r.tokens.output
    cacheRead += r.tokens.cacheRead
    if (r.costUsd !== undefined) costUsd = (costUsd ?? 0) + r.costUsd
  }
  // Sessions merge with the backfill; the token figures cannot — the
  // aggregates behind the backfill fold cache reads into one number, a
  // different measurement — so they stay the transcripts' own and read as
  // "at least" for any span the backfill extends.
  return { sessions: mergedSessions(rows, history), input, output, cacheRead, costUsd }
}

/** One day of the stacked chart: tokens per tool, on the session's start day. */
export interface TokensDayPoint {
  dayMs: number
  label: string
  byTool: Record<AgentTool, number>
  total: number
}

/** One day of the sessions chart: how many began, and whose they were. */
export interface SessionsDayPoint {
  dayMs: number
  label: string
  byTool: Record<AgentTool, number>
  count: number
}

/** The widest day chart drawn, whatever the data claims. One day one bar
 *  means the array below becomes DOM, and a single session wearing a bogus
 *  ancient stamp (a zero time serialises as year 1) would otherwise ask for
 *  hundreds of thousands of bars and hang the tab. A year is also simply the
 *  most a per-day chart can say before the bars are hairlines. */
const DAY_SPAN_CAP = 366

/** The continuous run of days from the earliest row or backfill day to
 *  `now`, zero-filled — a chart with the quiet days missing would lie about
 *  the pace — and capped at DAY_SPAN_CAP days ending today. Days before the
 *  window still count in the stat strip; they just fall off the left edge of
 *  the chart. */
function daySpan(rows: AgentRow[], history: HistoryDayRow[], now: number): number[] {
  let first = Number.POSITIVE_INFINITY
  for (const r of rows) {
    const at = Date.parse(r.startedAt)
    if (!Number.isNaN(at)) first = Math.min(first, dayStartMs(at))
  }
  for (const h of history) {
    const day = historyDayMs(h.date)
    if (!Number.isNaN(day)) first = Math.min(first, day)
  }
  if (!Number.isFinite(first)) return []
  const last = dayStartMs(now)
  first = Math.max(first, shiftDay(last, -(DAY_SPAN_CAP - 1)))
  const days: number[] = []
  for (let day = first; day <= last; day = shiftDay(day, 1)) days.push(day)
  return days
}

export function tokensByDay(
  rows: AgentRow[],
  now: number,
  history: HistoryDayRow[] = [],
): TokensDayPoint[] {
  const points = new Map<number, Record<AgentTool, number>>()
  for (const r of rows) {
    const at = Date.parse(r.startedAt)
    if (Number.isNaN(at)) continue
    const day = dayStartMs(at)
    const point = points.get(day) ?? { claude: 0, codex: 0, pi: 0 }
    point[r.tool] += rowTokens(r)
    points.set(day, point)
  }
  // The backfill widens the span but never the bars: it has no token figure
  // in the transcripts' measurement, so its days chart as quiet — visible,
  // zero, honest.
  return daySpan(rows, history, now).map((day) => {
    const byTool = points.get(day) ?? { claude: 0, codex: 0, pi: 0 }
    return {
      dayMs: day,
      label: monthDay(day),
      byTool,
      total: byTool.claude + byTool.codex + byTool.pi,
    }
  })
}

export function sessionsByDay(
  rows: AgentRow[],
  now: number,
  history: HistoryDayRow[] = [],
): SessionsDayPoint[] {
  // Per machine and tool first, so the merge with the backfill is the
  // per-key larger-of-two that mergedSessionCounts defines, then summed
  // across machines per day for the chart.
  const merged = mergedSessionCounts(rows, history)
  const counts = new Map<number, Record<AgentTool, number>>()
  for (const [key, n] of merged) {
    const { tool, day } = splitMergeKey(key)
    const dayMs = Number(day)
    if (!Number.isFinite(dayMs)) continue
    const point = counts.get(dayMs) ?? { claude: 0, codex: 0, pi: 0 }
    point[tool] += n
    counts.set(dayMs, point)
  }
  return daySpan(rows, history, now).map((day) => {
    const byTool = counts.get(day) ?? { claude: 0, codex: 0, pi: 0 }
    return {
      dayMs: day,
      label: monthDay(day),
      byTool,
      count: byTool.claude + byTool.codex + byTool.pi,
    }
  })
}

/** The projects that spent the most, largest first, at most `top` of them. */
export function byProject(
  rows: AgentRow[],
  top = 8,
): Array<{ cwd: string; label: string; tokens: number }> {
  const spent = new Map<string, number>()
  for (const r of rows) spent.set(r.cwd, (spent.get(r.cwd) ?? 0) + rowTokens(r))
  return [...spent.entries()]
    .map(([cwd, tokens]) => ({ cwd, label: basename(cwd) || cwd, tokens }))
    .sort((a, b) => b.tokens - a.tokens || a.label.localeCompare(b.label) || a.cwd.localeCompare(b.cwd))
    .slice(0, top)
}

/**
 * Token spend per model, largest first. A session's whole figure lands on its
 * latest model — the accounting is per session, not per line, so this is an
 * attribution rather than a measurement, and the latest model is the one the
 * session settled on. Sessions naming no model at all are left out.
 */
export function byModel(rows: AgentRow[]): Array<{ model: string; tokens: number }> {
  const spent = new Map<string, number>()
  for (const r of rows) {
    const model = latestModel(r)
    if (model === null) continue
    spent.set(model, (spent.get(model) ?? 0) + rowTokens(r))
  }
  return [...spent.entries()]
    .map(([model, tokens]) => ({ model, tokens }))
    .sort((a, b) => b.tokens - a.tokens || a.model.localeCompare(b.model))
}

// ---------------------------------------------------------------------------
// Activity heatmap and streaks.

/** One day square of the activity heatmap. */
export interface HeatCell {
  dayMs: number
  /** Input plus output of the sessions that began this day, rowTokens' figure. */
  tokens: number
  /** 0 for a quiet day; 1 to 4 for an active day, per heatmapWeeks' quartiles. */
  level: number
  /** Marks a day the calendar has not reached, which draws as nothing. */
  future?: boolean
}

/** A month heading over the heatmap: the week column it first holds. */
export interface HeatMonth {
  week: number
  label: string
}

/** How many complete weeks the heatmap reaches back past the current one: a
 *  year of squares, the span the contribution graphs it echoes settled on. */
const HEAT_WEEKS_BACK = 52

/** The closest two month labels may sit, in week columns — nearer than three
 *  and the shorter names overprint each other at the size they are drawn. */
const MONTH_LABEL_MIN_GAP = 3

/** The Monday-first weekday index of the day `ms` falls in. */
function mondayIndex(ms: number): number {
  return (new Date(ms).getDay() + 6) % 7
}

/**
 * The activity heatmap's cells: the last 52 full weeks plus the current
 * partial one, column-major — one array per week, seven cells Monday first —
 * ending today, with the current week's remaining days marked `future`.
 * Tokens land on the day a session began, the attribution every insight on
 * this screen shares.
 *
 * Levels are quartiles by rank among the active days (the empirical CDF),
 * not fractions of the maximum: token totals are wildly skewed — one long
 * session can dwarf a month — so thresholds cut from the values' range would
 * paint almost every active day in the faintest tint. Ranked, the busiest
 * quarter of days is always darkest, equal totals share a level, and the
 * lone-active-day case reads full strength rather than faint.
 *
 * A bogus ancient stamp (a zero time serialises as year 1) costs one range
 * check here: the window is bounded by construction, 53 columns and no more,
 * and days outside it are never aggregated, let alone walked to.
 */
export function heatmapWeeks(
  rows: AgentRow[],
  now: number,
  history: HistoryDayRow[] = [],
): { weeks: HeatCell[][]; months: HeatMonth[] } {
  const today = dayStartMs(now)
  const thisMonday = shiftDay(today, -mondayIndex(today))
  const firstMonday = shiftDay(thisMonday, -HEAT_WEEKS_BACK * 7)

  const tokens = new Map<number, number>()
  for (const r of rows) {
    const at = Date.parse(r.startedAt)
    if (Number.isNaN(at)) continue
    const day = dayStartMs(at)
    if (day < firstMonday || day > today) continue
    tokens.set(day, (tokens.get(day) ?? 0) + rowTokens(r))
  }

  // Days only the backfill witnesses: active, magnitude unknown. They paint
  // at the faintest level rather than blank — a day the tool's own counters
  // remember must not read as a day off — and they stay out of the quartile
  // ranking, which is a ranking of measured token totals.
  const backfilled = new Set<number>()
  for (const h of history) {
    const day = historyDayMs(h.date)
    if (Number.isNaN(day) || day < firstMonday || day > today) continue
    if ((tokens.get(day) ?? 0) > 0) continue
    backfilled.add(day)
  }

  const active = [...tokens.values()].filter((v) => v > 0).sort((a, b) => a - b)
  const levelOf = (t: number): number => {
    if (t <= 0 || active.length === 0) return 0
    let rank = 0
    for (const v of active) {
      if (v > t) break
      rank++
    }
    return Math.min(4, Math.ceil((4 * rank) / active.length))
  }

  const weeks: HeatCell[][] = []
  for (let monday = firstMonday; monday <= thisMonday; monday = shiftDay(monday, 7)) {
    const week: HeatCell[] = []
    for (let i = 0; i < 7; i++) {
      const day = shiftDay(monday, i)
      if (day > today) {
        week.push({ dayMs: day, tokens: 0, level: 0, future: true })
        continue
      }
      const t = tokens.get(day) ?? 0
      const level = backfilled.has(day) ? 1 : levelOf(t)
      week.push({ dayMs: day, tokens: t, level })
    }
    weeks.push(week)
  }

  // A label where a month first holds a week's Monday, unless the previous
  // label sits nearer than the minimum — the window's left edge often changes
  // month within a column or two, and both labels cannot be read.
  const months: HeatMonth[] = []
  let prevMonth = -1
  let lastAt = Number.NEGATIVE_INFINITY
  weeks.forEach((week, col) => {
    const month = new Date(week[0]!.dayMs).getMonth()
    if (month === prevMonth) return
    prevMonth = month
    if (col - lastAt < MONTH_LABEL_MIN_GAP) return
    months.push({ week: col, label: MONTHS[month]! })
    lastAt = col
  })

  return { weeks, months }
}

/** What the activity section says beside the heatmap. */
export interface UsageStats {
  sessions: number
  totalTokens: number
  /** Days on which at least one session began — by either witness, the
   *  transcripts or the backfill — within the same DAY_SPAN_CAP window
   *  spanDays is capped to, so the two always read against each other. */
  activeDays: number
  /** Days from the first session start to today inclusive, capped at
   *  DAY_SPAN_CAP exactly as daySpan caps — the year-1 guard again, so one
   *  broken stamp cannot claim a seven-hundred-thousand-day history. */
  spanDays: number
  /** The start day with the most tokens, `Aug 16` style, ties to the more
   *  recent day. Null when no day earned a token. */
  mostActiveDay: string | null
  /** The model with the most tokens, shortModel'd, or null when no session
   *  names one. byModel's attribution: a session lands on its latest model. */
  favoriteModel: string | null
  /** The longest endedAt minus startedAt over rows whose stamps are sane:
   *  both readable, forward-running, and no longer than the span cap — an
   *  epoch-zero start beside a real end claims a two-thousand-year session,
   *  which is a broken clock, not a record. Zero when nothing qualifies. */
  longestSessionMs: number
  /** The longest run of consecutive active days within the window. */
  longestStreak: number
  /** The run of consecutive active days ending today — or ending yesterday,
   *  which still counts: a streak is not broken by a today that has not had
   *  its first session yet, only by a whole day that passed without one. */
  currentStreak: number
}

/**
 * The heatmap's companion figures. Every walk here is over the set of active
 * days, never the calendar between them: the streak loops touch one member
 * per active day, so the ancient-stamp guard costs a set entry rather than a
 * march from year 1 to now.
 */
export function usageStats(
  rows: AgentRow[],
  now: number,
  history: HistoryDayRow[] = [],
): UsageStats {
  const today = dayStartMs(now)

  let totalTokens = 0
  let longestSessionMs = 0
  const byStartDay = new Map<number, number>()
  for (const r of rows) {
    totalTokens += rowTokens(r)
    const started = Date.parse(r.startedAt)
    if (!Number.isNaN(started)) {
      const day = dayStartMs(started)
      byStartDay.set(day, (byStartDay.get(day) ?? 0) + rowTokens(r))
    }
    const ended = Date.parse(r.endedAt)
    if (!Number.isNaN(started) && !Number.isNaN(ended)) {
      const ms = ended - started
      if (ms > 0 && ms <= DAY_SPAN_CAP * DAY_MS) longestSessionMs = Math.max(longestSessionMs, ms)
    }
  }

  // A day either witness saw is an active day: the calendar facts — active
  // days, span, streaks — take the transcripts and the backfill together,
  // while the token facts (most active day, total) stay the transcripts'
  // own, historyDayMs's reason. Bounded to the same window spanDays is
  // capped to, so "N of M" can never claim more active days than the span
  // it is read against — backfill reaches years back, and unclamped it
  // would print "700 of 366".
  const windowStart = shiftDay(today, -(DAY_SPAN_CAP - 1))
  const activeDaySet = new Set<number>()
  for (const day of byStartDay.keys()) {
    if (day >= windowStart && day <= today) activeDaySet.add(day)
  }
  for (const h of history) {
    const day = historyDayMs(h.date)
    if (!Number.isNaN(day) && day >= windowStart && day <= today) activeDaySet.add(day)
  }

  let first = Number.POSITIVE_INFINITY
  for (const day of activeDaySet) first = Math.min(first, day)
  let spanDays = 0
  if (Number.isFinite(first)) {
    first = Math.max(first, shiftDay(today, -(DAY_SPAN_CAP - 1)))
    // Rounded for dayLabel's reason: a daylight-saving hour must not make a
    // whole day appear or vanish.
    spanDays = Math.max(1, Math.round((today - first) / DAY_MS) + 1)
  }

  let mostDay: number | null = null
  let mostTokens = 0
  for (const [day, t] of byStartDay) {
    if (t > mostTokens || (t === mostTokens && mostDay !== null && t > 0 && day > mostDay)) {
      mostDay = day
      mostTokens = t
    }
  }

  const active = [...activeDaySet].sort((a, b) => a - b)
  let longestStreak = 0
  let run = 0
  let prev: number | null = null
  for (const day of active) {
    run = prev !== null && shiftDay(prev, 1) === day ? run + 1 : 1
    prev = day
    longestStreak = Math.max(longestStreak, run)
  }

  const activeSet = new Set(active)
  let currentStreak = 0
  let cursor = activeSet.has(today) ? today : shiftDay(today, -1)
  while (activeSet.has(cursor)) {
    currentStreak++
    cursor = shiftDay(cursor, -1)
  }

  const models = byModel(rows)
  return {
    sessions: mergedSessions(rows, history),
    totalTokens,
    activeDays: activeDaySet.size,
    spanDays,
    mostActiveDay: mostDay === null ? null : monthDay(mostDay, now),
    favoriteModel: models.length === 0 ? null : shortModel(models[0]!.model),
    longestSessionMs,
    longestStreak,
    currentStreak,
  }
}

/**
 * A duration in the two coarsest units that still say something: `6d 16h`,
 * `5h 12m`, `42m`, and `<1m` below a minute — a third unit would be false
 * precision at the widths these are printed in, exactly compactTokens' case.
 */
export function fmtDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 60_000) return '<1m'
  const minutes = Math.floor(ms / 60_000)
  const hours = Math.floor(minutes / 60)
  const days = Math.floor(hours / 24)
  if (days > 0) return `${days}d ${hours % 24}h`
  if (hours > 0) return `${hours}h ${minutes % 60}m`
  return `${minutes}m`
}

// ---------------------------------------------------------------------------
// Search results.

/** One session's worth of hits, headed by what identifies the session. */
export interface HitGroup {
  key: string
  machineId: string
  machineName: string
  tool: AgentTool
  id: string
  cwd: string
  title?: string
  /** The newest hit's stamp, which is also what the groups sort by. */
  ts?: string
  hits: AgentHitRow[]
}

/**
 * Hits from every machine merged into per-session runs, newest session
 * first — the daemon already answers newest-first per machine, and the merge
 * re-establishes that across them by each group's freshest stamp. Hits
 * inside a group read in file order, which is conversation order.
 */
export function groupHits(hits: AgentHitRow[]): HitGroup[] {
  const found = new Map<string, HitGroup>()
  for (const hit of hits) {
    const key = `${hit.machineId}/${hit.tool}/${hit.id}`
    const group = found.get(key)
    if (group === undefined) {
      found.set(key, {
        key,
        machineId: hit.machineId,
        machineName: hit.machineName,
        tool: hit.tool,
        id: hit.id,
        cwd: hit.cwd,
        title: hit.title,
        ts: hit.ts,
        hits: [hit],
      })
      continue
    }
    group.hits.push(hit)
    group.title ??= hit.title
    if (stamp(hit.ts) > stamp(group.ts)) group.ts = hit.ts
  }
  for (const group of found.values()) group.hits.sort((a, b) => a.offset - b.offset)
  return [...found.values()].sort((a, b) => stamp(b.ts) - stamp(a.ts) || a.key.localeCompare(b.key))
}

/** A stamp as a number, with absence and gibberish reading as oldest. */
function stamp(ts: string | undefined): number {
  if (ts === undefined) return 0
  const at = Date.parse(ts)
  return Number.isNaN(at) ? 0 : at
}

/**
 * Where the query sits in a snippet, for the highlight — a case-insensitive
 * find, matching the daemon's own idea of a match. Null when the query is
 * blank or the snippet does not contain it (a normalised text can differ from
 * its snippet), in which case the snippet renders unmarked rather than
 * wrongly marked.
 */
export function splitSnippet(
  snippet: string,
  query: string,
): { before: string; match: string; after: string } | null {
  const needle = query.trim().toLowerCase()
  if (needle === '') return null
  const at = snippet.toLowerCase().indexOf(needle)
  if (at < 0) return null
  return {
    before: snippet.slice(0, at),
    match: snippet.slice(at, at + needle.length),
    after: snippet.slice(at + needle.length),
  }
}

// ---------------------------------------------------------------------------
// Transcript viewer.

/** One transcript message plus the list key the viewer renders it under. */
export interface KeyedAgentMessage extends AgentMessage {
  key: string
}

/**
 * List keys for one fetched page of messages: `offset:n`, where n counts a
 * run of messages sharing one source line's offset. The offset alone is not
 * an identity — a Pi line carries thinking, text and a tool call at one
 * offset, and a multi-part Claude line does the same — so keyed on offset
 * alone, React keys collide, the virtualizer's measurement cache conflates
 * rows, and per-message state lands on every message of the line at once.
 *
 * Derived per page rather than per loaded window on purpose: the daemon
 * never splits one line's messages across pages, so a run of equal offsets
 * is always whole inside the page that holds it, and the keys a page was
 * given survive every prepend/append join unchanged.
 */
export function keyMessages(msgs: AgentMessage[]): KeyedAgentMessage[] {
  const out: KeyedAgentMessage[] = []
  let last: number | null = null
  let n = 0
  for (const m of msgs) {
    n = m.offset === last ? n + 1 : 0
    last = m.offset
    out.push({ ...m, key: `${m.offset}:${n}` })
  }
  return out
}

/**
 * Whether a "no such transcript" answer deserves another try. On a cold
 * index — a first daemon run, an index format bump — a deep-linked file may
 * simply not be indexed *yet*, so while the machine's index is not known to
 * have settled, the absence is re-asked for a while instead of believed.
 * Only a miss after the index settled, or after the patience budget is
 * spent, means the transcript is really gone.
 */
export function retryMissingTranscript(
  indexSettled: boolean,
  firstMissAt: number,
  now: number,
  budgetMs = 60_000,
): boolean {
  return !indexSettled && now - firstMissAt < budgetMs
}
