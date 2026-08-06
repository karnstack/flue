/*
 * The SaaS relay's whole authorization decision, offline.
 *
 * Under flue.sh the control plane (app/) decides who may bridge to what and
 * says so in a signed statement the browser and the daemon carry to this
 * Worker. The relay never calls the control plane on the channel path — a
 * round trip per dial is a latency and an availability coupling that a signed
 * statement buys its way out of — so everything a bridge is authorized by has
 * to be checkable here, with one shared secret and no network.
 *
 * That makes this file a **cross-implementation contract with
 * `app/src/lib/tokens.ts`**. It is a port of that file's `verifyChannelToken`
 * and the primitives underneath it, and the two are pinned to each other by
 * `app/test/channel-token-vector.json`, which both test suites read (see
 * test/tokens.ts, which imports the vector across the package boundary rather
 * than copying it, so that drift is a red test rather than a browser that
 * silently cannot reach its daemon).
 *
 * A port is a place a security check goes missing. Every line of the verifier
 * below is one an attacker gets to skip if it drifted, and the vector cannot
 * see it: a verifier that checked only the HMAC would still pass the vector.
 * `test/saas-token.test.ts` therefore carries one negative case per check, and
 * a copy of this file that dropped any of them goes red.
 *
 * Nothing here signs. The relay holds `RELAY_SIGNING_SECRET` because HMAC has
 * one key for both operations, but the only capability it ever exercises with
 * it is verification; a relay that minted its own tokens could name any
 * account it liked.
 */

import type { Env } from './index'

/**
 * The claims a channel token carries. Four fields, and there will not be a
 * fifth without the control plane and the relay agreeing to it in the same
 * change. Identical to `ChannelClaims` in app/src/lib/tokens.ts.
 */
export interface ChannelClaims {
  /** The account this channel belongs to — `users.id`. */
  acc: string
  /** The device — `devices.id`, twelve hex characters. */
  dev: string
  /** Which end of the bridge holds this token. */
  role: 'daemon' | 'client'
  /** Unix seconds. Dead at this instant, not merely after it. */
  exp: number
}

/**
 * The longest token that will be looked at, let alone hashed.
 *
 * The relay verifies these against whatever the internet sends it, and a token
 * the control plane mints is ~170 characters; anything past this bound is
 * refused before the HMAC rather than after it. Part of the format: the same
 * number as `MAX_CHANNEL_TOKEN_LENGTH` in app/src/lib/tokens.ts.
 */
export const MAX_CHANNEL_TOKEN_LENGTH = 1024

/**
 * The subprotocol a browser is answered with, and the one it hides the token
 * beside.
 *
 * A browser cannot set headers on a WebSocket upgrade. It can name
 * subprotocols — the second argument to `new WebSocket(url, protocols)` — and
 * those become `Sec-WebSocket-Protocol`, a *header*, which is the only way a
 * credential reaches this Worker without being in the URL. In the URL it would
 * be in the request line, and therefore in Workers Logs, in any proxy's access
 * log, and in the browser's history if it ever got there from a document
 * navigation (see `openSession` in app/src/server/devices.ts, which puts it in
 * the fragment for exactly this reason).
 *
 * So the browser offers **two** values:
 *
 *     new WebSocket(url, ['flue.v1', `flue.token.${token}`])
 *
 * and the Worker echoes `flue.v1` on the 101. The echo is mandatory — RFC 6455
 * §4.1 says a client that offered subprotocols and is answered without one
 * must fail the connection, and browsers do — and it must not be the token: a
 * response header is one more place a bearer credential would be written down.
 * Two values rather than one is what makes an echo possible that is not the
 * credential itself.
 */
export const CLIENT_SUBPROTOCOL = 'flue.v1'

/** The prefix that marks the subprotocol value carrying the token. */
export const TOKEN_SUBPROTOCOL_PREFIX = 'flue.token.'

/** `payloadPart.signaturePart`, both unpadded base64url and nothing else. */
const BASE64URL_PART = /^[A-Za-z0-9_-]+$/

const nowSeconds = () => Math.floor(Date.now() / 1000)

/**
 * The signing secret if this relay is a SaaS one, else null — the mode
 * selector, and the only thing that chooses between the two behaviours in
 * `index.ts`.
 *
 * Both modes are compiled in and the environment decides, so a self-hosted
 * relay and flue.sh's are one artifact. Empty counts as absent: a
 * `wrangler secret put` that was never run leaves the binding missing, and a
 * Worker started with an empty one would otherwise verify every token against
 * the empty key — which WebCrypto refuses, turning every dial into a 401 that
 * looks like a signing bug rather than the missing configuration it is.
 */
export function relaySigningSecret(env: Env): string | null {
  const secret = env.RELAY_SIGNING_SECRET
  return typeof secret === 'string' && secret.length > 0 ? secret : null
}

/**
 * The token out of a `Sec-WebSocket-Protocol` offer, or null.
 *
 * Both values must be there. Without `flue.v1` there is nothing this Worker
 * would be willing to echo on the 101 — it will not echo the credential — so
 * an offer that carries only a token is refused rather than half-honoured.
 */
export function channelTokenFromSubprotocols(header: string | null): string | null {
  if (!header) return null
  // A header list, whether the client sent one header or several: `Headers.get`
  // joins repeats with ", ", and either way the values are comma-separated and
  // may carry optional whitespace (RFC 9110 §5.6.1).
  const offered = header.split(',').map((v) => v.trim())
  if (!offered.includes(CLIENT_SUBPROTOCOL)) return null
  const carrier = offered.find((v) => v.startsWith(TOKEN_SUBPROTOCOL_PREFIX))
  if (carrier === undefined) return null
  const token = carrier.slice(TOKEN_SUBPROTOCOL_PREFIX.length)
  return token.length > 0 ? token : null
}

