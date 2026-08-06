// Enrolling a daemon: the device-authorization handshake behind `flue enable`.
//
// Three calls, two of them unauthenticated, and the whole point of the file is
// the seam between them — what is stored, what is handed back, and exactly
// once. Everything runs against a real (local) D1 through the same `db()`
// production uses, and inside a real Start request context, because two of the
// three read a cookie or a client IP.
//
// The pool isolates storage per test *file*, not per test: every test below
// mints its own user, its own key and its own caller, and nothing may assume an
// empty table.
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { db } from '../src/db/client'
import { deviceAuth, devices, users } from '../src/db/schema'
import { deviceIdFor, encodePublicKey } from '../src/lib/device-id'
import { sha256Hex } from '../src/lib/tokens'
import {
  DEVICE_AUTH_TTL_S,
  GRANTS_PER_IP,
  confirmDeviceAuth,
  pollDeviceAuth,
  startDeviceAuth,
} from '../src/server/enroll'
import { SESSION_COOKIE, createSession } from '../src/server/sessions'
import { inRequest } from './request'

/**
 * The cross-language vector.
 *
 * These are the initiator's static keys from testdata/noise/ik.json — bytes
 * that already have a name on both sides of the wire — and `b5d05f15398a` is
 * what Go's `crypto.DeviceID` returns for them. `internal/crypto`'s
 * `TestDeviceIDVector` asserts the identical pair, so the two derivations
 * cannot drift apart without one of the two tests going red.
 *
 * Why it matters: the daemon computes its own id from its own key and is then
 * addressed by that id everywhere else — the relay's account scoping, the
 * device list, revocation. If flue.sh derived a different id, a daemon and the
 * service would disagree about who it is and nothing else in either system
 * would notice.
 */
const VECTOR_PUBLIC_KEY = 'B8SYMazoUcTIYa1PqLyFDhjGEocxvfVjEHaSC8HolBE='
const VECTOR_DEVICE_ID = 'b5d05f15398a'

const now = () => Math.floor(Date.now() / 1000)

/** Bumped by every helper below, so no two callers in this file share a bucket. */
let seq = 0

/** A caller nobody else in this file is, so the per-IP cap never crosses tests. */
const freshIp = () => `198.51.100.${++seq % 256}`

/** A fresh 32-byte Noise static, base64 as the daemon would send it. */
function freshKey(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return encodePublicKey(bytes)
}

