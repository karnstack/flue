import { Fragment } from 'react'
import {
  ArrowRightIcon,
  ChevronDownIcon,
  EllipsisHorizontalIcon,
  PlusIcon,
  StarIcon,
} from '@heroicons/react/16/solid'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import type { FleetSession } from '@/fleet/types'
import { ago } from '@/lib/time'
import { cn } from '@/lib/utils'
import {
  COLUMN_KEYS,
  COLUMN_LABELS,
  displayName,
  type ColumnKey,
  type Group,
} from '@/sessions/view'

/** What a row's ⋯ menu can ask of a session. */
export type RowAction = 'rename' | 'tags' | 'pin' | 'unpin' | 'close'

/**
 * A row's selection key. `id` alone is not enough: two daemons mint ids with
 * no knowledge of each other, so only the machine qualifies one. The same
 * session shown under two tag headings carries the same key in both places —
 * which is exactly right for selection, and exactly why this string must
 * never become a DOM id or an htmlFor.
 */
const keyOf = (s: FleetSession) => `${s.machineId}/${s.id}`

/**
 * Where a long path is cut. CSS ellipsis can only eat the end, and the end of
 * a path is the half that tells two sessions apart — so the cut is made here,
 * in the middle, with more kept from the tail than the head for the same
 * reason. The full path rides in the cell's title.
 */
const PATH_MAX = 40
const PATH_HEAD = 15
const PATH_TAIL = 22

function midCut(path: string): string {
  if (path.length <= PATH_MAX) return path
  return `${path.slice(0, PATH_HEAD)}…${path.slice(-PATH_TAIL)}`
}

/**
 * A stamp as a distance: "5m ago". The daemon writes ISO strings and `ago`
 * reads unix seconds, so the parse and the division live here, once. A stamp
 * no Date can read renders as nothing rather than as arithmetic on NaN.
 */
function since(stamp: string): string {
  const at = Date.parse(stamp)
  return Number.isNaN(at) ? '' : ago(at / 1000)
}

/**
 * A group's headcount, in the two words that matter: "2 running · 1 exited".
 * A part with nobody in it is dropped rather than written as a zero, because
 * "3 running" is a statement and "3 running · 0 exited" is a form.
 */
function tally(sessions: FleetSession[]): string {
  const live = sessions.filter((s) => s.state !== 'exited').length
  const ended = sessions.length - live
  const parts: string[] = []
  if (live > 0) parts.push(`${live} running`)
  if (ended > 0) parts.push(`${ended} exited`)
  return parts.join(' · ')
}

/**
 * The state cell: a dot and a word.
 *
 * The dot is neutral, and deliberately. Teal is this app's single accent and
 * it is spent on the one primary button per screen — a dot per row would put
 * ten of them beside it and leave the eye nowhere to land. Contrast carries the
 * distinction instead: full-strength for a live session, faded for one that has
 * ended.
 *
 * `live` is written against `exited` rather than for the other value, so a
 * state the daemon adds later reads as live rather than as a process that
 * ended with an exit code nobody has.
 */
function StateCell({ session }: { session: FleetSession }) {
  const live = session.state !== 'exited'
  return (
    <div className="flex items-center gap-x-2">
      <span
        aria-hidden="true"
        className={cn(
          'size-1.5 shrink-0 rounded-full',
          live ? 'bg-zinc-950 dark:bg-white' : 'bg-zinc-950/30 dark:bg-white/30',
        )}
      />
      <span>{live ? 'Running' : `Exited ${session.exitCode}`}</span>
    </div>
  )
}

/*
 * The shared halves of the cell classes, since seven headings would otherwise
 * carry the same hundred characters each.
 *
 * Every token here has to stay hyphenated. styles.build.test.ts explains a
 * compiled utility by finding it inside a `className` or a `cn(...)` call, and
 * a name assembled in a constant is beyond its reach — so a bare single-word
 * utility put here would ship and then fail that guard as unexplained. Which
 * this comment demonstrated on its first draft, by using a word that is itself
 * a utility to describe the problem.
 */
const HEAD_CELL =
  'py-2 font-mono text-xs/6 font-medium tracking-wide whitespace-nowrap text-zinc-500 dark:text-zinc-400'
const BODY_CELL = 'py-2.5 text-base/6 sm:text-sm/6'

/** The muted body text most cells wear; the name cell alone speaks louder. */
const MUTED_CELL = 'text-zinc-600 dark:text-zinc-400'

