/*
 * What the sessions screen shows, worked out with nothing on screen.
 *
 * Every question the sessions list asks of its rows — which of them the search
 * admits, what order they read in, where the headings fall — is answered here,
 * by functions that take an array and return one. No React, no storage, no
 * clock: give the same rows and the same view twice and the answer is the same
 * twice, which is what lets the whole of it be pinned by cheap unit tests
 * instead of by rendering a screen and squinting at it.
 *
 * The split with the components above is the point. A row's markup should be
 * able to change — a column added, a heading restyled — without touching a
 * single ordering rule, and an ordering rule should be arguable without
 * reading any markup at all. So the components receive `Group[]` and do no
 * arithmetic on it whatsoever.
 *
 * The pipeline runs in one direction and only one: search, then drop what the
 * view does not want, then order, then cut into groups. Grouping last is what
 * makes "pinned first" hold inside every group without a second sort — the
 * groups are carved out of an already-ordered list and keep its order — and it
 * is why a filter can empty a machine's group out of existence rather than
 * leaving a heading over nothing.
 */
import { LOCAL_MACHINE_ID, type FleetSession } from '@/fleet/types'

/**
 * The ways the list can be cut into groups.
 *
 * The array is the source and the union is read off it, rather than the two
 * being written out side by side: this one has to be iterated — the display
 * options offer every choice, and the saved-views store validates against
 * them — and a hand-kept second copy is a copy that will one day be missing
 * the newest member with nothing to say so.
 */
export const GROUPINGS = ['machine', 'state', 'tag', 'directory', 'none'] as const
export type Grouping = (typeof GROUPINGS)[number]

/** The ways the rows can be ordered inside whatever they are grouped by. */
export const ORDERINGS = ['lastActive', 'created', 'name', 'directory'] as const
export type Ordering = (typeof ORDERINGS)[number]

/** Every column the sessions list can show, in the order they read across. */
export const COLUMN_KEYS = [
  'name',
  'directory',
  'machine',
  'tags',
  'state',
  'lastActive',
  'created',
] as const
export type ColumnKey = (typeof COLUMN_KEYS)[number]

/** One arrangement of the sessions list: what is shown, and how it reads. */
export interface ViewConfig {
  grouping: Grouping
  ordering: Ordering
  search: string
  columns: ColumnKey[]
  showExited: boolean
}

/**
 * The arrangement a browser that has never chosen one gets.
 *
 * Grouped by machine because the fleet is the reason this screen was rebuilt —
 * "what is running where" is the first question, and a heading per machine
 * answers it before a single row is read. Ended sessions stay in, because a
 * session that exited three minutes ago with a non-zero code is exactly what
 * someone comes here to find; hiding it by default would make the screen
 * quietly lie about what happened. Every column but the creation time, which
 * is the one people ask for rarely and can turn on.
 */
export const DEFAULT_VIEW: ViewConfig = {
  grouping: 'machine',
  ordering: 'lastActive',
  search: '',
  columns: ['name', 'directory', 'machine', 'tags', 'state', 'lastActive'],
  showExited: true,
}

/**
 * A run of rows under one heading.
 *
 * `key` is for React and for whoever remembers which headings are folded
 * shut; it is prefixed by what produced it, so a tag called `local` and a
 * machine called `local` can never be mistaken for each other. `label` is the
 * text a person reads, and nothing keys off it.
 */
export interface Group {
  key: string
  label: string
  sessions: FleetSession[]
}

/** The heading the sessions with no tags at all end up under. */
const UNTAGGED_KEY = 'untagged'

/** How coarsely `lastActive` is read. See orderSessions. */
const ACTIVE_BUCKET_MS = 30_000

/**
 * What to call a session, from the best evidence it has.
 *
 * Four sources, in falling order of how much a human meant them. A name is
 * what someone deliberately typed, so it outranks everything. A title is what
 * the program inside announced through OSC 0/2 — true, useful, and nobody's
 * choice. The last segment of the working directory is the name people use
 * for a session out loud anyway ("the one in web"). The command is the floor:
 * always there, and always the least informative, since half a fleet is
 * running the same shell.
 *
 * The root directory keeps its own name rather than falling through — every
 * session started at `/` would otherwise be called after its shell — and a
 * session with no directory at all skips the segment entirely.
 */
