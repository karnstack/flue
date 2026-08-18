import { describe, expect, it } from 'vitest'

import type { AgentMessage } from '@/client/protocol'

import {
  applyAgentView,
  basename,
  byModel,
  byProject,
  compactCost,
  compactTokens,
  dayLabel,
  dayStartMs,
  DEFAULT_AGENT_VIEW,
  displayTitle,
  filterHistory,
  filterRows,
  fmtDuration,
  groupHits,
  groupRows,
  heatmapWeeks,
  historyDayMs,
  insightTotals,
  keyMessages,
  latestModel,
  mergedSessions,
  orderRows,
  rangeFilter,
  rangeFilterHistory,
  retryMissingTranscript,
  rowKey,
  rowTokens,
  sessionsByDay,
  shortModel,
  splitSnippet,
  tokensByDay,
  usageStats,
  type AgentHitRow,
  type AgentRow,
  type HeatCell,
  type HistoryDayRow,
} from './view'

/** A local-time stamp, so day bucketing tests hold in any timezone. */
function at(y: number, monthIndex: number, d: number, h = 12): string {
  return new Date(y, monthIndex, d, h).toISOString()
}

// Tuesday, August 18th 2026, mid-afternoon local time.
const NOW = new Date(2026, 7, 18, 15).getTime()

function row(over: Partial<AgentRow> & { id: string }): AgentRow {
  return {
    tool: 'claude',
    cwd: '/Users/karn/code/flue',
    startedAt: at(2026, 7, 18, 9),
    endedAt: at(2026, 7, 18, 10),
    messageCount: 10,
    toolCallCount: 2,
    models: ['claude-sonnet-4-5-20250929'],
    tokens: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 },
    fileSize: 1000,
    machineId: 'local',
    machineName: 'mesa.local',
    ...over,
  }
}

function hit(over: Partial<AgentHitRow> & { id: string; offset: number }): AgentHitRow {
  return {
    tool: 'claude',
    cwd: '/Users/karn/code/flue',
    role: 'user',
    snippet: 'fix the tailwind build please',
    machineId: 'local',
    machineName: 'mesa.local',
    ...over,
  }
}

describe('rowKey', () => {
  it('qualifies the id by machine and tool', () => {
    expect(rowKey(row({ id: 'abc' }))).toBe('local/claude/abc')
    expect(rowKey(row({ id: 'abc', tool: 'codex', machineId: 'attic-pi' }))).toBe(
      'attic-pi/codex/abc',
    )
  })
})

describe('displayTitle', () => {
  it('prefers the title, then the first prompt, then the id', () => {
    expect(displayTitle(row({ id: 'x', title: 'Fix the build', firstPrompt: 'hi' }))).toBe(
      'Fix the build',
    )
    expect(displayTitle(row({ id: 'x', firstPrompt: 'hi' }))).toBe('hi')
    expect(displayTitle(row({ id: 'x' }))).toBe('x')
  })
})

describe('basename', () => {
  it('takes the last segment', () => {
    expect(basename('/Users/karn/code/flue')).toBe('flue')
    expect(basename('/Users/karn/code/flue/')).toBe('flue')
  })
  it('lets the root name itself and the empty string name nothing', () => {
    expect(basename('/')).toBe('/')
    expect(basename('')).toBe('')
  })
})

describe('shortModel', () => {
  it('drops the provider prefix, the claude family prefix, and a date stamp', () => {
    expect(shortModel('claude-sonnet-4-5-20250929')).toBe('sonnet-4-5')
    expect(shortModel('anthropic/claude-opus-4')).toBe('opus-4')
    expect(shortModel('gpt-5.2-codex')).toBe('gpt-5.2-codex')
  })
})

describe('latestModel', () => {
  it('answers the last model touched, or null for none', () => {
    expect(latestModel(row({ id: 'x', models: ['a', 'b'] }))).toBe('b')
    expect(latestModel(row({ id: 'x', models: [] }))).toBeNull()
  })
})

describe('rowTokens', () => {
  it('counts input and output, never the cache buckets', () => {
    const r = row({
      id: 'x',
      tokens: { input: 100, output: 50, cacheRead: 1_000_000, cacheWrite: 9000 },
    })
    expect(rowTokens(r)).toBe(150)
  })
})

describe('compactTokens', () => {
  it('prints small counts whole', () => {
    expect(compactTokens(0)).toBe('0')
    expect(compactTokens(12)).toBe('12')
    expect(compactTokens(999)).toBe('999')
  })
  it('keeps one decimal below ten of a unit and none above', () => {
    expect(compactTokens(1_200)).toBe('1.2K')
    expect(compactTokens(9_940)).toBe('9.9K')
    expect(compactTokens(12_400)).toBe('12K')
    expect(compactTokens(850_000)).toBe('850K')
    expect(compactTokens(1_200_000)).toBe('1.2M')
    expect(compactTokens(2_500_000_000)).toBe('2.5B')
  })
  it('promotes to the next unit at the boundary instead of printing 1000K', () => {
    expect(compactTokens(999_999)).toBe('1M')
  })
  it('answers 0 for garbage rather than arithmetic on it', () => {
    expect(compactTokens(Number.NaN)).toBe('0')
    expect(compactTokens(-5)).toBe('0')
  })
})

