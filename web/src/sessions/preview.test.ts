import { describe, expect, it } from 'vitest'

import { decodeBase64, previewLines, renderPreviewLines } from './preview'

/** The bytes a session would have produced, as a peek delivers them. */
function bytes(s: string): Uint8Array {
  return new TextEncoder().encode(s)
}

describe('renderPreviewLines', () => {
  it('lays plain output out one line per newline', () => {
    const out = renderPreviewLines(bytes('one\r\ntwo\r\nthree'), 20, 5)
    expect(out.slice(0, 3)).toEqual(['one', 'two', 'three'])
  })

  it('drops colour without dropping the text it coloured', () => {
    const out = renderPreviewLines(bytes('\x1b[31mred\x1b[0m and \x1b[1mbold\x1b[0m'), 40, 3)
    expect(out[0]).toBe('red and bold')
  })

  it('lets a carriage return overwrite the line it returned to', () => {
    // A progress bar is exactly this: the same row rewritten, never advanced.
    const out = renderPreviewLines(bytes('50%\r100%'), 20, 3)
    expect(out[0]).toBe('100%')
  })

  it('redraws in place when a program moves the cursor up', () => {
    // The case a strip-the-escapes reader gets wrong: without honouring the
    // cursor move, both frames survive and the card shows the program twice.
    const out = renderPreviewLines(bytes('frame one\r\nsecond\r\n\x1b[2A\x1b[Kframe two'), 20, 5)
    expect(out[0]).toBe('frame two')
  })

  it('erases what a clear-screen cleared', () => {
    const out = renderPreviewLines(bytes('gone\r\nalso gone\r\n\x1b[2J\x1b[Hfresh'), 20, 5)
    expect(out.filter((l) => l !== '')).toEqual(['fresh'])
  })

  it('positions absolutely, one-based, as the sequence means it', () => {
    const out = renderPreviewLines(bytes('\x1b[3;5Hhere'), 20, 5)
    expect(out[2]).toBe('    here')
  })

  it('erases to the end of a line and no further', () => {
    const out = renderPreviewLines(bytes('keep this\rkeep\x1b[K'), 20, 3)
    expect(out[0]).toBe('keep')
  })

  it('wraps at the terminal width rather than running off the grid', () => {
    const out = renderPreviewLines(bytes('abcdefghij'), 8, 4)
    expect(out.slice(0, 2)).toEqual(['abcdefgh', 'ij'])
  })

  it('scrolls, so the tail of a long stream is what survives', () => {
    const out = renderPreviewLines(bytes('a\r\nb\r\nc\r\nd\r\ne'), 10, 3)
    expect(out).toEqual(['c', 'd', 'e'])
  })

  it('swallows a title change whole rather than printing its text', () => {
    const out = renderPreviewLines(bytes('\x1b]0;a window title\x07visible'), 30, 3)
    expect(out[0]).toBe('visible')
  })

  it('swallows an ST-terminated title too', () => {
    const out = renderPreviewLines(bytes('\x1b]2;title\x1b\\visible'), 30, 3)
    expect(out[0]).toBe('visible')
  })

  it('keeps drawing after a mode set it does not implement', () => {
    // Hiding the cursor and switching screens are the two most common private
    // sequences in a TUI's first frame; neither may eat the frame.
    const out = renderPreviewLines(bytes('\x1b[?25l\x1b[?1049hdrawn'), 20, 3)
    expect(out[0]).toBe('drawn')
  })

  it('survives a tail that begins mid-sequence', () => {
    // Every peek is a tail, so this is the ordinary case rather than the
    // exotic one: the front of the buffer is half of something.
    const out = renderPreviewLines(bytes('31mstill readable'), 30, 3)
    expect(out[0]).toContain('still readable')
  })

  it('survives a tail that ends mid-sequence', () => {
    const out = renderPreviewLines(bytes('readable\x1b[3'), 30, 3)
    expect(out[0]).toBe('readable')
  })

  it('keeps an emoji whole', () => {
    const out = renderPreviewLines(bytes('ok ✅ 🎉'), 20, 3)
    expect(out[0]).toBe('ok ✅ 🎉')
  })

  it('expands a tab to the next stop', () => {
    const out = renderPreviewLines(bytes('ab\tc'), 20, 3)
    expect(out[0]).toBe('ab      c')
  })

  it('lets backspace step back over what it wrote', () => {
    // A shell echoing a corrected typo: the wrong character is stepped over
    // and written through, not deleted.
    const out = renderPreviewLines(bytes('ab\bc'), 20, 3)
    expect(out[0]).toBe('ac')
  })
})

describe('previewLines', () => {
  it('trims the blank grid a cleared screen leaves behind', () => {
    expect(previewLines(bytes('\x1b[2J\x1b[Honly this'), 20, 10, 6)).toEqual(['only this'])
  })

  it('keeps the blank lines that paragraph the output', () => {
    expect(previewLines(bytes('a\r\n\r\nb'), 20, 6, 6)).toEqual(['a', '', 'b'])
  })

  it('answers with the last max lines, not the first', () => {
    const out = previewLines(bytes('1\r\n2\r\n3\r\n4\r\n5'), 10, 20, 3)
    expect(out).toEqual(['3', '4', '5'])
  })

  it('answers with nothing for a session that has drawn nothing', () => {
    expect(previewLines(new Uint8Array(0), 80, 24, 6)).toEqual([])
  })

  it('falls back to a real grid when the dimensions are zero', () => {
    // A session the daemon has never sized reports 0×0, and a grid of that
    // size would divide by nothing and answer with nothing.
    expect(previewLines(bytes('sized anyway'), 0, 0, 6)).toEqual(['sized anyway'])
  })
})

/*
 * Compared as plain arrays throughout. jsdom gives the module under test a
 * different realm's Uint8Array from the one this file builds, so `toEqual` on
 * the views themselves fails over two byte-identical buffers — "compared
 * values have no visual difference", which is the assertion telling on itself.
 */
describe('decodeBase64', () => {
  it('reads what the daemon encoded', () => {
    expect([...decodeBase64(btoa('hi'))]).toEqual([...bytes('hi')])
  })

  it('answers empty rather than throwing at a string that is not base64', () => {
    expect([...decodeBase64('!!!not base64!!!')]).toEqual([])
  })

  it('answers empty for the empty tail a silent session has', () => {
    expect([...decodeBase64('')]).toEqual([])
  })
})
