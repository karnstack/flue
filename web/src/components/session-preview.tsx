import { useEffect, useRef, useState, type ReactNode } from 'react'

import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card'
import type { FleetSession } from '@/fleet/types'
import { cn } from '@/lib/utils'
import { decodeBase64, previewLines } from '@/sessions/preview'
import { displayName } from '@/sessions/view'

/**
 * How long the pointer has to rest on a row before the daemon is asked.
 *
 * A preview costs a round trip and a slice of a session's scrollback, and a
 * pointer travelling to the button at the top of the page crosses every row on
 * the way. Long enough that a crossing costs nothing, short enough that
 * stopping on a row feels like it answered rather than like it loaded.
 */
const OPEN_DELAY_MS = 400

/** How long the card stays up after the pointer leaves, so a wobble is free. */
const CLOSE_DELAY_MS = 120

/** How many lines the card shows. Twelve is about a third of a terminal. */
const PREVIEW_LINES = 14

/**
 * How much scrollback to ask for.
 *
 * More than the lines shown need, and deliberately: the bytes are a tail, so
 * they begin mid-frame, and a full-screen program's redraw of a 14-line region
 * can easily run to several kilobytes of cursor moves and colour before a
 * single character of the current frame appears. Ask for too little and the
 * card renders the bottom half of a frame with the top half missing.
 */
const PREVIEW_BYTES = 24 << 10

/**
 * How often an open card re-asks.
 *
 * A preview of a build that is running is worth watching for the few seconds
 * somebody holds a pointer over it, and a card that froze at the instant it
 * opened would be a screenshot presented as a window. Only while open: nothing
 * polls a card nobody is looking at.
 */
const REFRESH_MS = 1_500

/**
 * Whether this device points with something that cannot hover.
 *
 * A hover card on a touch screen is not merely useless, it is in the way: a
 * finger held on a row long enough to count as a hover opens a card over the
 * rows below, and the tap that follows either lands on the card or dismisses
 * it — so the ordinary act of opening a session becomes a fight with a preview
 * nobody asked for. And it would cost a round trip per row to do it.
 *
 * `(pointer: coarse)` rather than a width breakpoint, because the question is
 * about the pointer and not the screen: a laptop with a narrow window still
 * has a mouse, and a large tablet still does not.
 *
 * It starts false and corrects itself on mount, which is the right way round —
 * the card cannot open before a pointer has done something anyway, and a
 * server-rendered guess is not available here.
 */
function useCoarsePointer(): boolean {
  const [coarse, setCoarse] = useState(false)
  useEffect(() => {
    const mql = window.matchMedia('(pointer: coarse)')
    const read = () => setCoarse(mql.matches)
    read()
    mql.addEventListener('change', read)
    return () => mql.removeEventListener('change', read)
  }, [])
  return coarse
}

/** What the card is currently able to say. */
export type Preview =
  | { at: 'loading' }
  | { at: 'ready'; lines: string[] }
  | { at: 'unavailable' }

/**
 * A session's recent output, on hover.
 *
 * The question this answers is the one the sessions list could not: a row says
 * what a session is called, where it runs and when it was last touched, and
 * none of that says what it is *doing*. A name is a guess made when the
 * session was created; the last fourteen lines it drew are what is actually
 * happening in it.
 *
 * Everything here is arranged around one constraint — a list has many rows and
 * a pointer crosses all of them. So nothing is asked for until a pointer has
 * rested (`OPEN_DELAY_MS`), nothing is kept when the card closes, and the
 * request is a `peek` rather than an attach: no ref is minted, no stream
 * starts, and the session's own `lastActive` is not touched, which matters
 * more than it sounds — the default ordering is by that stamp, so a preview
 * that counted as activity would sort the row the pointer is resting on to the
 * top of the list underneath it.
 *
 * The card is deliberately not a live terminal. It is text, in the terminal's
 * font, with the colour dropped: a preview is read at a glance and colour at
 * this size is noise, while a real emulator per row would cost a canvas and a
 * WebGL context each.
 */
