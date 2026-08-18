import { Link } from '@tanstack/react-router'

import {
  compactCost,
  compactTokens,
  displayTitle,
  latestModel,
  rowKey,
  rowTokens,
  shortModel,
  type AgentGroup,
  type AgentRow,
} from '@/agents/view'
import { since } from '@/components/session-table'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import type { AgentTool } from '@/client/protocol'
import { cn } from '@/lib/utils'

/**
 * The viewer's path, written out rather than imported from src/router.tsx for
 * session-table's reason: the router reaches this component through the
 * agents screen, so the import would close a cycle. `to` is typed against the
 * registered tree, so a path that drifts is a compile error.
 */
const VIEWER_PATH = '/agents/$machineId/$tool/$sessionId' as const

/** Each tool's identity colour, as the one utility that names its token. */
const TOOL_DOT: Record<AgentTool, string> = {
  claude: 'bg-tool-claude',
  codex: 'bg-tool-codex',
  pi: 'bg-tool-pi',
}

/** The 8px dot that says which CLI wrote a transcript. Colour is the whole
 *  message, so assistive technology hears the tool's name instead. */
export function ToolDot({ tool, label }: { tool: AgentTool; label?: string }) {
  return (
    <span role="img" aria-label={label ?? tool} className="flex size-4 shrink-0 items-center justify-center">
      <span aria-hidden="true" className={cn('size-2 shrink-0 rounded-full', TOOL_DOT[tool])} />
    </span>
  )
}

/** The quiet text the trailing details are set in, as session rows set theirs. */
const META_TEXT = 'text-xs/6 whitespace-nowrap text-zinc-500 dark:text-zinc-400'

/**
 * One transcript, one row, the whole of it a link to the viewer. No overlay
 * trick here, unlike session rows: an agent row carries no checkbox and no
 * menu, so the anchor can simply be the row.
 *
 * Two arrangements share the markup. From md up it is a single 40px line —
 * identity left, figures ranged right. Below md the figures fold to a second
 * line under the title, because at 390px one line holds a title or a set of
 * numbers, not both.
 */
function AgentRowLine({ r, showMachine }: { r: AgentRow; showMachine: boolean }) {
  const title = displayTitle(r)
  const model = latestModel(r)
  const tokens = rowTokens(r)
  return (
    <li>
      <Link
        to={VIEWER_PATH}
        params={{ machineId: r.machineId, tool: r.tool, sessionId: r.id }}
        aria-label={`Open the ${title} transcript`}
        className="flex flex-col rounded-md px-2 py-1.5 outline-none hover:bg-row-hover focus-visible:outline-2 focus-visible:-outline-offset-1 focus-visible:outline-ring active:bg-row-press md:h-10 md:flex-row md:items-center md:gap-x-2.5 md:py-0"
      >
        <span className="flex min-w-0 flex-1 items-center gap-x-2">
          <ToolDot tool={r.tool} />
          <span className="min-w-0 truncate text-base/6 font-medium text-zinc-950 sm:text-control dark:text-white">
            {title}
          </span>
          <span
            title={r.cwd}
            className="min-w-0 truncate text-control text-zinc-500 max-md:hidden dark:text-zinc-400"
          >
            {projectOf(r)}
          </span>
          <span className={cn(META_TEXT, 'ml-auto shrink-0 tabular-nums md:hidden')}>
            {since(r.endedAt)}
          </span>
        </span>

        {/* The second line below md: project, model and tokens in one quiet
            sentence, cut short rather than wrapped. */}
        <span className={cn(META_TEXT, 'min-w-0 truncate pl-6 md:hidden')}>
          {[projectOf(r), model === null ? null : shortModel(model), `${compactTokens(tokens)} tok`]
            .filter((part) => part !== null && part !== '')
            .join(' · ')}
        </span>

        {/* The figures, md and up, in the order a reader resolves a row. */}
        <span className="flex shrink-0 items-center gap-x-2.5 max-md:hidden">
          {model !== null && (
            <span className="font-mono text-xs whitespace-nowrap text-zinc-500 dark:text-zinc-400" title={model}>
              {shortModel(model)}
            </span>
          )}
          <span className={cn(META_TEXT, 'tabular-nums')}>{r.messageCount} msgs</span>
          <span className={cn(META_TEXT, 'tabular-nums')}>{compactTokens(tokens)} tok</span>
          {r.costUsd !== undefined && (
            <span className={cn(META_TEXT, 'tabular-nums')}>{compactCost(r.costUsd)}</span>
          )}
          {showMachine && (
            <Badge variant="outline" className="text-zinc-500 dark:text-zinc-400">
              {r.machineName || r.machineId}
            </Badge>
          )}
          <span title={r.endedAt} className={cn(META_TEXT, 'w-14 text-right tabular-nums')}>
            {since(r.endedAt)}
          </span>
        </span>
      </Link>
    </li>
  )
}

