import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { DEFAULT_VIEW } from './view'
import {
  deleteView,
  listViews,
  loadCurrent,
  saveCurrent,
  saveView,
  type SavedView,
} from './views-store'

/** Written out rather than imported, so the key itself is part of the pin. */
const VIEWS_KEY = 'flue.views'

const WORK: SavedView = { ...DEFAULT_VIEW, name: 'Work', search: 'flue' }
const OPS: SavedView = {
  ...DEFAULT_VIEW,
  name: 'Ops',
  grouping: 'tag',
  ordering: 'name',
  columns: ['name', 'state'],
  showExited: false,
}

/** What a hand edit, an extension or a half-shipped migration left behind. */
function stored(value: unknown): void {
  localStorage.setItem(VIEWS_KEY, JSON.stringify(value))
}

beforeEach(() => {
  localStorage.clear()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('listViews and saveView', () => {
  it('round-trips a view', () => {
    saveView(WORK)
    expect(listViews()).toEqual([WORK])
  })

  it('is empty in a browser that never saved one', () => {
    expect(listViews()).toEqual([])
  })

  it('keeps them in the order they were written', () => {
    saveView(WORK)
    saveView(OPS)
    expect(listViews().map((v) => v.name)).toEqual(['Work', 'Ops'])
  })

  it('keeps one view per name, the newest', () => {
    saveView(WORK)
    saveView({ ...WORK, search: 'db' })
    expect(listViews()).toEqual([{ ...WORK, search: 'db' }])
  })

  it('leaves an edited view where it was, rather than moving it to the end', () => {
    // These are shown as tabs, and a tab that hops to the far end because
    // somebody changed its ordering would move the target as it was clicked.
    saveView(WORK)
    saveView(OPS)
    saveView({ ...WORK, search: 'db' })
    expect(listViews().map((v) => v.name)).toEqual(['Work', 'Ops'])
  })

  it('tells two names apart by case', () => {
    saveView(WORK)
    saveView({ ...WORK, name: 'work' })
    expect(listViews().map((v) => v.name)).toEqual(['Work', 'work'])
  })

  it('refuses a name that is nothing but blanks', () => {
    // listViews drops such a row, so accepting the write would put a tab on
    // screen that is gone at the next load — the same outcome a swallowed
    // quota error gives, and refused here for the same reason.
    expect(() => saveView({ ...WORK, name: '   ' })).toThrow()
    expect(listViews()).toEqual([])
  })

  it('leaves the views it already kept alone when it refuses one', () => {
    saveView(WORK)
    expect(() => saveView({ ...OPS, name: ' ' })).toThrow()
    expect(listViews()).toEqual([WORK])
  })

  it('lets a write failure reach the caller', () => {
    // Storage full, or a browser that refuses it: the caller is the one that
    // can say "that did not save", and a swallowed error would leave a tab on
    // screen that vanishes at the next load.
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota')
    })
    expect(() => saveView(WORK)).toThrow()
  })
})

describe('listViews on a store it cannot believe', () => {
  it('reads unparseable storage as no views at all', () => {
    for (const raw of ['not json', '{"a":1}', '"a string"', '42', 'null']) {
      localStorage.setItem(VIEWS_KEY, raw)
      expect(listViews(), raw).toEqual([])
    }
  })

  it('reads a storage the browser will not open as no views at all', () => {
    // Private modes exist, and a saved-view tab strip is not worth an
    // exception at the entry point.
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied')
    })
    expect(listViews()).toEqual([])
  })

  const rotten: Array<{ what: string; row: unknown }> = [
    { what: 'a row that is not an object', row: 'Work' },
    { what: 'a null row', row: null },
    { what: 'a nameless row', row: { ...DEFAULT_VIEW } },
    { what: 'a row named with a number', row: { ...DEFAULT_VIEW, name: 7 } },
    { what: 'a row with an empty name', row: { ...DEFAULT_VIEW, name: '' } },
    { what: 'a row named with nothing but blanks', row: { ...DEFAULT_VIEW, name: '   ' } },
    { what: 'a grouping nothing groups by', row: { ...WORK, grouping: 'folder' } },
    { what: 'a second grouping nothing groups by', row: { ...WORK, subgrouping: 'folder' } },
    { what: 'an ordering nothing orders by', row: { ...WORK, ordering: 'size' } },
    { what: 'a direction nothing reads in', row: { ...WORK, direction: 'sideways' } },
    { what: 'a search that is not text', row: { ...WORK, search: 3 } },
    { what: 'columns that are not a list', row: { ...WORK, columns: 'name' } },
    { what: 'a column no row has', row: { ...WORK, columns: ['name', 'colour'] } },
    { what: 'a column that is not text', row: { ...WORK, columns: [1] } },
    { what: 'a show-exited that is not a yes or a no', row: { ...WORK, showExited: 'yes' } },
  ]

  for (const { what, row } of rotten) {
    it(`drops ${what}, and keeps the rows around it`, () => {
      stored([OPS, row, WORK])
      expect(listViews()).toEqual([OPS, WORK])
    })
  }

  it('carries no property out that it did not ask for', () => {
    stored([{ ...WORK, injected: 'not mine' }])
    expect(listViews()).toEqual([WORK])
    expect(Object.keys(listViews()[0]!).sort()).toEqual(Object.keys(WORK).sort())
  })

  it('reads a view saved before directions existed in its ordering’s own', () => {
    // Views written by older builds carry no direction at all, and a browser
    // that loses its tabs to an upgrade reads that as data loss. They come
    // back reading the way that build showed them: the key's natural way.
    const { direction: _work, ...oldWork } = WORK
    const { direction: _ops, ...oldOps } = OPS
    stored([oldWork, oldOps])
    expect(listViews()).toEqual([
      { ...WORK, direction: 'desc' },
      { ...OPS, direction: 'asc' },
    ])
  })

  it('reads a view saved before second groupings existed as cut once', () => {
    // Same bargain as the direction: what that build showed was one cut, and
    // a saved tab someone arranged must not grow subheadings on the day this
    // ships. The default for a fresh browser is another matter (DEFAULT_VIEW).
    const { subgrouping: _, ...old } = OPS
    stored([old])
    expect(listViews()).toEqual([{ ...OPS, subgrouping: 'none' }])
  })

  it('round-trips a view cut twice', () => {
    const nested: SavedView = { ...WORK, grouping: 'machine', subgrouping: 'tag' }
    saveView(nested)
    expect(listViews()).toEqual([nested])
  })
})

