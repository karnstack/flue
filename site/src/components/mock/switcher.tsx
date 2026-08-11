import { Search } from 'lucide-react'

import { SWITCHER_PREVIEW, SWITCHER_SECTIONS, type MockSwitcherRow } from '@/components/mock/data'
import { cn } from '@/lib/utils'

/**
 * flue's session switcher, drawn.
 *
 * Same reasoning as FleetWindow: a drawing themes with the page, stays crisp
 * at any density, and cannot rot into a picture of a version nobody ships.
 * The shape is the app's own (web/src/components/session-switcher.tsx): a
 * search field, headed runs of rows, the highlighted row marked by a teal rule
 * rather than a coloured band, a preview pane beside the list, and the hint
 * bar along the bottom.
 *
 * The pane disappears below `@2xl`, exactly as the real one does below `md`,
 * because a preview needs width the phone does not have.
 */
export function SwitcherWindow({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        '@container overflow-hidden rounded-xl bg-white shadow-2xl ring-1 ring-zinc-950/8',
        'dark:bg-zinc-900 dark:shadow-none dark:ring-white/10',
        className,
      )}
    >
      <SearchField />
      <div className="flex">
        <RowList />
        <PreviewPane />
      </div>
      <HintBar />
    </div>
  )
}

/* The field the palette opens focused, with the app's own placeholder. */
function SearchField() {
  return (
    <div className="flex items-center gap-2.5 border-b border-border px-3.5">
      <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      <p className="flex h-11 items-center text-sm text-muted-foreground">Go to session…</p>
    </div>
  )
}

function RowList() {
  return (
    <div className="min-w-0 flex-1 py-1.5 @2xl:w-80 @2xl:flex-none @2xl:border-r @2xl:border-border">
      {SWITCHER_SECTIONS.map((section) => (
        <div key={section.label}>
          <p className="px-3.5 pt-2 pb-1 text-[0.6875rem] font-medium tracking-wide text-muted-foreground uppercase">
            {section.label}
          </p>
          <ul role="list">
            {section.rows.map((row) => (
              <Row key={`${row.machine}/${row.label}`} row={row} />
            ))}
          </ul>
        </div>
      ))}
    </div>
  )
}

/**
 * One row.
 *
 * The dot carries the state, as it does on a session row: teal for something
 * running, hollow for a session that has ended. The teal rule on the left is
 * where the keyboard is, which is one of the few jobs teal has in this app.
 */
function Row({ row }: { row: MockSwitcherRow }) {
  return (
    <li
      className={cn(
        'relative flex h-8 items-center gap-x-2.5 px-3.5 text-sm',
        row.active && 'bg-zinc-950/4 dark:bg-white/6',
      )}
    >
      {row.active && (
        <span aria-hidden="true" className="absolute inset-y-0 left-0 w-0.5 bg-teal-500" />
      )}
      <span
        aria-hidden="true"
        className={cn(
          'size-1.5 shrink-0 rounded-full',
          row.state === 'running' ? 'bg-teal-500' : 'bg-zinc-950/25 dark:bg-white/25',
        )}
      />
      <span className="truncate font-medium text-zinc-950 dark:text-white">{row.label}</span>
      <span className="truncate font-mono text-xs text-muted-foreground @max-lg:hidden">
        {row.cwd}
      </span>
      <span className="ml-auto flex shrink-0 items-center gap-x-2 pl-2">
        {row.current && <span className="text-xs text-muted-foreground">current</span>}
        <span className="font-mono text-xs text-muted-foreground">{row.machine}</span>
        {row.badge && (
          <kbd className="font-mono text-xs text-muted-foreground">&#8963;&#8679;{row.badge}</kbd>
        )}
      </span>
    </li>
  )
}

/**
 * The highlighted row's last fourteen lines.
 *
 * Dark in both themes, like every terminal on this site, and hidden where
 * there is no width for it.
 */
function PreviewPane() {
  return (
    <div className="hidden min-w-0 flex-1 flex-col @2xl:flex">
      <div className="flex items-center gap-x-2 border-b border-border px-3.5 py-2">
        <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-teal-500" />
        <span className="truncate text-sm font-medium">{SWITCHER_PREVIEW.title}</span>
        <span className="ml-auto shrink-0 font-mono text-xs text-muted-foreground">
          {SWITCHER_PREVIEW.machine}
        </span>
      </div>
      <div className="flex-1 overflow-hidden bg-zinc-950 px-3.5 py-3">
        {SWITCHER_PREVIEW.lines.map((line, i) => (
          <p
            // A fixed transcript. The index is the line's identity, and blank
            // lines make it the only stable one.
            key={i}
            // `whitespace-pre` rather than `truncate`, for the reason the app's
            // own pane is a `pre`: the lines were laid out against a terminal's
            // width, so the run of spaces holding `go test`'s columns apart has
            // to survive, and a blank line has to keep its height.
            className="overflow-hidden font-mono text-[0.6875rem]/5 whitespace-pre text-zinc-400"
          >
            {line.startsWith('>') ? (
              <>
                <span className="text-teal-400">&gt;</span>
                {line.slice(1)}
              </>
            ) : (
              line || ' '
            )}
          </p>
        ))}
        <p className="font-mono text-[0.6875rem]/5 whitespace-pre">
          <span className="text-teal-400">$ </span>
          <span className="term-cursor bg-teal-400 text-teal-400" aria-hidden="true" />
        </p>
      </div>
    </div>
  )
}

/*
 * The app's own hint bar, in the labels it prints on a Mac. Off an Apple
 * keyboard it spells the same two chords out as Ctrl+Shift, and a drawing has
 * to pick one — see isApplePlatform in web/src/switcher/keys.ts.
 */
const HINTS: { keys: string; what: string }[] = [
  { keys: '↑↓', what: 'move' },
  { keys: '↵', what: 'open' },
  { keys: '⌃⇧1-9', what: 'pinned' },
  { keys: '⌃⇧[ ]', what: 'prev / next' },
]

function HintBar() {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-border bg-muted/40 px-3.5 py-2 text-[0.6875rem] text-muted-foreground">
      {HINTS.map((hint) => (
        <span key={hint.keys} className="flex items-center gap-x-1">
          <kbd className="font-mono">{hint.keys}</kbd>
          {hint.what}
        </span>
      ))}
      <span className="ml-auto flex items-center gap-x-1">
        <kbd className="font-mono">esc</kbd>
        close
      </span>
    </div>
  )
}
