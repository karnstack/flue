// The verifier, on its own — no Worker, no hub, no sockets.
//
// `saas-auth.test.ts` proves the relay *routes* a good token; this file proves
// what a good token is. The distinction matters because every check below is
// one an attacker gets to skip if the port drifted: the shared vector passes
// under a verifier that checks nothing but the HMAC, so the vector alone
// proves the two implementations agree about *acceptance* and nothing at all
// about refusal. Each negative here corresponds to one line of
// `src/channel-auth.ts` that a laxer verifier would not have.

import { describe, expect, it } from 'vitest'

import {
  channelTokenFromSubprotocols,
  CLIENT_SUBPROTOCOL,
  MAX_CHANNEL_TOKEN_LENGTH,
  relaySigningSecret,
  TOKEN_SUBPROTOCOL_PREFIX,
  verifyChannelToken,
  type ChannelClaims,
} from '../src/channel-auth'
import type { Env } from '../src/index'
import {
  base64url,
  hmacBytes,
  hmacHex,
  inSeconds,
  signChannelToken,
  VECTOR_CASES,
  VECTOR_SECRET,
  vectorFor,
} from './tokens'

const SECRET = 'test-signing-secret'

const CLAIMS: ChannelClaims = {
  acc: '9f0d0b28-7f3e-4a4f-9c8e-2d1f0b3a5c67',
  dev: 'b5d05f15398a',
  role: 'client',
  exp: 0,
}

/** A live token over the given claims, signed under SECRET. */
const mint = (over: Partial<ChannelClaims> = {}): Promise<string> =>
  signChannelToken(SECRET, { ...CLAIMS, exp: inSeconds(60), ...over })

/** A token over an arbitrary payload — for the shapes `signChannelToken`
 *  cannot produce, all of them correctly signed so that only the check under
 *  test can be what refuses them. */
async function signRaw(secret: string, json: string): Promise<string> {
  const payload = base64url(new TextEncoder().encode(json))
  return `${payload}.${base64url(await hmacBytes(secret, payload))}`
}

describe('the shared vector', () => {
  // app/test/channel-token-vector.json, imported rather than copied (./tokens).
  // It pins the format across two implementations in two packages: the control
  // plane signs these bytes, the relay verifies them, and a change to either
  // side that moves a byte turns this red rather than turning a browser into
  // one that silently cannot reach its daemon.
  it('has the two cases this relay has to accept', () => {
    expect(VECTOR_CASES).toHaveLength(2)
    expect(VECTOR_CASES.map((v) => v.claims.role).sort()).toEqual(['client', 'daemon'])
  })

  for (const role of ['daemon', 'client'] as const) {
    it(`verifies the ${role} token to exactly the claims it carries`, async () => {
      const v = vectorFor(role)
      expect(await verifyChannelToken(VECTOR_SECRET, v.token)).toEqual(v.claims)
    })
  }

  it('is reproduced by this suite’s signer, so a minted token is a real one', async () => {
    // What makes every other test in these two files worth anything: the
    // signer in ./tokens is pinned by the same vector the verifier is, so a
    // token it mints is byte-identical to one the control plane would sign.
    for (const v of VECTOR_CASES) {
      expect(await signChannelToken(VECTOR_SECRET, v.claims)).toBe(v.token)
    }
  })

  it('refuses the vector’s tokens under any other secret', async () => {
    for (const v of VECTOR_CASES) {
      expect(await verifyChannelToken(`${VECTOR_SECRET}x`, v.token)).toBeNull()
      expect(await verifyChannelToken(SECRET, v.token)).toBeNull()
    }
  })
})

describe('verifyChannelToken accepts', () => {
  it('a token this service signed, with the claims rebuilt', async () => {
    const exp = inSeconds(60)
    expect(await verifyChannelToken(SECRET, await mint({ exp }))).toEqual({ ...CLAIMS, exp })
  })

  it('both roles', async () => {
    for (const role of ['daemon', 'client'] as const) {
      const claims = await verifyChannelToken(SECRET, await mint({ role }))
      expect(claims?.role).toBe(role)
    }
  })

  it('a token that is nearly expired', async () => {
    // Two seconds and not one. `inSeconds` reads a clock, `verifyChannelToken`
    // reads it again, and a second boundary crossed between them would make
    // `exp === now` — which the strict check correctly refuses, failing this
    // test for the very behaviour the expiry cases below assert. The margin is
    // the smallest one that cannot flake, not a claim about the format.
    expect(await verifyChannelToken(SECRET, await mint({ exp: inSeconds(2) }))).not.toBeNull()
  })
})

