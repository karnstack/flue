/** A snapshot of the terminal grid, used by tests and by reattach. */
export interface Grid {
  cols: number
  rows: number
  /**
   * One entry per row of the live grid — always exactly `rows` entries —
   * with trailing whitespace trimmed. Rows are the screen's rows, not the
   * viewport's: scrolling back through history does not change a snapshot.
   */
  lines: string[]
}

/**
 * The narrow seam between flue and whatever emulates the terminal.
 *
 * xterm.js implements this today. Keeping it small and free of xterm-specific
 * concepts is what keeps the protocol client and the terminal route testable
 * without a DOM, and is the whole reason this file exists: every part of flue
 * that talks to a terminal talks to these seven methods.
 */
export interface Emulator {
  /**
   * Feed bytes received from the daemon.
   *
   * Parsing may be asynchronous, so the grid need not reflect the write when
   * this returns. `done` fires once it does; it is also the hook to apply
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
  /** Capture the current grid. */
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
  /** Test-only: simulate user input. */
  injectForTest(data: string): void
}
