// The device directory: what a signed-in person may see and do to their own
// machines, and — the part that matters — what they may not do to anyone
// else's.
//
// Everything here runs against a real (local) D1 through the same `db()`
// production uses, and inside a real Start request, because every one of these
// calls resolves the session off a cookie.
//
// The property under test in almost every case below is the same one, stated
// four different ways: **ownership lives in the SQL predicate**. Not in a read
// followed by a check followed by a write — that is a race and, worse, a shape
// where deleting the check leaves the code still looking correct. `where id = ?
// and user_id = ?` cannot be half-applied: a device that is not yours matches
// no rows, so the statement writes nothing and there is nothing to report but
// the same refusal a missing device gets.
//
// The pool isolates storage per test *file*, not per test: every test below
// mints its own user and its own devices, and nothing may assume an empty
// table.
import { env } from 'cloudflare:test'
import { eq } from 'drizzle-orm'
import { describe, expect, it, vi } from 'vitest'
import { db } from '../src/db/client'
import { devices, users } from '../src/db/schema'
import { base64url, randomToken, sha256Hex, verifyChannelToken } from '../src/lib/tokens'
import { mintClientToken } from '../src/server/channel-token'
import { MAX_LABEL, listDevices, openSession, renameDevice, revokeDevice } from '../src/server/devices'
import { SESSION_COOKIE, createSession } from '../src/server/sessions'
import { inRequest } from './request'

const now = () => Math.floor(Date.now() / 1000)

/** Bumped by every helper below, so no two callers in this file collide. */
let seq = 0

const freshIp = () => `198.51.100.${++seq % 256}`

/** The secret and the relay the pool binds; production sets both per Worker. */
const SECRET = env.RELAY_SIGNING_SECRET
const RELAY_URL = env.RELAY_URL

async function makeUser(): Promise<{ id: string; email: string }> {
  const user = { id: crypto.randomUUID(), email: `dev-${++seq}-${crypto.randomUUID()}@example.com` }
  await db().insert(users).values({ ...user, createdAt: now() })
  return user
}

/** A device row as the approving poll would have written it, plus its token. */
async function makeDevice(
  userId: string,
  opts: { label?: string; lastSeen?: number | null; disabled?: boolean } = {},
): Promise<{ id: string; label: string; enrollmentToken: string }> {
  const enrollmentToken = randomToken()
  const id = (await sha256Hex(`device-${++seq}-${crypto.randomUUID()}`)).slice(0, 12)
  const label = opts.label ?? `machine ${seq}`
  await db()
    .insert(devices)
    .values({
      id,
      userId,
      label,
      publicKey: base64url(crypto.getRandomValues(new Uint8Array(32))),
      tokenHash: await sha256Hex(enrollmentToken),
      createdAt: now(),
      lastSeen: opts.lastSeen ?? null,
      disabled: opts.disabled ?? false,
    })
  return { id, label, enrollmentToken }
}

/** Sign `userId` in and hand back the Cookie header a browser would send. */
async function signIn(userId: string): Promise<string> {
  const { setCookie } = await inRequest(() => createSession(userId), { ip: freshIp() })
  const header = setCookie.find((c) => c.startsWith(`${SESSION_COOKIE}=`))
  if (!header) throw new Error('createSession set no session cookie')
  return `${SESSION_COOKIE}=${header.slice(`${SESSION_COOKIE}=`.length).split(';')[0]}`
}

/** Each call as the dashboard makes it: inside a request, with a cookie. */
const list = async (cookie?: string) => (await inRequest(() => listDevices(), { cookie, ip: freshIp() })).value
const revoke = async (deviceId: string, cookie?: string) =>
  (await inRequest(() => revokeDevice(deviceId), { cookie, ip: freshIp() })).value
const rename = async (deviceId: string, label: string, cookie?: string) =>
  (await inRequest(() => renameDevice(deviceId, label), { cookie, ip: freshIp() })).value
