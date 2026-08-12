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
 * that talks to a terminal talks to this interface.
 *
 * `setTheme`, `focus` and `contentSize` arrived with the terminal view, and
 * each is here rather than in the view because the alternative was the view
 * reaching past the seam into xterm's own DOM and options — which is the one
 * thing this file exists to prevent. All three are emulator-agnostic: every
 * terminal emulator has a palette, a focus state, and a rendered size. The two
 * that came after them, `answerQueries` and `applicationCursorKeys`, are the
 * same bargain struck over terminal modes rather than over what is drawn:
 * which client may answer a program's questions, and how a program wants its
 * arrow keys encoded.
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
  /**
   * Scroll the viewport by whole lines; positive is toward newer output.
   *
   * This exists for touch: xterm's own viewport scrolls on wheel events and
   * nothing else, so a phone gets no scrolling at all unless the view
   * translates drags into this.
   */
  scrollLines(n: number): void
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
   * Forget the reporting modes a replayed backlog turned on.
   *
   * A session's scrollback is bytes, not state, so replaying it re-runs
   * every mode change the shell ever wrote — including the ones belonging to
   * a program that has since exited or been killed with the daemon. Mouse
   * tracking and focus reporting are the two that matter, because they are
   * the only modes that put bytes on the wire with nobody typing: an armed
   * emulator sends an SGR report for every pointer move, and the shell
   * behind it receives that as somebody typing "35;61;22M" at the prompt.
   *
   * Only those two, and deliberately. Application cursor keys and bracketed
   * paste are also replayable and also stale, but they change what a
   * keystroke means rather than inventing keystrokes, so clearing them
   * against a live program would break arrows and pastes in a client that
   * had nothing wrong with it. See settleModes in internal/session for the
   * wider reset, which runs where there is no live program to break.
   *
   * Local to this emulator. Nothing reaches the shell.
   */
  stopReporting(): void
  /**
   * Whether this emulator would report pointer movement to the program.
   *
   * Exists so the reset above can be tested for what it does rather than for
   * the bytes it writes.
   */
  reportsPointer(): boolean
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
   * Re-colour a terminal that is already on screen.
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
   * dimensions with nothing scaling it — because it is what the sizing
   * policy divides by. Null rather than a zero box: a caller that divides by
   * this must be made to handle "not measurable yet", which is every call
   * under jsdom and the first frame in a browser.
   */
  contentSize(): PixelSize | null
  /**
   * Whether this emulator answers device queries — DA, DSR/CPR, DECRQM,
   * OSC color queries, XTGETTCAP — arriving in the output stream.
   *
   * Exactly one client attached to a session may answer: the stream is
   * broadcast to every mirror, each holds a full emulator, and a program
   * that asked once would otherwise be answered once per tab — the extras
   * land at the shell prompt as garbage. The view flips this with the
   * primary role. Off by default until the daemon says who is primary.
   */
  answerQueries(on: boolean): void
  /**
   * Whether the program has asked for application cursor keys (DECCKM).
   *
   * The on-screen key bar synthesises arrow presses, and an arrow's encoding
   * is the program's choice, not the bar's: CSI moves history at a shell,
   * SS3 is what vim and friends expect once they have set the mode. Reading
   * it here keeps the bar as mode-honest as a hardware keyboard through
   * xterm would be.
   */
  applicationCursorKeys(): boolean
  /** Test-only: simulate user input. */
  injectForTest(data: string): void
}
