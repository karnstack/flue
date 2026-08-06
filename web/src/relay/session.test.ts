import { afterEach, describe, expect, it, vi } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'

import { loadPinnedDaemonKeyFor, savePinnedDaemonKeyFor } from '@/crypto/keys'
import type { RelayHandoff } from '@/lib/url'
import { channelTokenSource, resolveRelaySession } from './session'

/** Two machines' static keys, as two `openSession` handoffs would carry them. */
const KEY_A = Uint8Array.from({ length: 32 }, (_, i) => i + 1)
const KEY_B = Uint8Array.from({ length: 32 }, (_, i) => 200 - i)

/**
 * The ids those two keys have, written out rather than derived.
 *
 * A device id *is* `hex(sha256(publicKey))[:12]`, so deriving them here with
 * the same function the code under test uses would assert nothing. These are
 * the values, and the vector test below is what ties the derivation to the two
 * other codebases that compute it.
 */
const ID_A = 'ae216c2ef524'
const ID_B = '9fa1c26e3f2c'

const base64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')

const handoff = (over: Partial<RelayHandoff> = {}): RelayHandoff => ({
  token: 'a-channel-token',
  daemonKey: base64url(KEY_A),
  deviceId: ID_A,
  controlPlane: 'https://app.flue.sh',
  ...over,
})

