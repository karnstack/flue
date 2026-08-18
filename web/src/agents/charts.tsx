/*
 * The insights charts, hand-rolled: three small SVG-or-simpler renderers and
 * no chart dependency. Pure props in, marks out — nothing here fetches,
 * aggregates or reads a clock, which keeps every number arguable in
 * agents/view.ts where the aggregation lives.
 *
 * Shared style, per the spec: no axis boxes, one hairline at the base, sparse
 * day labels, y labels in compact units, corners barely eased. Each mark
 * carries a `<title>` (or a title attribute) so hovering answers with the
 * exact figure the compact label rounded away.
 *
 * The two day charts draw into a stable viewBox and scale to their width, so
 * the geometry is arithmetic on the data alone; the labels scale with it,
 * which at half width is small type but never overlapping type.
 */
import type { CSSProperties } from 'react'

import { compactTokens, monthDay, type HeatCell, type HeatMonth } from '@/agents/view'
import { cn } from '@/lib/utils'

/** The drawing's coordinate space. Height per the spec, width chosen so a
 *  two-across arrangement renders near 1:1. */
const W = 640
const H = 160

/** Room above the tallest bar, so the max label never kisses the frame. */
const PLOT_TOP = 14
/** The band under the baseline that the day labels sit in. */
const X_BAND = 18

const BASE_Y = H - X_BAND
const PLOT_H = BASE_Y - PLOT_TOP

/** How wide one bar and its gap are, from how many bars there are. */
function geometry(n: number): { gap: number; barW: number } {
  if (n <= 0) return { gap: 0, barW: 0 }
  const gap = n > 1 ? Math.min(4, (W / n) * 0.15) : 0
  return { gap, barW: (W - gap * (n - 1)) / n }
}

/** Which bars get a day label: the first, the last, and two waypoints. */
function labelIndices(n: number): number[] {
  if (n <= 1) return [0]
  return [...new Set([0, Math.round((n - 1) / 3), Math.round(((n - 1) * 2) / 3), n - 1])]
}

/** The label row under the baseline, shared by both day charts. */
function XLabels({ points, barW, gap }: { points: Array<{ label: string }>; barW: number; gap: number }) {
  return (
    <>
      {labelIndices(points.length).map((at) => {
        const x = at * (barW + gap)
        const anchor = at === 0 ? 'start' : at === points.length - 1 ? 'end' : 'middle'
        return (
          <text
            key={at}
            x={anchor === 'start' ? x : anchor === 'end' ? x + barW : x + barW / 2}
            y={H - 5}
            textAnchor={anchor}
            className="fill-muted-foreground text-[10px]"
          >
            {points[at]!.label}
          </text>
        )
      })}
    </>
  )
}

/** The compact y scale: the max at the top, half of it midway. */
function YLabels({ max, format }: { max: number; format: (n: number) => string }) {
  return (
    <>
      <text x={0} y={PLOT_TOP - 4} className="fill-muted-foreground text-[10px]">
        {format(max)}
      </text>
      <text x={0} y={PLOT_TOP + PLOT_H / 2 - 3} className="fill-muted-foreground text-[10px]">
        {format(max / 2)}
      </text>
    </>
  )
}

export interface StackPoint {
  label: string
  /** The hover sentence for this bar, carried whole from the caller. */
  title: string
  /** One value per series, in the order `colors` names them. */
  parts: number[]
}

/**
 * Bars of stacked bands — tokens per day, banded by tool. `colors` are fill
 * utility classes, one per series, so the tool tokens in styles.css are named
 * exactly once by the caller.
 */
export function StackedBars({
  points,
  colors,
  label,
}: {
  points: StackPoint[]
  colors: string[]
  label: string
}) {
  if (points.length === 0) return null
  const totals = points.map((p) => p.parts.reduce((sum, v) => sum + v, 0))
  const max = Math.max(1, ...totals)
  const { gap, barW } = geometry(points.length)
  return (
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label} className="w-full">
      <YLabels max={max} format={compactTokens} />
      {points.map((p, at) => {
        const x = at * (barW + gap)
        let y = BASE_Y
        return (
          <g key={at}>
            <title>{p.title}</title>
            {p.parts.map((value, series) => {
              const h = (value / max) * PLOT_H
              y -= h
              return value > 0 ? (
                <rect
                  key={series}
                  x={x}
                  y={y}
                  width={barW}
                  height={h}
                  rx={1}
                  className={colors[series]}
                />
              ) : null
            })}
          </g>
        )
      })}
      <line x1={0} x2={W} y1={BASE_Y} y2={BASE_Y} className="stroke-hairline" />
      <XLabels points={points} barW={barW} gap={gap} />
    </svg>
  )
}

export interface BarPoint {
  label: string
  title: string
  value: number
}

/** Plain bars — sessions per day — in the quiet neutral, not a tool colour. */
export function Bars({ points, label }: { points: BarPoint[]; label: string }) {
  if (points.length === 0) return null
  const max = Math.max(1, ...points.map((p) => p.value))
  const { gap, barW } = geometry(points.length)
  const format = (n: number) => String(Math.round(n))
  return (
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label} className="w-full">
      <YLabels max={max} format={format} />
      {points.map((p, at) => {
        const h = (p.value / max) * PLOT_H
        return (
          <g key={at}>
            <title>{p.title}</title>
            {p.value > 0 && (
              <rect
                x={at * (barW + gap)}
                y={BASE_Y - h}
                width={barW}
                height={h}
                rx={1}
                className="fill-zinc-400 dark:fill-zinc-600"
              />
            )}
          </g>
        )
      })}
      <line x1={0} x2={W} y1={BASE_Y} y2={BASE_Y} className="stroke-hairline" />
      <XLabels points={points} barW={barW} gap={gap} />
    </svg>
  )
}

