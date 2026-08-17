/*
 * What the palette shows, worked out with no React and no fleet in sight.
 *
 * The whole arrangement lives here for the reason sessions/view.ts gives for
 * the same split: the rules about what appears where, in what order, and under
 * which heading are the part worth pinning down with cheap unit tests, and none
 * of them need a DOM to be true.
 */
import type { FleetSession } from '@/fleet/types'
import { keyOf } from '@/fleet/types'
import { displayName, filterSessions, orderSessions } from '@/sessions/view'
import { visitKey, type RecentVisit } from './recents'

/**
 * How many rows are rendered at once.
 *
 * A number, rather than virtualization, because nobody scrolls a palette: the
 * answer is either in the first dozen rows or it is faster to type another
 * letter. What the cap must never do is hide rows silently — see `overflow` on
 * the result, which the footer says out loud.
 */
export const ROW_CAP = 50

/** How many pinned rows get a number badge, since the chord runs 1..9. */
export const BADGE_CAP = 9

/**
 * One row of the palette.
 *
 * `live` is a session some machine is currently reporting. `ghost` is one only
 * this browser remembers — its machine is unreachable, so the fleet is holding
 * no row for it (fleet/fleet.ts drops them deliberately) and the recents store
 * is the only description of it that exists here. A ghost is still selectable:
 * the terminal route has a proper answer for a machine it cannot reach, and
 * refusing to navigate would be this list deciding on the reader's behalf that
 * a sleeping laptop is not worth waking.
 */
export type SwitcherRow =
  | {
      kind: 'live'
      key: string
      session: FleetSession
      /** 1..9 on a pinned row that earned a chord, null everywhere else. */
      badge: number | null
      /** The session this tab is already in. */
      current: boolean
    }
  | {
      kind: 'ghost'
      key: string
      visit: RecentVisit
      current: boolean
    }

/** A headed run of rows. Sections with nothing in them are never returned. */
export interface SwitcherSection {
  key: 'pinned' | 'recent' | 'all' | 'results'
  label: string
  rows: SwitcherRow[]
}

export interface Palette {
  sections: SwitcherSection[]
  /** How many rows the cap left out. Zero unless the fleet is very large. */
  overflow: number
}

export interface BuildOptions {
  sessions: FleetSession[]
  recents: RecentVisit[]
  search: string
  /** `machineId/sessionId` of the session this tab is in, if it is in one. */
  currentKey?: string | null
  cap?: number
}

/**
 * The palette's rows, sectioned.
 *
 * Empty search reads in three runs, in falling order of deliberateness. Pinned
 * is what someone decided was worth keeping to hand, so it leads and it is the
 * only run whose order is stable enough to hang number chords off. Recent is
 * where this browser has actually been, newest first, which is the ordering
 * that makes a switcher a reflex rather than a search. Everything else follows
 * under its own heading — sessions that exist and have simply never been opened
 * *here* — because a list that quietly omitted them would be a fleet-wide
 * switcher that could not reach half the fleet.
 *
 * A search collapses all of that into one run: once someone is typing, headings
 * are furniture between them and the match. Ghosts sort to the end of it, since
 * a session that can be opened right now beats one whose machine is asleep.
 *
 * Exited sessions are not offered at rest at all. This palette is a "take me
 * there" control, and a dead session is not a there — every ended row is one
 * more press between somebody and the session they meant. A search brings them
 * back: typing the exact name of a session you know ended and getting nothing
 * would be its own kind of wrong, so a match is shown, marked as ended, and
 * ranked after everything running. Ghosts are a different kind of unreachable
 * and keep their resting rows — an offline machine comes back, an exited shell
 * does not.
 */
export function buildPalette({
  sessions,
  recents,
  search,
  currentKey = null,
  cap = ROW_CAP,
}: BuildOptions): Palette {
  const live = new Map(sessions.map((s) => [keyOf(s), s]))
  const needle = search.trim()

  const sections = needle === ''
    ? restingSections(sessions, recents, live, currentKey)
    : searchSections(sessions, recents, live, needle, currentKey)

  return capped(sections, cap)
}

