// Global middleware seam. CSRF-only for now; the auth middleware joins
// requestMiddleware in a later task.
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
