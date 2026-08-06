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
import { GRANTS_PER_IP, startDeviceAuth } from '../src/server/enroll'
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

/**
 * POST the way the *daemon* will: no cookie, no `Sec-Fetch-Site`, just an
 * `Origin`, and the fields form-encoded.
 *
 * Both of those are load-bearing, and both are things a Go client gets wrong by
 * default.
 *
 * `Origin` is not decoration: start.ts validates CSRF on every server-fn RPC
 * and refuses a POST carrying no origin signal at all, so a client that sends
 * none gets 403 — which is what a naive `http.Post` does. Saying which origin
 * it is talking to is what a non-browser client offers instead, and it costs
 * nothing: CSRF exists to stop a *browser* being made to speak with its user's
 * ambient credential, and these two endpoints have no ambient credential to
 * borrow.
 *
 * `application/x-www-form-urlencoded` is not decoration either, and it is the
 * quieter trap. Start reads a form-encoded or multipart body as `FormData` and
 * hands it straight to the validator; any other body goes through seroval's
 * `fromJSON`, which wants seroval's own node shape and not a plain object. So
 * `json.Marshal` + `Content-Type: application/json` does not arrive as
 * `{label, publicKey}` — it arrives as nothing, and the answer is a 400 that
 * looks like a validation bug. Every daemon-shaped call in this file therefore
 * sends `URLSearchParams`, which is the encoding Task 11 has to send too.
 */
function callAsDaemon(
  name: string,
  fields: Record<string, string>,
  opts: { ip?: string } = {},
): Promise<Response> {
  return SELF.fetch(urlFor(name), {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'x-tsr-serverFn': 'true',
      origin: ORIGIN,
      'cf-connecting-ip': opts.ip ?? `203.0.113.${++seq % 256}`,
    },
    body: new URLSearchParams(fields).toString(),
    redirect: 'manual',
  })
}

/** The JSON a server function answers with. */
async function payload(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text()
  try {
    return JSON.parse(text) as Record<string, unknown>
  } catch {
    throw new Error(`server fn answered with something that is not JSON: ${text.slice(0, 200)}`)
  }
}

/**
 * Run `fn` with `device_auth` renamed out from under the running Worker, so the
 * next statement against it fails the way a real outage does.
 *
 * A genuine `D1_ERROR: no such table: device_auth: SQLITE_ERROR` raised from
 * inside the handler is the only honest way to test the "something broke that
 * nobody wrote an error for" path — a stubbed throw would prove the wrapper
 * catches what the test throws at it and nothing about what D1 does. Renamed
 * rather than dropped, and restored in a `finally`, so the file's other tests
 * (and their rows) are untouched either way.
 */