/** The three-run arrangement an unsearched palette opens on. */
function restingSections(
  sessions: FleetSession[],
  recents: RecentVisit[],
  live: Map<string, FleetSession>,
  currentKey: string | null,
): SwitcherSection[] {
  // The dead do not rest here — see the ended-sessions note on buildPalette.
  const usable = sessions.filter((s) => s.state !== 'exited')
  const pinned = pinnedOrder(usable)
  const spoken = new Set(pinned.map(keyOf))

  const recentRows: SwitcherRow[] = []
  for (const visit of recents) {
    const key = visitKey(visit)
    if (spoken.has(key)) continue
    // Spoken for even when the next line skips it: a session deliberately
    // left out of Recent must not resurface further down the palette.
    spoken.add(key)
    const session = live.get(key)
    // A visited session the fleet reports as exited is remembered, not
    // offered: its machine is answering, so unlike a ghost there is no
    // sleeping laptop this row could wake.
    if (session !== undefined && session.state === 'exited') continue
    recentRows.push(
      session
        ? { kind: 'live', key, session, badge: null, current: key === currentKey }
        : { kind: 'ghost', key, visit, current: key === currentKey },
    )
  }

  // Whatever the fleet holds that neither of the runs above has spoken for,
  // in the sessions screen's own default order so the two screens agree about
  // what "recently busy" means.
  const rest = orderSessions(
    usable.filter((s) => !spoken.has(keyOf(s))),
    'lastActive',
  ).map((session) => liveRow(session, null, currentKey))

  return trim([
    { key: 'pinned', label: 'Pinned', rows: pinned.map((s, at) => liveRow(s, badgeAt(at), currentKey)) },
    { key: 'recent', label: 'Recent', rows: recentRows },
    { key: 'all', label: 'All sessions', rows: rest },
  ])
}

/** The one run a search collapses to. */
function searchSections(
  sessions: FleetSession[],
  recents: RecentVisit[],
  live: Map<string, FleetSession>,
  needle: string,
  currentKey: string | null,
): SwitcherSection[] {
  // Ended sessions rejoin the list once they are named, ranked after
  // everything running: a match that can be switched to beats one that can
  // only be read about.
  const matched = orderSessions(filterSessions(sessions, needle), 'lastActive')
  const hits = [
    ...matched.filter((s) => s.state !== 'exited'),
    ...matched.filter((s) => s.state === 'exited'),
  ].map((s) => liveRow(s, null, currentKey))
  const ghosts = recents
    .filter((v) => !live.has(visitKey(v)) && matchesVisit(v, needle))
    .map((visit) => ({
      kind: 'ghost' as const,
      key: visitKey(visit),
      visit,
      current: visitKey(visit) === currentKey,
    }))
  return trim([{ key: 'results', label: 'Results', rows: [...hits, ...ghosts] }])
}

/** Whether a remembered session answers to a search. */
function matchesVisit(v: RecentVisit, needle: string): boolean {
  const lowered = needle.toLowerCase()
  return [v.label, v.machineName, v.cwd].some((field) => field.toLowerCase().includes(lowered))
}

function liveRow(session: FleetSession, badge: number | null, currentKey: string | null): SwitcherRow {
  const key = keyOf(session)
  return { kind: 'live', key, session, badge, current: key === currentKey }
}

/** 1..9 for the first nine rows, nothing after: the chord runs out. */
function badgeAt(index: number): number | null {
  return index < BADGE_CAP ? index + 1 : null
}

/**
 * The pinned sessions, in an order that does not move.
 *
 * Number chords are the reason this is not simply `orderSessions`. That
 * function's default key is `lastActive`, which by design lets a busy session
 * climb — fine for a list somebody reads, ruinous for a badge somebody has
 * memorised, because ⌃⇧2 would land on whichever session happened to print
 * something in the last half minute. `createdAt` is stamped once and never
 * written again, so a pinned row keeps its number for as long as it is pinned.
 */
function pinnedOrder(sessions: FleetSession[]): FleetSession[] {
  return sessions
    .filter((s) => s.pinned)
    .sort(
      (a, b) =>
        Date.parse(a.createdAt) - Date.parse(b.createdAt) ||
        a.cwd.localeCompare(b.cwd) ||
        a.id.localeCompare(b.id),
    )
}

