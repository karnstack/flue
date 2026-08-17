import { useCallback, useRef, type ReactNode } from 'react'
import { PlusIcon } from 'lucide-react'

import { useIsMobile } from '@/hooks/use-mobile'
import { leafIds, tabOf, type PaneTree, type TreePath } from '@/sessions/pane-tree'
import { cn } from '@/lib/utils'

/**
 * The tab strips' heights in px (h-11 and h-9 below). Handed to panes as
 * their viewportInset, so the strip and the pinning formula cannot disagree
 * about how tall the strip is.
 */
const MOBILE_STRIP_PX = 44
const DESKTOP_STRIP_PX = 36

/** One pane of a group: the session, and what a tab calls it. */
export interface GroupPane {
  id: string
  label: string
}

export interface SessionGroupProps {
  /**
   * The desktop arrangement: one split tree per tab (sessions/pane-tree.ts),
   * owned and persisted by the route, which is where splits are made and
   * members reconciled. Tabs and splits compose — a tab holds a whole split
   * arrangement, and "new tab" adds a tab without disturbing it. Out of step
   * is survivable: the route reconciles against the members on every change.
   */
  tabs: PaneTree[]
  /** Every pane in order — anchor first — for labels and the phone's flat tabs. */
  panes: GroupPane[]
  /** A divider settled: the split at `path` inside tab `tab` wants `ratio`. */
  onRatio: (tab: number, path: TreePath, ratio: number) => void
  /** The pane in front: the phone's tab, or the desktop tab that holds it. */
  active: string
  onActivate: (id: string) => void
  /** The strip's `+`: a new tab, in the directory of the active pane. */
  onNewTab?: () => void
  /**
   * Draw one pane's terminal. `viewportInset` is the in-flow chrome above
   * the pane — a tab strip's height, zero elsewhere — for the terminal's
   * visual-viewport pinning; key the terminal on it. `fit` says whether this
   * pane may pin itself to the visual viewport at all: true when it is the
   * page, false for every pane of a multi-pane split — the pinning slots are
   * single-occupancy (lib/viewport.ts), and N sibling panes each grabbing
   * them would leave all but the last frozen at mount-time height.
   */
  renderPane: (id: string, viewportInset: number, fit: boolean) => ReactNode
}

/**
 * One session group, rendered for the screen it is on: tabs of split trees
 * on a desktop, a flat tab strip on a phone — a phone has room for exactly
 * one pane, so its tabs are the members and the trees are ignored.
 *
 * A group of one deliberately does not read as a group at all — no strip, no
 * divider, exactly the full-bleed terminal every session has always been.
 * That is the backward-compatibility floor the issue draws: a plain session
 * is the degenerate case, not a special one.
 */
export function SessionGroup({
  tabs,
  panes,
  onRatio,
  active,
  onActivate,
  onNewTab,
  renderPane,
}: SessionGroupProps) {
  const isMobile = useIsMobile()
  const labels = new Map(panes.map((p, i) => [p.id, p.label === '' ? `Terminal ${i + 1}` : p.label]))

  if (panes.length <= 1) {
    const only = panes[0]?.id ?? active
    return <div className="h-full w-full">{renderPane(only, 0, true)}</div>
  }

  if (isMobile) {
    const shown = panes.some((p) => p.id === active) ? active : panes[0]!.id
    return (
      <div className="flex h-full w-full flex-col">
        <Strip
          height="mobile"
          tabs={panes.map((p) => ({ key: p.id, label: labels.get(p.id)!, selected: p.id === shown }))}
          onPick={(key) => onActivate(key)}
          onNewTab={onNewTab}
        />
        <div className="relative min-h-0 w-full flex-1">
          {renderPane(shown, MOBILE_STRIP_PX, true)}
        </div>
      </div>
    )
  }

  // Desktop: the tab that holds the active pane, first tab when none does.
  const at = Math.max(0, tabOf(tabs, active))
  const tree = tabs[at]
  if (tree === undefined) {
    // The tree has not caught up with the members yet (first list still in
    // flight). One pane, plainly, until it does.
    return <div className="h-full w-full">{renderPane(active, 0, true)}</div>
  }
  const strip = tabs.length > 1
  const soloLeaf = 'leaf' in tree

  const body = soloLeaf ? (
    renderPane(tree.leaf, strip ? DESKTOP_STRIP_PX : 0, true)
  ) : (
    <SplitTree tree={tree} onRatio={(path, ratio) => onRatio(at, path, ratio)} renderPane={renderPane} />
  )

  if (!strip) return <div className="h-full w-full">{body}</div>
  return (
    <div className="flex h-full w-full flex-col">
      <Strip
        height="desktop"
        tabs={tabs.map((t, i) => {
          const ids = leafIds(t)
          const label = labels.get(ids[0]!) ?? `Terminal ${i + 1}`
          return {
            key: ids[0]!,
            label: ids.length > 1 ? `${label} · ${ids.length}` : label,
            selected: i === at,
          }
        })}
        onPick={(key) => onActivate(key)}
        onNewTab={onNewTab}
      />
      <div className="relative min-h-0 w-full flex-1">{body}</div>
    </div>
  )
}

/**
 * The tab strip, in flow above the panes rather than floating over them — a
 * strip overlaid on a pane would sit on the first row of every full-screen
 * program. Compact on a desktop, finger-sized on a phone; quiet by the nav
 * rules: colour and a soft tint mark the selected tab, never weight.
 */
