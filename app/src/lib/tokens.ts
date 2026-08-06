// The cryptographic primitives the auth paths share. Nothing here touches the
// database or the environment: these are pure functions over WebCrypto, which
// is what makes them testable without a request context.
//
// (Task 7 adds the relay-token helpers on top of the same primitives.)

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
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(msg))
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('')
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
  const digest = await crypto.subtle.digest('SHA-256', bytes.slice().buffer)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
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
