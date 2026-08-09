/*
 * What a session looks like right now, worked out from its bytes.
 *
 * The daemon answers `peek` with the raw tail of a session's scrollback —
 * escape sequences and all — because rendering is this side's job and this
 * side owns a terminal emulator. That emulator is not the one to use here.
 * xterm draws into a DOM node, keeps a WebGL context and a full scrollback,
 * and a hover card that spun one up per row would pay all of that to read a
 * dozen lines of text it then throws away.
 *
 * So this is a terminal small enough to be worth having twice: a grid of
 * characters, a cursor, and the handful of sequences that decide where text
 * lands. It renders to strings and understands nothing about colour, because
 * a preview is a paragraph of monospaced text and every SGR in the stream is
 * something it deliberately drops.
 *
 * The sequences it *does* implement are not a guess about what programs emit.
 * They are the ones that move text somewhere other than where a naive
 * strip-the-escapes reader would put it — cursor motion, erase, carriage
 * return — because that reader is what this replaces, and what it got wrong
 * was every full-screen program: a TUI that redraws its frame in place would
 * come out as a dozen stacked copies of itself. Everything else is skipped
 * precisely enough that it takes no characters with it.
 */

/** The grid this falls back to when a preview names no dimensions. */
const FALLBACK_COLS = 80
const FALLBACK_ROWS = 24

/**
 * The widest and tallest grid a preview will build.
 *
 * The dimensions arrive from the daemon and describe a real terminal, so they
 * are not hostile — but they are also not this card's business: a 400-column
 * session previewed at 400 columns would wrap nowhere near where the card is
 * cut off. The cap keeps the work bounded and the wrapping honest.
 */
const MAX_COLS = 200
const MAX_ROWS = 100

/** Where a tab stop falls. Every terminal in practice, and the VT100 default. */
const TAB_WIDTH = 8

/** Bytes that are not characters: the C0 controls this grid acts on. */
const BEL = 0x07
const BS = 0x08
const TAB = 0x09
const LF = 0x0a
const CR = 0x0d
const ESC = 0x1b

/**
 * One terminal's worth of characters, and where the next one goes.
 *
 * Rows are arrays of single-character strings rather than strings, because
 * writing into the middle of a JavaScript string means rebuilding it, and a
 * screenful of output writes into the middle of a row once per character.
 */
class Grid {
  private rows: string[][]
  private row = 0
  private col = 0

  constructor(
    private readonly cols: number,
    private readonly height: number,
  ) {
    this.rows = Array.from({ length: height }, () => [])
  }

  /** Put one character where the cursor is and step past it. */
  put(ch: string) {
    // Wrap before writing, not after: a character written at the last column
    // occupies it, and the wrap is what the *next* one does. Deferring it the
    // other way would leave the cursor off the end of the row.
    if (this.col >= this.cols) {
      this.col = 0
      this.down()
    }
    const line = this.rows[this.row]!
    // A cursor moved past the end of a short line leaves a gap, and the gap is
    // spaces: a program that positions and prints is drawing a column, and
    // holes read as one when they are filled and as a ragged edge when they
    // are not.
    while (line.length < this.col) line.push(' ')
    line[this.col] = ch
    this.col++
  }

  /**
   * Down one row, scrolling when there is nowhere further down to go.
   *
   * The scroll is what makes this a terminal rather than a page: the tail of a
   * long stream is exactly the case a preview is for, and a grid that stopped
   * at the last row would show the first screenful of the tail instead of the
   * last.
   */
  down() {
    if (this.row + 1 < this.height) {
      this.row++
      return
    }
    this.rows.shift()
    this.rows.push([])
  }

  up() {
    if (this.row > 0) this.row--
  }

  /** Move the cursor without writing, clamped to the grid. */
  moveTo(row: number, col: number) {
    this.row = clamp(row, 0, this.height - 1)
    this.col = clamp(col, 0, this.cols - 1)
  }

  moveBy(rows: number, cols: number) {
    this.moveTo(this.row + rows, this.col + cols)
  }

  get at(): { row: number; col: number } {
    return { row: this.row, col: this.col }
  }

  carriageReturn() {
    this.col = 0
  }

  backspace() {
    if (this.col > 0) this.col--
  }

