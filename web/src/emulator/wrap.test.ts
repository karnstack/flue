import { describe, expect, it } from 'vitest'

import { logicalLineAt, spansFor, type BufferRows } from './wrap'

/**
 * A buffer built from row texts, with `|` marking a row that continues the one
 * above it. Rows come back exactly as written, short and long ones included,
 * so that padding them to the width stays the assembler's job and not the
 * fixture's.
 */
function buffer(cols: number, ...rows: string[]): BufferRows {
  const parsed = rows.map((r) => ({ wrapped: r.startsWith('|'), text: r.replace(/^\|/, '') }))
  return {
    length: parsed.length,
    text: (y) => parsed[y]?.text ?? null,
    isWrapped: (y) => parsed[y]?.wrapped ?? false,
  }
}

describe('logicalLineAt', () => {
  it('pads a short row out to the width, so the arithmetic holds', () => {
    const line = logicalLineAt(buffer(8, 'ab'), 0, 8)
    expect(line).toStrictEqual({ text: 'ab      ', top: 0, cols: 8 })
  })

  it('cuts a long row back to the width, so the rows under it stay aligned', () => {
    // A cell can carry more than one unit of text, a combining mark being the
    // usual way. Left alone it would push every row below it out of place.
    expect(logicalLineAt(buffer(4, 'aaaaaa'), 0, 4)).toStrictEqual({
      text: 'aaaa',
      top: 0,
      cols: 4,
    })
    expect(logicalLineAt(buffer(4, 'aaaaaa', '|bb'), 0, 4)).toStrictEqual({
      text: 'aaaabb  ',
      top: 0,
      cols: 4,
    })
  })

  it('walks backward and forward across every wrapped row', () => {
    const buf = buffer(4, 'aaaa', '|bbbb', '|cccc', 'dddd')
    // Hovering the middle row finds the whole line, not the row.
    expect(logicalLineAt(buf, 1, 4)).toStrictEqual({ text: 'aaaabbbbcccc', top: 0, cols: 4 })
    expect(logicalLineAt(buf, 2, 4)).toStrictEqual({ text: 'aaaabbbbcccc', top: 0, cols: 4 })
    // And stops at the row that starts a new one.
    expect(logicalLineAt(buf, 3, 4)).toStrictEqual({ text: 'dddd', top: 3, cols: 4 })
  })

  it('has nothing to say about a row that is not there', () => {
    const buf = buffer(4, 'aaaa')
    expect(logicalLineAt(buf, 5, 4)).toBeNull()
    expect(logicalLineAt(buf, -1, 4)).toBeNull()
    expect(logicalLineAt(buf, 0, 0)).toBeNull()
  })
})

describe('spansFor', () => {
  const line = { text: 'aaaabbbbcccc', top: 7, cols: 4 }

  it('keeps a range inside one row as one span', () => {
    expect(spansFor(line, 1, 3)).toStrictEqual([{ y: 7, x1: 1, x2: 3 }])
  })

  it('breaks a range at every row boundary it crosses', () => {
    // This is the case the phone has and the laptop does not.
    expect(spansFor(line, 2, 10)).toStrictEqual([
      { y: 7, x1: 2, x2: 4 },
      { y: 8, x1: 0, x2: 4 },
      { y: 9, x1: 0, x2: 2 },
    ])
  })

  it('clamps a range that runs past the text', () => {
    expect(spansFor(line, 10, 99)).toStrictEqual([{ y: 9, x1: 2, x2: 4 }])
  })

  it('has no span for an empty or inverted range', () => {
    expect(spansFor(line, 4, 4)).toStrictEqual([])
    expect(spansFor(line, 8, 2)).toStrictEqual([])
  })
})
