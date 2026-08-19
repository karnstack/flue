/*
 * The split tree: how a group's panes are arranged on a desktop.
 *
 * A binary tree, tmux-shaped. A leaf is a session; a split holds two
 * subtrees along one axis and the fraction the first one takes. Splitting
 * always targets a pane — the one whose menu row or chord asked — and
 * replaces that leaf with a split of the old pane and the new one, so ⇧⌘D
 * over the right column of an A|B split yields A beside a B-over-C stack,
 * never a wholesale change of axis.
 *
 * Pure data and pure functions, so the arithmetic is testable without a DOM
 * and the route can hold the tree as plain state. Every mutation returns a
 * new tree and never touches the old one; helpers return the *same*
 * reference when there is nothing to change, which is what lets a caller use
 * them inside a React state updater without manufacturing re-renders.
 */

import type { SplitDirection } from '@/lib/split-keys'

export type PaneTree =
  | { leaf: string }
  | { split: SplitDirection; ratio: number; a: PaneTree; b: PaneTree }

/** A path from the root to a node: which child to take at each split. */
export type TreePath = Array<'a' | 'b'>

export function leaf(id: string): PaneTree {
  return { leaf: id }
}

/** Every session id in the tree, left to right. */
export function leafIds(t: PaneTree): string[] {
  if ('leaf' in t) return [t.leaf]
  return [...leafIds(t.a), ...leafIds(t.b)]
}

/**
 * Replace the leaf holding `targetId` with a split of it and `newId` along
 * `dir`, halves each. The same tree comes back when the target is not in it
 * — the caller's placement raced a close, and inventing a position would be
 * worse than declining.
 */
export function splitLeaf(
  t: PaneTree,
  targetId: string,
  dir: SplitDirection,
  newId: string,
): PaneTree {
  if ('leaf' in t) {
    if (t.leaf !== targetId) return t
    return { split: dir, ratio: 0.5, a: t, b: leaf(newId) }
  }
  const a = splitLeaf(t.a, targetId, dir, newId)
  if (a !== t.a) return { ...t, a }
  const b = splitLeaf(t.b, targetId, dir, newId)
  if (b !== t.b) return { ...t, b }
  return t
}

/**
 * Drop every leaf not in `keep`, collapsing splits so the survivor takes its
 * parent's whole box. Null when nothing survives.
 */
export function prune(t: PaneTree, keep: ReadonlySet<string>): PaneTree | null {
  if ('leaf' in t) return keep.has(t.leaf) ? t : null
  const a = prune(t.a, keep)
  const b = prune(t.b, keep)
  if (a === null) return b
  if (b === null) return a
  if (a === t.a && b === t.b) return t
  return { ...t, a, b }
}

/**
 * Bring the tree in line with the panes that actually exist: prune what has
 * gone, and hang what appeared without a recorded placement — a split made
 * on another device, say — off the root's own axis. The same reference comes
 * back when the tree already agrees.
 */
export function reconcile(t: PaneTree | null, ids: readonly string[]): PaneTree | null {
  if (ids.length === 0) return null
  const keep = new Set(ids)
  let next = t === null ? null : prune(t, keep)
  const have = next === null ? new Set<string>() : new Set(leafIds(next))
  for (const id of ids) {
    if (have.has(id)) continue
    have.add(id)
    next =
      next === null
        ? leaf(id)
        : { split: 'split' in next ? next.split : 'row', ratio: 0.5, a: next, b: leaf(id) }
  }
  return next
}

/**
 * The leaf whose box touches the surface's top-right corner: rightward at a
 * row split, upward at a column split. It is where the control strip lives —
 * the chips belong to the surface, not to a pane, so they sit at the
 * surface's own corner and pass to the next corner pane when that one
 * closes.
 */
export function topRightLeaf(t: PaneTree): string {
  if ('leaf' in t) return t.leaf
  return topRightLeaf(t.split === 'row' ? t.b : t.a)
}

/**
 * The leaf whose box touches the surface's top-left corner: the `a` side of
 * a split is its left or top either way, so the walk never branches. It is
 * where the tag strip lives, for the chips' reason — the tags name the
 * group, not a pane, so they sit at the surface's own corner.
 */
export function topLeftLeaf(t: PaneTree): string {
  if ('leaf' in t) return t.leaf
  return topLeftLeaf(t.a)
}

/**
 * Bring a tab list in line with the panes that exist: prune every tab's
 * tree, drop tabs that emptied, and give each unplaced newcomer a tab of its
 * own — which is both what "new tab" resolves to before its placement lands
 * and the honest home for a member some other device split. The same array
 * comes back when nothing changed.
 */
