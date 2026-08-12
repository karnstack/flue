import type { Emulator, Grid, PixelSize, TerminalTheme } from '@/emulator/types'

export interface FakeEmulatorOptions {
  cols?: number
  rows?: number
  theme?: TerminalTheme
}

export interface FakeEmulator extends Emulator {
  /** Everything written, decoded as UTF-8. */
  readonly written: string[]
  /** Everything written, joined — the usual thing to assert on. */
  text(): string
  readonly cols: number
  readonly rows: number
  readonly themes: TerminalTheme[]
  /** Every answerQueries() call, in order. Last one is the live setting. */
  readonly queryAnswers: boolean[]
  readonly mountedOn: HTMLElement | null
  readonly disposals: number
  readonly focusCalls: number
  /** Net lines scrolled through scrollLines(); positive is toward newer. */
  readonly scrolled: number
  /** What contentSize() reports. jsdom lays nothing out, so this is set by hand. */
  measured: PixelSize | null
  /** What applicationCursorKeys() reports; set by hand like measured. */
  appCursor: boolean
  /** Simulate the user typing. */
  send(text: string): void
  /**
   * Where each stopReporting() call landed, as a count of written chunks.
   *
   * A count rather than a flag because the ordering against the output
   * stream is the property worth testing: clearing the modes before a
   * replayed backlog has been written would be undone by the backlog.
   */
  readonly reportingStops: number[]
  /** What reportsPointer() answers; set by hand like measured. */
  pointerReports: boolean
}

/**
 * An Emulator that records instead of rendering.
 *
 * The terminal view's contract with the emulator is a sequence of calls — a
 * reset before a truncated snapshot, dimensions from `attached`, bytes for one
 * ref and not another — and every one of those is invisible through a real
 * xterm under jsdom, which lays out nothing and paints nothing. This makes
 * them assertions rather than inferences.
 */
export function createFakeEmulator(opts: FakeEmulatorOptions = {}): FakeEmulator {
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  const listeners: Array<(bytes: Uint8Array) => void> = []
  const written: string[] = []
  const themes: TerminalTheme[] = []
  const queryAnswers: boolean[] = []
  const reportingStops: number[] = []

  const self: FakeEmulator = {
    written,
    themes,
    queryAnswers,
    reportingStops,
    cols: opts.cols ?? 80,
    rows: opts.rows ?? 24,
    mountedOn: null,
    disposals: 0,
    focusCalls: 0,
    scrolled: 0,
    measured: null,
    appCursor: false,
    pointerReports: false,

    text: () => written.join(''),

    send(text: string) {
      const bytes = encoder.encode(text)
      for (const cb of listeners) cb(bytes)
    },

    write(bytes: Uint8Array, done?: () => void) {
      written.push(decoder.decode(bytes))
      // Synchronously, which the seam explicitly permits and xterm does not
      // do — a consumer that assumed otherwise would be caught here.
      done?.()
    },

    resize(cols: number, rows: number) {
      mutable(self).cols = cols
      mutable(self).rows = rows
    },

    scrollLines(n: number) {
      mutable(self).scrolled += n
    },

    snapshot(): Grid {
      return { cols: self.cols, rows: self.rows, lines: Array(self.rows).fill('') }
    },

    onData(cb: (bytes: Uint8Array) => void) {
      listeners.push(cb)
    },

    stopReporting() {
      reportingStops.push(written.length)
      mutable(self).pointerReports = false
    },

    reportsPointer: () => self.pointerReports,

    attachTo(el: HTMLElement) {
      mutable(self).mountedOn = el
    },

    dispose() {
      mutable(self).disposals++
    },

    setTheme(theme: TerminalTheme) {
      themes.push(theme)
    },

    answerQueries(on: boolean) {
      queryAnswers.push(on)
    },

    focus() {
      mutable(self).focusCalls++
    },

    contentSize: () => self.measured,

    applicationCursorKeys: () => self.appCursor,

    injectForTest(data: string) {
      self.send(data)
    },
  }

  if (opts.theme) themes.push(opts.theme)
  return self
}

/** The readonly fields above are readonly to the test, not to this file. */
function mutable(e: FakeEmulator) {
  return e as { -readonly [K in keyof FakeEmulator]: FakeEmulator[K] }
}
