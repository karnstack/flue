import { describe, expect, it } from 'vitest'

import type { FleetSession } from '@/fleet/types'
import type { RecentVisit } from './recents'
import {
  BADGE_CAP,
  buildPalette,
  cycleOrder,
  flatten,
  openingRow,
  rowLabel,
  rowTarget,
  stepCycle,
} from './order'

/**
 * One session, inert by default so whatever a case overrides is the only thing
 * that can explain its result. The same shape sessions/view.test.ts uses, and
 * deliberately the same defaults.
 */
function s(over: Partial<FleetSession> = {}): FleetSession {
  return {
    id: 'id',
    title: '',
    name: '',
    tags: [],
    pinned: false,
    cwd: '/home/karn',
    cmd: ['zsh'],
    state: 'running',
    exitCode: 0,
    cols: 80,
    rows: 24,
    createdAt: '2026-01-01T00:00:00Z',
    lastActive: '2026-01-01T00:00:00Z',
    machineId: 'local',
    machineName: 'macbook',
    ...over,
  }
}

/** One remembered visit. */
function v(over: Partial<RecentVisit> = {}): RecentVisit {
  return {
    machineId: 'local',
    machineName: 'macbook',
    sessionId: 'id',
    label: 'zsh',
    cwd: '/home/karn',
    visitedAt: '2026-01-01T00:00:00Z',
    ...over,
  }
}

/** The section keys in reading order. */
function sectionKeys(palette: ReturnType<typeof buildPalette>): string[] {
  return palette.sections.map((sec) => sec.key)
}

/** Every row key, flattened. */
function keys(palette: ReturnType<typeof buildPalette>): string[] {
  return flatten(palette).map((r) => r.key)
}

