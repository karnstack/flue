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
