/*
 * The fleet's certificates, as a browser reads them.
 *
 * One Ed25519 keypair per relay signs three kinds of statement — a machine
 * naming itself and its Noise static key, a pairing ceremony naming the device
 * key it admitted, and a revocation naming a device key that is dead
 * (spec/fleet-trust.md, Certificates). This module is the reader's half of
 * that: `internal/fleet` in Go is the other, and testdata/fleet/certs.json is
 * what keeps the two from drifting.
 *
 * The browser verifies and never signs. It holds the fleet *public* key —
 * pinned from the pairing link, see crypto/keys.ts — and the private half
 * never leaves the machines. So everything here is a decision about bytes
 * somebody else produced: a blob off a credential-less `GET /directory`, or
 * one this browser stored earlier. Every fault ends the same way, with null,
 * because the reasons are not the reader's business — a blob a hostile relay
 * chose is not owed a diagnosis.
 *
 * The canonical encoding, byte for byte (the layout is fixed by
 * internal/fleet's package comment; this is the same document):
 *
 *   "flue-fleet-cert/"     16 ASCII bytes of domain separation
 *   u8  v                  1
 *   u8  kind               1 machine, 2 device, 3 revoke
 *   then, per kind, in this order:
 *     machine:  str(id)  str(name)  key32(noise)   u64(iat)
 *     device:   key32(device)  str(name)  str(pairedOn)  u64(iat)
 *     revoke:   key32(device)  u64(iat)
 *
 *   str    = u16 big-endian byte length, then that many bytes of UTF-8
 *   key32  = exactly 32 raw bytes, no length prefix
 *   u64    = 8 bytes big-endian
 *
 * The signature covers exactly the canonical bytes, and the signed blob is
 * canonical || signature. The canonical part is self-delimiting, so whatever
 * follows the fields must be exactly 64 bytes of signature: a blob with one
 * byte more or fewer is refused, which is what stops anything being appended
 * to a signed statement.
 */
import { ed25519 } from '@noble/curves/ed25519.js'

/** The 16 ASCII bytes every canonical encoding opens with. */
const PREFIX = 'flue-fleet-cert/'

/** The one version this module writes and accepts. */
const VERSION = 1

/** Kind bytes, in the order the spec lists the kinds. */
const KIND_MACHINE = 1
const KIND_DEVICE = 2
const KIND_REVOKE = 3

/**
 * The ceiling on every string field, on the way in and on the way out.
 *
 * The same 512 as Go's `maxStringBytes`, and it has to be the same: a reader
 * whose ceiling was lower would refuse a certificate the daemons honour, and
 * one whose ceiling was higher would read a length off an unauthenticated blob
 * and believe it.
 */
const MAX_STRING_BYTES = 512

/**
 * The ceiling on `iat`, matching Go's `maxIAT` exactly so the two accept the
 * same set of blobs. Unix seconds do not reach 2^62; anything at or above it
 * is not a time.
 */
const MAX_IAT = 1n << 62n

/** An X25519 public key — the only kind of key a certificate names. */
const KEY_BYTES = 32

/** An Ed25519 signature, and an Ed25519 public key. */
const SIGNATURE_BYTES = 64
const FLEET_KEY_BYTES = 32

/** A machine naming itself: minted by the machine, for itself, at join time. */
export interface MachineCert {
  kind: 'machine'
  /** The machine id, which is also its slot on the relay: `/client/<id>`. */
  id: string
  /** The machine's display name. */
  name: string
  /** The daemon's static X25519 public key — what a browser pins to reach it. */
  noise: Uint8Array
  /** Unix seconds, for display. Certificates deliberately never expire. */
  iat: number
}

/** A pairing ceremony's outcome, naming the device key it admitted. */
export interface DeviceCert {
  kind: 'device'
  device: Uint8Array
  name: string
  /** The machine id the ceremony ran on. */
  pairedOn: string
  iat: number
}

/**
 * The operator killing a device key.
 *
 * It permanently outranks any device certificate for the same key, whatever
 * either one's `iat` says — `iat` is display, not precedence. Readers have to
 * implement it that way: check the revocations before honouring a device
 * certificate, and never compare the two by time. `relay/directory.ts` is
 * where this browser does it.
 */
export interface Revocation {
  kind: 'revoke'
  device: Uint8Array
  iat: number
}

