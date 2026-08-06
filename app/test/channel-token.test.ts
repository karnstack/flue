// The channel token: the one statement the relay trusts.
//
// The relay never calls this service on the hot path — it verifies a token
// offline against `RELAY_SIGNING_SECRET` and bridges whatever the claims say.
// So this file is testing two different things and they are worth keeping
// apart in your head:
//
//   1. **The wire format**, which is a cross-implementation contract. Task 9
//      ports `verifyChannelToken` into the relay Worker; the pinned vector in
//      channel-token-vector.json is what stops the two from drifting. The
//      vector's bytes were derived independently (node:crypto, see the file's
//      `note`), so these assertions are not the implementation agreeing with
//      itself.
//
//   2. **The mint**, which is the authorization decision — who may ask for a
//      token that names an account and a device. Everything here runs against
//      a real (local) D1 through the same `db()` production uses, and the
//      client path inside a real Start request, because it reads a cookie.
//
// The pool isolates storage per test *file*, not per test: every test below
// mints its own user and device, and nothing may assume an empty table.
import { env } from 'cloudflare:test'
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { db } from '../src/db/client'
import { devices, users } from '../src/db/schema'
import type { ChannelClaims } from '../src/lib/tokens'
import {
  MAX_CHANNEL_TOKEN_LENGTH,
  base64url,
  randomToken,
  sha256Hex,
  signChannelToken,
  verifyChannelToken,
} from '../src/lib/tokens'
import {
  CLIENT_TOKEN_TTL_S,
  DAEMON_TOKEN_TTL_S,
  mintClientToken,
  mintDaemonToken,
} from '../src/server/channel-token'
import { SESSION_COOKIE, createSession } from '../src/server/sessions'
import vectorFile from './channel-token-vector.json'
import { inRequest } from './request'

const now = () => Math.floor(Date.now() / 1000)

/** Bumped by every helper below, so no two callers in this file collide. */
let seq = 0

const freshIp = () => `203.0.113.${++seq % 256}`

/** The secret the pool binds; production sets it with `wrangler secret put`. */
const SECRET = env.RELAY_SIGNING_SECRET
/** The relay the pool binds. Every mint hands this back with the token. */
const RELAY_URL = env.RELAY_URL

/** JSON widens `role` to string; the vector is the union it spells. */
function vectorClaims(v: (typeof vectorFile.vectors)[number]): ChannelClaims {
  return { ...v.claims, role: v.claims.role as ChannelClaims['role'] }
}

/**
 * A token signed by something that is not the code under test.
 *
 * The forger in these tests: it takes an arbitrary payload — one
 * `signChannelToken`'s types would refuse — and signs it correctly. That is
 * the interesting attacker: not somebody who scribbles on a token, but
 * somebody holding a *valid* signature over claims the verifier should still
 * turn down.
 */
async function forge(secret: string, payloadJson: string): Promise<string> {
  const enc = new TextEncoder()
  const payload = base64url(enc.encode(payloadJson))
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(payload))
  return `${payload}.${base64url(new Uint8Array(sig))}`
}

/** The payload half of a token, decoded back to the JSON text that was signed. */
function payloadJsonOf(token: string): string {
  const part = token.split('.')[0] as string
  const b64 = part.replaceAll('-', '+').replaceAll('_', '/')
  const binary = atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, '='))
  return new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)))
}