const open = async (deviceId: string, cookie?: string) =>
  (await inRequest(() => openSession(deviceId), { cookie, ip: freshIp() })).value

/** The row behind an id, or undefined. */
async function row(deviceId: string) {
  const [found] = await db().select().from(devices).where(eq(devices.id, deviceId))
  return found
}

describe('listDevices', () => {
  it('returns the caller’s machines and nobody else’s', async () => {
    // The whole "one login, all your machines" claim, and its converse.
    const mine = await makeUser()
    const theirs = await makeUser()
    const a = await makeDevice(mine.id, { label: 'mac studio', lastSeen: now() - 30 })
    const b = await makeDevice(mine.id, { label: 'thinkpad' })
    const hidden = await makeDevice(theirs.id, { label: 'not mine' })

    const listed = await list(await signIn(mine.id))

    expect(listed.map((d) => d.id).sort()).toEqual([a.id, b.id].sort())
    expect(listed.map((d) => d.label)).toContain('mac studio')
    expect(listed.map((d) => d.id)).not.toContain(hidden.id)
  })

  it('hands over exactly the four fields the screen needs', async () => {
    // Not `select()`: `devices` also holds `token_hash` (the digest of a live
    // bearer credential) and `public_key`, and a list endpoint that returned
    // the row would put both into the RPC payload of every dashboard load.
    const user = await makeUser()
    const device = await makeDevice(user.id, { lastSeen: 1_700_000_000 })

    const [listed] = await list(await signIn(user.id))

    expect(Object.keys(listed ?? {}).sort()).toEqual(['disabled', 'id', 'label', 'lastSeen'])
    expect(listed).toEqual({
      id: device.id,
      label: device.label,
      lastSeen: 1_700_000_000,
      disabled: false,
    })
    expect(JSON.stringify(listed)).not.toContain(await sha256Hex(device.enrollmentToken))
  })

  it('is empty for an account with no machines', async () => {
    const user = await makeUser()
    expect(await list(await signIn(user.id))).toEqual([])
  })

  it('puts the machines that were seen most recently first, and never-seen last', async () => {
    // Ordering has to happen somewhere or the list reshuffles between loads.
    const user = await makeUser()
    const never = await makeDevice(user.id, { lastSeen: null })
    const old = await makeDevice(user.id, { lastSeen: now() - 86_400 })
    const fresh = await makeDevice(user.id, { lastSeen: now() - 10 })

    expect((await list(await signIn(user.id))).map((d) => d.id)).toEqual([fresh.id, old.id, never.id])
  })

  it('refuses without a session', async () => {
    const user = await makeUser()
    await makeDevice(user.id)
    await expect(list()).rejects.toThrow()
  })

  it('shows a disabled machine, flagged', async () => {
    // A revocation deletes the row; `disabled` is the operator's kill switch,
    // and hiding a machine that has been switched off would leave its owner
    // wondering where it went.
    const user = await makeUser()
    const device = await makeDevice(user.id, { disabled: true })
    const [listed] = await list(await signIn(user.id))
    expect(listed).toMatchObject({ id: device.id, disabled: true })
  })
})

