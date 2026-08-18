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
  filterRows,
  groupHits,
  groupRows,
  insightTotals,
  keyMessages,
  latestModel,
  orderRows,
  rangeFilter,
  retryMissingTranscript,
  rowKey,
  rowTokens,
  sessionsByDay,
  shortModel,
  splitSnippet,
  tokensByDay,
  type AgentHitRow,
  type AgentRow,
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
})

describe('sessionsByDay', () => {
  it('counts starts per day across the same zero-filled span', () => {
    const rows = [
      row({ id: 'a', startedAt: at(2026, 7, 17, 9) }),
      row({ id: 'b', startedAt: at(2026, 7, 17, 20) }),
      row({ id: 'c', startedAt: at(2026, 7, 18, 9) }),
    ]
    const days = sessionsByDay(rows, NOW)
    expect(days.map((d) => d.count)).toEqual([2, 1])
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