async function makeUser(disabled = false): Promise<{ id: string; email: string }> {
  const user = { id: crypto.randomUUID(), email: `chan-${++seq}-${crypto.randomUUID()}@example.com` }
  await db().insert(users).values({ ...user, createdAt: now(), disabled })
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
      label: `device ${seq}`,
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

/** `mintClientToken` as the dashboard calls it: with a session cookie. */
async function mintAsUser(deviceId: string, cookie?: string) {
  const { value } = await inRequest(() => mintClientToken(deviceId), { cookie, ip: freshIp() })
  return value
}

describe('the channel token wire format', () => {
  it('signs the pinned cross-implementation vector byte for byte', async () => {
    // The contract with Task 9's relay port. A change to the payload's key
    // order, to base64url padding, to hex-vs-raw signature bytes — anything at
    // all — moves these strings, and a moved string here is a relay that
    // cannot bridge a browser to a daemon.
    for (const v of vectorFile.vectors) {
      expect(await signChannelToken(vectorFile.secret, vectorClaims(v))).toBe(v.token)
    }
  })

  it('verifies the pinned vector back to exactly its claims', async () => {
    for (const v of vectorFile.vectors) {
      expect(await verifyChannelToken(vectorFile.secret, v.token)).toEqual(vectorClaims(v))
    }
  })

  it('signs the payload with its keys in the pinned order', async () => {
    // The signature covers the payload *text*, so two spellings of the same
    // claims are two different tokens. Building the object in a fixed order is
    // what makes the bytes reproducible; this is the assertion that says so.
    for (const v of vectorFile.vectors) {
      const token = await signChannelToken(vectorFile.secret, vectorClaims(v))
      expect(payloadJsonOf(token)).toBe(v.payloadJson)
    }
    // And the order is not the caller's to choose: the same claims handed over
    // in a different key order still sign to the same token.
    const shuffled = { exp: 4102444800, role: 'client', dev: 'b5d05f15398a', acc: 'a' } as ChannelClaims
    expect(payloadJsonOf(await signChannelToken('s', shuffled))).toBe(
      '{"acc":"a","dev":"b5d05f15398a","role":"client","exp":4102444800}',
    )
  })

  it('is two base64url parts separated by a dot, and nothing else', async () => {
    const token = await signChannelToken('s', {
      acc: 'a',
      dev: 'd',
      role: 'client',
      exp: now() + 60,
    })
    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/)
    // 32 raw HMAC bytes, base64url, unpadded: 43 characters. Hex would be 64,
    // and the relay would reject every token this service mints.
    expect(token.split('.')).toHaveLength(2)
  })

  it('signs the same bytes an independent HMAC does', async () => {
    // The vector pins two fixed inputs; this pins the general case against a
    // second implementation of the same three lines (see `forge`).
    const claims: ChannelClaims = { acc: 'acct', dev: 'b5d05f15398a', role: 'daemon', exp: 1 }
    expect(await signChannelToken('another secret', claims)).toBe(
      await forge('another secret', JSON.stringify(claims)),
    )
  })
})

