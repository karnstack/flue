import { Fragment } from 'react'
import { Link } from '@tanstack/react-router'
import {
  ChevronDownIcon,
  EllipsisHorizontalIcon,
  PlusIcon,
  StarIcon,
} from '@heroicons/react/16/solid'

import { SessionPreview } from '@/components/session-preview'
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
import { keyOf, type FleetSession } from '@/fleet/types'
import { ago } from '@/lib/time'
import { cn } from '@/lib/utils'
import { COLUMN_KEYS, displayName, type ColumnKey, type Group } from '@/sessions/view'

/** What a row's ⋯ menu can ask of a session. */
export type RowAction = 'rename' | 'tags' | 'pin' | 'unpin' | 'close'

/**
 * How a row asks the daemon what it is doing, for the hover preview.
 *
 * A function rather than a client, so this component keeps its one useful
 * property: it renders from data and reports clicks, and a test can put a
 * whole list on screen without a fleet, a socket or a daemon behind it.
 * Omitting it turns the previews off entirely, which is what the callers that
 * have nothing to peek with do.
 */
export type PeekFn = (
  s: FleetSession,
  bytes: number,
) => Promise<{ data: string; cols: number; rows: number }>

/**
 * The terminal's path, written out rather than imported from src/router.tsx —
 * importing it would close a cycle, since the router reaches this component
 * through the sessions screen. The literal is not unchecked: `to` is typed
 * against the registered route tree, so a path that drifts is a compile error.
 */
const TERMINAL_PATH = '/d/$deviceId/s/$sessionId' as const

/**
 * Where a long path is cut. CSS ellipsis can only eat the end, and the end of
 * a path is the half that tells two sessions apart — so the cut is made here,
 * in the middle, with more kept from the tail than the head for the same
 * reason. The full path rides in the element's title.
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
 * The state, said as a leading dot.
 *
 * The dot is neutral, and deliberately. Teal is this app's single accent and
 * it is spent on the one primary button per screen — a dot per row would put
 * ten of them beside it and leave the eye nowhere to land. Contrast carries
 * the distinction instead: full-strength for a live session, faded for one
 * that has ended.
 *
 * A live session says "Running" to assistive technology alone — on screen the
 * dot is the whole sentence. An ended one says nothing here, because its row
 * carries a written "Exited n" among the trailing details, and one telling of
 * a state per row is enough for anyone listening.
 *
 * `live` is written against `exited` rather than for the other value, so a
 * state the daemon adds later reads as live rather than as a process that
 * ended with an exit code nobody has.
 */
function StateDot({ session }: { session: FleetSession }) {
  const live = session.state !== 'exited'
  return (
    <span
      title={live ? 'Running' : `Exited ${session.exitCode}`}
      // z-10 with every other title-holder on the row: the row link's
      // stretched overlay is what a browser hit-tests, and a tooltip under
      // it never shows. See SessionRow.
      className="relative z-10 flex size-4 shrink-0 items-center justify-center"
    >
      <span
        aria-hidden="true"
        className={cn(
          'size-1.5 shrink-0 rounded-full',
          live ? 'bg-zinc-950 dark:bg-white' : 'bg-zinc-950/30 dark:bg-white/30',
        )}
      />
      {live && <span className="sr-only">Running</span>}
    </span>
  )
}

/** The quiet text the trailing details are set in. */
const META_TEXT = 'text-xs/6 whitespace-nowrap text-zinc-500 dark:text-zinc-400'

/**
 * How many tag badges a row shows before folding the rest into a "+n". A row
 * is one line that must never push the pane sideways — the old layout's
 * overflow-x wrapper died with it, so this cap is what holds the line now —
 * and the folded remainder rides in the +n badge's tooltip.
 */
const TAG_CAP = 3

/**
 * One session, one row: a single line with the identity on the left, the
 * details ranged right, and the whole of it one link.
 *
 * The link is a real anchor with the terminal's href, which is what buys the
 * open-in-a-new-tab family for free — a Ctrl, Cmd or middle click never
 * reaches the router, the browser answers it natively — and it is stretched
 * over the row by its ::after box rather than by wrapping the row's markup,
 * because a checkbox inside an anchor is both invalid and unreadable.
 *
 * That overlay is what a browser hit-tests, so two kinds of children stand
 * above it on `z-10`: the ones that take their own pointer — the checkbox,
 * the ⋯ trigger — and every element carrying a title, whose tooltip would
 * otherwise never show because the hover always landed on the anchor. The
 * title-holders are narrow, so the dead spots they cost the click surface
 * are small and each buys a tooltip that is actually reachable; everything
 * else lets a click fall through, and the row opens from anywhere.
 *
 * The checkbox keeps quiet until the row is hovered, checked, or focused —
 * CSS alone, no state — because a column of boxes at rest would make every
 * glance at the list feel like a bulk edit. The ⋯ menu holds the same
 * silence. Both stay at full strength for a coarse pointer, which has no
 * hover to reveal them with.
 */
