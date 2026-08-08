import { describe, expect, it } from 'vitest'

import type { FleetSession } from '@/fleet/types'
import {
  applyView,
  COLUMN_KEYS,
  DEFAULT_VIEW,
  displayName,
  filterSessions,
  GROUPINGS,
  groupSessions,
  ORDERINGS,
  orderSessions,
} from './view'

/**
 * One session, with everything a caller did not care about filled in.
 *
 * Defaults are deliberately inert — no name, no title, no tags, unpinned, one
 * directory, one machine, one instant — so that whatever a case overrides is
 * the only thing that can explain its result.
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
    machineName: 'MacBook Pro',
    ...over,
  }
}

/** The ids of a list, which is all any ordering assertion is really about. */
function ids(list: FleetSession[]): string[] {
  return list.map((x) => x.id)
}

describe('displayName', () => {
  const cases: Array<{ what: string; session: FleetSession; want: string }> = [
    {
      what: 'the human name outranks everything',
      session: s({ name: 'api server', title: 'vim', cwd: '/code/flue', cmd: ['zsh'] }),
      want: 'api server',
    },
    {
      what: 'the scraped title, when nobody has named it',
      session: s({ title: 'vim README.md', cwd: '/code/flue', cmd: ['zsh'] }),
      want: 'vim README.md',
    },
    {
      what: 'the last segment of the directory, when the title is empty too',
      session: s({ cwd: '/code/flue/web', cmd: ['zsh'] }),
      want: 'web',
    },
    {
      what: 'the command, when there is no directory to name it after',
      session: s({ cwd: '', cmd: ['go', 'test', './...'] }),
      want: 'go test ./...',
    },
  ]

  for (const { what, session, want } of cases) {
    it(what, () => {
      expect(displayName(session)).toBe(want)
    })
  }

  it('calls the root directory by its own name', () => {
    // '/' has no last segment, and falling through to the command would name
    // every root session after its shell.
    expect(displayName(s({ cwd: '/', cmd: ['zsh'] }))).toBe('/')
  })

  it('ignores a trailing separator', () => {
    expect(displayName(s({ cwd: '/code/flue/web/' }))).toBe('web')
  })

  it('is the empty string when a session has nothing at all to be called', () => {
    expect(displayName(s({ cwd: '', cmd: [] }))).toBe('')
  })
})

describe('filterSessions', () => {
  const rows = [
    s({ id: 'a', name: 'api server', cwd: '/code/flue', tags: ['feat-x'], machineName: 'Attic Pi' }),
    s({ id: 'b', title: 'vim README', cwd: '/srv/db', tags: ['ops'], machineName: 'Home Box' }),
  ]

  const cases: Array<{ what: string; search: string; want: string[] }> = [
    { what: 'an empty search keeps everything', search: '', want: ['a', 'b'] },
    { what: 'whitespace alone is an empty search', search: '   ', want: ['a', 'b'] },
    { what: 'matches the name a row shows', search: 'api', want: ['a'] },
    { what: 'matches a title a row shows', search: 'readme', want: ['b'] },
    { what: 'matches the directory', search: '/srv', want: ['b'] },
    { what: 'matches a tag', search: 'feat-x', want: ['a'] },
    { what: 'matches the machine', search: 'home', want: ['b'] },
    { what: 'is case-insensitive on the query', search: 'API', want: ['a'] },
    { what: 'is case-insensitive on the field', search: 'attic', want: ['a'] },
    { what: 'matches inside a word, not just at its start', search: 'erver', want: ['a'] },
    { what: 'is empty when nothing matches', search: 'nothing here', want: [] },
  ]

  for (const { what, search, want } of cases) {
    it(what, () => {
      expect(ids(filterSessions(rows, search))).toEqual(want)
    })
  }

  it('leaves the order it was handed alone', () => {
    const reversed = [rows[1]!, rows[0]!]
    expect(ids(filterSessions(reversed, ''))).toEqual(['b', 'a'])
  })

  it('does not touch the list it was given', () => {
    const input = [...rows]
    filterSessions(input, 'api')
    expect(input).toEqual(rows)
  })
})