describe('verifyChannelToken', () => {
  const live = (over: Partial<ChannelClaims> = {}): ChannelClaims => ({
    acc: 'acct-1',
    dev: 'b5d05f15398a',
    role: 'client',
    exp: now() + 60,
    ...over,
  })

  it('round-trips a client token and a daemon token', async () => {
    for (const role of ['client', 'daemon'] as const) {
      const claims = live({ role })
      expect(await verifyChannelToken('s3cret', await signChannelToken('s3cret', claims))).toEqual(
        claims,
      )
    }
  })

  it('refuses a token signed under a different secret', async () => {
    const token = await signChannelToken('the real secret', live())
    expect(await verifyChannelToken('some other secret', token)).toBeNull()
    // Including the near miss — one character out.
    expect(await verifyChannelToken('the real secreT', token)).toBeNull()
    expect(await verifyChannelToken('', token)).toBeNull()
  })

  it('refuses a payload that has been edited under a good signature', async () => {
    // The whole point of the thing: an attacker who holds their own valid
    // token for their own account must not be able to repoint it.
    const mine = await signChannelToken('s', live({ acc: 'mine' }))
    const [, sig] = mine.split('.')
    const theirs = base64url(new TextEncoder().encode(JSON.stringify(live({ acc: 'theirs' }))))
    expect(await verifyChannelToken('s', `${theirs}.${sig}`)).toBeNull()

    // And a single flipped character anywhere in the payload.
    const payload = mine.split('.')[0] as string
    const flipped = `${payload.slice(0, -1)}${payload.endsWith('A') ? 'B' : 'A'}.${sig}`
    expect(await verifyChannelToken('s', flipped)).toBeNull()
  })

  it('refuses a token whose signature has been edited', async () => {
    const token = await signChannelToken('s', live())
    const [payload, sig] = token.split('.') as [string, string]
    expect(await verifyChannelToken('s', `${payload}.${sig.slice(0, -1)}A`)).toBeNull()
    expect(await verifyChannelToken('s', `${payload}.`)).toBeNull()
    expect(await verifyChannelToken('s', `${payload}.${sig}${sig}`)).toBeNull()
    // The signature is raw bytes, base64url — not the hex `hmacHex` returns.
    // A verifier that accepted both would accept two spellings of one token.
    expect(await verifyChannelToken('s', `${payload}.${'0'.repeat(64)}`)).toBeNull()
  })

  it('refuses an expired token, and one that expires exactly now', async () => {
    expect(await verifyChannelToken('s', await signChannelToken('s', live({ exp: now() - 1 })))).toBeNull()
    expect(await verifyChannelToken('s', await signChannelToken('s', live({ exp: now() })))).toBeNull()
    expect(await verifyChannelToken('s', await signChannelToken('s', live({ exp: 0 })))).toBeNull()
    // The other side of that boundary. (Not `now() + 1`: a second ticking over
    // between signing and verifying would make this flake, and the three
    // assertions above can only fail if the clock runs backwards.)
    expect(await verifyChannelToken('s', await signChannelToken('s', live({ exp: now() + 30 })))).not.toBeNull()
  })

  it('refuses a correctly signed token whose role is not one of the two', async () => {
    // Signing does not judge; verifying does. A token that says `role: "admin"`
    // is a token the relay must not be able to interpret.
    for (const role of ['admin', 'Client', 'CLIENT', '', 'daemon ', null, 1, ['client']]) {
      const payload = JSON.stringify({ ...live(), role })
      expect(await verifyChannelToken('s', await forge('s', payload))).toBeNull()
    }
  })

  it('refuses a correctly signed token whose claims are the wrong shape', async () => {
    const payloads = [
      '{}',
      'null',
      '42',
      '"a string"',
      '[{"acc":"a","dev":"d","role":"client","exp":9999999999}]',
      '{"dev":"d","role":"client","exp":9999999999}', // no acc
      '{"acc":"a","role":"client","exp":9999999999}', // no dev
      '{"acc":"a","dev":"d","exp":9999999999}', // no role
      '{"acc":"a","dev":"d","role":"client"}', // no exp
      '{"acc":"","dev":"d","role":"client","exp":9999999999}', // empty acc
      '{"acc":"a","dev":"","role":"client","exp":9999999999}', // empty dev
      '{"acc":1,"dev":"d","role":"client","exp":9999999999}', // acc not a string
      '{"acc":"a","dev":2,"role":"client","exp":9999999999}', // dev not a string
      '{"acc":"a","dev":"d","role":"client","exp":"9999999999"}', // exp not a number
      '{"acc":"a","dev":"d","role":"client","exp":null}',
      '{"acc":"a","dev":"d","role":"client","exp":true}',
      'not json at all',
      '',
    ]
    for (const payload of payloads) {
      expect(await verifyChannelToken('s', await forge('s', payload))).toBeNull()
    }
  })

  it('refuses anything that is not two base64url parts', async () => {
    const valid = await signChannelToken('s', live())
    const [payload, sig] = valid.split('.') as [string, string]
    const junk = [
      '',
      '.',
      '..',
      payload, // no signature at all
      `.${sig}`,
      `${payload}.${sig}.${sig}`, // three parts — not a JWT
      `${payload}#${sig}`,
      `${payload} .${sig}`,
      ` ${payload}.${sig}`,
      `${payload}.${sig} `,
      `${payload}=.${sig}`, // padded: this format never pads
      `${payload}+/.${sig}`, // standard base64's two characters
      `${'A'.repeat(MAX_CHANNEL_TOKEN_LENGTH)}.${sig}`, // and nothing unbounded
    ]
    for (const token of junk) expect(await verifyChannelToken('s', token)).toBeNull()
  })

  it('bounds what it will even hash', async () => {
    // The relay verifies this against whatever the internet sends it. A token
    // longer than any this service mints is refused before the HMAC.
    const claims = live()
    const token = await signChannelToken('s', claims)
    expect(token.length).toBeLessThan(MAX_CHANNEL_TOKEN_LENGTH)
    expect(await verifyChannelToken('s', `${token}${'A'.repeat(MAX_CHANNEL_TOKEN_LENGTH)}`)).toBeNull()
  })
})