export interface HBarRow {
  key: string
  label: string
  value: number
  /** The full name for the hover, when the label is a cut of something. */
  title?: string
}

/**
 * Ranked rows — top projects, models — as label, proportional bar, compact
 * value. HTML rather than one SVG, and deliberately: the labels have to cut
 * themselves short the way every other label on the screen does, and SVG text
 * cannot, so each bar is a plain proportional fill beside real text.
 */
export function HBars({
  rows,
  label,
  colorClass = 'bg-zinc-400 dark:bg-zinc-600',
}: {
  rows: HBarRow[]
  label: string
  colorClass?: string
}) {
  if (rows.length === 0) return null
  const max = Math.max(1, ...rows.map((r) => r.value))
  return (
    <div role="img" aria-label={label} className="flex flex-col gap-y-1.5">
      {rows.map((r) => (
        <div key={r.key} title={r.title ?? r.label} className="flex items-center gap-x-2">
          <span className="w-24 shrink-0 truncate text-control text-muted-foreground">
            {r.label}
          </span>
          <span className="min-w-0 flex-1">
            <span
              className={cn('block h-3 rounded-[1px]', colorClass, 'w-(--bar-w)')}
              style={{ '--bar-w': `${Math.max(0.5, (r.value / max) * 100)}%` } as CSSProperties}
            />
          </span>
          <span className="w-12 shrink-0 text-right text-xs text-muted-foreground tabular-nums">
            {compactTokens(r.value)}
          </span>
        </div>
      ))}
    </div>
  )
}

/** One heatmap square's edge and the gap between squares, in px — small
 *  enough that a year of columns sits on a desktop, big enough to hover. */
const HEAT_CELL = 11
const HEAT_GAP = 3
const HEAT_STEP = HEAT_CELL + HEAT_GAP

/** How far the columns start in from the left: the weekday gutter (w-7 is
 *  28px) plus one column gap, so the month labels can line up by offset. */
const HEAT_INSET = 31

/** The level fills, level 0 first. A quiet day wears the same barely-there
 *  tint the chart baselines are drawn in, legible on both themes; the four
 *  active levels ramp the one accent by opacity. Teal rather than a tool
 *  colour, because each square aggregates every tool at once. */
const HEAT_FILLS = [
  'bg-hairline',
  'bg-accent-bg/30',
  'bg-accent-bg/50',
  'bg-accent-bg/75',
  'bg-accent-bg',
]

/** The weekday gutter, GitHub's cut of it: three names carry the whole axis. */
const HEAT_DAY_LABELS = ['Mon', '', 'Wed', '', 'Fri', '', '']

/**
 * The activity heatmap — a year of days, one square each, Monday at the top
 * of every column. Plain divs rather than SVG: the squares are a fixed size
 * by design, so there is no geometry to scale, and a `title` per square is
 * the whole interaction. The one wrapper scrolls sideways, which is how a
 * 390px phone gets the year without crushing it.
 */
export function Heatmap({
  weeks,
  months,
  label,
}: {
  weeks: HeatCell[][]
  months: HeatMonth[]
  label: string
}) {
  if (weeks.length === 0) return null
  return (
    <div className="overflow-x-auto">
      <div role="img" aria-label={label} className="w-max">
        <div className="relative h-4" style={{ marginLeft: HEAT_INSET }}>
          {months.map((m) => (
            <span
              key={m.week}
              className="absolute top-0 text-[10px] text-muted-foreground"
              style={{ left: m.week * HEAT_STEP }}
            >
              {m.label}
            </span>
          ))}
        </div>
        <div className="flex gap-x-[3px]">
          <div aria-hidden="true" className="flex w-7 flex-col gap-y-[3px]">
            {HEAT_DAY_LABELS.map((d, at) => (
              <span key={at} className="h-[11px] text-[10px] leading-[11px] text-muted-foreground">
                {d}
              </span>
            ))}
          </div>
          {weeks.map((week) => (
            <div key={week[0]!.dayMs} className="flex flex-col gap-y-[3px]">
              {week.map((cell) =>
                cell.future ? (
                  // Not yet a day: no fill, no title — the square is absent,
                  // not quiet.
                  <div key={cell.dayMs} className="size-[11px]" />
                ) : (
                  <div
                    key={cell.dayMs}
                    title={`${monthDay(cell.dayMs)} · ${
                      cell.tokens > 0 ? `${compactTokens(cell.tokens)} tok` : 'quiet'
                    }`}
                    className={cn('size-[11px] rounded-[2px]', HEAT_FILLS[cell.level])}
                  />
                ),
              )}
            </div>
          ))}
        </div>
        <div className="mt-2 flex items-center justify-end gap-x-1.5 text-control text-muted-foreground">
          Less
          <span className="flex items-center gap-x-[3px]">
            {HEAT_FILLS.slice(1).map((fill) => (
              <span key={fill} aria-hidden="true" className={cn('size-[11px] rounded-[2px]', fill)} />
            ))}
          </span>
          More
        </div>
      </div>
    </div>
  )
}
