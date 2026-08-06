// The test-side *signer* for channel tokens, and the shared vector that pins it.
//
// The relay only ever verifies; nothing in src/ signs, and nothing should. But
// a suite that can only replay two frozen tokens can test almost nothing — not
// expiry, not the account keying, not a bridge — so the tests mint their own.
//
// That signer is not trusted on its own authority. `saas-token.test.ts` asserts
// it reproduces `app/test/channel-token-vector.json` byte for byte from the
// vector's secret and claims, which makes every token minted here a token the
// control plane would have produced: if this file drifted from
// `app/src/lib/tokens.ts`, the vector case goes red before any behaviour test
// gets a chance to pass for the wrong reason.
//
// The vector is **imported**, not copied. `../../app/test/...` is a relative
// path out of this package and into the control plane's, deliberately: a copy
// would be two files that agree until the day one of them is regenerated, and
// the whole point of a cross-implementation vector is that drift is a build
// error. (web/src/relay/socket.test.ts reaches for `testdata/noise/ik.json` the
// same way, for the same reason.)
//
// Not a `.test.ts` file, so vitest does not collect it.

import vectorFile from '../../app/test/channel-token-vector.json'
import type { ChannelClaims } from '../src/channel-auth'

/** One `{secret, claims} → token` case from the shared vector. */
export interface VectorCase {
  claims: ChannelClaims
  payloadJson: string
  token: string
}

/** The secret the vector's tokens are signed under — *not* the env binding. */
export const VECTOR_SECRET: string = vectorFile.secret

/**
 * The vector's cases, retyped rather than spread: JSON gives `role` the type
 * `string`, and narrowing it here is what turns a vector whose role stopped
 * being one of the two into a compile error.
 */
export const VECTOR_CASES: VectorCase[] = vectorFile.vectors.map((v) => ({
  claims: {
    acc: v.claims.acc,
    dev: v.claims.dev,
    role: asRole(v.claims.role),
    exp: v.claims.exp,
  },
  payloadJson: v.payloadJson,
  token: v.token,
}))

function asRole(role: string): 'daemon' | 'client' {
  if (role !== 'daemon' && role !== 'client') throw new Error(`vector role ${role}`)
  return role
}

/** The vector case for a role, by name — the suite reads both. */
export function vectorFor(role: 'daemon' | 'client'): VectorCase {
  const found = VECTOR_CASES.find((v) => v.claims.role === role)
  if (!found) throw new Error(`the shared vector has no ${role} case`)
  return found
}

/**
 * Sign a channel token: the mirror image of `app/src/lib/tokens.ts`'s
 * `signChannelToken`, down to the pinned key order of the payload — the
 * signature covers the payload *text*, so a different key order is a different
 * token over the same facts.
 */
export async function signChannelToken(secret: string, claims: ChannelClaims): Promise<string> {
  const payload = base64url(
    new TextEncoder().encode(
      JSON.stringify({ acc: claims.acc, dev: claims.dev, role: claims.role, exp: claims.exp }),
    ),
  )
  return `${payload}.${base64url(await hmacBytes(secret, payload))}`
}

/** The same HMAC, spelled in hex — for the test that a hex signature is refused. */
export async function hmacHex(secret: string, msg: string): Promise<string> {
  return [...(await hmacBytes(secret, msg))].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export async function hmacBytes(secret: string, msg: string): Promise<Uint8Array> {
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(msg)))
}

export function base64url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}

/** Unix seconds, `s` seconds from now. */
export function inSeconds(s: number): number {
  return Math.floor(Date.now() / 1000) + s
}