async function makeUser(): Promise<{ id: string; email: string }> {
  const user = { id: crypto.randomUUID(), email: `enroll-${++seq}-${crypto.randomUUID()}@example.com` }
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

/** `startDeviceAuth` as a daemon calls it: unauthenticated, from its own IP. */
async function start(input: { label?: string; publicKey?: string } = {}) {
  const { value } = await inRequest(
    () =>
      startDeviceAuth({
        label: input.label ?? 'test daemon',
        publicKey: input.publicKey ?? freshKey(),
      }),
    { ip: freshIp() },
  )
  return value
}

/** `pollDeviceAuth` as a daemon calls it: unauthenticated. */
async function poll(deviceCode: string) {
  const { value } = await inRequest(() => pollDeviceAuth({ deviceCode }), { ip: freshIp() })
  return value
}

/** `confirmDeviceAuth` as the browser calls it: with a session cookie. */
async function confirm(userCode: string, cookie: string) {
  const { value } = await inRequest(() => confirmDeviceAuth({ userCode }), {
    cookie,
    ip: freshIp(),
  })
  return value
}

describe('the device id', () => {
  it('matches the id the Go daemon derives for the same key', async () => {
    expect(await deviceIdFor(VECTOR_PUBLIC_KEY)).toBe(VECTOR_DEVICE_ID)
  })

  it('is twelve lowercase hex characters, like crypto.DeviceID', async () => {
    expect(await deviceIdFor(freshKey())).toMatch(/^[0-9a-f]{12}$/)
  })

  it('derives from the key bytes, not from how they were spelled', async () => {
    // The daemon sends standard base64; base64url is the same 32 bytes with
    // two characters swapped. A digest of the *text* would give two ids for
    // one key — and therefore two device rows for one daemon.
    const urlSpelling = VECTOR_PUBLIC_KEY.replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
    expect(await deviceIdFor(urlSpelling)).toBe(VECTOR_DEVICE_ID)
  })
})

describe('startDeviceAuth', () => {
  it('mints a human-typable code and an opaque one, and stores only a digest of the opaque one', async () => {
    const grant = await start({ publicKey: VECTOR_PUBLIC_KEY, label: 'mac studio' })

    // What the human reads off their terminal.
    expect(grant.userCode).toMatch(/^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/)
    // What the daemon holds and presents on every poll: 32 bytes, base64url.
    expect(grant.deviceCode).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(grant.expiresIn).toBe(DEVICE_AUTH_TTL_S)
    expect(grant.verificationUrl).toMatch(/\/enroll$/)
    expect(grant.verificationUrlComplete).toContain(encodeURIComponent(grant.userCode))

    const [row] = await db()
      .select()
      .from(deviceAuth)
      .where(eq(deviceAuth.userCode, grant.userCode.replace('-', '')))

    expect(row).toBeDefined()
    // The bearer secret is not in the row; its digest is.
    expect(row?.deviceCode).toBe(await sha256Hex(grant.deviceCode))
    expect(row?.deviceCode).not.toBe(grant.deviceCode)
    expect(row?.label).toBe('mac studio')
    expect(row?.publicKey).toBe(VECTOR_PUBLIC_KEY)
    // Nothing is approved by minting.
    expect(row?.approvedUserId).toBeNull()
    expect(row?.deviceId).toBeNull()
    expect(row?.expiresAt).toBeGreaterThan(now())
  })

  it('refuses a public key that is not 32 bytes', async () => {
    await expect(start({ publicKey: 'aGVsbG8=' })).rejects.toThrow()
    await expect(start({ publicKey: 'not base64 at all !!' })).rejects.toThrow()
    await expect(start({ publicKey: '' })).rejects.toThrow()
    // 33 bytes: the right shape, the wrong length.
    const long = new Uint8Array(33)
    crypto.getRandomValues(long)
    await expect(start({ publicKey: encodePublicKey(long) })).rejects.toThrow()
  })

  it('stores one spelling of a key however the daemon spelled it', async () => {
    const grant = await start({
      publicKey: VECTOR_PUBLIC_KEY.replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, ''),
    })
    const [row] = await db()
      .select()
      .from(deviceAuth)
      .where(eq(deviceAuth.userCode, grant.userCode.replace('-', '')))
    expect(row?.publicKey).toBe(VECTOR_PUBLIC_KEY)
  })

  it('caps how many grants one caller may open', async () => {
    // Unauthenticated, and every call writes a row: without a cap the table is
    // whatever an unauthenticated caller feels like making it.
    const ip = freshIp()
    const open = () =>
      inRequest(() => startDeviceAuth({ label: 'flood', publicKey: freshKey() }), { ip })

    for (let i = 0; i < GRANTS_PER_IP; i++) await open()
    await expect(open()).rejects.toThrow()
  })

  it('bounds the label rather than storing whatever arrived', async () => {
    const grant = await start({ label: `\u001b[31mred alert ${'x'.repeat(500)}` })
    const [row] = await db()
      .select()
      .from(deviceAuth)
      .where(eq(deviceAuth.userCode, grant.userCode.replace('-', '')))
    expect(row?.label.length).toBeLessThanOrEqual(64)
    // Control characters are stripped: this label is chosen by whoever runs
    // the daemon and is printed straight into a terminal by `flue devices` —
    // an unfiltered escape sequence there is somebody else's cursor.
    expect(row?.label).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/)
  })
})

describe('pollDeviceAuth', () => {
  it('is pending until somebody confirms', async () => {
    const grant = await start()
    expect(await poll(grant.deviceCode)).toEqual({ status: 'pending' })
  })

  it('cannot be polled with what the database stores', async () => {
    // The dump test. `device_auth.device_code` holds SHA-256 of the code, so
    // everything an attacker can read out of the table is useless as a poll.
    const grant = await start()
    const stored = await sha256Hex(grant.deviceCode)
    expect(await poll(stored)).toEqual({ status: 'expired' })
  })

  it('reports expired for a code nobody minted', async () => {
    expect(await poll('a'.repeat(43))).toEqual({ status: 'expired' })
    expect(await poll('')).toEqual({ status: 'expired' })
  })

  it('reports expired once the grant has aged out, and clears the row', async () => {
    const deviceCode = 'expired-grant-code-for-the-ttl-test'
    const userCode = 'ZZZZZZZZ'
    await db()
      .insert(deviceAuth)
      .values({
        userCode,
        deviceCode: await sha256Hex(deviceCode),
        label: 'stale',
        createdAt: now() - DEVICE_AUTH_TTL_S - 60,
        expiresAt: now() - 1,
        publicKey: freshKey(),
      })

    expect(await poll(deviceCode)).toEqual({ status: 'expired' })
    expect(await db().select().from(deviceAuth).where(eq(deviceAuth.userCode, userCode))).toEqual(
      [],
    )
  })
})

