/*
 * Which sessions this browser has actually been in, newest first.
 *
 * Two jobs, and the second is the one that decides the shape. The first is
 * ordering: a switcher whose list is sorted by anything but "where you just
 * were" makes you read it every time, and the fleet's own orderings — last
 * active, created, name — are all facts about the session rather than about the
 * reader. The second is memory. The fleet drops a machine's rows the moment it
 * goes unreachable, on purpose (fleet/fleet.ts, slotStatus: rows from a machine
 * nobody can reach are a claim it cannot stand behind), so a session on a
 * sleeping laptop is not merely stale in the list — it is absent from it. This
 * store is where it survives, which is why each entry carries a copy of what
 * the row said rather than only the ids to look one up with.
 *
 * Per browser, in localStorage, like the saved views beside it
 * (sessions/views-store.ts) and for the same reason: recency spans machines, so
 * no one daemon owns it, and there is nothing to sync it through that would not
 * first have to be invented. The cost is the same too — where you have been on
 * a laptop is not where you have been on a phone.
 *
 * Everything read back out is measured rather than believed. localStorage is
 * writable by anything on the origin and survives every deploy, so a corrupt
 * document, a foreign shape or a half-written row all have to read as
 * something; they read as "not a visit", and a browser whose store is nonsense
 * is a browser that has been nowhere, which is a state already known to work.
 */

/** Where the visits live. A JSON array of RecentVisit, newest first. */
const RECENTS_KEY = 'flue.switcher.recents'

/**
 * How many visits are kept.
 *
 * Far more than a list anybody reads — the palette shows a few dozen rows at
 * most — because the tail is not for reading. It is what lets a session you
 * opened last week still be reachable by name while its machine is asleep, and
 * a hundred rows of four short strings is a few kilobytes.
 */
export const RECENTS_CAP = 100

/**
 * One session this browser has opened, as it looked at the time.
 *
 * The denormalized fields are the point (see the note at the top): when the
 * machine is unreachable these are the only description of the session that
 * exists on this device. They are refreshed on every visit, so they drift only
 * for sessions nobody has opened since they were renamed.
 */
export interface RecentVisit {
  machineId: string
  machineName: string
  sessionId: string
  /** What the row displayed — `displayName`'s answer, not the raw name. */
  label: string
  cwd: string
  /** ISO 8601, stamped by this browser's clock. Ordering only. */
  visitedAt: string
}

/** The identity of a visit, spelled exactly as `fleet/types.ts` spells a row's. */
export const visitKey = (v: Pick<RecentVisit, 'machineId' | 'sessionId'>) =>
  `${v.machineId}/${v.sessionId}`

/** Whether a parsed value is a visit this module is willing to hand back. */
function isVisit(value: unknown): value is RecentVisit {
  const v = value as RecentVisit | null
  return (
    typeof v?.machineId === 'string' &&
    v.machineId !== '' &&
    typeof v.sessionId === 'string' &&
    v.sessionId !== '' &&
    typeof v.machineName === 'string' &&
    typeof v.label === 'string' &&
    typeof v.cwd === 'string' &&
    typeof v.visitedAt === 'string'
  )
}

/**
 * Every visit this browser remembers, newest first.
 *
 * Stored order is the answer — the list is written newest-first and read back
 * as it was written, so nothing here parses a timestamp. That matters more than
 * it sounds: `visitedAt` is stamped by whichever device wrote it, and a phone
 * with a wrong clock would otherwise be able to sort itself to the top of a
 * laptop's list forever.
 *
 * Rows are validated one at a time rather than all or nothing, as the views
 * store does: one mangled entry should cost its owner that entry, not the
 * ninety-nine beside it.
 */
export function listRecents(): RecentVisit[] {
  let raw: string | null
  try {
    raw = localStorage.getItem(RECENTS_KEY)
  } catch {
    return []
  }
  if (raw === null) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  const seen = new Set<string>()
  const out: RecentVisit[] = []
  for (const row of parsed) {
    if (!isVisit(row)) continue
    // A store that somehow holds one session twice reads as one visit at its
    // newest position. Nothing this module writes can produce that, but the
    // palette keys its rows on this and two rows with one key is a React
    // warning and a highlight that cannot be moved off.
    const key = visitKey(row)
    if (seen.has(key)) continue
    seen.add(key)
    out.push({
      machineId: row.machineId,
      machineName: row.machineName,
      sessionId: row.sessionId,
      label: row.label,
      cwd: row.cwd,
      visitedAt: row.visitedAt,
    })
  }
  return out
}

/**
 * Write down that this browser is in a session now.
 *
 * Moved to the front rather than added, so opening a session you have opened
 * before does not leave two entries and does not leave the old position
 * standing. The description is overwritten on the way past — a session renamed
 * since the last visit should read by its new name.
 *
 * Best effort, and silently so. A browser that refuses the write (private
 * modes exist, and quotas are real) still shows every session the fleet can
 * reach; what it loses is the ordering and the ghosts, which is a smaller
 * palette rather than a broken one. There is no promise on screen to break.
 */
export function recordVisit(visit: Omit<RecentVisit, 'visitedAt'>): void {
  const key = visitKey(visit)
  const kept = listRecents().filter((v) => visitKey(v) !== key)
  kept.unshift({ ...visit, visitedAt: new Date().toISOString() })
  try {
    localStorage.setItem(RECENTS_KEY, JSON.stringify(kept.slice(0, RECENTS_CAP)))
  } catch {
    // Nothing to do and nobody to tell: see above.
  }
}

/**
 * Forget one session.
 *
 * Called when a machine reports that a session is gone — a ghost row that can
 * never be opened again is worse than no row, because it is indistinguishable
 * on screen from one that is merely asleep. Idempotent: forgetting a session
 * that was never visited succeeds, because the state asked for already holds.
 */
export function forgetVisit(visit: Pick<RecentVisit, 'machineId' | 'sessionId'>): void {
  const key = visitKey(visit)
  const kept = listRecents().filter((v) => visitKey(v) !== key)
  try {
    localStorage.setItem(RECENTS_KEY, JSON.stringify(kept))
  } catch {
    // As above.
  }
}
