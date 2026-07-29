import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { RouterProvider } from '@tanstack/react-router'
import './styles.css'
import { createFlueRouter } from '@/router'
import { stripHandoff } from '@/lib/url'
import { registerServiceWorker } from '@/lib/sw-register'

// First, before the router reads the location and before anything can be
// fetched with this page as its referrer. The daemon has already redeemed the
// handoff token and moved the session token into an HttpOnly cookie, so what
// is left in the URL is a spent secret — but it is still a secret-shaped
// string in the address bar, in the history entry, and in any referrer.
const cleaned = stripHandoff(location.href)
if (cleaned !== location.href) history.replaceState(null, '', cleaned)

const router = createFlueRouter()

const root = document.getElementById('root')
if (!root) throw new Error('missing #root')

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
