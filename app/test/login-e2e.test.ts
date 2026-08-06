// The login flow over a real HTTP request to the real built Worker.
//
// login.test.ts drives the handlers directly, which proves what they decide.
// This file proves the parts only a request can: that the CSRF middleware in
// start.ts is actually in front of the server functions, that a cookie set
// inside a server function survives Start's response assembly, and that the
// very next request is recognized as signed in. Task 4 left exactly this
// carried forward — its cookie tests ran through `requestHandler`, one layer
// below the wire.
//
// `SELF.fetch` here is the built Worker (vitest.config.ts points the pool at
// dist/server), so this needs `pnpm build` first — the Makefile's test-app
// target encodes that.
//
// The server functions are addressed by the URLs the build emitted, read out
// of the compiled resolver and passed in as TEST_SERVER_FN_URLS; the ids are
// content hashes no test could spell for itself.
import { SELF, env } from 'cloudflare:test'
import { eq } from 'drizzle-orm'
import { describe, expect, it, vi } from 'vitest'
import { db } from '../src/db/client'
import { invites, users } from '../src/db/schema'
import { issueLoginCode } from '../src/server/codes'
import { SESSION_COOKIE } from '../src/server/sessions'

const ORIGIN = 'https://app.flue.sh'

/** Bumped by every helper below, so no two requests in this file look alike. */
let seq = 0

const serverFnUrls = (env as unknown as { TEST_SERVER_FN_URLS: Record<string, string> })
  .TEST_SERVER_FN_URLS

function urlFor(name: string): string {
  const path = serverFnUrls[name]
  if (!path) {
    throw new Error(
      `no server function named ${name} in the build — did it get renamed, or was dist/ built from older source?`,
    )
  }
  return `${ORIGIN}${path}`
}

/**
 * POST to a server function the way the browser's RPC client does: a form body
 * (Start accepts `application/x-www-form-urlencoded`), the `x-tsr-serverFn`
 * marker that asks for a serialized result, and whatever CSRF signal the test
 * wants to present.
 */
function callServerFn(
  name: string,
  fields: Record<string, string>,
  opts: { fetchSite?: string | null; cookie?: string } = {},
): Promise<Response> {
  const headers = new Headers({
    'content-type': 'application/x-www-form-urlencoded',
    'x-tsr-serverFn': 'true',
    // A fresh caller per call. Without it every request in this file shares
    // the `unknown` IP bucket and the per-IP send cap would eventually make
    // adding a test to this file break an unrelated one. (On a deployment this
    // header is written by Cloudflare's edge, not by the client.)
    'cf-connecting-ip': `192.0.2.${++seq % 256}`,
  })
  const site = opts.fetchSite === undefined ? 'same-origin' : opts.fetchSite
  if (site !== null) headers.set('sec-fetch-site', site)
  if (opts.cookie) headers.set('cookie', opts.cookie)

  return SELF.fetch(urlFor(name), {
    method: 'POST',
    headers,
    body: new URLSearchParams(fields).toString(),
  })
}

/** The `__Host-session` value from a response, or null. */
function sessionCookie(res: Response): string | null {
  const header = res.headers.getSetCookie().find((c) => c.startsWith(`${SESSION_COOKIE}=`))
  if (!header) return null
  const value = header.slice(`${SESSION_COOKIE}=`.length).split(';')[0]
  return value ? decodeURIComponent(value) : null
}

const now = () => Math.floor(Date.now() / 1000)
function freshEmail(prefix: string): string {
  return `${prefix}-${++seq}-${crypto.randomUUID()}@example.com`
}

/**
 * Issue a real code for `email` and read the plaintext off the Sender seam.
 *
 * Run in this isolate rather than through the Worker: the same D1 backs both,
 * and the code only ever exists in the Sender's hands, which `SELF.fetch`
 * would put out of reach.
 */
async function codeFor(email: string): Promise<string> {
  const lines: string[] = []
  const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    if (typeof args[0] === 'string') lines.push(args[0])
  })
  try {
    await issueLoginCode(email)
  } finally {
    spy.mockRestore()
  }
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as { evt?: string; code?: string }
      if (parsed.evt === 'login_code' && parsed.code) return parsed.code
    } catch {
      // not the sender's line
    }
  }
  throw new Error('the sender was never handed a code')
}

