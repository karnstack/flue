import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { RouterProvider } from '@tanstack/react-router'
import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { loadOrCreateDeviceKey, loadPinnedDaemonKey } from '@/crypto/keys'
import { createFlueRouter } from '@/router'

/** The token a QR code carries: unpadded URL-safe base64 of 32 bytes. */
const TOKEN = 'Zm91cnRlZW4tY2hhcnMtb2YtdG9rZW4tc2hhcGVkLXQ'

/** The daemon's static public key, as the answer encodes it: standard base64. */
const DAEMON_PUB_BYTES = Uint8Array.from({ length: 32 }, (_, i) => i + 1)
const DAEMON_PUB = btoa(String.fromCharCode(...DAEMON_PUB_BYTES))

/** The same key as the QR carries it: unpadded URL-safe base64, in `?k=`. */
const urlSafe = (std: string) => std.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const DAEMON_PUB_PARAM = urlSafe(DAEMON_PUB)

/** Some other daemon's key — 32 bytes that are not the ones in the QR. */
const OTHER_PUB_BYTES = Uint8Array.from({ length: 32 }, (_, i) => 200 - i)
const OTHER_PUB = btoa(String.fromCharCode(...OTHER_PUB_BYTES))

/** A whole pairing link, as the QR encodes it: the token and the key. */
const LINK = `?t=${TOKEN}&k=${DAEMON_PUB_PARAM}`

const EXPIRY_NOTE =
  'Pairing links work once and expire after two minutes — start again from Devices on the paired browser.'

/**
 * A fetch answer, minted rather than constructed.
 *
 * `Response` is a browser global jsdom does not implement, and the pieces this
 * page touches are three methods — so the double is those three and nothing
 * else, which also keeps a test from passing on a helper the page never calls.
 */
function answer(init: { ok: boolean; status: number; json?: unknown; text?: string }): Response {
  return {
    ok: init.ok,
    status: init.status,
    json: async () => init.json,
    text: async () => init.text ?? '',
  } as unknown as Response
}

const paired = (over: Record<string, unknown> = {}) =>
  answer({ ok: true, status: 200, json: { deviceId: 'a1b2c3d4e5f6', daemonPub: DAEMON_PUB, ...over } })

const refused = (body = 'pairing refused\n') => answer({ ok: false, status: 403, text: body })

/**
 * Mount the real router at /pair.
 *
 * The real one rather than a fixture: the search parameter is read through
 * TanStack, and a route registered by the test would prove nothing about the
 * one the app ships — including that it sits outside the shell, which is the
 * decision router.tsx exists to make. There is no client provider here on
 * purpose, and this page must never need one: the device reading it holds no
 * session token, so the WebSocket that provider opens is not available to it.
 */
async function renderPair(search = '') {
  window.history.replaceState(null, '', `/pair${search}`)
  const router = createFlueRouter()
  await router.load()
  return render(<RouterProvider router={router} />)
}

const pairButton = () => screen.getByRole('button', { name: 'Pair' })
const status = () => screen.getByRole('status').textContent ?? ''

/**
 * The Pair button once it can actually be pressed.
 *
 * It is shut until the device key is in hand — pairing without one would enrol
 * nothing — and clicking a disabled button is a no-op userEvent reports as a
 * success, so a test that did not wait would spend its assertions on a request
 * that was never made.
 */
async function armedPairButton(): Promise<HTMLElement> {
  const button = await screen.findByRole('button', { name: 'Pair' })
  await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false))
  return button
}