  tab() {
    this.col = Math.min(this.cols - 1, (Math.floor(this.col / TAB_WIDTH) + 1) * TAB_WIDTH)
  }

  /** Erase within the cursor's own row. `mode` is CSI K's argument. */
  eraseLine(mode: number) {
    const line = this.rows[this.row]!
    if (mode === 1) {
      for (let i = 0; i <= this.col && i < line.length; i++) line[i] = ' '
      return
    }
    if (mode === 2) {
      line.length = 0
      return
    }
    line.length = Math.min(line.length, this.col)
  }

  /** Erase whole rows around the cursor. `mode` is CSI J's argument. */
  eraseDisplay(mode: number) {
    if (mode === 1) {
      for (let r = 0; r < this.row; r++) this.rows[r] = []
      this.eraseLine(1)
      return
    }
    if (mode === 2 || mode === 3) {
      this.rows = Array.from({ length: this.height }, () => [])
      return
    }
    this.eraseLine(0)
    for (let r = this.row + 1; r < this.height; r++) this.rows[r] = []
  }

  /** The grid as lines, trailing spaces trimmed off each. */
  lines(): string[] {
    return this.rows.map((line) => line.join('').replace(/\s+$/, ''))
  }
}

function clamp(n: number, lo: number, hi: number): number {
  return n < lo ? lo : n > hi ? hi : n
}

/**
 * Whether a byte begins a CSI final byte — the character that ends a
 * `ESC [ … <final>` sequence. Everything between the bracket and it is
 * parameters and intermediates, which this parser reads as text and mostly
 * ignores.
 */
function isCsiFinal(b: number): boolean {
  return b >= 0x40 && b <= 0x7e
}

/**
 * Draw `data` onto a grid of `cols` × `rows` and read the result back as
 * lines, blank ones and all.
 *
 * The bytes are a *tail*, so they will usually begin partway through
 * something — mid-escape-sequence, mid-UTF-8 character, mid-line. Nothing here
 * treats that as an error: a truncated sequence at the front consumes a few
 * characters that were never going to make sense anyway, and the decoder is
 * lenient by construction.
 */
export function renderPreviewLines(data: Uint8Array, cols: number, rows: number): string[] {
  const width = clamp(Math.floor(cols) || FALLBACK_COLS, 8, MAX_COLS)
  const height = clamp(Math.floor(rows) || FALLBACK_ROWS, 2, MAX_ROWS)
  const grid = new Grid(width, height)

  // Decoded once, up front, with the replacement character standing in for a
  // partial rune at either end. Decoding lazily per byte would mean
  // reimplementing UTF-8, and TextDecoder is in every browser this app runs
  // in — including, since Node 11, the one the tests run in.
  const text = new TextDecoder('utf-8', { fatal: false }).decode(data)

  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)

    if (code === ESC) {
      i = escape(text, i, grid)
      continue
    }
    switch (code) {
      case LF:
        grid.down()
        continue
      case CR:
        grid.carriageReturn()
        continue
      case BS:
        grid.backspace()
        continue
      case TAB:
        grid.tab()
        continue
      case BEL:
        continue
    }
    // Every other C0 control, and DEL. They are not characters and a preview
    // that printed them as boxes would say the program emitted boxes.
    if (code < 0x20 || code === 0x7f) continue
    // A surrogate pair is one character wearing two code units, and a grid
    // that stored them in two cells would put half an emoji in each — which a
    // later overwrite of one cell then splits for good.
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      grid.put(text.slice(i, i + 2))
      i++
      continue
    }
    grid.put(text[i]!)
  }

  return grid.lines()
}

/**
 * Consume one escape sequence beginning at `at`, applying whatever it means,
 * and answer the index of its last character.
 *
 * The return is an index rather than a length so the caller's `for` can take
 * it directly; a sequence that runs off the end of the buffer — the ordinary
 * case for a tail cut mid-sequence — consumes the rest and ends the loop.
 */