async function withBrokenDatabase<T>(fn: () => Promise<T>): Promise<T> {
  await env.DB.exec('ALTER TABLE device_auth RENAME TO device_auth_gone')
  try {
    return await fn()
  } finally {
    await env.DB.exec('ALTER TABLE device_auth_gone RENAME TO device_auth')
  }
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

// The daemon's half of the handshake, over the transport the daemon will
// actually use. `startDeviceAuth` and `pollDeviceAuth` are plain functions in
// server/enroll.ts and enroll.test.ts proves what they decide; what only a
// request can prove is that they are *reachable* — unauthenticated, from a
// client that is not a browser, and with the hostile-input handling in front
// of them that /login's fields get.
describe('the daemon-facing endpoints', () => {
  it('are addressable at a URL the daemon can compute for itself', async () => {
    // Start mints a server function's id as sha256("<file>--<name>_createServerFn_handler"),
    // which is deterministic but invisible: nothing in the source spells the
    // URL, and a rename or a move silently changes it. Task 11's daemon has to
    // hardcode these two paths, so this recomputes them from the derivation
    // and checks them against the build. Moving either function out of
    // src/routes/enroll.tsx, or renaming it, breaks a shipped daemon — and now
    // breaks this test first.
    const idFor = (file: string, name: string) =>
      sha256Hex(`${file}--${name}_createServerFn_handler`)

    expect(serverFnUrls.startDeviceAuthFn).toBe(
      `/_serverFn/${await idFor('src/routes/enroll.tsx', 'startDeviceAuthFn')}`,
    )
    expect(serverFnUrls.pollDeviceAuthFn).toBe(
      `/_serverFn/${await idFor('src/routes/enroll.tsx', 'pollDeviceAuthFn')}`,
    )
  })

  it('opens a grant for a caller with no session and no cookie', async () => {
    const publicKey = freshKey()
    const res = await callAsDaemon('startDeviceAuthFn', { label: 'a go daemon', publicKey })
    expect(res.status).toBe(200)

    const grant = (await payload(res)) as unknown as {
      userCode: string
      deviceCode: string
      verificationUrl: string
      interval: number
    }
    expect(grant.userCode).toMatch(/^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/)
    expect(grant.deviceCode).toMatch(/^[A-Za-z0-9_-]{43}$/)
    // Taken from the request the daemon made, not from a header it supplied:
    // this string is printed into somebody's terminal.
    expect(grant.verificationUrl).toBe(`${ORIGIN}/enroll`)

    const row = await grantRow(grant.userCode)
    expect(row?.label).toBe('a go daemon')
    expect(row?.publicKey).toBe(publicKey)
    expect(row?.approvedUserId).toBeNull()

    // And the poll endpoint answers the same unauthenticated caller.
    const polled = await callAsDaemon('pollDeviceAuthFn', { deviceCode: grant.deviceCode })
    expect(polled.status).toBe(200)
    expect(await payload(polled)).toEqual({ status: 'pending' })
  })

  it('tells a daemon nothing for a device code it did not mint', async () => {
    const res = await callAsDaemon('pollDeviceAuthFn', { deviceCode: 'a'.repeat(43) })
    expect(res.status).toBe(200)
    expect(await payload(res)).toEqual({ status: 'expired' })
  })

  it('refuses a public key that is not one, and writes nothing', async () => {
    const before = (await db().select().from(deviceAuth)).length
    const res = await callAsDaemon('startDeviceAuthFn', { label: 'x', publicKey: 'not-a-key' })

    // 400, not 500: the caller's key is wrong, the server is fine. Nothing
    // about this caller is enumerable, so the daemon's operator gets an error
    // they can read rather than a coy one.
    expect(res.status).toBe(400)
    const body = await payload(res)
    expect(body.error).toContain('32 bytes')
    expect(body.deviceCode).toBeUndefined()
    expect((await db().select().from(deviceAuth)).length).toBe(before)
  })

  it('does no work for oversized fields', async () => {
    // The validator turns anything past its bound into '', and an empty key is
    // refused before the per-IP cap is even consulted. Without the bound, a
    // megabyte "public key" is a megabyte of base64 decoding per request, for
    // free, on an endpoint with no credential in front of it.
    const ip = '198.51.100.222'
    const res = await callAsDaemon(
      'startDeviceAuthFn',
      { label: 'y'.repeat(50_000), publicKey: 'A'.repeat(50_000) },
      { ip },
    )
    expect(res.status).toBe(400)
    expect((await payload(res)).deviceCode).toBeUndefined()

    // The proof that it was free: the per-IP counter was never touched.
    const key = await sha256Hex(`device-auth:ip:${ip}`)
    expect(await db().select().from(rateLimits).where(eq(rateLimits.key, key))).toEqual([])
  })

  it('says 429 rather than 400 when a caller is over its cap', async () => {
    // The one refusal that is worth retrying, told apart from the one that is
    // not. A daemon that read both as "bad request" would give up on a full
    // bucket; one that read both as "try again" would spin on a typo.
    const ip = '198.51.100.223'
    let last: Response | undefined
    for (let i = 0; i <= GRANTS_PER_IP; i++) {
      last = await callAsDaemon(
        'startDeviceAuthFn',
        { label: 'flood', publicKey: freshKey() },
        { ip },
      )
    }
    expect(last?.status).toBe(429)
  })

  it('does not take a JSON body — the daemon has to form-encode', async () => {
    // The hard input for Task 11, pinned rather than left in a comment.
    //
    // Start reads a form-encoded or multipart body as `FormData` and hands it
    // to the validator; *any* other body it runs through seroval's `fromJSON`,
    // which wants seroval's own node shape (`{"t":10,...}`) and throws on a
    // plain object. So the obvious Go client — `json.Marshal(struct{...})`
    // with `Content-Type: application/json` — never reaches
    // `readStartDeviceAuth` at all. It does not even get one of this file's
    // JSON refusals: the throw happens in Start's body parse, above the
    // handler, so what comes back is the seroval envelope that motivated the
    // raw `Response`s in the first place.
    const before = (await db().select().from(deviceAuth)).length
    const res = await SELF.fetch(urlFor('startDeviceAuthFn'), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-tsr-serverFn': 'true',
        origin: ORIGIN,
        'cf-connecting-ip': freshIp(),
      },
      body: JSON.stringify({ label: 'a go daemon', publicKey: freshKey() }),
      redirect: 'manual',
    })

    expect(res.status).not.toBe(200)
    // Start's envelope, not ours — the tell that this failed above the handler.
    expect(res.headers.get('x-tss-serialized')).toBe('true')
    // And no grant: a JSON body opens nothing, however well-formed it looks.
    expect((await db().select().from(deviceAuth)).length).toBe(before)
  })

  it('answers a broken database in JSON, and says nothing about it', async () => {
    // Two failures in one, and the daemon would be stuck on either.
    //
    // A throw that escapes a server function is not a 500 with a plain body:
    // Start serializes it with seroval and answers `x-tss-serialized: true`
    // with a graph the browser's RPC client decodes and a Go program does not
    // — the exact shape these endpoints return raw `Response`s to avoid. And
    // the message inside it is D1's, naming our storage engine and our table
    // to a caller with no session.
    const res = await withBrokenDatabase(() =>
      callAsDaemon('startDeviceAuthFn', { label: 'a go daemon', publicKey: freshKey() }),
    )

    expect(res.status).toBe(500)
    // Not Start's envelope: raw pass-through, and nothing serialized.
    expect(res.headers.get('x-tss-serialized')).toBeNull()

    // `payload` is JSON.parse, so reaching the next line is the claim that a
    // daemon can read this. The body is the whole body: one fixed string.
    const body = await payload(res)
    expect(body).toEqual({ error: 'enroll: could not open a grant' })

    // And said explicitly, because `toEqual` above would still pass if the
    // fallback string itself ever grew a detail: nothing internal leaks.
    const text = JSON.stringify(body)
    expect(text).not.toContain('D1_ERROR')
    expect(text).not.toContain('SQLITE')
    expect(text).not.toContain('device_auth')
  })

  it('answers a broken database on a poll the same way', async () => {
    // The call the daemon makes every five seconds for ten minutes, so it is
    // the likeliest of the three to be in flight when the database has a bad
    // moment — and it had no try/catch at all until this was written.
    const res = await withBrokenDatabase(() =>
      callAsDaemon('pollDeviceAuthFn', { deviceCode: 'a'.repeat(43) }),
    )

    expect(res.status).toBe(500)
    expect(res.headers.get('x-tss-serialized')).toBeNull()

    const body = await payload(res)
    expect(body).toEqual({ error: 'enroll: could not read the grant' })
    expect(JSON.stringify(body)).not.toContain('D1_ERROR')
  })

  it('refuses a POST that carries no origin signal at all', async () => {
    // Not a property of these endpoints so much as of the app — but it is the
    // one thing a Go client will get wrong by default, so it is written down
    // where the daemon's author will find it.
    const res = await SELF.fetch(urlFor('startDeviceAuthFn'), {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-tsr-serverFn': 'true',
        'cf-connecting-ip': freshIp(),
      },
      body: new URLSearchParams({ label: 'headerless', publicKey: freshKey() }).toString(),
      redirect: 'manual',
    })
    expect(res.status).toBe(403)
  })
})