/** A `sessionStorage` that is only this test's. */
function memoryStore(seed: Record<string, string> = {}): Storage {
  const map = new Map(Object.entries(seed))
  return {
    get length() {
      return map.size
    },
    clear: () => map.clear(),
    getItem: (k: string) => map.get(k) ?? null,
    key: (i: number) => [...map.keys()][i] ?? null,
    removeItem: (k: string) => void map.delete(k),
    setItem: (k: string, v: string) => void map.set(k, v),
  } as Storage
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('resolveRelaySession, from a handoff', () => {
  it('pins the machine’s key under its device id and carries the first token', async () => {
    vi.stubGlobal('indexedDB', new IDBFactory())
    const store = memoryStore()

    const session = await resolveRelaySession(handoff(), store)

    expect(session).not.toBeNull()
    expect(session!.deviceId).toBe(ID_A)
    expect(session!.daemonPub).toEqual(KEY_A)
    expect(session!.controlPlane).toBe('https://app.flue.sh')
    expect(session!.token).toBe('a-channel-token')
    // Pinned, so a reload has a key to hand the handshake — the fragment is
    // scrubbed the moment it is read.
    expect(await loadPinnedDaemonKeyFor(ID_A)).toEqual(KEY_A)
  })

  it('keeps two machines apart, which is the bug this closes', async () => {
    // One origin, two machines. Before per-device pinning, opening B
    // overwrote A's key and A's next session built its Noise IK handshake
    // against B's static: `readMessageB` throws, the socket closes like any
    // outage, and the tab reconnects into the same failure forever.
    vi.stubGlobal('indexedDB', new IDBFactory())

    const a = await resolveRelaySession(handoff(), memoryStore())
    const b = await resolveRelaySession(
      handoff({ deviceId: ID_B, daemonKey: base64url(KEY_B) }),
      memoryStore(),
    )

    expect(a!.daemonPub).toEqual(KEY_A)
    expect(b!.daemonPub).toEqual(KEY_B)
    expect(await loadPinnedDaemonKeyFor(ID_A)).toEqual(KEY_A)
    expect(await loadPinnedDaemonKeyFor(ID_B)).toEqual(KEY_B)
  })

  it('never writes the token down', async () => {
    // It is a bearer credential with a sixty-second life. A copy at rest is a
    // copy that can be replayed, and a reload mints a fresh one anyway.
    vi.stubGlobal('indexedDB', new IDBFactory())
    const store = memoryStore()

    await resolveRelaySession(handoff(), store)

    expect(JSON.stringify(store)).not.toContain('a-channel-token')
    expect(store.getItem('flue.relay.session')).not.toContain('a-channel-token')
  })

  it('is null for a key that is not a 32-byte Noise static', async () => {
    vi.stubGlobal('indexedDB', new IDBFactory())
    for (const daemonKey of ['', 'not base64!!', base64url(new Uint8Array(31)), 'AAAA']) {
      expect(await resolveRelaySession(handoff({ daemonKey }), memoryStore())).toBeNull()
    }
  })

  it('refuses a key that does not hash to the id it arrived with, and pins nothing', async () => {
    // A fragment is whatever the link someone clicked put there, and `k` and
    // `d` used to be adopted without ever being compared. Two things that buys,
    // both of them real:
    //
    //   - **poisoning.** `d` is the victim's machine and `k` is anything at
    //     all: the record for that machine is overwritten in this browser, and
    //     every later session with it builds its IK handshake against the wrong
    //     static. The socket closes like an outage and the tab reconnects into
    //     the identical failure, silently, until the store is cleared.
    //   - **substitution.** `k` and `d` are both the *attacker's* machine, on
    //     the genuine `relay.flue.sh` origin with its genuine TLS — so one dial
    //     opens a terminal into a machine they own, from a page that looks
    //     exactly like the real thing.
    //
    // The id is `hex(sha256(k))[:12]`, so the fragment carries its own proof
    // and the check costs one hash.
    vi.stubGlobal('indexedDB', new IDBFactory())

    for (const deviceId of [
      ID_B, // A's key filed under B's name: the poisoning above.
      '', // Nothing at all.
      ID_A.toUpperCase(), // The right digest, the wrong spelling of it.
      ID_A.slice(0, 11), // A prefix, which a `startsWith` would wave through.
      `${ID_A}00`, // And a superset of one.
    ]) {
      const store = memoryStore()
      expect(await resolveRelaySession(handoff({ deviceId }), store)).toBeNull()
      // Nothing written down, either half of it: refusing after the write
      // would leave the poisoned record behind and only skip this one session.
      expect(await loadPinnedDaemonKeyFor(deviceId)).toBeNull()
      expect(store.getItem('flue.relay.session')).toBeNull()
    }

    // And the record the attacker was aiming at is untouched.
    expect(await loadPinnedDaemonKeyFor(ID_B)).toBeNull()
  })

  it('derives a device id the way the daemon and the control plane do', async () => {
    // The third copy of a cross-language contract. `DeviceID` in
    // internal/crypto/devices.go and `deviceIdFor` in app/src/lib/device-id.ts
    // are the other two, and internal/crypto's `TestDeviceIDVector` and
    // app/test/enroll.test.ts pin this same key to these same twelve
    // characters. If this derivation drifted, the check above would start
    // refusing every genuine handoff — a total outage on the hosted path, with
    // nothing on screen but the explainer.
    vi.stubGlobal('indexedDB', new IDBFactory())
    const key = 'B8SYMazoUcTIYa1PqLyFDhjGEocxvfVjEHaSC8HolBE' // testdata/noise/ik.json
    const session = await resolveRelaySession(
      handoff({ daemonKey: key, deviceId: 'b5d05f15398a' }),
      memoryStore(),
    )
    expect(session?.deviceId).toBe('b5d05f15398a')
  })

  it('reduces the control plane to an origin, and refuses one that is not a URL', async () => {
    // A fragment is whatever the address bar holds. What comes out of it is
    // used to build a request, so it is reduced to an origin — no path, no
    // query — and anything that is not http(s) is refused outright.
    vi.stubGlobal('indexedDB', new IDBFactory())

    const withPath = await resolveRelaySession(
      handoff({ controlPlane: 'https://app.flue.sh/devices?x=1#y' }),
      memoryStore(),
    )
    expect(withPath!.controlPlane).toBe('https://app.flue.sh')

    for (const controlPlane of [
      '',
      'not a url',
      'javascript:alert(1)',
      'data:text/html,x',
      // A credentialed POST over a network anyone can read.
      'http://app.flue.sh',
    ]) {
      expect(await resolveRelaySession(handoff({ controlPlane }), memoryStore())).toBeNull()
    }
  })

  it('allows a plain-http control plane on loopback, for `vite dev`', async () => {
    vi.stubGlobal('indexedDB', new IDBFactory())
    for (const controlPlane of ['http://localhost:3001', 'http://127.0.0.1:3001']) {
      const session = await resolveRelaySession(handoff({ controlPlane }), memoryStore())
      expect(session?.controlPlane).toBe(controlPlane)
    }
  })

  it('still opens the session when sessionStorage refuses to hold anything', async () => {
    // Site data blocked costs this tab its reload and nothing else.
    vi.stubGlobal('indexedDB', new IDBFactory())
    const store = memoryStore()
    vi.spyOn(store, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError')
    })

    const session = await resolveRelaySession(handoff(), store)
    expect(session?.token).toBe('a-channel-token')
  })

  it('is null when the key store will not open at all', async () => {
    vi.stubGlobal('indexedDB', {
      open() {
        throw new Error('the key store is gone')
      },
    })
    expect(await resolveRelaySession(handoff(), memoryStore())).toBeNull()
  })
})

