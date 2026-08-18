import { Terminal, type IDisposable } from '@xterm/xterm'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { pathLinksAt } from './links'
import type { Cell, Emulator, Grid, PixelSize, TerminalTheme } from './types'

export interface XtermOptions {
  cols?: number
  rows?: number
  theme?: TerminalTheme
  /**
   * Whether this is a Mac keyboard, which decides one thing here: Ctrl+C
   * stays the interrupt even over a selection, because Cmd+C owns copy on a
   * Mac and macOS browsers do not copy on Ctrl+C — claiming it would swallow
   * the key: no copy, no interrupt.
   */
  macKeyboard?: boolean
}

/**
 * The class xterm puts on the element whose box is exactly the rendered
 * screen: `cols` cells wide and `rows` cells tall, in CSS pixels.
 *
 * Both the DOM renderer and the WebGL addon set that element's width and
 * height explicitly, which is what makes it the one honest measurement of the
 * screen. The `.xterm` element around it is a block box and takes its parent's
 * width instead, so measuring that would report the pane, not the screen.
 */
const SCREEN_SELECTOR = '.xterm-screen'

/**
 * Kept in step with `--font-mono` in styles.css, which emulator.test.ts
 * asserts. It cannot read the token: xterm measures glyph widths on a canvas,
 * and `var(--font-mono)` does not resolve in a canvas font string.
 */
export const TERMINAL_FONT_FAMILY =
  "ui-monospace, 'SFMono-Regular', 'SF Mono', Menlo, Consolas, monospace"

/**
 * What a "newline, do not send yet" chord puts on the wire: ESC then CR.
 *
 * There is no such thing at the VT level. Enter is a carriage return and
 * Shift does not change that — xterm.js is faithful to the hardware and
 * encodes both the same way, which is why Shift+Enter in a browser terminal
 * submits an agent's prompt rather than adding a line to it.
 *
 * ESC CR is the sequence the CLIs themselves settled on. A line editor reads
 * it as Alt+Enter, `claude /terminal-setup` writes exactly these two bytes
 * into VS Code's keybindings.json for `shift+enter`, and iTerm2, Ghostty,
 * WezTerm, Kitty, Warp and Windows Terminal send it out of the box — which is
 * what "Shift+Enter is natively supported" means in those tools. So this is
 * flue matching a convention, not inventing one.
 */
export const NEWLINE_CHORD_BYTES = '\x1b\r'

/**
 * Every mouse protocol off, every mouse encoding off, focus reporting off.
 *
 * The set is exhaustive on purpose. The protocols (1000 press-only, 1002
 * drag, 1003 any motion) and the encodings (1005 UTF-8, 1006 SGR, 1015
 * urxvt, 1016 SGR-pixels) are separate switches in the terminal, and a
 * program may have set any combination of them; clearing the protocol a
 * particular program happened to use is how this fix would work on one
 * machine and not the next.
 */
const STOP_REPORTING =
  '\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1005l\x1b[?1006l\x1b[?1015l\x1b[?1016l\x1b[?1004l'

/**
 * xterm.js behind the Emulator seam.
 *
 * The palette is passed in rather than chosen here: which colours a terminal
 * wears is a design decision, and this file's job is only to hand them to
 * xterm. See src/emulator/palette.ts for the ones flue ships.
 */