export type Cert = MachineCert | DeviceCert | Revocation

const encoder = new TextEncoder()
/** `fatal` is the point: Go's decoder refuses a string field that is not
 *  UTF-8, and a reader that quietly substituted U+FFFD would accept blobs the
 *  daemons reject. */
const decoder = new TextDecoder('utf-8', { fatal: true })

/**
 * The canonical bytes of one certificate — exactly what a signature covers.
 *
 * Nothing in the product calls this: the browser holds no fleet private key
 * and signs nothing. It exists because a decoder tested only against its own
 * output agrees with itself about a bug, and because testdata/fleet/certs.json
 * pins `canonicalHex` for every case. Given the fixture's fields this must
 * produce the fixture's bytes, or this implementation has drifted from Go's.
 *
 * It throws rather than returning null, which is the other way round from
 * `verifyCert` and deliberate: the input here is this module's caller's own
 * value, not a stranger's bytes, so a field that will not encode is a mistake
 * worth surfacing.
 */
export function encodeCert(cert: Cert): Uint8Array {
  const parts: Uint8Array[] = [encoder.encode(PREFIX)]
  switch (cert.kind) {
    case 'machine':
      parts.push(
        new Uint8Array([VERSION, KIND_MACHINE]),
        str('id', cert.id),
        str('name', cert.name),
        key32('noise', cert.noise),
        u64('iat', cert.iat),
      )
      break
    case 'device':
      parts.push(
        new Uint8Array([VERSION, KIND_DEVICE]),
        key32('device', cert.device),
        str('name', cert.name),
        str('pairedOn', cert.pairedOn),
        u64('iat', cert.iat),
      )
      break
    case 'revoke':
      parts.push(
        new Uint8Array([VERSION, KIND_REVOKE]),
        key32('device', cert.device),
        u64('iat', cert.iat),
      )
      break
  }
  return concat(parts)
}

/**
 * Read a signed blob and check it under the fleet public key.
 *
 * Null for every fault there is: not a certificate, a version this module does
 * not speak, a kind byte with no meaning, a field cut short, a string that is
 * not UTF-8, bytes left over after the fields, a signature that does not
 * verify. One answer for all of them, because a caller walking a directory has
 * one thing to do with each — drop it — and because the blobs arrive from a
 * store the relay can serve any way it likes.
 *
 * A verified certificate is a statement the fleet key signed and nothing more.
 * It is not permission: the caller still has to check that a revocation does
 * not outrank it, and that the key it names is the key it is being used for.
 */
export function verifyCert(fleetPub: Uint8Array, blob: Uint8Array): Cert | null {
  if (fleetPub.length !== FLEET_KEY_BYTES) return null
  const read = decode(blob)
  if (read === null) return null
  const { cert, canonicalLength } = read
  // Exactly a signature after the fields, never merely at least one. A blob
  // with trailing bytes is a signed statement somebody has added to, and the
  // signature covers none of the addition.
  if (blob.length - canonicalLength !== SIGNATURE_BYTES) return null
  try {
    // `zip215: false` asks noble for RFC 8032 verification, which is the rule
    // Go's crypto/ed25519 implements. The default is ZIP215, whose accept set
    // is strictly larger — and a browser that admitted a machine the daemons
    // reject, or the other way round, would be two implementations of one
    // trust decision.
    if (!ed25519.verify(blob.subarray(canonicalLength), blob.subarray(0, canonicalLength), fleetPub, { zip215: false })) {
      return null
    }
  } catch {
    // noble throws on a malformed point or scalar rather than answering false.
    // Same outcome: this blob is not signed by that key.
    return null
  }
  return cert
}

// --- encoding primitives ---

function str(field: string, s: string): Uint8Array {
  if (!wellFormed(s)) {
    // A JavaScript string may hold an unpaired surrogate, which TextEncoder
    // would silently write as U+FFFD — different bytes than the caller named,
    // under a signature that would then cover them.
    throw new Error(`fleet: ${field} is not well-formed UTF-16`)
  }
  const bytes = encoder.encode(s)
  if (bytes.length > MAX_STRING_BYTES) {
    throw new Error(`fleet: ${field} is ${bytes.length} bytes, the ceiling is ${MAX_STRING_BYTES}`)
  }
  const out = new Uint8Array(2 + bytes.length)
  new DataView(out.buffer).setUint16(0, bytes.length)
  out.set(bytes, 2)
  return out
}

