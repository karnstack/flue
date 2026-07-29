import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Drives the worker's own event handlers.
 *
 * `sw-strategy.test.ts` covers which requests are touched; this covers what
 * happens to the ones that are — above all the cache *key*, which is the one
 * place a spent handoff token could be written to disk.
 *
 * The worker registers its listeners on `self` at module scope, so the test
 * stubs the worker globals and then imports it, capturing the listeners on
 * the way past.
 */

type Listener = (event: unknown) => void

interface Waitable {
  waitUntil(p: Promise<unknown>): void
}

class FakeCache {
  readonly store = new Map<string, Response>()

  private key(request: Request | string): string {
    return typeof request === 'string' ? request : request.url
  }

  match(request: Request | string): Promise<Response | undefined> {
    return Promise.resolve(this.store.get(this.key(request)))
  }

  put(request: Request | string, response: Response): Promise<void> {
    this.store.set(this.key(request), response)
    return Promise.resolve()
  }

  addAll(urls: string[]): Promise<void> {
    for (const url of urls) this.store.set(url, new Response(`body of ${url}`))
    return Promise.resolve()
  }
}

class FakeCacheStorage {
  readonly caches = new Map<string, FakeCache>()
  readonly deleted: string[] = []

  open(name: string): Promise<FakeCache> {
    let cache = this.caches.get(name)
    if (!cache) {
      cache = new FakeCache()
      this.caches.set(name, cache)
    }
    return Promise.resolve(cache)
  }

  keys(): Promise<string[]> {
    return Promise.resolve([...this.caches.keys()])
  }

  delete(name: string): Promise<boolean> {
    this.deleted.push(name)
    return Promise.resolve(this.caches.delete(name))
  }
}

const ORIGIN = 'http://localhost:3000'

let listeners: Map<string, Listener>
let cacheStorage: FakeCacheStorage
let fetchMock: ReturnType<typeof vi.fn>
let claim: ReturnType<typeof vi.fn>

async function loadWorker() {
  listeners = new Map()
  cacheStorage = new FakeCacheStorage()
  claim = vi.fn().mockResolvedValue(undefined)
  fetchMock = vi.fn()

  vi.stubGlobal('addEventListener', (type: string, listener: Listener) => {
    listeners.set(type, listener)
  })
  vi.stubGlobal('caches', cacheStorage)
  vi.stubGlobal('fetch', fetchMock)
  vi.stubGlobal('skipWaiting', vi.fn().mockResolvedValue(undefined))
  vi.stubGlobal('clients', { claim })

  vi.resetModules()
  await import('./sw')
}

/** Run a captured extendable-event listener and await whatever it queued. */
async function dispatch(type: 'install' | 'activate'): Promise<void> {
  const listener = listeners.get(type)
  expect(listener, `no ${type} listener registered`).toBeDefined()
  const queued: Promise<unknown>[] = []
  const event: Waitable = { waitUntil: (p) => void queued.push(p) }
  listener!(event)
  await Promise.all(queued)
}

/** Run the fetch listener; resolves to the Response it answered with, or null. */
async function dispatchFetch(request: Request): Promise<Response | null> {
  const listener = listeners.get('fetch')
  expect(listener).toBeDefined()
  let answered: Promise<Response> | Response | null = null
  listener!({ request, respondWith: (r: Promise<Response> | Response) => void (answered = r) })
  return answered === null ? null : await answered
}

/** The only cache the worker ever opens, whatever its version string is. */
function theCache(): FakeCache {
  const [only] = [...cacheStorage.caches.values()]
  expect(only, 'the worker opened no cache').toBeDefined()
  return only!
}

