import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { FlueClientContext } from '@/client/provider'
import type { RelayUIInfo } from '@/components/cloudflare-connect'
import type { ReleaseStatus } from '@/hooks/use-release'
import { fakeClient } from '@/testing/socket'
import { UpdateNotice } from './update-notice'

/*
 * The sidebar's update notice, against a scripted daemon.
 *
 * What these pin, beyond which words appear: the order the two states are
 * offered in, which is a fact about how flue is built rather than a
 * preference — the relay is deployed from the binary, so a relay redeployed
 * before the binary is upgraded is behind again immediately — and that the
 * flue half never offers to do something a browser cannot do.
 */

const RELEASE = '/api/flue/release'
const RELAY = '/api/relay/info'

/** Answer the two GETs the notice makes, and nothing else. */
function stubDaemon(answers: { release?: ReleaseStatus; relay?: RelayUIInfo }) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      const body = url.startsWith(RELEASE) ? answers.release : url.startsWith(RELAY) ? answers.relay : undefined
      if (!body) return new Response('', { status: 404 })
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }),
  )
}

const CURRENT: ReleaseStatus = { current: '0.4.1', update: false }
const BEHIND: ReleaseStatus = {
  current: '0.4.1',
  latest: '0.5.0',
  url: 'https://github.com/karnstack/flue/releases/tag/v0.5.0',
  update: true,
}

const RELAY_MATCHED: RelayUIInfo = {
  configured: true,
  can_deploy: true,
  version: '0.4.1',
  deployed_version: '0.4.1',
  has_token: true,
}
const RELAY_BEHIND: RelayUIInfo = { ...RELAY_MATCHED, deployed_version: '0.4.0' }

/** Mounted with a greeted client, so the version line has something to say. */
function mount() {
  const { client, last } = fakeClient()
  client.connect()
  const view = render(
    <FlueClientContext.Provider value={client}>
      <UpdateNotice />
    </FlueClientContext.Provider>,
  )
  // FakeSocket delivers synchronously, so the welcome's setState lands right
  // here — inside act, or as an act warning from every test in the file.
  act(() => {
    last().open()
    last().emitControl({ type: 'welcome', daemonId: 'local', host: 'macbook', ver: '0.4.1' })
  })
  return view
}

afterEach(() => vi.unstubAllGlobals())

describe('UpdateNotice', () => {
  it('says nothing but the version when nothing is behind', async () => {
    stubDaemon({ release: CURRENT, relay: RELAY_MATCHED })
    mount()

    expect(await screen.findByText('flue 0.4.1')).toBeTruthy()
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2))
    expect(screen.queryByText('Update available')).toBeNull()
    expect(screen.queryByText('Relay is behind')).toBeNull()
  })

  it('offers the release, and a window rather than a button that cannot work', async () => {
    stubDaemon({ release: BEHIND, relay: RELAY_MATCHED })
    mount()

    expect(await screen.findByText('Update available')).toBeTruthy()
    // Both numbers, so the reader can see the size of the jump without
    // going anywhere.
    expect(screen.getByText('0.5.0')).toBeTruthy()
    expect(screen.getByText('0.4.1')).toBeTruthy()

    // Not "Update". Nothing in a browser can replace a running binary on the
    // machine it is talking to, and a control that said so would be lying.
    await userEvent.click(screen.getByRole('button', { name: 'How to update' }))

    expect(await screen.findByRole('dialog')).toBeTruthy()
    expect(screen.getByText('brew upgrade karnstack/tap/flue')).toBeTruthy()
    expect(screen.getByText('curl -fsSL https://flue.sh/install.sh | sh')).toBeTruthy()
    // And the consequence, said before it happens rather than discovered as a
    // second notice afterwards.
    expect(screen.getByText(/relay ships with the binary/)).toBeTruthy()
  })

  it('offers the relay redeploy, which is a thing this page can actually do', async () => {
    stubDaemon({ release: CURRENT, relay: RELAY_BEHIND })
    mount()

    expect(await screen.findByText('Relay is behind')).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: 'Update relay' }))
    expect(await screen.findByRole('dialog')).toBeTruthy()
    expect(screen.getByText('Update the relay')).toBeTruthy()
  })

  it('speaks about flue first when both are behind', async () => {
    // Not a preference. The relay carries the Worker and the web bundle the
    // binary ships, so redeploying it before the upgrade lands buys a relay
    // that is out of date again a minute later.
    stubDaemon({ release: BEHIND, relay: RELAY_BEHIND })
    mount()

    expect(await screen.findByText('Update available')).toBeTruthy()
    expect(screen.queryByText('Relay is behind')).toBeNull()
  })

  it('sends away only what was sent away', async () => {
    // Dismissal is keyed by subject. Silencing "a new flue is out" must not
    // also silence the relay notice that follows the upgrade — which is the
    // one the reader can act on from here.
    stubDaemon({ release: BEHIND, relay: RELAY_BEHIND })
    mount()

    await userEvent.click(await screen.findByRole('button', { name: 'Dismiss: Update available' }))

    expect(screen.queryByText('Update available')).toBeNull()
    expect(await screen.findByText('Relay is behind')).toBeTruthy()
    // The version line is not part of the notice and never goes away with it.
    expect(screen.getByText('flue 0.4.1')).toBeTruthy()
  })

  it('picks up a release that lands while the tab sits open', async () => {
    // The whole reason this can be seen without a reload. The daemon has no
    // timer of its own — its check is started *by* a read of
    // /api/flue/release — so a tab that asked once and never again was a
    // daemon that checked once and never again, and a machine left running
    // with flue open never heard about a release at all.
    const answers = { release: CURRENT, relay: RELAY_MATCHED }
    stubDaemon(answers)
    mount()

    expect(await screen.findByText('flue 0.4.1')).toBeTruthy()
    expect(screen.queryByText('Update available')).toBeNull()

    // The release lands, and the daemon's next answer says so.
    answers.release = BEHIND
    act(() => {
      window.dispatchEvent(new Event('focus'))
    })

    expect(await screen.findByText('Update available')).toBeTruthy()
  })

  it('asks again on a timer, for a tab that is never left and never returned to', async () => {
    // A focused tab fires no focus events, and flue's is the tab people leave
    // focused. Without the interval the listener above covers everyone except
    // the person most likely to be looking.
    vi.useFakeTimers()
    try {
      stubDaemon({ release: CURRENT, relay: RELAY_MATCHED })
      mount()
      await vi.advanceTimersByTimeAsync(0)

      const asks = () =>
        vi.mocked(fetch).mock.calls.filter(([input]) => String(input).startsWith(RELEASE)).length
      expect(asks()).toBe(1)

      await vi.advanceTimersByTimeAsync(5 * 60 * 1000)
      expect(asks()).toBe(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('renders nothing at all on a daemon too old to answer', async () => {
    // A 404 from either endpoint is the ordinary case for an older daemon,
    // and for one that cannot reach GitHub. Neither is an error worth a
    // sentence: a version nobody could look up is not news.
    stubDaemon({})
    mount()

    expect(await screen.findByText('flue 0.4.1')).toBeTruthy()
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2))
    expect(screen.queryByText('Update available')).toBeNull()
    expect(screen.queryByText('Relay is behind')).toBeNull()
  })
})
