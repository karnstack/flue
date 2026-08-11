/**
 * Wrapped lines, assembled and taken apart again.
 *
 * A terminal stores what it drew, not what it was given: a path longer than
 * the window occupies two rows, and a matcher handed one row at a time finds
 * half a path or none. So a hover assembles the whole logical line, matches
 * against that, and maps the ranges it found back to the rows they came from.
 *
 * Deliberately written against a tiny structural interface rather than against
 * xterm, so the arithmetic can be tested without a DOM. See link-provider.ts
 * for the adapter.
 *
 * All of it assumes one unit of text per cell, which is the one place it can
 * be wrong. A double-width glyph, CJK for example, fills two cells and carries
 * one unit, so its row comes back short; a combining mark does the reverse and
 * makes its row long. Forcing every row to exactly `cols` is what keeps either
 * from moving the rows underneath, and moving the rows underneath is the error
 * worth spending anything to avoid. What survives is confined to the row that
 * caused it, measured rather than argued: cells to the right of a wide glyph
 * come out one column low per glyph, and where that row is continued, the pad
 * lays a blank at the join, so text running across the join stops matching
 * there.
 *
 * The obvious precedent says this is avoidable, and it is right. xterm's own
 * web-links addon does not have the limitation: its LinkComputer walks the
 * buffer a cell at a time, skips the empty second half of a wide glyph, and
 * charges each cell however many units its own characters take, then corrects
 * again for a wide glyph pushed onto the following row. Exact, and it costs a
 * live buffer to read cells out of, which is the dependency this file exists
 * to do without. A path with CJK in it is the whole of what that buys.
 */

/** The little of a terminal buffer that assembly needs. */
export interface BufferRows {
  /** How many rows the buffer holds, history included. */
  readonly length: number
  /** Row `y` as text, untrimmed, or null if there is no such row. */
  text(y: number): string | null
  /** Whether row `y` continues the row above it. */
  isWrapped(y: number): boolean
}

/** One logical line: every row of it, joined. */
export interface LogicalLine {
  /** The rows concatenated, each padded to exactly `cols`. */
  text: string
  /** The buffer row `text[0]` sits on. */
  top: number
  /** The width every row contributes, which is what makes the mapping exact. */
  cols: number
}

/** A run of one buffer row, in cells. */
export interface Span {
  /** The buffer row, not the viewport row. */
  y: number
  /** The first column, counted from zero. */
  x1: number
  /** One past the last column. */
  x2: number
}

/** The whole logical line row `y` belongs to, or null if there is no such row. */
export function logicalLineAt(buf: BufferRows, y: number, cols: number): LogicalLine | null {
  if (cols <= 0 || y < 0 || y >= buf.length) return null
  if (buf.text(y) === null) return null

  let top = y
  while (top > 0 && buf.isWrapped(top)) top--
  let last = y
  while (last + 1 < buf.length && buf.isWrapped(last + 1)) last++

  let text = ''
  for (let at = top; at <= last; at++) {
    // Padded and cut to exactly `cols`, because every mapping below is index
    // division by the width. A terminal hands a row over with its trailing
    // blanks already gone, and a row that came back a few units short of its
    // width would move every row under it by that much: silently, and only on
    // a window narrow enough for the line to have wrapped at all.
    text += (buf.text(at) ?? '').padEnd(cols, ' ').slice(0, cols)
  }
  return { text, top, cols }
}

/** Where `[start, end)` of a logical line sits on screen, one span per row. */
export function spansFor(line: LogicalLine, start: number, end: number): Span[] {
  const from = Math.max(0, Math.min(start, line.text.length))
  const to = Math.max(from, Math.min(end, line.text.length))
  const out: Span[] = []
  for (let at = from; at < to; ) {
    const x1 = at % line.cols
    const x2 = Math.min(line.cols, x1 + (to - at))
    out.push({ y: line.top + Math.floor(at / line.cols), x1, x2 })
    at += x2 - x1
  }
  return out
}
