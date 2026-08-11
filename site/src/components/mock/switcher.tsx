import { useEffect, useMemo, useRef, useState } from 'react'
import { Search } from 'lucide-react'

import {
  SWITCHER_ROWS,
  SWITCHER_SECTION_LABELS,
  type MockSwitcherRow,
} from '@/components/mock/data'
import { cn } from '@/lib/utils'

/**
 * flue's session switcher, drawn, and typed into.
 *
 * Same reasoning as FleetWindow: a drawing themes with the page, stays crisp
 * at any density, and cannot rot into a picture of a version nobody ships.
 * The shape is the app's own (web/src/components/session-switcher.tsx): a
 * search field, headed runs of rows, the highlighted row marked by a teal rule
 * rather than a coloured band, a preview pane beside the list, and the hint
 * bar along the bottom.
 *
 * It works, because the page claims one keystroke reaches any session and a
 * still picture cannot support that claim. Everything it does is copied from
 * the app rather than invented, and the two rules worth naming are the ones a
 * plausible fake would get wrong:
 *
 *   - typing collapses the three runs into a single Results run and drops the
 *     number badges, since a badge belongs to a resting order (searchSections,
 *     web/src/switcher/order.ts)
 *   - the arrows wrap rather than stop at the ends (session-switcher.tsx)
 *
 * What it cannot do is open anything, so Enter says so out loud rather than
 * quietly doing nothing under a hint bar that promises otherwise.
 *
 * The pane disappears below `@2xl`, exactly as the real one does below `md`,
 * because a preview needs width the phone does not have.
 */