export function createXtermEmulator(opts: XtermOptions = {}): Emulator {
  const term = new Terminal({
    cols: opts.cols ?? 80,
    rows: opts.rows ?? 24,
    theme: opts.theme,
    // Gates `unicode`, `markers`, character joiners and decorations. Nothing
    // here uses any of them yet; it stays on because the WebGL addon is
    // loaded through a catch-and-fall-back, so an API refusal inside it would
    // show up as a silently slower renderer rather than as an error.
    allowProposedApi: true,
    // The daemon forwards the pty's bytes verbatim, so a bare LF from the
    // program is a bare LF here. Rewriting it to CRLF would be flue inventing
    // output the program did not produce.
    convertEol: false,
    scrollback: 10_000,
    fontFamily: TERMINAL_FONT_FAMILY,
    fontSize: 13,
    // OSC 8 hyperlinks — `ls --hyperlink`, modern CLIs. xterm parses them in
    // core but activates nothing without a handler. The scheme check lives in
    // openTerminalLink: an escape sequence chooses the URI, so a shell script
    // printing one must not be able to hand the browser javascript: or file:.
    linkHandler: {
      activate: (_event, uri) => openTerminalLink(uri),
    },
  })
  // Plain-text URLs in output, the other way a link appears in a terminal.
  // The addon's matcher only produces http(s) URIs; the handler still goes
  // through the same guard so there is exactly one place that opens links.
  term.loadAddon(new WebLinksAddon((_event, uri) => openTerminalLink(uri)))

  const encoder = new TextEncoder()
  let disposed = false
  let linkProvider: IDisposable | null = null

  /*
   * The keys xterm has no notion of: Shift+Enter, and copy and paste chords.
   *
   * Here rather than in the terminal view, and that is the whole argument for
   * this seam: the view's own keydown handler has no way to put bytes on the
   * wire without reaching past it. `term.input` sends them through onData, so
   * the key bar's latched Ctrl and the replay mute gate both still apply, and
   * the daemon counts the keystroke as activity exactly as it would any other.
   *
   * keydown alone — keyup and keypress arrive for the same press, and either
   * would send the sequence a second time.
   */
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown') return true

    /*
     * Shift+Enter. Ctrl, Alt and Cmd are all excluded: Ctrl+Shift+Enter is
     * the view's focus-mode chord, and Alt+Enter already produces these
     * bytes through xterm's own encoder.
     */
    if (e.key === 'Enter' && e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
      // xterm keeps the caret in a real textarea, and refusing the event is
      // not the same as cancelling it: left to the browser, this Enter writes
      // a line into that element and xterm's input listener then reads a
      // value nothing typed. xterm's own cancel never runs, because `false`
      // returns above it.
      e.preventDefault()
      term.input(NEWLINE_CHORD_BYTES, true)
      return false
    }

    // `key` is 'C' when Shift is down and 'c' when it is not; Cmd chords are
    // left alone throughout — on a Mac the browser's own copy and paste
    // already work, because xterm's encoder ignores metaKey.
    const key = e.key.toLowerCase()
    if (e.metaKey || e.altKey || !e.ctrlKey) return true

    /*
     * Ctrl+C over a selection: stand aside instead of encoding ETX, and the
     * browser's own copy runs — xterm fills the clipboard from its copy
     * listener on the helper textarea. Not on a Mac (see XtermOptions), and
     * never with nothing selected: an empty selection must still interrupt,
     * because Ctrl+C is how anybody stops a program.
     *
     * The clear is deferred past the copy: xterm reads the selection when
     * the copy event lands, which is during this keydown's default action,
     * so clearing synchronously here would copy nothing. Cleared at all so
     * the next Ctrl+C interrupts — a held selection must not make SIGINT
     * unreachable from the keyboard.
     */
    if (key === 'c' && !e.shiftKey && !opts.macKeyboard && term.hasSelection()) {
      setTimeout(() => {
        if (!disposed) term.clearSelection()
      }, 0)
      return false
    }

    /*
     * Ctrl+Shift+C: copy, claimed on every platform. xterm's encoder
     * produces no key for it, so left alone nothing calls preventDefault and
     * Chrome opens the DevTools inspector over the terminal — which is also
     * why the empty-selection press is swallowed rather than passed on.
     */
    if (key === 'c' && e.shiftKey) {
      e.preventDefault()
      const text = term.getSelection()
      if (text !== '') {
        // The write can fail — no clipboard API on an insecure origin, or
        // permission refused. The selection is only cleared once the text
        // is really on the clipboard, so a failed copy leaves something to
        // try again with.
        void navigator.clipboard?.writeText?.(text).then(
          () => {
            if (!disposed) term.clearSelection()
          },
          () => {},
        )
      }
      return false
    }

    /*
     * Ctrl+Shift+V: stand aside, the chord the fingers that just learned
     * Ctrl+Shift+C reach for next. Chromium and Firefox on Windows and
     * Linux bind it to a plain-text paste themselves and fire a trusted
     * paste event at the helper textarea, which xterm's own paste handler
     * consumes — bracketed paste included. Claiming it and reading the
     * async clipboard here instead would cost a permission prompt on the
     * platforms that press it, and go dead outright on insecure origins,
     * where navigator.clipboard does not exist. On a Mac the chord is bound
     * to nothing, and Cmd+V already pastes.
     */
    if (key === 'v' && e.shiftKey) return false

    return true
  })
  // The word a long press anchored, in buffer rows: where a drag extends
  // from, and what it falls back to when the finger comes back inside it.
  // `to` is the column after the last cell, the way a range end usually is.
  let anchor: { row: number; from: number; to: number } | null = null

  // Device-query suppression for mirrors. The session's byte stream is
  // broadcast to every attached client, each of which is a full emulator
  // that would answer DA, DSR, DECRQM, OSC colour queries and XTGETTCAP by
  // itself — so a program that asked once would hear back once per open
  // tab, and every reply past the first arrives at the shell prompt as
  // garbage ("11;rgb:…", "…R"). Exactly one client may answer: the primary.
  //
  // xterm has no switch for this, but registered parser handlers run ahead
  // of the built-ins and a `true` swallows the sequence. Every handler
  // below answers "handled" exactly when this emulator must stay silent,
  // and defers to the built-in when it is allowed to speak. Off until the
  // daemon says who is primary — a mirror that answered during the attach
  // round-trip would be the bug again.
  let answers = false
  const silent = () => !answers

  // CSI queries: DA1/DA2, DSR 5n/6n and DECXCPR, DECRQM (ANSI and DEC),
  // DECREQTPARM, XTVERSION, and the window-report family of `t`.
  const csi = [
    { final: 'c' },
    { prefix: '>', final: 'c' },
    { final: 'n' },
    { prefix: '?', final: 'n' },
    { intermediates: '$', final: 'p' },
    { prefix: '?', intermediates: '$', final: 'p' },
    { final: 'x' },
    { prefix: '>', final: 'q' },
    { final: 't' },
  ]
  for (const id of csi) term.parser.registerCsiHandler(id, silent)
  // DCS queries: XTGETTCAP and DECRQSS.
  term.parser.registerDcsHandler({ intermediates: '+', final: 'q' }, silent)
  term.parser.registerDcsHandler({ intermediates: '$', final: 'q' }, silent)
  // OSC 10/11/12 ask with a literal "?" and set with a colour. Only the
  // question is swallowed: a mirror must still apply a colour a program
  // sets, or its screen drifts from the primary's.
  for (const ident of [10, 11, 12]) {
    term.parser.registerOscHandler(ident, (data) => (data === '?' ? silent() : false))
  }

  return {
    write(bytes: Uint8Array, done?: () => void) {
      term.write(bytes, done)
    },

    resize(cols: number, rows: number) {
      term.resize(cols, rows)
    },

    scrollLines(n: number) {
      // On the main buffer the scrollback is real and moving the viewport
      // over it is the whole job. The alternate buffer keeps none, so there
      // the viewport has nothing to move and the drag has to become input —
      // which is exactly what xterm already does for a desktop wheel, and
      // what a fullscreen TUI (claude, vim, less) is listening for.
      if (term.buffer.active.type !== 'alternate') {
        term.scrollLines(n)
        return
      }
      const lines = Math.abs(n)
      if (disposed || lines === 0) return
      if (term.modes.mouseTrackingMode !== 'none') {
        // A tracking program hears wheel reports, and the encoding of a
        // report depends on which protocol and encoding it picked. That
        // logic already lives in xterm behind its wheel listener, so rather
        // than fork it, hand xterm the wheel events a desktop would have:
        // one per line, at the middle of the screen, which is near enough
        // to where a finger dragging the content is.
        const screen = term.element?.querySelector(SCREEN_SELECTOR)
        if (!(screen instanceof HTMLElement)) return
        const rect = screen.getBoundingClientRect()
        // Each dispatch runs listeners synchronously, and a listener's data
        // callback is app code that could tear this emulator down mid-loop.
        for (let i = 0; i < lines && !disposed; i++) {
          screen.dispatchEvent(
            new WheelEvent('wheel', {
              bubbles: true,
              cancelable: true,
              clientX: rect.x + rect.width / 2,
              clientY: rect.y + rect.height / 2,
              deltaY: n < 0 ? -1 : 1,
              deltaMode: WheelEvent.DOM_DELTA_LINE,
            }),
          )
        }
        return
      }
      // No tracking: arrow keys, the translation every terminal settled on
      // for a wheel over an alternate screen. Through term.input rather than
      // straight down the wire so the keystrokes flow out through onData
      // like any other. DECCKM decides the encoding, same as a real press.
      const arrow = (term.modes.applicationCursorKeysMode ? '\x1bO' : '\x1b[') + (n < 0 ? 'A' : 'B')
      term.input(arrow.repeat(lines), true)
    },

    snapshot(): Grid {
      return extractGrid(term)
    },

    onData(cb: (bytes: Uint8Array) => void) {
      term.onData((data) => cb(encoder.encode(data)))
    },

    screenBox() {
      if (disposed) return null
      const screen = term.element?.querySelector(SCREEN_SELECTOR)
      if (!(screen instanceof HTMLElement)) return null
      // getBoundingClientRect and not offsetWidth, and for exactly the reason
      // contentSize gives for the opposite choice: a mirroring view is scaled
      // by CSS on an ancestor, and the rect is the only one of the two that
      // has the scale in it.
      const rect = screen.getBoundingClientRect()
      if (rect.width <= 0 || rect.height <= 0) return null
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
    },

    selectWordAt(cell: Cell) {
      if (disposed) return
      const row = bufferRow(term, cell.row)
      const word = wordAt(term, row, cell.col)
      if (!word) return
      anchor = { row, from: word.from, to: word.to }
      apply(term, row, word.from, row, word.to)
    },

    extendSelectionTo(cell: Cell) {
      if (disposed || !anchor) return
      const row = bufferRow(term, cell.row)
      // The cell under the finger belongs to the selection, so the far edge
      // is the column after it. Without this a drag can never reach the last
      // character of a line, which is where the interesting half of a path
      // or a hash lives.
      if (after(row, cell.col + 1, anchor.row, anchor.to)) {
        apply(term, anchor.row, anchor.from, row, cell.col + 1)
      } else if (after(anchor.row, anchor.from, row, cell.col)) {
        apply(term, row, cell.col, anchor.row, anchor.to)
      } else {
        apply(term, anchor.row, anchor.from, anchor.row, anchor.to)
      }
    },

    selection() {
      if (disposed) return ''
      return term.getSelection()
    },

    clearSelection() {
      anchor = null
      if (disposed) return
      term.clearSelection()
    },

    paste(text: string) {
      if (disposed) return
      term.paste(text)
    },

    stopReporting() {
      if (disposed) return
      // Written as output rather than set on xterm's services, because the
      // parser is the only supported way in and because it keeps the ordering
      // honest: this lands in the stream where the caller put it, so live
      // output arriving after it is applied after it. A program that turns
      // tracking back on a moment later still gets tracking.
      term.write(STOP_REPORTING)
    },

    reportsPointer() {
      if (disposed) return false
      return term.modes.mouseTrackingMode !== 'none'
    },

    attachTo(el: HTMLElement) {
      term.open(el)
      // Best-effort GPU rendering; the DOM renderer is a fine fallback, and
      // the load is deliberately not awaited so the terminal is on screen
      // before the addon module has even been fetched.
      void loadWebglRenderer(term, () => disposed)
    },

    detectLinks(detector) {
      linkProvider?.dispose()
      linkProvider = null
      if (disposed || detector === null) return
      linkProvider = term.registerLinkProvider({
        provideLinks: (bufferLine, provide) => {
          pathLinksAt(term, bufferLine, detector).then(provide, () => provide(undefined))
        },
      })
    },

    dispose() {
      if (disposed) return
      disposed = true
      linkProvider?.dispose()
      linkProvider = null
      term.dispose()
    },

    // Everything from here on can be called after disposal: a queued animation
    // frame, a media-query change landing mid-teardown, a focus effect racing
    // an unmount, a key bar tap that arrives as the view goes away. xterm
    // throws from a disposed terminal, so each of the four that reach into
    // `term` checks first. answerQueries needs no check — it writes the local
    // flag the parser handlers read and touches nothing of xterm's — and
    // injectForTest is reached from tests alone, which own their teardown.

    setTheme(theme: TerminalTheme) {
      if (disposed) return
      term.options.theme = theme
    },

    focus() {
      if (disposed) return
      term.focus()
    },

    answerQueries(on: boolean) {
      answers = on
    },

    applicationCursorKeys() {
      // A key bar tap can outrun the unmount that disposed this. CSI is the
      // honest answer for a terminal that no longer exists — and the bytes go
      // nowhere anyway, because the view drops them with no ref to send on.
      if (disposed) return false
      return term.modes.applicationCursorKeysMode
    },

    contentSize(): PixelSize | null {
      if (disposed) return null
      const screen = term.element?.querySelector(SCREEN_SELECTOR)
      if (!(screen instanceof HTMLElement)) return null
      // The style attribute, which both renderers write the screen's exact
      // size into, rather than either measurement the browser offers. The
      // rect is out because a non-primary view is scaled by CSS: it reports
      // the scaled box, and dividing the pane by that converges on nothing.
      // And offsetWidth — unscaled, the obvious next choice — rounds to
      // whole pixels, when on a Retina display the true width is fractional:
      // a cell is a whole count of device pixels divided by the pixel ratio.
      // The half-pixel it drops, divided into a cell width and multiplied
      // back out across the pane, can flip cellsThatFit between N and N+1
      // columns depending on the dimensions the screen currently wears; the
      // pty then answers each flip with the other one — a sizing loop that
      // redraws the prompt several times a second for as long as the pane
      // keeps that width. (Style, not "the obvious CSS word for it": see the
      // Tailwind scanner note in src/styles.css.)
      const size = {
        width: parseFloat(screen.style.width) || screen.offsetWidth,
        height: parseFloat(screen.style.height) || screen.offsetHeight,
      }
      return size.width > 0 && size.height > 0 ? size : null
    },

    injectForTest(data: string) {
      term.input(data, true)
    },
  }
}

