import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { LayoutGridIcon, PlusIcon } from 'lucide-react'

import { useFlueClient } from '@/client/provider'
import { ExitOverlay } from '@/components/exit-overlay'
import { KeyBar } from '@/components/key-bar'
import { ThemeMenu } from '@/components/theme-menu'
import { DARK_SCHEME_QUERY, prefersDark } from '@/emulator/palette'
import { controlColors, resolveTheme, THEME_SYSTEM } from '@/emulator/themes'
import type { Emulator } from '@/emulator/types'
import { createXtermEmulator, type XtermOptions } from '@/emulator/xterm'
import { loadThemePref, saveThemePref, THEME_PREF_KEY } from '@/lib/theme-pref'
import {
  cellBox,
  cellsThatFit,
  fitFactor,
  GUTTER_PX,
  type Box,
  type Dimensions,
} from '@/lib/geometry'
import { startGlide } from '@/lib/glide'
import { createKeyboardModes, type KeyboardMode } from '@/lib/keyboard'
import { barKeyBytes, ctrlTransform, type BarKey } from '@/lib/keys'
import { cn } from '@/lib/utils'
import { trackVisualViewport, zoomedIn } from '@/lib/viewport'

/** What the view is showing, which is not the same as what the socket is doing. */
type Phase = 'connecting' | 'live' | 'reconnecting' | 'exited' | 'gone'

export interface TerminalProps {
  /**
   * The session to attach to. Required, and deliberately so.
   *
   * The obvious extra — spawn a session when this is absent — cannot be made
   * safe here. `spawn` carries no key the daemon could deduplicate on, and
   * React runs every mount effect twice in development, so a spawning view
   * starts two shells on every single mount and can only ever detach one.
   * Creating a session belongs to whatever navigates here with its id.
   */
  sessionId: string
  /**
   * Build the emulator. The seam tests reach for; nothing in the app passes it.
   */
  createEmulator?: (opts: XtermOptions) => Emulator
  /**
   * Called with the new session's id once a Restart's spawn has attached.
   * The route supplies navigation; the component never touches the router.
   */
  onRestarted?: (sessionId: string) => void
  /** Called after Close has closed the dead session; navigate away here. */
  onClosed?: () => void
}

/** Named so the test and the markup cannot drift apart. */
export const TERMINAL_SHORTCUT_HINT = 'Ctrl+Shift+Enter'

/**
 * A full reset, sent before a truncated snapshot.
 *
 * RIS rather than the reflex ESC[2J ESC[H. A snapshot arrives with no
 * assumptions attached — the evicted output may have left a scroll region, an
 * alternate screen, a character set or an SGR attribute in force, and an
 * erase-in-display clears none of those. What follows would then be painted
 * through the leftovers of a past this view can no longer see.
 */
const RESET = new TextEncoder().encode('\x1bc')

const EXIT_NOTICE = (code: number) =>
  new TextEncoder().encode(`\r\n\x1b[90m[process exited: ${code}]\x1b[0m\r\n`)

/**
 * How long the pane must hold still before the pty hears about its size.
 *
 * Longer than any animation frame, shorter than a human pause: a browser
 * sidebar's slide reaches the pty once instead of twenty SIGWINCHes' worth
 * of redrawn prompts, and a hand-dragged window reflows once it rests.
 * (Written around the bare word for the CSS property here — see the
 * Tailwind scanner note in docs/FOLLOW-UPS.md.)
 */
export const RESIZE_SETTLE_MS = 150

/**
 * The terminal, full bleed, one session.
 *
 * This renders outside AppShell on purpose: a session *is* the tab, so sidebar
 * chrome around it would contradict the premise of the project. The only thing
 * ever drawn over the terminal is a status pill, and only when the terminal is
 * not usable.
 *
 * ## The sizing policy
 *
 * Every attached view measures its own pane and reports the cells that fit
 * it; the daemon sizes the pty to the fit of the most recently active view
 * (`effectiveLocked` in internal/daemon) — activity being input, a report,
 * a signal or the attach itself. A view whose own fit matches or exceeds
 * the pty renders it one-to-one; a smaller view renders the full screen and
 * scales the whole surface down, staying fully interactive. Picking up the
 * phone therefore reshapes the session to the phone the moment its report
 * lands, and the first keystroke back on the laptop reshapes it back; a
 * detaching view hands the size to whichever remaining view was active
 * last. Ownership of the *primary* role never moves with any of this — the
 * daemon keeps one client primary purely to answer device queries.
 *
 * Known cost of that scaling, and it is a real one: xterm derives mouse
 * coordinates from `getBoundingClientRect`, which reports the *scaled* box, so
 * click-to-position and drag-select land off by the scale factor on a
 * scaled view. Keyboard input, which is what a terminal is for, is
 * unaffected. The alternative — scaling by font size instead — keeps mouse
 * coordinates honest but makes what a view reports depend on how small a
 * font it is willing to draw, so the session's shape would follow rendering
 * choices rather than the pane a human is looking at.
 *
 * ## One view per session per tab
 *
 * FlueClient's reattach plan holds one entry per session, and `attached`
 * carries no field saying which of two views asked. Two of these on one
 * session in one tab would survive until the first reconnect and then both sit
 * on one ref. Do not build one.
 */
