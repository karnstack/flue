// The abuse controls, and the switch that turns an account off.
//
// flue.sh hands a browser a shell on somebody's machine, so the two things this
// file covers are the two things an operator needs on the day it is misused:
// **caps**, so no unauthenticated caller can spend the service's budget for it,
// and a **kill switch** that takes effect on the next call rather than when a
// cookie happens to expire.
//
// Three properties run through everything below.
//
// **A cap that is refused is still counted.** Every path here counts before it
// decides, so an over-cap caller keeps itself over the line — and, more
// importantly, the counting is identical whoever asked. A limiter that only
// counted the interesting events would say out loud which addresses were
// interesting.
//
// **A refusal says nothing.** `submitCode` over its cap answers exactly what a
// wrong code answers, `{ok:false}`, and the tests below check that the code it
// refused to look at was *not* spent — which is how you can tell the cap fired
// before the verification rather than after it.
//
// **The kill switch is a read, not a cache.** `currentUser` and both token
// mints re-read `disabled` on every call (Task 4/7 built that; the tests here
// re-assert it as one contract), and `disableUser` adds the half a flag cannot
// do on its own: deleting the sessions, so a re-enable does not resurrect an
// eight-hour cookie somebody stole.
//
// Everything runs against a real (local) D1 through the same `db()` production
// uses, inside a real Start request (test/request.ts) — cookies and the client
// IP are read off the request, so a fake context would test nothing. The pool
// isolates storage per test *file*, not per test: every test mints its own
// user, its own IP and its own device, and nothing may assume an empty table.
import {
  createExecutionContext,
  createScheduledController,
  env,
  waitOnExecutionContext,
} from 'cloudflare:test'
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { db } from '../src/db/client'
import { deviceAuth, devices, loginCodes, rateLimits, sessions, users } from '../src/db/schema'
import { base64url, hmacHex, randomToken, sha256Hex } from '../src/lib/tokens'
// The Worker entry itself — this file is the only test that reaches for it,
// because it is the only one asserting on something no request can reach.
import worker from '../src/server'
import { mintClientToken, mintDaemonToken } from '../src/server/channel-token'
import { CODE_TTL_S } from '../src/server/codes'
import { DeviceError, openSession } from '../src/server/devices'
import { disableDevice, disableUser, enableUser } from '../src/server/kill-switch'
import { submitCode } from '../src/server/login'
import {
  CODE_SUBMITS_PER_IP,
  LONGEST_WINDOW_S,
  SESSIONS_OPENED_PER_USER,
  withinLimit,
} from '../src/server/ratelimit'
import { SESSION_COOKIE, createSession, currentUser } from '../src/server/sessions'
import { runScheduledSweeps } from '../src/server/sweep'
import { inRequest } from './request'

const now = () => Math.floor(Date.now() / 1000)

/** Bumped by every helper below, so no two callers in this file collide. */
let seq = 0

/** Every test gets its own client IP, so a per-IP cap only fires where asked. */
const freshIp = () => `203.0.113.${++seq % 256}`

async function makeUser(opts: { disabled?: boolean } = {}): Promise<{ id: string; email: string }> {
  const user = { id: crypto.randomUUID(), email: `cap-${++seq}-${crypto.randomUUID()}@example.com` }
  await db()
    .insert(users)
    .values({ ...user, createdAt: now(), disabled: opts.disabled ?? false })
  return user
}

/** A device row as the approving poll would have written it, plus its token. */
async function makeDevice(
  userId: string,
  opts: { disabled?: boolean } = {},
): Promise<{ id: string; enrollmentToken: string }> {
  const enrollmentToken = randomToken()
  const id = (await sha256Hex(`device-${++seq}-${crypto.randomUUID()}`)).slice(0, 12)
  await db()
    .insert(devices)
    .values({
      id,
      userId,
      label: `machine ${seq}`,
      publicKey: base64url(crypto.getRandomValues(new Uint8Array(32))),
      tokenHash: await sha256Hex(enrollmentToken),
      createdAt: now(),
      disabled: opts.disabled ?? false,
    })
  return { id, enrollmentToken }
}

/** Sign `userId` in and hand back the Cookie header a browser would send. */
async function signIn(userId: string): Promise<string> {
  const { setCookie } = await inRequest(() => createSession(userId), { ip: freshIp() })
  const header = setCookie.find((c) => c.startsWith(`${SESSION_COOKIE}=`))
  if (!header) throw new Error('createSession set no session cookie')
  return `${SESSION_COOKIE}=${header.slice(`${SESSION_COOKIE}=`.length).split(';')[0]}`
}