describe('orderSessions', () => {
  it('floats the pinned to the top under every ordering', () => {
    // The unpinned row wins on all four keys — later, newer, alphabetically
    // first, and first by directory — so only the pin can explain the result.
    const pinned = s({
      id: 'pinned',
      name: 'zeta',
      cwd: '/z',
      pinned: true,
      lastActive: '2026-01-01T00:00:00Z',
      createdAt: '2026-01-01T00:00:00Z',
    })
    const loud = s({
      id: 'loud',
      name: 'alpha',
      cwd: '/a',
      lastActive: '2026-06-01T00:00:00Z',
      createdAt: '2026-06-01T00:00:00Z',
    })

    for (const ordering of ORDERINGS) {
      expect(ids(orderSessions([loud, pinned], ordering)), ordering).toEqual(['pinned', 'loud'])
    }
  })

  it('orders the pinned among themselves by the same key', () => {
    const later = s({ id: 'later', pinned: true, cwd: '/b', lastActive: '2026-01-01T00:05:00Z' })
    const earlier = s({ id: 'earlier', pinned: true, cwd: '/a', lastActive: '2026-01-01T00:00:00Z' })
    expect(ids(orderSessions([earlier, later], 'lastActive'))).toEqual(['later', 'earlier'])
  })

  describe('by last active', () => {
    it('treats stamps inside one 30s bucket as equally recent', () => {
      // Five seconds apart, both inside [00:00:00, 00:00:30) — so the
      // directory decides, and a byte written to either pty cannot reshuffle
      // the two rows under the reader's pointer.
      const zulu = s({ id: 'zulu', cwd: '/z', lastActive: '2026-01-01T00:00:10Z' })
      const alpha = s({ id: 'alpha', cwd: '/a', lastActive: '2026-01-01T00:00:05Z' })
      expect(ids(orderSessions([zulu, alpha], 'lastActive'))).toEqual(['alpha', 'zulu'])
    })

    it('puts the genuinely more recent first once the buckets differ', () => {
      // Forty seconds apart: :10 lands in the first bucket, :50 in the second.
      const zulu = s({ id: 'zulu', cwd: '/z', lastActive: '2026-01-01T00:00:50Z' })
      const alpha = s({ id: 'alpha', cwd: '/a', lastActive: '2026-01-01T00:00:10Z' })
      expect(ids(orderSessions([alpha, zulu], 'lastActive'))).toEqual(['zulu', 'alpha'])
    })

    it('breaks a tie in one directory by id', () => {
      const second = s({ id: 'b2', cwd: '/code', lastActive: '2026-01-01T00:00:10Z' })
      const first = s({ id: 'a1', cwd: '/code', lastActive: '2026-01-01T00:00:20Z' })
      expect(ids(orderSessions([second, first], 'lastActive'))).toEqual(['a1', 'b2'])
    })

    it('sorts a stamp no Date can read by directory rather than throwing', () => {
      const broken = s({ id: 'broken', cwd: '/z', lastActive: 'not a time' })
      const fine = s({ id: 'fine', cwd: '/a', lastActive: '2026-01-01T00:00:00Z' })
      expect(ids(orderSessions([broken, fine], 'lastActive'))).toEqual(['fine', 'broken'])
    })
  })

  describe('by created', () => {
    it('puts the newest first, to the second', () => {
      // No bucketing here: createdAt is stamped once and never moves, so
      // there is no churn to absorb.
      const old = s({ id: 'old', cwd: '/a', createdAt: '2026-01-01T00:00:00Z' })
      const fresh = s({ id: 'fresh', cwd: '/z', createdAt: '2026-01-01T00:00:01Z' })
      expect(ids(orderSessions([old, fresh], 'created'))).toEqual(['fresh', 'old'])
    })

    it('breaks a tie by directory, then id', () => {
      const zulu = s({ id: 'z', cwd: '/z' })
      const alphaTwo = s({ id: 'a2', cwd: '/a' })
      const alphaOne = s({ id: 'a1', cwd: '/a' })
      expect(ids(orderSessions([zulu, alphaTwo, alphaOne], 'created'))).toEqual(['a1', 'a2', 'z'])
    })
  })

  describe('by name', () => {
    it('reads alphabetically, on the same name the row shows', () => {
      const titled = s({ id: 'titled', title: 'build', cwd: '/z' })
      const named = s({ id: 'named', name: 'api', cwd: '/y' })
      const bare = s({ id: 'bare', cwd: '/code/zzz' })
      expect(ids(orderSessions([bare, titled, named], 'name'))).toEqual(['named', 'titled', 'bare'])
    })

    it('breaks a tie by directory, then id', () => {
      const one = s({ id: 'a1', name: 'same', cwd: '/a' })
      const two = s({ id: 'a2', name: 'same', cwd: '/a' })
      const other = s({ id: 'b', name: 'same', cwd: '/b' })
      expect(ids(orderSessions([other, two, one], 'name'))).toEqual(['a1', 'a2', 'b'])
    })
  })

  describe('by directory', () => {
    it('reads alphabetically by directory, ties broken by id', () => {
      const deep = s({ id: 'deep', cwd: '/code/flue/web' })
      const shallowTwo = s({ id: 'b', cwd: '/code/flue' })
      const shallowOne = s({ id: 'a', cwd: '/code/flue' })
      expect(ids(orderSessions([deep, shallowTwo, shallowOne], 'directory'))).toEqual([
        'a',
        'b',
        'deep',
      ])
    })
  })

  it('answers with a new list and leaves the caller’s alone', () => {
    const input = [s({ id: 'z', cwd: '/z' }), s({ id: 'a', cwd: '/a' })]
    const out = orderSessions(input, 'directory')
    expect(ids(input)).toEqual(['z', 'a'])
    expect(out).not.toBe(input)
  })
})