describe('buildPalette, resting', () => {
  it('reads pinned, then recent, then the rest', () => {
    const sessions = [
      s({ id: 'a', pinned: true }),
      s({ id: 'b' }),
      s({ id: 'c' }),
    ]
    const palette = buildPalette({
      sessions,
      recents: [v({ sessionId: 'b' })],
      search: '',
    })
    expect(sectionKeys(palette)).toEqual(['pinned', 'recent', 'all'])
    expect(keys(palette)).toEqual(['local/a', 'local/b', 'local/c'])
  })

  it('drops a heading that would stand over nothing', () => {
    const palette = buildPalette({ sessions: [s({ id: 'a' })], recents: [], search: '' })
    expect(sectionKeys(palette)).toEqual(['all'])
  })

  it('says a pinned session once, under Pinned, never again under Recent', () => {
    const palette = buildPalette({
      sessions: [s({ id: 'a', pinned: true })],
      recents: [v({ sessionId: 'a' })],
      search: '',
    })
    expect(keys(palette)).toEqual(['local/a'])
    expect(sectionKeys(palette)).toEqual(['pinned'])
  })

  it('numbers the pinned rows by creation, not by who printed something last', () => {
    const sessions = [
      s({ id: 'young', pinned: true, createdAt: '2026-02-01T00:00:00Z', lastActive: '2026-09-01T00:00:00Z' }),
      s({ id: 'old', pinned: true, createdAt: '2026-01-01T00:00:00Z', lastActive: '2026-01-01T00:00:00Z' }),
    ]
    const rows = flatten(buildPalette({ sessions, recents: [], search: '' }))
    expect(rows.map((r) => [r.key, r.kind === 'live' ? r.badge : null])).toEqual([
      ['local/old', 1],
      ['local/young', 2],
    ])
  })

  it('runs the badges out at nine, since the chord does', () => {
    const sessions = Array.from({ length: BADGE_CAP + 2 }, (_, i) =>
      s({ id: `p${i}`, pinned: true, createdAt: `2026-01-0${1}T00:00:0${i}Z` }),
    )
    const rows = flatten(buildPalette({ sessions, recents: [], search: '' }))
    const badges = rows.map((r) => (r.kind === 'live' ? r.badge : null))
    expect(badges.slice(0, BADGE_CAP)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9])
    expect(badges.slice(BADGE_CAP)).toEqual([null, null])
  })

  it('keeps the recents in the order they were visited, newest first', () => {
    const sessions = [s({ id: 'a' }), s({ id: 'b' })]
    const palette = buildPalette({
      sessions,
      recents: [v({ sessionId: 'b' }), v({ sessionId: 'a' })],
      search: '',
    })
    expect(keys(palette)).toEqual(['local/b', 'local/a'])
  })

  it('keeps a remembered session whose machine has gone, as a ghost', () => {
    const palette = buildPalette({
      sessions: [s({ id: 'a' })],
      recents: [v({ machineId: 'studio', machineName: 'studio', sessionId: 'gone', label: 'ssh vps' })],
      search: '',
    })
    const ghost = flatten(palette).find((r) => r.key === 'studio/gone')
    expect(ghost?.kind).toBe('ghost')
    expect(rowLabel(ghost!)).toBe('ssh vps')
    expect(rowTarget(ghost!)).toEqual({ machineId: 'studio', sessionId: 'gone' })
  })

  it('prefers the live row when a remembered session is reachable again', () => {
    const palette = buildPalette({
      sessions: [s({ id: 'a', name: 'now called this' })],
      recents: [v({ sessionId: 'a', label: 'called that once' })],
      search: '',
    })
    const row = flatten(palette)[0]!
    expect(row.kind).toBe('live')
    expect(rowLabel(row)).toBe('now called this')
  })

  it('orders the never-visited remainder the way the sessions screen does', () => {
    const sessions = [
      s({ id: 'quiet', lastActive: '2026-01-01T00:00:00Z' }),
      s({ id: 'busy', lastActive: '2026-06-01T00:00:00Z' }),
    ]
    expect(keys(buildPalette({ sessions, recents: [], search: '' }))).toEqual([
      'local/busy',
      'local/quiet',
    ])
  })

  it('marks the session this tab is already in', () => {
    const palette = buildPalette({
      sessions: [s({ id: 'a' }), s({ id: 'b' })],
      recents: [],
      search: '',
      currentKey: 'local/a',
    })
    expect(flatten(palette).map((r) => [r.key, r.current])).toEqual([
      ['local/a', true],
      ['local/b', false],
    ])
  })

  it('offers no exited session, pinned or not', () => {
    // A dead session is not a there, and every ended row is one more press
    // between somebody and the session they meant.
    const palette = buildPalette({
      sessions: [
        s({ id: 'dead-pin', pinned: true, state: 'exited' }),
        s({ id: 'live-pin', pinned: true, createdAt: '2026-02-01T00:00:00Z' }),
        s({ id: 'dead', state: 'exited' }),
        s({ id: 'live' }),
      ],
      recents: [],
      search: '',
    })
    expect(keys(palette)).toEqual(['local/live-pin', 'local/live'])
  })

  it('gives an exited pinned session no badge, and its number to the next', () => {
    // The chord picks from the palette's own pinned run, so a dead row that
    // kept a number would make ⌃⇧1 mean a session nobody can switch to.
    const sessions = [
      s({ id: 'dead', pinned: true, state: 'exited', createdAt: '2026-01-01T00:00:00Z' }),
      s({ id: 'live', pinned: true, createdAt: '2026-02-01T00:00:00Z' }),
    ]
    const rows = flatten(buildPalette({ sessions, recents: [], search: '' }))
    expect(rows.map((r) => [r.key, r.kind === 'live' ? r.badge : null])).toEqual([
      ['local/live', 1],
    ])
  })

  it('skips a visited session that has since exited, and does not ghost it', () => {
    // Its machine is answering, so unlike a ghost there is no sleeping
    // laptop this row could wake.
    const palette = buildPalette({
      sessions: [s({ id: 'a' }), s({ id: 'over', state: 'exited' })],
      recents: [v({ sessionId: 'over' })],
      search: '',
    })
    expect(keys(palette)).toEqual(['local/a'])
  })
})

