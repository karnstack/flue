import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import { x25519 } from '@noble/curves/ed25519.js'

import vectors from '../../../testdata/noise/ik.json'
import type { FlueClient } from '@/client/client'
import { savePinnedDaemonKeyFor } from '@/crypto/keys'
import { responderHandshake } from '@/testing/noise-daemon'
import { relayBoot } from './boot'
import { saveMachine, SELECTED_KEY } from './machines'
import type { RawSocket } from './socket'

const unhex = (s: string) => new Uint8Array((s.match(/.{2}/g) ?? []).map((b) => parseInt(b, 16)))

/** The daemon the selected machine is pinned to — a key pair the Noise
 *  vectors already carry, so the responder half can prove it was named. */
const DAEMON_PRIV = unhex(vectors.responderStaticPriv)
const DAEMON_PUB = x25519.getPublicKey(DAEMON_PRIV)

/** Some other machine's key: valid, pinned, and not the selected one's. */
const OTHER_PUB = x25519.getPublicKey(Uint8Array.from({ length: 32 }, (_, i) => i + 7))

const MESA = { id: 'blue-mesa', name: 'Blue Mesa', pairedAt: 1_700_000_000_000 }
const ATTIC = { id: 'attic-pi', name: 'Attic Pi', pairedAt: 1_700_000_001_000 }

/** The least transport that lets the relay socket dial and speak once. */
class FakeRaw implements RawSocket {
  sent: Array<string | ArrayBuffer | Uint8Array> = []
  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onmessage: ((data: string | ArrayBuffer) => void) | null = null
  send(data: string | ArrayBuffer | Uint8Array) {
    this.sent.push(data)
  }
  close() {}
  open() {
    this.onopen?.()
  }
}

/** A wsFactory that records every URL the boot's client dials. */
function recordingFactory() {
  const urls: string[] = []
  const raws: FakeRaw[] = []
  const factory = (url: string): RawSocket => {
    urls.push(url)
    const raw = new FakeRaw()
    raws.push(raw)
    return raw
  }
  return { urls, raws, factory }
}

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  vi.stubGlobal('indexedDB', new IDBFactory())
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('relayBoot', () => {
  it('is the picker when nothing is paired, and dials nothing', async () => {
    const { urls, factory } = recordingFactory()

    expect(await relayBoot('https://relay.example', factory)).toEqual({ picker: true })
    expect(urls).toEqual([])
  })

  it('is the picker when two machines wait and no selection was made', async () => {
    saveMachine(MESA)
    saveMachine(ATTIC)
    await savePinnedDaemonKeyFor(MESA.id, OTHER_PUB)
    await savePinnedDaemonKeyFor(ATTIC.id, DAEMON_PUB)

    expect(await relayBoot('https://relay.example')).toEqual({ picker: true })
  })

  it('is the picker when the chosen machine’s pin has gone missing', async () => {
    // A record without its key is a row to pick again, not a client to build:
    // a socket with no responder static would reconnect into the same failed
    // handshake for as long as the tab stayed open.
    saveMachine(MESA)
    expect(await relayBoot('https://relay.example')).toEqual({ picker: true })
  })

  it('is the picker when the key store will not open at all, rather than a crash', async () => {
    // Private browsing, a blocked origin, a quota refused. A rejected promise
    // here is the entry point, so it would mount nothing and say even less.
    saveMachine(MESA)
    vi.stubGlobal('indexedDB', {
      open() {
        throw new Error('the key store is gone')
      },
    })

    expect(await relayBoot('https://relay.example')).toEqual({ picker: true })
  })

  it('builds the selected machine’s client: its id in the URL, its key in the handshake', async () => {
    // Two machines, two pins, one selection — so a boot that reached for the
    // wrong record on either axis fails one of the two assertions below.
    saveMachine(MESA)
    saveMachine(ATTIC)
    sessionStorage.setItem(SELECTED_KEY, ATTIC.id)
    await savePinnedDaemonKeyFor(MESA.id, OTHER_PUB)
    await savePinnedDaemonKeyFor(ATTIC.id, DAEMON_PUB)

    const { urls, raws, factory } = recordingFactory()
    const boot = await relayBoot('https://relay.example', factory)

    expect('client' in boot && boot.client).toBeTruthy()
    const client = (boot as { client: FlueClient }).client
    client.connect()

    // The id: the selected machine's slot, nobody else's.
    expect(urls).toEqual(['wss://relay.example/client/attic-pi'])

    // The key: message A is sealed to the static pinned under attic-pi, so
    // only the daemon holding that key's private half can read it. Were the
    // boot to hand the socket blue-mesa's pin — the single-slot bug this
    // exists to catch — readMessageA here would throw.
    const raw = raws[0]!
    raw.open()
    const msgA = raw.sent.find((d): d is Uint8Array => typeof d !== 'string')
    expect(msgA).toBeDefined()
    const peer = responderHandshake(DAEMON_PRIV).readMessageA(new Uint8Array(msgA!))
    expect(peer).toHaveLength(32)

    client.close()
  })

  it('auto-selects the only machine there is', async () => {
    saveMachine(ATTIC)
    await savePinnedDaemonKeyFor(ATTIC.id, DAEMON_PUB)

    const { urls, factory } = recordingFactory()
    const boot = await relayBoot('https://relay.example', factory)

    expect('client' in boot).toBe(true)
    ;(boot as { client: FlueClient }).client.connect()
    expect(urls).toEqual(['wss://relay.example/client/attic-pi'])
    ;(boot as { client: FlueClient }).client.close()
  })
})