/**
 * One cell of one row, by column.
 *
 * The name cell doubles as a click target for opening — the widest, leftmost,
 * most looked-at spot on the row — while the accessible route stays the Open
 * button, which a keyboard can reach and a screen reader can tell apart. The
 * star for a pinned session speaks for itself to assistive technology; it is
 * state, not decoration.
 */
function Cell({
  column,
  s,
  onOpen,
}: {
  column: ColumnKey
  s: FleetSession
  onOpen: (s: FleetSession) => void
}) {
  switch (column) {
    case 'name':
      return (
        <td onClick={() => onOpen(s)} className={cn(BODY_CELL, 'cursor-pointer pr-3')}>
          <div className="flex items-center gap-x-2">
            {s.pinned && (
              // The label rides a span because the icon marks itself
              // aria-hidden; the star is state, not decoration, and a
              // screen reader should hear it.
              <span role="img" aria-label="Pinned" className="flex shrink-0">
                <StarIcon
                  aria-hidden="true"
                  className="size-3 shrink-0 text-zinc-500 dark:text-zinc-400"
                />
              </span>
            )}
            <div className="min-w-0">
              <p className="font-medium text-zinc-950 dark:text-white">{displayName(s)}</p>
              <p className="font-mono text-xs/5 text-zinc-500 dark:text-zinc-400">
                {s.cmd.join(' ')}
              </p>
            </div>
          </div>
        </td>
      )
    case 'directory':
      return (
        <td title={s.cwd} className={cn(BODY_CELL, MUTED_CELL, 'px-3 font-mono')}>
          {midCut(s.cwd)}
        </td>
      )
    case 'machine':
      return <td className={cn(BODY_CELL, MUTED_CELL, 'px-3')}>{s.machineName}</td>
    case 'tags':
      return (
        <td className={cn(BODY_CELL, 'px-3')}>
          <div className="flex items-center gap-x-1.5">
            {s.tags.map((tag) => (
              <Badge key={tag} variant="secondary">
                {tag}
              </Badge>
            ))}
          </div>
        </td>
      )
    case 'state':
      return (
        <td className={cn(BODY_CELL, MUTED_CELL, 'px-3')}>
          <StateCell session={s} />
        </td>
      )
    case 'lastActive':
      return (
        <td title={s.lastActive} className={cn(BODY_CELL, MUTED_CELL, 'px-3 tabular-nums')}>
          {since(s.lastActive)}
        </td>
      )
    case 'created':
      return (
        <td title={s.createdAt} className={cn(BODY_CELL, MUTED_CELL, 'px-3 tabular-nums')}>
          {since(s.createdAt)}
        </td>
      )
  }
}

/**
 * One session, one row.
 *
 * The hover surface is the same token the nav's items use, so "the pointer is
 * here" reads identically everywhere. The checkbox keeps quiet until the row
 * is hovered, checked, or focused — CSS alone, no state — because a column of
 * boxes at rest would make every glance at the list feel like a bulk edit.
 * Its cell wears `pr-4` on purpose: Task 11's checkbox carries an unseen hit
 * area reaching 12px past each side, and without that padding it would sit
 * over the name cell and swallow clicks meant to open the session.
 */