describe('confirmDeviceAuth', () => {
  it('refuses to run without a session', async () => {
    const grant = await start()
    await expect(
      inRequest(() => confirmDeviceAuth({ userCode: grant.userCode }), { ip: freshIp() }),
    ).rejects.toThrow()

    // And the grant is untouched: an unauthenticated caller approves nothing.
    const [row] = await db()
      .select()
      .from(deviceAuth)
      .where(eq(deviceAuth.userCode, grant.userCode.replace('-', '')))
    expect(row?.approvedUserId).toBeNull()
  })

  it('binds the grant to the signed-in user without creating the device yet', async () => {
    const user = await makeUser()
    const cookie = await signIn(user.id)
    const grant = await start({ publicKey: VECTOR_PUBLIC_KEY, label: 'mac studio' })

    const result = await confirm(grant.userCode, cookie)
    expect(result).toEqual({ ok: true, deviceId: VECTOR_DEVICE_ID, label: 'mac studio' })

    const [row] = await db()
      .select()
      .from(deviceAuth)
      .where(eq(deviceAuth.userCode, grant.userCode.replace('-', '')))
    expect(row?.approvedUserId).toBe(user.id)
    expect(row?.deviceId).toBe(VECTOR_DEVICE_ID)

    // The device is minted by the approving poll, not here: there is nowhere
    // to keep a raw token between the two requests, and `devices.token_hash`
    // is NOT NULL.
    expect(await db().select().from(devices).where(eq(devices.id, VECTOR_DEVICE_ID))).toEqual([])
  })

  it('accepts the code the way a person types it', async () => {
    const user = await makeUser()
    const cookie = await signIn(user.id)
    const grant = await start()

    // Lowercase, spaced, extra punctuation — the code is read off a terminal
    // and typed into a browser, and `user_code` is a TEXT primary key SQLite
    // compares byte for byte.
    const typed = ` ${grant.userCode.toLowerCase().replace('-', ' — ')} `
    expect(await confirm(typed, cookie)).toMatchObject({ ok: true })
  })

  it('is a no-op the second time the same user confirms', async () => {
    const user = await makeUser()
    const cookie = await signIn(user.id)
    const grant = await start()

    const first = await confirm(grant.userCode, cookie)
    const second = await confirm(grant.userCode, cookie)
    expect(second).toEqual(first)
  })

  it('refuses a code somebody else has already approved', async () => {
    const owner = await makeUser()
    const stranger = await makeUser()
    const grant = await start()

    await confirm(grant.userCode, await signIn(owner.id))
    expect(await confirm(grant.userCode, await signIn(stranger.id))).toEqual({ ok: false })

    // Still the first user's, not the second's.
    const [row] = await db()
      .select()
      .from(deviceAuth)
      .where(eq(deviceAuth.userCode, grant.userCode.replace('-', '')))
    expect(row?.approvedUserId).toBe(owner.id)
  })

  it('refuses a code that has expired, and one that never existed', async () => {
    const user = await makeUser()
    const cookie = await signIn(user.id)

    await db()
      .insert(deviceAuth)
      .values({
        userCode: 'XXXXXXXX',
        deviceCode: await sha256Hex('dead-grant'),
        label: 'stale',
        createdAt: now() - DEVICE_AUTH_TTL_S - 60,
        expiresAt: now() - 1,
        publicKey: freshKey(),
      })

    expect(await confirm('XXXX-XXXX', cookie)).toEqual({ ok: false })
    expect(await confirm('BBBB-BBBB', cookie)).toEqual({ ok: false })
  })
})

