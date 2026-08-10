/*
 * A fleet key that signs, for tests only.
 *
 * The browser verifies and never signs, so `crypto/cert.ts` has no signing
 * half — but a test that wants to watch a directory being read needs
 * certificates that verify, and a fixture cannot supply every shape a case
 * needs (two machines, a certificate re-minted a second later, one signed by
 * a stranger). So this holds the private half and mints them.
 *
 * The seed is testdata/fleet/certs.json's, which is what keeps this honest:
 * `FLEET_PUB` is asserted against the fixture's own `publicKeyHex` below, so
 * a signer that drifted from Go's would fail before any case ran.
 */
import { ed25519 } from '@noble/curves/ed25519.js'

import fixture from '../../../testdata/fleet/certs.json'
import { encodeCert, type Cert } from '@/crypto/cert'
import type { DirectoryAnswer, DirectoryFetch } from '@/relay/directory'

const unhex = (s: string) => new Uint8Array((s.match(/.{2}/g) ?? []).map((b) => parseInt(b, 16)))

/** The fixture's seed, decoded from the unpadded base64url the join line
 *  carries it in. */
export const FLEET_SEED = Uint8Array.from(
  atob(fixture.seed.replace(/-/g, '+').replace(/_/g, '/').padEnd(44, '=')),
  (c) => c.charCodeAt(0),
)

/** The public half every reader verifies under. */
export const FLEET_PUB = ed25519.getPublicKey(FLEET_SEED)

/** Some other fleet entirely: a key that signs perfectly well and is not
 *  the one any browser in these tests pinned. */
export const OTHER_SEED = new Uint8Array(32).fill(9)
export const OTHER_PUB = ed25519.getPublicKey(OTHER_SEED)

if (
  Array.from(FLEET_PUB, (b) => b.toString(16).padStart(2, '0')).join('') !== fixture.publicKeyHex
) {
  throw new Error('testing/fleet: this signer does not agree with testdata/fleet/certs.json')
}

/** One signed blob: the canonical bytes, then the signature over them. */
export function signCert(cert: Cert, seed: Uint8Array = FLEET_SEED): Uint8Array {
  const canonical = encodeCert(cert)
  const sig = ed25519.sign(canonical, seed)
  const out = new Uint8Array(canonical.length + sig.length)
  out.set(canonical)
  out.set(sig, canonical.length)
  return out
}

/** A machine certificate, with the fields a test rarely cares about filled. */
export function machineCert(
  id: string,
  name: string,
  noise: Uint8Array,
  iat = 1_754_700_000,
  seed = FLEET_SEED,
): Uint8Array {
  return signCert({ kind: 'machine', id, name, noise, iat }, seed)
}

/** A device certificate for one device key. */
export function deviceCert(
  device: Uint8Array,
  name = 'phone',
  pairedOn = 'attic-pi',
  iat = 1_754_700_000,
  seed = FLEET_SEED,
): Uint8Array {
  return signCert({ kind: 'device', device, name, pairedOn, iat }, seed)
}

/** A revocation for one device key. */
export function revocation(
  device: Uint8Array,
  iat = 1_754_700_000,
  seed = FLEET_SEED,
): Uint8Array {
  return signCert({ kind: 'revoke', device, iat }, seed)
}

/** Standard base64 with padding, the alphabet the Worker writes `blob` in. */
export function base64(bytes: Uint8Array): string {
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary)
}

/**
 * A stand-in for `GET /directory`: the document the Worker answers with,
 * around whatever blobs a case wants in it.
 *
 * The entry keys are left empty rather than computed. Nothing in the reader
 * looks at them — the signature over the bytes is what decides whether an
 * entry means anything — and a helper that filled them in would suggest
 * otherwise.
 */
export function directoryFetch(
  blobs: Uint8Array[],
  init: { ok?: boolean; status?: number; body?: string } = {},
): DirectoryFetch & { calls: string[] } {
  const calls: string[] = []
  const body =
    init.body ?? JSON.stringify({ v: 1, entries: blobs.map((b) => ({ key: '', blob: base64(b) })) })
  const fetch = (url: string): Promise<DirectoryAnswer> => {
    calls.push(url)
    return Promise.resolve({
      ok: init.ok ?? true,
      status: init.status ?? 200,
      text: () => Promise.resolve(body),
    })
  }
  return Object.assign(fetch, { calls })
}

/** The fixture's own device key, for cases that want the committed vectors
 *  rather than a minted one. */
export const FIXTURE_DEVICE = unhex(
  fixture.cases.find((c) => c.name === 'device')!.cert.deviceHex!,
)
