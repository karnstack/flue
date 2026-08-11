import { Clapperboard, Play } from 'lucide-react'
import { lazy, Suspense, useState } from 'react'

import { WALKTHROUGH_BLUR, WALKTHROUGH_POSTER, WALKTHROUGH_RUNTIME } from '@/lib/site'
import { cn } from '@/lib/utils'

const Player = lazy(() => import('@/components/walkthrough-player'))

/**
 * Fetch the player on intent rather than on arrival.
 *
 * A mouse reaching the card, or a keyboard reaching the button, is the last
 * warning before a click, and it is usually enough time to have the chunk
 * already there when the click lands. Calling import() twice costs nothing:
 * the second call gets the promise the first one made.
 */
function warm() {
  void import('@/components/walkthrough-player')
}

/**
 * The dark panel, cut the way every other window on this site is cut.
 * MockTerminal, FleetWindow and the Shell blocks in the docs all wear it, and
 * the recording is the only one of them that is not a drawing.
 */
const PANEL =
  '@container relative aspect-video overflow-hidden rounded-xl bg-zinc-950 ring-1 ring-zinc-950/10 dark:ring-white/10'

const CAPTION = `${WALKTHROUGH_RUNTIME}. Install, one relay in your own Cloudflare account, a phone paired from a QR code, then a second machine.`

/**
 * The setup walkthrough, shut until somebody asks for it.
 *
 * It opens on a click rather than on arrival for two reasons, and both of them
 * are load bearing.
 *
 * The pages here are prerendered to static HTML at build time, so every route
 * is rendered on a server first, and the streaming engine behind this video is
 * a custom element that has nothing to render there. Gating it on a click puts
 * it out of that reach by construction. There is no mounted flag and no
 * ClientOnly wrapper, because the state that gates it starts false on both
 * sides, so the first render matches and hydration has nothing to reconcile.
 *
 * And it is nearly nine minutes long. On a page nobody arrived at to watch a
 * video, the honest default is a frame from it with the runtime written
 * underneath, and the engine costs nothing until somebody wants it. What is
 * served is a real button around a real image, which is also what a reader
 * with no JavaScript keeps.
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
      {playing ? (
        <div className={PANEL}>
          <Suspense fallback={<Still />}>
            <Player />
          </Suspense>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setPlaying(true)}
          onPointerEnter={warm}
          onFocus={warm}
          aria-label={`Play the setup walkthrough, ${WALKTHROUGH_RUNTIME}`}
          className={cn(
            PANEL,
            'group grid w-full place-items-center focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
          )}
        >
          <Still />
          <PlayBadge />
        </button>
      )}
      <figcaption
        className={cn(
          'mt-4 flex items-start gap-3 font-mono text-xs tabular-nums text-muted-foreground',
          align === 'center' ? 'justify-center text-center' : 'text-left',
        )}
      >
        <Clapperboard className="size-3.5 h-lh shrink-0" aria-hidden="true" />
        {CAPTION}
      </figcaption>
    </figure>
  )
}

/**
 * What the card holds before anything is asked of it: the 24px copy first, so
 * there is something to look at in the first paint, and the full frame over it
 * once that decodes. It is the same pair kino stacks when the player opens,
 * from the same two URLs, so the handover has nothing to redraw.
 */
function Still() {
  return (
    <>
      <img
        src={WALKTHROUGH_BLUR}
        alt=""
        aria-hidden="true"
        className="absolute inset-0 size-full object-cover"
      />
      <img
        src={WALKTHROUGH_POSTER}
        alt=""
        loading="lazy"
        decoding="async"
        className="absolute inset-0 size-full object-cover"
      />
    </>
  )
}

/**
 * The play control, drawn to kino's own measurements.
 *
 * Same geometry as the one the player shows while it is idle: max(76px, 9cqw)
 * across, a max(32px, 3.8cqw) triangle in it, the same wash of black and the
 * same easing. So opening the video swaps a control for its twin in the same
 * spot rather than cutting to a different one. The cqw half is why the panel
 * opens a query scope of its own, since kino sizes against its own width too.
 *
 * The lengths are pixels rather than spacing steps because they are quoted
 * from a stylesheet this file does not own. A rounder number here would drift
 * away from kino the next time either side moved.
 */
function PlayBadge() {
  return (
    <span className="relative grid size-[max(76px,9cqw)] place-items-center rounded-full bg-black/34 backdrop-blur-sm group-hover:bg-black/50 motion-safe:transition motion-safe:duration-200 motion-safe:ease-[cubic-bezier(0.22,1,0.36,1)] motion-safe:group-hover:scale-106">
      <Play className="size-[max(32px,3.8cqw)] fill-white stroke-none" aria-hidden="true" />
    </span>
  )
}
