import { Terminal } from '@xterm/xterm'
import { WebLinksAddon } from '@xterm/addon-web-links'
import type { Emulator, Grid, PixelSize, TerminalTheme } from './types'

export interface XtermOptions {
  cols?: number
  rows?: number
  theme?: TerminalTheme
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

  /*
   * Shift+Enter, which xterm has no notion of.
   *
   * Here rather than in the terminal view, and that is the whole argument for
   * this seam: the view's own keydown handler has no way to put bytes on the
   * wire without reaching past it. `term.input` sends them through onData, so
   * the key bar's latched Ctrl and the replay mute gate both still apply, and
   * the daemon counts the keystroke as activity exactly as it would any other.
   *
   * keydown alone — keyup and keypress arrive for the same press, and either
   * would send the sequence a second time. Ctrl, Alt and Cmd are all excluded:
   * Ctrl+Shift+Enter is the view's focus-mode chord, and Alt+Enter already
   * produces these bytes through xterm's own encoder.
   */
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown') return true
    if (e.key !== 'Enter' || !e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return true
    // xterm keeps the caret in a real textarea, and refusing the event is not
    // the same as cancelling it: left to the browser, this Enter writes a line
    // into that element and xterm's input listener then reads a value nothing
    // typed. xterm's own cancel never runs, because `false` returns above it.
    e.preventDefault()
    term.input(NEWLINE_CHORD_BYTES, true)
    return false
  })

  const encoder = new TextEncoder()
  let disposed = false

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
      term.scrollLines(n)
    },

    snapshot(): Grid {
      return extractGrid(term)
    },

    onData(cb: (bytes: Uint8Array) => void) {
      term.onData((data) => cb(encoder.encode(data)))
    },

    attachTo(el: HTMLElement) {
      term.open(el)
      // Best-effort GPU rendering; the DOM renderer is a fine fallback, and
      // the load is deliberately not awaited so the terminal is on screen
      // before the addon module has even been fetched.
      void loadWebglRenderer(term, () => disposed)
    },

    dispose() {
      if (disposed) return
      disposed = true
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
      // offsetWidth/offsetHeight rather than getBoundingClientRect, because a
      // non-primary view is scaled by CSS: the rect would report the scaled
      // box, and dividing the pane by that converges on nothing.
      const size = { width: screen.offsetWidth, height: screen.offsetHeight }
      return size.width > 0 && size.height > 0 ? size : null
    },

    injectForTest(data: string) {
      term.input(data, true)
    },
  }
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