export function reconcileTabs(tabs: readonly PaneTree[], ids: readonly string[]): PaneTree[] {
  const keep = new Set(ids)
  let changed = false
  const out: PaneTree[] = []
  for (const t of tabs) {
    const next = prune(t, keep)
    if (next === null) {
      changed = true
      continue
    }
    if (next !== t) changed = true
    out.push(next)
  }
  const have = new Set(out.flatMap(leafIds))
  for (const id of ids) {
    if (have.has(id)) continue
    have.add(id)
    out.push(leaf(id))
    changed = true
  }
  // The caller holds this in React state: an unchanged answer must be the
  // same reference, or every reconcile pass would be a render.
  return changed ? out : (tabs as PaneTree[])
}

/**
 * Split `targetId`'s leaf inside whichever tab holds it. The same array when
 * no tab does — the caller's placement raced a close.
 */
export function splitInTabs(
  tabs: readonly PaneTree[],
  targetId: string,
  dir: SplitDirection,
  newId: string,
): PaneTree[] {
  for (let i = 0; i < tabs.length; i++) {
    const next = splitLeaf(tabs[i]!, targetId, dir, newId)
    if (next !== tabs[i]) {
      const out = [...tabs]
      out[i] = next
      return out
    }
  }
  // The same reference, as promised above: this lives in React state, and a
  // clone would spend a render (and a localStorage write) on a no-op.
  return tabs as PaneTree[]
}

/** The index of the tab holding `id`, or -1. */
export function tabOf(tabs: readonly PaneTree[], id: string): number {
  return tabs.findIndex((t) => leafIds(t).includes(id))
}

/** Read a group's persisted tab list from localStorage, empty when none. */
export function loadTabs(storageKey: string): PaneTree[] {
  try {
    const raw = localStorage.getItem(`${storageKey}:tabs`)
    if (raw === null) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(valid)
  } catch {
    return []
  }
}

/**
 * Persist a group's tab list. Idempotent on purpose: the route calls it
 * inside state updaters, which StrictMode double-invokes.
 */
export function saveTabs(storageKey: string, tabs: readonly PaneTree[]) {
  try {
    if (tabs.length === 0) localStorage.removeItem(`${storageKey}:tabs`)
    else localStorage.setItem(`${storageKey}:tabs`, JSON.stringify(tabs))
  } catch {
    // Storage full or unavailable: the layout still works, it just will not
    // survive a reload. Not worth surfacing.
  }
}

/** The node at a path, or null when the path outruns the tree. */
export function nodeAt(t: PaneTree, path: TreePath): PaneTree | null {
  let node: PaneTree = t
  for (const step of path) {
    if ('leaf' in node) return null
    node = node[step]
  }
  return node
}

/**
 * The tree with the split at `path` wearing `ratio`, clamped away from the
 * edges so no pane can be dragged to nothing. The same tree when the path
 * names no split.
 */
export function withRatio(t: PaneTree, path: TreePath, ratio: number): PaneTree {
  if (path.length === 0) {
    const clamped = Math.min(0.85, Math.max(0.15, ratio))
    if ('leaf' in t || t.ratio === clamped) return t
    return { ...t, ratio: clamped }
  }
  if ('leaf' in t) return t
  const step = path[0]!
  const child = withRatio(t[step], path.slice(1), ratio)
  if (child === t[step]) return t
  return { ...t, [step]: child }
}

/** Read a group's persisted tree from localStorage, or null. */
export function loadTree(storageKey: string): PaneTree | null {
  try {
    return parseTree(localStorage.getItem(`${storageKey}:tree`))
  } catch {
    return null
  }
}

/**
 * Persist a group's tree. Idempotent on purpose: the route calls it inside
 * state updaters, which StrictMode double-invokes.
 */
export function saveTree(storageKey: string, tree: PaneTree | null) {
  try {
    if (tree === null) localStorage.removeItem(`${storageKey}:tree`)
    else localStorage.setItem(`${storageKey}:tree`, JSON.stringify(tree))
  } catch {
    // Storage full or unavailable: the layout still works, it just will not
    // survive a reload. Not worth surfacing.
  }
}

/** Parse a stored tree, refusing anything that does not hold together. */
export function parseTree(raw: string | null): PaneTree | null {
  if (raw === null) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    return valid(parsed) ? parsed : null
  } catch {
    return null
  }
}

function valid(node: unknown): node is PaneTree {
  if (typeof node !== 'object' || node === null) return false
  if ('leaf' in node) {
    return typeof (node as { leaf: unknown }).leaf === 'string' && Object.keys(node).length === 1
  }
  const s = node as { split?: unknown; ratio?: unknown; a?: unknown; b?: unknown }
  return (
    (s.split === 'row' || s.split === 'column') &&
    typeof s.ratio === 'number' &&
    Number.isFinite(s.ratio) &&
    s.ratio > 0 &&
    s.ratio < 1 &&
    valid(s.a) &&
    valid(s.b)
  )
}