describe('revokeDevice', () => {
  it('removes a machine the caller owns', async () => {
    const user = await makeUser()
    const device = await makeDevice(user.id)

    await revoke(device.id, await signIn(user.id))

    expect(await row(device.id)).toBeUndefined()
  })

  it('refuses a machine somebody else owns, and leaves it alone', async () => {
    // The predicate under test: `where id = ? and user_id = ?`. A delete scoped
    // by id alone would take the victim's daemon off the service from any
    // account that could guess a twelve-character id — and device ids are
    // derived from public keys, which are not secret.
    const owner = await makeUser()
    const mallory = await makeUser()
    const device = await makeDevice(owner.id, { label: 'victim mac' })

    await expect(revoke(device.id, await signIn(mallory.id))).rejects.toThrow()

    expect(await row(device.id)).toMatchObject({ userId: owner.id, label: 'victim mac' })
  })

  it('refuses a machine that does not exist, indistinguishably', async () => {
    // Same refusal as "not yours", or this is an existence oracle for other
    // people's device ids.
    const owner = await makeUser()
    const mallory = await makeUser()
    const device = await makeDevice(owner.id)
    const cookie = await signIn(mallory.id)

    const notYours = await revoke(device.id, cookie).catch((e: Error) => e.message)
    const notThere = await revoke('ffffffffffff', cookie).catch((e: Error) => e.message)
    expect(notThere).toBe(notYours)
  })

  it('refuses without a session', async () => {
    const user = await makeUser()
    const device = await makeDevice(user.id)
    await expect(revoke(device.id)).rejects.toThrow()
    expect(await row(device.id)).toBeDefined()
  })

  it('logs the revoke, without the credential', async () => {
    // Removing a machine from an account is the one destructive thing this
    // screen does, so it leaves a trace. What it must not leave is the
    // device's token digest — a log line is a copy.
    const user = await makeUser()
    const device = await makeDevice(user.id)
    const lines: Array<string> = []
    const spy = vi.spyOn(console, 'log').mockImplementation((...args: Array<unknown>) => {
      if (typeof args[0] === 'string') lines.push(args[0])
    })
    try {
      await revoke(device.id, await signIn(user.id))
    } finally {
      spy.mockRestore()
    }

    const entry = lines
      .map((line) => {
        try {
          return JSON.parse(line) as Record<string, unknown>
        } catch {
          return null
        }
      })
      .find((parsed) => parsed?.evt === 'device_revoked')

    expect(entry).toMatchObject({ evt: 'device_revoked', userId: user.id, deviceId: device.id })
    expect(lines.join('\n')).not.toContain(await sha256Hex(device.enrollmentToken))
  })

  it('is what stops the machine getting another channel token', async () => {
    // The point of deleting the row rather than flipping a flag: the relay
    // never asks this service anything, so revocation is "no more tokens get
    // minted" plus the 60/300s a live one has left.
    const user = await makeUser()
    const device = await makeDevice(user.id)
    const cookie = await signIn(user.id)
    await expect(inRequest(() => mintClientToken(device.id), { cookie, ip: freshIp() })).resolves.toBeDefined()

    await revoke(device.id, cookie)

    await expect(
      inRequest(() => mintClientToken(device.id), { cookie, ip: freshIp() }),
    ).rejects.toThrow()
  })
})

describe('renameDevice', () => {
  it('renames a machine the caller owns', async () => {
    const user = await makeUser()
    const device = await makeDevice(user.id, { label: 'old name' })

    expect(await rename(device.id, 'kitchen pi', await signIn(user.id))).toBe('kitchen pi')

    expect((await row(device.id))?.label).toBe('kitchen pi')
  })

  it('refuses a machine somebody else owns, and leaves its name alone', async () => {
    const owner = await makeUser()
    const mallory = await makeUser()
    const device = await makeDevice(owner.id, { label: 'victim mac' })

    await expect(rename(device.id, 'mallory’s', await signIn(mallory.id))).rejects.toThrow()

    expect((await row(device.id))?.label).toBe('victim mac')
  })

  it('bounds the label rather than storing whatever arrived', async () => {
    // The same treatment `startDeviceAuth` gives a daemon-supplied label, and
    // for the same reason: this string is printed into a terminal by
    // `flue devices` on some other machine, where an escape sequence is
    // somebody else's cursor.
    const user = await makeUser()
    const device = await makeDevice(user.id)
    const cookie = await signIn(user.id)

    const stored = await rename(device.id, `\u001b[31mred  alert ${'x'.repeat(500)}`, cookie)

    expect(stored.length).toBeLessThanOrEqual(MAX_LABEL)
    expect(stored).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/)
    expect(stored).not.toMatch(/ {2}/)
    expect((await row(device.id))?.label).toBe(stored)
  })

  it('refuses a name that is not one', async () => {
    // Empty, whitespace, control characters only. `devices.label` is what
    // identifies a machine to its owner; a blank row is not a rename, it is a
    // machine they can no longer tell apart.
    const user = await makeUser()
    const device = await makeDevice(user.id, { label: 'keep me' })
    const cookie = await signIn(user.id)

    for (const attempt of ['', '   ', '\u0007\u001b']) {
      await expect(rename(device.id, attempt, cookie)).rejects.toThrow()
    }
    expect((await row(device.id))?.label).toBe('keep me')
  })

  it('does no work for an absurd input', async () => {
    // Bounded before it is normalized, before it is a bound parameter in D1.
    const user = await makeUser()
    const device = await makeDevice(user.id, { label: 'keep me' })
    await expect(rename(device.id, 'z'.repeat(100_000), await signIn(user.id))).rejects.toThrow()
    expect((await row(device.id))?.label).toBe('keep me')
  })

  it('refuses without a session', async () => {
    const user = await makeUser()
    const device = await makeDevice(user.id, { label: 'keep me' })
    await expect(rename(device.id, 'nope')).rejects.toThrow()
    expect((await row(device.id))?.label).toBe('keep me')
  })
})

