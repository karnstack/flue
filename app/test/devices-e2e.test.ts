// The device directory over a real HTTP request to the real built Worker.
//
// devices.test.ts drives the policy functions directly, which proves what they
// decide. This file proves the two things only a request can.
//
// **1. `requireUser` really fires, over the wire.** It has been function
// middleware since Task 4 and its redirect target became the type-checked
// `to: '/login'` in Task 5 — which made the thrown redirect *unresolved* at the
// middleware (no Location header yet; Start's request handler resolves it
// against the router on the way out). Task 5 could only assert the throw, since
// no protected server function existed to call over HTTP. Now one does, and the
// assertions below are of the behaviour that was actually measured rather than
// the one that seems obvious:
//
//   - a **document** request to /devices without a session gets a real 3xx with
//     `Location: /login` — an address-bar navigation, so the browser follows it;
//   - an **RPC** to a protected server function without a session gets **200**,
//     not 3xx, with `Location: /login` *and* a seroval payload carrying
//     `isSerializedRedirect`. Start serializes the redirect for its client
//     rather than answering a status the fetch would follow (following it would
//     replace the RPC's JSON with an HTML document the RPC client cannot use).
//     So on this path the header and the body are what say the guard fired, and
//     the status is not — asserting `3xx` here would be asserting a fiction.
//
// The load-bearing half of each of those tests is the same either way: nothing
// of the account's came back, and nothing of the account's changed.
//
// **2. Nothing leaks when the database breaks.** drizzle raises a failed
// statement as `Failed query: <SQL>\nparams: <every bound value>`, which on
// these paths means device ids and the session's user id. Every server function
// here wraps its call the way routes/enroll.tsx's `refusal` does; the tests at
// the bottom rename the table out from under the running Worker and read what
// actually comes back.
//
// `SELF.fetch` is the built Worker (vitest.config.ts points the pool at
// dist/server), so this needs `pnpm build` first.
import { SELF, env } from 'cloudflare:test'
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { db } from '../src/db/client'
import { devices, sessions, users } from '../src/db/schema'
import { base64url, randomToken, sha256Hex } from '../src/lib/tokens'
import { SESSION_COOKIE, createSession } from '../src/server/sessions'
import { inRequest } from './request'

const ORIGIN = 'https://app.flue.sh'

/** Bumped by every helper below, so no two callers in this file collide. */
let seq = 0

const now = () => Math.floor(Date.now() / 1000)
const freshIp = () => `192.0.2.${++seq % 256}`

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
  fields: Record<string, string> = {},
  opts: { cookie?: string } = {},
): Promise<Response> {
  const headers = new Headers({
    'content-type': 'application/x-www-form-urlencoded',
    'x-tsr-serverFn': 'true',
    // start.ts refuses a server-fn POST that carries no origin signal.
    'sec-fetch-site': 'same-origin',
    'cf-connecting-ip': freshIp(),
  })
  if (opts.cookie) headers.set('cookie', opts.cookie)

  return SELF.fetch(urlFor(name), {
    method: 'POST',
    headers,
    body: new URLSearchParams(fields).toString(),
    // Never followed: what the guard answers *is* the assertion.
    redirect: 'manual',
  })
}

async function makeUser(): Promise<{ id: string; email: string }> {
  const user = { id: crypto.randomUUID(), email: `dv-${++seq}-${crypto.randomUUID()}@example.com` }
  await db().insert(users).values({ ...user, createdAt: now() })
  return user
}

async function makeDevice(userId: string, label: string): Promise<string> {
  const id = (await sha256Hex(`e2e-device-${++seq}-${crypto.randomUUID()}`)).slice(0, 12)
  await db()
    .insert(devices)
    .values({
      id,
      userId,
      label,
      publicKey: base64url(crypto.getRandomValues(new Uint8Array(32))),
      tokenHash: await sha256Hex(randomToken()),
      createdAt: now(),
    })
  return id
}

/** Sign `userId` in and hand back the Cookie header a browser would send. */
async function signIn(userId: string): Promise<string> {
  const { setCookie } = await inRequest(() => createSession(userId), { ip: freshIp() })
  const header = setCookie.find((c) => c.startsWith(`${SESSION_COOKIE}=`))
  if (!header) throw new Error('createSession set no session cookie')
  return `${SESSION_COOKIE}=${header.slice(`${SESSION_COOKIE}=`.length).split(';')[0]}`
}

/**
 * A cookie whose session row has aged out. Not a forged cookie: the row is
 * real, the token is real, and only `expires_at` says no — which is the one
 * case a guard can get wrong by looking the session up without a clock.
 */