export function SwitcherWindow({ className }: { className?: string }) {
  const [query, setQuery] = useState('')
  const [picked, setPicked] = useState<MockSwitcherRow | null>(null)
  const [wanted, setWanted] = useState<string | null>(SWITCHER_ROWS[0]?.key ?? null)
  const inputRef = useRef<HTMLInputElement>(null)

  const sections = useMemo(() => buildSections(query), [query])
  const rows = useMemo(() => sections.flatMap((s) => s.rows), [sections])

  // The highlight, resolved rather than stored: a search can hide the row the
  // keyboard was on, and settling that here means no effect has to chase the
  // query with a second render.
  const active = rows.find((row) => row.key === wanted) ?? rows[0] ?? null
  const resting = query.trim() === ''

  const move = (delta: number) => {
    if (rows.length === 0) return
    const at = active === null ? -1 : rows.indexOf(active)
    const next =
      at < 0 ? (delta > 0 ? 0 : rows.length - 1) : (at + delta + rows.length) % rows.length
    setWanted(rows[next]?.key ?? null)
  }

  /*
   * The open chord, on the page that is about the open chord.
   *
   * Both halves of the app's own pair: Command+K, and Ctrl+Shift+K which stays
   * bound on a Mac too (matchChord, web/src/switcher/keys.ts). The platform is
   * not sniffed here the way the app sniffs it, because accepting both
   * everywhere costs nothing on a keyboard that cannot press one of them.
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const open =
        (e.metaKey && !e.ctrlKey && !e.altKey && e.key.toLowerCase() === 'k') ||
        (e.ctrlKey && e.shiftKey && !e.altKey && e.key.toLowerCase() === 'k')
      if (!open) return
      e.preventDefault()
      inputRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' })
      inputRef.current?.focus()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      move(1)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      move(-1)
    } else if (e.key === 'Home') {
      e.preventDefault()
      setWanted(rows[0]?.key ?? null)
    } else if (e.key === 'End') {
      e.preventDefault()
      setWanted(rows[rows.length - 1]?.key ?? null)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      setPicked(active)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      if (query === '') inputRef.current?.blur()
      setQuery('')
      setPicked(null)
    }
  }

  return (
    <div>
      <div
        className={cn(
          '@container overflow-hidden rounded-xl bg-white shadow-2xl ring-1 ring-zinc-950/8',
          'dark:bg-zinc-900 dark:shadow-none dark:ring-white/10',
          className,
        )}
      >
        <SearchField
          ref={inputRef}
          query={query}
          onQuery={(next) => {
            setQuery(next)
            setPicked(null)
          }}
          onKeyDown={onKeyDown}
        />
        <div className="flex min-h-68">
          <RowList
            sections={sections}
            active={active}
            resting={resting}
            query={query}
            onHighlight={setWanted}
          />
          <PreviewPane row={active} />
        </div>
        <HintBar />
      </div>
      <PickedNote row={picked} />
    </div>
  )
}

/* ------------------------------------------------------------ arranging --- */

type DrawnSection = { label: string; rows: MockSwitcherRow[] }

const RESTING_ORDER: MockSwitcherRow['section'][] = ['pinned', 'recent', 'all']

/**
 * The rows, sectioned the way buildPalette sections them.
 *
 * At rest, three runs in falling order of deliberateness, and a run with
 * nothing in it is dropped rather than left as an empty heading. A search
 * collapses all of it into one run, because once somebody is typing the
 * headings are furniture between them and the match.
 */
function buildSections(query: string): DrawnSection[] {
  const needle = query.trim().toLowerCase()

  if (needle !== '') {
    const hits = SWITCHER_ROWS.filter((row) =>
      // The app's haystack, minus the fields a drawn row has no version of:
      // name, working directory, machine (haystack, web/src/sessions/view.ts).
      [row.label, row.cwd, row.machine].some((field) => field.toLowerCase().includes(needle)),
    )
    return hits.length === 0 ? [] : [{ label: 'Results', rows: hits }]
  }

  return RESTING_ORDER.map((key) => ({
    label: SWITCHER_SECTION_LABELS[key],
    rows: SWITCHER_ROWS.filter((row) => row.section === key),
  })).filter((section) => section.rows.length > 0)
}

/* ------------------------------------------------------------- the parts --- */

/** The field the palette opens focused, with the app's own placeholder. */
function SearchField({
  ref,
  query,
  onQuery,
  onKeyDown,
}: {
  ref: React.Ref<HTMLInputElement>
  query: string
  onQuery: (next: string) => void
  onKeyDown: (e: React.KeyboardEvent) => void
}) {
  return (
    <div className="flex items-center gap-2.5 border-b border-border px-3.5">
      <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      <input
        ref={ref}
        type="text"
        value={query}
        onChange={(e) => onQuery(e.target.value)}
        onKeyDown={onKeyDown}
        // A drawing of a palette is still a text field, so it says what it is
        // to anything that cannot see the picture around it.
        aria-label="Search the example fleet"
        autoComplete="off"
        spellCheck={false}
        placeholder="Go to session…"
        className="h-11 w-full bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
      />
    </div>
  )
}

function RowList({
  sections,
  active,
  resting,
  query,
  onHighlight,
}: {
  sections: DrawnSection[]
  active: MockSwitcherRow | null
  resting: boolean
  query: string
  onHighlight: (key: string) => void
}) {
  return (
    <div className="min-w-0 flex-1 py-1.5 @2xl:w-80 @2xl:flex-none @2xl:border-r @2xl:border-border">
      {sections.map((section) => (
        <div key={section.label}>
          <p className="px-3.5 pt-2 pb-1 text-[0.6875rem] font-medium tracking-wide text-muted-foreground uppercase">
            {section.label}
          </p>
          <ul role="list">
            {section.rows.map((row) => (
              <Row
                key={row.key}
                row={row}
                active={row.key === active?.key}
                showBadge={resting}
                onHighlight={() => onHighlight(row.key)}
              />
            ))}
          </ul>
        </div>
      ))}

      {sections.length === 0 && (
        <p className="px-3.5 py-6 text-sm text-muted-foreground" role="status">
          Nothing matching &ldquo;{query.trim()}&rdquo;.
        </p>
      )}
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
function Row({
  row,
  active,
  showBadge,
  onHighlight,
}: {
  row: MockSwitcherRow
  active: boolean
  showBadge: boolean
  onHighlight: () => void
}) {
  return (
    <li
      onMouseMove={onHighlight}
      onClick={onHighlight}
      className={cn(
        'relative flex h-8 cursor-pointer items-center gap-x-2.5 px-3.5 text-sm',
        active && 'bg-zinc-950/4 dark:bg-white/6',
      )}
    >
      {active && <span aria-hidden="true" className="absolute inset-y-0 left-0 w-0.5 bg-teal-500" />}
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
        {/* The chord belongs to the resting order, so a search takes the badge
            off the row rather than promising a key that would land elsewhere. */}
        {showBadge && row.badge && (
          <kbd className="font-mono text-xs text-muted-foreground">&#8963;&#8679;{row.badge}</kbd>
        )}
      </span>
    </li>
  )
}

/**
 * The highlighted row's last lines.
 *
 * Dark in both themes, like every terminal on this site, and hidden where
 * there is no width for it. The prompt row under the tail is drawn only for a
 * session that is running, since a cursor blinking under an exited one would
 * be the pane saying the opposite of the dot beside its name.
 */
function PreviewPane({ row }: { row: MockSwitcherRow | null }) {
  return (
    <div className="hidden min-w-0 flex-1 flex-col @2xl:flex">
      {row && (
        <>
          <div className="flex items-center gap-x-2 border-b border-border px-3.5 py-2">
            <span
              aria-hidden="true"
              className={cn(
                'size-1.5 shrink-0 rounded-full',
                row.state === 'running' ? 'bg-teal-500' : 'bg-zinc-950/25 dark:bg-white/25',
              )}
            />
            <span className="truncate text-sm font-medium">{row.label}</span>
            <span className="ml-auto shrink-0 font-mono text-xs text-muted-foreground">
              {row.machine}
            </span>
          </div>
          <div className="flex-1 overflow-hidden bg-zinc-950 px-3.5 py-3">
            {row.preview.map((line, i) => (
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
            {row.state === 'running' && (
              <p className="font-mono text-[0.6875rem]/5 whitespace-pre">
                <span className="text-teal-400">$ </span>
                <span className="term-cursor bg-teal-400 text-teal-400" aria-hidden="true" />
              </p>
            )}
          </div>
        </>
      )}
    </div>
  )
}

/*
 * The app's own hint bar, in the labels it prints on a Mac. Off an Apple
 * keyboard it spells the same two chords out as Ctrl+Shift, and a drawing has
 * to pick one: see isApplePlatform in web/src/switcher/keys.ts.
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

/**
 * What Enter would have done.
 *
 * The hint bar says Enter opens, and on this page there is nothing to open.
 * Saying so is better than a key that silently does nothing under a bar
 * promising otherwise.
 */
function PickedNote({ row }: { row: MockSwitcherRow | null }) {
  return (
    <p className="mt-3 min-h-5 text-sm text-muted-foreground" role="status">
      {row && (
        <>
          That would open <span className="font-medium text-foreground">{row.label}</span> on{' '}
          <span className="font-mono text-foreground">{row.machine}</span>. This one is a drawing,
          so it stays here.
        </>
      )}
    </p>
  )
}
