import type { SessionInfo } from '@/client/protocol'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

export interface SessionTableProps {
  sessions: SessionInfo[]
  onOpen: (id: string) => void
}

/** Millis since the epoch, or -Infinity for a timestamp that will not parse. */
function activeAt(s: SessionInfo): number {
  const at = Date.parse(s.lastActive)
  return Number.isNaN(at) ? -Infinity : at
}

/**
 * Most recently active first, ties broken by id.
 *
 * Not decoration. The daemon answers `list` by ranging over a Go map, and Go
 * randomises that order on every single call — so rows given straight through
 * would reshuffle under the reader on each poll, and the row their pointer was
 * over would not be the row they clicked. Ordering has to happen somewhere,
 * and doing it here is what stops the next consumer forgetting it.
 *
 * The tie-break is what makes it stable rather than merely sorted: `lastActive`
 * has second resolution on the wire, so two sessions touched in the same second
 * compare equal, and equal keys leave the rest to whatever order arrived.
 *
 * Note the shape of the comparator. Subtracting the two timestamps would be
 * shorter and would return NaN for two unparseable ones, which is not a
 * comparator at all: Array#sort is free to leave such elements anywhere.
 */
function ordered(sessions: SessionInfo[]): SessionInfo[] {
  return [...sessions].sort((a, b) => {
    const left = activeAt(a)
    const right = activeAt(b)
    if (left !== right) return left < right ? 1 : -1
    return a.id.localeCompare(b.id)
  })
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
  'py-2 text-base/6 font-medium whitespace-nowrap text-zinc-950 sm:text-sm/6 dark:text-white'
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
    return (
      <p className="max-w-[65ch] text-base/7 text-pretty text-zinc-600 sm:text-sm/6 dark:text-zinc-400">
        No sessions yet. Run <code className="font-mono">flue open</code> in a directory, or start
        one here.
      </p>
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
              <tr key={s.id} className="border-b border-zinc-950/5 dark:border-white/5">
                <td className={cn(BODY_CELL, 'pr-3 text-zinc-950 dark:text-white')}>{s.cwd}</td>
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
                  */}
                  <Button
                    variant="outline"
                    size="sm"
                    aria-label={`Open ${s.cwd}`}
                    onClick={() => onOpen(s.id)}
                  >
                    Open
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