describe('openSession', () => {
  it('hands back a browser-navigable relay URL carrying a fresh client token', async () => {
    const user = await makeUser()
    const device = await makeDevice(user.id)

    const { url } = await open(device.id, await signIn(user.id))
    const parsed = new URL(url)

    // The mint speaks `wss://` because that is what a WebSocket dials; a
    // document navigation cannot. Same host, same port, https.
    expect(parsed.protocol).toBe('https:')
    expect(parsed.host).toBe(new URL(RELAY_URL).host)

    // The token is in the **fragment**, and the query is empty. A fragment is
    // never put on the wire by the browser: not in the relay's request logs
    // (Workers Logs is on there), not in a `Referer` the relay's page sends
    // onward. Asserting both halves, because "it is in the hash" and "it is
    // not also in the query" are two different facts and only the second one
    // is the security property.
    expect(parsed.search).toBe('')
    expect(parsed.searchParams.get('t')).toBeNull()

    // Read exactly as the relay's page must read it — the hash is a parameter
    // list, so `location.hash.slice(1)` through URLSearchParams.
    const token = new URLSearchParams(parsed.hash.slice(1)).get('t')
    expect(token).toBeTruthy()
    expect(await verifyChannelToken(SECRET, token as string)).toMatchObject({
      acc: user.id,
      dev: device.id,
      role: 'client',
    })
  })

  it('never writes the token anywhere a server would see it', async () => {
    // The whole point of the fragment, stated as a property rather than as a
    // spelling: everything to the left of `#` is what a server is handed, and
    // the token must not appear in any of it. This is what would fail if
    // someone "helpfully" added `?t=` back for a client that forgot to read
    // the hash.
    const user = await makeUser()
    const device = await makeDevice(user.id)

    const { url } = await open(device.id, await signIn(user.id))
    const [beforeHash = '', ...rest] = url.split('#')
    const token = new URLSearchParams(rest.join('#')).get('t')

    expect(token).toBeTruthy()
    expect(beforeHash).not.toContain(token as string)
    // And it is the whole request line: origin + path, nothing else.
    expect(beforeHash).toBe(`https://${new URL(RELAY_URL).host}/`)
  })

  it('refuses a machine the caller does not own', async () => {
    const owner = await makeUser()
    const mallory = await makeUser()
    const device = await makeDevice(owner.id)
    await expect(open(device.id, await signIn(mallory.id))).rejects.toThrow()
  })

  it('refuses without a session', async () => {
    const user = await makeUser()
    const device = await makeDevice(user.id)
    await expect(open(device.id)).rejects.toThrow()
  })

  it('refuses a machine that has been revoked', async () => {
    const user = await makeUser()
    const device = await makeDevice(user.id)
    const cookie = await signIn(user.id)
    await revoke(device.id, cookie)
    await expect(open(device.id, cookie)).rejects.toThrow()
  })
})
