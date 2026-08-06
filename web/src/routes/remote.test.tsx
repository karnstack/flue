import { act, fireEvent, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { FlueClientProvider } from '@/client/provider'
import type { RelayInfo } from '@/client/protocol'
import { renderWithRouter } from '@/testing/render'
import { fakeClient, type FakeSocket } from '@/testing/socket'
import { RemoteRoute } from './remote'

/** What the daemon says when its relay leg is up. */
const RELAY_UP: RelayInfo = { status: 'connected', origin: 'https://flue-relay.example' }

/**
 * The daemon's greeting, which every real connection opens with.
 *
 * `relay` is omitted rather than sent as `{status:'off'}` when there is none,
 * because that is what the wire does: internal/wire.Welcome carries a pointer
 * and internal/daemon's relayInfo returns nil for a daemon with no relay.
 */
const welcomed = (sock: FakeSocket, relay?: RelayInfo) =>
  act(() =>
    sock.emitControl({ type: 'welcome', daemonId: 'local', host: 'mb', ver: '0.1.0', relay }),
  )

/**
 * Mount the screen with a scripted socket under it.
 *
 * `renderWithRouter` rather than a bespoke router: the screen links to Devices,
 * and TanStack's Link throws without a router in context.
 */
async function mountRemote({ relay }: { relay?: RelayInfo } = {}) {
  const { client, sockets } = fakeClient()
  const view = await renderWithRouter(
    <FlueClientProvider client={client}>
      <RemoteRoute />
    </FlueClientProvider>,
    '/remote',
  )
  const sock = sockets[0]!
  act(() => sock.open())
  welcomed(sock, relay)
  return { ...view, client, sockets, sock }
}

/**
 * The two commands this screen exists to hand over, spelled exactly as the CLI
 * spells them (`usageText` in cmd/flue/main.go). A paraphrase here is a command
 * that does not exist, pasted into somebody's terminal.
 */
const SETUP = 'flue relay setup'
const LINK = 'flue link'
const STATUS = 'flue relay status'

/** What a browser that refuses the clipboard is told. */
const BY_HAND =
  'This browser would not hand flue the clipboard — select the command and copy it yourself.'

/**
 * navigator.clipboard, put back after a test that took it away.
 *
 * user-event installs a stub of its own on setup, so the property is restored
 * rather than deleted: leaving `undefined` behind would make every later copy
 * test in this file measure the fallback.
 */
const REAL_CLIPBOARD = Object.getOwnPropertyDescriptor(navigator, 'clipboard')

function withoutClipboard() {
  Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true })
}

afterEach(() => {
  if (REAL_CLIPBOARD) Object.defineProperty(navigator, 'clipboard', REAL_CLIPBOARD)
  else Reflect.deleteProperty(navigator, 'clipboard')
  vi.useRealTimers()
  vi.restoreAllMocks()
})

const copyButton = (command: string) => screen.getByRole('button', { name: `Copy ${command}` })

