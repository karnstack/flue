import { cn } from '@/lib/utils'

/**
 * The favicon's mark, drawn in the markup so the sidebar, the tab icon and
 * the installed app icon are one image. Teal here is the mark rather than
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
        className="stroke-teal-500"
      />
    </svg>
  )
}

/**
 * GitHub's own mark, drawn here because the icon sets this app carries do not
 * have it: Heroicons has never shipped brand glyphs and Lucide dropped theirs.
 * `currentColor`, so it takes the sidebar's text color in both themes like
 * every other icon beside it.
 */
export function GithubMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" fill="currentColor" className={className}>
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.65 7.65 0 0 1 2-.27c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
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
