// The login session: a cookie the browser holds, a digest the database holds,
// and the guard that stands between the two and every protected server
// function.
//
// Everything here runs against a real (local) D1 through the same `db()`
// production uses, and — unlike codes.test.ts — inside a real Start request
// context, because cookies *are* the unit under test. `inRequest` below builds
// that context with Start's own `requestHandler`, so `getCookie`/`setCookie`
// resolve exactly as they will in a route loader or a server function, and the
// `Set-Cookie` header the tests read is the one a browser would receive.
//
// The pool isolates storage per test *file*, not per test: every test below
// mints its own user and nothing may assume an empty table.
import { isRedirect } from '@tanstack/react-router'
import { createMiddleware, executeMiddleware } from '@tanstack/react-start'
import { requestHandler } from '@tanstack/react-start/server'
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { db } from '../src/db/client'
import { sessions, users } from '../src/db/schema'
import { sha256Hex } from '../src/lib/tokens'
import { requireUser } from '../src/server/auth'
import {
  SESSION_COOKIE,
  SESSION_TTL_S,
  createSession,
  currentUser,
  destroySession,
} from '../src/server/sessions'

const ORIGIN = 'https://app.flue.sh/'
const now = () => Math.floor(Date.now() / 1000)

/**
 * Run `body` inside one real Start request, and hand back what it returned
 * along with every `Set-Cookie` the request would send.
 *
 * `requestHandler` is the same wrapper the deployed Worker's entry uses: it
 * puts an h3 event in AsyncLocalStorage, which is what `getCookie`/`setCookie`
 * read. Without it those helpers throw "No StartEvent found" — so this is also
 * the assertion that sessions.ts is usable from ordinary request code.
 */
async function inRequest<T>(
  body: () => Promise<T>,
  opts: { cookie?: string } = {},
): Promise<{ value: T; setCookie: Array<string> }> {
  let outcome: { ok: true; value: T } | { ok: false; error: unknown } | undefined
  const handle = requestHandler(async () => {
    try {
      outcome = { ok: true, value: await body() }
    } catch (error) {
      // Rethrowing here would let h3 turn the failure into a 500 and swallow
      // it; the test wants the original error, after the response (and its
      // cookies) have been assembled.
      outcome = { ok: false, error }
    }
    return new Response('ok')
  })

  const headers = new Headers()
  if (opts.cookie !== undefined) headers.set('cookie', opts.cookie)
  const res = await handle(new Request(ORIGIN, { headers }), {})

  if (!outcome) throw new Error('the request handler never ran the body')
  if (!outcome.ok) throw outcome.error
  return { value: outcome.value, setCookie: res.headers.getSetCookie() }
}

/** The single `Set-Cookie` for our cookie name, or a failure if there is not exactly one. */
function sessionCookieHeader(setCookie: Array<string>): string {
  const ours = setCookie.filter((c) => c.startsWith(`${SESSION_COOKIE}=`))
  expect(ours).toHaveLength(1)
  return ours[0] as string
}

function tokenFrom(setCookie: Array<string>): string {
  const value = sessionCookieHeader(setCookie).slice(`${SESSION_COOKIE}=`.length).split(';')[0]
  if (!value) throw new Error('the session cookie carried no value')
  return decodeURIComponent(value)
}

let seq = 0
async function makeUser(opts: { disabled?: boolean } = {}): Promise<{ id: string; email: string }> {
  const id = `u${++seq}-${crypto.randomUUID()}`
  const email = `${id}@example.com`
  await db()
    .insert(users)
    .values({ id, email, createdAt: now(), disabled: opts.disabled ?? false })
  return { id, email }
}

/** Log a user in and return both halves: the cookie the browser gets, the token the DB hashed. */
async function login(userId: string): Promise<{ token: string; cookie: string }> {
  const { setCookie } = await inRequest(() => createSession(userId))
  const token = tokenFrom(setCookie)
  return { token, cookie: `${SESSION_COOKIE}=${token}` }
}

function rowsFor(id: string) {
  return db().select().from(sessions).where(eq(sessions.id, id))
}