describe('mintClientToken', () => {
  it('mints a short-lived client token for a device the user owns', async () => {
    const user = await makeUser()
    const device = await makeDevice(user.id)
    const before = now()

    const { token, relayUrl } = await mintAsUser(device.id, await signIn(user.id))

    expect(relayUrl).toBe(RELAY_URL)
    const claims = await verifyChannelToken(SECRET, token)
    expect(claims).toMatchObject({ acc: user.id, dev: device.id, role: 'client' })
    // 60 seconds, and the window is what bounds replay of a token that leaks
    // through a URL, a proxy log or a screenshot.
    expect(claims?.exp).toBeGreaterThanOrEqual(before + CLIENT_TOKEN_TTL_S)
    expect(claims?.exp).toBeLessThanOrEqual(now() + CLIENT_TOKEN_TTL_S)
    expect(CLIENT_TOKEN_TTL_S).toBe(60)
  })

  it('refuses without a session', async () => {
    const user = await makeUser()
    const device = await makeDevice(user.id)
    await expect(mintAsUser(device.id)).rejects.toThrow()
  })

  it('refuses a device the user does not own', async () => {
    const owner = await makeUser()
    const stranger = await makeUser()
    const device = await makeDevice(owner.id)
    await expect(mintAsUser(device.id, await signIn(stranger.id))).rejects.toThrow()
  })

  it('refuses a device that does not exist, indistinguishably', async () => {
    // Same refusal as "not yours", so this is not an existence oracle for
    // other people's device ids.
    const owner = await makeUser()
    const stranger = await makeUser()
    const device = await makeDevice(owner.id)
    const cookie = await signIn(stranger.id)

    const notYours = await mintAsUser(device.id, cookie).catch((e: Error) => e.message)
    const notThere = await mintAsUser('ffffffffffff', cookie).catch((e: Error) => e.message)
    expect(notThere).toBe(notYours)
  })

  it('refuses a disabled device — the kill switch', async () => {
    const user = await makeUser()
    const device = await makeDevice(user.id, { disabled: true })
    await expect(mintAsUser(device.id, await signIn(user.id))).rejects.toThrow()
  })

  it('stops minting the moment the device is disabled', async () => {
    const user = await makeUser()
    const device = await makeDevice(user.id)
    const cookie = await signIn(user.id)
    await expect(mintAsUser(device.id, cookie)).resolves.toBeDefined()

    await db().update(devices).set({ disabled: true }).where(eq(devices.id, device.id))
    await expect(mintAsUser(device.id, cookie)).rejects.toThrow()
  })

  it('refuses a disabled user, session or no session', async () => {
    const user = await makeUser()
    const device = await makeDevice(user.id)
    const cookie = await signIn(user.id)
    await db().update(users).set({ disabled: true }).where(eq(users.id, user.id))
    await expect(mintAsUser(device.id, cookie)).rejects.toThrow()
  })
})

