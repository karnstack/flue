// Global middleware seam: the two rules that apply to every request, and
// nothing else.
//
// The auth guard is *not* here: `requireUser` (server/auth.ts) is function
// middleware that each protected server fn composes with
// `.middleware([requireUser])`. Request middleware runs on every request the
// Worker sees — documents, assets, the login page itself — so a global guard
// would need a growing list of exceptions, and an exception list is how a route
// ends up unprotected by accident. CSRF and the security headers are global
// because they are the opposite kind of rule: they apply to everything, with
// nothing to exempt.
import { createStart, createCsrfMiddleware } from '@tanstack/react-start'
import { securityHeaders } from './server/security-headers'

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

// `securityHeaders` first, so it wraps CSRF's own 403 as well as everything
// downstream of it: a refusal is still a response a browser renders, and a
// response with no CSP is a response with no CSP.
export const startInstance = createStart(() => ({
  requestMiddleware: [securityHeaders, csrf],
}))