describe('RemoteRoute', () => {
  it('guides setup when the daemon has no relay', async () => {
    // The welcome carries no relay at all, which is how the daemon says "none
    // configured" — see relayInfo in internal/daemon/server.go.
    await mountRemote()

    expect(screen.getByRole('heading', { name: 'Remote access' })).toBeTruthy()
    expect(screen.getByText('Not configured')).toBeTruthy()
    // Both routes out of it: the self-hosted relay and the hosted account.
    expect(screen.getByText(SETUP)).toBeTruthy()
    expect(screen.getByText(LINK)).toBeTruthy()
  })

  it('says it cannot run either command itself', async () => {
    // The whole honesty of the screen. A browser cannot drive the daemon's CLI,
    // so a page that showed a "Set up" button would be offering a click that
    // does nothing — this one copies a command and says that is all it does.
    await mountRemote()

    expect(screen.getByText(/copy a command for you, not run it/)).toBeTruthy()
  })

  it('offers the account flow as well as the self-hosted one', async () => {
    await mountRemote()

    expect(screen.getByRole('link', { name: /flue\.sh/ }).getAttribute('href')).toBe(
      'https://app.flue.sh',
    )
  })

  it('copies a command to the clipboard', async () => {
    const user = userEvent.setup()
    await mountRemote()

    await user.click(copyButton(SETUP))

    expect(await navigator.clipboard.readText()).toBe(SETUP)
    expect(screen.getByText('Copied ✓')).toBeTruthy()
  })

  it('says so where the clipboard cannot be had', async () => {
    // A hardened browser, or a page served over plain http from something other
    // than loopback. The command is on screen and selectable either way, so
    // this degrades rather than failing silently — a copy button that did
    // nothing would leave the reader believing they had the command.
    await mountRemote()
    withoutClipboard()

    fireEvent.click(copyButton(SETUP))

    expect(await screen.findByText(BY_HAND)).toBeTruthy()
  })

  it('shows the origin the daemon is reachable at once the relay is up', async () => {
    await mountRemote({ relay: RELAY_UP })

    expect(screen.getByText('Connected')).toBeTruthy()
    expect(screen.getByText('https://flue-relay.example')).toBeTruthy()
    // The gate on the Devices screen is open at this point, and this is the
    // screen that says why.
    expect(screen.getByText(/pair a device against this address/i)).toBeTruthy()
    // Nothing left to set up, so nothing is offered.
    expect(screen.queryByText(SETUP)).toBeNull()
  })

  it('points at the flue.sh device directory once there is an address', async () => {
    await mountRemote({ relay: RELAY_UP })

    expect(screen.getByRole('link', { name: /device directory/i }).getAttribute('href')).toBe(
      'https://app.flue.sh/devices',
    )
  })

  it('reports a relay that is still being dialled without inventing an address', async () => {
    // The daemon blanks the origin for anything but `connected`
    // (SetRelayStatus), so there is no address to show while it dials — and
    // showing the one from a previous connection would be a claim that
    // something is reachable when nothing is.
    await mountRemote({ relay: { status: 'connecting' } })

    expect(screen.getByText('Connecting')).toBeTruthy()
    expect(screen.queryByText('https://flue-relay.example')).toBeNull()
    // The one command that prints what it is dialling.
    expect(screen.getByText(STATUS)).toBeTruthy()
  })

  it('reads the relay the client already holds when it mounts', async () => {
    // A screen reached by navigating mounts into a connection whose welcome
    // landed long ago. onWelcome reports only new ones, so a screen that waited
    // for one would sit on "Not configured" until the next reconnect.
    const { client, sockets } = fakeClient()
    client.connect()
    const sock = sockets[0]!
    act(() => sock.open())
    welcomed(sock, RELAY_UP)

    await renderWithRouter(
      <FlueClientProvider client={client}>
        <RemoteRoute />
      </FlueClientProvider>,
      '/remote',
    )

    expect(screen.getByText('Connected')).toBeTruthy()
    expect(screen.getByText('https://flue-relay.example')).toBeTruthy()
  })

  it('re-evaluates on the welcome each reconnect brings', async () => {
    // The relay state is a snapshot each connection's welcome carries, not a
    // stream: a relay that fell over during an outage is reported by the next
    // connection's greeting and by nothing else.
    vi.useFakeTimers({ shouldAdvanceTime: true })
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const { sock, sockets } = await mountRemote({ relay: RELAY_UP })
    expect(screen.getByText('Connected')).toBeTruthy()

    act(() => sock.close())
    await act(() => vi.advanceTimersByTimeAsync(2_000))
    const next = sockets[sockets.length - 1]!
    act(() => next.open())
    welcomed(next)

    expect(screen.getByText('Not configured')).toBeTruthy()
    expect(screen.getByText(SETUP)).toBeTruthy()
    expect(screen.queryByText('https://flue-relay.example')).toBeNull()
  })

  it('says how old what it is showing is when the daemon goes away', async () => {
    // Every claim on this screen comes from the last welcome, and a relay claim
    // outlives the connection that reported it — so "Connected, reachable from
    // anywhere" on a tab that lost the daemon is the one way this screen could
    // mislead. The address stays up, because it is still the best thing known;
    // what changes is that its age is stated.
    const { sock } = await mountRemote({ relay: RELAY_UP })

    act(() => sock.close())

    expect(screen.getByText(/Reconnecting/)).toBeTruthy()
    expect(screen.getByText('https://flue-relay.example')).toBeTruthy()
  })

  it('keeps one primary button on the screen', async () => {
    await mountRemote({ relay: RELAY_UP })

    const filled = screen
      .queryAllByRole('link')
      .concat(screen.queryAllByRole('button'))
      .filter((el) => el.getAttribute('data-variant') === 'default')

    expect(filled).toHaveLength(1)
  })
})