async function signInExpired(userId: string): Promise<string> {
  const cookie = await signIn(userId)
  const token = cookie.slice(`${SESSION_COOKIE}=`.length)
  await db()
    .update(sessions)
    .set({ expiresAt: now() - 60 })
    .where(eq(sessions.id, await sha256Hex(token)))
  return cookie
}

/** The row behind an id, or undefined. */
async function row(deviceId: string) {
  const [found] = await db().select().from(devices).where(eq(devices.id, deviceId))
  return found
}

/**
 * Run `fn` with `devices` renamed out from under the running Worker, so the
 * next statement against it fails the way a real outage does.
 *
 * A genuine `D1_ERROR: no such table: devices` raised inside the handler is the
 * only honest way to test the "something broke that nobody wrote an error for"
 * path — a stubbed throw would prove the wrapper catches what the test threw at
 * it and nothing about what D1 does. Renamed rather than dropped, and restored
 * in a `finally`. `sessions` and `users` are untouched, so `requireUser` still
 * passes and the failure lands where it is meant to.
 */
async function withBrokenDatabase<T>(fn: () => Promise<T>): Promise<T> {
  await env.DB.exec('ALTER TABLE devices RENAME TO devices_gone')
  try {
    return await fn()
  } finally {
    await env.DB.exec('ALTER TABLE devices_gone RENAME TO devices')
  }
}

describe('the device directory page', () => {
  it('sends a signed-out visitor to sign in', async () => {
    // A document request: a real redirect, which the address bar follows. 307
    // exactly, not merely 3xx — this is the status Task 5 could only assume,
    // and pinning it is what stops the number moving without anyone noticing.
    const res = await SELF.fetch(`${ORIGIN}/devices`, { redirect: 'manual' })
    expect(res.status).toBe(307)
    expect(res.headers.get('location')).toBe('/login')
  })

  it('renders the caller’s machines, server-side', async () => {
    const user = await makeUser()
    await makeDevice(user.id, 'kitchen pi')

    const res = await SELF.fetch(`${ORIGIN}/devices`, { headers: { cookie: await signIn(user.id) } })
    expect(res.status).toBe(200)

    const html = await res.text()
    expect(html).toContain('kitchen pi')
    expect(html).toContain('Your machines')
  })

  it('shows one account nothing of another’s', async () => {
    const mine = await makeUser()
    const theirs = await makeUser()
    await makeDevice(mine.id, 'mine-visible')
    await makeDevice(theirs.id, 'theirs-hidden')

    const res = await SELF.fetch(`${ORIGIN}/devices`, { headers: { cookie: await signIn(mine.id) } })
    const html = await res.text()
    expect(html).toContain('mine-visible')
    expect(html).not.toContain('theirs-hidden')
  })
})

describe('requireUser, over the wire', () => {
  it('turns a protected RPC with no cookie into a redirect to /login, and returns no data', async () => {
    const user = await makeUser()
    await makeDevice(user.id, 'should-not-appear')

    const res = await callServerFn('listDevicesFn')

    // Measured, not assumed. Start does not answer 3xx to an RPC — it answers
    // 200 `application/json` and serializes the navigation into the payload,
    // with the resolved Location alongside. The guard fired; the status is not
    // what says so. (The document request three tests up *does* get a 307:
    // same middleware, same throw, two different transports.)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/json')
    expect(res.headers.get('location')).toBe('/login')

    const body = await res.text()
    expect(body).toContain('isSerializedRedirect')
    expect(body).toContain('/login')
    // The half that matters: an unauthenticated caller got no device list.
    expect(body).not.toContain('should-not-appear')
  })

  it('does the same for a session that has expired', async () => {
    // The row exists and the token matches; only the clock says no. This is
    // the case a guard that reads the session without checking `expires_at`
    // would let straight through.
    const user = await makeUser()
    await makeDevice(user.id, 'expired-session-device')

    const res = await callServerFn('listDevicesFn', {}, { cookie: await signInExpired(user.id) })

    expect(res.status).toBe(200)
    expect(res.headers.get('location')).toBe('/login')
    const body = await res.text()
    expect(body).toContain('isSerializedRedirect')
    expect(body).not.toContain('expired-session-device')
  })

  it('does the same for a forged cookie', async () => {
    const res = await callServerFn(
      'listDevicesFn',
      {},
      { cookie: `${SESSION_COOKIE}=${'A'.repeat(43)}` },
    )
    expect(res.headers.get('location')).toBe('/login')
    expect(await res.text()).toContain('isSerializedRedirect')
  })

  it('stops a mutation, not merely a read', async () => {
    // The one that would actually cost something: revoke, unauthenticated.
    const user = await makeUser()
    const deviceId = await makeDevice(user.id, 'still here')

    const res = await callServerFn('revokeDeviceFn', { deviceId })

    expect(res.headers.get('location')).toBe('/login')
    expect(await res.text()).toContain('isSerializedRedirect')
    // The row survived, which is the whole point of the guard.
    expect(await row(deviceId)).toBeDefined()
  })

  it('lets a signed-in caller through to their own machines', async () => {
    const user = await makeUser()
    const deviceId = await makeDevice(user.id, 'reachable')

    const res = await callServerFn('listDevicesFn', {}, { cookie: await signIn(user.id) })

    expect(res.status).toBe(200)
    expect(res.headers.get('location')).toBeNull()
    const body = await res.text()
    expect(body).not.toContain('isSerializedRedirect')
    expect(body).toContain(deviceId)
    expect(body).toContain('reachable')
    // The server's clock rides along with the list. Without it the screen
    // renders "seen 3h ago" against the server's clock on the way out and the
    // visitor's on the way in, and the two disagree — a hydration mismatch on
    // every page load where a minute ticked over, and a wrong answer on any
    // machine whose clock is off.
    //
    // Asserted in two halves because seroval encodes an object as parallel
    // key/value arrays — the payload spells `"now"` in one list and the number
    // in another, so `"now":1786…` never appears anywhere in it.
    expect(body).toContain('"now"')
    expect(body).toMatch(/"t":0,"s":1\d{9}\}/)
  })
})

