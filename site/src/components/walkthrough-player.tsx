import { MuxPlayer } from '@karnstack/kino/mux'
import '@karnstack/kino/styles.css'

import { WALKTHROUGH_BLUR, WALKTHROUGH_PLAYBACK_ID, WALKTHROUGH_POSTER } from '@/lib/site'

/**
 * The player, alone in its own chunk.
 *
 * Nothing names this file with a static import. Walkthrough reaches it through
 * import() and nothing else does, which is what keeps the adaptive streaming
 * engine and kino's stylesheet out of the bytes every visitor downloads. It is
 * also what keeps them out of the prerender: every route here is rendered to
 * static HTML at build time, and the engine registers a custom element, which
 * has no meaning on a server.
 *
 * The accent is handed over as `var(--primary)` rather than as a colour. kino
 * assigns the prop straight to --kino-accent on its own root, so the value is
 * resolved where it is used, inside whichever theme the page is wearing, and
 * the header's toggle moves the scrubber along with everything else without a
 * re-render. A literal would have pinned it to one theme and been wrong in the
 * other.
 *
 * `tokens` is absent on purpose: playback is public, so there is nothing to
 * sign and no key to hold.
 */
export default function WalkthroughPlayer() {
  return (
    <MuxPlayer
      playbackId={WALKTHROUGH_PLAYBACK_ID}
      /* The same URL the closed card already painted, so opening the player
         costs no second image, and the same 24px still under it. */
      poster={WALKTHROUGH_POSTER}
      placeholder={WALKTHROUGH_BLUR}
      /* A click on the card is what mounts this, so the gesture has already
         happened by the time the engine asks to play. */
      autoPlay
      accentColor="var(--primary)"
      /* kino's glass sits inside a corner this site sets. One step in from the
         panel's own, which is what nesting two curves asks for. */
      theme={{ '--kino-radius': 'var(--radius-lg)' }}
    />
  )
}