describe('verifyChannelToken refuses', () => {
  it('a token longer than the bound, however well signed', async () => {
    // Signed correctly under SECRET and unexpired: the *only* thing wrong with
    // it is its length, so a verifier that dropped the bound would accept it
    // and would hash a megabyte of attacker input to find that out.
    const token = await mint({ acc: 'a'.repeat(MAX_CHANNEL_TOKEN_LENGTH) })
    expect(token.length).toBeGreaterThan(MAX_CHANNEL_TOKEN_LENGTH)
    expect(await verifyChannelToken(SECRET, token)).toBeNull()
  })

  it('the empty token, and a token that is only a dot', async () => {
    expect(await verifyChannelToken(SECRET, '')).toBeNull()
    expect(await verifyChannelToken(SECRET, '.')).toBeNull()
  })

  it('a token with no dot at all', async () => {
    const token = await mint()
    expect(await verifyChannelToken(SECRET, token.replace('.', ''))).toBeNull()
  })

  it('a third segment appended to a valid token', async () => {
    // `split('.')` then `[0]`/`[1]` would read straight past this. The count is
    // checked instead, so `payload.signature.anything` is not a token.
    const token = await mint()
    expect(await verifyChannelToken(SECRET, `${token}.extra`)).toBeNull()
    expect(await verifyChannelToken(SECRET, `${token}.`)).toBeNull()
  })

  it('a signature spelled in standard base64 rather than base64url', async () => {
    // The same 32 bytes, a different spelling. A verifier that decoded both
    // sides to bytes before comparing would accept this — which is the shape
    // of an alg-confusion bug, one token with two valid spellings — and the
    // constant-time compare over the canonical string is what does not.
    let token = ''
    for (let i = 0; i < 200 && !token; i++) {
      const candidate = await mint({ exp: inSeconds(60 + i) })
      if (/[-_]/.test(candidate.split('.')[1] ?? '')) token = candidate
    }
    expect(token).not.toBe('')
    const [payload, signature] = token.split('.') as [string, string]
    const standard = signature.replaceAll('-', '+').replaceAll('_', '/')
    expect(standard).not.toBe(signature)
    expect(await verifyChannelToken(SECRET, `${payload}.${standard}`)).toBeNull()
  })

  it('a signature carrying base64 padding', async () => {
    const [payload, signature] = (await mint()).split('.') as [string, string]
    expect(await verifyChannelToken(SECRET, `${payload}.${signature}=`)).toBeNull()
  })

  it('a payload spelled with characters outside the alphabet', async () => {
    const [payload, signature] = (await mint()).split('.') as [string, string]
    expect(await verifyChannelToken(SECRET, `${payload}%20.${signature}`)).toBeNull()
    expect(await verifyChannelToken(SECRET, ` ${payload}.${signature}`)).toBeNull()
  })

  it('the HMAC spelled in hex instead of the raw bytes', async () => {
    // `hmacHex` and the token's signature are the same computation; hex is a
    // *spelling*, and a verifier that accepted both would accept two tokens
    // per signature.
    const [payload] = (await mint()).split('.') as [string]
    expect(await verifyChannelToken(SECRET, `${payload}.${await hmacHex(SECRET, payload)}`)).toBe(
      null,
    )
  })

  it('a payload edited after signing', async () => {
    const [payload, signature] = (await mint()).split('.') as [string, string]
    const tampered = `${payload.slice(0, -2)}${payload.slice(-2) === 'AA' ? 'AB' : 'AA'}`
    expect(tampered).not.toBe(payload)
    expect(await verifyChannelToken(SECRET, `${tampered}.${signature}`)).toBeNull()
  })

  it('a token signed under a different secret', async () => {
    expect(await verifyChannelToken(SECRET, await signChannelToken('other', CLAIMS))).toBeNull()
  })

  it('a token verified under no secret at all', async () => {
    // WebCrypto throws on an empty key; the contract is null, not a 500.
    expect(await verifyChannelToken('', await mint())).toBeNull()
  })

  it('an expired token, and one whose second has arrived', async () => {
    expect(await verifyChannelToken(SECRET, await mint({ exp: inSeconds(-1) }))).toBeNull()
    // `exp > now`, strictly: dead *at* this instant, not merely after it.
    expect(await verifyChannelToken(SECRET, await mint({ exp: inSeconds(0) }))).toBeNull()
  })

  it('a role that is neither of the two', async () => {
    for (const role of ['admin', 'DAEMON', 'daemon ', '', 'relay']) {
      const token = await signRaw(SECRET, JSON.stringify({ ...CLAIMS, exp: inSeconds(60), role }))
      expect(await verifyChannelToken(SECRET, token)).toBeNull()
    }
  })

  it('a payload that is signed but is not an object with the four claims', async () => {
    const exp = inSeconds(60)
    const bad = [
      'not json at all',
      '[]',
      'null',
      '"a string"',
      '42',
      JSON.stringify([{ ...CLAIMS, exp }]),
      JSON.stringify({ dev: CLAIMS.dev, role: 'client', exp }),
      JSON.stringify({ acc: CLAIMS.acc, role: 'client', exp }),
      JSON.stringify({ acc: CLAIMS.acc, dev: CLAIMS.dev, exp }),
      JSON.stringify({ acc: CLAIMS.acc, dev: CLAIMS.dev, role: 'client' }),
      JSON.stringify({ ...CLAIMS, exp, acc: '' }),
      JSON.stringify({ ...CLAIMS, exp, dev: '' }),
      JSON.stringify({ ...CLAIMS, exp, acc: 7 }),
      JSON.stringify({ ...CLAIMS, exp, dev: ['b5d05f15398a'] }),
      JSON.stringify({ ...CLAIMS, exp: String(exp) }),
      JSON.stringify({ ...CLAIMS, exp: Infinity }),
      JSON.stringify({ ...CLAIMS, exp: null }),
    ]
    for (const json of bad) {
      expect(await verifyChannelToken(SECRET, await signRaw(SECRET, json))).toBeNull()
    }
  })

  it('every extra field a payload smuggled past the claims', async () => {
    const exp = inSeconds(60)
    const token = await signRaw(
      SECRET,
      JSON.stringify({ ...CLAIMS, exp, admin: true, acc2: 'other' }),
    )
    // Rebuilt, not passed through: a caller that spreads these claims must not
    // be handed a field the format does not have.
    expect(await verifyChannelToken(SECRET, token)).toEqual({ ...CLAIMS, exp })
  })
})

