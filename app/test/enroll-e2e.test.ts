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
import { randomToken, sha256Hex, verifyChannelToken } from '../src/lib/tokens'
import { DAEMON_TOKEN_TTL_S } from '../src/server/channel-token'
import { DAEMON_TOKENS_PER_IP, GRANTS_PER_IP, startDeviceAuth } from '../src/server/enroll'
import { SESSION_COOKIE, createSession } from '../src/server/sessions'
import { inRequest } from './request'
import serverFnIds from './server-fn-ids.json'

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
 * Run `fn` with `table` renamed out from under the running Worker, so the next
 * statement against it fails the way a real outage does.
 *
 * A genuine `D1_ERROR: no such table: device_auth: SQLITE_ERROR` raised from
 * inside the handler is the only honest way to test the "something broke that
 * nobody wrote an error for" path — a stubbed throw would prove the wrapper
 * catches what the test throws at it and nothing about what D1 does. Renamed
 * rather than dropped, and restored in a `finally`, so the file's other tests
 * (and their rows) are untouched either way.
 */
async function withBrokenTable<T>(table: string, fn: () => Promise<T>): Promise<T> {
  await env.DB.exec(`ALTER TABLE ${table} RENAME TO ${table}_gone`)
  try {
    return await fn()
  } finally {
    await env.DB.exec(`ALTER TABLE ${table}_gone RENAME TO ${table}`)
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

/**
 * One machine, enrolled the whole way: a grant opened, a person approving it,
 * and the single poll that mints the device and hands back its enrollment
 * token.
 *
 * Written as the real handshake rather than an INSERT because what the daemon
 * presents to `daemonTokenFn` is whatever *this* flow produced — a hand-built
 * `devices` row would prove the mint accepts a token this test wrote, not the
 * one the daemon is actually going to hold.
 */
async function enroll(): Promise<{ deviceId: string; deviceToken: string }> {
  const user = await makeUser()
  const grant = await start()
  await callServerFn(
    'confirmDeviceAuthFn',
    { userCode: grant.userCode },
    { cookie: await signIn(user.id) },
  )
  const polled = (await payload(
    await callAsDaemon('pollDeviceAuthFn', { deviceCode: grant.deviceCode }),
  )) as { status?: string; deviceId?: string; deviceToken?: string }
  if (polled.status !== 'approved' || !polled.deviceId || !polled.deviceToken) {
    throw new Error(`enroll helper: the approving poll answered ${JSON.stringify(polled)}`)
  }
  return { deviceId: polled.deviceId, deviceToken: polled.deviceToken }
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
  it('are addressable at the URLs server-fn-ids.json pins, in both languages', async () => {
    // Start mints a server function's id as sha256("<file>--<name>_createServerFn_handler"),
    // which is deterministic but invisible: nothing in the source spells the
    // URL, and a rename or a move silently changes it. The daemon hardcodes
    // these paths — internal/controlplane derives them in Go from the same two
    // strings — so a rename here breaks every flue already installed.
    //
    // server-fn-ids.json is the one written-down copy, and the assertions run
    // in the order that makes the coupling impossible to forget: the *build*
    // has to match the pinned literal (so a rename fails here first), and the
    // pinned literal has to match the derivation (so fixing the file means
    // spelling the new name, which is what the Go test then disagrees with
    // until its own constants are updated).
    const idFor = (file: string, name: string) =>
      sha256Hex(`${file}--${name}_createServerFn_handler`)

    for (const [name, pinned] of Object.entries(serverFnIds.functions)) {
      expect(serverFnUrls[name], `${name} moved or was renamed`).toBe(pinned.path)
      expect(pinned.path).toBe(`/_serverFn/${await idFor(pinned.file, name)}`)
    }

    // Named individually as well, so that emptying the JSON — or renaming a
    // key in it — cannot make the loop above vacuously pass.
    expect(Object.keys(serverFnIds.functions).sort()).toEqual([
      'daemonTokenFn',
      'pollDeviceAuthFn',
      'startDeviceAuthFn',
    ])
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
    const res = await withBrokenTable('device_auth', () =>
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
    const res = await withBrokenTable('device_auth', () =>
      callAsDaemon('pollDeviceAuthFn', { deviceCode: 'a'.repeat(43) }),
    )

    expect(res.status).toBe(500)
    expect(res.headers.get('x-tss-serialized')).toBeNull()

    const body = await payload(res)
    expect(body).toEqual({ error: 'enroll: could not read the grant' })
    expect(JSON.stringify(body)).not.toContain('D1_ERROR')
  })

  it('takes the exact request internal/controlplane builds', async () => {
    // The one thing the Go package's own tests cannot prove. They run against a
    // fake control plane in process, so they check that the client sends what
    // this repository believes Start requires — and every belief in that list
    // was arrived at by reading Start's source. This posts the *literal* header
    // set `(*controlplane.Client).post` sets, against the built Worker, so a
    // wrong one is a failure here rather than a 400 on somebody's laptop.
    //
    // Kept in step by hand, and deliberately spelled out rather than shared
    // with `callAsDaemon`: the point is the exact list, so a header quietly
    // added on one side has to be added here too.
    const res = await SELF.fetch(urlFor('startDeviceAuthFn'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Origin: ORIGIN,
        // Go canonicalizes header names, so this is the spelling that actually
        // goes on the wire for `req.Header.Set("X-TSR-ServerFn", "true")`.
        'X-Tsr-Serverfn': 'true',
        Accept: 'application/json',
        'User-Agent': 'Go-http-client/2.0',
        'cf-connecting-ip': freshIp(),
      },
      body: new URLSearchParams({ label: 'a go daemon', publicKey: freshKey() }).toString(),
      redirect: 'manual',
    })

    expect(res.status).toBe(200)
    expect(res.headers.get('x-tss-serialized')).toBeNull()
    const grant = (await payload(res)) as { deviceCode?: string }
    expect(grant.deviceCode).toMatch(/^[A-Za-z0-9_-]{43}$/)
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

// The fourth call, and the only one a *linked* daemon ever makes: swap the
// enrollment token stored in relay.json for a short-lived `role: 'daemon'`
// channel token, and dial the relay with it.
//
// `mintDaemonToken` (server/channel-token.ts) is the authorization decision and
// channel-token.test.ts drives it directly. What only a request can prove is
// that it is *reachable* by a program with no session and no cookie, over the
// same form-encoded/`Origin`/raw-JSON wire the other two daemon endpoints use —
// and that the credential in the body cannot be spent faster than a daemon
// needs it.
describe('the daemon token endpoint', () => {
  it('hands an enrolled daemon a token the relay will accept', async () => {
    const device = await enroll()

    const res = await callAsDaemon('daemonTokenFn', {
      deviceId: device.deviceId,
      enrollmentToken: device.deviceToken,
    })
    expect(res.status).toBe(200)

    const body = (await payload(res)) as { token: string; relayUrl: string; expiresIn: number }
    // Where to present it, and how long it is good for. The daemon refreshes
    // ahead of `expiresIn`, so a response without it would leave the daemon
    // guessing at the TTL of a credential it did not mint.
    expect(body.relayUrl).toBe(env.RELAY_URL)
    expect(body.expiresIn).toBe(DAEMON_TOKEN_TTL_S)

    // Verified exactly as the relay verifies it — same secret, same function —
    // so this is the claim that a daemon holding this token can open its leg.
    const claims = await verifyChannelToken(env.RELAY_SIGNING_SECRET, body.token)
    expect(claims?.role).toBe('daemon')
    expect(claims?.dev).toBe(device.deviceId)

    // The enrollment token is not consumed: the daemon presents the same one
    // every five minutes for the life of the machine.
    expect(
      (
        await callAsDaemon('daemonTokenFn', {
          deviceId: device.deviceId,
          enrollmentToken: device.deviceToken,
        })
      ).status,
    ).toBe(200)
  })

  it('refuses every wrong credential with one undistinguished 401', async () => {
    // A daemon does the same thing about all of them — stop, and tell its
    // operator to link again — and a refusal that said *which* would answer
    // questions for whoever is holding a token they should not have.
    const device = await enroll()
    const other = await enroll()

    const refusals = await Promise.all(
      [
        { deviceId: device.deviceId, enrollmentToken: randomToken() },
        { deviceId: device.deviceId, enrollmentToken: other.deviceToken },
        { deviceId: other.deviceId, enrollmentToken: device.deviceToken },
        { deviceId: 'ffffffffffff', enrollmentToken: device.deviceToken },
        { deviceId: '', enrollmentToken: device.deviceToken },
        { deviceId: device.deviceId, enrollmentToken: '' },
      ].map(async (fields) => {
        const res = await callAsDaemon('daemonTokenFn', fields)
        return { status: res.status, body: await payload(res) }
      }),
    )

    for (const refusal of refusals) {
      expect(refusal.status).toBe(401)
      expect(refusal.body).toEqual(refusals[0]?.body)
      expect(refusal.body.token).toBeUndefined()
    }
  })

  it('stops minting for a revoked machine', async () => {
    // The kill switch, at the door the daemon knocks on. `mintDaemonToken`
    // states it in its own predicate; this is the proof it is still stated
    // once the call is behind an HTTP handler.
    const device = await enroll()
    expect((await callAsDaemon('daemonTokenFn', {
      deviceId: device.deviceId,
      enrollmentToken: device.deviceToken,
    })).status).toBe(200)

    await db().update(devices).set({ disabled: true }).where(eq(devices.id, device.deviceId))

    expect((await callAsDaemon('daemonTokenFn', {
      deviceId: device.deviceId,
      enrollmentToken: device.deviceToken,
    })).status).toBe(401)
  })

  it('does no work for oversized fields', async () => {
    // The validator turns anything past its bound into '', and an empty field
    // is refused before the per-IP cap is consulted. Without the bound, a
    // megabyte "enrollment token" is a megabyte of hashing per request, for
    // free, on an endpoint with no session in front of it.
    const ip = '198.51.100.224'
    const res = await callAsDaemon(
      'daemonTokenFn',
      { deviceId: 'y'.repeat(50_000), enrollmentToken: 'z'.repeat(50_000) },
      { ip },
    )
    expect(res.status).toBe(401)

    // The proof that it was free: the per-IP counter was never touched.
    const key = await sha256Hex(`daemon-token:ip:${ip}`)
    expect(await db().select().from(rateLimits).where(eq(rateLimits.key, key))).toEqual([])
  })

  it('says 429 rather than 401 when a caller is over its cap', async () => {
    // Its own bucket, not `device-auth:ip`'s: linking a machine happens once
    // and refreshing a token happens forever, so one cap cannot serve both.
    // And the two refusals have to stay distinguishable — a daemon that read a
    // full bucket as "your enrollment is dead" would tell its operator to
    // re-link a machine that was fine.
    const ip = '198.51.100.225'
    const device = await enroll()
    let last: Response | undefined
    for (let i = 0; i <= DAEMON_TOKENS_PER_IP; i++) {
      last = await callAsDaemon(
        'daemonTokenFn',
        { deviceId: device.deviceId, enrollmentToken: device.deviceToken },
        { ip },
      )
    }
    expect(last?.status).toBe(429)
  })

  it('answers a broken database in JSON, and says nothing about it', async () => {
    // The call a linked daemon makes forever, so it will be in flight when the
    // database has a bad moment. A throw that escapes would be Start's seroval
    // envelope — unreadable to Go — carrying drizzle's `Failed query: <SQL>
    // params: <every bound value>`, which on this path is the device id and
    // the sha256 of the daemon's enrollment token.
    const device = await enroll()
    const res = await withBrokenTable('devices', () =>
      callAsDaemon('daemonTokenFn', {
        deviceId: device.deviceId,
        enrollmentToken: device.deviceToken,
      }),
    )

    expect(res.status).toBe(500)
    expect(res.headers.get('x-tss-serialized')).toBeNull()

    const body = await payload(res)
    expect(body).toEqual({ error: 'enroll: could not mint a daemon token' })
    const text = JSON.stringify(body)
    expect(text).not.toContain('D1_ERROR')
    expect(text).not.toContain('SQLITE')
    expect(text).not.toContain(device.deviceToken)
  })
})
