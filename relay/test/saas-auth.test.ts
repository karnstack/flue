// SaaS mode end to end: the Worker in front of the hub, with
// RELAY_SIGNING_SECRET bound (see vitest.config.ts — this file is the whole of
// the `saas` project, and every other suite runs without that binding, which
// is what keeps self-host mode honest).
//
// What is under test here is not the verifier — `saas-token.test.ts` has that —
// but the two decisions the Worker makes with it: *may* this socket open, and
// *which hub* does it land on. The second is the one that matters most. The
// relay bridges a browser to a daemon; if the hub name did not carry the
// account and the device, a token good for one machine would reach every
// machine on the relay.

import { SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'

import { CLIENT_SUBPROTOCOL, TOKEN_SUBPROTOCOL_PREFIX } from '../src/channel-auth'
import { BASE, bytes, encoder, frame, Leg } from './harness'
import { hmacHex, inSeconds, signChannelToken, vectorFor, VECTOR_SECRET } from './tokens'

/** The RELAY_SIGNING_SECRET this project binds. */
const SECRET = 'test-signing-secret'

/** A device id, as `sha256(pubkey)[:12]` spells one. */
const DEV = 'b5d05f15398a'

/** A fresh account per test: the hub is named `acc:dev`, so a new account is a
 *  new hub, and no test can inherit the daemon another one left attached. */
const account = () => crypto.randomUUID()

const client = (acc: string, dev = DEV, exp = inSeconds(60)) =>
  signChannelToken(SECRET, { acc, dev, role: 'client', exp })

const daemon = (acc: string, dev = DEV, exp = inSeconds(60)) =>
  signChannelToken(SECRET, { acc, dev, role: 'daemon', exp })

/** The offer a browser makes: the protocol name it will be answered with, and
 *  the credential beside it. The token is never in the URL. */
const offer = (token: string) =>
  `${CLIENT_SUBPROTOCOL}, ${TOKEN_SUBPROTOCOL_PREFIX}${token}`

function openClient(token: string | null): Promise<Response> {
  const headers: Record<string, string> = { Upgrade: 'websocket' }
  if (token !== null) headers['Sec-WebSocket-Protocol'] = offer(token)
  return SELF.fetch(`${BASE}/client`, { headers })
}

function openClientRaw(subprotocols: string): Promise<Response> {
  return SELF.fetch(`${BASE}/client`, {
    headers: { Upgrade: 'websocket', 'Sec-WebSocket-Protocol': subprotocols },
  })
}

function openDaemon(token: string | null): Promise<Response> {
  const headers: Record<string, string> = { Upgrade: 'websocket' }
  if (token !== null) headers.Authorization = `Bearer ${token}`
  return SELF.fetch(`${BASE}/daemon`, { headers })
}

/** A 101 response as a readable leg. */
function leg(res: Response): Leg {
  if (res.status !== 101 || !res.webSocket) throw new Error(`upgrade answered ${res.status}`)
  ;(res.webSocket as unknown as { binaryType: string }).binaryType = 'arraybuffer'
  res.webSocket.accept()
  return new Leg(res.webSocket)
}

/** A daemon leg attached to `acc`'s hub, ready to be talked to. */
async function attachedDaemon(acc: string, dev = DEV): Promise<Leg> {
  return leg(await openDaemon(await daemon(acc, dev)))
}

describe('the daemon leg in SaaS mode', () => {
  it('opens on a daemon-role token: 101', async () => {
    const res = await openDaemon(await daemon(account()))
    expect(res.status).toBe(101)
    res.webSocket!.accept()
    res.webSocket!.close()
  })

  it('refuses a request with no Authorization at all: 401', async () => {
    expect((await openDaemon(null)).status).toBe(401)
  })

  it('refuses the self-hosted shared secret: 401', async () => {
    // DAEMON_SECRET is bound in this project too (vitest.config.ts). A relay
    // that was told to verify signed tokens must not still honour the flat
    // bearer secret a self-hosted deployment shares with its one daemon.
    const res = await SELF.fetch(`${BASE}/daemon`, {
      headers: { Upgrade: 'websocket', Authorization: 'Bearer test-secret' },
    })
    expect(res.status).toBe(401)
  })

  it('refuses a client-role token: 401', async () => {
    expect((await openDaemon(await client(account()))).status).toBe(401)
  })

  it('refuses an expired token: 401', async () => {
    expect((await openDaemon(await daemon(account(), DEV, inSeconds(-1)))).status).toBe(401)
  })

  it('refuses a token signed by anyone else: 401', async () => {
    const forged = await signChannelToken('not-the-relays-secret', {
      acc: account(),
      dev: DEV,
      role: 'daemon',
      exp: inSeconds(60),
    })
    expect((await openDaemon(forged)).status).toBe(401)
  })

  it('refuses the shared vector’s token, which is signed under another secret', async () => {
    // The vector proves the *format* agrees across implementations; it is not
    // a credential for this relay, whose secret is not the vector's.
    expect(VECTOR_SECRET).not.toBe(SECRET)
    expect((await openDaemon(vectorFor('daemon').token)).status).toBe(401)
  })

  it('still answers 426 to an authorized request that is not an upgrade', async () => {
    const res = await SELF.fetch(`${BASE}/daemon`, {
      headers: { Authorization: `Bearer ${await daemon(account())}` },
    })
    expect(res.status).toBe(426)
  })
})

describe('the browser leg in SaaS mode', () => {
  it('opens on a client-role token and is answered with the protocol it offered', async () => {
    // The echo is not decoration: a browser that offered a subprotocol and got
    // a 101 without one fails the connection itself (RFC 6455 §4.1). What is
    // echoed is `flue.v1` and never `flue.token.…` — the credential does not
    // travel back out in a response header.
    const acc = account()
    await attachedDaemon(acc)
    const res = await openClient(await client(acc))
    expect(res.status).toBe(101)
    expect(res.headers.get('Sec-WebSocket-Protocol')).toBe(CLIENT_SUBPROTOCOL)
    expect(res.headers.get('Sec-WebSocket-Protocol')).not.toContain(TOKEN_SUBPROTOCOL_PREFIX)
    res.webSocket!.accept()
    res.webSocket!.close()
  })

  it('refuses a browser that presents nothing: 401', async () => {
    const acc = account()
    await attachedDaemon(acc)
    expect((await openClient(null)).status).toBe(401)
  })

  it('refuses a token in the query string: 401', async () => {
    // The one place the token must never be. A query parameter is on the wire,
    // in the Worker's request line, and therefore in Workers Logs.
    const acc = account()
    await attachedDaemon(acc)
    const res = await SELF.fetch(`${BASE}/client?t=${await client(acc)}`, {
      headers: { Upgrade: 'websocket' },
    })
    expect(res.status).toBe(401)
  })

  it('refuses an offer with the protocol name but no token: 401', async () => {
    const acc = account()
    await attachedDaemon(acc)
    expect((await openClientRaw(CLIENT_SUBPROTOCOL)).status).toBe(401)
  })

  it('refuses an offer with a token but no protocol name: 401', async () => {
    const acc = account()
    await attachedDaemon(acc)
    const res = await openClientRaw(`${TOKEN_SUBPROTOCOL_PREFIX}${await client(acc)}`)
    expect(res.status).toBe(401)
  })

  it('refuses a daemon-role token: 401', async () => {
    const acc = account()
    await attachedDaemon(acc)
    expect((await openClient(await daemon(acc))).status).toBe(401)
  })

  it('refuses an expired token: 401', async () => {
    const acc = account()
    await attachedDaemon(acc)
    expect((await openClient(await client(acc, DEV, inSeconds(-1)))).status).toBe(401)
  })

  it('refuses a token whose payload was edited after signing: 401', async () => {
    const acc = account()
    await attachedDaemon(acc)
    const [payload, signature] = (await client(acc)).split('.') as [string, string]
    const tampered = `${payload.slice(0, -1)}${payload.slice(-1) === 'A' ? 'B' : 'A'}`
    expect((await openClient(`${tampered}.${signature}`)).status).toBe(401)
  })

  it('refuses a token over the length bound, however well signed: 401', async () => {
    const acc = account()
    await attachedDaemon(acc)
    expect((await openClient(await client(`${acc}${'x'.repeat(1024)}`))).status).toBe(401)
  })

  it('refuses a signature spelled in hex rather than base64url: 401', async () => {
    const acc = account()
    await attachedDaemon(acc)
    const [payload] = (await client(acc)).split('.') as [string]
    expect((await openClient(`${payload}.${await hmacHex(SECRET, payload)}`)).status).toBe(401)
  })

  it('refuses a token carrying a third segment: 401', async () => {
    const acc = account()
    await attachedDaemon(acc)
    expect((await openClient(`${await client(acc)}.extra`)).status).toBe(401)
  })

  it('refuses a token spelled in standard base64: 401', async () => {
    const acc = account()
    await attachedDaemon(acc)
    // Signed correctly, the same 32 bytes, one spelling out of the alphabet.
    // Minted until the signature actually contains one of the two url-safe
    // characters, so the case is never vacuously true.
    let token = ''
    for (let i = 0; i < 200 && !token; i++) {
      const candidate = await client(acc, DEV, inSeconds(60 + i))
      if (/[-_]/.test(candidate)) token = candidate
    }
    expect(token).not.toBe('')
    expect((await openClient(token.replaceAll('-', '+').replaceAll('_', '/'))).status).toBe(401)
  })
})

describe('the hub a token lands on', () => {
  it('bridges a browser and a daemon holding the same account and device', async () => {
    const acc = account()
    const d = await attachedDaemon(acc)
    const c = leg(await openClient(await client(acc)))

    // The daemon is told about the browser…
    const open = await d.nextControl()
    expect(open).toEqual({ type: 'open', channel: expect.any(Number), origin: BASE })

    // …and bytes cross in both directions.
    c.ws.send(Uint8Array.of(0xde, 0xad))
    const up = await d.nextFrame()
    expect(up.channel).toBe(open.channel)
    expect(Array.from(up.payload)).toEqual([0xde, 0xad])

    d.ws.send(frame(up.channel, Uint8Array.of(1, 2, 3)))
    expect(bytes(await c.next('bare bytes'))).toEqual([1, 2, 3])
  })

  it('never bridges a browser to another account’s daemon', async () => {
    // The whole security argument in one assertion. The daemon is attached and
    // the token is valid — it simply names a different account, so it lands on
    // a different Durable Object, one with no daemon in it. Not "refused by a
    // check that could be forgotten": there is nothing there to reach.
    await attachedDaemon(account())
    const res = await openClient(await client(account()))
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ error: 'daemon offline' })
  })

  it('never bridges a browser to another device of the same account', async () => {
    const acc = account()
    await attachedDaemon(acc, 'aaaaaaaaaaaa')
    const res = await openClient(await client(acc, 'bbbbbbbbbbbb'))
    expect(res.status).toBe(503)
  })

  it('keeps two accounts’ daemons on their own hubs', async () => {
    const accA = account()
    const accB = account()
    const dA = await attachedDaemon(accA)
    const dB = await attachedDaemon(accB)
    leg(await openClient(await client(accA)))

    // A's daemon hears about A's browser; B's hears nothing, so the first
    // frame it ever sees is the one from its own browser.
    expect((await dA.nextControl()).type).toBe('open')
    leg(await openClient(await client(accB)))
    expect((await dB.nextControl()).type).toBe('open')
  })

  it('does not replace one account’s daemon with another’s', async () => {
    // A second daemon on the *same* hub takes over and closes the first
    // (spec/relay-protocol.md). Across accounts that must not happen at all.
    const accA = account()
    const dA = await attachedDaemon(accA)
    await attachedDaemon(account())
    const c = leg(await openClient(await client(accA)))
    expect((await dA.nextControl()).type).toBe('open')
    c.ws.close()
  })
})