export function displayName(s: FleetSession): string {
  return s.name || s.title || basename(s.cwd) || s.cmd.join(' ')
}

/** The last segment of a path, with `/` naming itself and `''` naming nothing. */
function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, '')
  if (trimmed === '') return path === '' ? '' : '/'
  return trimmed.slice(trimmed.lastIndexOf('/') + 1)
}

/**
 * The sessions a search admits, in the order they arrived.
 *
 * Substring rather than prefix, and folded to one case on both sides, because
 * the strings being searched are paths and process titles: `flue` should find
 * `/home/karn/code/flue` from the middle of it, and nobody types the leading
 * slash. An empty search — including one that is nothing but the spaces left
 * behind by a half-deleted word — admits everything.
 *
 * What is searched is what the row shows: the name it displays, its directory,
 * its tags, and its machine. A title that lost to a name the user typed is not
 * reachable, deliberately — a search that matched text no row on screen
 * contains produces a result the reader cannot explain.
 */
export function filterSessions(list: FleetSession[], search: string): FleetSession[] {
  const needle = search.trim().toLowerCase()
  if (needle === '') return [...list]
  return list.filter((s) => haystack(s).some((field) => field.toLowerCase().includes(needle)))
}

/** Every string a search is allowed to see, for one session. */
function haystack(s: FleetSession): string[] {
  return [displayName(s), s.cwd, s.machineName, ...s.tags]
}

/**
 * The rows in reading order: pinned first, then by the chosen key, then by
 * directory and id.
 *
 * The tail of that sentence is the load-bearing part, and it is inherited
 * rather than invented. Ordering has to happen somewhere: the daemon answers
 * `list` by ranging over a Go map, which Go randomises on every call, so rows
 * passed straight through would reshuffle on each poll and the row under the
 * reader's pointer would not be the row they clicked.
 *
 * Recency has the same defect by a subtler route. The daemon stamps
 * `lastActive` on every byte written to a pty *and* every chunk read back from
 * one, so a session tailing a log climbs the screen between one poll and the
 * next — deterministic per snapshot, but not stable across them. Hence the
 * bucket: `lastActive` is read to the nearest 30 seconds, so two sessions
 * touched within half a minute of each other are equally recent and neither
 * can overtake the other on a keystroke. Only a genuine half-minute of
 * quiet moves a row.
 *
 * Whatever the bucket cannot separate falls to `cwd` then `id`, and that pair
 * is why the screen sits still. `cwd` is settled when a session is spawned and
 * never written again, so an order resting on it does not move at all; `id`
 * breaks the remainder, since two sessions in one directory is the ordinary
 * case rather than the exotic one. Every other ordering ends the same way for
 * the same reason.
 *
 * Pinning wins over all of it, in both directions: a pinned session sorts to
 * the top and pinned sessions read among themselves by the same key the rest
 * do. A stamp no `Date` can parse compares as a tie rather than as an error,
 * and lands wherever the directory puts it.
 */
export function orderSessions(list: FleetSession[], ordering: Ordering): FleetSession[] {
  const by = COMPARE[ordering]
  return [...list].sort(
    (a, b) =>
      Number(b.pinned) - Number(a.pinned) ||
      // A comparison of two unreadable stamps is NaN, which is falsy — so the
      // tiebreak below catches it, and no row can vanish into a sort that
      // threw.
      by(a, b) ||
      a.cwd.localeCompare(b.cwd) ||
      a.id.localeCompare(b.id),
  )
}

/**
 * The chosen key, and only it — pinning and the tiebreak are applied around
 * these by orderSessions, so `directory` has nothing left of its own to say.
 */
const COMPARE: Record<Ordering, (a: FleetSession, b: FleetSession) => number> = {
  lastActive: (a, b) => activeBucket(b) - activeBucket(a),
  // No bucket here: `createdAt` is stamped once and never moves, so there is
  // no churn to absorb and the newest session should be visibly the newest.
  created: (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt),
  name: (a, b) => displayName(a).localeCompare(displayName(b)),
  directory: () => 0,
}