describe('mintDaemonToken', () => {
  it('mints a longer-lived daemon token for a valid enrollment token', async () => {
    const user = await makeUser()
    const device = await makeDevice(user.id)
    const before = now()

    const minted = await mintDaemonToken(device.id, device.enrollmentToken)
    expect(minted).not.toBeNull()
    expect(minted?.relayUrl).toBe(RELAY_URL)

    const claims = await verifyChannelToken(SECRET, minted?.token as string)
    expect(claims).toMatchObject({ acc: user.id, dev: device.id, role: 'daemon' })
    // Five minutes: a daemon holds a long-lived connection and refreshes,
    // where a browser tab is handed one token and dials once.
    expect(claims?.exp).toBeGreaterThanOrEqual(before + DAEMON_TOKEN_TTL_S)
    expect(claims?.exp).toBeLessThanOrEqual(now() + DAEMON_TOKEN_TTL_S)
    expect(DAEMON_TOKEN_TTL_S).toBe(300)
  })

  it('refuses a wrong, empty or absurd enrollment token', async () => {
    const user = await makeUser()
    const device = await makeDevice(user.id)
    expect(await mintDaemonToken(device.id, randomToken())).toBeNull()
    expect(await mintDaemonToken(device.id, '')).toBeNull()
    expect(await mintDaemonToken(device.id, 'x'.repeat(100_000))).toBeNull()
    expect(await mintDaemonToken('', device.enrollmentToken)).toBeNull()
    expect(await mintDaemonToken('ffffffffffff', device.enrollmentToken)).toBeNull()
  })

  it('cannot be called with what the database stores', async () => {
    // The dump test. `devices.token_hash` is SHA-256 of the token, so the
    // column is useless to anyone who can read the table.
    const user = await makeUser()
    const device = await makeDevice(user.id)
    const stored = await sha256Hex(device.enrollmentToken)
    expect(await mintDaemonToken(device.id, stored)).toBeNull()
  })

  it('refuses one device the token of another', async () => {
    const user = await makeUser()
    const a = await makeDevice(user.id)
    const b = await makeDevice(user.id)
    // Same owner, so this is the *binding* being tested, not ownership: a
    // token names one device and may not speak for its neighbour.
    expect(await mintDaemonToken(b.id, a.enrollmentToken)).toBeNull()
  })

  it('refuses a disabled device and a disabled owner — the kill switch', async () => {
    const user = await makeUser()
    const disabledDevice = await makeDevice(user.id, { disabled: true })
    expect(await mintDaemonToken(disabledDevice.id, disabledDevice.enrollmentToken)).toBeNull()

    const banned = await makeUser(true)
    const device = await makeDevice(banned.id)
    expect(await mintDaemonToken(device.id, device.enrollmentToken)).toBeNull()

    // And a revocation that lands mid-life takes effect on the next mint,
    // which is what bounds a revoked daemon's reach to one token's TTL.
    const live = await makeUser()
    const rug = await makeDevice(live.id)
    expect(await mintDaemonToken(rug.id, rug.enrollmentToken)).not.toBeNull()
    await db().update(devices).set({ disabled: true }).where(eq(devices.id, rug.id))
    expect(await mintDaemonToken(rug.id, rug.enrollmentToken)).toBeNull()
  })

  it('refuses a device whose owner no longer exists', async () => {
    // There are no foreign keys (see schema.ts), so a device row can outlive
    // its user. It must not be mintable: `acc` would name nobody.
    const user = await makeUser()
    const device = await makeDevice(user.id)
    await db().delete(users).where(eq(users.id, user.id))
    expect(await mintDaemonToken(device.id, device.enrollmentToken)).toBeNull()
  })
})

describe('the signing secret', () => {
  it('fails closed when RELAY_SIGNING_SECRET is unset', async () => {
    // Falling through with `undefined` would sign every token under the
    // literal string "undefined" — one well-known key shared by every
    // deployment that forgot `wrangler secret put`, which is the same as
    // having no signature at all.
    const user = await makeUser()
    const device = await makeDevice(user.id)
    const cookie = await signIn(user.id)
    const mutable = env as unknown as { RELAY_SIGNING_SECRET?: string }
    const saved = mutable.RELAY_SIGNING_SECRET

    try {
      delete mutable.RELAY_SIGNING_SECRET
      await expect(mintAsUser(device.id, cookie)).rejects.toThrow(/RELAY_SIGNING_SECRET/)
      await expect(mintDaemonToken(device.id, device.enrollmentToken)).rejects.toThrow(
        /RELAY_SIGNING_SECRET/,
      )
    } finally {
      mutable.RELAY_SIGNING_SECRET = saved
    }
  })
})