describe('resolveRelaySession, on a reload', () => {
  it('comes back from what the tab remembered, with no token', async () => {
    vi.stubGlobal('indexedDB', new IDBFactory())
    const store = memoryStore()
    await resolveRelaySession(handoff(), store)

    // The reload: the fragment is gone (it was scrubbed as it was read), so
    // there is no handoff to adopt.
    const session = await resolveRelaySession(null, store)

    expect(session).not.toBeNull()
    expect(session!.deviceId).toBe(ID_A)
    expect(session!.daemonPub).toEqual(KEY_A)
    expect(session!.controlPlane).toBe('https://app.flue.sh')
    // Nothing at rest holds a token; the first dial mints its own.
    expect(session!.token).toBeNull()
  })

  it('is null when the tab remembered nothing', async () => {
    // A bookmarked hosted-relay URL, or a self-hosted relay, which hands out
    // no session and asks for no token.
    vi.stubGlobal('indexedDB', new IDBFactory())
    expect(await resolveRelaySession(null, memoryStore())).toBeNull()
  })

  it('is null when the remembered machine has no pinned key', async () => {
    // Half a session cannot handshake, and asking for a token to open one
    // would be asking for a credential this tab could not spend.
    vi.stubGlobal('indexedDB', new IDBFactory())
    const store = memoryStore({
      'flue.relay.session': JSON.stringify({
        deviceId: 'cccccccccccc',
        controlPlane: 'https://app.flue.sh',
      }),
    })
    expect(await resolveRelaySession(null, store)).toBeNull()
  })

  it('is null when the pinned key does not hash to the id it is filed under', async () => {
    // The same check on the way out of the store as on the way in. `adopt` can
    // no longer write such a record, so this is about the ones already written
    // — by a build before that check existed — and it makes the invariant one
    // sentence rather than two: a key filed under an id always hashes to it.
    vi.stubGlobal('indexedDB', new IDBFactory())
    await savePinnedDaemonKeyFor(ID_A, KEY_B)
    const store = memoryStore({
      'flue.relay.session': JSON.stringify({ deviceId: ID_A, controlPlane: 'https://app.flue.sh' }),
    })

    expect(await resolveRelaySession(null, store)).toBeNull()
  })

  it('is null for anything that is not the shape it wrote', async () => {
    vi.stubGlobal('indexedDB', new IDBFactory())
    await savePinnedDaemonKeyFor(ID_A, KEY_A)

    for (const raw of [
      'not json',
      '{}',
      JSON.stringify({ deviceId: ID_A }),
      JSON.stringify({ controlPlane: 'https://app.flue.sh' }),
      JSON.stringify({ deviceId: 1, controlPlane: 'https://app.flue.sh' }),
      JSON.stringify({ deviceId: ID_A, controlPlane: 'javascript:alert(1)' }),
    ]) {
      expect(await resolveRelaySession(null, memoryStore({ 'flue.relay.session': raw }))).toBeNull()
    }
  })

  it('is null in a browser with no sessionStorage at all', async () => {
    vi.stubGlobal('indexedDB', new IDBFactory())
    expect(await resolveRelaySession(null, null)).toBeNull()
  })
})

describe('channelTokenSource', () => {
  const session = {
    deviceId: ID_A,
    daemonPub: KEY_A,
    controlPlane: 'https://app.flue.sh',
    token: 'the-handoff-token' as string | null,
  }

  it('is null with no session, so a self-hosted relay offers no subprotocol', () => {
    expect(channelTokenSource(null)).toBeNull()
  })

  it('spends the handoff token on the first dial and re-mints after it', async () => {
    // The bug this closes: the fragment's token lives sixty seconds, and every
    // reconnect used to present that same one. The first reconnect past a
    // minute was refused, and the tab reconnected into the identical refusal
    // forever.
    const minted: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        minted.push('call')
        return new Response(JSON.stringify({ token: `fresh-${minted.length}` }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }),
    )

    const source = channelTokenSource({ ...session })!

    expect(await source()).toBe('the-handoff-token')
    expect(minted).toHaveLength(0) // the first dial costs no round trip

    expect(await source()).toBe('fresh-1')
    expect(await source()).toBe('fresh-2')
    expect(minted).toHaveLength(2)
  })

  it('mints from the first dial when the tab was reloaded', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ token: 'fresh' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      ),
    )

    const source = channelTokenSource({ ...session, token: null })!
    expect(await source()).toBe('fresh')
  })

  it('rejects when the control plane refuses, so the socket can close', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":"no"}', { status: 403 })))

    const source = channelTokenSource({ ...session, token: null })!
    await expect(source()).rejects.toThrow()
  })
})
