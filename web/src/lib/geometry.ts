/**
 * The pixel arithmetic behind flue's sizing policy, with no DOM in it.
 *
 * The policy: exactly one attached client is primary and owns the pty's
 * dimensions. It measures its own pane and asks the daemon for the cells that
 * fit. Every other client renders the primary's screen at the primary's
 * dimensions and scales the whole surface to fit its own pane. That is what
 * stops a phone at 40 columns from shrinking a laptop's terminal.
 *
 * A note for whoever edits this file next: Tailwind scans prose exactly as it
 * scans markup, so the ordinary English verb for changing a terminal's
 * dimensions compiles a CSS rule of that name into the shipped stylesheet
 * wherever it is written in a comment. It happened twice while this file was
 * being written, the second time inside the comment warning about the first.
 * `sizing` and `dimensions` read better anyway; styles.build.test.ts holds the
 * line, and src/styles.css lists the other nine words that behave this way.
 *
 * jsdom lays nothing out — every measurement there is zero — so this is the
 * part of that policy a test can actually reach. Each function below therefore
 * has a defined answer for an unmeasurable box rather than an Infinity or a
 * NaN that only shows up as a blank screen.
 */

import type { Cell } from '@/emulator/types'

export interface Box {
  width: number
  height: number
}

export interface Dimensions {
  cols: number
  rows: number
}

/**
 * Space held back for the scrollback bar down the right-hand edge.
 *
 * 14px, matching xterm's own fit addon. The bar is always laid out — the
 * viewport is `overflow-y: scroll`, not `auto` — so a pane measurement that
 * ignored it would propose one column more than there is room for, and the
 * last column of every line would sit under the bar.
 */
export const GUTTER_PX = 14

/** The smallest pty flue will ask for. Mirrors xterm's own fit addon. */
const MIN_COLS = 2
const MIN_ROWS = 1

function measurable(box: Box): boolean {
  return (
    Number.isFinite(box.width) && Number.isFinite(box.height) && box.width > 0 && box.height > 0
  )
}

/**
 * The size of one character cell, from a rendered screen and the dimensions it
 * was rendered at.
 *
 * Derived rather than asked for, because the emulator seam reports pixels and
 * flue already knows the dimensions. Null when nothing has been laid out yet,
 * which is every measurement under jsdom and the first frame in a browser.
 */
export function cellBox(content: Box, dims: Dimensions): Box | null {
  if (!measurable(content)) return null
  if (!Number.isFinite(dims.cols) || !Number.isFinite(dims.rows)) return null
  if (dims.cols <= 0 || dims.rows <= 0) return null
  // Deliberately not rounded. A glyph advance width is rarely a whole number,
  // and rounding it here compounds across eighty columns into whole columns of
  // error in the dimensions proposed below.
  return { width: content.width / dims.cols, height: content.height / dims.rows }
}

/**
 * How many whole cells of `cell` a pane holds.
 *
 * Floored, and never taken to the nearest: a partial trailing column is a
 * column the pty believes it has and the user cannot see.
 */
export function cellsThatFit(pane: Box, cell: Box): Dimensions {
  if (!measurable(cell) || !measurable(pane)) return { cols: MIN_COLS, rows: MIN_ROWS }
  return {
    cols: Math.max(MIN_COLS, Math.floor((pane.width - GUTTER_PX) / cell.width)),
    rows: Math.max(MIN_ROWS, Math.floor(pane.height / cell.height)),
  }
}

/**
 * The factor at which a `content`-sized surface fits inside `pane`.
 *
 * Capped at 1. Magnifying would smear every glyph to fill space the primary's
 * screen has no text for; leaving that space empty is the honest rendering,
 * and it is also the one that keeps a laptop's view unchanged when a phone
 * joins the same session.
 */
export function fitFactor(content: Box, pane: Box): number {
  if (!measurable(content) || !measurable(pane)) return 1
  return Math.min(pane.width / content.width, pane.height / content.height, 1)
}

/** A point on the glass, in the same coordinates a touch reports. */
export interface Point {
  x: number
  y: number
}

/** Where a rendered screen sits on the glass, and how big it ended up. */
export interface ScreenBox extends Point, Box {}

/**
 * Which cell a point on the glass is over.
 *
 * `screen` is the rendered surface's own box as the browser reports it, which
 * on a scaled view is the *scaled* box. That is exactly why the arithmetic
 * here divides by it rather than by a cell size measured anywhere else:
 * dividing a scaled width by the column count gives the scaled width of one
 * column, and the factor cancels out. A cell size taken from `cellBox` would
 * not cancel, and every touch on a phone mirroring a laptop would land a
 * column or two off, further out the further right the finger went.
 *
 * Clamped to the screen rather than refused outside it. A drag that runs off
 * the edge means the row it ran off, which is what makes dragging to the end
 * of a line possible at all; and the inset around the surface is blank space
 * a press can legitimately begin in.
 */
export function cellAt(point: Point, screen: ScreenBox, dims: Dimensions): Cell | null {
  if (!measurable(screen) || dims.cols < 1 || dims.rows < 1) return null
  const col = Math.floor(((point.x - screen.x) / screen.width) * dims.cols)
  const row = Math.floor(((point.y - screen.y) / screen.height) * dims.rows)
  return {
    col: Math.min(Math.max(col, 0), dims.cols - 1),
    row: Math.min(Math.max(row, 0), dims.rows - 1),
  }
}