describe('deleteView', () => {
  it('removes the view by name and leaves the rest', () => {
    saveView(WORK)
    saveView(OPS)
    deleteView('Work')
    expect(listViews()).toEqual([OPS])
  })

  it('succeeds on a name that was never saved', () => {
    saveView(WORK)
    deleteView('Nothing')
    expect(listViews()).toEqual([WORK])
  })

  it('succeeds on an empty store', () => {
    expect(() => deleteView('Work')).not.toThrow()
    expect(listViews()).toEqual([])
  })
})

describe('the current arrangement', () => {
  /** Written out rather than imported, so the key itself is part of the pin. */
  const CURRENT_KEY = 'flue.view.current'

  it('round-trips the arrangement and the pressed tab', () => {
    saveView(OPS)
    saveCurrent({ ...DEFAULT_VIEW, grouping: 'state', columns: [...DEFAULT_VIEW.columns] }, 'Ops')

    const kept = loadCurrent()
    expect(kept.view.grouping).toBe('state')
    expect(kept.active).toBe('Ops')
  })

  it('opens on the default in a browser that never arranged anything', () => {
    expect(loadCurrent()).toEqual({ view: DEFAULT_VIEW, active: null })
  })

  it('hands out its own columns array, never the frozen default one', () => {
    // DEFAULT_VIEW is frozen; a caller editing what this returns must get a
    // TypeError never, and must not be editing the shared default either.
    const kept = loadCurrent()
    expect(() => kept.view.columns.push('created')).not.toThrow()
    expect(DEFAULT_VIEW.columns).not.toContain('created')
  })

  it('reads a record it cannot believe as the default, whole', () => {
    // Unlike the saved views there is no per-row salvage here: half an
    // arrangement is nothing the screen can show.
    const rotten = [
      'not json',
      '"a string"',
      'null',
      JSON.stringify({ active: 'Ops' }),
      JSON.stringify({ view: { ...DEFAULT_VIEW, grouping: 'folder' }, active: null }),
      JSON.stringify({ view: { ...DEFAULT_VIEW, subgrouping: 'folder' }, active: null }),
      JSON.stringify({ view: { ...DEFAULT_VIEW, direction: 'sideways' }, active: null }),
      JSON.stringify({ view: { ...DEFAULT_VIEW, columns: ['name', 'colour'] }, active: null }),
      JSON.stringify({ view: { ...DEFAULT_VIEW, showExited: 'yes' }, active: null }),
    ]
    for (const raw of rotten) {
      localStorage.setItem(CURRENT_KEY, raw)
      expect(loadCurrent(), raw).toEqual({ view: DEFAULT_VIEW, active: null })
    }
  })

  it('reads a storage the browser will not open as the default', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied')
    })
    expect(loadCurrent()).toEqual({ view: DEFAULT_VIEW, active: null })
  })

  it('reads an arrangement saved before directions existed in its ordering’s own', () => {
    const { direction: _, ...old } = { ...DEFAULT_VIEW, ordering: 'name' as const }
    localStorage.setItem(CURRENT_KEY, JSON.stringify({ view: old, active: null }))
    expect(loadCurrent().view).toEqual({ ...DEFAULT_VIEW, ordering: 'name', direction: 'asc' })
  })

  it('reads an arrangement saved before second groupings existed as cut once', () => {
    const { subgrouping: _, ...old } = DEFAULT_VIEW
    localStorage.setItem(CURRENT_KEY, JSON.stringify({ view: old, active: null }))
    expect(loadCurrent().view).toEqual({ ...DEFAULT_VIEW, subgrouping: 'none' })
  })

  it('drops a pressed tab whose view is gone, and keeps the arrangement', () => {
    // A view deleted in another browser tab can still be named here; the
    // strip cannot press a tab that is not there, but what the reader was
    // looking at is still what they were looking at.
    saveCurrent({ ...DEFAULT_VIEW, grouping: 'tag', columns: [...DEFAULT_VIEW.columns] }, 'Ops')

    const kept = loadCurrent()
    expect(kept.active).toBeNull()
    expect(kept.view.grouping).toBe('tag')
  })

  it('swallows a write the browser refuses', () => {
    // Best effort: there is no promise on screen to break, so unlike
    // saveView nothing is thrown and nobody is told.
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota exceeded')
    })
    expect(() => saveCurrent(DEFAULT_VIEW, null)).not.toThrow()
  })
})
