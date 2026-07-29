/** A snapshot of the terminal screen, used by tests and by reattach. */
export interface Grid {
  cols: number
  rows: number
  /**
   * One entry per row — always exactly `rows` entries — with trailing
   * whitespace trimmed. The rows are the live screen's, not the viewport's:
   * scrolling back through history does not change a snapshot.
   */
  lines: string[]
}

/** A measurement in CSS pixels. */
export interface PixelSize {
  width: number
  height: number
}

/**
 * A terminal colour palette.
 *
 * Every field is optional: an emulator has defaults for all of them, and a
 * palette that only re-points the background is a legitimate palette.
 *
 * The sixteen ANSI names are the *program's* vocabulary, not flue's. A program
 * asking for red has asked for red, and rendering it in the app's accent
 * colour would be flue lying about the output. Only the four surface roles —
 * background, foreground, cursor and selection — are flue's to choose.
 */
export interface TerminalTheme {
  background?: string
  foreground?: string
  cursor?: string
  cursorAccent?: string
  selectionBackground?: string
  selectionInactiveBackground?: string

  black?: string
  red?: string
  green?: string
  yellow?: string
  blue?: string
  magenta?: string
  cyan?: string
  white?: string
  brightBlack?: string
  brightRed?: string
  brightGreen?: string
  brightYellow?: string
  brightBlue?: string
  brightMagenta?: string
  brightCyan?: string
  brightWhite?: string
}

/**
 * The narrow seam between flue and whatever emulates the terminal.
 *
 * xterm.js implements this today. Keeping it small and free of xterm-specific
 * concepts is what keeps the protocol client and the terminal route testable
 * without a DOM, and is the whole reason this file exists: every part of flue
 * that talks to a terminal talks to these ten methods.
 *
 * The last three arrived with the terminal view, and each is here rather than
 * in the view because the alternative was the view reaching past the seam into
 * xterm's own DOM and options — which is the one thing this file exists to
 * prevent. All three are emulator-agnostic: every terminal emulator has a
 * palette, a focus state, and a rendered size.
 */
export interface Emulator {
  /**
   * Feed bytes received from the daemon.
   *
   * Parsing may be asynchronous, so the screen need not reflect the write
   * when this returns. `done` fires once it does; it is also the hook to apply
   * backpressure with, if the reader ever needs to.
   *
   * `done` may fire synchronously, before `write` returns — xterm parses on a
   * later task, but an implementation that parses immediately is free to call
   * it re-entrantly, so a caller must not assume `write` has returned by the
   * time it runs.
   */
  write(bytes: Uint8Array, done?: () => void): void
  /** Change the rendered dimensions. */
  resize(cols: number, rows: number): void
  /** Capture the current screen. */
  snapshot(): Grid
  /**
   * Register a callback for user input, encoded as UTF-8 bytes.
   *
   * There is no unregister: a registration lasts until `dispose`, and every
   * registered callback receives every keystroke. Register once. If a
   * reconnect needs to send input somewhere else, close over a mutable
   * destination rather than registering a second callback.
   */
  onData(cb: (bytes: Uint8Array) => void): void
  /**
   * Mount into the DOM.
   *
   * One emulator, one mount. Mounting twice opens a second renderer over the
   * same terminal; to move a terminal, or to remount under React's
   * double-invoked effects, dispose and build a new one.
   */
  attachTo(el: HTMLElement): void
  /** Release all resources. Safe to call more than once. */
  dispose(): void
  /**
   * Re-colour a running terminal.
   *
   * Needed because flue follows `prefers-color-scheme` and has no theme
   * toggle: there is no navigation to rebuild the terminal on when the OS
   * switches appearance, so the palette has to be replaceable in place.
   */
  setTheme(theme: TerminalTheme): void
  /** Put the keyboard into the terminal. */
  focus(): void
  /**
   * The size of the rendered screen in CSS pixels, or null if nothing has been
   * laid out.
   *
   * This is the *unscaled* size — what the screen would occupy at the current
   * dimensions with no CSS transform on it — because it is what the sizing
   * policy divides by. Null rather than a zero box: a caller that divides by
   * this must be made to handle "not measurable yet", which is every call
   * under jsdom and the first frame in a browser.
   */
  contentSize(): PixelSize | null
  /** Test-only: simulate user input. */
  injectForTest(data: string): void
}
