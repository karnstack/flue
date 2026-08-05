import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { RouterProvider } from '@tanstack/react-router'
import './styles.css'
import { createFlueRouter } from '@/router'
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

const router = createFlueRouter()

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
