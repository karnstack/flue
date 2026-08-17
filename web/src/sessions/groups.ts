/*
 * Session groups, client side.
 *
 * The daemon records one optional fact — `group`, the id of the session a
 * member was split from — and everything else about groups is a rendering
 * decision made here: which sessions share a surface, what order the panes
 * come in, and what the sessions list folds away. Groups are flat by
 * construction: a member's `group` names its anchor and nothing nests, so
 * every question below is answered by one field read, never a walk.
 */

import type { SessionInfo } from '@/client/protocol'
import { keyOf, type FleetSession } from '@/fleet/types'

/**
 * The id of the group a session belongs to: its anchor's, or its own when it
 * stands alone. This is what the terminal route resolves a URL through, so a
 * link to any member opens the whole group.
 */
export function anchorIdOf(s: Pick<SessionInfo, 'id' | 'group'>): string {
  return s.group !== undefined && s.group !== '' ? s.group : s.id
}

/**
 * The sessions that share one group surface, panes-in-order: the anchor
 * first when it still exists, then members oldest split first, so panes keep
 * their places as the list refreshes around them.
 *
 * Exited members stay in — a pane whose process ended shows its exit
 * overlay rather than vanishing mid-read — and ephemeral ones stay out: a
 * scratch terminal belongs to the modal, never to the pane layout. An anchor
 * that is gone (closed and reaped) simply yields the members, which is what
 * lets a group survive its anchor.
 */
export function groupMembers<T extends SessionInfo>(rows: T[], anchorId: string): T[] {
  const anchor = rows.filter((s) => s.id === anchorId && s.ephemeral !== true)
  const members = rows
    .filter((s) => s.group === anchorId && s.id !== anchorId && s.ephemeral !== true)
    .sort((a, b) =>
      a.createdAt === b.createdAt
        ? a.id.localeCompare(b.id)
        : a.createdAt.localeCompare(b.createdAt),
    )
  return [...anchor, ...members]
}

/** What foldGroups hands back: the rows left on show, and each anchor's pane count. */
export interface FoldedSessions {
  rows: FleetSession[]
  /** keyOf(anchor row) -> total panes in its group, only when more than one. */
  panes: Map<string, number>
}

/**
 * Fold group members under their anchors for the sessions list: one row per
 * group, wearing a pane count, rather than N rows for what a reader thinks
 * of as one terminal.
 *
 * Machine-scoped, because two daemons mint ids with no knowledge of each
 * other — a member folds only under an anchor on its own machine. A member
 * whose anchor is not in the list at all (closed, reaped, or filtered away
 * upstream) keeps its row: a session must never vanish from every surface at once.
 */
export function foldGroups(rows: FleetSession[]): FoldedSessions {
  const anchors = new Map<string, FleetSession>()
  for (const s of rows) {
    if (s.group === undefined || s.group === '') anchors.set(keyOf(s), s)
  }

  const out: FleetSession[] = []
  const panes = new Map<string, number>()
  for (const s of rows) {
    const anchorKey = `${s.machineId}/${anchorIdOf(s)}`
    const anchor = s.group !== undefined && s.group !== '' ? anchors.get(anchorKey) : undefined
    // A running member never folds under an exited anchor. The list hides
    // exited rows by default, and a fold that put a live shell behind a
    // hidden corpse would be that shell gone from the list, the search and
    // the bulk bar for the whole exited-retention window.
    if (anchor === undefined || (anchor.state === 'exited' && s.state !== 'exited')) {
      out.push(s)
      continue
    }
    panes.set(anchorKey, (panes.get(anchorKey) ?? 1) + 1)
  }
  return { rows: out, panes }
}