describe('compactCost', () => {
  it('keeps cents while they are legible and drops them once they are noise', () => {
    expect(compactCost(0.42)).toBe('$0.42')
    expect(compactCost(12.3)).toBe('$12.30')
    expect(compactCost(123.4)).toBe('$123')
  })
  it('refuses to print a negative or unreadable cost', () => {
    expect(compactCost(Number.NaN)).toBe('$0.00')
    expect(compactCost(-1)).toBe('$0.00')
  })
})

describe('filterRows', () => {
  const rows = [
    row({ id: 'a', tool: 'claude' }),
    row({ id: 'b', tool: 'codex' }),
    row({ id: 'c', tool: 'pi', machineId: 'attic-pi' }),
  ]

  it('admits everything when the sets are empty', () => {
    expect(filterRows(rows, { tools: new Set(), machines: new Set() })).toHaveLength(3)
    expect(filterRows(rows)).toHaveLength(3)
  })

  it('narrows by tool and by machine, together', () => {
    expect(filterRows(rows, { tools: new Set(['codex']) }).map((r) => r.id)).toEqual(['b'])
    expect(filterRows(rows, { machines: new Set(['attic-pi']) }).map((r) => r.id)).toEqual(['c'])
    expect(
      filterRows(rows, { tools: new Set(['pi']), machines: new Set(['local']) }),
    ).toHaveLength(0)
  })
})

describe('orderRows', () => {
  it('puts the most recently touched first, read in half-minute buckets', () => {
    const rows = [
      row({ id: 'old', endedAt: at(2026, 7, 17, 10) }),
      row({ id: 'new', endedAt: at(2026, 7, 18, 10) }),
    ]
    expect(orderRows(rows, 'recent').map((r) => r.id)).toEqual(['new', 'old'])
  })

  it('does not reshuffle rows whose stamps land in the same bucket', () => {
    // Two stamps fifteen seconds apart are equally recent, so the tiebreak —
    // cwd, then id — decides, and polling cannot swap them.
    const base = new Date(2026, 7, 18, 10, 0, 0).getTime()
    const rows = [
      row({ id: 'b', cwd: '/two', endedAt: new Date(base + 15_000).toISOString() }),
      row({ id: 'a', cwd: '/one', endedAt: new Date(base).toISOString() }),
    ]
    expect(orderRows(rows, 'recent').map((r) => r.id)).toEqual(['a', 'b'])
  })

  it('falls back to startedAt when endedAt is unreadable', () => {
    const rows = [
      row({ id: 'a', endedAt: 'garbage', startedAt: at(2026, 7, 18, 11) }),
      row({ id: 'b', endedAt: at(2026, 7, 17, 10) }),
    ]
    expect(orderRows(rows, 'recent').map((r) => r.id)).toEqual(['a', 'b'])
  })

  it('orders by tokens and by messages when asked', () => {
    const rows = [
      row({ id: 'small', tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } }),
      row({ id: 'big', tokens: { input: 500, output: 500, cacheRead: 0, cacheWrite: 0 } }),
    ]
    expect(orderRows(rows, 'tokens').map((r) => r.id)).toEqual(['big', 'small'])

    const counted = [row({ id: 'few', messageCount: 2 }), row({ id: 'many', messageCount: 90 })]
    expect(orderRows(counted, 'messages').map((r) => r.id)).toEqual(['many', 'few'])
  })

  it('holds two unreadable stamps still rather than losing a row to NaN', () => {
    const rows = [
      row({ id: 'b', cwd: '/two', startedAt: 'nope', endedAt: 'nope' }),
      row({ id: 'a', cwd: '/one', startedAt: 'nope', endedAt: 'nope' }),
    ]
    const out = orderRows(rows, 'recent')
    expect(out.map((r) => r.id)).toEqual(['a', 'b'])
  })
})

describe('dayLabel', () => {
  const day = (y: number, m: number, d: number) => dayStartMs(new Date(y, m, d).getTime())

  it('says Today and Yesterday for the two nearest days', () => {
    expect(dayLabel(day(2026, 7, 18), NOW)).toBe('Today')
    expect(dayLabel(day(2026, 7, 17), NOW)).toBe('Yesterday')
  })

  it('names the weekday inside a week and the date beyond it', () => {
    expect(dayLabel(day(2026, 7, 15), NOW)).toBe('Saturday')
    expect(dayLabel(day(2026, 7, 12), NOW)).toBe('Wednesday')
    expect(dayLabel(day(2026, 7, 11), NOW)).toBe('Aug 11')
  })

  it('carries the year when it is not this one', () => {
    expect(dayLabel(day(2025, 7, 11), NOW)).toBe('Aug 11, 2025')
  })
})