describe('sha256Hex', () => {
  it('is SHA-256, lowercase hex', async () => {
    // The canonical vector, so swapping the primitive (or the encoding) cannot
    // pass: sessions.id is defined as SHA-256(token) and the login path has to
    // agree with the schema comment forever.
    expect(await sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
    expect(await sha256Hex('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    )
  })
})

describe('createSession', () => {
  it('sets a __Host- cookie with every attribute that prefix requires', async () => {
    const user = await makeUser()
    const { setCookie } = await inRequest(() => createSession(user.id))
    const header = sessionCookieHeader(setCookie)

    // The name is not decoration. `__Host-` is a browser-enforced contract:
    // the cookie is refused unless it is Secure, has Path=/ and carries no
    // Domain — which is what stops a subdomain (or anything that gets to
    // *.flue.sh) from planting a session cookie on the control plane.
    expect(header.startsWith('__Host-session=')).toBe(true)
    expect(header).toContain('; Secure')
    expect(header).toContain('; Path=/')
    expect(header).not.toContain('Domain')
    // HttpOnly keeps the token out of document.cookie, so an XSS cannot read
    // it; SameSite=Lax (not Strict) still arrives on a top-level navigation
    // back from the email client, which is how a login flow ends.
    expect(header).toContain('; HttpOnly')
    expect(header).toContain('; SameSite=Lax')
    expect(header).toContain(`; Max-Age=${SESSION_TTL_S}`)

    // ...and the whole header, so an attribute cannot be lost in a refactor
    // without a test noticing.
    expect(header).toBe(
      `${SESSION_COOKIE}=${tokenFrom(setCookie)}; Max-Age=28800; Path=/; HttpOnly; Secure; SameSite=Lax`,
    )
  })

  it('mints 32 bytes of CSPRNG token, fresh every time', async () => {
    const user = await makeUser()
    const tokens = new Set<string>()
    for (let i = 0; i < 5; i++) {
      const { token } = await login(user.id)
      // 32 bytes, base64url, unpadded — 43 characters, url- and cookie-safe.
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)
      tokens.add(token)
    }
    expect(tokens.size).toBe(5)
  })

  it('stores the digest of the token and nothing else', async () => {
    const user = await makeUser()
    const { token } = await login(user.id)

    const [row] = await rowsFor(await sha256Hex(token))
    expect(row?.userId).toBe(user.id)
    // Not merely "the id column is a hash": no column of the row carries the
    // token, so a dump of D1 cannot be replayed as a cookie.
    expect(JSON.stringify(row)).not.toContain(token)

    // And no other row picked it up either — the whole table is checked, not
    // just the one this test wrote.
    const all = await db().select().from(sessions)
    expect(JSON.stringify(all)).not.toContain(token)
  })

  it('gives the session an eight-hour absolute life', async () => {
    const user = await makeUser()
    const before = now()
    const { token } = await login(user.id)

    const [row] = await rowsFor(await sha256Hex(token))
    expect(SESSION_TTL_S).toBe(8 * 60 * 60)
    expect(row?.createdAt).toBeGreaterThanOrEqual(before)
    expect((row?.expiresAt ?? 0) - (row?.createdAt ?? 0)).toBe(SESSION_TTL_S)
  })

  it('needs no prior session: login can mint one from nothing', async () => {
    // Task 5 rotates by calling destroySession() then createSession(); the
    // second must not depend on the first having found anything, and a request
    // that arrives with no cookie at all is the ordinary case.
    const user = await makeUser()
    const { setCookie } = await inRequest(async () => {
      await destroySession()
      await createSession(user.id)
    })

    const token = tokenFrom(setCookie)
    expect(await rowsFor(await sha256Hex(token))).toHaveLength(1)
    expect((await inRequest(currentUser, { cookie: `${SESSION_COOKIE}=${token}` })).value).toEqual({
      id: user.id,
      email: user.email,
    })
  })
})

describe('currentUser', () => {
  it('round-trips the cookie back to the user who logged in', async () => {
    const user = await makeUser()
    const { cookie } = await login(user.id)
    const { value } = await inRequest(currentUser, { cookie })
    expect(value).toEqual({ id: user.id, email: user.email })
  })

  it('is null with no cookie at all', async () => {
    const { value } = await inRequest(currentUser)
    expect(value).toBeNull()
  })

  it('is null for a cookie whose token was never issued', async () => {
    const forged = `${SESSION_COOKIE}=${'A'.repeat(43)}`
    expect((await inRequest(currentUser, { cookie: forged })).value).toBeNull()
    // An empty value is not a session either — and must not become "look up
    // the hash of the empty string".
    expect((await inRequest(currentUser, { cookie: `${SESSION_COOKIE}=` })).value).toBeNull()
  })

  it('is null once the session has expired', async () => {
    const user = await makeUser()
    const token = 'expired-session-token'
    await db()
      .insert(sessions)
      .values({
        id: await sha256Hex(token),
        userId: user.id,
        createdAt: now() - SESSION_TTL_S - 1,
        expiresAt: now() - 1, // one second past its absolute life
      })
    const { value } = await inRequest(currentUser, { cookie: `${SESSION_COOKIE}=${token}` })
    expect(value).toBeNull()
  })

  it('is null the moment the user is disabled, without waiting for the cookie to expire', async () => {
    // The kill switch has to reach *live* sessions: disabling an account whose
    // browser already holds a valid cookie is the entire point of the column.
    const user = await makeUser()
    const { cookie } = await login(user.id)
    expect((await inRequest(currentUser, { cookie })).value).not.toBeNull()

    await db().update(users).set({ disabled: true }).where(eq(users.id, user.id))
    expect((await inRequest(currentUser, { cookie })).value).toBeNull()

    // Re-enabling restores it: `disabled` is a gate on the read, not a delete.
    await db().update(users).set({ disabled: false }).where(eq(users.id, user.id))
    expect((await inRequest(currentUser, { cookie })).value).toEqual({
      id: user.id,
      email: user.email,
    })
  })

  it('is null when the session points at a user who no longer exists', async () => {
    // There are no foreign keys (see schema.ts), so a dangling row is
    // reachable; the join has to be what refuses it, not the database.
    const user = await makeUser()
    const { cookie, token } = await login(user.id)
    await db().delete(users).where(eq(users.id, user.id))
    expect((await inRequest(currentUser, { cookie })).value).toBeNull()
    // The row is still there — this is a join miss, not a cleanup path.
    expect(await rowsFor(await sha256Hex(token))).toHaveLength(1)
  })

  it('answers with the user the presented token belongs to, and no other', async () => {
    const a = await makeUser()
    const b = await makeUser()
    const sessionA = await login(a.id)
    const sessionB = await login(b.id)

    // Two live sessions in one table: the cookie is the only thing that
    // decides which user a request is, so neither may answer with the other.
    const seenA = (await inRequest(currentUser, { cookie: sessionA.cookie })).value
    const seenB = (await inRequest(currentUser, { cookie: sessionB.cookie })).value
    expect(seenA).toEqual({ id: a.id, email: a.email })
    expect(seenB).toEqual({ id: b.id, email: b.email })

    // ...and revoking one leaves the other's cookie answering as itself.
    await inRequest(destroySession, { cookie: sessionA.cookie })
    expect((await inRequest(currentUser, { cookie: sessionA.cookie })).value).toBeNull()
    expect((await inRequest(currentUser, { cookie: sessionB.cookie })).value).toEqual({
      id: b.id,
      email: b.email,
    })
  })
})

describe('destroySession', () => {
  it('deletes the row and clears the cookie', async () => {
    const user = await makeUser()
    const { cookie, token } = await login(user.id)

    const { setCookie } = await inRequest(destroySession, { cookie })
    const header = sessionCookieHeader(setCookie)
    // The clearing cookie is subject to the same __Host- contract as the one
    // it replaces: without Secure and Path=/ the browser rejects it outright
    // and the session cookie stays put.
    expect(header).toContain('; Max-Age=0')
    expect(header).toContain('; Secure')
    expect(header).toContain('; Path=/')
    expect(header).not.toContain('Domain')

    // Server-side, the session is gone whatever the browser does with the
    // header — a copied cookie is worthless after sign-out.
    expect(await rowsFor(await sha256Hex(token))).toHaveLength(0)
    expect((await inRequest(currentUser, { cookie })).value).toBeNull()
  })

  it('leaves other sessions alone', async () => {
    const user = await makeUser()
    const laptop = await login(user.id)
    const phone = await login(user.id)

    await inRequest(destroySession, { cookie: laptop.cookie })
    expect((await inRequest(currentUser, { cookie: laptop.cookie })).value).toBeNull()
    // Signing out here is not signing out everywhere.
    expect((await inRequest(currentUser, { cookie: phone.cookie })).value).toEqual({
      id: user.id,
      email: user.email,
    })
  })

  it('is a no-op when there is no cookie', async () => {
    const user = await makeUser()
    const live = await login(user.id)
    await inRequest(destroySession)
    expect((await inRequest(currentUser, { cookie: live.cookie })).value).not.toBeNull()
  })

  it('rotates: destroy then create leaves exactly the new session', async () => {
    // The shape Task 5's login handler uses. A pre-login session id must never
    // survive the login that follows it (session fixation).
    const user = await makeUser()
    const before = await login(user.id)

    const { setCookie } = await inRequest(
      async () => {
        await destroySession()
        await createSession(user.id)
      },
      { cookie: before.cookie },
    )

    // One cookie for this name, carrying the new token: the browser cannot be
    // left holding the old one.
    const after = tokenFrom(setCookie)
    expect(after).not.toBe(before.token)
    expect(await rowsFor(await sha256Hex(before.token))).toHaveLength(0)
    expect(await rowsFor(await sha256Hex(after))).toHaveLength(1)
    expect((await inRequest(currentUser, { cookie: before.cookie })).value).toBeNull()
    expect((await inRequest(currentUser, { cookie: `${SESSION_COOKIE}=${after}` })).value).toEqual({
      id: user.id,
      email: user.email,
    })
  })
})

// Start's server runtime keeps a second AsyncLocalStorage (alongside the h3
// event `inRequest` provides) holding the options `createStart` was given;
// `executeMiddleware` reads the app's global function middleware out of it and
// throws if it is missing. An empty context is enough here — this test has no
// global middleware to run — but it has to be present, so borrow the same
// well-known global the runtime uses.
type StartStorage = { run: <T>(context: object, body: () => T) => T }
const START_STORAGE_KEY = Symbol.for('tanstack-start:start-storage-context')
function withStartContext<T>(body: () => T): T {
  const storage = (globalThis as unknown as Record<symbol, StartStorage | undefined>)[
    START_STORAGE_KEY
  ]
  if (!storage) throw new Error('Start’s context storage is missing: did its global key change?')
  return storage.run({}, body)
}

// A stand-in for a protected server function: it records the context it was
// handed, so the tests can see both whether it ran and what `requireUser` put
// there. Running it through Start's own `executeMiddleware` — the function
// that drives every `.middleware([...])` chain — means the guard is exercised
// the way a real protected server fn exercises it.
function protectedRoute() {
  const seen: Array<unknown> = []
  const handler = createMiddleware({ type: 'function' }).server(async ({ next, context }) => {
    seen.push(context)
    return next()
  })
  const run = (cookie?: string) =>
    inRequest(
      () =>
        withStartContext(() =>
          executeMiddleware([requireUser, handler], 'server', {
            method: 'POST',
            data: undefined,
            context: {},
            serverFnMeta: { id: 'test/protected' },
          }),
        ),
      { cookie },
    )
  return { seen, run }
}

describe('requireUser', () => {
  it('redirects to /login when there is no session', async () => {
    const route = protectedRoute()
    const { value } = await route.run()

    expect(isRedirect(value.error)).toBe(true)
    // A Start redirect is a Response carrying the routing options. `to` is the
    // route-typed form — checked against the generated route tree at build
    // time — so what is asserted here is the target, not a Location header:
    // the header is filled in by Start's request handler, which resolves the
    // redirect against the router on the way out (see login-e2e.test.ts, where
    // a real request is what carries a Location).
    const thrown = value.error as Response & { options: { to?: string } }
    expect(thrown.options.to).toBe('/login')
    expect(thrown.status).toBe(307)
    // The guard is a gate, not a warning: the protected body never ran.
    expect(route.seen).toEqual([])
  })

  it('runs the protected function with the user in context', async () => {
    const user = await makeUser()
    const { cookie } = await login(user.id)

    const route = protectedRoute()
    const { value } = await route.run(cookie)

    expect(value.error).toBeUndefined()
    expect(route.seen).toHaveLength(1)
    expect(route.seen[0]).toMatchObject({ user: { id: user.id, email: user.email } })
  })

  it('redirects a disabled user holding a live cookie', async () => {
    const user = await makeUser({ disabled: true })
    const { cookie } = await login(user.id)

    const route = protectedRoute()
    const { value } = await route.run(cookie)

    expect(isRedirect(value.error)).toBe(true)
    expect((value.error as Response & { options: { to?: string } }).options.to).toBe('/login')
    expect(route.seen).toEqual([])
  })

  it('is a function middleware, so server fns compose it per call', () => {
    // Not a request middleware: it must not run globally on every asset and
    // document request, only where a protected function asks for it. (The
    // discriminator is on the options object at runtime; the published type
    // for those options does not carry it, hence the read through a cast.)
    const options = requireUser.options as { type?: string }
    expect(options.type).toBe('function')
  })
})