describe('POST /api/pair in SaaS mode', () => {
  // Pairing is credential-less on a self-hosted relay: there is one hub and the
  // pairing token is the credential. Here there are as many hubs as there are
  // devices, and the request has to name one — so it carries the same client
  // token the browser's socket does, as a bearer (there is no subprotocol on an
  // HTTP POST, and the token must not be in the URL).
  const pair = (token: string | null, acc: string) =>
    SELF.fetch(`${BASE}/api/pair`, {
      method: 'POST',
      headers: token === null ? {} : { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ token: 'pairing-token', publicKey: 'k', acc }),
    })

  it('refuses a request with no token: 401', async () => {
    expect((await pair(null, account())).status).toBe(401)
  })

  it('refuses a daemon-role token: 401', async () => {
    const acc = account()
    expect((await pair(await daemon(acc), acc)).status).toBe(401)
  })

  it('reaches the daemon on the hub its token names', async () => {
    const acc = account()
    const d = await attachedDaemon(acc)
    const answered = pair(await client(acc), acc)
    const msg = await d.nextControl()
    expect(msg.type).toBe('pair')
    d.ws.send(
      frame(
        0,
        encoder.encode(JSON.stringify({ type: 'pairResult', id: msg.id, status: 200, body: {} })),
      ),
    )
    expect((await answered).status).toBe(200)
  })

  it('lands on a hub of its own for another account: 503, not another daemon', async () => {
    await attachedDaemon(account())
    const other = account()
    const res = await pair(await client(other), other)
    expect(res.status).toBe(503)
  })
})
