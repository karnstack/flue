/**
 * One small figure per problem.
 *
 * Drawn in markup rather than set as art, for the reason the app mock is:
 * they theme with the page and stay crisp anywhere. Each is the same size and
 * uses the same vocabulary as the rest of the page — dashed for what is
 * absent or waiting, solid for what is real, teal for the one thing the eye
 * should land on, so three of them in a row read as a set rather than as
 * three drawings.
 */

const FRAME =
  'flex h-32 items-center justify-center gap-3 overflow-hidden rounded-lg border border-dashed border-border px-4'

/**
 * A window with a build in it, and the same window gone — the dashed outline
 * is what is left of the work when the thing that owned it closes.
 */
export function LidFigure() {
  return (
    <div className={FRAME} aria-hidden="true">
      <div className="w-28 shrink-0 rounded-md bg-card shadow-sm ring-1 ring-zinc-950/10 dark:shadow-none dark:ring-white/10">
        <div className="flex gap-1 border-b border-border px-2 py-1.5">
          <span className="size-1 rounded-full bg-foreground/20" />
          <span className="size-1 rounded-full bg-foreground/20" />
          <span className="size-1 rounded-full bg-foreground/20" />
        </div>
        <div className="space-y-1.5 p-2">
          <p className="font-mono text-[0.5625rem] text-muted-foreground">pnpm build</p>
          <span className="block h-1 w-full overflow-hidden rounded-full bg-foreground/10">
            <span className="block h-full w-2/5 rounded-full bg-primary" />
          </span>
        </div>
      </div>

      <span className="font-mono text-xs text-muted-foreground">&rarr;</span>

      {/* Same footprint, nothing in it. */}
      <div className="flex h-16 w-28 shrink-0 items-center justify-center rounded-md border border-dashed border-border">
        <span className="font-mono text-[0.5625rem] text-muted-foreground">gone</span>
      </div>
    </div>
  )
}

/**
 * A question that has been sitting there, and the clock that has been running
 * since it was asked.
 */
export function WaitingFigure() {
  return (
    <div className={FRAME} aria-hidden="true">
      <div className="w-full max-w-56 rounded-md bg-zinc-950 p-2.5 ring-1 ring-zinc-950/10 dark:ring-white/10">
        <p className="font-mono text-[0.5625rem]/4 text-zinc-500">
          Two ways to fix this. Which do you want?
        </p>
        <p className="mt-2 flex items-center gap-1.5 font-mono text-[0.5625rem]/4">
          <span className="text-teal-400">&gt;</span>
          <span className="term-cursor h-3 bg-teal-400" />
          <span className="ml-auto rounded-full bg-white/8 px-1.5 py-0.5 tabular-nums text-zinc-500">
            waiting 1h 04m
          </span>
        </p>
      </div>
    </div>
  )
}

const SCATTERED = [
  { name: 'macbook', rows: 2 },
  { name: 'studio', rows: 3 },
  { name: 'pi-4', rows: 1 },
  { name: 'vps', rows: 2 },
]

/** Four machines, four lists, and no line between any of them. */
export function ScatteredFigure() {
  return (
    <div className={FRAME} aria-hidden="true">
      {SCATTERED.map((machine) => (
        <div
          key={machine.name}
          className="flex-1 rounded-md border border-dashed border-border p-1.5"
        >
          <p className="truncate font-mono text-[0.5rem] text-muted-foreground">{machine.name}</p>
          <div className="mt-1.5 space-y-1">
            {Array.from({ length: machine.rows }, (_, i) => (
              <span
                // Bars in a fixed-length list; the index is their identity.
                key={i}
                className="block h-1 rounded-full bg-foreground/15"
                style={{ width: `${70 + ((i * 37) % 30)}%` }}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}
