// The cryptographic primitives the auth paths share. Nothing here touches the
// database or the environment: these are pure functions over WebCrypto, which
// is what makes them testable without a request context.
//
// The bottom half of the file is the *channel token* — the compact signed
// statement the relay verifies offline to decide whether a browser and a
// daemon may be bridged. It is a cross-implementation contract: see the note
// above `signChannelToken`.

// A login code is 8 decimal digits — 10^8 possibilities, refused after 5 wrong
// guesses, dead after 10 minutes.
const CODE_DIGITS = 8
const CODE_SPACE = 10 ** CODE_DIGITS

// 2^32 is not a multiple of 10^8 (4_294_967_296 = 42 * 10^8 + 94_967_296), so a
// bare `draw % 10^8` would make the first 94_967_296 codes ~2.4% likelier than
// the rest — a measurable dent in a keyspace whose whole job is to be flat.
// Draws at or above this bound are thrown away and redrawn; the discard
// probability is ~2.2%, so the loop terminates immediately in practice.
const UNBIASED_LIMIT = Math.floor(2 ** 32 / CODE_SPACE) * CODE_SPACE

/**
 * A login code: 8 decimal digits from the CSPRNG, uniformly distributed,
 * left-padded so '00000042' is as valid a code as '99999999'.
 */
export function randomCode8(): string {
  let draw = randomUint32()
  while (draw >= UNBIASED_LIMIT) draw = randomUint32()
  return String(draw % CODE_SPACE).padStart(CODE_DIGITS, '0')
}

function randomUint32(): number {
  const buf = new Uint32Array(1)
  crypto.getRandomValues(buf)
  // `noUncheckedIndexedAccess` types this as number | undefined; index 0 of a
  // length-1 array is always there. Asserted rather than defaulted on purpose —
  // a `?? 0` here would quietly turn an impossible read into the code 00000000.
  return buf[0] as number
}

/**
 * HMAC-SHA-256 of `msg` under `secret`, lowercase hex.
 *
 * Keyed on purpose. Login codes are stored as HMAC(server secret, code): an
 * unkeyed digest of an 8-digit code is a 10^8 rainbow table — minutes of GPU
 * time — so a leaked database dump would hand over every live code. With the
 * secret held only by the Worker, the dump is inert.
 */
export async function hmacHex(secret: string, msg: string): Promise<string> {
  return hex(await hmacBytes(secret, msg))
}

/**
 * HMAC-SHA-256 of `msg` under `secret`, as the 32 raw bytes.
 *
 * The same computation `hmacHex` returns a hex spelling of. The channel token
 * carries the raw bytes base64url instead — 43 characters rather than 64 — and
 * hex is a *spelling*, so the two must never be interchangeable in a verifier:
 * see `verifyChannelToken`.
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

/** Bytes as lowercase hex. */
function hex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * SHA-256 of `msg`, lowercase hex.
 *
 * Unkeyed on purpose, and only ever used on secrets that are already
 * unguessable: session tokens and device tokens are 32 bytes from the CSPRNG,
 * so there is no dictionary to build and nothing a key would add. (Login codes
 * are 8 digits and therefore use `hmacHex` instead — see above.) What this
 * buys is that the database stores a *verifier*, not the bearer token: a dump
 * of `sessions` cannot be pasted into a cookie jar.
 */
export async function sha256Hex(msg: string): Promise<string> {
  return sha256HexBytes(new TextEncoder().encode(msg))
}

/**
 * SHA-256 of raw bytes, lowercase hex.
 *
 * The same digest as `sha256Hex`, for the one input that is not text: a
 * device's Noise public key, whose id is a digest of the *key material* and has
 * to agree byte for byte with what the Go daemon computes (see lib/device-id).
 * Hashing its base64 spelling instead would be a different value, and the two
 * sides would disagree about the device's name.
 */
export async function sha256HexBytes(bytes: Uint8Array): Promise<string> {
  // `.slice()` copies into a plain ArrayBuffer: a Uint8Array that is a *view*
  // over a larger buffer (or over a SharedArrayBuffer) would otherwise hash
  // more than the caller passed, or not typecheck as a BufferSource at all.
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes.slice().buffer)))
}

/**
 * Compare two strings without leaking *where* they diverge.
 *
 * `a === b` bails at the first differing character, and that difference is
 * measurable: repeated guesses against a secret can be extended one character
 * at a time. This reads every character of `a` regardless, folding a length
 * mismatch into the same accumulator rather than returning early on it.
 *
 * Callers compare digests of a fixed width (hex HMACs), so `a.length` carries
 * nothing secret. JavaScript cannot promise true constant time — the engine may
 * do as it likes — but no branch here depends on the data.
 */
export function timingSafeEqual(a: string, b: string): boolean {
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

/**
 * base64url without padding (RFC 4648 §5) — the shape a token takes when it has
 * to survive a cookie, a URL and a shell copy-paste unescaped.
 */
export function base64url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}

