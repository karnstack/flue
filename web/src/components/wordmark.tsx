import { cn } from '@/lib/utils'

/**
 * The favicon's mark, drawn in the markup so the sidebar, the tab icon and
 * the installed app icon are one image. Amber here is the mark rather than
 * an accent — theme.ts draws the same distinction for the app icon — and the
 * geometry is the favicon's own: chevron, cursor bar, 22.5 corner.
 */
export function Mark() {
  return (
    <svg viewBox="0 0 100 100" aria-hidden="true" className="size-5 shrink-0">
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

/** Mono, like the landing page's wordmark: the name is something you type. */
export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={cn('flex items-center gap-x-2', className)}>
      <Mark />
      <span className="font-mono text-sm/6 font-semibold tracking-tight text-zinc-950 dark:text-white">
        flue
      </span>
    </span>
  )
}