function SessionRow({
  s,
  shown,
  selected,
  onToggleSelect,
  onOpen,
  onAction,
}: {
  s: FleetSession
  shown: ColumnKey[]
  selected: ReadonlySet<string>
  onToggleSelect: (key: string) => void
  onOpen: (s: FleetSession) => void
  onAction: (action: RowAction, s: FleetSession) => void
}) {
  const key = keyOf(s)
  const name = displayName(s)
  return (
    <tr className="group border-b border-zinc-950/5 transition-colors hover:bg-zinc-950/5 dark:border-white/5 dark:hover:bg-white/5">
      <td className="py-2.5 pr-4">
        <Checkbox
          checked={selected.has(key)}
          onCheckedChange={() => onToggleSelect(key)}
          aria-label={`Select ${name}`}
          className="opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 data-checked:opacity-100"
        />
      </td>
      {shown.map((column) => (
        <Cell key={column} column={column} s={s} onOpen={onOpen} />
      ))}
      <td className="py-2.5 pl-3 text-right">
        {/*
          Named after its own row. Every one of these says "Open", so without
          this a screen reader announces the same control as many times as
          there are sessions, with nothing to tell them apart.

          Quiet until the row is under the pointer, then at full contrast —
          ten boxed buttons in a column would be the loudest thing on the
          screen, and the affordance only needs to be certain for the row the
          reader is actually on. Keyboard focus keeps its own indicator.
        */}
        <Button
          variant="ghost"
          size="sm"
          aria-label={`Open ${name}`}
          className="text-zinc-500 group-hover:text-foreground dark:text-zinc-400"
          onClick={() => onOpen(s)}
        >
          Open
          <ArrowRightIcon
            data-icon="inline-end"
            aria-hidden="true"
            className="transition-transform group-hover/button:translate-x-0.5"
          />
        </Button>
        {/*
          The five actions a row can take, with pin and unpin standing in for
          each other by state — offering both would make one of them a lie.
          The menu content rides a portal, so nothing chosen here can bubble
          into the name cell's open. `w-auto` unseats the content's default
          trigger-width sizing, which measured against this small ⋯ button
          would pin the menu to its `min-w-32` floor regardless of the items.
        */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`Actions for ${name}`}
              className="text-zinc-500 dark:text-zinc-400"
            >
              <EllipsisHorizontalIcon aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-auto">
            <DropdownMenuItem onSelect={() => onAction('rename', s)}>Rename</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onAction('tags', s)}>Edit tags</DropdownMenuItem>
            {s.pinned ? (
              <DropdownMenuItem onSelect={() => onAction('unpin', s)}>Unpin</DropdownMenuItem>
            ) : (
              <DropdownMenuItem onSelect={() => onAction('pin', s)}>Pin</DropdownMenuItem>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onSelect={() => onAction('close', s)}>
              Close
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </td>
    </tr>
  )
}

/**
 * The rule under the last pinned row of the ungrouped list. Pinned rows are
 * the ordered prefix — the view model put them there — so the boundary is a
 * fact to find, not a sort to redo. It carries no words: a heading here would
 * say "pinned", the stars already do, and the reader only needs to see where
 * the fold in the paper is.
 */
function PinnedRule({ span }: { span: number }) {
  return (
    <tr
      data-divider=""
      aria-hidden="true"
      className="border-b border-zinc-950/10 dark:border-white/10"
    >
      <td colSpan={span} className="p-0" />
    </tr>
  )
}

/**
 * The sessions, in headed runs, one row each.
 *
 * Rows sit on the page background with horizontal rules between them and
 * nothing else: no wrapper panel, no vertical rules, no outer edge. Sibling
 * rows in one shared context need the lightest separation that works, and a
 * panel around each would claim every session is an independent object when
 * what is on screen is a single set.
 *
 * Everything arrives decided. `groups` come from applyView filtered, ordered
 * and cut — the ordering rationale lives on `orderSessions`, and nothing here
 * may re-sort a run of rows, ever. Folding, selection and column choice live
 * with the caller too: this component reports clicks and renders what it is
 * told, which is what keeps every behaviour above it testable without a DOM.
 *
 * The one decision made here is that the name column ignores `columns`. Every
 * other column is the caller's to drop, but a list of unnamed rows identifies
 * nothing — so 'name' renders whether asked for or not, and the display
 * options can offer it as permanently on.
 */
export function SessionTable({
  groups,
  columns,
  selected,
  onToggleSelect,
  onToggleGroup,
  collapsed,
  onOpen,
  onAction,
  onSpawnIn,
}: {
  groups: Group[]
  columns: ColumnKey[]
  selected: ReadonlySet<string>
  onToggleSelect(key: string): void
  onToggleGroup(groupKey: string): void
  collapsed: ReadonlySet<string>
  onOpen(s: FleetSession): void
  onAction(action: RowAction, s: FleetSession): void
  onSpawnIn?(groupKey: string): void
}) {
  if (groups.length === 0) {
    /*
     * The empty state quotes the landing page's terminal figure: a dark card
     * carrying the one command that matters, ending in the emulator's own
     * teal cursor. The card keeps its dark ground in both themes, exactly
     * as a terminal does — in the light theme it is the landing's figure, in
     * the dark one it sits a step above the canvas, as panels here do.
     */
    return (
      <div className="flex flex-col items-center py-12 text-center sm:py-16">
        <div className="w-full max-w-xs rounded-xl bg-zinc-950 px-4 py-3 text-left shadow-md shadow-zinc-950/10 ring-1 ring-white/10 dark:bg-zinc-900 dark:shadow-none">
          <p className="font-mono text-sm/6 text-zinc-300">
            <span className="text-zinc-400">$</span> flue open
            <span
              aria-hidden="true"
              className="ml-2 inline-block h-[1.1em] w-[0.6em] align-text-bottom bg-teal-400 motion-safe:animate-blink"
            />
          </p>
        </div>
        <p className="mt-6 text-base/6 font-medium text-zinc-950 dark:text-white">
          No sessions yet
        </p>
        <p className="mt-1 max-w-[40ch] text-base/7 text-pretty text-zinc-600 sm:text-sm/6 dark:text-zinc-400">
          Run <code className="font-mono">flue open</code> in a directory, or start one here.
        </p>
      </div>
    )
  }

  // Membership comes from the caller, order from COLUMN_KEYS — a preference
  // list must not get to reorder the columns by mentioning them differently.
  const shown = COLUMN_KEYS.filter((c) => c === 'name' || columns.includes(c))
  // The checkbox cell and the actions cell book-end every row.
  const span = shown.length + 2
  // The pinned rule only makes sense where there are no headings to do the
  // separating: the single 'all' group of the ungrouped view.
  const ungrouped = groups.length === 1 && groups[0]!.key === 'all'

  return (
    // The negative margins let the scroll area reach the edges of the screen's
    // padding, so a wide row scrolls rather than squeezing every other column;
    // the inner padding puts the cells back where they were. `-my-2` with the
    // matching `py-2` is what leaves a focus indicator somewhere to be drawn,
    // since scrolling one axis makes the other one clip.
    <div className="-mx-4 -my-2 overflow-x-auto whitespace-nowrap sm:-mx-6 lg:-mx-8">
      <div className="inline-block min-w-full px-4 py-2 align-middle sm:px-6 lg:px-8">
        <table className="w-full text-left">
          <thead>
            <tr className="border-b border-zinc-950/10 dark:border-white/10">
              <th scope="col" className="py-2 pr-4">
                <span className="sr-only">Select</span>
              </th>
              {shown.map((column) => (
                <th
                  key={column}
                  scope="col"
                  className={cn(HEAD_CELL, column === 'name' ? 'pr-3' : 'px-3')}
                >
                  {COLUMN_LABELS[column]}
                </th>
              ))}
              <th scope="col" className="py-2 pl-3">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          {groups.map((g) => {
            const open = !collapsed.has(g.key)
            // Where the pinned prefix ends; 0 and -1 both mean "no rule".
            const boundary = ungrouped ? g.sessions.findIndex((s) => !s.pinned) : 0
            return (
              // A rowgroup per group, so the heading travels with its rows.
              <tbody key={g.key}>
                <tr className="border-b border-zinc-950/5 dark:border-white/5">
                  {/*
                    Full-width, one real control. The toggle owns the chevron
                    and the label so its accessible name is the group's; the
                    tally is read-along text; and the spawn control — offered
                    only when the caller can honour it — stands apart so that
                    folding a group and starting a session on it can never be
                    the same click.
                  */}
                  <th colSpan={span} scope="colgroup" className="pt-4 pb-1 text-left font-normal">
                    <div className="flex items-center gap-x-1.5">
                      <button
                        type="button"
                        aria-expanded={open}
                        onClick={() => onToggleGroup(g.key)}
                        className="-ml-1.5 flex items-center gap-x-1 rounded-md px-1.5 py-0.5 text-sm/6 font-medium text-zinc-950 transition-colors outline-none hover:bg-zinc-950/5 focus-visible:ring-3 focus-visible:ring-ring/50 dark:text-white dark:hover:bg-white/5"
                      >
                        <ChevronDownIcon
                          aria-hidden="true"
                          className={cn(
                            'size-4 shrink-0 text-zinc-400 transition-transform dark:text-zinc-500',
                            !open && '-rotate-90',
                          )}
                        />
                        {g.label}
                      </button>
                      <span className="text-sm/6 text-zinc-500 dark:text-zinc-400">
                        {tally(g.sessions)}
                      </span>
                      {onSpawnIn && (
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          aria-label={`New session on ${g.label}`}
                          className="text-zinc-500 dark:text-zinc-400"
                          onClick={() => onSpawnIn(g.key)}
                        >
                          <PlusIcon aria-hidden="true" />
                        </Button>
                      )}
                    </div>
                  </th>
                </tr>
                {open &&
                  g.sessions.map((s, at) => (
                    // Keyed by the same composite the selection uses: unique
                    // within a group, even when the session itself repeats
                    // across tag groups in their own rowgroups.
                    <Fragment key={keyOf(s)}>
                      {at === boundary && at > 0 && <PinnedRule span={span} />}
                      <SessionRow
                        s={s}
                        shown={shown}
                        selected={selected}
                        onToggleSelect={onToggleSelect}
                        onOpen={onOpen}
                        onAction={onAction}
                      />
                    </Fragment>
                  ))}
              </tbody>
            )
          })}
        </table>
      </div>
    </div>
  )
}
