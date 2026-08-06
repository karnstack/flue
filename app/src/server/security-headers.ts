/*
 * The security headers every response this Worker writes carries.
 *
 * This origin mints relay channel tokens and holds the session cookie, so a
 * script running here is an account: it can read the device directory, mint a
 * token for any machine on it, and open a shell. It carried no security headers
 * at all — no CSP, no frame-ancestors, no Referrer-Policy — while the relay
 * origin, which can read nothing (every byte through it is inside a Noise
 * channel), carried all three. That is the wrong way round.
 *
 * # Why a request middleware and not a `_headers` file
 *
 * The app is a Worker with a static-assets directory (`assets.directory` in the
 * wrangler config the build generates). A `_headers` document applies to what
 * the *asset router* serves — the built JS and CSS — and to nothing the Worker
 * writes. Every response that matters here is a Worker response: the SSR HTML
 * that holds the session, every server function, the relay-token endpoint. So
 * the headers go on where all of them pass, which is Start's global request
 * middleware seam (src/start.ts, where CSRF is registered for the same reason).
 *
 * # Why the nonce is minted here
 *
 * Per response, from the CSPRNG, and handed *down* rather than read back: the
 * router has to have it while the HTML is being produced, so it is minted
 * before `next()` and put in the request context that src/router.tsx reads. A
 * nonce reused across responses, or derived from anything an attacker can see,
 * is `'unsafe-inline'` with extra steps. See lib/csp.ts for what it admits.
 */
import { createMiddleware } from '@tanstack/react-start'
import { CSP_NONCE_KEY, contentSecurityPolicy } from '@/lib/csp'

/**
 * 128 bits, base64.
 *
 * The CSP spec asks for at least 128 bits of entropy per response and says
 * nothing about the encoding; base64 keeps it short enough that the header cost
 * is nothing.
 */
function mintNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  return btoa(String.fromCharCode(...bytes))
}

/**
 * Mint, hand down, stamp the answer.
 *
 * Headers are set rather than merged: nothing else in this app writes any of
 * these three, and a route that started to would be a second policy this file
 * could not see.
 *
 * `Referrer-Policy: no-referrer` is safe alongside the CSRF middleware even
 * though that middleware can fall back to `Referer`: it reads `Sec-Fetch-Site`
 * first, and every browser that sends no `Referer` because of this header sends
 * that one.
 */
export const securityHeaders = createMiddleware({ type: 'request' }).server(async ({ next }) => {
  const nonce = mintNonce()
  const result = await next({ context: { [CSP_NONCE_KEY]: nonce } })

  result.response.headers.set('Content-Security-Policy', contentSecurityPolicy(nonce))
  result.response.headers.set('Referrer-Policy', 'no-referrer')
  result.response.headers.set('X-Content-Type-Options', 'nosniff')

  return result
})