describe('acting on somebody else’s machine, over HTTP', () => {
  it('is refused, and changes nothing', async () => {
    const owner = await makeUser()
    const mallory = await makeUser()
    const deviceId = await makeDevice(owner.id, 'victim mac')
    const cookie = await signIn(mallory.id)

    const revoked = await callServerFn('revokeDeviceFn', { deviceId }, { cookie })
    // A refusal in the same shape the success path speaks — not a thrown error
    // serialized by Start, and not a redirect.
    expect(revoked.status).toBe(200)
    expect(await revoked.text()).not.toContain('isSerializedRedirect')
    expect(await row(deviceId)).toBeDefined()

    const renamed = await callServerFn('renameDeviceFn', { deviceId, label: 'mine now' }, { cookie })
    expect(renamed.status).toBe(200)
    expect((await row(deviceId))?.label).toBe('victim mac')

    const opened = await callServerFn('openSessionFn', { deviceId }, { cookie })
    expect(opened.status).toBe(200)
    // No token, however the refusal is spelled.
    expect(await opened.text()).not.toContain('wss://')
  })
})

describe('when the database breaks', () => {
  it('answers a fixed string, and never drizzle’s bound parameters', async () => {
    // drizzle raises a failed statement as `Failed query: <SQL>\nparams: <every
    // bound value>`. Left to escape, Start serializes that message into the RPC
    // payload — so a dashboard load during an outage would hand the browser the
    // schema and the session's user id.
    const user = await makeUser()
    const cookie = await signIn(user.id)

    const res = await withBrokenDatabase(() => callServerFn('listDevicesFn', {}, { cookie }))
    const body = await res.text()

    expect(body).toContain('could not read')
    for (const leak of ['D1_ERROR', 'SQLITE', 'Failed query', 'params:', 'select', user.id]) {
      expect(body).not.toContain(leak)
    }
  })

  it('answers the same way when a session is being opened', async () => {
    // The path that mints a bearer credential, so its failure message is the
    // one worth being careful with: the bound parameters on this statement are
    // the device id and the account id.
    const user = await makeUser()
    const cookie = await signIn(user.id)

    const res = await withBrokenDatabase(() =>
      callServerFn('openSessionFn', { deviceId: 'ffffffffffff' }, { cookie }),
    )
    const body = await res.text()

    for (const leak of ['D1_ERROR', 'SQLITE', 'Failed query', 'params:', user.id]) {
      expect(body).not.toContain(leak)
    }
  })

  it('answers the same way on a revoke and a rename', async () => {
    const user = await makeUser()
    const cookie = await signIn(user.id)

    for (const [name, fields] of [
      ['revokeDeviceFn', { deviceId: 'ffffffffffff' }],
      ['renameDeviceFn', { deviceId: 'ffffffffffff', label: 'anything' }],
    ] as const) {
      const res = await withBrokenDatabase(() => callServerFn(name, fields, { cookie }))
      const body = await res.text()
      for (const leak of ['D1_ERROR', 'SQLITE', 'Failed query', 'params:', user.id]) {
        expect(body).not.toContain(leak)
      }
    }
  })
})
