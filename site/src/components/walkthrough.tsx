import { Clapperboard, Play } from 'lucide-react'
import { lazy, Suspense, useState } from 'react'

import { WALKTHROUGH_POSTER, WALKTHROUGH_RUNTIME } from '@/lib/site'
import { cn } from '@/lib/utils'

const Player = lazy(() => import('@/components/walkthrough-player'))

/**
 * The panel, cut the way every other window on this site is cut. MockTerminal,
 * FleetWindow and the docs Shell blocks all wear it.
 */
const PANEL =
  'relative aspect-video overflow-hidden rounded-xl bg-zinc-950 ring-1 ring-zinc-950/10 dark:ring-white/10'

/**
 * The setup walkthrough, mounted on a click.
 *
 * The click is not decoration. kino pulls in an adaptive streaming engine, and
 * that chunk is 218 kB gzipped against a site whose entire bundle is 101 kB, so
 * mounting it on arrival would triple what every visitor downloads for a video
 * most of them will not play. Deferring it also keeps the custom element out of
 * the prerender, which renders every route to static HTML at build time and has
 * nothing to do with a custom element.
 *
 * What stands in for it until then is a poster and a play button. Deliberately
 * not a copy of kino's own control: matching that pixel for pixel means copying
 * measurements out of a stylesheet this file does not own, and it goes wrong
 * the first time either side changes.
 */
export function Walkthrough({
  align = 'left',
  className,
}: {
  /** Follows the section it lands in, the same way InstallBlock does. */
  align?: 'left' | 'center'
  className?: string
}) {
  const [playing, setPlaying] = useState(false)

  return (
    <figure className={className}>
      <div className={PANEL}>
        {playing ? (
          <Suspense fallback={<Poster />}>
            <Player />
          </Suspense>
        ) : (
          <button
            type="button"
            onClick={() => setPlaying(true)}
            aria-label={`Play the setup walkthrough, ${WALKTHROUGH_RUNTIME}`}
            className="group absolute inset-0 grid w-full place-items-center focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
          >
            <Poster />
            <span className="relative grid size-20 place-items-center rounded-full bg-black/40 backdrop-blur-sm group-hover:bg-black/55 motion-safe:transition">
              <Play className="size-8 fill-white stroke-none" aria-hidden="true" />
            </span>
          </button>
        )}
      </div>
      <figcaption
        className={cn(
          'mt-4 flex items-start gap-3 font-mono text-xs tabular-nums text-muted-foreground',
          align === 'center' ? 'justify-center text-center' : 'text-left',
        )}
      >
        <Clapperboard className="size-3.5 h-lh shrink-0" aria-hidden="true" />
        {WALKTHROUGH_RUNTIME}. Install, one relay in your own Cloudflare account, a phone paired from
        a QR code, then a second machine.
      </figcaption>
    </figure>
  )
}

function Poster() {
  return (
    <img
      src={WALKTHROUGH_POSTER}
      alt=""
      className="absolute inset-0 size-full object-cover"
    />
  )
}