/**
 * Put a live login code in the table, and hand back the plaintext.
 *
 * Written directly rather than through `issueLoginCode` so that these tests
 * need no log capture to learn the code — and, more to the point, so that
 * issuing does not spend a *send* cap the submit tests are not about. The hash
 * is computed with the same HMAC and the same secret `verifyLoginCode` uses, so
 * what is stored is exactly what issuing would have stored.
 */
async function liveCodeFor(email: string): Promise<string> {
  const code = String(10_000_000 + (++seq % 10_000_000))
  await db()
    .insert(loginCodes)
    .values({
      id: crypto.randomUUID(),
      email,
      codeHash: await hmacHex(env.CODE_HMAC_SECRET, code),
      expiresAt: now() + CODE_TTL_S,
      createdAt: now(),
    })
  return code
}

/** Submit a code from a given caller, exactly as the route would. */
const submit = async (input: { email: string; code: string }, ip: string) =>
  (await inRequest(() => submitCode(input), { ip })).value

/** Open a session as the dashboard does: inside a request, with a cookie. */
const open = async (deviceId: string, cookie: string) =>
  (await inRequest(() => openSession(deviceId), { cookie, ip: freshIp() })).value

const sessionsOf = (userId: string) =>
  db().select().from(sessions).where(eq(sessions.userId, userId))

const userRow = async (userId: string) =>
  (await db().select().from(users).where(eq(users.id, userId)))[0]

describe('the rate_limits table', () => {
  it('is indexed on window_start, because the sweep ranges over it', async () => {
    // `sweepRateLimits` is `delete from rate_limits where window_start < ?`.
    // Without an index that is a full scan of every counter in the service —
    // one that gets slower exactly as the table gets bigger, which is to say
    // exactly when an unauthenticated caller is filling it.
    const { results } = await env.DB.prepare(
      "select name, sql from sqlite_master where type = 'index' and tbl_name = 'rate_limits'",
    ).all<{ name: string; sql: string | null }>()

    const onWindowStart = results.filter((row) => row.sql?.includes('window_start'))
    expect(onWindowStart).toHaveLength(1)
  })

  it('plans the sweep as an index scan, not a table scan', async () => {
    // The assertion above says an index exists; this one says the query planner
    // actually reaches for it — the two come apart the moment someone changes
    // the predicate (a function on the column, a different comparison) and the
    // index quietly stops applying.
    const { results } = await env.DB.prepare(
      'explain query plan delete from rate_limits where window_start < ?',
    )
      .bind(now())
      .all<{ detail: string }>()

    expect(results.map((row) => row.detail).join(' ')).toMatch(/USING (COVERING )?INDEX/i)
  })
})

describe('withinLimit: the window guard', () => {
  it('refuses a window longer than the sweep keeps rows for', async () => {
    // The sweep deletes every counter older than LONGEST_WINDOW_S, so a bucket
    // measured over anything longer would be swept *mid-window* and silently
    // start again from zero — a cap that reads like a cap and is not one. This
    // was prose in a comment until now; a comment cannot fail a build.
    await expect(
      withinLimit('too-long', 'somebody', 5, LONGEST_WINDOW_S + 1),
    ).rejects.toThrow(/LONGEST_WINDOW_S/)

    // And it refuses before it writes: a bucket that cannot be enforced does
    // not get to leave a row behind claiming it was.
    const key = await sha256Hex(`too-long:somebody`)
    expect(await db().select().from(rateLimits).where(eq(rateLimits.key, key))).toEqual([])
  })

  it('allows exactly the longest window', async () => {
    // The boundary is inclusive: LONGEST_WINDOW_S *is* the window the send caps
    // use, so an off-by-one here would break every login in the service.
    expect(await withinLimit('at-the-edge', `subject-${++seq}`, 2, LONGEST_WINDOW_S)).toBe(true)
  })
})

