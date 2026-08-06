// The flue mark and wordmark, ported from web/src/components/wordmark.tsx.
//
// Deliberately the same drawing, not a similar one: the daemon's dashboard puts
// this in its sidebar and its favicon, and app.flue.sh is the other half of the
// same product. Two marks that nearly match read as two products.
//
// Amber here is the *mark*, not the accent — which is why it is named as a
// colour rather than taken from `--primary`. `--primary` is the one filled
// button per screen; a logo that changed with a theme token would stop being a
// logo the first time that token moved.
import { cn } from '@/lib/utils'

/** The mark alone: chevron, cursor bar, 22.5 corner. */
export function Mark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 100 100" aria-hidden="true" className={cn('size-5 shrink-0', className)}>
      {/* zinc-900 in the dark theme, one step above the canvas, or the
          near-black field would dissolve into the near-black page. */}
      <rect width="100" height="100" rx="22.5" className="fill-zinc-950 dark:fill-zinc-900" />
      <path
        d="M20 26 L46 50 L20 74 M54.5 74 L80 74"
        fill="none"
        strokeWidth="10.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="stroke-amber-500"
      />
    </svg>
  )
}

/**
 * Mark plus name. Mono, like the landing page's wordmark: the name is something
 * you type.
 *
 * The size lives on the flex container rather than on a `<span>` around the
 * word — a font size belongs on a block box, and the text node inherits it.
 */
export function Wordmark({ className }: { className?: string }) {
  return (
    <span
      className={cn('flex items-center gap-2 font-mono text-sm font-semibold tracking-tight', className)}
    >
      <Mark />
      flue
    </span>
  )
}
