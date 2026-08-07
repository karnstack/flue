import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { RouterProvider } from '@tanstack/react-router'
import './styles.css'
import { FlueClient } from '@/client/client'
import { loadOrCreateDeviceKey, loadPinnedDaemonKeyFor } from '@/crypto/keys'
import { bootMachine } from '@/relay/machines'
import { isRelayOrigin } from '@/relay/mode'
import { relaySocket } from '@/relay/socket'
import { createFlueRouter, type FlueRouterOptions } from '@/router'
import { stripHandoff } from '@/lib/url'
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
 * What this tab can reach, when the page did not come from the daemon.
 *
 * On loopback the socket at /ws is the daemon: already private, and already
 * authenticated by a cookie the daemon itself set. On a relay origin there is
 * no /ws at all — there is a Worker at /client/<machine> that forwards bytes
 * it must not be able to read, and one origin fronts every machine this
 * browser has paired with. So the boot needs an answer to "which machine?"
 * before it can build anything: the tab's own selection when it has one, the
 * only machine there is when there is only one (bootMachine owns that
 * judgement), and otherwise the machine picker — which is also where a
 * machine whose pinned key has gone missing lands, because a record this
 * browser cannot handshake for is a row to pick again, not a client to build.
 *
 * The chosen machine's client rides a Noise channel keyed to the static key
 * pinned under that machine's id at pairing time; see src/relay/socket.ts,
 * which FlueClient cannot tell apart from a WebSocket. A key store that will
 * not open at all lands on the picker too, for the reason the old identity
 * loader gave: a rejected promise at the entry point mounts no app and tells
 * the user even less than the picker does.
 */
async function relayOptions(): Promise<FlueRouterOptions> {
  try {
    const machine = bootMachine()
    if (machine === null) return { picker: true }
    const daemonPub = await loadPinnedDaemonKeyFor(machine.id)
    if (daemonPub === null) return { picker: true }
    const identity = { deviceKey: await loadOrCreateDeviceKey(), daemonPub }
    return {
      // `location.origin` and not a configured one: the page and the relay it
      // talks to are the same deployment by construction, and a URL from
      // anywhere else would be a second thing to keep true.
      client: new FlueClient(location.origin, (origin) =>
        relaySocket(origin, identity, machine.id),
      ),
    }
  } catch {
    return { picker: true }
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