function key32(field: string, key: Uint8Array): Uint8Array {
  if (key.length !== KEY_BYTES) {
    throw new Error(`fleet: ${field} must be ${KEY_BYTES} bytes, got ${key.length}`)
  }
  return key
}

function u64(field: string, value: number): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`fleet: ${field} is not a unix time`)
  }
  const out = new Uint8Array(8)
  new DataView(out.buffer).setBigUint64(0, BigInt(value))
  return out
}

/** Whether every surrogate in the string is half of a pair. */
function wellFormed(s: string): boolean {
  return !/[\uD800-\uDFFF]/.test(s.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, ''))
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

// --- decoding ---

/**
 * A blob walked field by field. Every read is bounds-checked and a short one
 * ends the parse, so a length taken off the wire can never reach past the
 * bytes that carried it.
 */
class Reader {
  at = 0
  constructor(private readonly b: Uint8Array) {}

  take(n: number): Uint8Array | null {
    if (n < 0 || this.b.length - this.at < n) return null
    const out = this.b.subarray(this.at, this.at + n)
    this.at += n
    return out
  }

  str(): string | null {
    const header = this.take(2)
    if (header === null) return null
    const n = new DataView(header.buffer, header.byteOffset, 2).getUint16(0)
    if (n > MAX_STRING_BYTES) return null
    const raw = this.take(n)
    if (raw === null) return null
    try {
      return decoder.decode(raw)
    } catch {
      return null
    }
  }

  /** A key, copied out: the certificate outlives the blob it was read from. */
  key(): Uint8Array | null {
    const raw = this.take(KEY_BYTES)
    return raw === null ? null : new Uint8Array(raw)
  }

  iat(): number | null {
    const raw = this.take(8)
    if (raw === null) return null
    const v = new DataView(raw.buffer, raw.byteOffset, 8).getBigUint64(0)
    if (v > MAX_IAT) return null
    // Above 2^53 this loses precision, and that is acceptable where nothing
    // else would be: `iat` is display, never precedence — a revocation
    // outranks a device certificate whatever either says — and the ceiling
    // above is Go's, so this reader refuses nothing a daemon accepts.
    return Number(v)
  }
}

function decode(blob: Uint8Array): { cert: Cert; canonicalLength: number } | null {
  const r = new Reader(blob)
  const prefix = r.take(PREFIX.length)
  if (prefix === null) return null
  for (let i = 0; i < PREFIX.length; i++) {
    if (prefix[i] !== PREFIX.charCodeAt(i)) return null
  }
  const header = r.take(2)
  if (header === null || header[0] !== VERSION) return null

  let cert: Cert
  switch (header[1]) {
    case KIND_MACHINE: {
      const id = r.str()
      const name = r.str()
      const noise = r.key()
      const iat = r.iat()
      if (id === null || name === null || noise === null || iat === null) return null
      cert = { kind: 'machine', id, name, noise, iat }
      break
    }
    case KIND_DEVICE: {
      const device = r.key()
      const name = r.str()
      const pairedOn = r.str()
      const iat = r.iat()
      if (device === null || name === null || pairedOn === null || iat === null) return null
      cert = { kind: 'device', device, name, pairedOn, iat }
      break
    }
    case KIND_REVOKE: {
      const device = r.key()
      const iat = r.iat()
      if (device === null || iat === null) return null
      cert = { kind: 'revoke', device, iat }
      break
    }
    default:
      return null
  }
  return { cert, canonicalLength: r.at }
}

/**
 * Whether two keys are the same key, without an early exit.
 *
 * Everything compared here is a public key — one out of a certificate, one out
 * of this browser's own store — so there is no secret for a timing channel to
 * leak. The loop runs to the end anyway, for the reason routes/pair.tsx gives
 * for its own copy: the cheap spelling of a key comparison teaches the next
 * reader the wrong habit.
 */
export function sameKey(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!
  return diff === 0
}

/** A key as a map key: hex with no capitals, the spelling the directory's own
 *  entry keys use. */
export function keyHex(key: Uint8Array): string {
  return Array.from(key, (b) => b.toString(16).padStart(2, '0')).join('')
}
