// Re-minting a browser's channel token, which is what makes a SaaS session
// survive its own first minute.
//
// A client token lives 60 seconds (`CLIENT_TOKEN_TTL_S`) and the browser's
// relay socket presents one per dial. The token captured at "open a session"
// therefore covers the first dial and nothing after it: a laptop lid, a train
// tunnel, a Cloudflare edge dropping an idle socket — anything that costs the
// tab a reconnect past that minute — is refused at the upgrade, and the tab
// reconnects into the same refusal forever. `refreshClientToken` is the
// endpoint that closes that loop.
//
// Two properties are worth stating up front, because they are the whole reason
// this is a separate function and not `mintClientToken` with a different name:
//
//   1. **It is the same authorization decision.** Ownership and both kill
//      switches are re-stated in `mintClientToken`'s own SQL predicate, which
//      this calls; a device revoked mid-session stops getting tokens on the
//      next dial. That is the revocation path, and the tests below are what
//      say it did not get looser on the way through a second entry point.
//
//   2. **It has its own rate-limit buckets, and they are per machine.**
//      `openSession` counts against `open-session:user` — 30 in fifteen
//      minutes, a cap sized for a human clicking a button. A reconnect is not a
//      human: FlueClient's backoff tops out at ten seconds, so one tab in a bad
//      hour can legitimately ask for dozens. Sharing the bucket would mean a
//      flaky network locking the account out of opening *new* sessions, and a
//      tighter cap on reconnects than the reconnect loop itself produces.
//      And the reconnect bucket is keyed by (account, machine) rather than by
//      account, because a tab pointed at a machine that is asleep or revoked
//      loops forever — on one shared bucket that dead tab spends the account's
//      whole budget and 429s every session the person is actually watching.
//      An account-wide ceiling sits above it, far enough up that only a caller
//      inventing machines can reach it.
//
// The pool isolates storage per test *file*, not per test: every test mints its
// own user and device, and nothing may assume an empty table.
import { env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { db } from '../src/db/client'
import { devices, rateLimits, users } from '../src/db/schema'
import { base64url, randomToken, sha256Hex, verifyChannelToken } from '../src/lib/tokens'
import { CLIENT_TOKEN_TTL_S } from '../src/server/channel-token'
import { openSession } from '../src/server/devices'
import {
  TOKENS_REFRESHED_PER_DEVICE,
  TOKENS_REFRESHED_PER_USER,
  refreshClientToken,
} from '../src/server/refresh-token'
import { SESSION_COOKIE, createSession } from '../src/server/sessions'
import { inRequest } from './request'

const now = () => Math.floor(Date.now() / 1000)

/** Bumped by every helper below, so no two callers in this file collide. */
let seq = 0

const freshIp = () => `198.51.100.${++seq % 256}`

const SECRET = env.RELAY_SIGNING_SECRET

async function makeUser(disabled = false): Promise<{ id: string; email: string }> {
  const user = { id: crypto.randomUUID(), email: `ref-${++seq}-${crypto.randomUUID()}@example.com` }
  await db().insert(users).values({ ...user, createdAt: now(), disabled })
  return user
}

async function makeDevice(userId: string, opts: { disabled?: boolean } = {}): Promise<{ id: string }> {
  const id = (await sha256Hex(`device-${++seq}-${crypto.randomUUID()}`)).slice(0, 12)
  await db()
    .insert(devices)
    .values({
      id,
      userId,
      label: `machine ${seq}`,
      publicKey: base64url(crypto.getRandomValues(new Uint8Array(32))),
      tokenHash: await sha256Hex(randomToken()),
      createdAt: now(),
      disabled: opts.disabled ?? false,
    })
  return { id }
}

/** Sign `userId` in and hand back the Cookie header a browser would send. */
async function signIn(userId: string): Promise<string> {
  const { setCookie } = await inRequest(() => createSession(userId), { ip: freshIp() })
  const header = setCookie.find((c) => c.startsWith(`${SESSION_COOKIE}=`))
  if (!header) throw new Error('createSession set no session cookie')
  return `${SESSION_COOKIE}=${header.slice(`${SESSION_COOKIE}=`.length).split(';')[0]}`
}

/** The call as the tab makes it: inside a request, with a session cookie. */
const refresh = async (deviceId: string, cookie?: string) =>
  (await inRequest(() => refreshClientToken(deviceId), { cookie, ip: freshIp() })).value

const open = async (deviceId: string, cookie?: string) =>
  (await inRequest(() => openSession(deviceId), { cookie, ip: freshIp() })).value

describe('refreshClientToken', () => {
  it('mints a fresh client token for a machine the caller owns', async () => {
    const user = await makeUser()
    const device = await makeDevice(user.id)

    const { token } = await refresh(device.id, await signIn(user.id))

    const claims = await verifyChannelToken(SECRET, token)
    expect(claims).toMatchObject({ acc: user.id, dev: device.id, role: 'client' })
    // The same sixty seconds `openSession` hands out, from *now* rather than
    // from whenever the tab was opened — which is the entire point of the call.
    expect(claims?.exp).toBeGreaterThan(now())
    expect(claims?.exp).toBeLessThanOrEqual(now() + CLIENT_TOKEN_TTL_S)
  })

  it('dates every token from the call, not from the session', async () => {
    // The property that makes a reconnect work, stated as the thing that would
    // break if someone cached a grant: each answer's expiry is measured from
    // *this* call. Two calls inside the same second produce the same bytes —
    // the claims are `{acc, dev, role, exp}` and `exp` has one-second
    // resolution, so an identical token is a correct token, not a stale one —
    // and what has to hold is that neither of them is the one minted when the
    // tab was opened.
    const user = await makeUser()
    const device = await makeDevice(user.id)
    const cookie = await signIn(user.id)

    const before = now()
    const first = await refresh(device.id, cookie)
    const second = await refresh(device.id, cookie)

    for (const { token } of [first, second]) {
      const claims = await verifyChannelToken(SECRET, token)
      expect(claims).not.toBeNull()
      expect(claims?.exp).toBeGreaterThanOrEqual(before + CLIENT_TOKEN_TTL_S)
      expect(claims?.exp).toBeLessThanOrEqual(now() + CLIENT_TOKEN_TTL_S)
    }
  })

  it('refuses without a session', async () => {
    const user = await makeUser()
    const device = await makeDevice(user.id)
    await expect(refresh(device.id)).rejects.toThrow()
  })

  it('refuses a machine the caller does not own', async () => {
    const owner = await makeUser()
    const mallory = await makeUser()
    const device = await makeDevice(owner.id)
    await expect(refresh(device.id, await signIn(mallory.id))).rejects.toThrow()
  })

  it('refuses a machine that does not exist, in the same words', async () => {
    // One refusal for "no such device" and "not yours", or this is an
    // existence oracle for other people's device ids.
    const user = await makeUser()
    const owner = await makeUser()
    const theirs = await makeDevice(owner.id)
    const cookie = await signIn(user.id)

    const missing = await refresh('ffffffffffff', cookie).catch((e: Error) => e.message)
    const notMine = await refresh(theirs.id, cookie).catch((e: Error) => e.message)
    expect(missing).toBe(notMine)
  })

  it('refuses a machine flue has switched off', async () => {
    const user = await makeUser()
    const device = await makeDevice(user.id, { disabled: true })
    await expect(refresh(device.id, await signIn(user.id))).rejects.toThrow()
  })

  it('refuses every machine of a user flue has switched off', async () => {
    // The revocation path this endpoint exists on: a disabled account stops
    // getting tokens on its next dial, whatever it is holding right now.
    const user = await makeUser(true)
    const device = await makeDevice(user.id)
    await expect(refresh(device.id, await signIn(user.id))).rejects.toThrow()
  })

  it('refuses an oversized device id without a query', async () => {
    const user = await makeUser()
    await expect(refresh('f'.repeat(500), await signIn(user.id))).rejects.toThrow()
  })
})

describe('the refresh rate limit', () => {
  it('caps refreshes per machine, and says so', async () => {
    const user = await makeUser()
    const device = await makeDevice(user.id)
    const cookie = await signIn(user.id)

    for (let i = 0; i < TOKENS_REFRESHED_PER_DEVICE; i++) {
      expect((await refresh(device.id, cookie)).token).toBeTruthy()
    }
    await expect(refresh(device.id, cookie)).rejects.toThrow(/too many/i)
  })

  it('lets one machine’s dead tab starve only itself', async () => {
    // The bug this bucket shape exists to prevent, and it is an availability
    // bug rather than a security one. A tab pointed at a machine that is
    // asleep, offline or revoked reconnect-loops on FlueClient's 5–10s backoff
    // — 90–180 refreshes per fifteen minutes — and `withinLimit` counts the
    // refused calls too. On one account-wide bucket a handful of those dead
    // tabs spend the whole budget and every *healthy* session on the account
    // is answered 429 at its next reconnect: a machine nobody is watching
    // takes down the machine somebody is.
    const user = await makeUser()
    const dead = await makeDevice(user.id)
    const healthy = await makeDevice(user.id)
    const cookie = await signIn(user.id)

    for (let i = 0; i < TOKENS_REFRESHED_PER_DEVICE; i++) await refresh(dead.id, cookie)
    await expect(refresh(dead.id, cookie)).rejects.toThrow(/too many/i)

    expect((await refresh(healthy.id, cookie)).token).toBeTruthy()
  })

  it('does not spend another account’s allowance', async () => {
    const heavy = await makeUser()
    const quiet = await makeUser()
    const theirs = await makeDevice(heavy.id)
    const mine = await makeDevice(quiet.id)

    const heavyCookie = await signIn(heavy.id)
    for (let i = 0; i < TOKENS_REFRESHED_PER_DEVICE; i++) await refresh(theirs.id, heavyCookie)

    expect((await refresh(mine.id, await signIn(quiet.id))).token).toBeTruthy()
  })

  it('still holds an account-wide ceiling above the per-machine cap', async () => {
    // The per-machine bucket bounds a reconnect loop; it does not bound a
    // *caller*, who can name a new machine per request and buy a fresh one
    // each time. The ceiling is what keeps a stolen session cookie from being
    // an unbounded token faucet (and an unbounded supply of counter rows).
    //
    // Spent by seeding the counter rather than by making six thousand calls:
    // the key is `sha256(bucket:subject)` (server/ratelimit.ts), so writing the
    // row directly pins the bucket name *and* the subject shape — the property
    // under test is that the ceiling is named by the user and by nothing else.
    // A seed under the wrong name would leave the ceiling unspent and this
    // test would fail with a token in its hand.
    const user = await makeUser()
    const device = await makeDevice(user.id)
    const cookie = await signIn(user.id)

    await db()
      .insert(rateLimits)
      .values({
        key: await sha256Hex(`refresh-token:user:${user.id}`),
        windowStart: now(),
        count: TOKENS_REFRESHED_PER_USER,
      })

    await expect(refresh(device.id, cookie)).rejects.toThrow(/too many/i)
  })

  it('is not the machine’s cap in disguise', async () => {
    // Two numbers, and the ceiling has to be the larger one or the per-machine
    // bucket would never be the thing that fires.
    expect(TOKENS_REFRESHED_PER_USER).toBeGreaterThan(TOKENS_REFRESHED_PER_DEVICE)
  })

  it('is a different bucket from opening a session', async () => {
    // The one that matters most. `openSession` allows 30 per window; a tab
    // reconnecting through a bad hour spends far more than that on refreshes.
    // If the two shared a bucket, a flaky network would lock the account out
    // of opening new sessions — and, the other way round, thirty clicks would
    // strand every open tab at its next reconnect.
    const user = await makeUser()
    const device = await makeDevice(user.id)
    const cookie = await signIn(user.id)

    for (let i = 0; i < TOKENS_REFRESHED_PER_DEVICE; i++) await refresh(device.id, cookie)
    await expect(refresh(device.id, cookie)).rejects.toThrow(/too many/i)

    // Refreshes are spent; opening a session still works.
    expect((await open(device.id, cookie)).url).toContain('#')
  })
})