/** The buffer line a viewport row is currently showing. */
function bufferRow(term: Terminal, row: number): number {
  return term.buffer.active.viewportY + row
}

/** Whether (rowA, colA) comes after (rowB, colB) in reading order. */
function after(rowA: number, colA: number, rowB: number, colB: number): boolean {
  return rowA > rowB || (rowA === rowB && colA > colB)
}

/**
 * Hand a range to xterm's own selection.
 *
 * `select` takes a start and a *length*, and that length wraps: past the
 * width of a row it carries into the next one, which is the only reason a
 * multi-row range can be expressed through the public API at all.
 */
function apply(term: Terminal, row: number, from: number, endRow: number, to: number): void {
  term.select(from, row, (endRow - row) * term.cols + (to - from))
}

/**
 * Whether a cell is blank, asked by column rather than by string index.
 *
 * The distinction is not pedantic. A double-width character occupies two
 * cells and one position in the row's translated text, so walking that text
 * puts every column after the first CJK glyph out by one. Reading cells
 * instead keeps the count honest, and the second cell of a wide character —
 * width zero, no characters of its own — is part of the glyph before it
 * rather than a gap in the middle of a word.
 */
function blankAt(term: Terminal, row: number, col: number): boolean {
  const cell = term.buffer.active.getLine(row)?.getCell(col)
  if (!cell) return true
  if (cell.getWidth() === 0) return false
  const chars = cell.getChars()
  return chars === '' || chars === ' '
}

