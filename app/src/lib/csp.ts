/*
 * The Content-Security-Policy this origin serves, and the one value in it that
 * changes per response.
 *
 * Here rather than beside the middleware that sets it (server/security-headers
 * .ts) because two modules need part of it and only one of them is server-side:
 * the middleware mints the nonce and writes the header, and src/router.tsx
 * hands the same nonce to Start's SSR so the inline script it emits carries it.
 * A `server/` import from the router would drag a request-middleware definition
 * into the client bundle for the sake of one string constant.
 *
 * Why this origin needs a policy at all is in server/security-headers.ts: it
 * mints relay channel tokens and holds the session cookie, so a script running
 * here is an account.
 */

/**
 * The key the nonce travels under, in the request context Start assigns from
 * every global middleware's `next({ context })`.
 *
 * A constant rather than a literal in two files, because a typo in one of them
 * is a policy that names a nonce no script carries — which is a blank page with
 * a console error, not a type error.
 */
export const CSP_NONCE_KEY = 'cspNonce'

/** What a request context carrying the nonce looks like, to whoever reads it. */
export interface CspNonceContext {
  [CSP_NONCE_KEY]?: string
}

/**
 * The policy, with this response's nonce in it.
 *
 * Written as a list rather than one string so a directive can be read, and so
 * the ones that are easiest to get wrong sit next to their reasons:
 *
 *   - `script-src 'self' 'nonce-…'`. The nonce is not decoration: Start's SSR
 *     emits exactly one inline script — the stream barrier that carries the
 *     router manifest and starts hydration — and `'self'` does not admit an
 *     inline script. Without the nonce the page renders, every button is dead,
 *     and nothing on screen says why. It cannot be hashed instead: the script
 *     carries a timestamp, so it differs per response.
 *   - `style-src` keeps `'unsafe-inline'`, and that is a concession rather than
 *     an oversight. Radix's dialogs mount `react-remove-scroll`, which injects
 *     a `<style>` element to lock the page behind a modal, and `'self'` would
 *     refuse it — the scroll lock would quietly stop working. Inline *style* is
 *     a far smaller weapon than inline *script*, and script is where the
 *     account takeover lives.
 *   - `frame-ancestors 'none'` is the clickjacking control, and the modern
 *     spelling of `X-Frame-Options: DENY`. Nothing here is meant to be
 *     embedded, and a framed device directory with a "revoke" button under an
 *     invisible overlay is exactly the shape that attack takes.
 *   - `base-uri 'none'` stops an injected `<base>` from re-pointing every
 *     relative script URL at another origin, which is the standard way around
 *     a `script-src 'self'` policy.
 *   - `form-action 'self'` bounds where a form may POST. Every form here is a
 *     React handler that never submits natively, so this costs nothing and
 *     closes the injected-form case.
 *
 * `default-src 'self'` covers the rest — images, fonts, media, `connect-src`.
 * There is no external font, no CDN and no analytics on this origin, and the
 * one cross-origin request in this deployment runs the other way: the relay tab
 * fetches *this* origin for a channel token (docs/SAAS.md).
 */
export function contentSecurityPolicy(nonce: string): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}'`,
    "style-src 'self' 'unsafe-inline'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "object-src 'none'",
    "form-action 'self'",
  ].join('; ')
}