describe('submitCode: the per-IP cap', () => {
  it('stops answering after the cap, and does not spend the code it refused', async () => {
    // Guessing a code is already bounded — five attempts per code, claimed in
    // SQL. What is not bounded without this is the *cost*: every submission is
    // an unauthenticated HMAC plus a D1 write, and nothing about a wrong guess
    // makes it cheaper than a right one.
    const ip = freshIp()
    const user = await makeUser()

    for (let i = 0; i < CODE_SUBMITS_PER_IP; i++) {
      expect(await submit({ email: user.email, code: '00000000' }, ip)).toEqual({ ok: false })
    }

    // Over the cap now — and the refusal is the same one a wrong code gets.
    const code = await liveCodeFor(user.email)
    expect(await submit({ email: user.email, code }, ip)).toEqual({ ok: false })

    // The load-bearing half: that submission never reached the verifier. The
    // counter on the row is untouched — so a flood from one address cannot burn
    // a real user's code out from under them, which is what a cap that ran
    // *after* the verification would do.
    const [row] = await db().select().from(loginCodes).where(eq(loginCodes.email, user.email))
    expect(row?.attempts).toBe(0)

    // And the code itself still works, from a caller under its own cap.
    expect(await submit({ email: user.email, code }, freshIp())).toEqual({ ok: true })
  })

  it('caps the caller, not the account', async () => {
    const ip = freshIp()
    const user = await makeUser()
    for (let i = 0; i < CODE_SUBMITS_PER_IP; i++) {
      await submit({ email: user.email, code: '00000000' }, ip)
    }
    expect(await submit({ email: user.email, code: await liveCodeFor(user.email) }, ip)).toEqual({
      ok: false,
    })

    // A different person, behind a different address, is unaffected — a shared
    // office IP hitting the cap must not be a lockout for the account itself.
    const elsewhere = await makeUser()
    expect(
      await submit({ email: elsewhere.email, code: await liveCodeFor(elsewhere.email) }, freshIp()),
    ).toEqual({ ok: true })
  })

  it('says nothing but no', async () => {
    // Same shape, same keys, whether the cap fired or the code was wrong. A
    // "slow down" here would tell a caller which of its guesses were even read.
    const ip = freshIp()
    const user = await makeUser()
    for (let i = 0; i < CODE_SUBMITS_PER_IP; i++) {
      await submit({ email: user.email, code: '00000000' }, ip)
    }
    const capped = await submit({ email: user.email, code: '00000000' }, ip)
    const wrong = await submit({ email: (await makeUser()).email, code: '00000000' }, freshIp())

    expect(capped).toEqual(wrong)
    expect(Object.keys(capped)).toEqual(['ok'])
  })
})

describe('openSession: the per-user cap', () => {
  it('stops minting after the cap, and tells the person why', async () => {
    // Every call mints a bearer credential for the relay. The session behind it
    // is authenticated, so there is nothing to be coy about — but "authenticated"
    // is not "unlimited", and one compromised cookie should not be a token
    // faucet for as long as it lives.
    const user = await makeUser()
    const cookie = await signIn(user.id)
    const device = await makeDevice(user.id)

    for (let i = 0; i < SESSIONS_OPENED_PER_USER; i++) {
      expect((await open(device.id, cookie)).url).toContain('#t=')
    }

    await expect(open(device.id, cookie)).rejects.toThrow(DeviceError)
  })

  it('caps the account, not the machine', async () => {
    const user = await makeUser()
    const cookie = await signIn(user.id)
    const first = await makeDevice(user.id)
    const second = await makeDevice(user.id)

    for (let i = 0; i < SESSIONS_OPENED_PER_USER; i++) await open(first.id, cookie)

    // A second machine on the same account is over the same budget: the token
    // is minted for the *account*, so that is what the cap has to be about.
    await expect(open(second.id, cookie)).rejects.toThrow(DeviceError)

    // Somebody else is unaffected.
    const other = await makeUser()
    const theirs = await makeDevice(other.id)
    expect((await open(theirs.id, await signIn(other.id))).url).toContain('#t=')
  })

  it('refuses without saying anything about the machine', async () => {
    // The message is written for the person looking at the screen, and it is
    // the same sentence whichever machine they asked for — a cap is not a place
    // to start describing devices.
    const user = await makeUser()
    const cookie = await signIn(user.id)
    const device = await makeDevice(user.id)
    for (let i = 0; i < SESSIONS_OPENED_PER_USER; i++) await open(device.id, cookie)

    await expect(open(device.id, cookie)).rejects.toThrow(/Too many/i)
    // Not a database error escaping as one: drizzle prints bound parameters.
    await expect(open(device.id, cookie)).rejects.not.toThrow(/Failed query/)
  })
})