/**
 * The run of non-blank cells around a column, or null over blank space.
 *
 * Whitespace is the only separator, which is deliberate and is not what a
 * text editor would do. What gets lifted off a terminal is paths, URLs,
 * hashes, flags and session ids, and every one of them is full of the
 * punctuation an editor would break on — a rule that stopped at the hyphen
 * would turn a UUID into six presses.
 */
function wordAt(term: Terminal, row: number, col: number): { from: number; to: number } | null {
  const blank = (c: number) => blankAt(term, row, c)
  if (col < 0 || col >= term.cols || blank(col)) return null
  let from = col
  while (from > 0 && !blank(from - 1)) from--
  let to = col + 1
  while (to < term.cols && !blank(to)) to++
  return { from, to }
}

/**
 * Open a link the terminal's output produced.
 *
 * http and https only. Terminal output is untrusted input: anything the
 * shell prints — including what a remote program or a curled page echoes —
 * can be an OSC 8 sequence, and `javascript:` or `file:` handed to
 * window.open runs in this origin or reads disk. `noopener` for the same
 * reason: the opened page must get no handle back to the app.
 */
export function openTerminalLink(uri: string): void {
  if (!/^https?:\/\//i.test(uri)) return
  window.open(uri, '_blank', 'noopener')
}

/**
 * Read the live screen out of a terminal.
 *
 * Anchored at `baseY`, the top of the screen, rather than at `viewportY`,
 * where the user happens to be looking. The two are equal until there is
 * enough output to scroll, which is what makes the wrong one easy to ship.
 *
 * The trim is not redundant with xterm's own `trimRight`: that trims only
 * cells nothing was ever written to. A cell holding a space character has
 * content and survives it, so a line the program padded out with spaces comes
 * back padded.
 *
 * It trims the space character and nothing else. `\s` would be the reflex and
 * is wrong: it also matches U+00A0 and U+3000, which a program that ends a
 * line with a non-breaking space chose deliberately. Padding is what gets
 * dropped here, not every character that happens to look blank.
 */
export function extractGrid(term: Terminal): Grid {
  const buf = term.buffer.active
  const lines: string[] = []
  for (let y = 0; y < term.rows; y++) {
    const line = buf.getLine(buf.baseY + y)
    lines.push(line ? line.translateToString(true).replace(/[ ]+$/, '') : '')
  }
  return { cols: term.cols, rows: term.rows, lines }
}

/**
 * Load the WebGL renderer into `term`, reporting whether it took.
 *
 * Every failure here is soft by design: no WebGL2, a GPU process that has
 * gone away, a blocked dynamic import. All of them leave the DOM renderer in
 * place, which is slower and entirely usable — a terminal that renders slowly
 * beats a terminal that does not render.
 *
 * `isCancelled` covers the gap between the import starting and finishing: the
 * terminal can be disposed in it, and loading an addon into a disposed
 * terminal leaks the addon and logs from inside xterm.
 */
export async function loadWebglRenderer(
  term: Terminal,
  isCancelled: () => boolean = () => false,
): Promise<boolean> {
  try {
    const { WebglAddon } = await import('@xterm/addon-webgl')
    if (isCancelled()) return false

    const addon = new WebglAddon()
    // A lost context is not recoverable in place; disposing the addon hands
    // rendering back to the DOM renderer instead of leaving a dead canvas.
    addon.onContextLoss(() => addon.dispose())
    term.loadAddon(addon)
    return true
  } catch {
    return false
  }
}