describe('buildPalette, searching', () => {
  it('collapses to one run once somebody types', () => {
    const palette = buildPalette({
      sessions: [s({ id: 'a', pinned: true, name: 'build' }), s({ id: 'b', name: 'build two' })],
      recents: [],
      search: 'build',
    })
    expect(sectionKeys(palette)).toEqual(['results'])
    expect(palette.sections[0]?.label).toBe('Results')
  })

  it('narrows to what the search admits', () => {
    const palette = buildPalette({
      sessions: [s({ id: 'a', name: 'build' }), s({ id: 'b', name: 'deploy' })],
      recents: [],
      search: 'depl',
    })
    expect(keys(palette)).toEqual(['local/b'])
  })

  it('searches the ghosts too, and puts them after what is reachable', () => {
    const palette = buildPalette({
      sessions: [s({ id: 'live', name: 'build here' })],
      recents: [v({ machineId: 'studio', sessionId: 'asleep', label: 'build there' })],
      search: 'build',
    })
    expect(keys(palette)).toEqual(['local/live', 'studio/asleep'])
  })

  it('finds a ghost by its machine and by its directory', () => {
    const recents = [v({ machineId: 'studio', machineName: 'studio', sessionId: 'g', cwd: '/srv/api' })]
    expect(keys(buildPalette({ sessions: [], recents, search: 'studio' }))).toEqual(['studio/g'])
    expect(keys(buildPalette({ sessions: [], recents, search: 'srv' }))).toEqual(['studio/g'])
  })

  it('reads a search of nothing but spaces as no search', () => {
    const palette = buildPalette({ sessions: [s({ id: 'a', pinned: true })], recents: [], search: '   ' })
    expect(sectionKeys(palette)).toEqual(['pinned'])
  })

  it('has no sections at all when nothing matches', () => {
    const palette = buildPalette({ sessions: [s({ id: 'a' })], recents: [], search: 'nothing' })
    expect(palette.sections).toEqual([])
  })

  it('brings an exited session back once it is named', () => {
    // Typing the exact name of a session you know ended and getting nothing
    // would be its own kind of wrong.
    const palette = buildPalette({
      sessions: [s({ id: 'over', name: 'build', state: 'exited' })],
      recents: [],
      search: 'build',
    })
    expect(keys(palette)).toEqual(['local/over'])
  })

  it('ranks the ended matches after the running ones, and both before the ghosts', () => {
    const palette = buildPalette({
      sessions: [
        // The ended row is the more recently active, and loses anyway.
        s({ id: 'over', name: 'build old', state: 'exited', lastActive: '2026-06-01T00:00:00Z' }),
        s({ id: 'live', name: 'build now' }),
      ],
      recents: [v({ machineId: 'studio', sessionId: 'asleep', label: 'build there' })],
      search: 'build',
    })
    expect(keys(palette)).toEqual(['local/live', 'local/over', 'studio/asleep'])
  })
})

describe('the cap', () => {
  it('holds the total and counts what it left out', () => {
    const sessions = Array.from({ length: 12 }, (_, i) => s({ id: `s${i}` }))
    const palette = buildPalette({ sessions, recents: [], search: '', cap: 5 })
    expect(flatten(palette)).toHaveLength(5)
    expect(palette.overflow).toBe(7)
  })

  it('spends the budget on the sections that read first', () => {
    const sessions = [
      s({ id: 'p', pinned: true }),
      s({ id: 'a' }),
      s({ id: 'b' }),
    ]
    const palette = buildPalette({ sessions, recents: [], search: '', cap: 2 })
    expect(keys(palette)).toEqual(['local/p', 'local/a'])
    expect(palette.overflow).toBe(1)
  })

  it('leaves nothing out when there is room', () => {
    const palette = buildPalette({ sessions: [s({ id: 'a' })], recents: [], search: '' })
    expect(palette.overflow).toBe(0)
  })
})

describe('openingRow', () => {
  it('opens on the first row that is not where you already are', () => {
    const palette = buildPalette({
      sessions: [s({ id: 'a' }), s({ id: 'b' })],
      recents: [],
      search: '',
      currentKey: 'local/a',
    })
    expect(openingRow(palette)?.key).toBe('local/b')
  })

  it('falls back to the only row there is', () => {
    const palette = buildPalette({
      sessions: [s({ id: 'a' })],
      recents: [],
      search: '',
      currentKey: 'local/a',
    })
    expect(openingRow(palette)?.key).toBe('local/a')
  })

  it('is nothing when the palette is empty', () => {
    expect(openingRow(buildPalette({ sessions: [], recents: [], search: '' }))).toBeNull()
  })
})

