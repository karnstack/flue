import { useEffect, useMemo, useRef, useState } from 'react'
import { MagnifyingGlassIcon } from '@heroicons/react/16/solid'

import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { PreviewCard, type Preview } from '@/components/session-preview'
import type { FleetSession } from '@/fleet/types'
import { useIsMobile } from '@/hooks/use-mobile'
import { cn } from '@/lib/utils'
import { decodeBase64, previewLines } from '@/sessions/preview'
import { isApplePlatform, matchChord, openChordLabel } from '@/switcher/keys'
import {
  buildPalette,
  flatten,
  openingRow,
  rowCwd,
  rowLabel,
  rowMachine,
  rowTarget,
  type Palette,
  type SwitcherRow,
} from '@/switcher/order'
import type { RecentVisit } from '@/switcher/recents'

/**
 * How long a highlighted row has to be the highlighted row before the machine
 * holding it is asked what it is doing.
 *
 * The same idea as the hover card's rest delay and a third of the length,
 * because the gesture is different: a pointer crosses rows by accident, an
 * arrow key does not. What this is protecting against is the held arrow key —
 * twenty rows travelled in a second is twenty round trips to as many machines,
 * most of them over a relay, for previews nobody saw.
 */
const PEEK_SETTLE_MS = 120

/** How much scrollback a peek asks for. The hover card's number. */
const PEEK_BYTES = 24 << 10

/** How many lines the pane shows. */
const PEEK_LINES = 14

export interface SessionSwitcherProps {
  open: boolean
  onOpenChange(open: boolean): void
  /** Every session the fleet can currently see, across machines. */
  sessions: FleetSession[]
  /** Where this browser has been, newest first. */
  recents: RecentVisit[]
  /** The session this tab is in, as `machineId/sessionId`, if it is in one. */
  currentKey?: string | null
  /** Fetch a session's scrollback tail. Rejecting means "cannot say". */
  peek(target: { machineId: string; sessionId: string }): Promise<{
    data: string
    cols: number
    rows: number
  }>
  /** Go to a session. The palette closes itself first. */
  onPick(target: { machineId: string; sessionId: string }): void
  /** Start a session where the tab already is, for the dead-end row. */
  onSpawn(): void
  /** What that row should say it will do. Absent means no machine to do it on. */
  spawnLabel?: string | null
}

/**
 * The session switcher: every session on every machine, one keystroke away.
 *
 * It takes its rows as props and holds no fleet, for the reason PreviewCard
 * gives for the same split — everything here renders in a test without a socket
 * — and because the arrangement it draws is decided in switcher/order.ts, which
 * is unit-tested on its own.
 *
 * Two clocks meet here and neither is the sessions screen's. That screen waits
 * 150ms after a keystroke before it re-cuts its groups, because a reader
 * watching headings appear and vanish under their own typing is worse than a
 * list that lags. A palette is the opposite case: the list is flat, short, and
 * the whole point of it is to answer instantly, so filtering happens on the
 * keystroke and nothing waits. What waits is the peek, which costs a machine a
 * round trip.
 */
