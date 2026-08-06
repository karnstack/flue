// `/api/relay-token` over a real HTTP request to the real built Worker.
//
// This is the one endpoint on this service a **cross-origin** browser calls,
// and it is the only reason a line of CORS exists anywhere in the control
// plane. The tab that needs it was navigated to `relay.flue.sh` by
// `openSession`; the credential it needs is minted here, on `app.flue.sh`,
// against the session cookie it already holds. So the request is cross-origin
// and credentialed, and every property this file pins follows from that:
//
//   - **exactly one origin is allowed**, read per request from `RELAY_URL`.
//     `Access-Control-Allow-Origin` is never `*` (a wildcard is not even legal
//     with credentials) and never a reflection of whatever asked;
//   - **the preflight is answered for that origin and refused for any other**,
//     so a page on another site cannot get as far as the POST;
//   - **the session is still the whole authorization decision.** CORS decides
//     who may *read* an answer. It decides nothing about who gets one, and a
//     browser sends a same-site POST before it has been told the answer is
//     unreadable — so ownership and both kill switches are re-checked here
//     exactly as they are on every other path. The tests below are what say
//     that CORS was not mistaken for a guard.
//
// `SELF.fetch` is the built Worker (vitest.config.ts points the pool at
// dist/server), so this needs `pnpm build` first.
import { SELF, env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { db } from '../src/db/client'
import { devices, users } from '../src/db/schema'
import { base64url, randomToken, sha256Hex, verifyChannelToken } from '../src/lib/tokens'
import { RELAY_TOKEN_PATH, relayBrowserOrigin } from '../src/server/refresh-token'
import { SESSION_COOKIE, createSession } from '../src/server/sessions'
import { inRequest } from './request'

const ORIGIN = 'https://app.flue.sh'
const SECRET = env.RELAY_SIGNING_SECRET

/** The one origin allowed to make this call: the relay, over https. */
const RELAY_ORIGIN = `https://${new URL(env.RELAY_URL).host}`

let seq = 0
const now = () => Math.floor(Date.now() / 1000)
const freshIp = () => `192.0.2.${++seq % 256}`

async function makeUser(disabled = false): Promise<{ id: string }> {
  const user = { id: crypto.randomUUID(), email: `rt-${++seq}-${crypto.randomUUID()}@example.com` }
  await db().insert(users).values({ ...user, createdAt: now(), disabled })
  return user
}

async function makeDevice(userId: string, opts: { disabled?: boolean } = {}): Promise<string> {
  const id = (await sha256Hex(`rt-device-${++seq}-${crypto.randomUUID()}`)).slice(0, 12)
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
  return id
}

async function signIn(userId: string): Promise<string> {
  const { setCookie } = await inRequest(() => createSession(userId), { ip: freshIp() })
  const header = setCookie.find((c) => c.startsWith(`${SESSION_COOKIE}=`))
  if (!header) throw new Error('createSession set no session cookie')
  return `${SESSION_COOKIE}=${header.slice(`${SESSION_COOKIE}=`.length).split(';')[0]}`
}

/** The POST the tab makes: form-encoded, credentialed, from the relay origin. */
function post(
  deviceId: string,
  opts: { cookie?: string; origin?: string | null } = {},
): Promise<Response> {
  const headers = new Headers({
    'content-type': 'application/x-www-form-urlencoded',
    'cf-connecting-ip': freshIp(),
  })
  const origin = opts.origin === undefined ? RELAY_ORIGIN : opts.origin
  if (origin !== null) headers.set('origin', origin)
  if (opts.cookie) headers.set('cookie', opts.cookie)

  return SELF.fetch(`${ORIGIN}${RELAY_TOKEN_PATH}`, {
    method: 'POST',
    headers,
    body: new URLSearchParams({ deviceId }).toString(),
    redirect: 'manual',
  })
}

/** The preflight a browser sends before a request it thinks needs one. */
function preflight(origin: string | null, method = 'POST'): Promise<Response> {
  const headers = new Headers({ 'cf-connecting-ip': freshIp() })
  if (origin !== null) headers.set('origin', origin)
  headers.set('access-control-request-method', method)
  headers.set('access-control-request-headers', 'content-type')
  return SELF.fetch(`${ORIGIN}${RELAY_TOKEN_PATH}`, { method: 'OPTIONS', headers })
}

describe('the relay origin', () => {
  it('is derived from RELAY_URL, as an https origin', () => {
    // `RELAY_URL` is what a WebSocket dials (`wss://…`). A browser's `Origin`
    // header never says `wss`, so the allowance is the http form of the same
    // host — one variable, not two that can disagree.
    expect(relayBrowserOrigin()).toBe(RELAY_ORIGIN)
    expect(relayBrowserOrigin()).not.toContain('wss')
  })
})

describe('the CORS preflight', () => {
  it('allows the relay origin, with credentials, for POST only', async () => {
    const res = await preflight(RELAY_ORIGIN)

    expect(res.status).toBe(204)
    expect(res.headers.get('access-control-allow-origin')).toBe(RELAY_ORIGIN)
    expect(res.headers.get('access-control-allow-credentials')).toBe('true')
    expect(res.headers.get('access-control-allow-methods')).toBe('POST')
    // Cached per origin, so a proxy cannot hand one origin's allowance to
    // another.
    expect(res.headers.get('vary')?.toLowerCase()).toContain('origin')
  })

  it('never answers with a wildcard', async () => {
    // `*` is not legal alongside `Allow-Credentials: true` — a browser refuses
    // the pair — so a wildcard here would not be lax, it would be broken. It
    // would also be the shape someone reaches for when "CORS does not work".
    const res = await preflight(RELAY_ORIGIN)
    expect(res.headers.get('access-control-allow-origin')).not.toBe('*')
  })

  it('refuses every other origin', async () => {
    for (const origin of [
      'https://evil.example',
      // A sibling subdomain is same-*site*, so the session cookie really would
      // ride along on its POST. It is the origin that has to be checked.
      'https://evil.flue.sh',
      // A prefix of the relay's host, and a suffix of it: string-contains
      // checks pass both.
      'https://relay.test.flue.sh.evil.example',
      'https://not-relay.test.flue.sh',
      // The right host, the wrong scheme.
      `http://${new URL(env.RELAY_URL).host}`,
    ]) {
      const res = await preflight(origin)
      expect(res.status).toBe(403)
      expect(res.headers.get('access-control-allow-origin')).toBeNull()
    }
  })

  it('refuses a preflight for a method this endpoint does not answer', async () => {
    const res = await preflight(RELAY_ORIGIN, 'DELETE')
    expect(res.status).toBe(403)
    expect(res.headers.get('access-control-allow-origin')).toBeNull()
  })

  it('refuses a preflight that names no origin at all', async () => {
    const res = await preflight(null)
    expect(res.status).toBe(403)
    expect(res.headers.get('access-control-allow-origin')).toBeNull()
  })
})

describe('POST /api/relay-token', () => {
  it('mints a token the relay will accept, for the relay’s origin', async () => {
    const user = await makeUser()
    const deviceId = await makeDevice(user.id)

    const res = await post(deviceId, { cookie: await signIn(user.id) })

    expect(res.status).toBe(200)
    expect(res.headers.get('access-control-allow-origin')).toBe(RELAY_ORIGIN)
    expect(res.headers.get('access-control-allow-credentials')).toBe('true')
    // A bearer credential: nothing may cache it, anywhere, for anyone.
    expect(res.headers.get('cache-control')).toContain('no-store')

    const body = (await res.json()) as { token?: string }
    expect(await verifyChannelToken(SECRET, body.token as string)).toMatchObject({
      acc: user.id,
      dev: deviceId,
      role: 'client',
    })
  })

  it('is answered for the control plane’s own origin too', async () => {
    // Same-origin is not a cross-origin request at all; it is here because a
    // check that only knew about the relay would refuse the service's own
    // dashboard the day something on it needs a token.
    const user = await makeUser()
    const deviceId = await makeDevice(user.id)

    const res = await post(deviceId, { cookie: await signIn(user.id), origin: ORIGIN })
    expect(res.status).toBe(200)
    expect(res.headers.get('access-control-allow-origin')).toBe(ORIGIN)
  })

  it('refuses a POST from any other origin, before it looks at the session', async () => {
    // The CSRF half. `SameSite=Lax` withholds the session cookie from a
    // cross-*site* POST, but `evil.flue.sh` is same-site — so the cookie would
    // ride along, and the origin check is what stands between that page and a
    // live channel token for a machine it names.
    const user = await makeUser()
    const deviceId = await makeDevice(user.id)
    const cookie = await signIn(user.id)

    for (const origin of ['https://evil.flue.sh', 'https://evil.example', null]) {
      const res = await post(deviceId, { cookie, origin })
      expect(res.status).toBe(403)
      expect(res.headers.get('access-control-allow-origin')).toBeNull()
      expect(await res.text()).not.toContain('.')
    }
  })

  it('refuses a signed-out caller with 401 and no token', async () => {
    const user = await makeUser()
    const deviceId = await makeDevice(user.id)

    const res = await post(deviceId)
    expect(res.status).toBe(401)
    expect((await res.json()) as unknown).not.toHaveProperty('token')
  })

  it('answers a redirect to nobody', async () => {
    // A signed-out *fetch* must not be answered with `requireUser`'s redirect
    // to /login: a cross-origin fetch cannot follow one usefully, and Start
    // would serialize it into an RPC envelope this caller does not speak. The
    // status is the answer.
    const res = await post(await makeDevice((await makeUser()).id))
    expect(res.headers.get('location')).toBeNull()
  })

  it('refuses a machine the caller does not own', async () => {
    const owner = await makeUser()
    const mallory = await makeUser()
    const deviceId = await makeDevice(owner.id)

    const res = await post(deviceId, { cookie: await signIn(mallory.id) })
    expect(res.status).toBe(403)
    expect((await res.json()) as unknown).not.toHaveProperty('token')
  })

  it('refuses a machine flue has switched off', async () => {
    const user = await makeUser()
    const deviceId = await makeDevice(user.id, { disabled: true })

    const res = await post(deviceId, { cookie: await signIn(user.id) })
    expect(res.status).toBe(403)
  })

  it('refuses every machine of an account flue has switched off', async () => {
    const user = await makeUser(true)
    const deviceId = await makeDevice(user.id)

    const res = await post(deviceId, { cookie: await signIn(user.id) })
    // A disabled account has no session at all — `currentUser` re-reads the
    // flag on every call — so this is the signed-out answer, which is the
    // correct one.
    expect(res.status).toBe(401)
  })

  it('says nothing about the database when the database breaks', async () => {
    const user = await makeUser()
    const deviceId = await makeDevice(user.id)
    const cookie = await signIn(user.id)

    await env.DB.exec('ALTER TABLE devices RENAME TO devices_gone')
    try {
      const res = await post(deviceId, { cookie })
      expect(res.status).toBe(500)
      const text = await res.text()
      // drizzle raises a failed statement as `Failed query: <SQL>\nparams:
      // <every bound value>` — the schema and this caller's account id.
      expect(text).not.toContain('select')
      expect(text).not.toContain('Failed query')
      expect(text).not.toContain(user.id)
      expect(text).not.toContain(deviceId)
    } finally {
      await env.DB.exec('ALTER TABLE devices_gone RENAME TO devices')
    }
  })

  it('refuses an oversized body before parsing it', async () => {
    // The parse happens before the session is read — the device id is what the
    // session is then checked against — so a caller that can set an `Origin`
    // header (anything that is not a browser) would otherwise buy a full
    // `formData()` of whatever it felt like sending.
    const user = await makeUser()
    const deviceId = await makeDevice(user.id)

    const res = await SELF.fetch(`${ORIGIN}${RELAY_TOKEN_PATH}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        origin: RELAY_ORIGIN,
        cookie: await signIn(user.id),
        'cf-connecting-ip': freshIp(),
      },
      body: `deviceId=${deviceId}&pad=${'a'.repeat(4096)}`,
      redirect: 'manual',
    })

    expect(res.status).toBe(413)
    expect((await res.json()) as unknown).not.toHaveProperty('token')
  })

  it('refuses a GET, whatever it carries', async () => {
    // A credential-minting endpoint that answered a GET would be one an
    // <img src> could reach.
    const user = await makeUser()
    const deviceId = await makeDevice(user.id)
    const res = await SELF.fetch(`${ORIGIN}${RELAY_TOKEN_PATH}?deviceId=${deviceId}`, {
      headers: { cookie: await signIn(user.id), origin: RELAY_ORIGIN },
      redirect: 'manual',
    })
    expect(res.status).toBe(405)
  })
})