describe('groupRows', () => {
  it('cuts by day, newest heading first, and never re-sorts inside a run', () => {
    const rows = [
      row({ id: 'today-2', endedAt: at(2026, 7, 18, 11) }),
      row({ id: 'today-1', endedAt: at(2026, 7, 18, 9) }),
      row({ id: 'past', endedAt: at(2026, 7, 15, 9) }),
    ]
    const groups = groupRows(rows, 'day', NOW)
    expect(groups.map((g) => g.label)).toEqual(['Today', 'Saturday'])
    expect(groups[0]!.rows.map((r) => r.id)).toEqual(['today-2', 'today-1'])
  })

  it('buckets a day on when the transcript last moved, not when it began', () => {
    const rows = [row({ id: 'x', startedAt: at(2026, 7, 10, 9), endedAt: at(2026, 7, 18, 9) })]
    expect(groupRows(rows, 'day', NOW)[0]!.label).toBe('Today')
  })

  it('gathers rows with no readable stamp under Undated, at the end', () => {
    const rows = [
      row({ id: 'ok' }),
      row({ id: 'lost', startedAt: 'nope', endedAt: 'nope' }),
    ]
    const groups = groupRows(rows, 'day', NOW)
    expect(groups.map((g) => g.label)).toEqual(['Today', 'Undated'])
  })

  it('cuts by project on the full path, labelled by its last segment', () => {
    const rows = [
      row({ id: 'a', cwd: '/code/web' }),
      row({ id: 'b', cwd: '/code/api' }),
      row({ id: 'c', cwd: '/code/web' }),
    ]
    const groups = groupRows(rows, 'project', NOW)
    expect(groups.map((g) => g.label)).toEqual(['api', 'web'])
    expect(groups[1]!.rows.map((r) => r.id)).toEqual(['a', 'c'])
  })

  it('cuts by tool in the chips order, not alphabetically', () => {
    const rows = [
      row({ id: 'p', tool: 'pi' }),
      row({ id: 'c', tool: 'codex' }),
      row({ id: 'a', tool: 'claude' }),
    ]
    expect(groupRows(rows, 'tool', NOW).map((g) => g.label)).toEqual(['Claude', 'Codex', 'Pi'])
  })

  it('cuts by machine, keyed by id and labelled by name', () => {
    const rows = [
      row({ id: 'a', machineId: 'attic-pi', machineName: 'Attic Pi' }),
      row({ id: 'b', machineId: 'local', machineName: 'mesa.local' }),
    ]
    const groups = groupRows(rows, 'machine', NOW)
    expect(groups.map((g) => g.key)).toEqual(['machine:attic-pi', 'machine:local'])
    expect(groups.map((g) => g.label)).toEqual(['Attic Pi', 'mesa.local'])
  })

  it('falls back to the machine id when the name is blank', () => {
    const rows = [row({ id: 'a', machineName: '' })]
    expect(groupRows(rows, 'machine', NOW)[0]!.label).toBe('local')
  })
})

describe('applyAgentView', () => {
  it('filters, then orders, then cuts — one pipeline, one direction', () => {
    const rows = [
      row({ id: 'codex-old', tool: 'codex', endedAt: at(2026, 7, 17, 9) }),
      row({ id: 'claude', tool: 'claude', endedAt: at(2026, 7, 18, 9) }),
      row({ id: 'codex-new', tool: 'codex', endedAt: at(2026, 7, 18, 11) }),
    ]
    const groups = applyAgentView(
      rows,
      DEFAULT_AGENT_VIEW,
      { tools: new Set(['codex']) },
      NOW,
    )
    expect(groups.map((g) => g.label)).toEqual(['Today', 'Yesterday'])
    expect(groups[0]!.rows.map((r) => r.id)).toEqual(['codex-new'])
    expect(groups[1]!.rows.map((r) => r.id)).toEqual(['codex-old'])
  })

  it('lets a filter empty a heading out of existence', () => {
    const rows = [row({ id: 'a', tool: 'pi' })]
    expect(applyAgentView(rows, DEFAULT_AGENT_VIEW, { tools: new Set(['codex']) }, NOW)).toEqual(
      [],
    )
  })
})

describe('rangeFilter', () => {
  const rows = [
    row({ id: 'today', startedAt: at(2026, 7, 18, 9) }),
    row({ id: 'six-days', startedAt: at(2026, 7, 12, 9) }),
    row({ id: 'ten-days', startedAt: at(2026, 7, 8, 9) }),
    row({ id: 'ancient', startedAt: at(2025, 0, 1, 9) }),
    row({ id: 'undated', startedAt: 'nope' }),
  ]

  it('admits the last seven calendar days for 7d', () => {
    expect(rangeFilter(rows, '7d', NOW).map((r) => r.id)).toEqual(['today', 'six-days'])
  })

  it('widens with the range and admits everything for all', () => {
    expect(rangeFilter(rows, '30d', NOW).map((r) => r.id)).toEqual([
      'today',
      'six-days',
      'ten-days',
    ])
    expect(rangeFilter(rows, 'all', NOW)).toHaveLength(5)
  })

  it('counts a session started early on the boundary day', () => {
    const boundary = [row({ id: 'edge', startedAt: at(2026, 7, 12, 0) })]
    expect(rangeFilter(boundary, '7d', NOW)).toHaveLength(1)
  })
})