describe('the login page', () => {
  it('is served to a plain document request', async () => {
    // Document requests carry no same-origin signal from an address bar, and
    // the CSRF middleware is filtered to server functions precisely so that
    // this keeps working.
    const res = await SELF.fetch(`${ORIGIN}/login`)
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('Sign in to flue')
  })
})

describe('CSRF', () => {
  it('refuses a cross-site POST to a server function', async () => {
    const res = await callServerFn(
      'requestCodeFn',
      { email: freshEmail('csrf') },
      { fetchSite: 'cross-site' },
    )
    expect(res.status).toBe(403)
  })

  it('refuses a POST that carries no origin signal at all', async () => {
    // No Sec-Fetch-Site, no Origin, no Referer: curl, or anything that wants
    // to look like a browser without being one.
    const res = await callServerFn('requestCodeFn', { email: freshEmail('bare') }, {
      fetchSite: null,
    })
    expect(res.status).toBe(403)
  })

  it('lets a same-origin POST through', async () => {
    const res = await callServerFn('requestCodeFn', { email: freshEmail('same-origin') })
    expect(res.status).toBe(200)
  })
})

describe('signing in over HTTP', () => {
  it('answers a stranger and a member with the same status', async () => {
    // The enumeration check at the level a stranger can actually observe.
    const member = freshEmail('member')
    await db().insert(users).values({ id: crypto.randomUUID(), email: member, createdAt: now() })

    const known = await callServerFn('requestCodeFn', { email: member })
    const unknown = await callServerFn('requestCodeFn', { email: freshEmail('nobody') })

    expect(known.status).toBe(unknown.status)
    expect(known.headers.get('content-type')).toBe(unknown.headers.get('content-type'))
    // Neither response sets a cookie: asking for a code is not a login.
    expect(sessionCookie(known)).toBeNull()
    expect(sessionCookie(unknown)).toBeNull()
  })

  it('sets a usable session cookie, and the next request is signed in', async () => {
    const invite = `inv-${crypto.randomUUID()}`
    const email = freshEmail('e2e')
    await db().insert(invites).values({ code: invite, email, createdAt: now() })

    const res = await callServerFn('submitCodeFn', { email, code: await codeFor(email) })
    expect(res.status).toBe(200)

    // The cookie came back through a real server-function response, with every
    // attribute the __Host- prefix requires — h3 merged it into the JSON
    // result's headers rather than dropping it.
    const header = res.headers.getSetCookie().find((c) => c.startsWith(`${SESSION_COOKIE}=`))
    expect(header).toBeDefined()
    expect(header).toContain('; Secure')
    expect(header).toContain('; Path=/')
    expect(header).toContain('; HttpOnly')

    // The account exists, and the invite paid for it.
    const [user] = await db().select().from(users).where(eq(users.email, email))
    expect(user).toBeDefined()
    const [row] = await db().select().from(invites).where(eq(invites.code, invite))
    expect(row?.redeemedBy).toBe(user?.id)

    // And the point of the whole exercise: hand that cookie back on the next
    // request and the server knows who it is. /login redirects a visitor who
    // is already signed in, so the redirect *is* the recognition.
    const token = sessionCookie(res)
    const signedIn = await SELF.fetch(`${ORIGIN}/login`, {
      headers: { cookie: `${SESSION_COOKIE}=${token}` },
      redirect: 'manual',
    })
    expect(signedIn.status).toBeGreaterThanOrEqual(300)
    expect(signedIn.status).toBeLessThan(400)
    expect(signedIn.headers.get('location')).toBe('/devices')

    // ...whereas a forged cookie is nobody, and gets the form.
    const forged = await SELF.fetch(`${ORIGIN}/login`, {
      headers: { cookie: `${SESSION_COOKIE}=${'A'.repeat(43)}` },
      redirect: 'manual',
    })
    expect(forged.status).toBe(200)
  })

  it('refuses a wrong code without creating anything', async () => {
    const invite = `inv-${crypto.randomUUID()}`
    const email = freshEmail('wrong')
    await db().insert(invites).values({ code: invite, email, createdAt: now() })
    await codeFor(email)

    const res = await callServerFn('submitCodeFn', { email, code: '00000000' })
    expect(res.status).toBe(200) // a refusal, not an error: no status code to read either
    expect(sessionCookie(res)).toBeNull()
    expect(await db().select().from(users).where(eq(users.email, email))).toEqual([])
  })
})