export function SessionSwitcher({
  open,
  onOpenChange,
  sessions,
  recents,
  currentKey = null,
  peek,
  onPick,
  onSpawn,
  spawnLabel = null,
}: SessionSwitcherProps) {
  const [search, setSearch] = useState('')
  const [highlight, setHighlight] = useState<string | null>(null)
  const mobile = useIsMobile()
  const apple = useMemo(() => isApplePlatform(), [])

  /*
   * The rows the fleet is reporting *now*, read from inside the memo below
   * without being a dependency of it.
   *
   * This is the whole of how the arrangement stays still. `onFleet` fires every
   * three seconds and hands back fresh arrays, so a `sessions` dependency would
   * rebuild the palette on every poll: rows would re-sort under the reader's
   * highlight — a session that printed a line climbing past the one being read
   * — and a list that reorders between deciding and pressing Enter sends
   * somebody to the wrong session. The arrangement is settled when the palette
   * opens and whenever the search changes, and only then.
   */
  const latest = useRef({ sessions, recents, currentKey })
  latest.current = { sessions, recents, currentKey }

  const arrangement = useMemo<Palette>(() => {
    if (!open) return { sections: [], overflow: 0 }
    const now = latest.current
    return buildPalette({
      sessions: now.sessions,
      recents: now.recents,
      search,
      currentKey: now.currentKey,
    })
    // `open` re-settles it on each opening, so a palette reopened after a
    // session was started elsewhere is not showing yesterday's fleet.
  }, [open, search])

  /*
   * The same rows, with the newest word on each of them.
   *
   * Order comes from the arrangement, the words from the poll: a row whose
   * session is still there is redrawn from the current row — its title, its
   * state, its directory — and a row whose session has gone keeps the last
   * thing known about it rather than vanishing mid-read. Sessions that appear
   * while the palette is up wait for the next keystroke or the next opening,
   * which is a fair price for a list that does not move.
   */
  const live = useMemo(() => new Map(sessions.map((s) => [`${s.machineId}/${s.id}`, s])), [sessions])
  const palette = useMemo<Palette>(
    () => ({
      overflow: arrangement.overflow,
      sections: arrangement.sections.map((section) => ({
        ...section,
        rows: section.rows.map((row) => {
          const fresh = live.get(row.key)
          if (row.kind !== 'live' || fresh === undefined) return row
          return { ...row, session: fresh, current: row.key === currentKey }
        }),
      })),
    }),
    [arrangement, live, currentKey],
  )

  const rows = useMemo(() => flatten(palette), [palette])

  /*
   * The highlight is held as a row key rather than an index, and that is a
   * correctness matter rather than a preference: an index means "the third
   * row", and the third row is a different session the moment anything above it
   * changes. A key means the session somebody actually chose. When the key
   * stops existing — a search narrowed past it — the highlight falls to
   * whatever the palette would have opened on.
   */
  const active = rows.find((r) => r.key === highlight) ?? null
  useEffect(() => {
    if (!open) return
    if (rows.some((r) => r.key === highlight)) return
    setHighlight(openingRow(palette)?.key ?? null)
  }, [open, rows, highlight, palette])

  // A fresh palette every time: reopening on last week's search, with the
  // highlight parked where it was left, is a palette that has to be cleared
  // before it can be used.
  useEffect(() => {
    if (open) return
    setSearch('')
    setHighlight(null)
  }, [open])

  const preview = usePreview(active, peek, open && !mobile)

  const pick = (row: SwitcherRow | null) => {
    if (row === null) return
    onOpenChange(false)
    onPick(rowTarget(row))
  }

  const move = (delta: number) => {
    if (rows.length === 0) return
    const at = active === null ? -1 : rows.indexOf(active)
    const next = at < 0 ? (delta > 0 ? 0 : rows.length - 1) : (at + delta + rows.length) % rows.length
    setHighlight(rows[next]?.key ?? null)
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    // The pinned chords, live inside the palette as well as outside it, so a
    // hand already on Ctrl+Shift does not have to leave for the arrow keys.
    const chord = matchChord(e.nativeEvent, apple)
    if (chord?.kind === 'pinned') {
      e.preventDefault()
      const pinned = rows.filter((r) => r.kind === 'live' && r.badge !== null)
      pick(pinned[chord.index - 1] ?? null)
      return
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      move(1)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      move(-1)
    } else if (e.key === 'Home') {
      e.preventDefault()
      setHighlight(rows[0]?.key ?? null)
    } else if (e.key === 'End') {
      e.preventDefault()
      setHighlight(rows[rows.length - 1]?.key ?? null)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (rows.length === 0 && spawnLabel !== null) {
        onOpenChange(false)
        onSpawn()
        return
      }
      pick(active)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        aria-describedby={undefined}
        // Anchored high rather than centred: a palette grows downwards as it
        // fills, and one pinned to the middle of the window would slide its own
        // search field up the screen while somebody types into it.
        className={cn(
          'top-[12vh] w-[56rem] translate-y-0 gap-0 overflow-hidden p-0 sm:max-w-[calc(100vw-2rem)]',
          'max-h-[76vh] max-md:top-auto max-md:bottom-0 max-md:h-[85vh] max-md:max-h-none',
          'max-md:w-full max-md:rounded-b-none',
        )}
      >
        <DialogTitle className="sr-only">Switch session</DialogTitle>

        <div className="flex items-center gap-x-2.5 border-b border-hairline px-3.5">
          <MagnifyingGlassIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
          <input
            autoFocus
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-controls="switcher-rows"
            aria-activedescendant={active ? rowId(active) : undefined}
            aria-label="Search sessions"
            placeholder="Go to session…"
            autoComplete="off"
            spellCheck={false}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={onKeyDown}
            className="h-11 w-full bg-transparent text-base text-foreground outline-none placeholder:text-muted-foreground sm:text-control"
          />
        </div>

        <div className="flex min-h-0 flex-1">
          <div
            className={cn(
              'min-h-0 flex-1 overflow-y-auto py-1.5',
              // The pane beside it only exists where there is width for one.
              'md:w-[24rem] md:flex-none md:border-r md:border-hairline',
            )}
          >
            <ul id="switcher-rows" role="listbox" aria-label="Sessions">
              {palette.sections.map((section) => (
                <li key={section.key}>
                  <p className="px-3.5 pt-2 pb-1 text-[0.6875rem] font-medium tracking-wide text-muted-foreground uppercase">
                    {section.label}
                  </p>
                  <ul>
                    {section.rows.map((row) => (
                      <Row
                        key={row.key}
                        row={row}
                        active={row.key === active?.key}
                        onHighlight={() => setHighlight(row.key)}
                        onPick={() => pick(row)}
                      />
                    ))}
                  </ul>
                </li>
              ))}
            </ul>

            {rows.length === 0 && (
              <div className="px-3.5 py-6">
                <p className="text-control text-muted-foreground">
                  {search.trim() === '' ? 'No sessions yet.' : `Nothing matching “${search.trim()}”.`}
                </p>
                {spawnLabel !== null && (
                  <button
                    type="button"
                    onClick={() => {
                      onOpenChange(false)
                      onSpawn()
                    }}
                    className="mt-2 rounded-md px-2 py-1.5 -mx-2 text-control font-medium text-foreground transition-colors hover:bg-row-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                  >
                    {spawnLabel}
                  </button>
                )}
              </div>
            )}

            {palette.overflow > 0 && (
              // Said out loud rather than silently truncated: a list that stops
              // at fifty and does not mention it reads as a fleet of fifty.
              <p className="px-3.5 py-2 text-control text-muted-foreground">
                {palette.overflow} more — keep typing to narrow.
              </p>
            )}
          </div>

          {/* A fixed floor under the pane, so arrowing between a two-line
              preview and a fourteen-line one cannot change the panel's height
              and shove the list out from under the reader's eye. */}
          <div className="hidden min-h-[19rem] flex-1 md:block">
            {active === null ? null : active.kind === 'ghost' ? (
              <GhostPane row={active} />
            ) : (
              <PreviewCard session={active.session} preview={preview} />
            )}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-hairline bg-muted/40 px-3.5 py-2 text-[0.6875rem] text-muted-foreground">
          <Hint keys="↑↓" what="move" />
          <Hint keys="↵" what="open" />
          <Hint keys={apple ? '⌃⇧1-9' : 'Ctrl+Shift+1-9'} what="pinned" />
          <Hint keys={apple ? '⌃⇧[ ]' : 'Ctrl+Shift+[ ]'} what="prev / next" />
          <span className="ml-auto">
            <Hint keys="esc" what="close" />
          </span>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/** The id an option carries, so the field can name it as the active one. */
function rowId(row: SwitcherRow): string {
  return `switcher-row-${row.key}`
}

function Hint({ keys, what }: { keys: string; what: string }) {
  return (
    <span className="flex items-center gap-x-1">
      <kbd className="font-mono">{keys}</kbd>
      {what}
    </span>
  )
}

/**
 * One row.
 *
 * The dot carries the state, as it does on a session row: teal for something
 * running, hollow for a session that has ended, and hollow again for a ghost —
 * a machine this browser cannot reach right now can say nothing about what is
 * happening inside it, and a confident green dot over an unreachable machine
 * would be the list inventing news.
 */
function Row({
  row,
  active,
  onHighlight,
  onPick,
}: {
  row: SwitcherRow
  active: boolean
  onHighlight(): void
  onPick(): void
}) {
  const ended = row.kind === 'live' && row.session.state === 'exited'
  const ghost = row.kind === 'ghost'
  return (
    <li
      id={rowId(row)}
      role="option"
      aria-selected={active}
      onPointerMove={onHighlight}
      onClick={onPick}
      className={cn(
        'relative flex h-8 cursor-pointer items-center gap-x-2.5 px-3.5 text-control',
        active && 'bg-row-hover',
      )}
    >
      {/* The rule rather than a coloured row: teal has a short list of jobs in
          this app and "where the keyboard is" is one of them. */}
      {active && <span aria-hidden="true" className="absolute inset-y-0 left-0 w-0.5 bg-teal-500" />}
      <span
        aria-hidden="true"
        className={cn(
          'size-1.5 shrink-0 rounded-full',
          ghost || ended ? 'bg-zinc-950/25 dark:bg-white/25' : 'bg-teal-500',
        )}
      />
      <span
        className={cn(
          'truncate font-medium',
          ghost ? 'text-muted-foreground' : 'text-zinc-950 dark:text-white',
        )}
      >
        {rowLabel(row)}
      </span>
      <span className="truncate font-mono text-xs text-muted-foreground">{rowCwd(row)}</span>
      <span className="ml-auto flex shrink-0 items-center gap-x-2 pl-2">
        {row.current && <span className="text-xs text-muted-foreground">current</span>}
        <span className="font-mono text-xs text-muted-foreground">{rowMachine(row)}</span>
        {ghost ? (
          <span className="text-xs text-muted-foreground">unreachable</span>
        ) : row.badge !== null ? (
          <kbd className="font-mono text-xs text-muted-foreground">⌃⇧{row.badge}</kbd>
        ) : null}
      </span>
    </li>
  )
}

/**
 * What the pane shows for a session only this browser remembers.
 *
 * It says what is known and does not pretend to more: the name it had, where it
 * was, and that the machine is not answering. Deliberately not a refusal — the
 * row is still selectable, and the terminal it opens has its own answer for a
 * machine that is not there.
 */
function GhostPane({ row }: { row: Extract<SwitcherRow, { kind: 'ghost' }> }) {
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-x-2 border-b border-hairline px-3 py-2">
        <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-zinc-950/25 dark:bg-white/25" />
        <span className="truncate font-medium text-muted-foreground">{row.visit.label}</span>
        <span className="ml-auto shrink-0 font-mono text-xs text-muted-foreground">
          {row.visit.machineName}
        </span>
      </div>
      <div className="flex flex-1 items-center justify-center px-6 py-8">
        <p className="text-center text-control text-muted-foreground">
          {row.visit.machineName} is not reachable from here right now.
          <br />
          Open it anyway and flue will keep trying.
        </p>
      </div>
      <p title={row.visit.cwd} className="truncate border-t border-hairline px-3 py-1.5 font-mono text-xs text-muted-foreground">
        {row.visit.cwd}
      </p>
    </div>
  )
}

/**
 * The highlighted row's recent output, fetched once it has settled.
 *
 * Answers are kept for as long as the palette is up: walking back up a list
 * should not re-ask three machines for bytes this component read a second ago.
 * They are dropped with the palette, because a preview is a claim about what a
 * session is doing now.
 *
 * The generation counter settles the two races the hover card names: an answer
 * arriving after the highlight has moved must not fill in the wrong pane, and
 * one arriving after the palette has closed must not set state at all.
 */
function usePreview(
  row: SwitcherRow | null,
  peek: SessionSwitcherProps['peek'],
  wanted: boolean,
): Preview {
  const [cache, setCache] = useState<Map<string, Preview>>(() => new Map())
  const generation = useRef(0)
  const ask = useRef(peek)
  ask.current = peek

  const key = row?.kind === 'live' ? row.key : null
  const target = row?.kind === 'live' ? rowTarget(row) : null
  const machineId = target?.machineId ?? ''
  const sessionId = target?.sessionId ?? ''

  useEffect(() => {
    if (!wanted || key === null) return
    // Held answers are not re-asked. A palette is open for seconds, and a
    // second read of the same session inside that window would cost a machine a
    // round trip to tell the pane what it is already showing.
    if (cache.has(key)) return
    const mine = ++generation.current
    const timer = setTimeout(() => {
      ask.current({ machineId, sessionId }).then(
        (answer) => {
          if (generation.current !== mine) return
          setCache((prev) =>
            new Map(prev).set(key, {
              at: 'ready',
              lines: previewLines(decodeBase64(answer.data), answer.cols, answer.rows, PEEK_LINES),
            }),
          )
        },
        () => {
          if (generation.current !== mine) return
          // Every refusal reads the same, as the hover card's does: a machine
          // that went away, a session reaped a moment ago and a daemon
          // mid-reconnect are three ways of saying there is nothing to show.
          setCache((prev) => new Map(prev).set(key, { at: 'unavailable' }))
        },
      )
    }, PEEK_SETTLE_MS)
    return () => {
      clearTimeout(timer)
      generation.current++
    }
    // `cache` is read here and deliberately not depended on: it changes when an
    // answer lands, and an effect that woke on that would tear down the timer it
    // had just armed for the next row. What this depends on is which row is
    // highlighted, which is the three values below.
  }, [wanted, key, machineId, sessionId])

  useEffect(() => {
    if (wanted) return
    setCache(new Map())
  }, [wanted])

  if (key === null) return { at: 'unavailable' }
  return cache.get(key) ?? { at: 'loading' }
}