/** Drop the headings that would stand over nothing. */
function trim(sections: SwitcherSection[]): SwitcherSection[] {
  return sections.filter((s) => s.rows.length > 0)
}

/**
 * Hold the total to the cap, counting what was left out.
 *
 * Whole sections are dropped once the budget is spent rather than kept as empty
 * headings, and the section that runs out mid-way keeps its first rows: the top
 * of each run is the part that was worth showing.
 */
function capped(sections: SwitcherSection[], cap: number): Palette {
  let budget = Math.max(0, cap)
  let overflow = 0
  const out: SwitcherSection[] = []
  for (const section of sections) {
    const take = Math.min(budget, section.rows.length)
    overflow += section.rows.length - take
    budget -= take
    if (take > 0) out.push({ ...section, rows: section.rows.slice(0, take) })
  }
  return { sections: out, overflow }
}

/** Every row of a built palette, in reading order. */
export function flatten(palette: Palette): SwitcherRow[] {
  return palette.sections.flatMap((s) => s.rows)
}

/**
 * Which row the palette should open on.
 *
 * The first row that is not the session this tab is already in, which is what
 * makes an open-and-press-Enter a hop rather than a no-op. Falls back to the
 * first row when that is all there is, so the highlight is never nowhere.
 */
export function openingRow(palette: Palette): SwitcherRow | null {
  const rows = flatten(palette)
  return rows.find((r) => !r.current) ?? rows[0] ?? null
}

/**
 * The order ⌃⇧] and ⌃⇧[ walk, which is deliberately not the palette's.
 *
 * Recency cannot be cycled. Step to the most recent session and it becomes the
 * most recent, so the list reorders under the walk and "next" bounces between
 * two rows forever, never reaching a third. So the cycle rests on facts that do
 * not move: pinned first, then creation order, and the id to break a tie. The
 * same walk gives the same sequence every time, which is the only thing that
 * makes a blind chord learnable.
 *
 * Live sessions only, and that asymmetry with the palette is on purpose. A row
 * a reader deliberately picked out of a list can be a sleeping machine — they
 * saw what they chose. A blind hop must land somewhere usable — which also
 * rules out exited sessions, here and not only here: the palette excludes
 * them from its resting rows and its pinned badges, so a cycle that kept them
 * would have ⌃⇧2 mean one session with the palette open and another with it
 * shut.
 */
export function cycleOrder(sessions: FleetSession[]): FleetSession[] {
  return sessions.filter((s) => s.state !== 'exited').sort(
    (a, b) =>
      Number(b.pinned) - Number(a.pinned) ||
      Date.parse(a.createdAt) - Date.parse(b.createdAt) ||
      a.id.localeCompare(b.id),
  )
}

/**
 * The session `delta` steps away in the cycle, wrapping at both ends.
 *
 * A current session the cycle does not contain — a ghost, or a row from a
 * machine that has just gone — starts the walk from the top rather than
 * refusing it: the chord's job is to get somebody out of a session they can no
 * longer use, and that is exactly when it is pressed.
 */
export function stepCycle(
  order: FleetSession[],
  currentKey: string | null,
  delta: number,
): FleetSession | null {
  if (order.length === 0) return null
  const at = currentKey === null ? -1 : order.findIndex((s) => keyOf(s) === currentKey)
  if (at < 0) return order[delta > 0 ? 0 : order.length - 1] ?? null
  const next = (at + delta + order.length) % order.length
  return order[next] ?? null
}

/** What a row is called, whether the fleet can see it or only this browser can. */
export function rowLabel(row: SwitcherRow): string {
  return row.kind === 'live' ? displayName(row.session) : row.visit.label
}

/** Which machine a row lives on, by name. */
export function rowMachine(row: SwitcherRow): string {
  return row.kind === 'live' ? row.session.machineName : row.visit.machineName
}

/** A row's working directory, for the line under its name. */
export function rowCwd(row: SwitcherRow): string {
  return row.kind === 'live' ? row.session.cwd : row.visit.cwd
}

/** The address a row navigates to. */
export function rowTarget(row: SwitcherRow): { machineId: string; sessionId: string } {
  return row.kind === 'live'
    ? { machineId: row.session.machineId, sessionId: row.session.id }
    : { machineId: row.visit.machineId, sessionId: row.visit.sessionId }
}
