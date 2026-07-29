/**
 * What the service worker is allowed to do with a request.
 *
 * This is a pure function of the request so that the policy — above all
 * "never the API, never the socket" — is testable without a worker, a build,
 * or a browser.
 */
export type SwStrategy = 'passthrough' | 'network-first' | 'cache-first'

/** The parts of a `Request` the policy looks at. `Request` itself satisfies it. */
export interface SwRequestLike {
  method: string
  mode: string
  url: string
}

/**
 * The cache key the navigation fallback is stored under.
 *
 * Deliberately the bare root rather than the request's own URL: a first-load
 * navigation is `/?h=<one-time handoff token>`, and using that as a key would
 * write a spent secret into CacheStorage, which is readable by any script on
 * the origin. Every navigation resolves to the same shell document anyway.
 */
export const SHELL_URL = '/'

/** Where Vite emits hash-stamped build output; the only immutable URLs here. */
export const ASSET_PREFIX = '/assets/'

/**
 * Paths the service worker must never answer from, or write to, a cache.
 *
 * `/api/*` is live daemon state — a cached session list names PTYs that no
 * longer exist, which is worse than an error the UI can explain. `/ws` is the
 * terminal itself; a service worker cannot intercept the WebSocket handshake
 * anyway, but naming it here keeps a stray `fetch('/ws')` out of the cache and
 * states the rule where someone adding a strategy will read it.
 */
const NEVER_CACHED = ['/api', '/ws']

export function chooseStrategy(request: SwRequestLike, origin: string): SwStrategy {
  // Only GET is cacheable, and the daemon 405s everything but GET, HEAD and
  // the CLI's POST /api/handoff before its mux. HEAD included: answering one
  // from a cached body would be a lie about the network.
  if (request.method !== 'GET') return 'passthrough'

  let url: URL
  try {
    url = new URL(request.url)
  } catch {
    return 'passthrough'
  }
  if (url.origin !== origin) return 'passthrough'

  // Before the navigate check, not after: typing /api/sessions into the
  // address bar produces a navigation, and treating it as the app shell would
  // cache the API under exactly the rule that exists to hold the shell.
  for (const prefix of NEVER_CACHED) {
    if (url.pathname === prefix || url.pathname.startsWith(`${prefix}/`)) return 'passthrough'
  }

  // Network-first, never cache-first: the shell document names hash-stamped
  // bundles, so a stale shell asks the daemon for files it no longer has. The
  // cache is the offline fallback, not the fast path.
  if (request.mode === 'navigate') return 'network-first'

  // Content-hashed filenames, so a hit can never be stale.
  if (url.pathname.startsWith(ASSET_PREFIX)) return 'cache-first'

  // Icons, the manifest, the favicon, the worker script itself. Pleasant to
  // have offline, but none of them is what makes the UI load, and every extra
  // rule is another way to serve something stale.
  return 'passthrough'
}
