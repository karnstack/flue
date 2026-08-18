/**
 * flue's app-shell service worker.
 *
 * # What it is for
 *
 * Holding the app shell so the UI still loads when the daemon is unreachable
 * — the difference between a blank tab and a page that can say what went
 * wrong. It is not an offline mode: there is nothing to do in flue without a
 * daemon, because the terminal *is* a live WebSocket.
 *
 * # What it deliberately does not do
 *
 * It never caches `/api/*` and never touches `/ws`. A stale-while-revalidate
 * cache over `/api/sessions` would answer with PTYs that exited minutes ago,
 * which is worse than an honest failure. That is also why this file is
 * hand-written rather than generated: a PWA plugin's default strategy is a
 * strategy nobody here chose. The policy itself lives in `lib/sw-strategy.ts`
 * so it can be tested without a browser.
 *
 * # Types
 *
 * `lib.dom` and `lib.webworker` cannot both be in one TypeScript program, and
 * the rest of the app needs the DOM. Rather than split the build into two
 * `tsc` invocations for one 60-line file, the handful of worker globals this
 * uses are declared here. `caches`, `fetch`, `Request` and `Response` are
 * identical in both libs and come from `lib.dom` as usual.
 */
import { chooseStrategy, SHELL_URL } from './lib/sw-strategy'

interface ExtendableEventLike extends Event {
  waitUntil(f: Promise<unknown>): void
}

interface FetchEventLike extends Event {
  readonly request: Request
  respondWith(r: Response | Promise<Response>): void
}

interface ServiceWorkerGlobal {
  readonly location: Location
  readonly clients: { claim(): Promise<void> }
  skipWaiting(): Promise<void>
  addEventListener(type: 'install' | 'activate', listener: (e: ExtendableEventLike) => void): void
  addEventListener(type: 'fetch', listener: (e: FetchEventLike) => void): void
}

const sw = self as unknown as ServiceWorkerGlobal

interface SwBuild {
  /** Derived from the emitted filenames, so it changes iff the build does. */
  version: string
  /** URLs to fill the cache with at install time. */
  precache: string[]
}

/**
 * Injected as a `var` declaration prepended to this chunk by the `fluePwa`
 * plugin in vite.config.ts, which is the first moment the hash-stamped asset
 * filenames exist. `sw.build.test.ts` asserts on the emitted file, because a
 * silently skipped injection would leave a worker that caches nothing while
 * every unit test stayed green.
 */
declare const __FLUE_BUILD__: SwBuild | undefined

const BUILD: SwBuild =
  typeof __FLUE_BUILD__ === 'undefined' ? { version: 'dev', precache: [SHELL_URL] } : __FLUE_BUILD__

const CACHE_PREFIX = 'flue-shell-'
const CACHE_NAME = `${CACHE_PREFIX}${BUILD.version}`

sw.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME)
      await cache.addAll(BUILD.precache)
      // Take over immediately. flue ships as a single binary, so a new worker
      // only ever appears because the user upgraded flue and reloaded; making
      // them reload twice to pick it up buys nothing. The lazy chunks the
      // bundle does have (xterm's webgl addon, the QR engine) are precached
      // beside the shell and purged with it on activate, so a claimed page
      // from the old build that asks for one gets a soft failure — the
      // canvas renderer, the paste box — rather than a broken screen.
      await sw.skipWaiting()
    })(),
  )
})

sw.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys()
      await Promise.all(
        names
          .filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME)
          .map((name) => caches.delete(name)),
      )
      await sw.clients.claim()
    })(),
  )
})

sw.addEventListener('fetch', (event) => {
  const strategy = chooseStrategy(event.request, sw.location.origin)
  // No respondWith at all, rather than a respondWith that calls fetch: leaving
  // the event untouched hands the request straight back to the browser, which
  // is the only way a WebSocket upgrade or a streamed response is guaranteed
  // to behave exactly as it would with no worker installed.
  if (strategy === 'passthrough') return
  if (strategy === 'cache-first') {
    event.respondWith(cacheFirst(event.request))
    return
  }
  event.respondWith(networkFirst(event.request))
})

/** Hash-stamped build output: a hit can never be stale, so never revalidate. */
async function cacheFirst(request: Request): Promise<Response> {
  const cache = await caches.open(CACHE_NAME)
  const hit = await cache.match(request)
  if (hit) return hit

  const response = await fetch(request)
  // `basic` is a same-origin, unfiltered response. An opaque one has a status
  // of 0 and a body nothing can read, and caching it would poison the entry.
  // What may be cached at all is chooseStrategy's decision alone — a second,
  // differently-worded check here could only ever disagree with it.
  if (response.ok && response.type === 'basic') {
    await cache.put(request, response.clone())
  }
  return response
}

/**
 * Whether a response really is the app document.
 *
 * "This request is a navigation" is a good proxy for "the answer will be the
 * shell" only because the daemon serves the shell for every path it does not
 * have a file at. Typing `/favicon.svg`, `/manifest.webmanifest` or `/sw.js`
 * into the address bar is *also* a navigation, and each of those has a real
 * file behind it — so without this check the next load with the daemon down
 * would render an SVG, or the worker's own source, as the app.
 *
 * Asking the response what it is beats predicting it from the path: a list of
 * static prefixes would have to be kept in step with public/ and with whatever
 * the build emits, and would drift silently the first time it was not. A
 * missing Content-Type fails closed.
 */
function isShellDocument(response: Response): boolean {
  return response.headers.get('content-type')?.includes('text/html') ?? false
}

/**
 * Navigations: the daemon answers if it can, and the cached shell answers if
 * it cannot.
 *
 * The response is stored under SHELL_URL, never under the request URL. Every
 * route resolves to the same shell document, and a first-load navigation is
 * `/?h=<one-time handoff token>` — using it as a key would leave a spent
 * secret in CacheStorage for any script on the origin to read.
 */
async function networkFirst(request: Request): Promise<Response> {
  const cache = await caches.open(CACHE_NAME)
  try {
    const response = await fetch(request)
    // Only a successful shell is worth keeping. A 401 from an expired session
    // is a real answer and is passed straight through, but caching it would
    // make the failure outlive its cause.
    if (response.ok && response.type === 'basic' && isShellDocument(response)) {
      await cache.put(SHELL_URL, response.clone())
    }
    return response
  } catch (err) {
    const cached = await cache.match(SHELL_URL)
    if (cached) return cached
    throw err
  }
}
