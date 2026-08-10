import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { RouterProvider } from '@tanstack/react-router'
import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  loadOrCreateDeviceKey,
  loadPinnedDaemonKey,
  loadPinnedDaemonKeyFor,
  loadPinnedFleetKey,
} from '@/crypto/keys'
import { listMachines } from '@/relay/machines'
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

/** The fleet public key, as `?f=` carries it: 32 bytes, unpadded URL-safe. */
const FLEET_PUB_BYTES = Uint8Array.from({ length: 32 }, (_, i) => 100 + i)
const FLEET_PUB_PARAM = urlSafe(btoa(String.fromCharCode(...FLEET_PUB_BYTES)))

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
 * The same refusal as the relay has to carry it.
 *
 * The daemon's own origin answers `pairing refused` as text/plain; the relay
 * cannot carry a bare text body over its control channel and answers the JSON
 * envelope instead — see spec/relay-protocol.md, `pairResult.body`. The page is
 * served over both, so it reads both.
 */
const refusedJson = () =>
  answer({ ok: false, status: 403, text: '{"error":"pairing refused"}' })

/** A relay that never got the request as far as the daemon. */
const relayFailure = (status: number, error: string) =>
  answer({ ok: false, status, text: `{"error":"${error}"}` })

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
  // Async act, because mounting RouterProvider re-runs router.load() from
  // Transitioner's mount effect, and its continuations update the router
  // stores a microtask after RTL's synchronous act exits — an act warning per
  // mounted Match on a runner slow enough to print them.
  let view!: ReturnType<typeof render>
  await act(async () => {
    view = render(<RouterProvider router={router} />)
  })
  return view
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
  // The machine records a relay-origin pairing writes, likewise per test.
  localStorage.clear()
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

  it('scrubs the token and the key from the address bar, and pairs from memory', async () => {
    // The live bearer token must not outlive its reading in the URL — the
    // address bar is a history entry, and history syncs. The page captures
    // both parameters before the rewrite, so the rewrite must not cost the
    // ceremony anything: TanStack notices the replaceState and re-renders
    // the route with an empty search, and the POST below is the proof the
    // page kept what the bar no longer shows.
    fetchMock.mockResolvedValue(paired())
    await renderPair(LINK)

    await waitFor(() => expect(window.location.search).toBe(''))
    expect(window.location.pathname).toBe('/pair')

    await userEvent.click(await armedPairButton())
    const { body } = posted(fetchMock)
    expect(body.token).toBe(TOKEN)
    expect(await screen.findByRole('heading', { name: 'Paired' })).toBeTruthy()
    expect(await loadPinnedDaemonKey()).toEqual(DAEMON_PUB_BYTES)
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

  it('reads the relay’s refusal as words rather than showing it as JSON', async () => {
    // Same refusal, different wrapping. A user reading `{"error":"pairing
    // refused"}` off a phone screen is being shown the wire, not told what
    // happened.
    fetchMock.mockResolvedValue(refusedJson())
    await renderPair(LINK)

    await userEvent.click(await armedPairButton())

    expect(await screen.findByText(/pairing refused/)).toBeTruthy()
    expect(status()).toContain('pairing refused')
    expect(status()).not.toContain('{')
    expect(status()).not.toContain('error"')
    expect(status()).toContain(EXPIRY_NOTE)

    // A 403 is the daemon's own answer, and presenting the token is what closed
    // the window — so there is nothing left to press.
    expect(screen.queryByRole('button', { name: 'Pair' })).toBeNull()
  })

  it('keeps the token alive when the relay could not reach the daemon', async () => {
    // 503 from the Worker: the daemon leg is not connected, so nothing was
    // presented and nothing was redeemed. The user's two-minute window is still
    // theirs, and taking the button away would throw it away for them.
    fetchMock.mockResolvedValue(relayFailure(503, 'daemon offline'))
    await renderPair(LINK)

    await userEvent.click(await armedPairButton())

    expect(await screen.findByText(/daemon offline/)).toBeTruthy()
    expect(status()).not.toContain('{')
    expect(pairButton()).toBeTruthy()
    expect(await loadPinnedDaemonKey()).toBeNull()
  })

  it('keeps the token alive when the daemon never answered the relay', async () => {
    // 504: the request was parked at the Worker until its deadline. The daemon
    // may never have seen it, and a second press is the user's to make — if the
    // token really was spent, the daemon will say so itself.
    fetchMock.mockResolvedValue(relayFailure(504, 'daemon did not answer'))
    await renderPair(LINK)

    await userEvent.click(await armedPairButton())

    expect(await screen.findByText(/did not answer/)).toBeTruthy()
    expect(pairButton()).toBeTruthy()
  })

  it('keeps the token alive when the relay rejected the request before the daemon saw it', async () => {
    // 400 from the Worker: a foreign Origin, or a body that did not parse.
    // The second is what a POST truncated by a phone's flaky connection looks
    // like — token and all, still live — and the relay answers 400 rather than
    // 403 for exactly this reason (relay/src/hub.ts, pairRejected). A retry is
    // the user's to make and this page must not have taken it away.
    fetchMock.mockResolvedValue(relayFailure(400, 'pairing request rejected'))
    await renderPair(LINK)

    await userEvent.click(await armedPairButton())

    expect(await screen.findByText(/pairing request rejected/)).toBeTruthy()
    expect(status()).not.toContain('{')
    expect(pairButton()).toBeTruthy()
    expect(await loadPinnedDaemonKey()).toBeNull()
  })

  it('does not put a proxy’s error page on the screen', async () => {
    // A relay origin has intermediaries in front of the daemon, and an edge
    // that is having a bad day answers with HTML. React would escape it and it
    // would still be a page of markup where a sentence belongs — in either
    // wrapping, so the JSON envelope is held to the same rule.
    const html = '<html><body><h1>502 Bad Gateway</h1></body></html>'
    fetchMock.mockResolvedValueOnce(answer({ ok: false, status: 502, text: html }))
    const first = await renderPair(LINK)

    await userEvent.click(await armedPairButton())
    expect(await screen.findByText(/502/)).toBeTruthy()
    expect(status()).not.toContain('Bad Gateway')
    first.unmount()

    fetchMock.mockResolvedValueOnce(
      answer({ ok: false, status: 403, text: JSON.stringify({ error: html }) }),
    )
    await renderPair(LINK)

    await userEvent.click(await armedPairButton())
    expect(await screen.findByText(/refused the pairing/)).toBeTruthy()
    expect(status()).not.toContain('Bad Gateway')
  })

  it('names the status when a refusal carried nothing worth quoting', async () => {
    // A 502 with an empty body: the relay could not make sense of what its
    // upstream said. There is nothing to repeat, so the page says only what it
    // knows — and leaves the button, because nothing here proves a redeem.
    fetchMock.mockResolvedValue(answer({ ok: false, status: 502, text: '' }))
    await renderPair(LINK)

    await userEvent.click(await armedPairButton())

    expect(await screen.findByText(/502/)).toBeTruthy()
    expect(pairButton()).toBeTruthy()
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

/**
 * Mount the pairing page as a relay would serve it: same document, same router,
 * an origin that is not the daemon's own.
 *
 * The whole location is replaced rather than one property spied on — jsdom's
 * `Location` is [Unforgeable], so a spy on one field throws — and it is
 * replaced *after* the history move so the pathname and search the router
 * reads are the ones the test named.
 */
async function renderRelayPair(search = '') {
  window.history.replaceState(null, '', `/pair${search}`)
  vi.stubGlobal('location', {
    ...window.location,
    href: `https://flue.example${window.location.pathname}${window.location.search}`,
    origin: 'https://flue.example',
    hostname: 'flue.example',
    pathname: window.location.pathname,
    search: window.location.search,
    hash: '',
    reload: vi.fn(),
    replace: vi.fn(),
  })
  const router = createFlueRouter()
  await router.load()
  // The same async act as renderPair, for the same post-mount load.
  let view!: ReturnType<typeof render>
  await act(async () => {
    view = render(<RouterProvider router={router} />)
  })
  return view
}

describe('PairRoute on a relay origin', () => {
  it('posts to the machine the link names, pins under it, and records it', async () => {
    fetchMock.mockResolvedValue(paired())
    await renderRelayPair(`${LINK}&d=blue-mesa&n=Blue%20Mesa`)

    await userEvent.click(await armedPairButton())
    await screen.findByRole('heading', { name: 'Paired' })

    // The id in the path is what picks the hub on a relay that fronts more
    // than one machine — a bare /api/pair no longer names any of them.
    const { url } = posted(fetchMock)
    expect(url).toBe('/api/pair/blue-mesa')

    // Pinned under the machine's id, so a second machine's ceremony cannot
    // overwrite this one — and not in the single self-host slot.
    expect(await loadPinnedDaemonKeyFor('blue-mesa')).toEqual(DAEMON_PUB_BYTES)
    expect(await loadPinnedDaemonKey()).toBeNull()

    // And written down, so the boot and the picker know this machine exists.
    const machines = listMachines()
    expect(machines).toHaveLength(1)
    expect(machines[0]).toMatchObject({ id: 'blue-mesa', name: 'Blue Mesa' })
    expect(machines[0]!.pairedAt).toBeGreaterThan(0)
  })

  it('pins the fleet key the link carried, and only from the link', async () => {
    // The anchor for every machine this browser has not paired with: a
    // certificate that verifies under this key is a machine it will dial.
    // So it comes out of the QR — the one leg no intermediary can sit in —
    // and never out of the answer to the POST.
    fetchMock.mockResolvedValue(paired())
    await renderRelayPair(`${LINK}&f=${FLEET_PUB_PARAM}&d=blue-mesa&n=Blue%20Mesa`)

    await userEvent.click(await armedPairButton())
    await screen.findByRole('heading', { name: 'Paired' })

    expect(await loadPinnedFleetKey()).toEqual(FLEET_PUB_BYTES)
    // The machine's own pin is unaffected: two facts, two records.
    expect(await loadPinnedDaemonKeyFor('blue-mesa')).toEqual(DAEMON_PUB_BYTES)
  })

  it('pairs the machine alone when the link carries no fleet key', async () => {
    // A relay from before the fleet key, or a daemon that holds none. The
    // ceremony is the one it always was, and nothing fleet-wide is pinned.
    fetchMock.mockResolvedValue(paired())
    await renderRelayPair(`${LINK}&d=blue-mesa`)

    await userEvent.click(await armedPairButton())
    await screen.findByRole('heading', { name: 'Paired' })

    expect(await loadPinnedFleetKey()).toBeNull()
    expect(await loadPinnedDaemonKeyFor('blue-mesa')).toEqual(DAEMON_PUB_BYTES)
  })

  it('pins no fleet key from an `f` that is not 32 bytes', async () => {
    // Nothing writes a short `f` but something that rewrote the link. It is
    // refused as no fleet key rather than rounded off into one, and this
    // machine still pairs — a browser that trusted it would be verifying
    // every machine certificate under bytes a stranger chose.
    fetchMock.mockResolvedValue(paired())
    await renderRelayPair(`${LINK}&f=c2hvcnQ&d=blue-mesa`)

    await userEvent.click(await armedPairButton())
    await screen.findByRole('heading', { name: 'Paired' })

    expect(await loadPinnedFleetKey()).toBeNull()
    expect(await loadPinnedDaemonKeyFor('blue-mesa')).toEqual(DAEMON_PUB_BYTES)
  })

  it('scrubs the fleet key out of the address bar with the rest', async () => {
    fetchMock.mockResolvedValue(paired())
    await renderRelayPair(`${LINK}&f=${FLEET_PUB_PARAM}&d=blue-mesa`)
    await waitFor(() => expect(document.location.search).toBe('?d=blue-mesa'))

    // And the ceremony still runs on what the first render captured.
    await userEvent.click(await armedPairButton())
    await screen.findByRole('heading', { name: 'Paired' })
    expect(await loadPinnedFleetKey()).toEqual(FLEET_PUB_BYTES)
  })

  it('scrubs the secrets but keeps the machine the link names', async () => {
    // `location` is this suite's stub and stays frozen; `document.location`
    // is the real bar the scrub rewrites, so it is where the rewrite shows.
    // The id and the name are not secrets and the ceremony still needs them
    // on a reload's explanation page, so only `t` and `k` go.
    fetchMock.mockResolvedValue(paired())
    await renderRelayPair(`${LINK}&d=blue-mesa&n=Blue%20Mesa`)

    await waitFor(() => expect(document.location.search).toBe('?d=blue-mesa&n=Blue+Mesa'))

    // And pairing still runs on the captured values: posted at the machine
    // the link named, pinned under it.
    await userEvent.click(await armedPairButton())
    await screen.findByRole('heading', { name: 'Paired' })
    expect(posted(fetchMock).url).toBe('/api/pair/blue-mesa')
    expect(await loadPinnedDaemonKeyFor('blue-mesa')).toEqual(DAEMON_PUB_BYTES)
  })

  it('walks straight into the machine it just paired', async () => {
    // The ceremony's product is access; "you can close this page" was making
    // the user go find it. Everything the relay boot needs is written before
    // `paired` is set, so the button selects the machine and does a full
    // document load — the same move MachinesRoute.connect makes, and for the
    // same reason: the tab's router was built before the record existed.
    fetchMock.mockResolvedValue(paired())
    await renderRelayPair(`${LINK}&d=blue-mesa&n=Blue%20Mesa`)

    await userEvent.click(await armedPairButton())
    await screen.findByRole('heading', { name: 'Paired' })
    expect(screen.queryByText(/close this page/)).toBeNull()

    await userEvent.click(screen.getByRole('button', { name: /Open this machine's sessions/ }))

    expect(sessionStorage.getItem('flue.machine.selected')).toBe('blue-mesa')
    expect(vi.mocked(location.replace)).toHaveBeenCalledWith('/')
  })

  it('falls back to the id as the name when the link carries none', async () => {
    fetchMock.mockResolvedValue(paired())
    await renderRelayPair(`${LINK}&d=blue-mesa`)

    await userEvent.click(await armedPairButton())
    await screen.findByRole('heading', { name: 'Paired' })

    expect(listMachines()[0]).toMatchObject({ id: 'blue-mesa', name: 'blue-mesa' })
  })

  it('refuses a link that names no machine, and posts nothing', async () => {
    // On a relay origin the machine id is the address: without one there is
    // nowhere to post and no slot to pin under, so the ceremony never starts.
    await renderRelayPair(LINK)

    expect(await screen.findByText(/names no machine|no machine/i)).toBeTruthy()
    expect(screen.getByText(EXPIRY_NOTE)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Pair' })).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(await loadPinnedDaemonKey()).toBeNull()
    expect(listMachines()).toEqual([])
  })

  it('refuses a machine id the relay would refuse, the same way', async () => {
    // The Worker 404s anything outside its grammar, and an id is about to be
    // spliced into a path — so the page holds the link to the same rule rather
    // than posting at a URL of the link's own design.
    await renderRelayPair(`${LINK}&d=Not%2FValid`)

    expect(await screen.findByText(/names no machine|no machine/i)).toBeTruthy()
    expect(screen.getByText(EXPIRY_NOTE)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Pair' })).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