describe('the mode selector', () => {
  it('is SaaS mode when RELAY_SIGNING_SECRET is bound', () => {
    expect(relaySigningSecret({ RELAY_SIGNING_SECRET: 'x' } as Env)).toBe('x')
  })

  it('is self-host mode when it is unbound or empty', () => {
    // Empty counts as unbound: a `wrangler secret put` that was never run
    // leaves the binding missing, and a Worker started with `RELAY_SIGNING_SECRET=`
    // would otherwise verify every token against the empty key.
    expect(relaySigningSecret({} as Env)).toBeNull()
    expect(relaySigningSecret({ RELAY_SIGNING_SECRET: '' } as Env)).toBeNull()
  })
})

describe('the client subprotocol', () => {
  const token = 'eyJhIjoxfQ.c2ln'
  const offer = `${CLIENT_SUBPROTOCOL}, ${TOKEN_SUBPROTOCOL_PREFIX}${token}`

  it('carries the token beside the protocol name, in either order', () => {
    expect(channelTokenFromSubprotocols(offer)).toBe(token)
    expect(
      channelTokenFromSubprotocols(
        `${TOKEN_SUBPROTOCOL_PREFIX}${token},${CLIENT_SUBPROTOCOL}`,
      ),
    ).toBe(token)
  })

  it('tolerates the whitespace a header list is written with', () => {
    expect(
      channelTokenFromSubprotocols(`  ${CLIENT_SUBPROTOCOL} ,  ${TOKEN_SUBPROTOCOL_PREFIX}${token} `),
    ).toBe(token)
  })

  it('is nothing without the protocol name', () => {
    // The relay has to echo *something* it was offered on the 101 or the
    // browser fails the connection, and the one thing it will never echo is
    // the credential. No `flue.v1` in the offer, no channel.
    expect(channelTokenFromSubprotocols(`${TOKEN_SUBPROTOCOL_PREFIX}${token}`)).toBeNull()
  })

  it('is nothing without a token', () => {
    expect(channelTokenFromSubprotocols(CLIENT_SUBPROTOCOL)).toBeNull()
    expect(channelTokenFromSubprotocols(`${CLIENT_SUBPROTOCOL}, ${TOKEN_SUBPROTOCOL_PREFIX}`)).toBe(
      null,
    )
    expect(channelTokenFromSubprotocols(null)).toBeNull()
    expect(channelTokenFromSubprotocols('')).toBeNull()
  })

  it('takes the first token offered and not a second one', () => {
    expect(
      channelTokenFromSubprotocols(
        `${CLIENT_SUBPROTOCOL}, ${TOKEN_SUBPROTOCOL_PREFIX}one, ${TOKEN_SUBPROTOCOL_PREFIX}two`,
      ),
    ).toBe('one')
  })
})
