import { afterEach, describe, expect, it, vi } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'

import { loadOrCreateDeviceKey, savePinnedDaemonKey } from '@/crypto/keys'
import { isRelayOrigin, loadRelayIdentity } from './mode'

/** A daemon's static public key, as pairing would have left it behind. */
const DAEMON_PUB = Uint8Array.from({ length: 32 }, (_, i) => i + 1)

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('isRelayOrigin', () => {
  it('is false on every host the daemon serves the app from itself', () => {
    // The daemon binds loopback and nothing else, so these three hostnames are
    // the complete list of ways a page can have come from it.
    for (const hostname of ['127.0.0.1', 'localhost', '[::1]']) {
      expect(isRelayOrigin({ hostname })).toBe(false)
    }
  })

  it('is true on a host the daemon could not have been', () => {
    expect(isRelayOrigin({ hostname: 'flue-relay.example.workers.dev' })).toBe(true)
    expect(isRelayOrigin({ hostname: 'flue.sh' })).toBe(true)
  })
})

describe('loadRelayIdentity', () => {
  it('is null in a browser that has never paired', async () => {
    vi.stubGlobal('indexedDB', new IDBFactory())
    expect(await loadRelayIdentity()).toBeNull()
  })

  it('reads the pinned daemon key and this browser\'s own', async () => {
    const store = new IDBFactory()
    vi.stubGlobal('indexedDB', store)
    await savePinnedDaemonKey(DAEMON_PUB)

    const identity = await loadRelayIdentity()

    expect(identity!.daemonPub).toEqual(DAEMON_PUB)
    expect(identity!.deviceKey.privateKey).toEqual((await loadOrCreateDeviceKey()).privateKey)
  })

  it('mints no key for a browser that has no daemon to speak to', async () => {
    // A key is a persistent secret in the user's browser. Making one for a tab
    // that cannot reach anything would be storing a credential nobody asked
    // for — and the /pair page makes its own when the ceremony really starts.
    //
    // The count is the evidence: one open for the pinned key, and a second
    // would be the device key being created behind it.
    const store = new IDBFactory()
    const opened = vi.fn()
    vi.stubGlobal('indexedDB', {
      open: (name: string, version?: number) => {
        opened()
        return store.open(name, version)
      },
    })

    expect(await loadRelayIdentity()).toBeNull()
    expect(opened).toHaveBeenCalledTimes(1)
  })

  it('carries the pinned daemon key and this browser’s own key', async () => {
    // The self-hosted path, unchanged: one origin, one machine, the key the
    // /pair ceremony left behind.
    const store = new IDBFactory()
    vi.stubGlobal('indexedDB', store)
    await savePinnedDaemonKey(DAEMON_PUB)

    const identity = await loadRelayIdentity()

    expect(identity).not.toBeNull()
    expect(identity!.daemonPub).toEqual(DAEMON_PUB)
    // The same key the rest of the app would load, not a fresh one: the daemon
    // knows this browser by the public half it registered at pairing time.
    const device = await loadOrCreateDeviceKey()
    expect(identity!.deviceKey.privateKey).toEqual(device.privateKey)
    expect(identity!.deviceKey.publicKey).toEqual(device.publicKey)
  })

  it('is null when the key store cannot be read at all', async () => {
    // Private browsing, a blocked origin, a quota the browser will not grant.
    // There is no identity to be had either way, and the alternative is a
    // rejected promise at the entry point — which mounts nothing at all and
    // tells the user even less.
    vi.stubGlobal('indexedDB', {
      open() {
        throw new Error('the key store is gone')
      },
    })
    expect(await loadRelayIdentity()).toBeNull()
  })
})
