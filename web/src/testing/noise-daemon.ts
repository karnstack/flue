/*
 * The daemon's half of Noise_IK_25519_ChaChaPoly_SHA256 — responder only, and
 * for tests only.
 *
 * `web/src/crypto/noise.ts` is the initiator and stays that way: the browser
 * is never the responder, so a responder there would be production code with
 * no production caller. But a test that wants to watch the relay socket
 * complete a real handshake needs something on the other end that holds a
 * private key and answers message B, and replaying a fixture cannot do it —
 * the initiator's ephemeral is random, so message B has to be computed against
 * whatever it sent.
 *
 * It is a second implementation of the same symmetric-state machinery rather
 * than a re-export of noise.ts's internals, which is the point: a double that
 * shared the code under test would agree with it about a bug. What keeps it
 * honest is testdata/noise/ik.json — given the fixture's responder static and
 * ephemeral keys it must reproduce msg2 byte-exactly and the transport
 * ciphertexts with it (asserted in web/src/relay/socket.test.ts), the same
 * vectors the Go responder and the TS initiator are held to.
 *
 * The mirror image of this exists on the other side: internal/crypto's
 * InitiatorHandshake is Go's test-only initiator.
 */
import { x25519 } from '@noble/curves/ed25519.js'
import { chacha20poly1305 } from '@noble/ciphers/chacha.js'
import { hmac } from '@noble/hashes/hmac.js'
import { sha256 } from '@noble/hashes/sha2.js'
import type { NoiseChannel } from '@/crypto/noise'

const PROTOCOL = 'Noise_IK_25519_ChaChaPoly_SHA256'

/** X25519 keys and ChaChaPoly tags, the two widths the message layout uses. */
const KEY_LEN = 32
const TAG_LEN = 16

const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}

const nonceBytes = (n: bigint) => {
  const b = new Uint8Array(12)
  new DataView(b.buffer).setBigUint64(4, n, true)
  return b
}

const hkdf = (chainingKey: Uint8Array, ikm: Uint8Array) => {
  const tempKey = hmac(sha256, chainingKey, ikm)
  const out1 = hmac(sha256, tempKey, new Uint8Array([1]))
  const out2 = hmac(sha256, tempKey, concat(out1, new Uint8Array([2])))
  return [out1, out2] as const
}

class CipherState {
  private n = 0n
  constructor(private k: Uint8Array) {}
  encrypt(ad: Uint8Array, plaintext: Uint8Array): Uint8Array {
    const ct = chacha20poly1305(this.k, nonceBytes(this.n), ad).encrypt(plaintext)
    this.n++
    return ct
  }
  decrypt(ad: Uint8Array, ciphertext: Uint8Array): Uint8Array {
    const pt = chacha20poly1305(this.k, nonceBytes(this.n), ad).decrypt(ciphertext)
    this.n++
    return pt
  }
}

class SymmetricState {
  ck: Uint8Array
  h: Uint8Array
  private cipher: CipherState | null = null

  constructor() {
    const name = new TextEncoder().encode(PROTOCOL)
    this.h = name.length <= 32 ? concat(name, new Uint8Array(32 - name.length)) : sha256(name)
    this.ck = this.h
  }
  mixHash(data: Uint8Array) {
    this.h = sha256(concat(this.h, data))
  }
  mixKey(ikm: Uint8Array) {
    const [ck, temp] = hkdf(this.ck, ikm)
    this.ck = ck
    this.cipher = new CipherState(temp)
  }
  encryptAndHash(plaintext: Uint8Array): Uint8Array {
    if (!this.cipher) {
      this.mixHash(plaintext)
      return plaintext
    }
    const ct = this.cipher.encrypt(this.h, plaintext)
    this.mixHash(ct)
    return ct
  }
  decryptAndHash(ciphertext: Uint8Array): Uint8Array {
    if (!this.cipher) {
      this.mixHash(ciphertext)
      return ciphertext
    }
    const pt = this.cipher.decrypt(this.h, ciphertext)
    this.mixHash(ciphertext)
    return pt
  }
  split(): [CipherState, CipherState] {
    const [k1, k2] = hkdf(this.ck, new Uint8Array(0))
    return [new CipherState(k1), new CipherState(k2)]
  }
}

export interface ResponderHandshake {
  /**
   * Reads `-> e, es, s, ss` and returns the initiator's static public key —
   * the device identity a real daemon looks up in its device store. Throws
   * unless the message was sealed to this responder's static key, which is
   * how a browser pinning the wrong daemon fails.
   */
  readMessageA(msg: Uint8Array): Uint8Array
  /** Writes `<- e, ee, se` and splits, returning both the bytes to send and
   *  the transport channel that follows them. */
  messageB(): { msg: Uint8Array; channel: NoiseChannel }
}

export function responderHandshake(
  staticPriv: Uint8Array,
  ephemeralPriv?: Uint8Array, // fixed only where a vector is being reproduced
): ResponderHandshake {
  const ss = new SymmetricState()
  const s = { priv: staticPriv, pub: x25519.getPublicKey(staticPriv) }
  const ePriv = ephemeralPriv ?? crypto.getRandomValues(new Uint8Array(32))
  const e = { priv: ePriv, pub: x25519.getPublicKey(ePriv) }

  // IK pre-message: the responder's own static is what the initiator pinned.
  ss.mixHash(new Uint8Array(0)) // prologue (empty)
  ss.mixHash(s.pub)

  let re: Uint8Array | null = null
  let rs: Uint8Array | null = null

  return {
    readMessageA(msg) {
      if (re) throw new Error('noise: messageA already read')
      if (msg.length < KEY_LEN + KEY_LEN + TAG_LEN + TAG_LEN) {
        throw new Error('noise: message A is too short')
      }
      // <- e
      re = msg.slice(0, KEY_LEN)
      ss.mixHash(re)
      // <- es
      ss.mixKey(x25519.getSharedSecret(s.priv, re))
      // <- s
      rs = ss.decryptAndHash(msg.slice(KEY_LEN, KEY_LEN + KEY_LEN + TAG_LEN))
      // <- ss
      ss.mixKey(x25519.getSharedSecret(s.priv, rs))
      ss.decryptAndHash(msg.slice(KEY_LEN + KEY_LEN + TAG_LEN)) // empty payload
      return rs
    },
    messageB() {
      if (!re || !rs) throw new Error('noise: messageB before messageA')
      // -> e
      ss.mixHash(e.pub)
      // -> ee
      ss.mixKey(x25519.getSharedSecret(e.priv, re))
      // -> se
      ss.mixKey(x25519.getSharedSecret(e.priv, rs))
      const payload = ss.encryptAndHash(new Uint8Array(0))
      // The initiator's split names these (i2r, r2i); this side seals with the
      // second and opens with the first.
      const [i2r, r2i] = ss.split()
      return {
        msg: concat(e.pub, payload),
        channel: {
          seal: (pt) => r2i.encrypt(new Uint8Array(0), pt),
          open: (c) => i2r.decrypt(new Uint8Array(0), c),
        },
      }
    },
  }
}