export function SessionPreview({
  session,
  peek,
  children,
  disabled = false,
}: {
  session: FleetSession
  /** Fetch this session's scrollback tail. Rejecting means "cannot say". */
  peek: (session: FleetSession, bytes: number) => Promise<{
    data: string
    cols: number
    rows: number
  }>
  /** The row the card hangs off. */
  children: ReactNode
  /**
   * Skip the card entirely. A coarse pointer already does this for itself —
   * see useCoarsePointer — so this is for a caller that has some other reason
   * to want the row bare.
   */
  disabled?: boolean
}) {
  const coarse = useCoarsePointer()
  const [open, setOpen] = useState(false)
  const [preview, setPreview] = useState<Preview>({ at: 'loading' })

  /**
   * Which fetch the card is currently interested in.
   *
   * A card closed and reopened over a different row must not be filled in by
   * the first row's answer, and an answer that arrives after the pointer has
   * gone must not set state on a card that is no longer up. One counter
   * settles both: every fetch remembers the generation it was issued in, and
   * an answer from an older one is dropped.
   */
  const generation = useRef(0)

  /**
   * The current `peek` and the current row, readable from inside the effect
   * without being in its dependencies.
   *
   * This is not a style choice. The row arrives from the fleet, which re-lists
   * every three seconds and hands back fresh objects each time, so a `session`
   * in the dependency array is a *new value* on every poll: the effect would
   * tear down, set the card back to "Reading…" and refetch three times as
   * often as it was asked to, which on screen is a card that blinks while the
   * pointer rests on it. What the effect actually depends on is *which* row is
   * being previewed, which is the two identifiers below and nothing else.
   */
  const latest = useRef({ peek, session })
  latest.current = { peek, session }

  const { machineId, id } = session

  useEffect(() => {
    if (!open) return

    const load = (mine: number) => {
      const { peek: ask, session: row } = latest.current
      ask(row, PREVIEW_BYTES).then(
        (answer) => {
          if (generation.current !== mine) return
          setPreview({
            at: 'ready',
            lines: previewLines(
              decodeBase64(answer.data),
              answer.cols,
              answer.rows,
              PREVIEW_LINES,
            ),
          })
        },
        () => {
          if (generation.current !== mine) return
          // Every refusal reads the same on screen, and that is right: a
          // machine that went away, a session reaped a moment ago and a daemon
          // mid-reconnect are three ways of saying the card cannot show
          // anything, and a reader hovering a row wants the row, not a
          // diagnosis of the transport.
          setPreview({ at: 'unavailable' })
        },
      )
    }

    const mine = ++generation.current
    setPreview({ at: 'loading' })
    load(mine)
    const timer = setInterval(() => load(mine), REFRESH_MS)
    return () => {
      clearInterval(timer)
      // Bumped on the way out as well as the way in, so an answer already in
      // flight when the pointer leaves cannot land on the next card.
      generation.current++
    }
    // machineId and id are the row's identity; see `latest` for why the row
    // itself is deliberately not here.
  }, [open, machineId, id])

  if (disabled || coarse) return <>{children}</>

  return (
    <HoverCard
      open={open}
      onOpenChange={setOpen}
      openDelay={OPEN_DELAY_MS}
      closeDelay={CLOSE_DELAY_MS}
    >
      {/*
        `asChild` onto whatever the row is, so no wrapper element lands between
        the list item and what it holds — the row's layout is a flex line and an
        extra div in it would break the alignment of every cell.
      */}
      <HoverCardTrigger asChild>{children}</HoverCardTrigger>
      {/*
        Below the row and aligned to its left edge, never beside it. The row's
        own trailing details — its tags, its machine, when it was last touched
        — sit to the right of the name, so a card placed on that side covers
        the very row the pointer is resting on. Dropping it underneath covers
        the rows *below*, which is what a hover card is for and what the reader
        expects when something opens under their pointer.
      */}
      <HoverCardContent side="bottom" align="start" className="w-[30rem] max-w-[90vw] p-0">
        <PreviewCard session={session} preview={preview} />
      </HoverCardContent>
    </HoverCard>
  )
}

/** The card's own markup, with no fetching in it, so it renders in a test. */
export function PreviewCard({
  session,
  preview,
}: {
  session: FleetSession
  preview: Preview
}) {
  const ended = session.state === 'exited'
  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-x-2 border-b border-hairline px-3 py-2">
        <span
          aria-hidden="true"
          className={cn(
            'size-1.5 shrink-0 rounded-full',
            ended ? 'bg-zinc-950/30 dark:bg-white/30' : 'bg-teal-500',
          )}
        />
        <span className="truncate font-medium text-zinc-950 dark:text-white">
          {displayName(session)}
        </span>
        <span className="ml-auto shrink-0 truncate font-mono text-xs text-zinc-500 dark:text-zinc-400">
          {session.machineName}
        </span>
      </div>

      {/*
        The terminal's own ground, in both themes, exactly as the empty state's
        figure is: a preview of a terminal that sat on a white card would be
        the one place in the app where terminal output is not on a dark
        surface, and the eye reads the mismatch before it reads the text.
      */}
      <div className="bg-zinc-950 px-3 py-2.5 dark:bg-zinc-950/60">
        <PreviewBody preview={preview} exited={ended} exitCode={session.exitCode} />
      </div>

      <p
        title={session.cwd}
        className="truncate border-t border-hairline px-3 py-1.5 font-mono text-xs text-zinc-500 dark:text-zinc-400"
      >
        {session.cwd}
      </p>
    </div>
  )
}

function PreviewBody({
  preview,
  exited,
  exitCode,
}: {
  preview: Preview
  exited: boolean
  exitCode: number
}) {
  if (preview.at === 'loading') {
    return (
      <p className="font-mono text-xs/5 text-zinc-500">
        Reading…
        <span
          aria-hidden="true"
          className="ml-1 inline-block h-[1.05em] w-[0.55em] align-text-bottom bg-teal-400 motion-safe:animate-blink"
        />
      </p>
    )
  }
  if (preview.at === 'unavailable') {
    return <p className="font-mono text-xs/5 text-zinc-500">No preview right now.</p>
  }
  if (preview.lines.length === 0) {
    return (
      <p className="font-mono text-xs/5 text-zinc-500">
        {exited ? `Ended with ${exitCode} and drew nothing.` : 'Nothing drawn yet.'}
      </p>
    )
  }
  return (
    /*
      `pre` with wrapping off: the lines were laid out against a terminal's own
      width by the renderer, and letting the card re-wrap them would fold an
      aligned column of output in half. The overflow is hidden rather than
      scrolled — a card that appears under the pointer and then asks to be
      scrolled is a control, and this is a glance.

      Which leaves the cut edge, and a hard one reads as a rendering fault
      rather than as a line that carries on. The mask fades the last few
      characters out instead, so the edge says "there is more of this" the way
      a terminal's own right margin does. A mask rather than an overlay,
      because the ground behind it is the card's dark panel and an overlay
      would have to name that colour a second time.
    */
    <pre className="overflow-hidden font-mono text-[11px]/[1.45] whitespace-pre text-zinc-300 [mask-image:linear-gradient(to_right,black_calc(100%-2rem),transparent)]">
      {preview.lines.join('\n')}
    </pre>
  )
}