/** The project a row belongs to, said as its directory's last segment. */
function projectOf(r: AgentRow): string {
  const trimmed = r.cwd.replace(/\/+$/, '')
  if (trimmed === '') return r.cwd
  return trimmed.slice(trimmed.lastIndexOf('/') + 1)
}

/**
 * The transcripts in headed runs, one row each — the same flat vocabulary as
 * the sessions list: headings over hairline-free rows, no card and no column
 * headers, because the layout already says what each piece is.
 */
export function AgentList({ groups, showMachine }: { groups: AgentGroup[]; showMachine: boolean }) {
  return (
    <div className="flex flex-col gap-y-4">
      {groups.map((g) => (
        <section key={g.key} className="flex flex-col">
          <div className="flex items-baseline gap-x-1.5 px-2 py-1">
            <h2 className="min-w-0 truncate text-control font-medium text-zinc-950 dark:text-white">
              {g.label}
            </h2>
            <span className="shrink-0 text-xs text-zinc-500 tabular-nums dark:text-zinc-400">
              {g.rows.length}
            </span>
          </div>
          <ul role="list" className="mt-1 flex flex-col">
            {g.rows.map((r) => (
              <AgentRowLine key={rowKey(r)} r={r} showMachine={showMachine} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  )
}

/**
 * Nothing indexed anywhere: the sessions screen's empty-state figure, quoted
 * with this screen's own sentence. The cursor pairs with motion-safe so a
 * reduced-motion setting leaves it lit rather than flashing.
 */
export function AgentEmptyState() {
  return (
    <div className="flex flex-col items-center py-12 text-center sm:py-16">
      <div className="w-full max-w-xs rounded-lg bg-zinc-950 px-4 py-3 text-left shadow-medium ring-1 ring-white/10 dark:bg-zinc-900">
        <p className="font-mono text-sm/6 text-zinc-300">
          <span className="text-zinc-400">$</span> claude
          <span
            aria-hidden="true"
            className="ml-2 inline-block h-[1.1em] w-[0.6em] bg-teal-400 align-text-bottom motion-safe:animate-blink"
          />
        </p>
      </div>
      <p className="mt-6 text-base/6 font-medium text-balance text-zinc-950 dark:text-white">
        No agent transcripts
      </p>
      <p className="mt-1 max-w-[44ch] text-base/7 text-pretty text-zinc-600 sm:text-sm/6 dark:text-zinc-400">
        Sessions from Claude Code, Codex, and Pi will appear here once those CLIs have run on a
        connected machine.
      </p>
    </div>
  )
}

/** Placeholder rows while the first answers are still on their way. */
export function AgentSkeleton() {
  return (
    <div className="flex flex-col gap-y-3">
      <Skeleton className="h-5 w-40" />
      <Skeleton className="h-8 w-full" />
      <Skeleton className="h-8 w-full" />
      <Skeleton className="h-8 w-full" />
    </div>
  )
}
