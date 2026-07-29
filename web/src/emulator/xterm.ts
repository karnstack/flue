import { Terminal } from '@xterm/xterm'
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
  })

  const encoder = new TextEncoder()
  let disposed = false

  return {
    write(bytes: Uint8Array, done?: () => void) {
      term.write(bytes, done)
    },

    resize(cols: number, rows: number) {
      term.resize(cols, rows)
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

    // The three below are all reachable after disposal: a queued animation
    // frame, a media-query change landing mid-teardown, a focus effect racing
    // an unmount. xterm throws from a disposed terminal, so each checks.

    setTheme(theme: TerminalTheme) {
      if (disposed) return
      term.options.theme = theme
    },

    focus() {
      if (disposed) return
      term.focus()
    },

    contentSize(): PixelSize | null {
      if (disposed) return null
      const screen = term.element?.querySelector(SCREEN_SELECTOR)
      if (!(screen instanceof HTMLElement)) return null
      // offsetWidth/offsetHeight rather than getBoundingClientRect, because a
      // non-primary view carries a CSS transform: the rect would report the
      // scaled box, and dividing the pane by that converges on nothing.
      const size = { width: screen.offsetWidth, height: screen.offsetHeight }
      return size.width > 0 && size.height > 0 ? size : null
    },

    injectForTest(data: string) {
      term.input(data, true)
    },
  }
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
