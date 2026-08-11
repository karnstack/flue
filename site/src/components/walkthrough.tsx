import { MuxPlayer } from '@karnstack/kino/mux'
import '@karnstack/kino/styles.css'
import { Clapperboard } from 'lucide-react'

import {
  WALKTHROUGH_BLUR,
  WALKTHROUGH_PLAYBACK_ID,
  WALKTHROUGH_POSTER,
  WALKTHROUGH_RUNTIME,
} from '@/lib/site'
import { cn } from '@/lib/utils'

/**
 * The setup walkthrough.
 *
 * Nothing here starts playback, and that is worth saying because kino's
 * `autoPlay` prop is right there and using it breaks in a way that takes a
 * while to see. kino builds its <mux-video> inside a mount effect and sets
 * `autoplay` on the element there, while its teardown calls remove(), which
 * detaches an element without pausing it. React runs a mount effect twice in
 * development, so the first element is left detached and playing and
 * unreachable: a second audio track a beat behind the visible one, which no
 * control on the page can stop, because the provider that owned it is gone.
 *
 * The accent is handed over as `var(--primary)` rather than as a colour. kino
 * assigns the prop straight to --kino-accent on its own root, so it resolves
 * inside whichever theme the page is wearing and the header's toggle moves the
 * scrubber with everything else. A literal would have pinned it to one theme.
 *
 * `tokens` is absent on purpose: playback is public, so there is nothing to
 * sign and no key to hold.
 */
export function Walkthrough({
  align = 'left',
  className,
}: {
  /** Follows the section it lands in, the same way InstallBlock does. */
  align?: 'left' | 'center'
  className?: string
}) {
  return (
    <figure className={className}>
      <div className="relative aspect-video overflow-hidden rounded-xl bg-zinc-950 ring-1 ring-zinc-950/10 dark:ring-white/10">
        <MuxPlayer
          playbackId={WALKTHROUGH_PLAYBACK_ID}
          poster={WALKTHROUGH_POSTER}
          placeholder={WALKTHROUGH_BLUR}
          accentColor="var(--primary)"
          /* kino's glass sits inside a corner this site sets. One step in from
             the panel's own, which is what nesting two curves asks for. */
          theme={{ '--kino-radius': 'var(--radius-lg)' }}
        />
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
