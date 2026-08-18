/*
 * The insights charts. The bar charts ride shadcn's chart wrapper over
 * Recharts — the one charting stack the component system blesses — while the
 * activity heatmap stays hand-rolled, since a contribution grid is not a
 * Recharts shape and a grid of little squares needs no scales. Pure props in,
 * marks out: nothing here fetches, aggregates or reads a clock, which keeps
 * every number arguable in agents/view.ts where the aggregation lives.
 *
 * Colour reaches Recharts through the CSS variables styles.css already
 * themes (--color-tool-*, --color-accent-bg), passed via each config's
 * `color` field. The wrapper's `.dark`-class theme mechanism goes unused on
 * purpose: this app themes by media query and has no .dark class to match.
 */
import { Bar, BarChart, LabelList, Rectangle, XAxis, YAxis } from 'recharts'
import type { RectangleProps } from 'recharts'

import { compactTokens, monthDay, type HeatCell, type HeatMonth } from '@/agents/view'
import type { AgentTool } from '@/client/protocol'
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from '@/components/ui/chart'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

/** The tool series, coloured by the identity tokens styles.css themes. */
const TOOL_CHART_CONFIG = {
  claude: { label: 'Claude', color: 'var(--color-tool-claude)' },
  codex: { label: 'Codex', color: 'var(--color-tool-codex)' },
  pi: { label: 'Pi', color: 'var(--color-tool-pi)' },
} satisfies ChartConfig

const TOOL_KEYS = ['claude', 'codex', 'pi'] as const satisfies readonly AgentTool[]

/**
 * A stack segment that rounds its top only when it is the stack's crown —
 * the last series with anything in it that day. A blanket radius would put
 * pill-shaped joints in the middle of every mixed stack; a radius on the
 * final series alone would leave a flat top on the days that series sat out.
 */
function crownedSegment(at: number) {
  return function CrownedSegment(props: RectangleProps & { payload?: ToolDayDatum }) {
    const rest = TOOL_KEYS.slice(at + 1)
    const crowned = props.payload !== undefined && rest.every((k) => props.payload![k] <= 0)
    return <Rectangle {...props} radius={crowned ? [3, 3, 0, 0] : 0} />
  }
}

/** One day of a tool-banded chart: the label plus one value per tool. */
export interface ToolDayDatum {
  label: string
  claude: number
  codex: number
  pi: number
}

/**
 * A day-by-day stacked bar chart banded by tool — tokens and session counts
 * share it, differing only in how the numbers print.
 */
export function ToolDayChart({
  data,
  label,
  format,
}: {
  data: ToolDayDatum[]
  label: string
  format: (n: number) => string
}) {
  if (data.length === 0) return null
  return (
    <ChartContainer config={TOOL_CHART_CONFIG} className="aspect-auto h-48 w-full">
      <BarChart
        accessibilityLayer
        data={data}
        margin={{ top: 4, right: 0, left: 0, bottom: 0 }}
        aria-label={label}
      >
        <XAxis
          dataKey="label"
          tickLine={false}
          axisLine={{ stroke: 'var(--color-hairline)' }}
          tickMargin={6}
          minTickGap={48}
          interval="preserveStartEnd"
          tick={{ fontSize: 10 }}
        />
        <YAxis
          width={36}
          tickLine={false}
          axisLine={false}
          tickCount={3}
          allowDecimals={false}
          tickFormatter={format}
          tick={{ fontSize: 10 }}
        />
        <ChartTooltip
          cursor={{ fill: 'var(--color-row-hover)' }}
          content={
            <ChartTooltipContent
              formatter={(value, name) => (
                <div className="flex w-full items-center gap-x-1.5">
                  <span
                    aria-hidden="true"
                    className="size-2 shrink-0 rounded-[2px]"
                    style={{ backgroundColor: `var(--color-${String(name)})` }}
                  />
                  <span className="text-muted-foreground">
                    {TOOL_CHART_CONFIG[name as AgentTool]?.label ?? String(name)}
                  </span>
                  <span className="ml-auto pl-3 font-medium tabular-nums">
                    {format(Number(value))}
                  </span>
                </div>
              )}
            />
          }
        />
        {TOOL_KEYS.map((tool, at) => (
          <Bar
            key={tool}
            dataKey={tool}
            stackId="day"
            fill={`var(--color-${tool})`}
            shape={crownedSegment(at)}
          />
        ))}
      </BarChart>
    </ChartContainer>
  )
}

export interface RankRow {
  /** A unique identity — the cwd, the model id — never the display label,
   *  because two projects can share a basename and a category axis keyed on
   *  a duplicated label folds their bars into one. */
  key: string
  label: string
  value: number
  /** The full name for the hover, when the label is a cut of something. */
  title?: string
}

const RANK_CONFIG = {
  value: { label: 'Tokens', color: 'var(--color-accent-bg)' },
} satisfies ChartConfig