describe('groupSessions', () => {
  it('is one unlabelled heap when grouping is off', () => {
    const rows = [s({ id: 'a' }), s({ id: 'b' })]
    const groups = groupSessions(rows, 'none')
    expect(groups).toHaveLength(1)
    expect(groups[0]!.key).toBe('all')
    expect(ids(groups[0]!.sessions)).toEqual(['a', 'b'])
  })

  it('has no groups at all for no sessions, whatever the grouping', () => {
    for (const grouping of GROUPINGS) {
      expect(groupSessions([], grouping), grouping).toEqual([])
    }
  })

  describe('by machine', () => {
    const rows = [
      s({ id: 'z', machineId: 'zeta', machineName: 'zeta box' }),
      s({ id: 'l', machineId: 'local', machineName: 'MacBook Pro' }),
      s({ id: 'a', machineId: 'attic', machineName: 'attic pi' }),
    ]

    it('leads with the machine this tab is riding, then reads alphabetically', () => {
      const groups = groupSessions(rows, 'machine')
      expect(groups.map((g) => g.label)).toEqual(['MacBook Pro', 'attic pi', 'zeta box'])
    })

    it('keys by machine id, so two machines sharing a name stay apart', () => {
      const twins = [
        s({ id: 'one', machineId: 'attic', machineName: 'pi' }),
        s({ id: 'two', machineId: 'shed', machineName: 'pi' }),
      ]
      const groups = groupSessions(twins, 'machine')
      expect(groups.map((g) => g.key)).toEqual(['machine:attic', 'machine:shed'])
    })

    it('keeps the order it was handed inside a group', () => {
      const pair = [
        s({ id: 'second', machineId: 'attic', machineName: 'attic pi' }),
        s({ id: 'first', machineId: 'attic', machineName: 'attic pi' }),
      ]
      expect(ids(groupSessions(pair, 'machine')[0]!.sessions)).toEqual(['second', 'first'])
    })
  })

  describe('by state', () => {
    it('puts the live sessions ahead of the ended ones', () => {
      const rows = [
        s({ id: 'gone', state: 'exited', exitCode: 1 }),
        s({ id: 'live', state: 'running' }),
      ]
      const groups = groupSessions(rows, 'state')
      expect(groups.map((g) => g.key)).toEqual(['state:running', 'state:exited'])
      expect(groups.map((g) => g.label)).toEqual(['Running', 'Exited'])
      expect(ids(groups[0]!.sessions)).toEqual(['live'])
      expect(ids(groups[1]!.sessions)).toEqual(['gone'])
    })

    it('leaves out a state nothing is in', () => {
      const groups = groupSessions([s({ id: 'live' })], 'state')
      expect(groups.map((g) => g.key)).toEqual(['state:running'])
    })
  })

  describe('by tag', () => {
    const rows = [
      s({ id: 'both', tags: ['ops', 'api'] }),
      s({ id: 'one', tags: ['api'] }),
      s({ id: 'none', tags: [] }),
    ]

    it('lists tags alphabetically and shows a session under each of its own', () => {
      const groups = groupSessions(rows, 'tag')
      expect(groups.map((g) => g.key)).toEqual(['tag:api', 'tag:ops', 'untagged'])
      expect(ids(groups[0]!.sessions)).toEqual(['both', 'one'])
      expect(ids(groups[1]!.sessions)).toEqual(['both'])
    })

    it('sweeps the untagged into one bucket at the end', () => {
      const groups = groupSessions(rows, 'tag')
      const last = groups[groups.length - 1]!
      expect(last.label).toBe('No tag')
      expect(ids(last.sessions)).toEqual(['none'])
    })

    it('has no bucket for the untagged when every session carries a tag', () => {
      const groups = groupSessions([s({ id: 'one', tags: ['api'] })], 'tag')
      expect(groups.map((g) => g.key)).toEqual(['tag:api'])
    })

    it('cannot have a real tag collide with the untagged bucket', () => {
      const groups = groupSessions([s({ id: 'odd', tags: ['untagged'] })], 'tag')
      expect(groups.map((g) => g.key)).toEqual(['tag:untagged'])
    })
  })

  describe('by directory', () => {
    it('is one group per directory, alphabetically', () => {
      const rows = [
        s({ id: 'z', cwd: '/srv/db' }),
        s({ id: 'a', cwd: '/code/flue' }),
        s({ id: 'b', cwd: '/code/flue' }),
      ]
      const groups = groupSessions(rows, 'directory')
      expect(groups.map((g) => g.key)).toEqual(['dir:/code/flue', 'dir:/srv/db'])
      expect(groups.map((g) => g.label)).toEqual(['/code/flue', '/srv/db'])
      expect(ids(groups[0]!.sessions)).toEqual(['a', 'b'])
    })
  })

  it('gives every group a key no other group can claim', () => {
    const rows = [
      s({ id: 'a', cwd: '/code', tags: ['api'], machineId: 'attic', state: 'running' }),
      s({ id: 'b', cwd: '/srv', tags: [], machineId: 'local', state: 'exited' }),
    ]
    const keys = GROUPINGS.flatMap((g) => groupSessions(rows, g).map((group) => group.key))
    expect(new Set(keys).size).toBe(keys.length)
  })
})

