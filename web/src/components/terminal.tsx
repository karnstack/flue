import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { ArrowLeftRightIcon, LayoutGridIcon, PlusIcon } from 'lucide-react'

import { useFlueClient } from '@/client/provider'
import { ExitOverlay } from '@/components/exit-overlay'
import { KeyBar } from '@/components/key-bar'
import { SelectionMenu, type MenuEnd } from '@/components/selection-menu'
import { ThemeMenu } from '@/components/theme-menu'
import { DARK_SCHEME_QUERY, prefersDark } from '@/emulator/palette'
import { controlColors, resolveTheme, THEME_SYSTEM } from '@/emulator/themes'
import type { Emulator } from '@/emulator/types'
import { createXtermEmulator, type XtermOptions } from '@/emulator/xterm'
import { loadThemePref, saveThemePref, THEME_PREF_KEY } from '@/lib/theme-pref'
import {
  cellAt,
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
import { isApplePlatform, openChordLabel } from '@/switcher/keys'
import { useSwitcher } from '@/switcher/provider'

/** What the view is showing, which is not the same as what the socket is doing. */
type Phase = 'connecting' | 'live' | 'reconnecting' | 'exited' | 'gone' | 'revoked'

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
  /**
   * Called by the `+` in the control strip, with this session's directory when
   * the list has said what it is.
   *
   * The dialog it opens lives above this component, not in it, and that is the
   * same bargain the rest of the file keeps: the form needs the fleet's
   * machines and the fleet's tags, and a terminal that knew the fleet existed
   * would be a terminal that could not be mounted without one.
   */
  onNewSession?: (cwd: string | null) => void
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
 * How long a finger must hold still before the press counts as a selection.
 *
 * Exported for the test, which cannot wait it out in real time and must not
 * hard-code a number this file is free to change.
 */
export const LONG_PRESS_MS = 450

/**
 * How far a finger may wander in that time and still be holding still.
 *
 * Nobody keeps a thumb inside a pixel, and a zero here would mean the
 * gesture only ever worked for people whose hands did not shake.
 */
const PRESS_SLOP = 10

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
  onNewSession,
}: TerminalProps) {
  const client = useFlueClient()
  const switcher = useSwitcher()
  // Which modifier this keyboard actually has, for the chip's tooltip. Once per
  // mount: nobody swaps a Mac for a ThinkPad mid-session.
  const chordLabel = useMemo(() => openChordLabel(isApplePlatform()), [])
  const paneRef = useRef<HTMLDivElement>(null)
  const innerRef = useRef<HTMLDivElement>(null)
  const surfaceRef = useRef<HTMLDivElement>(null)
  // Seeded from the client rather than assumed, because onStatus reports only
  // changes: a view mounted into a connection that is already up would
  // otherwise sit at "Connecting" until something else went wrong. The
  // revoked check first, for the same reason it exists on the client: the
  // event fired before this view mounted, the fleet closed the client on it,
  // and a pill promising "Connecting…" over a client nothing will ever dial
  // again would wait forever.
  const [phase, setPhase] = useState<Phase>(() => {
    if (client.revoked !== null) return 'revoked'
    return client.status === 'reconnecting' ? 'reconnecting' : 'connecting'
  })
  // The daemon's reason, for the pill's second line. Seeded alongside the
  // phase and replaced by the event so both mount orders read the same.
  const [revokedWhy, setRevokedWhy] = useState<string | null>(() => client.revoked)
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
  // Which end the selection menu is showing at, or null for not showing.
  // One state and not two: there is no menu without a selection.
  const [menuEnd, setMenuEnd] = useState<MenuEnd | null>(null)
  const [clipProblem, setClipProblem] = useState<string | null>(null)
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
    copy: () => void
    paste: () => void
    dismiss: () => void
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

    // The two grounds behind the pane, painted along with it wherever the
    // theme lands. The pane stops at the visual viewport while a phone
    // keyboard is up, and rubber-band overscroll runs past the page: both
    // bands show what is under the pane, which otherwise wears the app
    // scheme's colour — a dark OS under a light terminal theme put a black
    // flash behind every keyboard open.
    //
    // Both, because the canvas alone leaves the keyboard band wrong in the
    // other direction. The body's box is the full height of the *layout*
    // viewport, and a phone keyboard shortens only the visual one, so the
    // body paints its own stylesheet colour over the canvas across exactly
    // the strip the keyboard uncovers — zinc-950, a black bar under a dark
    // terminal theme, which is what iOS 26 shows around its keyboard slab
    // and behind the form accessory bar. Only overscroll past the body's box
    // ever reaches the canvas itself.
    //
    // Restored on unmount so the rest of the app keeps its stylesheet colour.
    const canvas = document.documentElement
    const body = document.body
    const priorCanvas = canvas.style.backgroundColor
    const priorBody = body.style.backgroundColor
    // What this effect last painted, read back so the value carries the
    // style engine's own serialisation. The cleanup compares before it
    // restores, for the reason the viewport tracker's disposer does: a
    // replacement owner can paint before this one tears down, and a stale
    // cleanup must surrender only what it still owns.
    let paintedCanvas = ''
    let paintedBody = ''
    const paintGround = (bg: string | undefined) => {
      pane.style.backgroundColor = bg ?? ''
      canvas.style.backgroundColor = bg ?? ''
      body.style.backgroundColor = bg ?? ''
      paintedCanvas = canvas.style.backgroundColor
      paintedBody = body.style.backgroundColor
    }

    const palette = resolveTheme(themeIdRef.current, prefersDark())
    const emulator = createEmulator({ cols: 80, rows: 24, theme: palette })
    // Read by the clipboard callbacks, which settle a promise later and
    // must not write state into a view that has gone away.
    let alive = true
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
    // Whether a replayed backlog is still arriving under this attachment.
    //
    // The gate above keeps the emulator's *answers* off the wire while the
    // scrollback replays. This is the other half of the same problem: a
    // replay also re-runs every mode change in that scrollback, and the
    // modes outlive it. A shell killed with the daemon inside a
    // mouse-tracking program wrote the sequence that turned tracking on and
    // never the one that turns it off, so replaying its snapshot leaves this
    // emulator reporting the pointer at a fresh prompt — see stopReporting.
    // Turned off the moment the backlog has been consumed, which is where
    // the reset goes; false already on a fresh spawn, whose head === seq
    // means there is nothing replayed to answer for.
    let replaying = false
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
    /*
     * What the browser tab is called while this session is on it: the name a
     * human typed leads, then whatever the program inside announced through
     * OSC 0/2, then the session's working directory when the program has
     * said nothing — the same pecking order displayName reads names by,
     * minus the command floor, which would caption every tab "zsh".
     *
     * Two sources feed it, both already flowing: `attached` carries the OSC
     * title's first word, and the sessions poll carries every later one,
     * name and directory included. When all three strings are empty the tab
     * keeps whatever it was called before, rather than being blanked.
     */
    let tabName = ''
    let tabOsc = ''
    let tabCwd = ''
    const retitle = () => {
      const at = tabOsc || tabCwd
      const text = tabName && at ? `${tabName} — ${at}` : tabName || at
      if (text) document.title = text
    }

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
    /*
     * Long press to select, drag to widen it.
     *
     * Copying off a terminal is the one thing a phone could not do here at
     * all, and it is not for want of a control: the screen is painted to a
     * canvas, so there is no text on the page for the operating system to
     * offer its own Copy over, and `user-select` is off across xterm besides.
     * Nothing but flue can know that those pixels are characters.
     *
     * The gesture has to be told apart from the scroll that shares the
     * surface with it, and the two are the same event until they are not. A
     * press that holds still for `LONG_PRESS_MS` is a selection; a finger
     * that travels more than `PRESS_SLOP` before then is a scroll, and the
     * slop is what keeps a thumb resting on glass from being read as a drag.
     * Once a selection has begun the scroll path is abandoned for the rest of
     * the gesture — a drag that both grew a range and scrolled the scrollback
     * under it would be unusable.
     */
    let pressTimer: ReturnType<typeof setTimeout> | null = null
    let pressFrom: { x: number; y: number } | null = null
    let selectDrag = false
    /*
     * The compatibility mousedown behind a press that selected.
     *
     * A touch the page did not cancel is replayed as a mouse, and xterm's own
     * mousedown handler begins a fresh selection of its own — clearing the
     * one the press just made, a frame after making it. A long press that
     * never moved has no touchmove to cancel, so the only place left to stop
     * it is the mouse event itself. Capture phase on the inset, which is an
     * ancestor of the element xterm listens on, so this runs first.
     */
    let swallowMouse = false
    const cellUnder = (x: number, y: number) => {
      const box = emulator.screenBox()
      return box ? cellAt({ x, y }, box, dims) : null
    }
    const endPress = () => {
      if (pressTimer !== null) clearTimeout(pressTimer)
      pressTimer = null
      pressFrom = null
    }
    const dismissSelection = () => {
      emulator.clearSelection()
      setMenuEnd(null)
      setClipProblem(null)
    }
    const beginSelection = () => {
      pressTimer = null
      const from = pressFrom
      if (from === null) return
      const cell = cellUnder(from.x, from.y)
      if (cell === null) return
      emulator.selectWordAt(cell)
      // Blank space holds no word, and a press on it selects nothing. Leaving
      // the menu away is the honest answer: a Copy over an empty selection is
      // a button that does nothing.
      if (emulator.selection() === '') return
      selectDrag = true
      swallowMouse = true
      // Whatever this gesture was going to be, it is a selection now.
      touchY = null
      touchCarry = 0
      flick = []
      glide?.()
      glide = null
      const box = inner.getBoundingClientRect()
      // Away from the half the finger is in, so the menu never covers the
      // words it is offering to copy.
      setMenuEnd(from.y > box.y + box.height / 2 ? 'top' : 'bottom')
    }
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
      // A finger anywhere on the terminal puts a showing selection away.
      // The menu is outside this element, so tapping Copy does not come
      // through here and does not dismiss the thing it is copying.
      selectDrag = false
      endPress()
      dismissSelection()
      if (e.touches.length !== 1 || zoomedIn(window.visualViewport)) {
        touchY = null
        touchCarry = 0
        flick = []
        return
      }
      const press = e.touches[0]!
      pressFrom = { x: press.clientX, y: press.clientY }
      pressTimer = setTimeout(beginSelection, LONG_PRESS_MS)
      touchY = e.touches[0]!.clientY
      touchCarry = 0
      // The anchor counts as a sample. A flick is often three moves long at a
      // 60Hz touch rate, and reading its speed from the moves alone would
      // throw away a third of the evidence and most of the window. The lift
      // trims it back off again if the finger rested here before setting off.
      flick.push({ t: e.timeStamp, y: touchY })
    }
    const touchMove = (e: TouchEvent) => {
      if (e.touches.length !== 1) {
        touchY = null
        touchCarry = 0
        flick = []
        // A second finger ends the drag but keeps what it selected: the range
        // is on screen and the menu is up, and throwing both away because
        // somebody steadied the phone would be its own bug.
        selectDrag = false
        endPress()
        return
      }
      const moved = e.touches[0]!
      if (selectDrag) {
        e.preventDefault()
        const cell = cellUnder(moved.clientX, moved.clientY)
        if (cell !== null) emulator.extendSelectionTo(cell)
        return
      }
      if (pressFrom !== null) {
        const travel = Math.hypot(moved.clientX - pressFrom.x, moved.clientY - pressFrom.y)
        if (travel > PRESS_SLOP) endPress()
      }
      if (touchY === null) return
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
      endPress()
      if (selectDrag) {
        // The lift leaves the range and the menu standing; there is nothing
        // here to coast.
        selectDrag = false
        touchY = null
        touchCarry = 0
        flick = []
        return
      }
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
      selectDrag = false
      endPress()
    }
    const swallowSyntheticMouse = (e: MouseEvent) => {
      if (!swallowMouse) return
      swallowMouse = false
      e.preventDefault()
      e.stopPropagation()
    }
    inner.addEventListener('touchstart', touchStart, { passive: true })
    inner.addEventListener('touchmove', touchMove, { passive: false })
    inner.addEventListener('touchend', touchEnd, { passive: true })
    inner.addEventListener('touchcancel', touchCancel, { passive: true })
    inner.addEventListener('mousedown', swallowSyntheticMouse, true)

    // The pane hugs the visual viewport: a phone keyboard shrinks it and the
    // ResizeObserver below refits the terminal above the keyboard. While
    // pinch-zoomed it instead releases the surface so one finger pans.
    const untrackViewport = trackVisualViewport({
      pane,
      surface,
      gestureArea: inner,
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
        replaying = a.head > a.seq
        if (a.truncated) emulator.write(RESET)
        emulator.resize(a.cols, a.rows)
        tabOsc = a.title
        retitle()
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
          if (e !== epoch) return
          consumed += bytes.length
          // In the done callback and not at frame arrival, for the same
          // reason the gate is: this has to land after the parser has read
          // the backlog, or the modes it clears are set again behind it.
          if (replaying && consumed >= muteUntil) {
            replaying = false
            emulator.stopReporting()
          }
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
        if (!own) return
        setCwd(own.cwd)
        tabName = own.name
        tabOsc = own.title
        tabCwd = own.cwd
        retitle()
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

    offs.push(
      client.onRevoked((reason) => {
        // Final like `gone`, and for a stronger reason: the fleet closes this
        // client on the same event, so no reconnect is coming to walk the
        // pill back — without this the view would freeze on "live" over a
        // socket that is gone for good. The session itself may well go on
        // without us; what ended is this device's standing to watch it.
        if (over) return
        over = true
        setRevokedWhy(reason)
        setPhase('revoked')
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
      copy: () => {
        const text = emulator.selection()
        // Nothing selected is not a failure worth a message; the menu only
        // exists because something was, and this is the race where a
        // relayout ate it in between.
        if (text === '') return dismissSelection()
        const clipboard = navigator.clipboard
        if (!clipboard?.writeText) {
          return setClipProblem('This browser does not allow reading the clipboard here.')
        }
        void clipboard.writeText(text).then(
          () => alive && dismissSelection(),
          () => alive && setClipProblem('This browser would not take the copy.'),
        )
      },
      paste: () => {
        if (ref === null || consumed < muteUntil) {
          return setClipProblem('The terminal is not ready for input yet.')
        }
        const clipboard = navigator.clipboard
        if (!clipboard?.readText) {
          return setClipProblem('This browser does not allow reading the clipboard here.')
        }
        // A latched hardware modifier does not alter a clipboard paste. Clear
        // ours before xterm emits the prepared text through onData, or a
        // one-character paste such as "c" would turn into Ctrl+C.
        ctrlArmedRef.current = false
        setCtrlArmed(false)
        void clipboard.readText().then(
          (text) => {
            if (!alive) return
            if (text === '') return setClipProblem('The clipboard is empty.')
            dismissSelection()
            // Through the emulator, so the newlines are normalised and a
            // program in bracketed-paste mode is told what it asked to be
            // told. Sending these bytes straight down the wire would let a
            // pasted command with a newline in it run itself.
            emulator.paste(text)
            emulator.focus()
          },
          () => alive && setClipProblem('This browser would not hand flue the clipboard.'),
        )
      },
      dismiss: dismissSelection,
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
      alive = false
      actionsRef.current = null
      for (const off of offs) off()
      inner.removeEventListener('touchstart', touchStart)
      inner.removeEventListener('touchmove', touchMove)
      inner.removeEventListener('touchend', touchEnd)
      inner.removeEventListener('touchcancel', touchCancel)
      inner.removeEventListener('mousedown', swallowSyntheticMouse, true)
      endPress()
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
      if (body.style.backgroundColor === paintedBody) {
        body.style.backgroundColor = priorBody
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
          'flue-term-gesture absolute inset-3 transition-opacity',
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
      {menuEnd !== null && (
        <SelectionMenu
          at={menuEnd}
          onCopy={() => actionsRef.current?.copy()}
          onPaste={() => actionsRef.current?.paste()}
          onCancel={() => actionsRef.current?.dismiss()}
        />
      )}
      {clipProblem !== null && (
        <p
          role="alert"
          className="absolute right-3 bottom-20 left-3 z-20 rounded-md bg-(--chip-bg) px-3 py-2 text-center text-sm text-(--chip-fg) shadow-lg ring-1 ring-(--chip-ring)"
        >
          {clipProblem}
        </p>
      )}
      {/* z-10: xterm's own layers carry z-indexes, and an unindexed sibling
          loses to them — the controls must win the stack or the scrollbar
          eats their clicks. */}
      <div className="absolute top-3 right-3 z-10 flex items-start gap-x-2">
        <ThemeMenu value={themeId} dark={dark} onChange={handleTheme} />
        {/*
          The way to another session without leaving this one.

          A button and not only a chord, and that is the whole reason it is
          here: a phone has no Ctrl and no Cmd, so a switcher reachable only by
          keystroke would be a feature laptops have. The tooltip carries the
          chord for the keyboards that do have one, which is how anybody learns
          it — the connecting pill's hint is gone in a hundred milliseconds on
          a local daemon.
        */}
        <button
          type="button"
          onClick={() => switcher.open()}
          title={`Switch session · ${chordLabel}`}
          className={cn(
            'rounded-lg px-2.5 py-1.5',
            'bg-(--chip-bg) text-(--chip-dim) shadow-lg ring-1 ring-(--chip-ring) backdrop-blur-sm',
            'transition-colors hover:text-(--chip-fg)',
          )}
        >
          <ArrowLeftRightIcon aria-hidden="true" className="size-4" />
          <span className="sr-only">Switch session</span>
        </button>
        {/*
          The way back to the rest of flue — sessions, devices, remote — in
          the same chip the strip's other controls wear. A real link, so a
          middle or cmd click behaves browser-natively, and a new tab by
          default: this tab is a session and stays one.
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
        {/*
          A button, and it used to be a link to `/?cwd=` — which is the
          dashboard, so a session started from here came up behind the whole
          list for as long as the daemon took to answer. It asks first now:
          the dialog above this component collects a name and tags while there
          is still a form to collect them on, and the page it opens starts the
          session on its own ground.

          The same box as the theme trigger — an icon in px-2.5 py-1.5 — so the
          cluster reads as one control strip, not two heights.
        */}
        <button
          type="button"
          onClick={() => onNewSession?.(cwd)}
          title="New session here"
          className={cn(
            'rounded-lg px-2.5 py-1.5',
            'bg-(--chip-bg) text-(--chip-dim) shadow-lg ring-1 ring-(--chip-ring) backdrop-blur-sm',
            'transition-colors hover:text-(--chip-fg)',
          )}
        >
          <PlusIcon aria-hidden="true" className="size-4" />
          <span className="sr-only">New session in this directory</span>
        </button>
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
              <>
                <span className="mt-0.5 block pl-3.5 text-xs/5 font-normal text-(--chip-dim)">
                  <kbd className="font-mono">{TERMINAL_SHORTCUT_HINT}</kbd> for focus mode
                </span>
                {/* The chord, said once where somebody waiting has a moment to
                    read it. The chip above is what teaches it the rest of the
                    time, and on a fast daemon this pill is gone before it can. */}
                <span className="block pl-3.5 text-xs/5 font-normal text-(--chip-dim)">
                  <kbd className="font-mono">{chordLabel}</kbd> to switch session
                </span>
              </>
            )}
            {phase === 'revoked' && revokedWhy !== null && revokedWhy !== '' && (
              // The daemon's reason, in the slot the connecting hint uses:
              // the one line of detail a pill has room for, and the last
              // thing this connection was told.
              <span className="mt-0.5 block pl-3.5 text-xs/5 font-normal text-(--chip-dim)">
                {revokedWhy}
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
  revoked: 'This device was revoked',
}
