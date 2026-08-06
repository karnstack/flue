// A device's name, derived the way the daemon derives it.
//
// This file is one half of a cross-language contract. The other half is
// `DeviceID` in internal/crypto/devices.go:
//
//	func DeviceID(publicKey []byte) string {
//		sum := sha256.Sum256(publicKey)
//		return hex.EncodeToString(sum[:])[:12]
//	}
//
// The daemon computes its own id from its own Noise static key before it has
// ever spoken to flue.sh, and is then addressed by that id everywhere: the
// relay's account scoping, the device list, revocation, the URL of a session.
// If the two derivations disagreed, a daemon and the service would hold
// different opinions about who it is, and nothing in either system would
// notice — so `app/test/enroll.test.ts` and `internal/crypto`'s
// `TestDeviceIDVector` pin the same key to the same twelve characters.
//
// The id is a *label*, not a credential. Twelve hex characters is 48 bits, and
// a second key that collides with a device's id is roughly 2^48 of offline
// work; the Go store therefore compares whole keys and never decides anything
// from the id alone, and nothing on this side may either. What proves a
// device's identity here is its enrollment token, not its name.
import { sha256HexBytes } from './tokens'

/** Twelve lowercase hex characters — 48 bits of the digest, as Go slices it. */
export const DEVICE_ID_LENGTH = 12

/** A Noise X25519 static public key is 32 bytes. Nothing else is one. */
export const PUBLIC_KEY_BYTES = 32

/**
 * Decode a public key the daemon sent, or null if it is not one.
 *
 * Accepts standard base64 and base64url, padded or not, because a key travels
 * through JSON, a URL and a shell and picks up whichever spelling it meets;
 * `atob` understands only the standard alphabet, so the two url-safe
 * characters are translated first. Everything else is refused rather than
 * coerced: a key of the wrong length is not a Noise static, and a string with
 * a character outside the alphabet is not a key at all.
 *
 * Non-canonical encodings are refused too. The last base64 character of a
 * 32-byte value carries four unused bits, so `...lBE=` and `...lBF=` decode to
 * the same bytes — two spellings of one key, which would be two rows in a
 * table keyed by the text. Re-encoding and comparing is the cheapest way to
 * insist there is exactly one.
 */
export function decodePublicKey(encoded: string): Uint8Array | null {
  const standard = encoded.trim().replaceAll('-', '+').replaceAll('_', '/').replace(/=+$/, '')
  if (!/^[A-Za-z0-9+/]+$/.test(standard)) return null

  let binary: string
  try {
    // atob wants the padding back; base64 is 4 characters per 3 bytes.
    binary = atob(standard.padEnd(Math.ceil(standard.length / 4) * 4, '='))
  } catch {
    return null
  }

  if (binary.length !== PUBLIC_KEY_BYTES) return null
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0))
  if (encodePublicKey(bytes).replace(/=+$/, '') !== standard) return null
  return bytes
}

/**
 * The one spelling of a key this service stores: standard base64, padded — the
 * shape Go's `base64.StdEncoding` produces, so a key written here and a key
 * written by the daemon are the same string.
 */
export function encodePublicKey(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

/**
 * The device id for an encoded public key: `hex(sha256(key))[:12]`.
 *
 * Over the key's *bytes*, never over its text — that is the whole reason
 * `decodePublicKey` exists. A digest of the base64 would depend on which
 * spelling arrived and would not match anything the daemon computed.
 *
 * Throws on a key that is not a key. The callers that face the network
 * validate with `decodePublicKey` first and answer for themselves; anything
 * that reaches this function with a bad key has a bug, and a thrown error is
 * better than an id derived from something that was never a key.
 */
export async function deviceIdFor(publicKey: string): Promise<string> {
  const bytes = decodePublicKey(publicKey)
  if (!bytes) throw new Error('device-id: not a 32-byte base64 public key')
  return deviceIdFromKey(bytes)
}

/**
 * The same derivation for a key that has already been decoded, so a caller
 * that has to check the key anyway does not decode it twice — and has no
 * throwing path left to guard.
 */
export async function deviceIdFromKey(publicKey: Uint8Array): Promise<string> {
  return (await sha256HexBytes(publicKey)).slice(0, DEVICE_ID_LENGTH)
}