function SessionRow({
  s,
  shown,
  selected,
  onToggleSelect,
  onAction,
  peek,
}: {
  s: FleetSession
  shown: ColumnKey[]
  selected: ReadonlySet<string>
  onToggleSelect: (key: string) => void
  onAction: (action: RowAction, s: FleetSession) => void
  peek?: PeekFn
}) {
  const key = keyOf(s)
  const name = displayName(s)
  const ended = s.state === 'exited'
  const link = (
    <Link
      to={TERMINAL_PATH}
      params={{ deviceId: s.machineId, sessionId: s.id }}
      // A tab of its own, because a session is a tab: this list is the thing
      // people come back to between sessions, and opening one over it meant
      // the way back was the browser's back button — which drops the terminal
      // and its scrollback with it. The router hands the click straight to the
      // browser once a target is set, so this is a real new tab and not a
      // navigation dressed up as one.
      target="_blank"
      rel="noopener"
      // Said out loud rather than left to the target attribute, which screen
      // readers announce inconsistently and some not at all.
      aria-label={`Open ${name} in a new tab`}
      className="flex min-w-0 flex-1 items-baseline gap-x-2 outline-none after:absolute after:inset-0 after:rounded-md focus-visible:after:outline-2 focus-visible:after:-outline-offset-1 focus-visible:after:outline-ring"
    >
      <span className="truncate text-base/6 font-medium text-zinc-950 sm:text-control dark:text-white">
        {name}
      </span>
      <span className="truncate font-mono text-xs/6 text-zinc-500 max-sm:hidden dark:text-zinc-400">
        {s.cmd.join(' ')}
      </span>
    </Link>
  )
  return (
    <li className="group/row relative flex items-center gap-x-3 rounded-md px-2 py-1.5 transition-colors hover:bg-row-hover">
      <Checkbox
        checked={selected.has(key)}
        onCheckedChange={() => onToggleSelect(key)}
        aria-label={`Select ${name}`}
        className="z-10 opacity-0 transition-opacity group-hover/row:opacity-100 pointer-coarse:opacity-100 focus-visible:opacity-100 data-checked:opacity-100"
      />
      {s.pinned && (
        // The label rides a span because the icon marks itself aria-hidden;
        // the star is state, not decoration, and a screen reader should
        // hear it.
        <span role="img" aria-label="Pinned" className="flex shrink-0">
          <StarIcon
            aria-hidden="true"
            className="size-3 shrink-0 text-zinc-500 dark:text-zinc-400"
          />
        </span>
      )}
      {shown.includes('state') && <StateDot session={s} />}
      {/*
        The preview hangs off the link rather than off the row, and that is
        not merely tidier — the link's stretched ::after is part of the
        anchor's own rendered box, so a pointer anywhere on the row that is
        not one of the z-10 controls enters the anchor and opens the card.
        Hanging it off the `li` instead would put the hover handlers on an
        element that is not a control, and the card would follow the pointer
        over the checkbox and the ⋯ menu as well.
      */}
      {peek === undefined ? (
        link
      ) : (
        <SessionPreview session={s} peek={peek}>
          {link}
        </SessionPreview>
      )}
      {/*
        The details, right-ranged in the order a reader resolves a row: what
        it is tagged, where it runs, where it sits, how it ended, when it was
        last touched. Presence is the caller's, through `shown`; the narrower
        the screen, the fewer survive. The machine chip survives every width
        on purpose — the headline use of this screen is a phone reading a
        desktop's fleet, and on that phone "which machine" outranks "which
        directory", so the directory is what gets shed first.
      */}
      <div className="flex shrink-0 items-center gap-x-2.5">
        {shown.includes('tags') && s.tags.length > 0 && (
          <span className="flex items-center gap-x-1.5 max-sm:hidden">
            {s.tags.slice(0, TAG_CAP).map((tag) => (
              <Badge key={tag} variant="secondary">
                {tag}
              </Badge>
            ))}
            {s.tags.length > TAG_CAP && (
              <Badge
                variant="secondary"
                title={s.tags.slice(TAG_CAP).join(', ')}
                className="relative z-10"
              >
                +{s.tags.length - TAG_CAP}
              </Badge>
            )}
          </span>
        )}
        {shown.includes('machine') && (
          <Badge variant="outline" className="text-zinc-500 dark:text-zinc-400">
            {s.machineName}
          </Badge>
        )}
        {shown.includes('directory') && (
          <span
            title={s.cwd}
            className={cn(META_TEXT, 'relative z-10 font-mono max-md:hidden')}
          >
            {midCut(s.cwd)}
          </span>
        )}
        {shown.includes('state') && ended && (
          <span className={META_TEXT}>Exited {s.exitCode}</span>
        )}
        {shown.includes('created') && (
          <span
            title={s.createdAt}
            className={cn(META_TEXT, 'relative z-10 tabular-nums max-sm:hidden')}
          >
            {since(s.createdAt)}
          </span>
        )}
        {shown.includes('lastActive') && (
          <span title={s.lastActive} className={cn(META_TEXT, 'relative z-10 tabular-nums')}>
            {since(s.lastActive)}
          </span>
        )}
        {/*
          The five actions a row can take, with pin and unpin standing in for
          each other by state — offering both would make one of them a lie.
          The trigger is named after its own row: every one of these draws
          the same glyph, so without that a screen reader announces the same
          control as many times as there are sessions. The menu content rides
          a portal, so nothing chosen here lands on the row's link. `w-auto`
          unseats the content's default trigger-width sizing, which measured
          against this small ⋯ button would pin the menu to its `min-w-32`
          floor regardless of the items.
        */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`Actions for ${name}`}
              className="relative z-10 -my-1 text-zinc-500 opacity-0 transition-opacity group-hover/row:opacity-100 pointer-coarse:opacity-100 focus-visible:opacity-100 data-open:opacity-100 dark:text-zinc-400"
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
      </div>
    </li>
  )
}

