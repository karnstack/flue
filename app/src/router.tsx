import { createRouter } from '@tanstack/react-router'
import { getGlobalStartContext } from '@tanstack/react-start'
import { routeTree } from './routeTree.gen'
import { CSP_NONCE_KEY, type CspNonceContext } from './lib/csp'

export function getRouter() {
  return createRouter({
    routeTree,
    defaultPreload: 'intent',
    scrollRestoration: true,
    // The one inline script this app serves is Start's own stream barrier, and
    // `script-src 'self'` does not admit an inline script. Start stamps this
    // value onto that tag, the request middleware that minted it puts the same
    // value in the header, and hydration survives a policy that would otherwise
    // kill it silently — see lib/csp.ts and server/security-headers.ts.
    ssr: { nonce: cspNonce() },
  })
}

/**
 * This response's CSP nonce, or undefined where there is no response.
 *
 * Undefined is the normal answer in the browser: this module is isomorphic, the
 * client builds its own router at hydration, and `getGlobalStartContext` is
 * defined as returning nothing there. It is also the answer if this is ever
 * reached before the global middlewares have run, which that function reports
 * by throwing — a router with no nonce renders a page whose inline script is
 * refused, which is bad, but a router that throws renders no page at all.
 *
 * The context is read through a narrow cast rather than through the inferred
 * middleware types on purpose. `Register` (routeTree.gen.ts) names both
 * `getRouter` and `startInstance`, so inferring the context here — inside
 * `getRouter` — would make the router's own type depend on itself.
 */
function cspNonce(): string | undefined {
  try {
    return (getGlobalStartContext() as CspNonceContext | undefined)?.[CSP_NONCE_KEY]
  } catch {
    return undefined
  }
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof getRouter>
  }
}
