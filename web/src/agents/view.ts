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
import type { AgentHit, AgentMessage, AgentSummary, AgentTool } from '@/client/protocol'

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

/** `Aug 12`, with the year on when it is not this year's. */
function monthDay(dayMs: number, now?: number): string {
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
 * the sequence.
 */
export function applyAgentView(
  rows: AgentRow[],
  view: AgentViewConfig,
  filters: { tools?: ReadonlySet<AgentTool>; machines?: ReadonlySet<string> },
  now: number,
): AgentGroup[] {
  return groupRows(orderRows(filterRows(rows, filters), view.ordering), view.grouping, now)
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

export function insightTotals(rows: AgentRow[]): InsightTotals {
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
  return { sessions: rows.length, input, output, cacheRead, costUsd }
}

/** One day of the stacked chart: tokens per tool, on the session's start day. */
export interface TokensDayPoint {
  dayMs: number
  label: string
  byTool: Record<AgentTool, number>
  total: number
}

/** One day of the plain chart: how many sessions began. */
export interface SessionsDayPoint {
  dayMs: number
  label: string
  count: number
}

/** The continuous run of days from the earliest row to `now`, zero-filled —
 *  a chart with the quiet days missing would lie about the pace. */
function daySpan(rows: AgentRow[], now: number): number[] {
  let first = Number.POSITIVE_INFINITY
  for (const r of rows) {
    const at = Date.parse(r.startedAt)
    if (!Number.isNaN(at)) first = Math.min(first, dayStartMs(at))
  }
  if (!Number.isFinite(first)) return []
  const days: number[] = []
  const last = dayStartMs(now)
  for (let day = first; day <= last; day = shiftDay(day, 1)) days.push(day)
  return days
}

export function tokensByDay(rows: AgentRow[], now: number): TokensDayPoint[] {
  const points = new Map<number, Record<AgentTool, number>>()
  for (const r of rows) {
    const at = Date.parse(r.startedAt)
    if (Number.isNaN(at)) continue
    const day = dayStartMs(at)
    const point = points.get(day) ?? { claude: 0, codex: 0, pi: 0 }
    point[r.tool] += rowTokens(r)
    points.set(day, point)
  }
  return daySpan(rows, now).map((day) => {
    const byTool = points.get(day) ?? { claude: 0, codex: 0, pi: 0 }
    return {
      dayMs: day,
      label: monthDay(day),
      byTool,
      total: byTool.claude + byTool.codex + byTool.pi,
    }
  })
}

export function sessionsByDay(rows: AgentRow[], now: number): SessionsDayPoint[] {
  const counts = new Map<number, number>()
  for (const r of rows) {
    const at = Date.parse(r.startedAt)
    if (Number.isNaN(at)) continue
    const day = dayStartMs(at)
    counts.set(day, (counts.get(day) ?? 0) + 1)
  }
  return daySpan(rows, now).map((day) => ({
    dayMs: day,
    label: monthDay(day),
    count: counts.get(day) ?? 0,
  }))
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
