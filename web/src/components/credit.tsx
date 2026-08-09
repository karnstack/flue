import { AUTHOR_URL } from '@/lib/links'
import { cn } from '@/lib/utils'

/**
 * Who made this, in the corner where a colophon belongs.
 *
 * Placed over the panel rather than at the end of it, because the panel has
 * no end: every management screen scrolls its own body, so a line appended to
 * the content would be reachable only by scrolling to the bottom of whichever
 * list happened to be open, and on a short screen it would sit halfway up the
 * page instead.
 *
 * Which makes it an overlay, and an overlay over a scrolling list has to earn
 * the pixels it covers. It does so by taking none: pointer events pass
 * straight through the wrapper and are picked back up only by the link
 * itself, so a row underneath this text stays clickable, and the text is
 * dimmed to the quietest step the palette has until a pointer is on it.
 *
 * Not below md. On a phone the bottom-right corner is where a thumb rests and
 * where the key bar and the safe area both want room, and a credit is not
 * worth any of that.
 */
export function Credit({ className }: { className?: string }) {
  return (
    <p
      className={cn(
        'pointer-events-none absolute right-4 bottom-2.5 z-10 hidden select-none text-xs text-zinc-400 md:block dark:text-zinc-600',
        className,
      )}
    >
      Built by{' '}
      <a
        href={AUTHOR_URL}
        target="_blank"
        rel="noopener noreferrer"
        className="pointer-events-auto font-medium underline-offset-2 transition-colors hover:text-zinc-950 hover:underline dark:hover:text-white"
      >
        karn
      </a>{' '}
      and a few AI agents
    </p>
  )
}