describe('insightTotals', () => {
  it('sums the buckets and counts the sessions', () => {
    const rows = [
      row({ id: 'a', tokens: { input: 100, output: 50, cacheRead: 30, cacheWrite: 5 } }),
      row({ id: 'b', tokens: { input: 10, output: 5, cacheRead: 3, cacheWrite: 1 } }),
    ]
    expect(insightTotals(rows)).toEqual({
      sessions: 2,
      input: 110,
      output: 55,
      cacheRead: 33,
      costUsd: null,
    })
  })

  it('keeps cost null until any row records one, then sums those that do', () => {
    expect(insightTotals([row({ id: 'a' })]).costUsd).toBeNull()
    const rows = [row({ id: 'a', costUsd: 0.4 }), row({ id: 'b' }), row({ id: 'c', costUsd: 0.2 })]
    expect(insightTotals(rows).costUsd).toBeCloseTo(0.6)
  })

  it('answers zeros for no rows at all', () => {
    expect(insightTotals([])).toEqual({
      sessions: 0,
      input: 0,
      output: 0,
      cacheRead: 0,
      costUsd: null,
    })
  })
})

describe('tokensByDay', () => {
  it('stacks each tool on the day its session began, zero-filling quiet days', () => {
    const rows = [
      row({
        id: 'a',
        tool: 'claude',
        startedAt: at(2026, 7, 16, 9),
        tokens: { input: 60, output: 40, cacheRead: 0, cacheWrite: 0 },
      }),
      row({
        id: 'b',
        tool: 'codex',
        startedAt: at(2026, 7, 18, 9),
        tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
      }),
    ]
    const days = tokensByDay(rows, NOW)
    expect(days).toHaveLength(3)
    expect(days[0]!.byTool).toEqual({ claude: 100, codex: 0, pi: 0 })
    expect(days[1]!.total).toBe(0)
    expect(days[2]!.byTool).toEqual({ claude: 0, codex: 15, pi: 0 })
    expect(days[0]!.label).toBe('Aug 16')
  })

  it('answers nothing for rows with no readable stamps', () => {
    expect(tokensByDay([row({ id: 'x', startedAt: 'nope' })], NOW)).toEqual([])
    expect(tokensByDay([], NOW)).toEqual([])
  })

  it('caps the span when a stamp claims the distant past', () => {
    // A zero time serialises as year 1; one such row must not ask for
    // hundreds of thousands of bars.
    const rows = [
      row({ id: 'ancient', startedAt: '0001-01-01T00:00:00Z' }),
      row({ id: 'b', startedAt: at(2026, 7, 18, 9) }),
    ]
    const days = tokensByDay(rows, NOW)
    expect(days.length).toBeLessThanOrEqual(366)
    expect(days.at(-1)!.total).toBeGreaterThan(0)
  })
})

describe('sessionsByDay', () => {
  it('counts starts per day across the same zero-filled span, split by tool', () => {
    const rows = [
      row({ id: 'a', startedAt: at(2026, 7, 17, 9) }),
      row({ id: 'b', tool: 'codex', startedAt: at(2026, 7, 17, 20) }),
      row({ id: 'c', startedAt: at(2026, 7, 18, 9) }),
    ]
    const days = sessionsByDay(rows, NOW)
    expect(days.map((d) => d.count)).toEqual([2, 1])
    expect(days[0]!.byTool).toEqual({ claude: 1, codex: 1, pi: 0 })
    expect(days[1]!.byTool).toEqual({ claude: 1, codex: 0, pi: 0 })
  })
})

describe('byProject', () => {
  it('sums token spend per path and keeps only the biggest spenders', () => {
    const rows = [
      row({ id: 'a', cwd: '/code/web', tokens: { input: 5, output: 5, cacheRead: 0, cacheWrite: 0 } }),
      row({ id: 'b', cwd: '/code/web', tokens: { input: 5, output: 5, cacheRead: 0, cacheWrite: 0 } }),
      row({ id: 'c', cwd: '/code/api', tokens: { input: 50, output: 0, cacheRead: 0, cacheWrite: 0 } }),
    ]
    expect(byProject(rows)).toEqual([
      { cwd: '/code/api', label: 'api', tokens: 50 },
      { cwd: '/code/web', label: 'web', tokens: 20 },
    ])
    expect(byProject(rows, 1)).toHaveLength(1)
  })
})

describe('byModel', () => {
  it('lands a session on its latest model and skips sessions naming none', () => {
    const rows = [
      row({ id: 'a', models: ['old-model', 'claude-opus-4'], tokens: { input: 60, output: 40, cacheRead: 0, cacheWrite: 0 } }),
      row({ id: 'b', models: ['claude-opus-4'], tokens: { input: 5, output: 5, cacheRead: 0, cacheWrite: 0 } }),
      row({ id: 'c', models: [] }),
    ]
    expect(byModel(rows)).toEqual([{ model: 'claude-opus-4', tokens: 110 }])
  })
})