/** The credential out of an `Authorization: Bearer` header, or null. */
export function bearerToken(header: string | null): string | null {
  if (!header) return null
  const prefix = 'Bearer '
  if (!header.startsWith(prefix)) return null
  const token = header.slice(prefix.length).trim()
  return token.length > 0 ? token : null
}

/**
 * Check a channel token, or null.
 *
 * A port of `verifyChannelToken` in app/src/lib/tokens.ts — the same checks in
 * the same order, and the same refusal to say which one failed. A caller
 * cannot tell a forgery from a stale token and needs to do the same thing
 * about both.
 *
 * The three load-bearing properties, restated here because this copy is the
 * one exposed to the internet:
 *
 *   - **The signature is checked before the payload is parsed.** `JSON.parse`
 *     on unauthenticated input is a wider surface than an HMAC over a string,
 *     and nothing below the compare should be reachable by someone who cannot
 *     sign.
 *   - **The compare is constant-time and over one spelling.** The signature is
 *     43 characters of base64url — the raw HMAC bytes. A verifier that also
 *     accepted the 64-character hex spelling would accept two tokens per
 *     signature, which is the shape of an alg-confusion bug.
 *   - **`exp > now`, strictly.** A token whose second has arrived is dead. The
 *     TTLs are 60 s for a browser and 300 s for a daemon
 *     (app/src/server/channel-token.ts), and that window is the entire
 *     revocation latency of the system: this relay holds no revocation list
 *     and asks nobody. A disabled account stops being minted tokens; the last
 *     one it holds dies on its own.
 *
 * Everything runs inside one try/catch because the contract is "any failure is
 * null": WebCrypto throws on some inputs (an empty key, for one), and a
 * verifier that threw where it should have refused would turn a bad token into
 * a 500.
 */
export async function verifyChannelToken(
  secret: string,
  token: string,
): Promise<ChannelClaims | null> {
  try {
    if (typeof token !== 'string' || token.length === 0) return null
    if (token.length > MAX_CHANNEL_TOKEN_LENGTH) return null

    const parts = token.split('.')
    if (parts.length !== 2) return null
    const [payload, signature] = parts as [string, string]
    if (!BASE64URL_PART.test(payload) || !BASE64URL_PART.test(signature)) return null

    // The presented signature is the first argument by the convention
    // `timingSafeEqual` documents: attacker-controlled first, so the loop's
    // length carries nothing secret.
    const expected = base64url(await hmacBytes(secret, payload))
    if (!timingSafeEqual(signature, expected)) return null

    const bytes = base64urlBytes(payload)
    if (!bytes) return null
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes))
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null

    const { acc, dev, role, exp } = parsed as Record<string, unknown>
    if (typeof acc !== 'string' || acc.length === 0) return null
    if (typeof dev !== 'string' || dev.length === 0) return null
    if (role !== 'daemon' && role !== 'client') return null
    if (typeof exp !== 'number' || !Number.isFinite(exp)) return null
    if (exp <= nowSeconds()) return null

    // Rebuilt rather than returned as-is: whatever else the payload carried is
    // not a claim, and must not reach a caller that spreads this object — the
    // hub name is built from these fields.
    return { acc, dev, role, exp }
  } catch {
    return null
  }
}

/**
 * HMAC-SHA-256 of `msg` under `secret`, as the 32 raw bytes.
 *
 * The token carries these base64url — 43 characters rather than the 64 of a
 * hex spelling — and hex is a *spelling*, so the two must never be
 * interchangeable in a verifier: see `verifyChannelToken`.
 */
async function hmacBytes(secret: string, msg: string): Promise<Uint8Array> {
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

/**
 * base64url without padding (RFC 4648 §5) — the spelling the token's two parts
 * are written in.
 */
function base64url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}

/**
 * base64url back to bytes, or null if it is not base64url.
 *
 * `atob` speaks the standard alphabet only, so the two url-safe characters are
 * translated back and the padding this format omits is restored — a length
 * that is 1 more than a multiple of 4 is not base64 at all and `atob` says so.
 */
function base64urlBytes(part: string): Uint8Array | null {
  const b64 = part.replaceAll('-', '+').replaceAll('_', '/')
  const padded = b64.padEnd(Math.ceil(b64.length / 4) * 4, '=')
  try {
    const binary = atob(padded)
    return Uint8Array.from(binary, (c) => c.charCodeAt(0))
  } catch {
    return null
  }
}

/**
 * Compare two strings without leaking *where* they diverge.
 *
 * `a === b` bails at the first differing character, and that difference is
 * measurable: repeated guesses against a secret can be extended one character
 * at a time. This reads every character of `a` regardless, folding a length
 * mismatch into the same accumulator rather than returning early on it.
 *
 * Callers compare digests of a fixed width, so `a.length` carries nothing
 * secret. JavaScript cannot promise true constant time — the engine may do as
 * it likes — but no branch here depends on the data.
 */
function timingSafeEqual(a: string, b: string): boolean {
  let diff = a.length ^ b.length
  for (let i = 0; i < a.length; i++) {
    // Wrap the index into `b` so a shorter `b` still costs a full pass; the
    // length mismatch itself is already in `diff` and cannot be cancelled out
    // by the wrapped characters matching. `|| 0` covers an empty `b`, where
    // charCodeAt returns NaN.
    diff |= a.charCodeAt(i) ^ (b.charCodeAt(i % b.length) || 0)
  }
  return diff === 0
}
