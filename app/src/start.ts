// Global middleware seam, and deliberately CSRF-only.
//
// The auth guard is *not* here: `requireUser` (server/auth.ts) is function
// middleware that each protected server fn composes with
// `.middleware([requireUser])`. Request middleware runs on every request the
// Worker sees — documents, assets, the login page itself — so a global guard
// would need a growing list of exceptions, and an exception list is how a route
// ends up unprotected by accident. CSRF is global because it is the opposite
// kind of rule: it applies to every same-origin RPC, with nothing to exempt.
import { createStart, createCsrfMiddleware } from '@tanstack/react-start'

// The filter is the shape Start itself recommends (it prints exactly this in
// its missing-CSRF warning): validate server-function RPCs, the same-origin
// endpoints CSRF actually defends. A bare createCsrfMiddleware() would also
// 403 document requests that carry no same-origin signal — address-bar
// navigations (Sec-Fetch-Site: none), curl, uptime checks, SELF.fetch in the
// vitest workers pool — because absent Sec-Fetch-Site/Origin/Referer headers
// fail its default check.
const csrf = createCsrfMiddleware({
  filter: (ctx) => ctx.handlerType === 'serverFn',
})

export const startInstance = createStart(() => ({
  requestMiddleware: [csrf],
}))