describe('heatmapWeeks', () => {
  const dayOf = (y: number, m: number, d: number) => dayStartMs(new Date(y, m, d).getTime())

  function cellFor(weeks: HeatCell[][], dayMs: number): HeatCell {
    for (const week of weeks) for (const cell of week) if (cell.dayMs === dayMs) return cell
    throw new Error('day not on the map')
  }

  it('spans 52 full weeks plus the current one, seven cells each, Monday first', () => {
    const { weeks } = heatmapWeeks([], NOW)
    expect(weeks.length).toBeGreaterThanOrEqual(52)
    expect(weeks.length).toBeLessThanOrEqual(53)
    for (const week of weeks) expect(week).toHaveLength(7)
    // NOW is a Tuesday, so the last column's Monday is the day before.
    expect(weeks.at(-1)![0]!.dayMs).toBe(dayOf(2026, 7, 17))
  })

  it('lands a known Tuesday in row 1 of the last column', () => {
    const { weeks } = heatmapWeeks([row({ id: 'x', startedAt: at(2026, 7, 18, 9) })], NOW)
    const last = weeks.at(-1)!
    expect(last[1]!.dayMs).toBe(dayOf(2026, 7, 18))
    expect(last[1]!.tokens).toBe(150)
    // The lone active day reads full strength, per the rank-quartile choice.
    expect(last[1]!.level).toBe(4)
  })

  it('flags the current week days past today as future, and nothing else', () => {
    const { weeks } = heatmapWeeks([], NOW)
    const last = weeks.at(-1)!
    // Monday and Tuesday have happened; Wednesday through Sunday have not.
    expect(last.map((c) => c.future === true)).toEqual([
      false,
      false,
      true,
      true,
      true,
      true,
      true,
    ])
    for (const week of weeks.slice(0, -1)) {
      for (const cell of week) expect(cell.future).toBeUndefined()
    }
  })

  it('gives every day level 0 when there are no rows', () => {
    const { weeks } = heatmapWeeks([], NOW)
    for (const cell of weeks.flat()) {
      expect(cell.level).toBe(0)
      expect(cell.tokens).toBe(0)
    }
  })

  it('keeps levels monotone with token totals, quartile by quartile', () => {
    // Eight active days spending 10..80; ranked quartiles read 1,1,2,2,3,3,4,4.
    const rows = Array.from({ length: 8 }, (_, i) =>
      row({
        id: `d${i}`,
        startedAt: at(2026, 7, 3 + i, 9),
        tokens: { input: (i + 1) * 10, output: 0, cacheRead: 0, cacheWrite: 0 },
      }),
    )
    const { weeks } = heatmapWeeks(rows, NOW)
    const levels = Array.from({ length: 8 }, (_, i) => cellFor(weeks, dayOf(2026, 7, 3 + i)).level)
    expect(levels).toEqual([1, 1, 2, 2, 3, 3, 4, 4])
  })

  it('drops a year-1 stamp at the window edge rather than walking to it', () => {
    const rows = [
      row({ id: 'ancient', startedAt: '0001-01-01T00:00:00Z' }),
      row({ id: 'fresh', startedAt: at(2026, 7, 18, 9) }),
    ]
    const { weeks } = heatmapWeeks(rows, NOW)
    expect(weeks.length).toBeLessThanOrEqual(53)
    expect(weeks.flat().reduce((sum, c) => sum + c.tokens, 0)).toBe(150)
  })

  it('labels a month at the week its Mondays reach it, never crowding', () => {
    const { weeks, months } = heatmapWeeks([], NOW)
    // A year holds twelve month starts; at most a couple are skipped for
    // sitting too close to the label before them.
    expect(months.length).toBeGreaterThanOrEqual(10)
    const names = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
    for (const m of months) {
      const monday = new Date(weeks[m.week]![0]!.dayMs)
      expect(names[monday.getMonth()]).toBe(m.label)
    }
    for (let i = 1; i < months.length; i++) {
      expect(months[i]!.week - months[i - 1]!.week).toBeGreaterThanOrEqual(3)
    }
  })
})