describe('DEFAULT_VIEW', () => {
  it('groups by machine, orders by last active, and searches for nothing', () => {
    expect(DEFAULT_VIEW.grouping).toBe('machine')
    expect(DEFAULT_VIEW.ordering).toBe('lastActive')
    expect(DEFAULT_VIEW.search).toBe('')
    expect(DEFAULT_VIEW.showExited).toBe(true)
  })

  it('shows every column but the creation time', () => {
    expect(DEFAULT_VIEW.columns).toEqual(COLUMN_KEYS.filter((c) => c !== 'created'))
    expect(DEFAULT_VIEW.columns).not.toContain('created')
  })
})

describe('applyView', () => {
  const rows = [
    s({ id: 'live', cwd: '/code/flue', machineId: 'local', machineName: 'MacBook Pro' }),
    s({
      id: 'gone',
      cwd: '/srv/db',
      state: 'exited',
      exitCode: 0,
      machineId: 'attic',
      machineName: 'attic pi',
    }),
  ]

  it('keeps the ended sessions when the view says to', () => {
    const groups = applyView(rows, { ...DEFAULT_VIEW, showExited: true })
    expect(groups.flatMap((g) => ids(g.sessions)).sort()).toEqual(['gone', 'live'])
  })

  it('drops the ended sessions when the view says not to', () => {
    const groups = applyView(rows, { ...DEFAULT_VIEW, showExited: false })
    expect(groups.flatMap((g) => ids(g.sessions))).toEqual(['live'])
    // And the machine that had only ended sessions leaves with them.
    expect(groups.map((g) => g.key)).toEqual(['machine:local'])
  })

  it('searches, then orders, then groups', () => {
    const many = [
      s({ id: 'zulu', cwd: '/code/z', tags: ['api'], lastActive: '2026-01-01T00:00:00Z' }),
      s({ id: 'alpha', cwd: '/code/a', tags: ['api'], lastActive: '2026-01-01T00:00:05Z' }),
      s({ id: 'other', cwd: '/code/b', tags: ['ops'] }),
    ]
    const groups = applyView(many, {
      ...DEFAULT_VIEW,
      grouping: 'tag',
      ordering: 'lastActive',
      search: 'code/',
    })
    expect(groups.map((g) => g.key)).toEqual(['tag:api', 'tag:ops'])
    // One 30s bucket holds both api rows, so the directory settles them.
    expect(ids(groups[0]!.sessions)).toEqual(['alpha', 'zulu'])
  })

  it('is no groups at all when the search matches nothing', () => {
    expect(applyView(rows, { ...DEFAULT_VIEW, search: 'nothing here' })).toEqual([])
  })

  it('leaves the fleet’s own list untouched', () => {
    const input = [...rows]
    applyView(input, DEFAULT_VIEW)
    expect(input).toEqual(rows)
  })
})