beforeEach(async () => {
  await loadWorker()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('install', () => {
  it('fills a versioned cache with the precache list', async () => {
    await dispatch('install')
    expect([...cacheStorage.caches.keys()][0]).toMatch(/^flue-shell-/)
    expect([...theCache().store.keys()]).toContain('/')
  })
})

describe('activate', () => {
  it('drops older flue caches and keeps foreign ones', async () => {
    await cacheStorage.open('flue-shell-old')
    await cacheStorage.open('something-else')
    await dispatch('activate')
    expect(cacheStorage.deleted).toContain('flue-shell-old')
    expect(cacheStorage.deleted).not.toContain('something-else')
    expect(claim).toHaveBeenCalled()
  })
})

describe('fetch', () => {
  it('does not answer for the API at all', async () => {
    // Not "answers from the network": leaving the event untouched is what
    // makes the request behave exactly as it would with no worker installed.
    const answered = await dispatchFetch(new Request(`${ORIGIN}/api/sessions`))
    expect(answered).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('caches a navigation under the origin root, never under its own URL', async () => {
    // The load-bearing assertion. A first-load navigation is
    // /?h=<one-time handoff token>; keying the cache on request.url would
    // write that spent secret into CacheStorage, which any script on the
    // origin can read back.
    await dispatch('install')
    fetchMock.mockResolvedValue(shellResponse())

    const request = new Request(`${ORIGIN}/?h=super-secret-handoff`)
    Object.defineProperty(request, 'mode', { value: 'navigate' })
    const answered = await dispatchFetch(request)

    // Without these two the assertion below would pass on a request the
    // worker never handled: '/' is in the cache from install either way.
    expect(answered).not.toBeNull()
    expect(fetchMock).toHaveBeenCalled()

    const keys = [...theCache().store.keys()]
    expect(keys).toContain('/')
    for (const key of keys) expect(key).not.toContain('super-secret-handoff')
  })

  it('falls back to the cached shell when the daemon is unreachable', async () => {
    await dispatch('install')
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'))

    const request = new Request(`${ORIGIN}/sessions`)
    Object.defineProperty(request, 'mode', { value: 'navigate' })
    const answered = await dispatchFetch(request)

    expect(answered).not.toBeNull()
    // The body install put in the cache under '/', not anything the failed
    // fetch produced.
    expect(await answered!.text()).toBe('body of /')
  })

  it('propagates the failure when there is no cached shell either', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'))
    const request = new Request(`${ORIGIN}/sessions`)
    Object.defineProperty(request, 'mode', { value: 'navigate' })
    await expect(dispatchFetch(request)).rejects.toThrow('Failed to fetch')
  })

  it('does not cache an unsuccessful shell response', async () => {
    // A 401 from an expired session is a real answer and is passed straight
    // through, but caching it would make the failure outlive its cause.
    // Same-origin and text/html, exactly like a good shell response: what
    // must keep this out of the cache is the status alone, not the response
    // filtering and not the content type.
    fetchMock.mockResolvedValue(typed('unauthorized', 'text/html; charset=utf-8', 401))
    const request = new Request(`${ORIGIN}/`)
    Object.defineProperty(request, 'mode', { value: 'navigate' })
    const answered = await dispatchFetch(request)

    expect(answered!.status).toBe(401)
    expect([...theCache().store.keys()]).not.toContain('/')
  })

  it.each([
    ['/favicon.svg', '<svg/>', 'image/svg+xml'],
    ['/manifest.webmanifest', '{"name":"flue"}', 'application/manifest+json'],
    ['/sw.js', 'self.addEventListener', 'text/javascript; charset=utf-8'],
    ['/assets/index-abc123.js', 'const a=1', 'text/javascript; charset=utf-8'],
  ])('does not let a navigation to %s overwrite the cached shell', async (path, body, type) => {
    // Typing any of these into the address bar is a navigation, so it takes
    // the shell path — but the daemon has a real file behind each one, so the
    // body is not the shell. Without the content-type guard the next load
    // with the daemon down would render an SVG, a JSON manifest, or the
    // worker's own source as the app.
    await dispatch('install')
    fetchMock.mockResolvedValue(typed(body, type))

    const request = new Request(`${ORIGIN}${path}`)
    Object.defineProperty(request, 'mode', { value: 'navigate' })
    const answered = await dispatchFetch(request)

    // The request really was handled and really did hit the network —
    // otherwise the cache assertion below would pass on a no-op.
    expect(answered).not.toBeNull()
    expect(fetchMock).toHaveBeenCalled()
    expect(await answered!.text()).toBe(body)

    // Still the body install put there, not this one.
    expect(await theCache().store.get('/')!.text()).toBe('body of /')
  })

  it('does not cache a navigation response that will not say what it is', async () => {
    // Fail closed. A 200 with no Content-Type at all is not evidence of a
    // shell, and treating "unknown" as "yes" is how the guard above quietly
    // stops guarding anything.
    await dispatch('install')
    fetchMock.mockResolvedValue(basic(new Response(null, { status: 200 })))

    const request = new Request(`${ORIGIN}/mystery`)
    Object.defineProperty(request, 'mode', { value: 'navigate' })
    const answered = await dispatchFetch(request)

    expect(answered).not.toBeNull()
    expect(fetchMock).toHaveBeenCalled()
    expect(await theCache().store.get('/')!.text()).toBe('body of /')
  })

  it('serves a hashed asset from the cache without touching the network', async () => {
    await dispatch('install')
    theCache().store.set(`${ORIGIN}/assets/index-abc123.js`, new Response('cached bundle'))

    const answered = await dispatchFetch(new Request(`${ORIGIN}/assets/index-abc123.js`))
    expect(await answered!.text()).toBe('cached bundle')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('does not cache an opaque asset response', async () => {
    // chooseStrategy already refuses cross-origin *requests*, but it cannot
    // see the response: a same-origin URL that redirected cross-origin comes
    // back opaque, with status 0 and a body nothing can read. Caching one
    // would wedge the app on a bundle that can never execute.
    await dispatch('install')
    const opaque = new Response(null, { status: 200 })
    Object.defineProperty(opaque, 'type', { value: 'opaque' })
    fetchMock.mockResolvedValue(opaque)

    const url = `${ORIGIN}/assets/index-ghi789.js`
    await dispatchFetch(new Request(url))
    expect([...theCache().store.keys()]).not.toContain(url)
  })

  it('fetches and stores a hashed asset it has never seen', async () => {
    await dispatch('install')
    fetchMock.mockResolvedValue(assetResponse('fresh bundle'))

    const url = `${ORIGIN}/assets/index-def456.js`
    const answered = await dispatchFetch(new Request(url))
    expect(await answered!.text()).toBe('fresh bundle')
    expect([...theCache().store.keys()]).toContain(url)
  })
})

/**
 * Mark a response as same-origin and unfiltered. `type` is readonly and
 * defaults to 'default' on a hand-constructed Response, but the worker
 * refuses to cache anything that is not 'basic'.
 */
function basic(response: Response): Response {
  Object.defineProperty(response, 'type', { value: 'basic' })
  return response
}

/**
 * A response of a stated type.
 *
 * The Content-Type has to be explicit: the Response constructor labels a
 * string body `text/plain`, so a fixture that left it out would be refused by
 * the shell's content-type guard and every "did it cache?" assertion would
 * pass for the wrong reason.
 */
function typed(body: string | null, contentType: string, status = 200): Response {
  return basic(new Response(body, { status, headers: { 'content-type': contentType } }))
}

function shellResponse(body = '<!doctype html><html></html>'): Response {
  return typed(body, 'text/html; charset=utf-8')
}

function assetResponse(body: string): Response {
  return typed(body, 'text/javascript; charset=utf-8')
}
