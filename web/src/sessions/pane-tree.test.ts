import { describe, expect, it } from 'vitest'

import {
  leaf,
  leafIds,
  parseTree,
  prune,
  reconcile,
  reconcileTabs,
  splitInTabs,
  splitLeaf,
  tabOf,
  topRightLeaf,
  withRatio,
  type PaneTree,
} from './pane-tree'

const AB: PaneTree = { split: 'row', ratio: 0.5, a: leaf('a'), b: leaf('b') }

describe('splitLeaf', () => {
  it('replaces the target leaf with a split of it and the newcomer', () => {
    const t = splitLeaf(leaf('a'), 'a', 'row', 'b')
    expect(t).toEqual(AB)
  })

  it('splits inside one side without touching the other — the ⇧⌘D case', () => {
    // A|B, then split B downward: A stays a full-height column, B becomes a
    // stack. The whole surface must not change axis.
    const t = splitLeaf(AB, 'b', 'column', 'c')
    expect(t).toEqual({
      split: 'row',
      ratio: 0.5,
      a: leaf('a'),
      b: { split: 'column', ratio: 0.5, a: leaf('b'), b: leaf('c') },
    })
  })

  it('returns the same tree when the target is not in it', () => {
    expect(splitLeaf(AB, 'missing', 'row', 'c')).toBe(AB)
  })
})

describe('prune', () => {
  it('collapses a split whose side has gone, giving the survivor the whole box', () => {
    expect(prune(AB, new Set(['b']))).toEqual(leaf('b'))
  })

  it('prunes deep and keeps untouched subtrees by reference', () => {
    const deep: PaneTree = {
      split: 'row',
      ratio: 0.3,
      a: leaf('a'),
      b: { split: 'column', ratio: 0.6, a: leaf('b'), b: leaf('c') },
    }
    const t = prune(deep, new Set(['a', 'c']))
    expect(t).toEqual({ split: 'row', ratio: 0.3, a: leaf('a'), b: leaf('c') })
    expect(prune(deep, new Set(['a', 'b', 'c']))).toBe(deep)
  })

  it('is null when nothing survives', () => {
    expect(prune(AB, new Set())).toBeNull()
  })
})

describe('reconcile', () => {
  it('adopts a newcomer the tree has no placement for, off the root axis', () => {
    const t = reconcile(AB, ['a', 'b', 'c'])
    expect(leafIds(t!)).toEqual(['a', 'b', 'c'])
  })

  it('prunes what has gone and answers the same reference when nothing changed', () => {
    expect(reconcile(AB, ['a', 'b'])).toBe(AB)
    expect(reconcile(AB, ['a'])).toEqual(leaf('a'))
  })

  it('builds from nothing and empties to null', () => {
    expect(leafIds(reconcile(null, ['a', 'b'])!)).toEqual(['a', 'b'])
    expect(reconcile(AB, [])).toBeNull()
  })
})

describe('withRatio', () => {
  it('sets the ratio at a path and clamps it away from the edges', () => {
    const deep: PaneTree = {
      split: 'row',
      ratio: 0.5,
      a: leaf('a'),
      b: { split: 'column', ratio: 0.5, a: leaf('b'), b: leaf('c') },
    }
    const t = withRatio(deep, ['b'], 0.7)
    expect(t).not.toBe(deep)
    expect((t as { b: { ratio: number } }).b.ratio).toBe(0.7)
    expect(((withRatio(deep, [], 0.01) as { ratio: number }).ratio)).toBe(0.15)
  })

  it('answers the same tree for a path that names no split', () => {
    expect(withRatio(AB, ['a'], 0.7)).toBe(AB)
  })
})

describe('tabs of trees', () => {
  it('splits inside the tab that holds the target, leaving the others alone', () => {
    const tabs = [AB, leaf('c')]
    const next = splitInTabs(tabs, 'c', 'column', 'd')
    expect(next[0]).toBe(AB)
    expect(next[1]).toEqual({ split: 'column', ratio: 0.5, a: leaf('c'), b: leaf('d') })
  })

  it('reconciles: prunes emptied tabs, gives an unplaced newcomer its own tab', () => {
    const tabs = [AB, leaf('c')]
    const next = reconcileTabs(tabs, ['a', 'b', 'x'])
    expect(next.map(leafIds)).toEqual([['a', 'b'], ['x']])
    // And the same reference when nothing changed — this lives in React state.
    expect(reconcileTabs(tabs, ['a', 'b', 'c'])).toBe(tabs)
  })

  it('finds the tab holding a pane', () => {
    expect(tabOf([AB, leaf('c')], 'b')).toBe(0)
    expect(tabOf([AB, leaf('c')], 'c')).toBe(1)
    expect(tabOf([AB], 'zz')).toBe(-1)
  })

  it('names the top-right pane: rightward through rows, upward through columns', () => {
    expect(topRightLeaf(AB)).toBe('b')
    expect(
      topRightLeaf({
        split: 'row',
        ratio: 0.5,
        a: leaf('a'),
        b: { split: 'column', ratio: 0.5, a: leaf('b'), b: leaf('c') },
      }),
    ).toBe('b')
  })
})

describe('parseTree', () => {
  it('round-trips a stored tree and refuses garbage', () => {
    expect(parseTree(JSON.stringify(AB))).toEqual(AB)
    expect(parseTree(null)).toBeNull()
    expect(parseTree('not json')).toBeNull()
    expect(parseTree(JSON.stringify({ split: 'row', ratio: 2, a: { leaf: 'a' } }))).toBeNull()
    expect(parseTree(JSON.stringify({ leaf: 42 }))).toBeNull()
  })
})