/**
 * The rule under the last pinned row of the ungrouped list. Pinned rows are
 * the ordered prefix — the view model put them there — so the boundary is a
 * fact to find, not a sort to redo. It carries no words: a heading here would
 * say "pinned", the stars already do, and the reader only needs to see where
 * the fold in the paper is.
 */
function PinnedRule() {
  return (
    <li
      data-divider=""
      aria-hidden="true"
      className="mx-2 my-1 border-b border-zinc-950/10 dark:border-white/10"
    />
  )
}

/**
 * The sessions, in headed runs, one row each.
 *
 * No heading row of field names, anywhere. The rows are single lines whose
 * layout already says what each piece is — a name reads as a name, a path as
 * a path, a stamp as a stamp — and a band of labels over them would spend the
 * top of the screen restating the obvious while making the list read like a
 * spreadsheet. What survives of the columns preference is the choice itself:
 * `columns` still decides which pieces a row carries; they simply sit on the
 * row's one line now.
 *
 * Each group heads its run with a soft full-width band rather than a bare
 * line, so a fold target reads as a place and not as a stray row; the rows
 * themselves sit on the page background and answer a hover with a soft
 * rounded tint, the same surface token the nav's items use.
 *
 * Everything arrives decided. `groups` come from applyView filtered, ordered
 * and cut — the ordering rationale lives on `orderSessions`, and nothing here
 * may re-sort a run of rows, ever. Folding, selection and the pieces to show
 * live with the caller too: this component reports clicks and renders what it
 * is told, which is what keeps every behaviour above it testable without a
 * DOM. Opening is the one act that no longer passes through the caller at
 * all — each row is a link to its own session, and the router answers it.
 *
 * The one decision made here is that the name ignores `columns`. Every other
 * piece is the caller's to drop, but a list of unnamed rows identifies
 * nothing — so the name renders whether asked for or not, and the display
 * options can offer it as permanently on.
 */