describe('usageStats', () => {
  it('counts a run of active days up to today as the current streak', () => {
    const rows = [
      row({ id: 'a', startedAt: at(2026, 7, 16, 9) }),
      row({ id: 'b', startedAt: at(2026, 7, 17, 9) }),
      row({ id: 'c', startedAt: at(2026, 7, 18, 9) }),
    ]
    const s = usageStats(rows, NOW)
    expect(s.currentStreak).toBe(3)
    expect(s.longestStreak).toBe(3)
    expect(s.activeDays).toBe(3)
    expect(s.sessions).toBe(3)
    expect(s.totalTokens).toBe(450)
  })

  it('still counts a run that ended yesterday — today may not have started', () => {
    const rows = [15, 16, 17].map((d) => row({ id: `d${d}`, startedAt: at(2026, 7, d, 9) }))
    expect(usageStats(rows, NOW).currentStreak).toBe(3)
  })

  it('lets a gap break a streak, and a run two days old is no streak at all', () => {
    const rows = [10, 11, 12, 15, 16].map((d) => row({ id: `d${d}`, startedAt: at(2026, 7, d, 9) }))
    const s = usageStats(rows, NOW)
    expect(s.longestStreak).toBe(3)
    expect(s.currentStreak).toBe(0)
  })

  it('caps spanDays at 366 for a lone year-1 stamp, without a calendar walk', () => {
    const s = usageStats([row({ id: 'ancient', startedAt: '0001-01-01T00:00:00Z' })], NOW)
    expect(s.spanDays).toBe(366)
    expect(s.activeDays).toBe(1)
    expect(s.longestStreak).toBe(1)
    expect(s.currentStreak).toBe(0)
    // The default endedAt is fine but the start claims year 1: a two-thousand-
    // year session is a broken clock, not a record.
    expect(s.longestSessionMs).toBe(0)
  })

  it('measures spanDays from the first start to today inclusive', () => {
    expect(usageStats([row({ id: 'a', startedAt: at(2026, 7, 12, 9) })], NOW).spanDays).toBe(7)
  })

  it('picks the favorite model by tokens, not by session count', () => {
    const rows = [
      row({ id: 'a', models: ['claude-opus-4'], tokens: { input: 5, output: 5, cacheRead: 0, cacheWrite: 0 } }),
      row({ id: 'b', models: ['claude-opus-4'], tokens: { input: 5, output: 5, cacheRead: 0, cacheWrite: 0 } }),
      row({ id: 'c', models: ['claude-sonnet-4-5-20250929'], tokens: { input: 900, output: 100, cacheRead: 0, cacheWrite: 0 } }),
    ]
    expect(usageStats(rows, NOW).favoriteModel).toBe('sonnet-4-5')
    expect(usageStats([row({ id: 'x', models: [] })], NOW).favoriteModel).toBeNull()
  })

  it('names the day with the most tokens', () => {
    const rows = [
      row({
        id: 'big',
        startedAt: at(2026, 7, 16, 9),
        tokens: { input: 900, output: 100, cacheRead: 0, cacheWrite: 0 },
      }),
      row({ id: 'small', startedAt: at(2026, 7, 17, 9) }),
    ]
    expect(usageStats(rows, NOW).mostActiveDay).toBe('Aug 16')
  })

  it('takes the longest session from sane stamps only', () => {
    const rows = [
      row({
        id: 'ok',
        startedAt: at(2026, 7, 18, 9),
        endedAt: new Date(2026, 7, 18, 10, 30).toISOString(),
      }),
      row({ id: 'no-start', startedAt: 'nope', endedAt: at(2026, 7, 18, 10) }),
      row({ id: 'backwards', startedAt: at(2026, 7, 18, 10), endedAt: at(2026, 7, 18, 9) }),
    ]
    expect(usageStats(rows, NOW).longestSessionMs).toBe(90 * 60_000)
  })

  it('answers zeros and nulls for no rows at all', () => {
    expect(usageStats([], NOW)).toEqual({
      sessions: 0,
      totalTokens: 0,
      activeDays: 0,
      spanDays: 0,
      mostActiveDay: null,
      favoriteModel: null,
      longestSessionMs: 0,
      longestStreak: 0,
      currentStreak: 0,
    })
  })
})

describe('fmtDuration', () => {
  it('prints days with hours, hours with minutes, minutes alone', () => {
    expect(fmtDuration(6 * 86_400_000 + 16 * 3_600_000)).toBe('6d 16h')
    expect(fmtDuration(5 * 3_600_000 + 12 * 60_000)).toBe('5h 12m')
    expect(fmtDuration(42 * 60_000)).toBe('42m')
  })

  it('says <1m under a minute and for garbage', () => {
    expect(fmtDuration(59_999)).toBe('<1m')
    expect(fmtDuration(0)).toBe('<1m')
    expect(fmtDuration(Number.NaN)).toBe('<1m')
  })
})

describe('groupHits', () => {
  it('folds hits into per-session runs, newest session first, hits in file order', () => {
    const hits = [
      hit({ id: 'young', offset: 900, ts: at(2026, 7, 18, 10) }),
      hit({ id: 'old', offset: 10, ts: at(2026, 7, 10, 10) }),
      hit({ id: 'young', offset: 100, ts: at(2026, 7, 18, 9) }),
    ]
    const groups = groupHits(hits)
    expect(groups.map((g) => g.id)).toEqual(['young', 'old'])
    expect(groups[0]!.hits.map((h) => h.offset)).toEqual([100, 900])
    expect(groups[0]!.ts).toBe(at(2026, 7, 18, 10))
  })

  it('keeps sessions with the same id apart across machines', () => {
    const hits = [
      hit({ id: 'same', offset: 1 }),
      hit({ id: 'same', offset: 2, machineId: 'attic-pi', machineName: 'Attic Pi' }),
    ]
    expect(groupHits(hits)).toHaveLength(2)
  })

  it('adopts a title from whichever hit carries one', () => {
    const hits = [hit({ id: 'x', offset: 1 }), hit({ id: 'x', offset: 2, title: 'Found it' })]
    expect(groupHits(hits)[0]!.title).toBe('Found it')
  })

  it('sorts stampless sessions after stamped ones, deterministically', () => {
    const hits = [
      hit({ id: 'blank-b', offset: 1 }),
      hit({ id: 'stamped', offset: 1, ts: at(2026, 7, 18, 9) }),
      hit({ id: 'blank-a', offset: 1 }),
    ]
    expect(groupHits(hits).map((g) => g.id)).toEqual(['stamped', 'blank-a', 'blank-b'])
  })
})

