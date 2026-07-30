import { ArrowRightIcon } from '@heroicons/react/16/solid'

import type { SessionInfo } from '@/client/protocol'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

export interface SessionTableProps {
  sessions: SessionInfo[]
  onOpen: (id: string) => void
}

/**
 * By directory, ties broken by id.
 *
 * Ordering has to happen somewhere. The daemon answers `list` by ranging over
 * a Go map, and Go randomises that order on every single call, so rows given
 * straight through would reshuffle on each poll and the row under the reader's
 * pointer would not be the row they clicked. Doing it here is what stops the
 * next consumer forgetting it.
 *
 * The sort key is the part worth explaining, because the obvious one is wrong.
 * "Most recently active first" reads well and moves rows for a living: the
 * daemon stamps `lastActive` on every byte written to a pty *and* every chunk
 * read back from one, so a session tailing a log climbs to the top between one
 * poll and the next. That is the same defect as the random order, arriving by
 * a different route — deterministic per snapshot, but not stable across them.
 *
 * `cwd` is fixed when the session is spawned and never written again, so this
 * order does not move at all, and it sorts the rows by the column they lead
 * with. `id` breaks the tie, since two sessions in one directory is the
 * ordinary case rather than the exotic one.
 */
function ordered(sessions: SessionInfo[]): SessionInfo[] {
  return [...sessions].sort((a, b) => a.cwd.localeCompare(b.cwd) || a.id.localeCompare(b.id))
}

/**
 * The state cell: a dot and a word.
 *
 * The dot is neutral, and deliberately. Amber is this app's single accent and
 * it is spent on the one primary button per screen — a dot per row would put
 * ten of them beside it and leave the eye nowhere to land. Contrast carries the
 * distinction instead: full-strength for a live session, faded for one that has
 * ended.
 *
 * `live` is written against `exited` rather than for the other value, so a
 * state the daemon adds later reads as live rather than as a process that
 * ended with an exit code nobody has.
 */
function StateCell({ session }: { session: SessionInfo }) {
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
 * The shared halves of the cell classes, since three headings would otherwise
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

/**
 * The sessions, one row each.
 *
 * Rows sit on the page background with horizontal rules between them and
 * nothing else: no wrapper panel, no vertical rules, no outer edge. Sibling
 * rows in one shared context need the lightest separation that works, and a
 * panel around each would claim every session is an independent object when
 * what is on screen is a single set.
 */
export function SessionTable({ sessions, onOpen }: SessionTableProps) {
  if (sessions.length === 0) {
    /*
     * The empty state quotes the landing page's terminal figure: a dark card
     * carrying the one command that matters, ending in the emulator's own
     * amber cursor. The card keeps its dark ground in both themes, exactly
     * as a terminal does — in the light theme it is the landing's figure, in
     * the dark one it sits a step above the canvas, as panels here do.
     */
    return (
      <div className="flex flex-col items-center py-12 text-center sm:py-16">
        <div className="w-full max-w-xs rounded-xl bg-zinc-950 px-4 py-3 text-left shadow-md shadow-zinc-950/10 ring-1 ring-white/10 dark:bg-zinc-900 dark:shadow-none">
          <p className="font-mono text-sm/6 text-zinc-300">
            <span className="text-zinc-500">$</span> flue open
            <span
              aria-hidden="true"
              className="ml-2 inline-block h-[1.1em] w-[0.6em] align-text-bottom bg-amber-400 motion-safe:animate-blink"
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
              <th scope="col" className={cn(HEAD_CELL, 'pr-3')}>
                Directory
              </th>
              <th scope="col" className={cn(HEAD_CELL, 'px-3')}>
                Command
              </th>
              <th scope="col" className={cn(HEAD_CELL, 'px-3')}>
                State
              </th>
              <th scope="col" className="py-2 pl-3">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {ordered(sessions).map((s) => (
              // The hover surface is the same token the nav's items use, so
              // "the pointer is here" reads identically everywhere. The row
              // itself is not a control — Open is — but on a wide screen the
              // wash is what ties a directory to its button.
              <tr
                key={s.id}
                className="group border-b border-zinc-950/5 transition-colors hover:bg-zinc-950/5 dark:border-white/5 dark:hover:bg-white/5"
              >
                <td className={cn(BODY_CELL, 'pr-3 font-mono text-zinc-950 dark:text-white')}>
                  {s.cwd}
                </td>
                <td className={cn(BODY_CELL, 'px-3 font-mono text-zinc-600 dark:text-zinc-400')}>
                  {s.cmd.join(' ')}
                </td>
                <td
                  className={cn(BODY_CELL, 'px-3 tabular-nums text-zinc-600 dark:text-zinc-400')}
                >
                  <StateCell session={s} />
                </td>
                <td className="py-2.5 pl-3 text-right">
                  {/*
                    Named after its own row. Every one of these says "Open", so
                    without this a screen reader announces the same control as
                    many times as there are sessions, with nothing to tell them
                    apart.

                    Quiet until the row is under the pointer, then at full
                    contrast — ten boxed buttons in a column would be the
                    loudest thing on the screen, and the affordance only needs
                    to be certain for the row the reader is actually on.
                    Keyboard focus keeps its own indicator at any time.
                  */}
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={`Open ${s.cwd}`}
                    className="text-zinc-500 group-hover:text-zinc-950 dark:text-zinc-400 dark:group-hover:text-white"
                    onClick={() => onOpen(s.id)}
                  >
                    Open
                    <ArrowRightIcon
                      data-icon="inline-end"
                      aria-hidden="true"
                      className="transition-transform group-hover/button:translate-x-0.5"
                    />
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
