/*
 * What a browser that holds no daemon key is told, instead of a spinner.
 *
 * Reached only from a relay origin, and only when `loadRelayIdentity` came back
 * with nothing (src/relay/mode.ts). Without a pinned key there is no Noise
 * handshake to attempt, so the honest answer is a sentence rather than a socket
 * that reconnects for as long as the tab is open.
 *
 * Narrow on purpose: this screen is *only* for "there is no key here". A
 * browser that has one and cannot complete the handshake — a revoked device, a
 * daemon that has been re-keyed, a daemon that is asleep — is FlueClient's
 * ordinary `reconnecting` state, and the status UI already says so. Widening
 * this page to cover that would mean telling a paired user to pair again every
 * time their laptop shut its lid.
 */
import { useEffect } from 'react'

import { loadRelayIdentity } from '@/relay/mode'

/*
 * The two class strings this page shares with /pair, spelled out rather than
 * imported.
 *
 * Every token has to stay hyphenated for styles.build.test.ts to find it inside
 * a `className`, which is also why they are not assembled from parts.
 */
const PROSE = 'text-base/7 text-pretty text-zinc-600 sm:text-sm/6 dark:text-zinc-400'

/**
 * The unpaired explainer.
 *
 * Same frame as /pair — centred, no wider than a paragraph, no sidebar and no
 * nav — for the same reason: a device with no key has nothing it could navigate
 * to, and links to sessions it cannot open would be chrome promising what it
 * does not have. That includes a link to /pair itself: a pairing link is only
 * good with a live token in it, so a bare link here would be an invitation to
 * the page that says "nothing to pair with yet".
 */
export function UnpairedRoute() {
  /*
   * Ask again, once, on the way in.
   *
   * The flag that mounts this screen is answered at the entry point, before the
   * router exists (src/main.tsx), and never again for the life of the tab. That
   * is one navigation away from being a lie: /pair on a relay origin is a route
   * in this same document, so a device that pairs there and then opens any other
   * address — a back button, a bookmark, the link in the copy above — is
   * client-side routing into a tab still holding "no key", and would be told it
   * is not paired while its key sits in the store. The window between the two is
   * exactly the ceremony the user just finished.
   *
   * Reloading rather than flipping a state: the pinned key decides the client,
   * its Noise transport and the router's context, and all three are built once
   * at the entry point from the identity. A screen that swapped itself out would
   * leave the tab holding a router whose context still says unpaired and a
   * provider with no client to give — the reload is what makes the answer one
   * answer. It cannot loop: the reload re-runs the entry point, which reads the
   * same store and mounts the app instead of this page.
   */
  useEffect(() => {
    let live = true
    void loadRelayIdentity().then((identity) => {
      if (live && identity !== null) location.reload()
    })
    return () => {
      live = false
    }
  }, [])

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-sm flex-col justify-center gap-y-5 px-5 py-10 sm:max-w-md">
      <h1 className="text-2xl/8 font-semibold tracking-tight text-zinc-950 sm:text-xl/7 dark:text-white">
        Not paired with a daemon yet
      </h1>
      <p className={PROSE}>
        This browser holds no key for any machine running flue, so there is nothing for it to
        connect to. Either it has never been paired, or the keys it kept were cleared along with
        the rest of this site’s data.
      </p>
      <p className={PROSE}>
        To let it in: open flue on the machine that runs your sessions, go to Devices, and press
        Pair device. Scan the code it shows with this device, or open the link printed beside it.
      </p>
      <p className={PROSE}>
        The code works once and expires after two minutes, so start it with this device in your
        hand.
      </p>
    </main>
  )
}
