// The terms page, over a real HTTP request to the real built Worker.
//
// It is a static document, so there is not much to assert — but the two things
// asserted here are the reason the page exists at all. flue.sh relays a *shell*:
// the terms are where the service says what it will not be used for, that an
// account can be switched off without notice when it is, and where to write if
// somebody is on the receiving end of it. A page that is not reachable, or one
// nothing links to, is a policy nobody agreed to.
//
// `SELF.fetch` is the built Worker (vitest.config.ts points the pool at
// dist/server), so this needs `pnpm build` first.
import { SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'

const ORIGIN = 'https://app.flue.sh'

describe('/terms', () => {
  it('renders, and says the three things it has to say', async () => {
    const res = await SELF.fetch(`${ORIGIN}/terms`)
    expect(res.status).toBe(200)

    const html = await res.text()
    // Acceptable use — what the relay is for, and what it is not for.
    expect(html).toMatch(/acceptable use/i)
    // The kill switch, stated as a term rather than discovered as an outage.
    expect(html).toMatch(/disable/i)
    // Somewhere to report abuse. A dual-use service with no address to write to
    // is one that finds out from its host.
    expect(html).toContain('abuse@flue.sh')
  })

  it('is linked from the page where an account is created', async () => {
    // Signing in is the only way to get an account, so the sign-in screen is
    // where the terms have to be one click away.
    const res = await SELF.fetch(`${ORIGIN}/login`)
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('href="/terms"')
  })
})