export function SessionTable({
  groups,
  columns,
  selected,
  onToggleSelect,
  onToggleGroup,
  collapsed,
  onAction,
  onSpawnIn,
  spawnLabel,
  peek,
}: {
  groups: Group[]
  columns: ColumnKey[]
  selected: ReadonlySet<string>
  onToggleSelect(key: string): void
  onToggleGroup(groupKey: string): void
  collapsed: ReadonlySet<string>
  onAction(action: RowAction, s: FleetSession): void
  /** Start a session belonging to this group. See `spawnFromGroup`. */
  onSpawnIn?(group: Group): void
  /**
   * What that control is called for a given group, or undefined for a group
   * that cannot have one. The caller owns both halves because it is the caller
   * that knows what the grouping *is* — this component is handed labelled runs
   * of rows and could not tell a machine's heading from a tag's.
   */
  spawnLabel?(group: Group): string | undefined
  /** How a row asks what it is doing, for the hover preview. See PeekFn. */
  peek?: PeekFn
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
        <div className="w-full max-w-xs rounded-lg bg-zinc-950 px-4 py-3 text-left shadow-medium ring-1 ring-white/10 dark:bg-zinc-900">
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
  // list must not get to reorder a row's pieces by mentioning them
  // differently.
  const shown = COLUMN_KEYS.filter((c) => c === 'name' || columns.includes(c))
  // The pinned rule only makes sense where there are no headings to do the
  // separating: the single 'all' group of the ungrouped view.
  const ungrouped = groups.length === 1 && groups[0]!.key === 'all'

  return (
    <div className="flex flex-col gap-y-4">
      {groups.map((g) => {
        const open = !collapsed.has(g.key)
        // Where the pinned prefix ends; 0 and -1 both mean "no rule".
        const boundary = ungrouped ? g.sessions.findIndex((s) => !s.pinned) : 0
        /*
         * What this heading's `+` would be called, and therefore whether it
         * exists at all.
         *
         * Resolved once, per group, and checked — not merely passed to
         * aria-label. A group that refuses one answers undefined (see
         * `spawnFromGroup`, and "Exited" for the case that motivates it), and
         * an unchecked answer rendered a button with no accessible name: a
         * `+` a pointer can press, a click the caller then refuses, and
         * nothing for a screen reader to announce it as.
         */
        const spawn = onSpawnIn === undefined ? undefined : spawnLabel?.(g)
        return (
          <section key={g.key} className="flex flex-col">
            {/*
              Two real controls in the band, and they are kept apart on
              purpose: folding a group and starting a session in it must never
              be the same click. The toggle owns the chevron and the label so
              its accessible name is the group's; the tally is read-along
              text; and the `+` is ranged right, where a new-thing control
              belongs and where a pointer aimed at the fold cannot reach it.
              It appears only when the caller can honour it — see
              `spawnFromGroup`, which is what decides that a heading like
              "Exited" has nothing to offer.
            */}
            <div className="group/band flex items-center gap-x-1.5 rounded-md px-2 py-1 transition-colors hover:bg-row-hover">
              <button
                type="button"
                aria-expanded={open}
                onClick={() => onToggleGroup(g.key)}
                className="-ml-1 flex min-w-0 items-center gap-x-1 rounded-sm px-1 py-0.5 text-control font-medium text-zinc-950 transition-colors outline-none focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring dark:text-white"
              >
                <ChevronDownIcon
                  aria-hidden="true"
                  className={cn(
                    'size-3.5 shrink-0 text-zinc-400 transition-transform dark:text-zinc-500',
                    !open && '-rotate-90',
                  )}
                />
                <span className="truncate">{g.label}</span>
              </button>
              <span className="shrink-0 text-xs text-zinc-500 tabular-nums dark:text-zinc-400">
                {tally(g.sessions)}
              </span>
              {spawn !== undefined && onSpawnIn !== undefined && (
                <Button
                  variant="ghost"
                  size="icon-xs"
                  // Named after its own group, as every repeated control in a
                  // list is: without it a screen reader announces "New
                  // session" once per heading with nothing to tell them apart.
                  aria-label={spawn}
                  // Quiet until the band is under the pointer or the button
                  // itself has focus — a column of `+` signs down the left of
                  // every heading would read as the loudest thing on a screen
                  // whose ordinary use is reading it. Full strength for a
                  // coarse pointer, which has no hover to reveal it with.
                  className="ml-auto text-zinc-500 opacity-0 transition-opacity group-hover/band:opacity-100 pointer-coarse:opacity-100 focus-visible:opacity-100 dark:text-zinc-400"
                  onClick={() => onSpawnIn(g)}
                >
                  <PlusIcon aria-hidden="true" />
                </Button>
              )}
            </div>
            {open && (
              <ul className="mt-1 flex flex-col">
                {g.sessions.map((s, at) => (
                  // Keyed by the same composite the selection uses: unique
                  // within a group, even when the session itself repeats
                  // across tag groups in their own lists.
                  <Fragment key={keyOf(s)}>
                    {at === boundary && at > 0 && <PinnedRule />}
                    <SessionRow
                      s={s}
                      shown={shown}
                      selected={selected}
                      onToggleSelect={onToggleSelect}
                      onAction={onAction}
                      peek={peek}
                    />
                  </Fragment>
                ))}
              </ul>
            )}
          </section>
        )
      })}
    </div>
  )
}
