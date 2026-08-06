// The security headers on this origin's responses.
//
// Asserted off the wire, through `SELF.fetch` against the built Worker, because
// the mechanism is easy to get wrong in a way that looks right. A `_headers`
// document among the client assets would deploy cleanly, apply to the built JS
// and CSS, and apply to *none* of the responses that matter — the SSR HTML that
// carries the session, the server functions, the relay-token endpoint. Only a
// request middleware covers those, and only a request the Worker really handles
// proves it does.
//
// Why this origin needs any of it: it mints relay channel tokens and holds the
// session cookie, so a script running here is an account. It had none of these
// headers while the relay origin — which can read nothing, every byte through
// it being inside a Noise channel — had all three.
import { SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'

const BASE = 'https://app.flue.sh'

/** The directives, split, so one can be named in a failure. */
function directives(res: Response): Map<string, string> {
  const header = res.headers.get('Content-Security-Policy')
  expect(header).not.toBeNull()
  return new Map(
    header!.split('; ').map((d) => {
      const at = d.indexOf(' ')
      return at === -1 ? [d, ''] : [d.slice(0, at), d.slice(at + 1)]
    }),
  )
}

describe('the control plane serves security headers', () => {
  it('puts a policy on a page response', async () => {
    const res = await SELF.fetch(`${BASE}/`)
    expect(res.status).toBe(200)

    const csp = directives(res)
    expect(csp.get('default-src')).toBe("'self'")
    expect(csp.get('style-src')).toBe("'self' 'unsafe-inline'")
    // Clickjacking, an injected <base> re-pointing every relative script URL,
    // and a form posting somewhere else. All three are cheap and none of them
    // was closed.
    expect(csp.get('frame-ancestors')).toBe("'none'")
    expect(csp.get('base-uri')).toBe("'none'")
    expect(csp.get('object-src')).toBe("'none'")
    expect(csp.get('form-action')).toBe("'self'")

    expect(res.headers.get('Referrer-Policy')).toBe('no-referrer')
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff')
  })

  it('never allows inline script', async () => {
    // The directive this whole file exists for. `'unsafe-inline'` here would
    // make an injected <script> on the origin that holds the session cookie
    // executable, which is account takeover — and it is the tempting fix for
    // the hydration failure the next test describes.
    const csp = directives(await SELF.fetch(`${BASE}/`))
    expect(csp.get('script-src')).not.toContain("'unsafe-inline'")
    expect(csp.get('script-src')).toContain("'self'")
  })

  it('admits the one inline script Start emits, by nonce', async () => {
    // Without this the app would be broken rather than protected: Start's SSR
    // writes one inline script — the stream barrier carrying the router
    // manifest — and `script-src 'self'` refuses an inline script. The page
    // would render, hydration would never run, every button would be dead, and
    // nothing on screen would say why. Hashing it is not an option; it carries
    // a timestamp.
    const res = await SELF.fetch(`${BASE}/`)
    const html = await res.text()

    const nonce = /'nonce-([A-Za-z0-9+/=]+)'/.exec(directives(res).get('script-src') ?? '')?.[1]
    expect(nonce).toBeDefined()

    // Every script tag in the document, and each one either carries this
    // response's nonce or is loaded from this origin. A tag that has neither is
    // a tag the browser will refuse.
    const scripts = [...html.matchAll(/<script\b([^>]*)>/g)].map(([, attrs]) => attrs ?? '')
    expect(scripts.length).toBeGreaterThan(0)
    for (const attrs of scripts) {
      expect(attrs.includes(`nonce="${nonce}"`) || /\bsrc="\//.test(attrs)).toBe(true)
    }
  })

  it('mints a fresh nonce per response', async () => {
    // A nonce reused across responses is `'unsafe-inline'` with extra steps:
    // an injected script only has to carry the value somebody else's page
    // already showed them.
    const first = directives(await SELF.fetch(`${BASE}/`)).get('script-src')
    const second = directives(await SELF.fetch(`${BASE}/`)).get('script-src')
    expect(first).not.toBe(second)
  })

  it('covers a route that is not the landing page', async () => {
    // /login is where the session begins. A middleware wired to one route
    // rather than to every request would pass the test above and miss this.
    const res = await SELF.fetch(`${BASE}/login`)
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'")
    expect(res.headers.get('Referrer-Policy')).toBe('no-referrer')
  })
})