/** The one request the page makes, as JSON. */
function posted(mock: ReturnType<typeof vi.fn>) {
  expect(mock).toHaveBeenCalledTimes(1)
  const [url, init] = mock.mock.calls[0] as [string, RequestInit]
  return { url, init, body: JSON.parse(String(init.body)) as Record<string, unknown> }
}

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  // jsdom ships no IndexedDB, and the page reaches for the default factory the
  // way the browser does. A fresh one per test keeps the device key a test
  // creates out of the next test's store.
  vi.stubGlobal('indexedDB', new IDBFactory())
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('PairRoute', () => {
  it('posts the token, the device key and the label, then confirms', async () => {
    fetchMock.mockResolvedValue(paired())
    await renderPair(LINK)

    const name = await screen.findByLabelText('Name this device')
    await userEvent.clear(name)
    await userEvent.type(name, 'Pixel by the sink')
    await userEvent.click(await armedPairButton())

    const { url, init, body } = posted(fetchMock)
    expect(url).toBe('/api/pair')
    expect(init.method).toBe('POST')
    expect(init.headers).toMatchObject({ 'Content-Type': 'application/json' })
    expect(body.token).toBe(TOKEN)
    expect(body.label).toBe('Pixel by the sink')

    // Standard base64 of the 32 raw bytes of this browser's own public key —
    // the encoding handlePair decodes, and the key it stores against the
    // device it just registered.
    const key = await loadOrCreateDeviceKey()
    expect(body.publicKey).toBe(btoa(String.fromCharCode(...key.publicKey)))

    expect(await screen.findByRole('heading', { name: 'Paired' })).toBeTruthy()
    expect(status()).toContain('Pixel by the sink')
    // Nothing left to press: the token is spent and the ceremony is over.
    expect(screen.queryByRole('button', { name: 'Pair' })).toBeNull()
  })

  it('pins the key the QR carried, once the daemon answers as that key', async () => {
    fetchMock.mockResolvedValue(paired())
    await renderPair(LINK)

    await userEvent.click(await armedPairButton())
    await screen.findByRole('heading', { name: 'Paired' })

    // The bytes, not the base64: this is what the Noise initiator will name as
    // the responder's static key. They come from `?k=` — the QR — and the
    // answer to the POST is only ever checked against them.
    expect(await loadPinnedDaemonKey()).toEqual(DAEMON_PUB_BYTES)
  })

  it('refuses a daemon whose key is not the one in the QR', async () => {
    // The whole point of `?k=`. The QR is drawn on a screen the user controls
    // and read by a camera; the POST and its answer travel the channel Noise IK
    // exists to protect. So a 200 from something that names a different key is
    // not a pairing to complete with a warning — it is the attack, and the
    // device must pin nothing and say so.
    fetchMock.mockResolvedValue(paired({ daemonPub: OTHER_PUB }))
    await renderPair(LINK)

    await userEvent.click(await armedPairButton())

    expect(await screen.findByText(/tampered with/)).toBeTruthy()
    expect(status()).toContain('not the one in the QR')
    expect(screen.queryByRole('heading', { name: 'Paired' })).toBeNull()

    // Neither key is kept: not the impostor's, and not the QR's either.
    expect(await loadPinnedDaemonKey()).toBeNull()

    // And no retry, because whatever answered has spent the window.
    expect(screen.queryByRole('button', { name: 'Pair' })).toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('asks the daemon for nothing when the link carries no key', async () => {
    // An old link, one retyped from a screenshot, or one a chat app shortened.
    // Without `?k=` there is nothing to check the daemon against, so falling
    // back to whatever the answer names would be trust-on-first-use over the
    // very channel the pinned key protects. It is a refusal, not a warning.
    await renderPair(`?t=${TOKEN}`)

    expect(await screen.findByText(/does not carry/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Pair' })).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(await loadPinnedDaemonKey()).toBeNull()
  })

  it('refuses a key parameter that is not 32 bytes of URL-safe base64', async () => {
    // Truncated in transit, or half of one. A key that will not decode to a
    // Noise static key is no key at all, and is refused exactly like a missing
    // one rather than being quietly dropped in favour of the answer's.
    await renderPair(`?t=${TOKEN}&k=${DAEMON_PUB_PARAM.slice(0, 20)}`)

    expect(await screen.findByText(/does not carry/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Pair' })).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(await loadPinnedDaemonKey()).toBeNull()
  })

  it('repeats the daemon’s refusal and says why it will not work twice', async () => {
    fetchMock.mockResolvedValue(refused())
    await renderPair(LINK)

    await userEvent.click(await armedPairButton())

    // Verbatim. The daemon answers every refusal with the same bytes on
    // purpose, so this page has nothing to add about which one happened — only
    // the rule that covers all of them.
    expect(await screen.findByText(/pairing refused/)).toBeTruthy()
    expect(status()).toContain('pairing refused')
    expect(status()).toContain(EXPIRY_NOTE)

    // The window closed on that presentation whether or not the token was
    // right, so there is no second attempt to offer — and none is made.
    expect(screen.queryByRole('button', { name: 'Pair' })).toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(await loadPinnedDaemonKey()).toBeNull()
  })

  it('leaves the button in place when the daemon was never reached', async () => {
    // Nothing was answered, so nothing was necessarily spent: the token may
    // still be live, and a second press is the user's to make. It is never
    // made for them.
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'))
    await renderPair(LINK)

    await userEvent.click(await armedPairButton())

    expect(await screen.findByText(/could not be reached/)).toBeTruthy()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(pairButton()).toBeTruthy()
  })

  it('refuses to call a pairing done when the answer carried no usable key', async () => {
    // A 200 with an unreadable daemonPub means the daemon registered this
    // device and this device cannot name it. Reporting success would be a
    // pairing that only fails at the first handshake, long after the page is
    // closed.
    fetchMock.mockResolvedValue(paired({ daemonPub: 'not base64 at all' }))
    await renderPair(LINK)

    await userEvent.click(await armedPairButton())

    expect(await screen.findByText(/could not be read/)).toBeTruthy()
    expect(screen.queryByRole('heading', { name: 'Paired' })).toBeNull()
    expect(await loadPinnedDaemonKey()).toBeNull()

    // And it says what is actually true on the other side. The 200 means the
    // daemon wrote this device into devices.json, so "nothing was kept" would
    // be a lie about the daemon: the paired browser is listing a device the
    // user has no working half of, and only a revoke there clears it.
    expect(status()).toContain('now lists this device')
    expect(status()).toContain('revoke')
  })

  it('says the device is paired anyway when the key cannot be stored', async () => {
    // Same side of the 200, different failure: the daemon kept its half and
    // this browser could not keep its own. The device is registered either way,
    // so the instruction is the same one — go and revoke it.
    fetchMock.mockResolvedValue(paired())
    await renderPair(LINK)

    // The device key is already in hand by the time the button arms, so taking
    // the store away here fails exactly the save that follows the 200.
    const button = await armedPairButton()
    vi.stubGlobal('indexedDB', {
      open() {
        throw new Error('the key store is gone')
      },
    })

    await userEvent.click(button)

    expect(await screen.findByText(/would not keep/)).toBeTruthy()
    expect(screen.queryByRole('heading', { name: 'Paired' })).toBeNull()
    expect(status()).toContain('now lists this device')
    expect(status()).toContain('revoke')
  })

  it('explains itself and asks the daemon for nothing without a token', async () => {
    await renderPair()

    expect(screen.getByRole('heading', { name: 'Nothing to pair with yet' })).toBeTruthy()
    expect(screen.getByText(/open Devices/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Pair' })).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()

    // Nor is a key made for a ceremony that is not happening: this page is
    // reachable without any credential at all, so a visit must leave nothing
    // behind.
    expect(await loadPinnedDaemonKey()).toBeNull()
  })

  it('offers the platform as the name, and falls back when there is none', async () => {
    fetchMock.mockResolvedValue(paired())
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue('iPhone')

    const view = await renderPair(LINK)
    expect(await screen.findByDisplayValue('iPhone')).toBeTruthy()
    view.unmount()

    vi.spyOn(navigator, 'platform', 'get').mockReturnValue('')
    await renderPair(LINK)
    expect(await screen.findByDisplayValue('This device')).toBeTruthy()
  })
})