describe('keyMessages', () => {
  const msg = (offset: number, kind: AgentMessage['kind'] = 'text'): AgentMessage => ({
    role: 'assistant',
    kind,
    text: 'x',
    offset,
  })

  it('numbers a run of messages sharing one source line', () => {
    const keyed = keyMessages([msg(0, 'thinking'), msg(0, 'text'), msg(0, 'tool_call'), msg(64)])
    expect(keyed.map((m) => m.key)).toEqual(['0:0', '0:1', '0:2', '64:0'])
  })

  it('gives every distinct offset its own :0', () => {
    const keyed = keyMessages([msg(0), msg(120), msg(480)])
    expect(keyed.map((m) => m.key)).toEqual(['0:0', '120:0', '480:0'])
  })

  it('keeps the message itself intact beside the key', () => {
    const keyed = keyMessages([msg(7, 'tool_result')])
    expect(keyed[0]).toEqual({ ...msg(7, 'tool_result'), key: '7:0' })
  })

  it('leaves keys unchanged when two pages join at a line boundary', () => {
    // A line's messages never split across pages, so keying page by page and
    // joining must equal keying the joined whole — in either join order.
    const all = [msg(0, 'thinking'), msg(0, 'text'), msg(40), msg(80, 'tool_call'), msg(80, 'tool_result')]
    const head = all.slice(0, 2)
    const tail = all.slice(2)
    expect([...keyMessages(head), ...keyMessages(tail)]).toEqual(keyMessages(all))
  })

  it('answers nothing for an empty page', () => {
    expect(keyMessages([])).toEqual([])
  })
})

describe('retryMissingTranscript', () => {
  it('retries while the index has not settled and the budget holds', () => {
    expect(retryMissingTranscript(false, 1_000, 2_000)).toBe(true)
  })

  it('believes the absence once the index settled', () => {
    expect(retryMissingTranscript(true, 1_000, 2_000)).toBe(false)
  })

  it('gives up once the budget is spent, settled or not', () => {
    expect(retryMissingTranscript(false, 0, 59_999)).toBe(true)
    expect(retryMissingTranscript(false, 0, 60_000)).toBe(false)
  })

  it('honours a caller-set budget', () => {
    expect(retryMissingTranscript(false, 0, 5_000, 4_000)).toBe(false)
    expect(retryMissingTranscript(false, 0, 3_999, 4_000)).toBe(true)
  })
})

describe('splitSnippet', () => {
  it('finds the query case-insensitively and hands back the three parts', () => {
    expect(splitSnippet('Fix the Tailwind build', 'tailwind')).toEqual({
      before: 'Fix the ',
      match: 'Tailwind',
      after: ' build',
    })
  })

  it('answers null for a blank query or an absent match', () => {
    expect(splitSnippet('anything', '')).toBeNull()
    expect(splitSnippet('anything', '   ')).toBeNull()
    expect(splitSnippet('anything', 'zebra')).toBeNull()
  })

  it('matches the trimmed query, as the search box sends it', () => {
    expect(splitSnippet('a zebra crossing', ' zebra ')).toEqual({
      before: 'a ',
      match: 'zebra',
      after: ' crossing',
    })
  })
})

// ---------------------------------------------------------------------------
// Backfill history and tombstones.

function hist(over: Partial<HistoryDayRow> & { date: string; sessions: number }): HistoryDayRow {
  return { tool: 'claude', machineId: 'local', ...over }
}

describe('historyDayMs', () => {
  it('reads a date in the local calendar', () => {
    expect(historyDayMs('2026-08-18')).toBe(new Date(2026, 7, 18).getTime())
  })
  it('is NaN for anything that is not YYYY-MM-DD', () => {
    expect(Number.isNaN(historyDayMs('yesterday'))).toBe(true)
    expect(Number.isNaN(historyDayMs('2026-8-18'))).toBe(true)
  })
})

describe('filterHistory', () => {
  const days = [
    hist({ date: '2026-08-01', sessions: 3 }),
    hist({ date: '2026-08-02', sessions: 1, tool: 'codex', machineId: 'remote' }),
  ]
  it('admits everything when no chips narrow', () => {
    expect(filterHistory(days)).toHaveLength(2)
    expect(filterHistory(days, { tools: new Set(), machines: new Set() })).toHaveLength(2)
  })
  it('narrows by tool and machine the way filterRows does', () => {
    expect(filterHistory(days, { tools: new Set(['claude'] as const) })).toHaveLength(1)
    expect(filterHistory(days, { machines: new Set(['remote']) })).toHaveLength(1)
  })
})

describe('rangeFilterHistory', () => {
  it('keeps the calendar window and drops the rest', () => {
    const days = [
      hist({ date: '2026-08-18', sessions: 1 }),
      hist({ date: '2026-08-12', sessions: 2 }),
      hist({ date: '2026-08-11', sessions: 3 }),
      hist({ date: '2026-08-19', sessions: 4 }), // tomorrow: not yet a day
    ]
    const kept = rangeFilterHistory(days, '7d', NOW)
    expect(kept.map((h) => h.date)).toEqual(['2026-08-18', '2026-08-12'])
    expect(rangeFilterHistory(days, 'all', NOW)).toHaveLength(3)
  })
})

