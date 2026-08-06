// The enrolment page and its one mutation, over a real HTTP request to the
// real built Worker.
//
// enroll.test.ts drives the handlers directly, which proves what they decide.
// This file proves the part only a request can: that the guard is actually in
// *front* of the mutation. `confirmDeviceAuth` checks the session itself, but
// the route composes `requireUser` middleware as well, and middleware that was
// never wired up is indistinguishable from middleware that was — until someone
// removes the check inside the handler.
//
// `SELF.fetch` is the built Worker (vitest.config.ts points the pool at
// dist/server), so this needs `pnpm build` first. Server functions are
// addressed by the URLs the build emitted (TEST_SERVER_FN_URLS); their ids are
// content hashes no test could spell for itself.
import { SELF, env } from 'cloudflare:test'
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { db } from '../src/db/client'
import { deviceAuth, devices, rateLimits, users } from '../src/db/schema'
import { sha256Hex } from '../src/lib/tokens'
import { startDeviceAuth } from '../src/server/enroll'
import { SESSION_COOKIE, createSession } from '../src/server/sessions'
import { inRequest } from './request'

const ORIGIN = 'https://app.flue.sh'

/** Bumped by every helper below, so no two callers in this file share a bucket. */
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

/** POST to a server function the way the browser's RPC client does. */
function callServerFn(
  name: string,
  fields: Record<string, string>,
  opts: { cookie?: string } = {},
): Promise<Response> {
  const headers = new Headers({
    'content-type': 'application/x-www-form-urlencoded',
    'x-tsr-serverFn': 'true',
    // The CSRF middleware in start.ts refuses a POST with no origin signal.
    'sec-fetch-site': 'same-origin',
    'cf-connecting-ip': `203.0.113.${++seq % 256}`,
  })
  if (opts.cookie) headers.set('cookie', opts.cookie)

  return SELF.fetch(urlFor(name), {
    method: 'POST',
    headers,
    body: new URLSearchParams(fields).toString(),
    redirect: 'manual',
  })
}

const now = () => Math.floor(Date.now() / 1000)
const freshIp = () => `203.0.113.${++seq % 256}`

function freshKey(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

async function makeUser(): Promise<{ id: string; email: string }> {
  const user = { id: crypto.randomUUID(), email: `e2e-${++seq}-${crypto.randomUUID()}@example.com` }
  await db().insert(users).values({ ...user, createdAt: now() })
  return user
}

/** Sign `userId` in and hand back the Cookie header a browser would send. */
async function signIn(userId: string): Promise<string> {
  const { setCookie } = await inRequest(() => createSession(userId), { ip: freshIp() })
  const header = setCookie.find((c) => c.startsWith(`${SESSION_COOKIE}=`))
  if (!header) throw new Error('createSession set no session cookie')
  const value = header.slice(`${SESSION_COOKIE}=`.length).split(';')[0]
  return `${SESSION_COOKIE}=${value}`
}

/** A grant, opened the way the daemon opens one. */
async function start() {
  const { value } = await inRequest(
    () => startDeviceAuth({ label: 'e2e daemon', publicKey: freshKey() }),
    { ip: freshIp() },
  )
  return value
}

/** The grant row behind a formatted user code. */
async function grantRow(userCode: string) {
  const [row] = await db()
    .select()
    .from(deviceAuth)
    .where(eq(deviceAuth.userCode, userCode.replace('-', '')))
  return row
}

describe('the enrolment page', () => {
  it('sends a signed-out visitor to sign in', async () => {
    const res = await SELF.fetch(`${ORIGIN}/enroll`, { redirect: 'manual' })
    expect(res.status).toBeGreaterThanOrEqual(300)
    expect(res.status).toBeLessThan(400)
    expect(res.headers.get('location')).toBe('/login')
  })

  it('renders the form for someone signed in', async () => {
    const user = await makeUser()
    const res = await SELF.fetch(`${ORIGIN}/enroll`, {
      headers: { cookie: await signIn(user.id) },
    })
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('Connect a machine')
  })

  it('does not approve anything just by being visited with a code in the URL', async () => {
    // `verificationUrlComplete` puts the code in the query string so the field
    // arrives filled in. If following that link approved the grant, the link
    // itself would be the credential — and it is printed to a terminal, pasted
    // into chat windows and read by whoever is looking at the screen.
    const user = await makeUser()
    const grant = await start()

    const res = await SELF.fetch(
      `${ORIGIN}/enroll?code=${encodeURIComponent(grant.userCode)}`,
      { headers: { cookie: await signIn(user.id) } },
    )
    expect(res.status).toBe(200)

    expect((await grantRow(grant.userCode))?.approvedUserId).toBeNull()
  })
})

describe('confirming over HTTP', () => {
  it('refuses a caller with no session, and approves nothing', async () => {
    const grant = await start()

    const res = await callServerFn('confirmDeviceAuthFn', { userCode: grant.userCode })

    // `requireUser` throws a redirect to /login. Start serializes that for the
    // RPC client rather than answering 3xx — the transport is 200, the payload
    // is the navigation — so the Location header and the body are what say the
    // guard fired, not the status.
    expect(res.headers.get('location')).toBe('/login')
    expect(await res.text()).toContain('isSerializedRedirect')

    // And the row is untouched, which is the part that matters: an
    // unauthenticated caller approves nothing.
    const row = await grantRow(grant.userCode)
    expect(row?.approvedUserId).toBeNull()
    expect(row?.deviceId).toBeNull()
  })

  it('refuses a forged session cookie', async () => {
    const grant = await start()

    const res = await callServerFn(
      'confirmDeviceAuthFn',
      { userCode: grant.userCode },
      { cookie: `${SESSION_COOKIE}=${'A'.repeat(43)}` },
    )

    expect(res.headers.get('location')).toBe('/login')
    expect((await grantRow(grant.userCode))?.approvedUserId).toBeNull()
  })

  it('binds the grant to the account whose cookie it carried', async () => {
    const user = await makeUser()
    const grant = await start()

    const res = await callServerFn(
      'confirmDeviceAuthFn',
      { userCode: grant.userCode },
      { cookie: await signIn(user.id) },
    )
    expect(res.status).toBe(200)

    const row = await grantRow(grant.userCode)
    expect(row?.approvedUserId).toBe(user.id)
    expect(row?.deviceId).toMatch(/^[0-9a-f]{12}$/)

    // Still no device: it is minted by the approving poll, in the same batch
    // that burns the grant.
    expect(await db().select().from(devices).where(eq(devices.id, row?.deviceId ?? ''))).toEqual([])
  })

  it('does no work for an oversized code', async () => {
    // The validator turns anything past 64 characters into '', which
    // `confirmDeviceAuth` refuses before it queries or counts anything.
    // Without the bound, an unbounded string becomes a bound parameter in a D1
    // lookup, for free, on every request someone cares to send.
    const user = await makeUser()
    const res = await callServerFn(
      'confirmDeviceAuthFn',
      { userCode: 'B'.repeat(5000) },
      { cookie: await signIn(user.id) },
    )

    // An ordinary refusal, not a redirect and not an error.
    expect(res.status).toBe(200)
    expect(await res.text()).not.toContain('isSerializedRedirect')

    // The proof that it was free: the guess counter was never touched. A code
    // that reached the lookup would have spent one of this user's attempts.
    const key = await sha256Hex(`device-confirm:user:${user.id}`)
    expect(await db().select().from(rateLimits).where(eq(rateLimits.key, key))).toEqual([])
  })
})
