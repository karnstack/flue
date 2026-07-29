import { describe, expect, it } from 'vitest'
import { chooseStrategy, SHELL_URL, type SwRequestLike } from './sw-strategy'

const ORIGIN = 'http://127.0.0.1:7717'

function req(url: string, extra: Partial<SwRequestLike> = {}): SwRequestLike {
  return { method: 'GET', mode: 'no-cors', url: new URL(url, ORIGIN).toString(), ...extra }
}

describe('chooseStrategy', () => {
  it('never handles the JSON API or the WebSocket path', () => {
    // The whole point of this service worker is to hold the app shell. A
    // cache in front of /api/sessions would answer with a session list that
    // no longer exists, which is worse than no answer at all.
    //
    // Note what this does and does not prove today: the fallthrough is also
    // passthrough, so deleting the explicit API rule right now would leave
    // these particular cases green. They are a regression guard against a
    // later, broader rule — "cache every same-origin GET" is the obvious one
    // — and the case below is the one that fails immediately if the explicit
    // rule goes away.
    expect(chooseStrategy(req('/api/sessions'), ORIGIN)).toBe('passthrough')
    expect(chooseStrategy(req('/api'), ORIGIN)).toBe('passthrough')
    expect(chooseStrategy(req('/api/handoff'), ORIGIN)).toBe('passthrough')
    expect(chooseStrategy(req('/ws'), ORIGIN)).toBe('passthrough')
    expect(chooseStrategy(req('/ws/anything'), ORIGIN)).toBe('passthrough')
  })

  it('never handles the API even when it is typed into the address bar', () => {
    // The discriminating case, and the reason the API rule sits above the
    // navigation rule rather than below it: a typed URL produces a navigation,
    // and the other order would cache /api/sessions as if it were the shell.
    expect(chooseStrategy(req('/api/sessions', { mode: 'navigate' }), ORIGIN)).toBe('passthrough')
    expect(chooseStrategy(req('/ws', { mode: 'navigate' }), ORIGIN)).toBe('passthrough')
  })

  it('never handles a non-GET request', () => {
    expect(chooseStrategy(req('/', { method: 'POST', mode: 'navigate' }), ORIGIN)).toBe(
      'passthrough',
    )
    expect(chooseStrategy(req('/assets/app-abc123.js', { method: 'HEAD' }), ORIGIN)).toBe(
      'passthrough',
    )
  })

  it('never handles a cross-origin request', () => {
    expect(chooseStrategy(req('http://example.com/assets/app-abc123.js'), ORIGIN)).toBe(
      'passthrough',
    )
    // Same host, different port: a different origin, and flue is not it.
    expect(chooseStrategy(req('http://127.0.0.1:3000/'), ORIGIN)).toBe('passthrough')
  })

  it('serves navigations network-first', () => {
    // Network-first, not cache-first: the shell HTML names hash-stamped asset
    // files, so a stale shell asks for bundles the daemon no longer has.
    expect(chooseStrategy(req('/', { mode: 'navigate' }), ORIGIN)).toBe('network-first')
    expect(chooseStrategy(req('/sessions', { mode: 'navigate' }), ORIGIN)).toBe('network-first')
    expect(chooseStrategy(req('/d/local/s/abc123', { mode: 'navigate' }), ORIGIN)).toBe(
      'network-first',
    )
  })

  it('serves the handoff navigation network-first too', () => {
    // The daemon has to see this request: it is what redeems the token.
    expect(chooseStrategy(req('/?h=secret', { mode: 'navigate' }), ORIGIN)).toBe('network-first')
  })

  it('serves hashed build assets cache-first', () => {
    expect(chooseStrategy(req('/assets/index-abc123.js'), ORIGIN)).toBe('cache-first')
    expect(chooseStrategy(req('/assets/index-abc123.css'), ORIGIN)).toBe('cache-first')
  })

  it('leaves everything else to the network', () => {
    // Icons, the manifest, the favicon: nice to have offline, but caching
    // them buys nothing the shell needs and every extra rule is another way
    // to serve something stale.
    expect(chooseStrategy(req('/favicon.svg'), ORIGIN)).toBe('passthrough')
    expect(chooseStrategy(req('/manifest.webmanifest'), ORIGIN)).toBe('passthrough')
    expect(chooseStrategy(req('/sw.js'), ORIGIN)).toBe('passthrough')
  })

  it('points the navigation fallback at the origin root', () => {
    // Not the request URL: a first-load navigation is /?h=<one-time token>,
    // and using it as a cache key would persist a spent secret in
    // CacheStorage, which any script on the origin can read.
    expect(SHELL_URL).toBe('/')
  })
})