export function Terminal({
  sessionId,
  createEmulator = createXtermEmulator,
  onRestarted,
  onClosed,
}: TerminalProps) {
  const client = useFlueClient()
  const paneRef = useRef<HTMLDivElement>(null)
  const innerRef = useRef<HTMLDivElement>(null)
  const surfaceRef = useRef<HTMLDivElement>(null)
  // Seeded from the client rather than assumed, because onStatus reports only
  // changes: a view mounted into a connection that is already up would
  // otherwise sit at "Connecting" until something else went wrong.
  const [phase, setPhase] = useState<Phase>(() =>
    client.status === 'reconnecting' ? 'reconnecting' : 'connecting',
  )
  const [mode, setMode] = useState<KeyboardMode>('tab')
  // Coarse pointer once per mount: whether this device's primary pointer is a
  // finger decides the key bar's existence, and a pointer does not change
  // class mid-session in any way worth re-rendering for.
  const [coarse] = useState(() => globalThis.matchMedia?.('(pointer: coarse)')?.matches ?? false)
  // The latched Ctrl: state for the chip's pressed look, a ref for the input
  // path, which lives inside the effect and must read it without re-running.
  const [ctrlArmed, setCtrlArmed] = useState(false)
  const ctrlArmedRef = useRef(ctrlArmed)
  ctrlArmedRef.current = ctrlArmed
  const [exitCode, setExitCode] = useState<number | null>(null)
  // This session's directory, for Restart and the new-session link. From the
  // session list, because `attached` does not carry it.
  const [cwd, setCwd] = useState<string | null>(null)
  // The theme choice — global, every session wears it — read once per mount
  // and mirrored into a ref so the effect can resolve it without carrying
  // the state in its dependency array: a theme change must restyle the live
  // emulator, never rebuild it, because rebuilding drops the scrollback.
  const [themeId, setThemeId] = useState(loadThemePref)
  const themeIdRef = useRef(themeId)
  themeIdRef.current = themeId
  // The OS scheme, in state as well as in the effect's media listener: the
  // floating controls are rendered, not painted imperatively, and their
  // colours follow the resolved theme — which under System changes with the
  // scheme.
  const [dark, setDark] = useState(prefersDark)
  // The effect's handles for the floating controls. The spawn bookkeeping
  // and the emulator are effect-local, so the actions that need them are
  // built inside the effect and reached from render through this ref. Close
  // needs no daemon action at all: the exit already retired the ref on both
  // ends, and an exited session reaps itself after ExitedRetention — Close
  // just leaves.
  const actionsRef = useRef<{
    restart: (dir: string | null) => void
    applyTheme: (id: string) => void
    sendKey: (key: BarKey) => void
  } | null>(null)
  // The latest onRestarted, readable from inside the effect without putting
  // a prop identity in its dependency array.
  const restartedRef = useRef(onRestarted)
  restartedRef.current = onRestarted

  useEffect(() => {
    const pane = paneRef.current
    const inner = innerRef.current
    const surface = surfaceRef.current
    if (!pane || !inner || !surface) return

    // The document's canvas, painted along with the pane wherever the theme
    // lands. The pane stops at the visual viewport while a phone keyboard is
    // up, and rubber-band overscroll runs past the page: both bands show the
    // canvas, which otherwise wears the app scheme's colour — a dark OS under
    // a light terminal theme put a black flash behind every keyboard open.
    // Restored on unmount so the rest of the app keeps its stylesheet colour.
    const canvas = document.documentElement
    const priorCanvas = canvas.style.backgroundColor
    // What this effect last painted, read back so the value carries the
    // style engine's own serialisation. The cleanup compares before it
    // restores, for the reason the viewport tracker's disposer does: a
    // replacement owner can paint before this one tears down, and a stale
    // cleanup must surrender only what it still owns.
    let paintedCanvas = ''
    const paintGround = (bg: string | undefined) => {
      pane.style.backgroundColor = bg ?? ''
      canvas.style.backgroundColor = bg ?? ''
      paintedCanvas = canvas.style.backgroundColor
    }

    const palette = resolveTheme(themeIdRef.current, prefersDark())
    const emulator = createEmulator({ cols: 80, rows: 24, theme: palette })
    emulator.attachTo(surface)
    emulator.focus()
    paintGround(palette.background)

    // Everything below is effect-local rather than a ref, because all of it
    // belongs to one emulator and one attachment: a second mount gets its own.
    let ref: number | null = null
    let primary = false
    let dims: Dimensions = { cols: 80, rows: 24 }
    // The fit this view last told the daemon about, per connection: the
    // daemon holds one desired size per attachment, so re-sending an
    // unchanged one is noise — and under the largest-view policy a small
    // view's fit never converges on `dims`, so `dims` cannot be the guard.
    let reported: Dimensions | null = null
    // The replay mute gate, per-attach state: every `attached` re-arms it.
    // consumed counts this ref's output bytes from seq — advanced in each
    // write's done callback, not at frame arrival, because xterm parses
    // asynchronously and emits its probe answers during that parse; a counter
    // running ahead of the parser would open the gate with the replies still
    // to come. Input is muted while consumed < muteUntil, so emulator-made
    // answers to replayed probe sequences (DA, DECRQM, OSC 11) never reach
    // the shell's stdin. head === seq on a fresh spawn opens it immediately.
    let consumed = 0
    let muteUntil = 0
    // The attachment's epoch, stepped with every reseed. Each done callback
    // below closes over the value it was written under: one enqueued under a
    // previous attachment can fire after the reseed, and its bytes are
    // already counted — the reattach's seq names where they ended, so letting
    // it add them again would open the new gate early. The ref cannot stand
    // in for this check: the daemon numbers refs from 1 again on every
    // connection, so the same value plausibly names both attachments.
    let epoch = 0
    // Set once the session can produce nothing further — the process exited,
    // or the daemon has never heard of it. Both are terminal, so a later
    // reconnect must not walk the pill back to "Reconnecting…" and imply that
    // waiting will help.
    let over = false
    // The reqId of a Restart's spawn, unanswered. Doubles as the click guard:
    // one restart in flight at a time, per mount.
    let restartReq: number | null = null
    let frame = 0
    // The pty-resize debounce. A browser sidebar sliding open resizes the
    // pane on every animation frame, and each new pty size is a SIGWINCH the
    // shell answers by redrawing its prompt — an animated toggle used to
    // leave a wall of prompt lines in the scrollback, with right-prompt
    // fragments stranded at every mid-animation width. Display keeps up per
    // frame; the pty hears about it once, when the layout has settled.
    let settleTimer = 0
    const priorTitle = document.title

    const paneBox = (): Box => {
      // The inner box, not the pane: the pane carries the padding that gives
      // the terminal its margin, and cells are fit to what is inside it.
      const box = inner.getBoundingClientRect()
      return { width: box.width, height: box.height }
    }

    /**
     * Put the surface where the policy says it goes.
     *
     * Deferred to an animation frame by `schedule`: the emulator lays out its
     * screen when it renders, so measuring in the same turn as a change to its
     * dimensions reads the size it had a moment ago.
     *
     * An arrow const rather than a function declaration, and not by taste: a
     * declaration is hoisted above the null check on `surface` and `pane`, so
     * TypeScript discards the narrowing inside it and the body would need a
     * non-null assertion on every line.
     */
    const relayout = () => {
      frame = 0
      // Nothing is known about the screen until the daemon has answered, and
      // the emulator's placeholder 80x24 is not it. Scaling that would flash a
      // wrong-sized terminal for one round trip.
      if (ref === null) return
      const content = emulator.contentSize()
      if (!content) return
      const cell = cellBox(content, dims)
      if (!cell) return
      const want = cellsThatFit(paneBox(), cell)

      // Every view reports its own fit — the daemon hands the pty to whichever
      // view was active last — but only after RESIZE_SETTLE_MS without further
      // movement, one report per settled layout rather than one per animation
      // frame.
      if (reported === null || want.cols !== reported.cols || want.rows !== reported.rows) {
        if (settleTimer) clearTimeout(settleTimer)
        settleTimer = window.setTimeout(sendFittedSize, RESIZE_SETTLE_MS)
      }

      if (want.cols >= dims.cols) {
        // Every column fits, so the surface lays out one-to-one whatever the
        // row count says. Rows overflowing alone is almost always this view's
        // own keyboard sliding over the pane: for the settle window the bottom
        // rows clip behind it and then the pty takes the new height. Scaling
        // here instead used to pinch both axes for that window — a lurch on
        // every keyboard open. The cost is deliberate: a view whose columns
        // fit while its rows do not shows the top of the screen until the pty
        // follows, and in the rare enduring cross-device shape of that kind,
        // scrollback still reaches what the pane cannot.
        surface.style.removeProperty('width')
        surface.style.removeProperty('height')
        surface.style.removeProperty('scale')
        return
      }

      // Columns overflow: a wider view is setting the size, and columns
      // clipping would amputate lines mid-word. Lay the surface out at the
      // screen's true size and scale the whole thing down, rather than
      // reflowing text.
      //
      // The gutter goes back on. The scrollbar is drawn at the right-hand edge
      // of the surface, and a surface exactly as wide as the screen puts it on
      // top of the last column — which is the very thing the unscaled view
      // reserves it to avoid, so both paths have to account for it.
      const boxed = { width: content.width + GUTTER_PX, height: content.height }
      // These override flue-term-surface's 100% even though that utility is
      // written with the logical properties: logical and physical declarations
      // for the same axis cascade against each other, and a style attribute
      // outranks every author rule whatever layer it sits in.
      surface.style.width = `${boxed.width}px`
      surface.style.height = `${boxed.height}px`
      surface.style.scale = String(fitFactor(boxed, paneBox()))
    }

    const schedule = () => {
      // Coalesced: an observer callback, an attach and a size broadcast can
      // all land in one turn, and three frames would do the same work thrice.
      if (frame) return
      frame = requestAnimationFrame(relayout)
    }

    // The debounce's trailing edge. Everything is re-measured at fire time —
    // the layout has usually moved since the frame that armed the timer, and
    // the point is to fit the pane where it stopped, not where it passed
    // through. The guards re-run too: a detach, a promotion loss, or an
    // unmount can all land inside the settle window.
    const sendFittedSize = () => {
      settleTimer = 0
      if (ref === null) return
      const content = emulator.contentSize()
      if (!content) return
      const cell = cellBox(content, dims)
      if (!cell) return
      const want = cellsThatFit(paneBox(), cell)
      if (reported !== null && want.cols === reported.cols && want.rows === reported.rows) return
      reported = want
      client.resize(ref, want.cols, want.rows, primary)
    }

    emulator.onData((bytes) => {
      // No ref, no destination — and no input while the backlog replays.
      if (ref === null || consumed < muteUntil) return
      let out = bytes
      if (ctrlArmedRef.current) {
        // The bar's latched Ctrl folds this keystroke, and is spent on it
        // whether or not it could fold — like a real latched modifier.
        out = ctrlTransform(bytes) ?? bytes
        // The ref by hand, beside the state and not through it: the render
        // that would re-sync it is a flush away, and two keystrokes delivered
        // inside one task would both read the arming and both fold.
        ctrlArmedRef.current = false
        setCtrlArmed(false)
      }
      client.sendInput(ref, out)
    })

    // Touch scrolling, by hand: xterm's viewport scrolls on wheel events and
    // nothing else, so without this a phone cannot reach the scrollback at
    // all. Drags become whole-line scrollLines() calls, with the fractional
    // remainder carried between moves so slow drags still add up. The
    // surface's own CSS sets touch-action: pinch-zoom (styles.css), which is
    // what keeps the browser from spending the gesture on panning the page
    // while still leaving two fingers to the zoom. A finger that lifts while
    // still moving hands its speed to a glide (lib/glide.ts), which is what
    // every other scrolling surface on a phone does.
    let touchY: number | null = null
    let touchCarry = 0
    // The flick record: the last few moves' clocks and positions, enough to
    // read a release velocity from. Cleared whenever a gesture starts.
    let flick: Array<{ t: number; y: number }> = []
    let glide: (() => void) | null = null
    const lineHeightPx = () => {
      const content = emulator.contentSize()
      return content && dims.rows > 0 ? content.height / dims.rows : 17
    }
    const touchStart = (e: TouchEvent) => {
      // A finger on the glass pins the content — any glide in flight ends.
      glide?.()
      glide = null
      flick = []
      // A magnified page belongs to the browser, and releasing touch-action
      // is not enough to give it back: touch-action only says the browser
      // *may* pan, while the preventDefault() below cancels that pan whatever
      // it says. So while zoomed this takes no gesture at all.
      if (e.touches.length !== 1 || zoomedIn(window.visualViewport)) {
        touchY = null
        return
      }
      touchY = e.touches[0]!.clientY
      touchCarry = 0
      // The anchor counts as a sample. A flick is often three moves long at a
      // 60Hz touch rate, and reading its speed from the moves alone would
      // throw away a third of the evidence and most of the window. The lift
      // trims it back off again if the finger rested here before setting off.
      flick.push({ t: e.timeStamp, y: touchY })
    }
    const touchMove = (e: TouchEvent) => {
      if (touchY === null || e.touches.length !== 1) return
      // The zoom can arrive after the finger is already down, so the same
      // question is asked again here. Dropping the anchor rather than merely
      // returning keeps a later unzoom from scrolling by the whole distance
      // the finger travelled while panning.
      if (zoomedIn(window.visualViewport)) {
        touchY = null
        return
      }
      e.preventDefault()
      const y = e.touches[0]!.clientY
      // Dragging the content down (finger moves down) shows older lines:
      // negative scrollLines. The carry keeps sub-line motion.
      const delta = (touchY - y) / lineHeightPx() + touchCarry
      const lines = Math.trunc(delta)
      touchCarry = delta - lines
      touchY = y
      flick.push({ t: e.timeStamp, y })
      if (flick.length > 6) flick.shift()
      if (lines !== 0) emulator.scrollLines(lines)
    }
    const touchEnd = (e: TouchEvent) => {
      const wasDragging = touchY !== null
      touchY = null
      touchCarry = 0
      // Velocity is the recent motion, not the whole gesture: a hesitation
      // after touchdown, or a drag that turned around mid-way, is no part of
      // the speed at the lift and averaging across it would divide the answer
      // by the length of the pause. Two samples are always kept, so a flick
      // short enough to be three samples still reads.
      while (flick.length > 2 && flick[flick.length - 1]!.t - flick[0]!.t > 100) flick.shift()
      // Two samples and thirty milliseconds are the floor, so a tap reads as
      // no flick at all. The lift's own clock is the other half: moves stop
      // arriving the instant the finger stops, so a thumb that parks the
      // content and lets go a moment later leaves fast samples behind it, and
      // only their age gives it away.
      const a = flick[0]
      const b = flick[flick.length - 1]
      flick = []
      if (!wasDragging || !a || !b || b.t - a.t < 30) return
      if (e.timeStamp - b.t > 100) return
      const dt = (b.t - a.t) / 1000
      const lps = (a.y - b.y) / lineHeightPx() / dt
      glide = startGlide({ velocity: lps, onLines: (n) => emulator.scrollLines(n) })
    }
    /**
     * The gesture taken away rather than finished: a notification shade pulled
     * down over it, an alert, a call. No finger ever lifted, so there is no
     * release to read a speed from — the drag simply stops where it was.
     *
     * Its own handler rather than touchEnd's, because the samples a
     * system-stolen drag leaves behind are indistinguishable from a flick's:
     * fast, recent, and promptly followed by an event. Sharing the lift path
     * would send the scrollback coasting with nothing on the glass.
     */
    const touchCancel = () => {
      touchY = null
      touchCarry = 0
      flick = []
    }
    surface.addEventListener('touchstart', touchStart, { passive: true })
    surface.addEventListener('touchmove', touchMove, { passive: false })
    surface.addEventListener('touchend', touchEnd, { passive: true })
    surface.addEventListener('touchcancel', touchCancel, { passive: true })

    // The pane hugs the visual viewport: a phone keyboard shrinks it and the
    // ResizeObserver below refits the terminal above the keyboard. While
    // pinch-zoomed it instead releases the surface so one finger pans.
    const untrackViewport = trackVisualViewport({
      pane,
      surface,
      viewport: window.visualViewport,
    })

    // Every registration returns an unsubscribe, and all of them are released
    // on cleanup: the client outlives this view by design.
    const offs: Array<() => void> = []

    offs.push(
      client.onStatus((s) => {
        // A ref belongs to the connection that issued it and to nothing else,
        // so anything other than `open` retires the one this view holds. The
        // daemon numbers refs from 1 again on every connection, so a kept ref
        // can come to name a stranger's attachment.
        //
        // The gone signal below needs none of this as a precondition: the
        // client correlates `not_found` to a session by reqId and reports
        // only this route's own attach, replayed after a daemon restart or
        // not, so there is no separate entitlement to gate on whether a ref
        // is currently held.
        if (s !== 'open') {
          ref = null
          primary = false
          // A new connection is a new attachment with no recorded desire;
          // whatever this view reported belongs to the old one.
          reported = null
          // No role, no voice: a client that answered device queries while
          // unattached would race the reattach's own answer arbitration.
          emulator.answerQueries(false)
        }
        // `open` is deliberately not `live`. The socket being up says nothing
        // about this session: the attach is still a round-trip away, and the
        // screen on display is whatever was there before the outage.
        if (over) return
        if (s === 'reconnecting') setPhase('reconnecting')
        else if (s === 'connecting') setPhase('connecting')
      }),
    )

    offs.push(
      client.onAttached((a) => {
        if (restartReq !== null && a.reqId === restartReq) {
          // The Restart's own spawn. Hand the new ref straight back — the
          // route this navigates to attaches for itself — and go. The dead
          // session needs nothing: the exit already retired its ref on both
          // ends, and the daemon reaps it after ExitedRetention.
          restartReq = null
          client.detach(a.ref)
          restartedRef.current?.(a.id)
          return
        }
        // One client serves the whole tab, so every listener sees every reply.
        if (a.id !== sessionId) return
        ref = a.ref
        primary = a.primary
        // A fresh attachment has no recorded desire on the daemon; the next
        // relayout re-reports this pane's fit under the new ref.
        reported = null
        // The primary is the one client that answers device queries; a
        // mirror answering too is how a program that asked once hears back
        // once per tab, the extras landing at the prompt as garbage.
        emulator.answerQueries(a.primary)
        dims = { cols: a.cols, rows: a.rows }
        epoch++
        consumed = a.seq
        muteUntil = a.head
        if (a.truncated) emulator.write(RESET)
        emulator.resize(a.cols, a.rows)
        if (a.title) document.title = a.title
        // An exited session still reattaches and still replays its scrollback;
        // it is just not going to produce any more of it.
        if (!over) setPhase('live')
        schedule()
      }),
    )

    offs.push(
      client.onOutput((r, bytes) => {
        if (r !== ref) return
        const e = epoch
        emulator.write(bytes, () => {
          if (e === epoch) consumed += bytes.length
        })
      }),
    )

    offs.push(
      client.onSizeChanged((m) => {
        if (m.ref !== ref) return
        // This is also how promotion arrives: the daemon hands ownership to the
        // most recently active client when a primary leaves and says so here.
        // Nothing else will ever ask this client for its dimensions. The
        // answering role travels with the promotion.
        primary = m.primary
        emulator.answerQueries(m.primary)
        dims = { cols: m.cols, rows: m.rows }
        emulator.resize(m.cols, m.rows)
        schedule()
      }),
    )

    offs.push(
      client.onExit((r, code) => {
        if (r !== ref) return
        over = true
        emulator.write(EXIT_NOTICE(code))
        setExitCode(code)
        setPhase('exited')
      }),
    )

    offs.push(
      client.onSessions((list) => {
        const own = list.find((s) => s.id === sessionId)
        if (own) setCwd(own.cwd)
      }),
    )

    offs.push(
      client.onSessionGone((id) => {
        // The client resolved the not_found to its session by reqId and has
        // already dropped it from the reattach plan — for the mount-time
        // attach and for a replay after a daemon restart alike. Terminal
        // states are final: a later reconnect must not walk this back.
        if (id !== sessionId || over) return
        over = true
        setPhase('gone')
      }),
    )

    const keys = createKeyboardModes(pane, setMode)

    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Enter' || !e.ctrlKey || !e.shiftKey || e.altKey || e.metaKey) return
      // Capture, and stopped here. Left to bubble, xterm's own handler on the
      // helper textarea would already have turned it into a carriage return
      // and sent it to the shell before this ran.
      e.preventDefault()
      e.stopPropagation()
      void (keys.mode() === 'focus' ? keys.exitFocus() : keys.enterFocus())
    }
    window.addEventListener('keydown', onKey, true)

    // The pane, not the window. A viewport-level event misses everything that
    // changes the pane without changing the viewport — and, measured rather
    // than assumed, naming that event as a quoted string here is a Tailwind
    // scanner candidate that compiles a stray rule of the same name into the
    // shipped stylesheet. See the note at the top of src/styles.css.
    const observer = new ResizeObserver(schedule)
    observer.observe(inner)

    const media = globalThis.matchMedia?.(DARK_SCHEME_QUERY)
    const onScheme = () => {
      // Through resolveTheme, so a chosen preset holds its ground when the
      // OS scheme flips — only System follows it.
      const next = resolveTheme(themeIdRef.current, media?.matches ?? true)
      emulator.setTheme(next)
      // The pane shows through wherever a scaled surface does not reach, so it
      // has to follow the terminal's background and not the app's — and the
      // document canvas with it.
      paintGround(next.background)
      setDark(media?.matches ?? true)
    }
    media?.addEventListener?.('change', onScheme)

    actionsRef.current = {
      // Click-driven only, for the same StrictMode reason session creation
      // lives on the sessions screen: a spawn fired from a mount effect runs
      // twice and can only ever detach one of its shells.
      restart: (dir) => {
        if (restartReq !== null) return
        const reqId = client.spawn({ cwd: dir ?? undefined, cols: dims.cols, rows: dims.rows })
        if (reqId !== null) restartReq = reqId
      },
      applyTheme: (id) => {
        const next = resolveTheme(id, prefersDark())
        emulator.setTheme(next)
        paintGround(next.background)
      },
      sendKey: (key) => {
        if (ref === null || consumed < muteUntil) return
        const bytes = barKeyBytes(key, {
          appCursor: emulator.applicationCursorKeys(),
          ctrl: ctrlArmedRef.current,
        })
        if (ctrlArmedRef.current) {
          // Spent here too, ref first: see the onData path above.
          ctrlArmedRef.current = false
          setCtrlArmed(false)
        }
        client.sendInput(ref, bytes)
      },
    }

    // Another tab choosing a theme lands here: the preference is global, and
    // a change should sweep every open terminal, not just the one clicked.
    // The storage event only ever fires in *other* tabs; the clicking tab
    // goes through handleTheme. A null key is storage.clear() — back to
    // system either way.
    const onStorage = (e: StorageEvent) => {
      if (e.key !== null && e.key !== THEME_PREF_KEY) return
      const id = e.newValue ?? THEME_SYSTEM
      setThemeId(id)
      actionsRef.current?.applyTheme(id)
    }
    window.addEventListener('storage', onStorage)

    client.attach(sessionId, 0)
    // For the cwd: `attached` does not carry it, the session list does.
    client.list()

    return () => {
      actionsRef.current = null
      for (const off of offs) off()
      surface.removeEventListener('touchstart', touchStart)
      surface.removeEventListener('touchmove', touchMove)
      surface.removeEventListener('touchend', touchEnd)
      surface.removeEventListener('touchcancel', touchCancel)
      glide?.()
      untrackViewport()
      window.removeEventListener('storage', onStorage)
      window.removeEventListener('keydown', onKey, true)
      observer.disconnect()
      media?.removeEventListener?.('change', onScheme)
      keys.dispose()
      if (frame) cancelAnimationFrame(frame)
      if (settleTimer) clearTimeout(settleTimer)
      // A ref if the reply landed, the session's name if it did not. Both are
      // needed: `detach` is the only thing that retires a ref, and an unmount
      // inside the attach round-trip has no ref to give — which is exactly
      // what React's double-invoked mount effect does on every mount.
      if (ref !== null) client.detach(ref)
      else client.forget(sessionId)
      document.title = priorTitle
      if (canvas.style.backgroundColor === paintedCanvas) {
        canvas.style.backgroundColor = priorCanvas
      }
      emulator.dispose()
    }
  }, [client, sessionId, createEmulator])

  const handleRestart = () => actionsRef.current?.restart(cwd)
  const handleClose = () => onClosed?.()
  const handleTheme = (id: string) => {
    setThemeId(id)
    saveThemePref(id)
    actionsRef.current?.applyTheme(id)
  }

  // What the floating controls wear: the resolved theme's own surfaces,
  // handed down as CSS variables so every chip — and the exit overlay —
  // matches the terminal it floats over.
  const controls = controlColors(resolveTheme(themeId, dark))
  const chipStyle = {
    '--chip-bg': controls.bg,
    '--chip-fg': controls.fg,
    '--chip-dim': controls.dim,
    '--chip-ring': controls.ring,
    '--chip-wash': controls.wash,
  } as CSSProperties

  return (
    <div
      ref={paneRef}
      data-flue-mode={mode}
      style={chipStyle}
      // The background follows the terminal palette, which the effect sets in
      // JS the moment it runs. These two are what the very first paint uses,
      // and they have to agree with that palette or the pane flashes. The
      // style carries only the --chip-* variables, so React never touches
      // the backgroundColor the effect owns.
      className="relative h-full w-full overflow-hidden bg-white dark:bg-zinc-950"
    >
      {/*
        The inset is the terminal's margin, like any terminal app's: the pane
        behind it carries the terminal palette's background, so the padding
        reads as the terminal's own breathing room, not a frame. Cells are
        fit to this box (see paneBox), never to the pane.
      */}
      <div
        ref={innerRef}
        data-flue-inset=""
        className={cn(
          'absolute inset-3 transition-opacity',
          coarse && 'bottom-16',
          phase === 'exited' && 'opacity-60',
        )}
      >
        <div
          ref={surfaceRef}
          data-flue-surface=""
          className="flue-term-surface absolute top-0 left-0 origin-top-left"
        />
      </div>
      {coarse && (
        <KeyBar
          ctrl={ctrlArmed}
          onCtrl={() => setCtrlArmed((v) => !v)}
          onKey={(k) => actionsRef.current?.sendKey(k)}
        />
      )}
      {/* z-10: xterm's own layers carry z-indexes, and an unindexed sibling
          loses to them — the controls must win the stack or the scrollbar
          eats their clicks. */}
      <div className="absolute top-3 right-3 z-10 flex items-start gap-x-2">
        <ThemeMenu value={themeId} dark={dark} onChange={handleTheme} />
        {/*
          A real link, so a middle or cmd click behaves browser-natively. It
          opens in a new tab by default so this session stays put; the root
          route spawns into ?cwd= on mount and navigates itself.
        */}
        {/*
          The way back to the rest of flue — sessions, devices, remote — in
          the same chip the strip's other controls wear. A new tab, like the
          + beside it: this tab is a session and stays one.
        */}
        <a
          href="/"
          target="_blank"
          rel="noopener"
          title="Open the dashboard"
          className={cn(
            'rounded-lg px-2.5 py-1.5',
            'bg-(--chip-bg) text-(--chip-dim) shadow-lg ring-1 ring-(--chip-ring) backdrop-blur-sm',
            'transition-colors hover:text-(--chip-fg)',
          )}
        >
          <LayoutGridIcon aria-hidden="true" className="size-4" />
          <span className="sr-only">Open the flue dashboard</span>
        </a>
        <a
          href={cwd ? `/?cwd=${encodeURIComponent(cwd)}` : '/'}
          target="_blank"
          rel="noopener"
          title="New session here"
          // The same box as the theme trigger — an icon in px-2.5 py-1.5 —
          // so the cluster reads as one control strip, not two heights.
          className={cn(
            'rounded-lg px-2.5 py-1.5',
            'bg-(--chip-bg) text-(--chip-dim) shadow-lg ring-1 ring-(--chip-ring) backdrop-blur-sm',
            'transition-colors hover:text-(--chip-fg)',
          )}
        >
          <PlusIcon aria-hidden="true" className="size-4" />
          <span className="sr-only">New session in this directory</span>
        </a>
        {phase !== 'live' && (
          // Dark in both themes, like the pane it floats over usually is; the
          // translucent ground and backdrop-blur keep it legible over whatever
          // the screen underneath was showing. The dot is the phase at a
          // glance: pulsing while an answer is still expected, still once the
          // state is final and waiting will not change it. Like the dot on a
          // session row it stays neutral — waiting reads as motion, not
          // colour, and teal's short list of jobs does not include this pill.
          <div
            role="status"
            className={cn(
              // /4 line-height: 16px text box + py-1.5 = the same 28px as the
              // icon buttons beside it (size-4 in py-1.5), one strip height.
              'rounded-lg px-3 py-1.5 text-base/4 font-medium sm:text-sm/4',
              'bg-(--chip-bg) text-(--chip-fg) shadow-lg ring-1 ring-(--chip-ring) backdrop-blur-sm',
            )}
          >
            <span className="flex items-center gap-x-2">
              <span
                aria-hidden="true"
                className={cn(
                  'size-1.5 shrink-0 rounded-full',
                  phase === 'connecting' || phase === 'reconnecting'
                    ? 'bg-(--chip-fg) motion-safe:animate-pulse'
                    : 'bg-(--chip-dim)',
                )}
              />
              {NOTICE[phase]}
            </span>
            {phase === 'connecting' && (
              <span className="mt-0.5 block pl-3.5 text-xs/5 font-normal text-(--chip-dim)">
                <kbd className="font-mono">{TERMINAL_SHORTCUT_HINT}</kbd> for focus mode
              </span>
            )}
          </div>
        )}
      </div>
      {phase === 'exited' && exitCode !== null && (
        <ExitOverlay code={exitCode} onRestart={handleRestart} onClose={handleClose} />
      )}
    </div>
  )
}

const NOTICE: Record<Exclude<Phase, 'live'>, string> = {
  connecting: 'Connecting…',
  reconnecting: 'Reconnecting…',
  exited: 'Process exited',
  gone: 'This session is gone',
}
