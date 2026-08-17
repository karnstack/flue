import { describe, expect, it } from 'vitest'

import type { SessionInfo } from '@/client/protocol'
import type { FleetSession } from '@/fleet/types'
import { anchorIdOf, foldGroups, groupMembers } from './groups'

function row(over: Partial<FleetSession> & { id: string }): FleetSession {
  return {
    title: '',
    name: '',
    tags: [],
    pinned: false,
    cwd: '/home/karn',
    cmd: ['zsh', '-l'],
    state: 'running',
    exitCode: 0,
    cols: 80,
    rows: 24,
    createdAt: '2026-08-01T10:00:00Z',
    lastActive: '2026-08-01T10:00:00Z',
    machineId: 'local',
    machineName: 'this machine',
    ...over,
  }
}

describe('anchorIdOf', () => {
  it('is the session itself when it stands alone', () => {
    expect(anchorIdOf({ id: 's1' })).toBe('s1')
    expect(anchorIdOf({ id: 's1', group: '' })).toBe('s1')
  })

  it('is the anchor for a member, so any member URL opens the group', () => {
    expect(anchorIdOf({ id: 's2', group: 's1' })).toBe('s1')
  })
})

describe('groupMembers', () => {
  const anchor = row({ id: 'a' })
  const early = row({ id: 'm1', group: 'a', createdAt: '2026-08-01T10:01:00Z' })
  const late = row({ id: 'm2', group: 'a', createdAt: '2026-08-01T10:02:00Z' })

  it('yields the anchor first, then members oldest split first', () => {
    const got = groupMembers([late, anchor, early] as SessionInfo[], 'a')
    expect(got.map((s) => s.id)).toEqual(['a', 'm1', 'm2'])
  })

  it('keeps an exited member — its pane owes the reader an exit overlay', () => {
    const ended = row({ id: 'm1', group: 'a', state: 'exited' })
    const got = groupMembers([anchor, ended] as SessionInfo[], 'a')
    expect(got.map((s) => s.id)).toEqual(['a', 'm1'])
  })

  it('excludes a scratch terminal — the modal owns it, never the layout', () => {
    const scratch = row({ id: 'sc', group: 'a', ephemeral: true })
    const got = groupMembers([anchor, scratch, early] as SessionInfo[], 'a')
    expect(got.map((s) => s.id)).toEqual(['a', 'm1'])
  })

  it('survives a missing anchor: the members are the group now', () => {
    const got = groupMembers([late, early] as SessionInfo[], 'a')
    expect(got.map((s) => s.id)).toEqual(['m1', 'm2'])
  })

  it('leaves strangers out', () => {
    const other = row({ id: 'x', group: 'b' })
    const plain = row({ id: 'y' })
    const got = groupMembers([anchor, other, plain] as SessionInfo[], 'a')
    expect(got.map((s) => s.id)).toEqual(['a'])
  })
})

describe('foldGroups', () => {
  it('folds members under their anchor and counts the panes', () => {
    const anchor = row({ id: 'a' })
    const m1 = row({ id: 'm1', group: 'a' })
    const m2 = row({ id: 'm2', group: 'a' })
    const plain = row({ id: 'p' })

    const { rows, panes } = foldGroups([anchor, m1, plain, m2])
    expect(rows.map((s) => s.id)).toEqual(['a', 'p'])
    expect(panes.get('local/a')).toBe(3)
    expect(panes.has('local/p')).toBe(false)
  })

  it('keeps a member whose anchor is gone — no session may vanish', () => {
    const orphan = row({ id: 'm1', group: 'gone' })
    const { rows, panes } = foldGroups([orphan])
    expect(rows.map((s) => s.id)).toEqual(['m1'])
    expect(panes.size).toBe(0)
  })

  it('does not fold a running member under an exited anchor', () => {
    // The list hides exited rows by default, so a live shell folded under a
    // dead anchor would vanish from the list, the search and the bulk bar
    // for the whole exited-retention window.
    const deadAnchor = row({ id: 'a', state: 'exited' })
    const live = row({ id: 'm1', group: 'a' })
    const alsoDead = row({ id: 'm2', group: 'a', state: 'exited' })
    const { rows, panes } = foldGroups([deadAnchor, live, alsoDead])
    expect(rows.map((s) => s.id)).toEqual(['a', 'm1'])
    // The exited member still folds — it is as over as its anchor.
    expect(panes.get('local/a')).toBe(2)
  })

  it('folds per machine: the same ids on two machines are two groups', () => {
    const anchorHere = row({ id: 'a' })
    const memberThere = row({ id: 'm1', group: 'a', machineId: 'remote', machineName: 'far' })
    const { rows } = foldGroups([anchorHere, memberThere])
    // The remote member's anchor is on another machine, so it must not fold
    // under the local one.
    expect(rows.map((s) => s.id)).toEqual(['a', 'm1'])
  })
})