describe('the kill switch: a disabled user', () => {
  it('is no longer anybody, on the very next call', async () => {
    // Task 4 built this and sessions.test.ts pins it; it is re-asserted here
    // because "the switch" is one contract spread over three files, and this is
    // the file that says what the contract is.
    const user = await makeUser()
    const cookie = await signIn(user.id)
    expect((await inRequest(currentUser, { cookie })).value).toEqual({
      id: user.id,
      email: user.email,
    })

    await db().update(users).set({ disabled: true }).where(eq(users.id, user.id))
    expect((await inRequest(currentUser, { cookie })).value).toBeNull()
  })

  it('gets no tokens for any of their machines', async () => {
    const user = await makeUser()
    const cookie = await signIn(user.id)
    const device = await makeDevice(user.id)

    await db().update(users).set({ disabled: true }).where(eq(users.id, user.id))

    // The browser's mint refuses (there is no session left to resolve), and so
    // does the daemon's — which never had a session and would otherwise keep
    // reconnecting for as long as its enrollment token lived.
    await expect(inRequest(() => mintClientToken(device.id), { cookie })).rejects.toThrow(
      'mintClientToken: no session',
    )
    expect(await mintDaemonToken(device.id, device.enrollmentToken)).toBeNull()
  })

  it('drops every live session the moment disableUser runs', async () => {
    // The flag alone gates the *read*: `currentUser` refuses, but the rows stay,
    // so re-enabling an account hands back every cookie that was live when it
    // was switched off — for up to eight hours. An operator turning an account
    // off because a laptop was stolen means both.
    const user = await makeUser()
    const laptop = await signIn(user.id)
    const phone = await signIn(user.id)
    expect(await sessionsOf(user.id)).toHaveLength(2)

    // The count is the one thing an operator cannot read off the flag
    // afterwards, so it is part of the contract.
    expect(await disableUser(user.id)).toEqual({ sessionsDropped: 2 })

    expect((await userRow(user.id))?.disabled).toBe(true)
    expect(await sessionsOf(user.id)).toEqual([])
    expect((await inRequest(currentUser, { cookie: laptop })).value).toBeNull()
    expect((await inRequest(currentUser, { cookie: phone })).value).toBeNull()

    // And re-enabling does not resurrect them: the rows are gone, so the thief's
    // copy of the cookie is worthless whatever happens to the flag afterwards.
    await enableUser(user.id)
    expect((await userRow(user.id))?.disabled).toBe(false)
    expect((await inRequest(currentUser, { cookie: laptop })).value).toBeNull()
  })

  it('leaves everybody else signed in', async () => {
    const target = await makeUser()
    const bystander = await makeUser()
    await signIn(target.id)
    const theirs = await signIn(bystander.id)

    await disableUser(target.id)

    expect(await sessionsOf(bystander.id)).toHaveLength(1)
    expect((await inRequest(currentUser, { cookie: theirs })).value).toEqual({
      id: bystander.id,
      email: bystander.email,
    })
  })
})

describe('the kill switch: a disabled device', () => {
  it('gets no client token and no daemon token', async () => {
    const user = await makeUser()
    const cookie = await signIn(user.id)
    const device = await makeDevice(user.id)

    // Live first, so the refusal below is the flag and nothing else.
    expect((await inRequest(() => mintClientToken(device.id), { cookie })).value.token).toBeTruthy()

    await disableDevice(device.id)

    expect((await db().select().from(devices).where(eq(devices.id, device.id)))[0]?.disabled).toBe(
      true,
    )
    await expect(inRequest(() => mintClientToken(device.id), { cookie })).rejects.toThrow(
      'mintClientToken: no such device',
    )
    expect(await mintDaemonToken(device.id, device.enrollmentToken)).toBeNull()

    // The owner is untouched: one machine off is not the whole account off.
    expect((await inRequest(currentUser, { cookie })).value).toEqual({
      id: user.id,
      email: user.email,
    })
  })
})