/** Which half-minute a session was last touched in. */
function activeBucket(s: FleetSession): number {
  return Math.floor(Date.parse(s.lastActive) / ACTIVE_BUCKET_MS)
}

/**
 * The rows cut into headed runs, in the order the headings should read.
 *
 * Rows keep the order they were handed inside each run — this is a cut, never
 * a re-sort — so a caller that ordered first gets that ordering honoured under
 * every heading. Only groups with something in them are returned: a heading
 * over no rows is a claim that something is there.
 *
 * Tags are the one grouping where the row count grows. A session tagged `api`
 * and `ops` appears under both, because the alternative — picking one of its
 * tags to file it under — is a choice no rule can make correctly, and a
 * session that vanished from a tag it genuinely carries is worse than one
 * counted twice. Sessions with no tags gather under one heading at the very
 * end, where they read as the remainder rather than as a tag someone invented.
 */
export function groupSessions(list: FleetSession[], grouping: Grouping): Group[] {
  return collect(list, BUCKETS[grouping])
}

/**
 * One heading a session belongs under. `rank` orders the headings coarsely —
 * the machine this tab rides, live before ended, real tags before the
 * remainder — and everything sharing a rank reads alphabetically by label.
 */
interface Bucket {
  key: string
  label: string
  rank: number
}

const BUCKETS: Record<Grouping, (s: FleetSession) => Bucket[]> = {
  // Keyed by id and labelled by name, so two machines a user has given the
  // same name to stay apart. The machine this tab is riding leads: it is the
  // one a new session defaults to, the only one present when nothing has been
  // paired yet, and putting it anywhere else would make the ordinary
  // single-machine screen depend on what its owner happened to call it.
  machine: (s) => [
    {
      key: `machine:${s.machineId}`,
      label: s.machineName,
      rank: s.machineId === LOCAL_MACHINE_ID ? 0 : 1,
    },
  ],
  // Written against `exited` rather than for `running`, so a state the daemon
  // adds later reads as live rather than as a process that ended with an exit
  // code nobody has.
  state: (s) =>
    s.state === 'exited'
      ? [{ key: 'state:exited', label: 'Exited', rank: 1 }]
      : [{ key: 'state:running', label: 'Running', rank: 0 }],
  tag: (s) =>
    s.tags.length === 0
      ? [{ key: UNTAGGED_KEY, label: 'No tag', rank: 1 }]
      : s.tags.map((t) => ({ key: `tag:${t}`, label: t, rank: 0 })),
  directory: (s) => [{ key: `dir:${s.cwd}`, label: s.cwd, rank: 0 }],
  none: () => [{ key: 'all', label: 'All sessions', rank: 0 }],
}

/** Gather the rows into their buckets, then put the buckets in reading order. */
function collect(list: FleetSession[], bucketsOf: (s: FleetSession) => Bucket[]): Group[] {
  const found = new Map<string, Bucket & { sessions: FleetSession[] }>()
  for (const s of list) {
    for (const bucket of bucketsOf(s)) {
      const already = found.get(bucket.key)
      if (already) already.sessions.push(s)
      else found.set(bucket.key, { ...bucket, sessions: [s] })
    }
  }
  return [...found.values()]
    .sort(
      (a, b) => a.rank - b.rank || a.label.localeCompare(b.label) || a.key.localeCompare(b.key),
    )
    .map(({ key, label, sessions }) => ({ key, label, sessions }))
}

/**
 * The whole pipeline: what this view makes of these sessions.
 *
 * The one function the screen calls, so that the order of the four steps is
 * decided here rather than re-derived by every caller. Ended sessions are
 * dropped after the search rather than before it — the two are independent,
 * but doing it in this order means a search that matches nothing and a view
 * with everything ended both arrive at the same empty answer by the same
 * route.
 */
export function applyView(list: FleetSession[], v: ViewConfig): Group[] {
  const matched = filterSessions(list, v.search)
  const wanted = v.showExited ? matched : matched.filter((s) => s.state !== 'exited')
  return groupSessions(orderSessions(wanted, v.ordering), v.grouping)
}