describe('the approving poll', () => {
  it('mints the token once, creates the device, and burns the grant', async () => {
    const user = await makeUser()
    const cookie = await signIn(user.id)
    const grant = await start({ publicKey: VECTOR_PUBLIC_KEY, label: 'mac studio' })

    expect(await poll(grant.deviceCode)).toEqual({ status: 'pending' })
    await confirm(grant.userCode, cookie)

    const approved = await poll(grant.deviceCode)
    expect(approved.status).toBe('approved')
    if (approved.status !== 'approved') throw new Error('unreachable')
    // The id the daemon computed for itself.
    expect(approved.deviceId).toBe(VECTOR_DEVICE_ID)
    expect(approved.deviceToken).toMatch(/^[A-Za-z0-9_-]{43}$/)

    // The device exists, owned by the user who confirmed, holding the token's
    // digest and not the token.
    const [device] = await db().select().from(devices).where(eq(devices.id, VECTOR_DEVICE_ID))
    expect(device).toMatchObject({
      id: VECTOR_DEVICE_ID,
      userId: user.id,
      label: 'mac studio',
      publicKey: VECTOR_PUBLIC_KEY,
      disabled: false,
    })
    expect(device?.tokenHash).toBe(await sha256Hex(approved.deviceToken as string))
    expect(device?.tokenHash).not.toBe(approved.deviceToken)

    // And the grant is gone in the same breath — an approved code that
    // survived would mint a device per poll until it expired.
    expect(
      await db()
        .select()
        .from(deviceAuth)
        .where(eq(deviceAuth.userCode, grant.userCode.replace('-', ''))),
    ).toEqual([])
  })

  it('has nothing left to hand over on the next poll', async () => {
    const user = await makeUser()
    const cookie = await signIn(user.id)
    const grant = await start()
    await confirm(grant.userCode, cookie)

    const first = await poll(grant.deviceCode)
    expect(first.status).toBe('approved')

    // The daemon stops polling once it holds a token; anything that keeps
    // polling gets no second one.
    const second = await poll(grant.deviceCode)
    if (second.status === 'approved') expect(second.deviceToken).toBeUndefined()
    else expect(second.status).toBe('expired')
  })

  it('never writes the token anywhere', async () => {
    const user = await makeUser()
    const cookie = await signIn(user.id)
    const grant = await start()
    await confirm(grant.userCode, cookie)

    const approved = await poll(grant.deviceCode)
    if (approved.status !== 'approved' || !approved.deviceToken) {
      throw new Error('the approving poll returned no token')
    }

    // Every cell of every table this flow touches, read back and searched for
    // the two bearer secrets it handed out.
    const dump = JSON.stringify([
      await db().select().from(devices),
      await db().select().from(deviceAuth),
      await db().select().from(users),
    ])
    expect(dump).not.toContain(approved.deviceToken)
    expect(dump).not.toContain(grant.deviceCode)
  })
})

describe('re-enrolment', () => {
  it('replaces the device row when the same key enrolls again', async () => {
    // `devices.id` is sha256(pubkey)[:12], so a daemon that enrolls twice —
    // after a revoke, or onto a second account — collides on the primary key.
    const first = await makeUser()
    const second = await makeUser()
    const publicKey = freshKey()
    const deviceId = await deviceIdFor(publicKey)

    const one = await start({ publicKey, label: 'before' })
    await confirm(one.userCode, await signIn(first.id))
    const approvedOnce = await poll(one.deviceCode)
    if (approvedOnce.status !== 'approved') throw new Error('the first enrolment did not approve')

    const two = await start({ publicKey, label: 'after' })
    await confirm(two.userCode, await signIn(second.id))
    const approvedTwice = await poll(two.deviceCode)
    if (approvedTwice.status !== 'approved') throw new Error('the second enrolment did not approve')

    expect(approvedTwice.deviceId).toBe(deviceId)
    expect(approvedTwice.deviceToken).not.toBe(approvedOnce.deviceToken)

    // One row, not two, and it is the second enrolment's: new owner, new
    // label, new token. The first token no longer matches anything.
    const rows = await db().select().from(devices).where(eq(devices.id, deviceId))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ userId: second.id, label: 'after' })
    expect(rows[0]?.tokenHash).toBe(await sha256Hex(approvedTwice.deviceToken as string))

    const staleHash = await sha256Hex(approvedOnce.deviceToken as string)
    expect(await db().select().from(devices).where(eq(devices.tokenHash, staleHash))).toEqual([])
  })

  it('clears a revocation when the key comes back', async () => {
    const user = await makeUser()
    const publicKey = freshKey()
    const deviceId = await deviceIdFor(publicKey)

    const one = await start({ publicKey })
    await confirm(one.userCode, await signIn(user.id))
    await poll(one.deviceCode)
    // The kill switch, flipped between enrolments.
    await db().update(devices).set({ disabled: true }).where(eq(devices.id, deviceId))

    const two = await start({ publicKey })
    await confirm(two.userCode, await signIn(user.id))
    expect((await poll(two.deviceCode)).status).toBe('approved')

    const [row] = await db().select().from(devices).where(eq(devices.id, deviceId))
    // A fresh enrolment is a fresh device: it does not inherit the old row's
    // disabled flag or its last-seen stamp.
    expect(row?.disabled).toBe(false)
    expect(row?.lastSeen).toBeNull()
  })
})