function escape(text: string, at: number, grid: Grid): number {
  const next = text.charCodeAt(at + 1)

  // OSC: ESC ] … BEL, or ESC ] … ESC \. Title changes live here, and a
  // preview neither shows nor wants them — but they carry arbitrary text, so
  // skipping to the terminator rather than to the next control character is
  // the difference between dropping a title and printing one.
  if (next === 0x5d) {
    for (let i = at + 2; i < text.length; i++) {
      const c = text.charCodeAt(i)
      if (c === BEL) return i
      if (c === ESC && text.charCodeAt(i + 1) === 0x5c) return i + 1
    }
    return text.length
  }

  // CSI: ESC [ params intermediates final.
  if (next === 0x5b) {
    let i = at + 2
    while (i < text.length && !isCsiFinal(text.charCodeAt(i))) i++
    if (i >= text.length) return text.length
    applyCsi(text.slice(at + 2, i), text[i]!, grid)
    return i
  }

  // Everything else. `ESC ( B` and friends take one more byte; the rest —
  // ESC 7, ESC 8, ESC M, ESC = — are single. Both are handled by consuming
  // the byte after ESC, plus one more for the charset-designation family,
  // which is the only two-byte form that appears in ordinary output.
  if (next === 0x28 || next === 0x29 || next === 0x2a || next === 0x2b) return at + 2
  return at + 1
}

/** Apply one CSI sequence's effect on where text lands. */
function applyCsi(params: string, final: string, grid: Grid) {
  // Private sequences — `ESC [ ? 25 l`, `ESC [ ? 1049 h` — set modes rather
  // than move anything, with one exception this deliberately does not make:
  // switching to the alternate screen would, in a real terminal, hide what
  // came before. Honouring that here would blank the preview of every program
  // that uses one at the exact moment it starts drawing, which is the moment
  // somebody is hovering to see. The redraw that follows overwrites the grid
  // anyway, so the frame the reader gets is the current one either way.
  if (params.startsWith('?')) return

  const args = params.split(';').map((p) => (p === '' ? 0 : Number.parseInt(p, 10) || 0))
  // CSI's own default: an omitted parameter is 1 for motion, 0 for erase.
  const n = args[0] === undefined || args[0] === 0 ? 1 : args[0]

  switch (final) {
    case 'A':
      for (let k = 0; k < n; k++) grid.up()
      return
    case 'B':
      grid.moveBy(n, 0)
      return
    case 'C':
      grid.moveBy(0, n)
      return
    case 'D':
      grid.moveBy(0, -n)
      return
    case 'E':
      grid.moveTo(grid.at.row + n, 0)
      return
    case 'F':
      grid.moveTo(grid.at.row - n, 0)
      return
    case 'G':
      grid.moveTo(grid.at.row, n - 1)
      return
    case 'H':
    case 'f':
      // Both parameters are 1-based and both default to 1.
      grid.moveTo((args[0] || 1) - 1, (args[1] || 1) - 1)
      return
    case 'J':
      grid.eraseDisplay(args[0] ?? 0)
      return
    case 'K':
      grid.eraseLine(args[0] ?? 0)
      return
    // Everything else — SGR (`m`), scroll regions, device queries, insert and
    // delete — either paints or is answered by a terminal that is talking back
    // to a program. A preview does neither.
  }
}

/**
 * The last `max` lines a session drew that have anything on them.
 *
 * Blank lines *between* content are kept, because they are how output is
 * paragraphed and a preview that squeezed them out would run two commands'
 * output together. Only the run of empties at either end goes: a program that
 * has just cleared its screen leaves a grid of them, and they are the reason a
 * naive tail shows a card full of nothing.
 */
export function previewLines(data: Uint8Array, cols: number, rows: number, max: number): string[] {
  const lines = renderPreviewLines(data, cols, rows)
  let end = lines.length
  while (end > 0 && lines[end - 1]!.trim() === '') end--
  let start = 0
  while (start < end && lines[start]!.trim() === '') start++
  const body = lines.slice(start, end)
  return body.length > max ? body.slice(body.length - max) : body
}

/**
 * Base64 as bytes.
 *
 * `atob` rather than a hand-rolled decoder, and a lenient one: the daemon is
 * the only source of these strings and it produces them with encoding/json, so
 * a string that will not decode means something has gone wrong upstream of a
 * hover card — which is not the place to find out about it. An empty answer
 * renders as "nothing to show", which is the honest thing for a card to say
 * either way.
 */
export function decodeBase64(text: string): Uint8Array {
  try {
    const binary = atob(text)
    const out = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
    return out
  } catch {
    return new Uint8Array(0)
  }
}