/** Ranked horizontal bars — top projects, models — in the accent. */
export function RankChart({ rows, label }: { rows: RankRow[]; label: string }) {
  if (rows.length === 0) return null
  const labels = new Map(rows.map((r) => [r.key, r.label]))
  const cut = (name: string) => (name.length > 13 ? `${name.slice(0, 12)}…` : name)
  return (
    <ChartContainer
      config={RANK_CONFIG}
      className="aspect-auto w-full"
      style={{ height: rows.length * 28 + 8 }}
    >
      <BarChart
        accessibilityLayer
        data={rows}
        layout="vertical"
        margin={{ top: 0, right: 44, left: 0, bottom: 0 }}
        aria-label={label}
      >
        <XAxis type="number" hide />
        <YAxis
          type="category"
          dataKey="key"
          width={104}
          tickLine={false}
          axisLine={false}
          tick={{ fontSize: 11 }}
          tickFormatter={(key: string) => cut(labels.get(key) ?? key)}
        />
        <ChartTooltip
          cursor={{ fill: 'var(--color-row-hover)' }}
          content={
            <ChartTooltipContent
              hideIndicator
              labelFormatter={(_value, payload) => {
                const first = payload?.[0]?.payload as RankRow | undefined
                return first?.title ?? first?.label ?? ''
              }}
              formatter={(value) => (
                <span className="ml-auto font-medium tabular-nums">
                  {compactTokens(Number(value))}
                </span>
              )}
            />
          }
        />
        {/* Not animated: the grow-in hides the value labels for its
            duration, which reads as a blink whenever the data legitimately
            refreshes. A ranked list is read, not watched. */}
        <Bar
          dataKey="value"
          fill="var(--color-value)"
          fillOpacity={0.7}
          radius={2}
          barSize={14}
          isAnimationActive={false}
        >
          <LabelList
            dataKey="value"
            position="right"
            formatter={(v: unknown) => compactTokens(Number(v))}
            className="fill-muted-foreground"
            fontSize={11}
          />
        </Bar>
      </BarChart>
    </ChartContainer>
  )
}

/** One heatmap square's edge and the gap between squares, in px — sized so
 *  a year of columns fills the insights column near exactly, and generous
 *  enough that a fingertip can land on one day. Must agree with the size
 *  utilities on the squares below. */
const HEAT_CELL = 13
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

/** The hover's day line: weekday plus date, so a square answers "which
 *  Tuesday" without the reader counting rows. */
function heatDayLabel(dayMs: number): string {
  const weekday = new Date(dayMs).toLocaleDateString(undefined, { weekday: 'short' })
  return `${weekday} ${monthDay(dayMs)}`
}

/**
 * The activity heatmap — a year of days, one square each, Monday at the top
 * of every column. Plain divs rather than SVG: the squares are a fixed size
 * by design, so there is no geometry to scale, and a tooltip per square is
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
    <div className="max-w-full overflow-x-auto">
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
              <span key={at} className="h-[13px] text-[10px] leading-[13px] text-muted-foreground">
                {d}
              </span>
            ))}
          </div>
          {/* One provider over the whole grid, so after the first square
              opens its neighbours answer instantly — the sweep-across-a-year
              gesture this graphic exists for. The native title attribute was
              here first and looked like the nineties. */}
          <TooltipProvider delayDuration={150}>
            {weeks.map((week) => (
              <div key={week[0]!.dayMs} className="flex flex-col gap-y-[3px]">
                {week.map((cell) =>
                  cell.future ? (
                    // Not yet a day: no fill, no hover — the square is
                    // absent, not quiet.
                    <div key={cell.dayMs} className="size-[13px]" />
                  ) : (
                    <Tooltip key={cell.dayMs}>
                      <TooltipTrigger asChild>
                        <div className={cn('size-[13px] rounded-[2px]', HEAT_FILLS[cell.level])} />
                      </TooltipTrigger>
                      <TooltipContent sideOffset={6}>
                        <span className="font-medium">{heatDayLabel(cell.dayMs)}</span>
                        <span className="text-background/70">
                          {/* A painted day with no token figure is backfill:
                              the tool's own counters remember activity whose
                              transcripts are gone, so it is active, not
                              quiet — just unmeasured. */}
                          {cell.tokens > 0
                            ? `${compactTokens(cell.tokens)} tok`
                            : cell.level > 0
                              ? 'active'
                              : 'quiet'}
                        </span>
                      </TooltipContent>
                    </Tooltip>
                  ),
                )}
              </div>
            ))}
          </TooltipProvider>
        </div>
        <div className="mt-2 flex items-center justify-end gap-x-1.5 text-control text-muted-foreground">
          Less
          <span className="flex items-center gap-x-[3px]">
            {HEAT_FILLS.slice(1).map((fill) => (
              <span key={fill} aria-hidden="true" className={cn('size-[13px] rounded-[2px]', fill)} />
            ))}
          </span>
          More
        </div>
      </div>
    </div>
  )
}