/**
 * A bearer token: 32 bytes from the CSPRNG, base64url, 43 characters.
 *
 * One definition for every opaque secret this service hands out — session
 * cookies, device-flow device codes, device enrollment tokens. They are all
 * the same object with different lifetimes, and they are all stored as
 * `sha256Hex(token)` and never in the clear, which only holds while "the
 * token" means "256 unguessable bits": at that width there is no dictionary to
 * invert and therefore nothing an HMAC key would add.
 *
 * 256 bits and not fewer, on purpose. These are compared by an indexed lookup
 * rather than in constant time, and the argument for that is entirely the
 * keyspace.
 */
export function randomToken(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return base64url(bytes)
}

/**
 * The claims a channel token carries. Four fields, and there will not be a
 * fifth without the relay agreeing to it.
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
 * this service mints is ~170 characters; anything past this bound is refused
 * before the HMAC rather than after it. Part of the format, so the port keeps
 * the same number.
 */
export const MAX_CHANNEL_TOKEN_LENGTH = 1024

/** `payloadPart.signaturePart`, both unpadded base64url and nothing else. */
const BASE64URL_PART = /^[A-Za-z0-9_-]+$/

const nowSeconds = () => Math.floor(Date.now() / 1000)

/**
 * Sign a channel token: `base64url(JSON claims) + "." + base64url(HMAC-SHA-256)`.
 *
 * **This is a cross-implementation contract.** The relay verifies these tokens
 * *offline* — it never calls this service on the channel hot path, which is the
 * whole reason a signed statement exists instead of a lookup — so its copy of
 * the verifier (relay/src/channel-auth.ts) has to agree with this one down to
 * the byte. `app/test/channel-token-vector.json` pins a fixed
 * {secret, claims} → token, and both test suites assert it; drift shows up as
 * a red test rather than as a browser that silently cannot reach its daemon.
 *
 * Deliberately not a JWT. There is no header, no `alg`, no negotiation — one
 * algorithm, four claims, one line — because every JWT verification bug worth
 * the name lives in the parts this format does not have.
 *
 * The claims are rebuilt here in the pinned key order rather than passed
 * through: the signature covers the payload *text*, so `{acc,dev,role,exp}`
 * and `{exp,role,dev,acc}` would be two different tokens over the same facts,
 * and which one you got would depend on how some caller wrote an object
 * literal.
 *
 * Signing judges nothing — not the role, not the expiry, not who is asking.
 * That is `server/channel-token.ts`'s job on the way in and
 * `verifyChannelToken`'s on the way out.
 */
export async function signChannelToken(secret: string, claims: ChannelClaims): Promise<string> {
  const payload = base64url(
    new TextEncoder().encode(
      JSON.stringify({ acc: claims.acc, dev: claims.dev, role: claims.role, exp: claims.exp }),
    ),
  )
  return `${payload}.${base64url(await hmacBytes(secret, payload))}`
}

/**
 * Check a channel token, or null.
 *
 * Null for every failure without distinguishing them: not two parts, not
 * base64url, a signature that does not match, a payload that is not JSON, an
 * object missing a claim or holding the wrong type, a role that is neither of
 * the two, an expiry that has passed. A caller cannot tell a forgery from a
 * stale token, and needs to do the same thing about both.
 *
 * Three things here are load-bearing and are the reason this is not four
 * lines:
 *
 *   - **The signature is checked before the payload is parsed.** JSON.parse on
 *     unauthenticated input is a wider surface than an HMAC over a string, and
 *     nothing below the compare should be reachable by an attacker who cannot
 *     sign.
 *   - **The compare is constant-time and over one spelling.** The signature is
 *     43 characters of base64url — the raw HMAC bytes. A verifier that also
 *     accepted the 64-character hex (`hmacHex`) would accept two spellings of
 *     one token, which is exactly the shape of an `alg`-confusion bug.
 *   - **`exp > now`, strictly.** A token whose second has arrived is dead. The
 *     TTLs are 60s and 300s (server/channel-token.ts) and that window is the
 *     only thing bounding replay of a token that leaked — the relay holds no
 *     revocation list and asks nobody.
 *
 * Everything runs inside one try/catch because the contract is "any failure is
 * null": WebCrypto throws on some inputs (an empty key, for one), and a
 * verifier that threw where it should have refused would turn a bad token into
 * a 500 — or, in a caller that only handles null, into an unhandled rejection.
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

    // The presented signature is the first argument by the convention this
    // file's `timingSafeEqual` documents: attacker-controlled first, so the
    // loop's length carries nothing secret.
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
    // not a claim, and must not reach a caller that spreads this object.
    return { acc, dev, role, exp }
  } catch {
    return null
  }
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
