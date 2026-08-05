/*
 * Noise_IK_25519_ChaChaPoly_SHA256, initiator side only. The daemon is
 * always the responder; its static key arrives pinned via the pairing QR.
 *
 *   <- s                    (pre-message: the pinned daemon key)
 *   -> e, es, s, ss         messageA
 *   <- e, ee, se            messageB
 *
 * Kept deliberately non-general: one pattern, one suite, one role. The Go
 * side (internal/crypto) is the other half; testdata/noise/ik.json keeps
 * the two from drifting.
 */
import { x25519 } from '@noble/curves/ed25519.js'
import { chacha20poly1305 } from '@noble/ciphers/chacha.js'
import { hmac } from '@noble/hashes/hmac.js'
import { sha256 } from '@noble/hashes/sha2.js'

const PROTOCOL = 'Noise_IK_25519_ChaChaPoly_SHA256'

const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}

/** ChaChaPoly nonce per the Noise spec: 4 zero bytes, then n as 64-bit LE. */
const nonceBytes = (n: bigint) => {
  const b = new Uint8Array(12)
  new DataView(b.buffer).setBigUint64(4, n, true)
  return b
}

const hkdf = (chainingKey: Uint8Array, ikm: Uint8Array, outputs: 2 | 3) => {
  const tempKey = hmac(sha256, chainingKey, ikm)
  const out1 = hmac(sha256, tempKey, new Uint8Array([1]))
  const out2 = hmac(sha256, tempKey, concat(out1, new Uint8Array([2])))
  if (outputs === 2) return [out1, out2] as const
  const out3 = hmac(sha256, tempKey, concat(out2, new Uint8Array([3])))
  return [out1, out2, out3] as const
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
    // decrypt throws on a bad tag; the nonce still advances only on
    // success, which is what makes a replay fail (the counter has moved on).
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
    // Protocol names longer than 32 bytes are hashed; this one is exactly 32.
    this.h = name.length <= 32 ? concat(name, new Uint8Array(32 - name.length)) : sha256(name)
    this.ck = this.h
  }
  mixHash(data: Uint8Array) {
    this.h = sha256(concat(this.h, data))
  }
  mixKey(ikm: Uint8Array) {
    const [ck, temp] = hkdf(this.ck, ikm, 2)
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
    // Decrypt first (it needs the pre-update h as AD), then mix the
    // ciphertext that was actually consumed. A bad tag throws out of
    // `decrypt` before mixHash ever runs, which is fine: a failed handshake
    // message is fatal to the whole handshake, so there is no later step
    // that could observe a stale h.
    const pt = this.cipher.decrypt(this.h, ciphertext)
    this.mixHash(ciphertext)
    return pt
  }
  split(): [CipherState, CipherState] {
    const [k1, k2] = hkdf(this.ck, new Uint8Array(0), 2)
    return [new CipherState(k1), new CipherState(k2)]
  }
}

export interface NoiseChannel {
  seal(plaintext: Uint8Array): Uint8Array
  open(ciphertext: Uint8Array): Uint8Array // throws on tamper/replay — caller must drop the connection
}

export interface InitiatorHandshake {
  messageA(): Uint8Array // -> e, es, s, ss
  readMessageB(msg: Uint8Array): NoiseChannel // <- e, ee, se; throws on any failure
}

export function initiatorHandshake(
  staticPriv: Uint8Array,
  peerStaticPub: Uint8Array,
  ephemeralPriv?: Uint8Array, // tests only; defaults to crypto.getRandomValues
): InitiatorHandshake {
  const ss = new SymmetricState()
  const s = { priv: staticPriv, pub: x25519.getPublicKey(staticPriv) }
  const ePriv = ephemeralPriv ?? crypto.getRandomValues(new Uint8Array(32))
  const e = { priv: ePriv, pub: x25519.getPublicKey(ePriv) }

  // IK pre-message: the responder's static key is mixed before message A.
  ss.mixHash(new Uint8Array(0)) // prologue (empty)
  ss.mixHash(peerStaticPub)

  let sent = false
  return {
    messageA() {
      if (sent) throw new Error('noise: messageA already produced')
      sent = true
      // -> e
      ss.mixHash(e.pub)
      // -> es
      ss.mixKey(x25519.getSharedSecret(e.priv, peerStaticPub))
      // -> s
      const encS = ss.encryptAndHash(s.pub)
      // -> ss
      ss.mixKey(x25519.getSharedSecret(s.priv, peerStaticPub))
      const payload = ss.encryptAndHash(new Uint8Array(0))
      return concat(e.pub, encS, payload)
    },
    readMessageB(msg) {
      if (!sent) throw new Error('noise: messageB before messageA')
      // <- e
      const re = msg.slice(0, 32)
      ss.mixHash(re)
      // <- ee
      ss.mixKey(x25519.getSharedSecret(e.priv, re))
      // <- se
      ss.mixKey(x25519.getSharedSecret(s.priv, re))
      ss.decryptAndHash(msg.slice(32)) // empty payload; throws on tamper
      const [i2r, r2i] = ss.split()
      return {
        seal: (pt) => i2r.encrypt(new Uint8Array(0), pt),
        open: (c) => r2i.decrypt(new Uint8Array(0), c),
      }
    },
  }
}
