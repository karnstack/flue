import type { IBufferCellPosition, ILink, Terminal } from '@xterm/xterm'

import type { LinkDetector } from './types'

/*
 * The xterm half of link detection: assemble the logical line a hovered row
 * belongs to, and map match indices back onto buffer cells.
 *
 * xterm hands a link provider one buffer row, and a 90-character path in an
 * 80-column phone view occupies two of them. Matching row by row would find
 * half a path on each and neither half would verify — a feature that works on
 * a laptop and silently fails on the device it matters most on. So the
 * provider walks `isWrapped` in both directions and matches against the whole
 * logical line.
 */

/**
 * One logical line: the row asked about plus every row soft-wrapped onto it,
 * with a buffer position recorded per UTF-16 unit as the text is assembled.
 * Match indices are string offsets while decorations want cells, and wide
 * glyphs make the two disagree, so the mapping is carried rather than
 * computed. `bufferLine` is 1-based, as `provideLinks` hands it over.
 */
export function logicalLineAt(
  term: Terminal,
  bufferLine: number,
): { text: string; cells: IBufferCellPosition[] } | null {
  const buf = term.buffer.active
  const asked = bufferLine - 1
  if (!buf.getLine(asked)) return null
  let first = asked
  while (first > 0 && buf.getLine(first)?.isWrapped) first--
  let last = asked
  while (buf.getLine(last + 1)?.isWrapped) last++
  let text = ''
  const cells: IBufferCellPosition[] = []
  for (let y = first; y <= last; y++) {
    const row = buf.getLine(y)
    if (!row) break
    for (let x = 0; x < row.length; x++) {
      const cell = row.getCell(x)
      if (!cell || cell.getWidth() === 0) continue
      const chars = cell.getChars() || ' '
      for (let i = 0; i < chars.length; i++) {
        text += chars[i]!
        cells.push({ x: x + 1, y: y + 1 })
      }
    }
  }
  let cut = text.length
  while (cut > 0 && text[cut - 1] === ' ') cut--
  return { text: text.slice(0, cut), cells: cells.slice(0, cut) }
}

/**
 * The verified links for one hovered row; undefined when nothing qualifies.
 * Ranges are 1-based and end-inclusive, which is what `ILink` expects.
 */
export async function pathLinksAt(
  term: Terminal,
  bufferLine: number,
  detector: LinkDetector,
): Promise<ILink[] | undefined> {
  const line = logicalLineAt(term, bufferLine)
  if (line === null) return undefined
  const candidates = detector.find(line.text)
  if (candidates.length === 0) return undefined
  const real = await detector.verify(candidates.map((c) => c.path))
  const links: ILink[] = []
  for (let i = 0; i < candidates.length; i++) {
    if (real[i] !== true) continue
    const c = candidates[i]!
    const from = line.cells[c.start]
    const to = line.cells[c.end - 1]
    if (from === undefined || to === undefined) continue
    links.push({
      range: { start: from, end: to },
      text: c.path,
      activate: () => detector.open(c),
    })
  }
  return links.length > 0 ? links : undefined
}
