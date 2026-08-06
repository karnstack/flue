import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { RouterProvider } from '@tanstack/react-router'
import './styles.css'
import { FlueClient } from '@/client/client'
import { isRelayOrigin, loadRelayIdentity } from '@/relay/mode'
import { channelTokenSource, resolveRelaySession } from '@/relay/session'
import { relaySocket } from '@/relay/socket'
import { createFlueRouter, type FlueRouterOptions } from '@/router'
import { stripHandoff, takeRelayHandoff } from '@/lib/url'
import { registerServiceWorker } from '@/lib/sw-register'

// First, before createFlueRouter() reads the location. The daemon has already
// redeemed the handoff token and moved the session token into an HttpOnly
// cookie, so what is left in the URL is spent — but it is still a
// secret-shaped string sitting in the address bar and in the history entry,
// where it gets bookmarked, screenshotted and pasted into bug reports.
//
// Not "before it can leak as a referrer": <link rel="manifest"> and the icon
// links are fetched while the HTML is parsed, long before this deferred module
// runs, so no placement of this line could win that race. What actually closes
// that vector is the daemon's Referrer-Policy: no-referrer.
const cleaned = stripHandoff(location.href)
if (cleaned !== location.href) history.replaceState(null, '', cleaned)

/**
 * The session handoff `app.flue.sh` navigated here with — taken *once*, here,
 * before anything else reads the location.
 *
 * Read at the entry point rather than inside the socket factory because
 * reading it is destructive: `takeRelayHandoff` scrubs the fragment as it
 * reads, so a second caller would find nothing. It carries four things (see
 * src/lib/url.ts): the channel token for the first dial, the target machine's
 * Noise static key, the id it is pinned under, and the control plane to ask
 * for the *next* token — which is what makes a reconnect past the token's
 * sixty seconds work at all.
 *
 * Null on the daemon's own origin and on a self-hosted relay: neither hands out
 * one of these, and neither asks for one.
 */
const relayHandoff = takeRelayHandoff()

/**
 * What this tab can reach, when the page did not come from the daemon.
 *
 * On loopback the socket at /ws is the daemon: already private, and already
 * authenticated by a cookie the daemon itself set. On a relay origin there is
 * no /ws at all — there is a Worker at /client that forwards bytes it must not
 * be able to read. So a relay origin gets a client whose transport is a Noise
 * channel to a daemon whose static key this browser holds; see
 * src/relay/socket.ts, which FlueClient cannot tell apart from a WebSocket.
 *
 * *Which* daemon is the question a hosted relay makes interesting, and the
 * session is the answer: one origin fronts every machine on every account, so
 * the key and the machine it belongs to come from the handoff (or from what
 * this tab remembered across a reload), not from a single per-origin pin. A
 * self-hosted relay has no session and needs none — the origin is the machine.
 *
 * With no daemon key there is nothing to build: the tab has no daemon, and the
 * router is told to say so rather than to connect on a loop with no credential
 * to offer.
 */
async function relayOptions(): Promise<FlueRouterOptions> {
  const session = await resolveRelaySession(relayHandoff)
  const identity = await loadRelayIdentity(session)
  if (identity === null) return { unpaired: true }
  // Built once and shared by every dial, because it holds the one-shot handoff
  // token: the first dial spends it, and every reconnect after that re-mints.
  const token = channelTokenSource(session)
  return {
    // `location.origin` and not a configured one: the page and the relay it
    // talks to are the same deployment by construction, and a URL from anywhere
    // else would be a second thing to keep true.
    client: new FlueClient(location.origin, (origin) =>
      relaySocket(origin, { ...identity, token }),
    ),
  }
}

/*
 * Awaited here, at the entry point, rather than anywhere below it. Reading the
 * key store is asynchronous and the answer decides which app to mount, so the
 * alternative is a FlueClient that accepts a promise and has to hold a "not yet
 * known" state that every one of its methods then answers for. One await in the
 * one module that is allowed to be slow is cheaper than that everywhere.
 *
 * On the daemon's own origin nothing is awaited and nothing is passed: the
 * router mounts the provider it always did, and that builds the loopback
 * client itself.
 */
const router = createFlueRouter(isRelayOrigin() ? await relayOptions() : {})

const root = document.getElementById('root')
if (!root) throw new Error('missing #root')

// The client provider is deliberately not here. It lives on the router's root
// route — see src/router.tsx — which outlives every navigation just as this
// would, so the tab still shares one socket, but which can also see where the
// tab actually is: /pair is served to a device with no session token, and a
// socket opened there is a 401 the client would retry for as long as the page
// is open.
createRoot(root).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
)

// Built app only: `pnpm dev` serves modules from source and has no /sw.js to
// register, and a worker holding a stale shell is the last thing a dev loop
// needs. After load, so it never competes with the app's own resources for
// the first paint.
if (import.meta.env.PROD) {
  addEventListener('load', () => {
    void registerServiceWorker(navigator.serviceWorker)
  })
}