describe('the cycle', () => {
  it('walks pinned first, then creation order', () => {
    const sessions = [
      s({ id: 'c', createdAt: '2026-03-01T00:00:00Z' }),
      s({ id: 'a', createdAt: '2026-01-01T00:00:00Z' }),
      s({ id: 'p', pinned: true, createdAt: '2026-09-01T00:00:00Z' }),
    ]
    expect(cycleOrder(sessions).map((x) => x.id)).toEqual(['p', 'a', 'c'])
  })

  it('does not move when a session goes busy, unlike the list', () => {
    const before = [s({ id: 'a' }), s({ id: 'b', createdAt: '2026-02-01T00:00:00Z' })]
    const after = [
      s({ id: 'a' }),
      s({ id: 'b', createdAt: '2026-02-01T00:00:00Z', lastActive: '2026-12-01T00:00:00Z' }),
    ]
    expect(cycleOrder(before).map((x) => x.id)).toEqual(cycleOrder(after).map((x) => x.id))
  })

  it('steps forward and back', () => {
    const order = cycleOrder([s({ id: 'a' }), s({ id: 'b', createdAt: '2026-02-01T00:00:00Z' })])
    expect(stepCycle(order, 'local/a', 1)?.id).toBe('b')
    expect(stepCycle(order, 'local/b', -1)?.id).toBe('a')
  })

  it('wraps at both ends', () => {
    const order = cycleOrder([s({ id: 'a' }), s({ id: 'b', createdAt: '2026-02-01T00:00:00Z' })])
    expect(stepCycle(order, 'local/b', 1)?.id).toBe('a')
    expect(stepCycle(order, 'local/a', -1)?.id).toBe('b')
  })

  it('starts from the top for a session the cycle does not hold', () => {
    const order = cycleOrder([s({ id: 'a' }), s({ id: 'b', createdAt: '2026-02-01T00:00:00Z' })])
    expect(stepCycle(order, 'studio/gone', 1)?.id).toBe('a')
    expect(stepCycle(order, null, 1)?.id).toBe('a')
  })

  it('has nowhere to step in an empty fleet', () => {
    expect(stepCycle([], 'local/a', 1)).toBeNull()
  })

  it('walks past the exited, so a blind hop cannot land on a dead session', () => {
    const sessions = [
      s({ id: 'a' }),
      s({ id: 'over', state: 'exited', createdAt: '2026-02-01T00:00:00Z' }),
      s({ id: 'b', createdAt: '2026-03-01T00:00:00Z' }),
    ]
    const order = cycleOrder(sessions)
    expect(order.map((x) => x.id)).toEqual(['a', 'b'])
    expect(stepCycle(order, 'local/a', 1)?.id).toBe('b')
    // Pressed from inside a session that has just ended, the chord still
    // leaves: the walk starts from the top rather than refusing.
    expect(stepCycle(order, 'local/over', 1)?.id).toBe('a')
  })
})

describe('the group section', () => {
  const anchor = s({ id: 'a', name: 'api' })
  const member = s({ id: 'm1', name: 'logs', group: 'a', createdAt: '2026-01-02T00:00:00Z' })
  const other = s({ id: 'x', name: 'elsewhere' })

  it('leads the resting palette with the current group’s other terminals', () => {
    const palette = buildPalette({
      sessions: [other, member, anchor],
      recents: [],
      search: '',
      currentKey: 'local/a',
    })
    expect(sectionKeys(palette)[0]).toBe('group')
    const group = palette.sections[0]!
    expect(group.label).toBe('This session')
    // The session the tab is on gets no *group* row — this section is a
    // take-me-there control, and here is not a there — though it keeps its
    // ordinary row further down, marked current, as it always has. The
    // sibling does not resurface below.
    expect(group.rows.map((r) => r.key)).toEqual(['local/m1'])
    const all = palette.sections.find((sec) => sec.key === 'all')!
    expect(all.rows.map((r) => r.key)).toEqual(['local/a', 'local/x'])
  })

  it('resolves the group from a member’s own tab too', () => {
    const palette = buildPalette({
      sessions: [anchor, member],
      recents: [],
      search: '',
      currentKey: 'local/m1',
    })
    expect(palette.sections[0]!.rows.map((r) => r.key)).toEqual(['local/a'])
  })

  it('is absent outside a session and for a group of one', () => {
    for (const currentKey of [null, 'local/x']) {
      const palette = buildPalette({
        sessions: [anchor, member, other],
        recents: [],
        search: '',
        currentKey,
      })
      expect(sectionKeys(palette)).not.toContain('group')
    }
  })

  it('leaves a pinned sibling to the Pinned run — the number chords hang off it', () => {
    const pinnedMember = s({ id: 'm2', name: 'pinned one', group: 'a', pinned: true })
    const palette = buildPalette({
      sessions: [anchor, member, pinnedMember],
      recents: [],
      search: '',
      currentKey: 'local/a',
    })
    const group = palette.sections.find((sec) => sec.key === 'group')!
    const pinned = palette.sections.find((sec) => sec.key === 'pinned')!
    expect(group.rows.map((r) => r.key)).toEqual(['local/m1'])
    expect(pinned.rows.map((r) => r.key)).toEqual(['local/m2'])
  })

  it('never crosses machines, however the ids collide', () => {
    const farMember = s({ id: 'm1', group: 'a', machineId: 'far', machineName: 'far' })
    const palette = buildPalette({
      sessions: [anchor, farMember],
      recents: [],
      search: '',
      currentKey: 'local/a',
    })
    expect(sectionKeys(palette)).not.toContain('group')
  })
})