function Strip({
  height,
  tabs,
  onPick,
  onNewTab,
}: {
  height: 'mobile' | 'desktop'
  tabs: Array<{ key: string; label: string; selected: boolean }>
  onPick: (key: string) => void
  onNewTab?: () => void
}) {
  return (
    <div
      role="tablist"
      aria-label="Terminals in this group"
      className={cn(
        'flex shrink-0 items-center gap-x-1 overflow-x-auto border-b border-zinc-950/10 bg-white px-1.5 dark:border-white/10 dark:bg-zinc-950',
        height === 'mobile' ? 'h-11' : 'h-9',
      )}
    >
      {tabs.map((t) => (
        <button
          key={t.key}
          type="button"
          role="tab"
          aria-selected={t.selected}
          onClick={() => onPick(t.key)}
          className={cn(
            'max-w-48 truncate rounded-md whitespace-nowrap',
            height === 'mobile' ? 'px-3 py-1.5 text-base/5' : 'px-2.5 py-1 text-sm/5',
            t.selected
              ? 'bg-zinc-950/5 text-zinc-950 dark:bg-white/10 dark:text-white'
              : 'text-zinc-500 dark:text-zinc-400',
          )}
        >
          {t.label}
        </button>
      ))}
      {onNewTab !== undefined && (
        <button
          type="button"
          onClick={onNewTab}
          title="New tab"
          className={cn(
            'flex shrink-0 items-center justify-center rounded-md text-zinc-500 hover:bg-zinc-950/5 hover:text-zinc-950 dark:text-zinc-400 dark:hover:bg-white/10 dark:hover:text-white',
            height === 'mobile' ? 'size-8' : 'size-7',
          )}
        >
          <PlusIcon aria-hidden="true" className="size-4" />
          <span className="sr-only">New tab in this group</span>
        </button>
      )}
    </div>
  )
}

/**
 * One tab's split tree, drawn recursively: a split is a flex box of its two
 * subtrees with a draggable divider between them, a leaf is a pane.
 */
function SplitTree({
  tree,
  onRatio,
  renderPane,
}: {
  tree: PaneTree
  onRatio: (path: TreePath, ratio: number) => void
  renderPane: SessionGroupProps['renderPane']
}) {
  // The two boxes either side of each divider, keyed by the divider's path,
  // for the drag to write sizes into directly. A drag through state would
  // re-render every mounted terminal once per pointermove — sixty times a
  // second — for a style change on exactly two wrapper divs.
  const boxes = useRef(new Map<string, { a: HTMLDivElement | null; b: HTMLDivElement | null }>())
  const boxFor = (key: string) => {
    let entry = boxes.current.get(key)
    if (entry === undefined) {
      entry = { a: null, b: null }
      boxes.current.set(key, entry)
    }
    return entry
  }

  const beginDrag = useCallback(
    (path: TreePath, dir: 'row' | 'column') => (e: React.PointerEvent<HTMLDivElement>) => {
      const holder = e.currentTarget.parentElement
      if (holder === null) return
      const entry = boxes.current.get(path.join(''))
      if (entry === undefined || entry.a === null || entry.b === null) return
      const { a, b } = entry
      e.preventDefault()
      e.currentTarget.setPointerCapture(e.pointerId)
      const box = holder.getBoundingClientRect()
      const span = dir === 'row' ? box.width : box.height
      const startAt = dir === 'row' ? e.clientX : e.clientY
      const startRatio = Number(a.style.flexGrow)
      let settled = startRatio

      const move = (ev: PointerEvent) => {
        const at = dir === 'row' ? ev.clientX : ev.clientY
        settled = Math.min(0.85, Math.max(0.15, startRatio + (at - startAt) / span))
        a.style.flexGrow = String(settled)
        b.style.flexGrow = String(1 - settled)
      }
      const up = () => {
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', up)
        window.removeEventListener('pointercancel', up)
        // One state commit per drag, where it also persists — React's sizes
        // and the DOM's agree again from the next render on.
        onRatio(path, settled)
      }
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', up)
      window.addEventListener('pointercancel', up)
    },
    [onRatio],
  )

  const renderNode = (node: PaneTree, path: TreePath): ReactNode => {
    if ('leaf' in node) {
      return (
        <div className="relative size-full min-h-0 min-w-0">{renderPane(node.leaf, 0, false)}</div>
      )
    }
    const key = path.join('')
    const entry = boxFor(key)
    return (
      <div className={cn('flex size-full min-h-0 min-w-0', node.split === 'column' && 'flex-col')}>
        <div
          ref={(el) => {
            entry.a = el
          }}
          className="relative min-h-0 min-w-0 basis-0"
          style={{ flexGrow: node.ratio }}
        >
          {renderNode(node.a, [...path, 'a'])}
        </div>
        <div
          role="separator"
          aria-orientation={node.split === 'row' ? 'vertical' : 'horizontal'}
          onPointerDown={beginDrag(path, node.split)}
          className={cn(
            'relative shrink-0 bg-zinc-500/40 hover:bg-zinc-500/70',
            node.split === 'row' ? 'w-px cursor-col-resize' : 'h-px cursor-row-resize',
          )}
        >
          {/* The grab area: a 1px line is a divider, not a handle. */}
          <div
            aria-hidden="true"
            className={cn(
              'absolute',
              node.split === 'row' ? 'inset-y-0 -right-1 -left-1' : 'inset-x-0 -top-1 -bottom-1',
            )}
          />
        </div>
        <div
          ref={(el) => {
            entry.b = el
          }}
          className="relative min-h-0 min-w-0 basis-0"
          style={{ flexGrow: 1 - node.ratio }}
        >
          {renderNode(node.b, [...path, 'b'])}
        </div>
      </div>
    )
  }

  return <div className="h-full w-full">{renderNode(tree, [])}</div>
}