describe('the scheduled sweep', () => {
  /** One row per table the sweep is responsible for, identified as the seed left it. */
  interface SeededRows {
    /** `rate_limits.key`. */
    rateLimit: string
    /** `device_auth.user_code`. */
    grant: string
    /** `sessions.id`. */
    session: string
    /** `login_codes.email`. */
    code: string
  }

  /** One expired row in each table the sweep is responsible for, plus a live one. */
  async function seed(): Promise<{ stale: SeededRows; live: SeededRows }> {
    const user = await makeUser()
    const at = now()

    const staleKey = await sha256Hex(`sweep-stale:${++seq}`)
    const liveKey = await sha256Hex(`sweep-live:${++seq}`)
    await db()
      .insert(rateLimits)
      .values([
        { key: staleKey, windowStart: at - LONGEST_WINDOW_S - 60, count: 1 },
        { key: liveKey, windowStart: at, count: 1 },
      ])

    const staleGrant = `STALE${++seq}`
    const liveGrant = `LIVE${++seq}`
    await db()
      .insert(deviceAuth)
      .values([
        {
          userCode: staleGrant,
          deviceCode: await sha256Hex(`grant-stale-${seq}`),
          label: 'old',
          createdAt: at - 1200,
          expiresAt: at - 60,
        },
        {
          userCode: liveGrant,
          deviceCode: await sha256Hex(`grant-live-${seq}`),
          label: 'new',
          createdAt: at,
          expiresAt: at + 600,
        },
      ])

    const staleSession = await sha256Hex(`session-stale-${++seq}`)
    const liveSession = await sha256Hex(`session-live-${++seq}`)
    await db()
      .insert(sessions)
      .values([
        { id: staleSession, userId: user.id, createdAt: at - 100_000, expiresAt: at - 60 },
        { id: liveSession, userId: user.id, createdAt: at, expiresAt: at + 3600 },
      ])

    const staleCodeEmail = `sweep-stale-${++seq}@example.com`
    const liveCodeEmail = `sweep-live-${++seq}@example.com`
    await db()
      .insert(loginCodes)
      .values([
        {
          id: crypto.randomUUID(),
          email: staleCodeEmail,
          codeHash: 'x'.repeat(64),
          expiresAt: at - 60,
          createdAt: at - 700,
        },
        {
          id: crypto.randomUUID(),
          email: liveCodeEmail,
          codeHash: 'y'.repeat(64),
          expiresAt: at + 600,
          createdAt: at,
        },
      ])

    return {
      stale: { rateLimit: staleKey, grant: staleGrant, session: staleSession, code: staleCodeEmail },
      live: { rateLimit: liveKey, grant: liveGrant, session: liveSession, code: liveCodeEmail },
    }
  }

  /** How many of the four seeded rows are still there — one number per table. */
  async function survivors(rows: SeededRows): Promise<Record<keyof SeededRows, number>> {
    return {
      rateLimit: (await db().select().from(rateLimits).where(eq(rateLimits.key, rows.rateLimit)))
        .length,
      grant: (await db().select().from(deviceAuth).where(eq(deviceAuth.userCode, rows.grant)))
        .length,
      session: (await db().select().from(sessions).where(eq(sessions.id, rows.session))).length,
      code: (await db().select().from(loginCodes).where(eq(loginCodes.email, rows.code))).length,
    }
  }

  it('collects every expired row and keeps every live one', async () => {
    // Four tables, one pass. Each of them is written by an *unauthenticated*
    // caller (a counter per address anyone types, a grant per `flue enable`, a
    // code per request) or grows with every login, and nothing reads an expired
    // row — so what is left without this is a table that only ever grows.
    const { stale, live } = await seed()

    await runScheduledSweeps()

    expect(await survivors(stale)).toEqual({ rateLimit: 0, grant: 0, session: 0, code: 0 })
    expect(await survivors(live)).toEqual({ rateLimit: 1, grant: 1, session: 1, code: 1 })
  })

  it('is what the Worker’s cron trigger runs', async () => {
    // The sweeps used to ride on a 1-in-100 coin flip on ordinary traffic,
    // which means a service nobody is using never collects — and a service
    // somebody is *flooding* collects on their schedule, not ours. This asserts
    // the wiring itself rather than the function: the Worker's `scheduled`
    // export (src/server.ts — the file wrangler.jsonc names as `main`, so this
    // is the entry Cloudflare's scheduler reaches), invoked the way the runtime
    // invokes it, is what empties the tables.
    //
    // Not through `SELF`: the pool's stub only speaks `fetch`, and a scheduled
    // invocation is not a request. `createScheduledController` is the pool's
    // own supported shape for exactly this.
    const { stale, live } = await seed()

    const controller = createScheduledController({ scheduledTime: new Date(), cron: '17 * * * *' })
    const ctx = createExecutionContext()
    // Optional in the `ExportedHandler` type — asserted here, because "the
    // export exists" is half of what this test is about.
    expect(typeof worker.scheduled).toBe('function')
    await worker.scheduled?.(controller, env, ctx)
    await waitOnExecutionContext(ctx)

    expect(await survivors(stale)).toEqual({ rateLimit: 0, grant: 0, session: 0, code: 0 })
    expect(await survivors(live)).toEqual({ rateLimit: 1, grant: 1, session: 1, code: 1 })
  })
})