describe('mergedSessions', () => {
  it('takes the larger claim per machine, tool and day, never the sum', () => {
    const rows = [
      row({ id: 'a', startedAt: at(2026, 7, 18, 9) }),
      row({ id: 'b', startedAt: at(2026, 7, 18, 11) }),
    ]
    // The backfill remembers 5 sessions that day — stubs included — so 5
    // stands; 2 + 5 would bill the two indexed ones twice.
    expect(mergedSessions(rows, [hist({ date: '2026-08-18', sessions: 5 })])).toBe(5)
    // The index winning the same comparison also stands.
    expect(mergedSessions(rows, [hist({ date: '2026-08-18', sessions: 1 })])).toBe(2)
  })
  it('keeps machines, tools and days apart', () => {
    const rows = [row({ id: 'a', startedAt: at(2026, 7, 18, 9) })]
    const days = [
      hist({ date: '2026-08-18', sessions: 2, machineId: 'remote' }),
      hist({ date: '2026-08-17', sessions: 3 }),
    ]
    expect(mergedSessions(rows, days)).toBe(1 + 2 + 3)
  })
})

describe('insightTotals with backfill', () => {
  it('merges the session count and leaves every token figure alone', () => {
    const rows = [row({ id: 'a', startedAt: at(2026, 7, 18, 9) })]
    const totals = insightTotals(rows, [hist({ date: '2026-08-10', sessions: 4 })])
    expect(totals.sessions).toBe(5)
    expect(totals.input).toBe(100)
    expect(totals.output).toBe(50)
  })
})

describe('sessionsByDay with backfill', () => {
  it('charts remembered days and stretches the span back to them', () => {
    const rows = [row({ id: 'a', startedAt: at(2026, 7, 18, 9) })]
    const days = sessionsByDay(rows, NOW, [hist({ date: '2026-08-10', sessions: 6 })])
    expect(days[0]!.dayMs).toBe(new Date(2026, 7, 10).getTime())
    expect(days[0]!.byTool.claude).toBe(6)
    expect(days.at(-1)!.byTool.claude).toBe(1)
  })
  it('takes the larger claim on a day both witness', () => {
    const rows = [
      row({ id: 'a', startedAt: at(2026, 7, 18, 9) }),
      row({ id: 'b', startedAt: at(2026, 7, 18, 11) }),
    ]
    const days = sessionsByDay(rows, NOW, [hist({ date: '2026-08-18', sessions: 5 })])
    expect(days.at(-1)!.byTool.claude).toBe(5)
  })
})

describe('tokensByDay with backfill', () => {
  it('stretches the span but keeps remembered days at zero tokens', () => {
    const rows = [row({ id: 'a', startedAt: at(2026, 7, 18, 9) })]
    const days = tokensByDay(rows, NOW, [hist({ date: '2026-08-10', sessions: 6 })])
    expect(days[0]!.dayMs).toBe(new Date(2026, 7, 10).getTime())
    expect(days[0]!.total).toBe(0)
    expect(days.at(-1)!.total).toBe(150)
  })
})

describe('usageStats with backfill', () => {
  it('counts remembered days as active and lets them carry a streak', () => {
    const rows = [row({ id: 'a', startedAt: at(2026, 7, 18, 9) })]
    const days = [
      hist({ date: '2026-08-16', sessions: 2 }),
      hist({ date: '2026-08-17', sessions: 1 }),
    ]
    const usage = usageStats(rows, NOW, days)
    expect(usage.activeDays).toBe(3)
    expect(usage.longestStreak).toBe(3)
    expect(usage.currentStreak).toBe(3)
    expect(usage.sessions).toBe(4)
    // The token facts stay the transcripts' own.
    expect(usage.totalTokens).toBe(150)
    expect(usage.mostActiveDay).toBe('Aug 18')
  })
})

describe('heatmapWeeks with backfill', () => {
  it('paints a remembered day at the faintest level and leaves ranked days ranked', () => {
    const rows = [row({ id: 'a', startedAt: at(2026, 7, 18, 9) })]
    const { weeks } = heatmapWeeks(rows, NOW, [hist({ date: '2026-08-10', sessions: 3 })])
    const cells = weeks.flat()
    const remembered = cells.find((c) => c.dayMs === new Date(2026, 7, 10).getTime())!
    const measured = cells.find((c) => c.dayMs === new Date(2026, 7, 18).getTime())!
    expect(remembered.level).toBe(1)
    expect(remembered.tokens).toBe(0)
    expect(measured.level).toBe(4)
  })
  it('never dims a day the transcripts already measured', () => {
    const rows = [row({ id: 'a', startedAt: at(2026, 7, 18, 9) })]
    const { weeks } = heatmapWeeks(rows, NOW, [hist({ date: '2026-08-18', sessions: 9 })])
    const cell = weeks.flat().find((c) => c.dayMs === new Date(2026, 7, 18).getTime())!
    expect(cell.level).toBe(4)
    expect(cell.tokens).toBe(150)
  })
})

describe('applyAgentView with tombstones', () => {
  it('keeps a pruned transcript out of the list', () => {
    const rows = [row({ id: 'kept' }), row({ id: 'pruned', missing: true })]
    const groups = applyAgentView(rows, DEFAULT_AGENT_VIEW, {}, NOW)
    const listed = groups.flatMap((g) => g.rows.map((r) => r.id))
    expect(listed).toEqual(['kept'])
  })
  it('still counts it in the insights', () => {
    const rows = [row({ id: 'pruned', missing: true })]
    expect(insightTotals(rows).sessions).toBe(1)
    expect(usageStats(rows, NOW).activeDays).toBe(1)
  })
})
