import { describe, expect, it } from 'vitest'
import { cellAt, cellBox, cellsThatFit, fitFactor, GUTTER_PX } from './geometry'

describe('cellBox', () => {
  it('divides rendered pixels by the cells they were rendered at', () => {
    expect(cellBox({ width: 800, height: 408 }, { cols: 80, rows: 24 })).toEqual({
      width: 10,
      height: 17,
    })
  })

  it('keeps the fractional part, because cell widths are fractional', () => {
    // Real glyph advance widths are not whole pixels. Rounding here compounds
    // over eighty columns into several columns of error.
    const cell = cellBox({ width: 803, height: 408 }, { cols: 80, rows: 24 })
    expect(cell!.width).toBeCloseTo(10.0375, 4)
  })

  it('reports nothing rather than a nonsense cell when nothing is laid out', () => {
    // jsdom measures every element at zero, and so does a real browser for an
    // element that has not been painted yet. A zero-width cell would divide
    // into Infinity columns one line later.
    expect(cellBox({ width: 0, height: 408 }, { cols: 80, rows: 24 })).toBeNull()
    expect(cellBox({ width: 800, height: 0 }, { cols: 80, rows: 24 })).toBeNull()
    expect(cellBox({ width: 800, height: 408 }, { cols: 0, rows: 24 })).toBeNull()
    expect(cellBox({ width: 800, height: 408 }, { cols: 80, rows: 0 })).toBeNull()
  })
})

describe('cellsThatFit', () => {
  it('floors to whole cells and reserves the scrollbar gutter', () => {
    expect(cellsThatFit({ width: 800 + GUTTER_PX, height: 408 }, { width: 10, height: 17 })).toEqual(
      { cols: 80, rows: 24 },
    )
  })

  it('never proposes a partial trailing cell', () => {
    const got = cellsThatFit({ width: 809 + GUTTER_PX, height: 415 }, { width: 10, height: 17 })
    expect(got).toEqual({ cols: 80, rows: 24 })
  })

  it('holds a floor under a pane too small to hold anything', () => {
    // A zero-column pty is not a thing the daemon will accept, and a browser
    // window really can be dragged down to a few pixels.
    expect(cellsThatFit({ width: 1, height: 1 }, { width: 10, height: 17 })).toEqual({
      cols: 2,
      rows: 1,
    })
  })

  it('reports the floor rather than Infinity for an unmeasurable cell', () => {
    expect(cellsThatFit({ width: 800, height: 400 }, { width: 0, height: 0 })).toEqual({
      cols: 2,
      rows: 1,
    })
  })
})

describe('fitFactor', () => {
  it('is 1 when the primary grid already fits', () => {
    expect(fitFactor({ width: 400, height: 200 }, { width: 800, height: 600 })).toBe(1)
  })

  it('shrinks by the tighter of the two axes', () => {
    // A phone at 400px wide looking at a laptop's 1600px-wide terminal has to
    // scale to a quarter, even though the height would have allowed a half.
    expect(fitFactor({ width: 1600, height: 800 }, { width: 400, height: 400 })).toBe(0.25)
    expect(fitFactor({ width: 800, height: 1600 }, { width: 400, height: 400 })).toBe(0.25)
  })

  it('never magnifies', () => {
    // Scaling up a terminal blurs every glyph, and the primary's grid is the
    // truth about how much text there is. Leaving the spare space empty is the
    // honest rendering.
    expect(fitFactor({ width: 100, height: 100 }, { width: 1000, height: 1000 })).toBe(1)
  })

  it('falls back to 1 when either box is unmeasurable', () => {
    expect(fitFactor({ width: 0, height: 0 }, { width: 400, height: 400 })).toBe(1)
    expect(fitFactor({ width: 400, height: 400 }, { width: 0, height: 0 })).toBe(1)
  })
})

describe('cellAt', () => {
  const screen = { x: 20, y: 40, width: 800, height: 480 }
  const dims = { cols: 80, rows: 24 }

  it('reads a point as the cell drawn under it', () => {
    // 10px per column, 20px per row, and the screen's own origin subtracted
    // first: the inset around it is not part of the grid.
    expect(cellAt({ x: 20, y: 40 }, screen, dims)).toEqual({ col: 0, row: 0 })
    expect(cellAt({ x: 125, y: 105 }, screen, dims)).toEqual({ col: 10, row: 3 })
  })

  it('cancels the scale a mirroring view is rendered at', () => {
    // The same 80x24 screen, drawn at half size on a phone. The reported box
    // is the scaled one, so dividing by it gives the scaled column width and
    // the factor drops out — a touch two thirds along still reads column 53
    // and not column 26.
    const half = { x: 0, y: 0, width: 400, height: 240 }
    expect(cellAt({ x: 265, y: 120 }, half, dims)).toEqual({ col: 53, row: 12 })
  })

  it('clamps a finger that has run off the edge', () => {
    // What makes dragging to the end of a line possible: past the right edge
    // means the last column, not "no cell".
    expect(cellAt({ x: 9999, y: 9999 }, screen, dims)).toEqual({ col: 79, row: 23 })
    expect(cellAt({ x: -9999, y: -9999 }, screen, dims)).toEqual({ col: 0, row: 0 })
  })

  it('has no answer before anything has been laid out', () => {
    // jsdom, and the first frame in a browser. Dividing by this box would
    // produce an Infinity that only shows up as a selection nobody can aim.
    expect(cellAt({ x: 10, y: 10 }, { x: 0, y: 0, width: 0, height: 0 }, dims)).toBeNull()
    expect(cellAt({ x: 10, y: 10 }, screen, { cols: 0, rows: 0 })).toBeNull()
  })
})
