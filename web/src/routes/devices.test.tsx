import { act, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { FlueClientProvider } from '@/client/provider'
import type { DeviceInfo, Pairing, RelayInfo } from '@/client/protocol'
import { renderWithRouter } from '@/testing/render'
import { fakeClient, type FakeSocket } from '@/testing/socket'
import { DevicesRoute } from './devices'

/** A fixed wall clock, so "last seen" and the countdown are assertable. */
const NOW_MS = Date.parse('2026-08-05T12:00:00Z')
const NOW = NOW_MS / 1000

function device(over: Partial<DeviceInfo> & { id: string }): DeviceInfo {
  return {
    label: 'iPhone',
    pairedAt: NOW - 86_400,
    lastSeen: NOW - 300,
    ...over,
  }
}

/**
 * A pairing window with two minutes left on whatever clock is running.
 *
 * Read from `Date.now` rather than pinned to NOW, so a test that has not set
 * the system time still gets a live window rather than one the screen expires
 * on its first tick.
 */
function pairing(over: Partial<Pairing> = {}): Pairing {
  return {
    type: 'pairing',
    token: 'zK3tokenzK3',
    url: 'http://127.0.0.1:7717/pair?t=zK3tokenzK3',
    daemonPub: 'ZGFlbW9uLXB1YmxpYy1rZXk=',
    expiresAt: Math.floor(Date.now() / 1000) + 120,
    ...over,
  }
}

/** What the daemon says when its relay leg is up, which most cases start from. */
const RELAY_UP: RelayInfo = { status: 'connected', origin: 'https://flue-relay.example' }

/** The daemon's greeting, which every real connection opens with. */
const welcomed = (sock: FakeSocket, relay?: RelayInfo) =>
  act(() =>
    sock.emitControl({ type: 'welcome', daemonId: 'local', host: 'mb', ver: '0.1.0', relay }),
  )

/**
 * Mount the screen with a scripted socket under it.
 *
 * `renderWithRouter` rather than a bespoke router: this screen navigates
 * nowhere, so the only thing the router is here for is the nav context every
 * shell route renders inside.
 *
 * The socket is opened after the first render on purpose — a cold tab mounts
 * this screen while the client is still connecting, and the request for the
 * device list has to survive that.
 *
 * The welcome carries a connected relay by default, because jsdom serves every
 * test from localhost: without an address other devices could reach, the Pair
 * button is gated shut, and most of this file is about what happens after it
 * is pressed. The gating cases below say `relay` themselves.
 */
async function mountDevices(
  { open = true, relay = RELAY_UP }: { open?: boolean; relay?: RelayInfo } = {},
) {
  const { client, sockets } = fakeClient()
  const view = await renderWithRouter(
    <FlueClientProvider client={client}>
      <DevicesRoute />
    </FlueClientProvider>,
    '/devices',
  )
  const sock = sockets[0]!
  if (open) {
    act(() => sock.open())
    welcomed(sock, relay)
  }
  return { ...view, client, sockets, sock }
}

const listed = (sock: FakeSocket, devices: DeviceInfo[]) =>
  act(() => sock.emitControl({ type: 'deviceList', devices }))

const offered = (sock: FakeSocket, p: Pairing = pairing()) => act(() => sock.emitControl(p))

const pairButton = () => screen.getByRole('button', { name: 'Pair device' })
const notice = () => screen.getByRole('status').textContent ?? ''

/**
 * The words the gate shows, pinned exactly: this copy is the screen's whole
 * account of why its primary button is shut, and a paraphrase drifting away
 * from the actual command (`flue relay setup`) would strand the reader.
 */
const EXPLAINER =
  "Remote devices can't reach 127.0.0.1. Run flue relay setup to give this daemon an address, then pair."

/**
 * A 2D context good enough for lean-qr, since jsdom ships none.
 *
 * Stubbed rather than skipped: without it jsdom reports "not implemented" and
 * hands back null, so every QR assertion here would be measuring the screen's
 * own fallback instead of the code it is meant to draw. The two methods below
 * are the whole of what `toCanvas` touches.
 */
function stubCanvas() {
  return vi
    .spyOn(HTMLCanvasElement.prototype, 'getContext')
    .mockImplementation(
      () =>
        ({
          createImageData: (width: number, height: number) => ({
            width,
            height,
            data: new Uint8ClampedArray(width * height * 4),
          }),
          putImageData: () => {},
        }) as unknown as CanvasRenderingContext2D,
    )
}

beforeEach(() => {
  stubCanvas()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('DevicesRoute', () => {
  it('asks for the device list on mount, even before the socket is up', async () => {
    // Held by the client and replayed on every connection, so a screen that
    // mounted cold is not left permanently empty.
    const { sock } = await mountDevices({ open: false })
    expect(sock.ofType('devices')).toEqual([])

    act(() => sock.open())

    expect(sock.ofType('devices')).toEqual([{ type: 'devices' }])
  })

  it('does not poll for the device list', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const { sock } = await mountDevices()

    await act(() => vi.advanceTimersByTimeAsync(30_000))

    expect(sock.ofType('devices')).toHaveLength(1)
  })

  it('does not claim nothing is paired before the daemon has answered', async () => {
    const { sock } = await mountDevices()
    expect(screen.queryByText(/No paired devices yet/i)).toBeNull()

    listed(sock, [])

    expect(screen.getByText(/No paired devices yet/i)).toBeTruthy()
  })

  it('renders each device by label, with when it was last seen', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    vi.setSystemTime(NOW_MS)
    const { sock } = await mountDevices()

    listed(sock, [
      device({ id: 'aa11bb22cc33', label: 'iPhone', lastSeen: NOW - 300 }),
      device({ id: 'dd44ee55ff66', label: 'Work laptop', lastSeen: NOW - 7_200 }),
    ])

    expect(screen.getByText('iPhone')).toBeTruthy()
    expect(screen.getByText('Work laptop')).toBeTruthy()
    expect(screen.getByText('5m ago')).toBeTruthy()
    expect(screen.getByText('2h ago')).toBeTruthy()
  })

  it('asks before it revokes', async () => {
    const { sock } = await mountDevices()
    listed(sock, [device({ id: 'aa11bb22cc33', label: 'iPhone' })])

    await userEvent.click(screen.getByRole('button', { name: /Revoke iPhone/i }))
    expect(sock.ofType('revoke')).toEqual([])

    await userEvent.click(screen.getByRole('button', { name: /Confirm/i }))

    expect(sock.ofType('revoke')).toEqual([{ type: 'revoke', deviceId: 'aa11bb22cc33' }])
  })

  it('moves focus to the confirmation it just put in place', async () => {
    // The swap replaces the control that was activated. Left alone, focus
    // falls to the body — so a keyboard user is given no indicator, no
    // announcement, and no way to reach a question they cannot tell was asked.
    const { sock } = await mountDevices()
    listed(sock, [device({ id: 'aa11bb22cc33', label: 'iPhone' })])

    await userEvent.click(screen.getByRole('button', { name: /Revoke iPhone/i }))

    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: 'Confirm revoking iPhone' }),
    )
  })

  it('reddens the revoke under the pointer, not only under the row', async () => {
    // The ghost variant carries `hover:text-foreground`, and a `group-hover:`
    // utility does not displace it: the modifiers differ, so twMerge keeps
    // both and the sheet emits the plain one later at equal specificity. The
    // pointer landing on the button would then take the red back off it.
    const { sock } = await mountDevices()
    listed(sock, [device({ id: 'aa11bb22cc33', label: 'iPhone' })])

    const classes = screen.getByRole('button', { name: /Revoke iPhone/i }).className

    expect(classes).toContain('hover:text-destructive')
    expect(classes).not.toContain('hover:text-foreground')
  })

  it('backs out of a revoke that was not confirmed', async () => {
    const { sock } = await mountDevices()
    listed(sock, [device({ id: 'aa11bb22cc33', label: 'iPhone' })])

    await userEvent.click(screen.getByRole('button', { name: /Revoke iPhone/i }))
    await userEvent.click(screen.getByRole('button', { name: /Cancel/i }))

    expect(sock.ofType('revoke')).toEqual([])
    expect(screen.getByRole('button', { name: /Revoke iPhone/i })).toBeTruthy()
  })

  it('arms one row at a time', async () => {
    // Two rows both showing Confirm is two loaded guns, and the second one
    // was armed by a click the reader has already forgotten making.
    const { sock } = await mountDevices()
    listed(sock, [
      device({ id: 'aa11bb22cc33', label: 'iPhone' }),
      device({ id: 'dd44ee55ff66', label: 'Work laptop' }),
    ])

    await userEvent.click(screen.getByRole('button', { name: /Revoke iPhone/i }))
    await userEvent.click(screen.getByRole('button', { name: /Revoke Work laptop/i }))

    expect(screen.getAllByRole('button', { name: /Confirm/i })).toHaveLength(1)
  })

  it('opens a pairing window only when the user asks', async () => {
    const { sock } = await mountDevices()
    listed(sock, [])
    expect(sock.ofType('pairStart')).toEqual([])

    await userEvent.click(pairButton())

    expect(sock.ofType('pairStart')).toEqual([{ type: 'pairStart' }])
  })

  it('shows the link and its QR code once the daemon has opened the window', async () => {
    const { sock, container } = await mountDevices()
    await userEvent.click(pairButton())

    offered(sock)

    expect(screen.getByText('http://127.0.0.1:7717/pair?t=zK3tokenzK3')).toBeTruthy()
    const canvas = container.querySelector('canvas')
    expect(canvas).not.toBeNull()
    // Drawn, not merely mounted: lean-qr sizes the canvas to the code it
    // generated, so an empty one is a QR nobody could scan.
    expect(canvas!.width).toBeGreaterThan(20)
    expect(canvas!.width).toBe(canvas!.height)
  })

  it('adds the machine to the link when the relay carries one by name', async () => {
    // The daemon writes ?t= and ?k= into the URL; which machine the link pairs
    // against is this tab's to add, from the welcome's relay snapshot. The
    // name rides along only as a query parameter, encoded — never in a path.
    const { sock } = await mountDevices({
      relay: { ...RELAY_UP, machineId: 'blue-mesa', machineName: 'Blue Mesa' },
    })
    await userEvent.click(pairButton())

    offered(sock)

    expect(
      screen.getByText('http://127.0.0.1:7717/pair?t=zK3tokenzK3&d=blue-mesa&n=Blue%20Mesa'),
    ).toBeTruthy()
  })

  it('leaves the name off the link when the relay reports none', async () => {
    const { sock } = await mountDevices({
      relay: { ...RELAY_UP, machineId: 'blue-mesa' },
    })
    await userEvent.click(pairButton())

    offered(sock)

    expect(
      screen.getByText('http://127.0.0.1:7717/pair?t=zK3tokenzK3&d=blue-mesa'),
    ).toBeTruthy()
  })

  it('still shows the link where no canvas can be drawn', async () => {
    // A hardened browser can refuse a 2D context, and the link below the code
    // is the whole of what the code encodes — so that path degrades rather
    // than taking the pairing window down with it.
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
    const { sock } = await mountDevices()

    offered(sock)

    expect(screen.getByText('http://127.0.0.1:7717/pair?t=zK3tokenzK3')).toBeTruthy()
  })

  it('says the link is single-use, and counts down to its expiry', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW_MS)
    const { sock } = await mountDevices()

    offered(sock)
    expect(screen.getByText(/works once/i)).toBeTruthy()
    expect(screen.getByText('2:00')).toBeTruthy()

    await act(() => vi.advanceTimersByTimeAsync(61_000))

    expect(screen.getByText('0:59')).toBeTruthy()
  })

  it('clears a window that has run out rather than showing a dead link', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW_MS)
    const { sock } = await mountDevices()
    offered(sock)

    await act(() => vi.advanceTimersByTimeAsync(121_000))

    expect(screen.queryByText('http://127.0.0.1:7717/pair?t=zK3tokenzK3')).toBeNull()
    expect(notice()).toMatch(/expired/i)
  })

  it('closes the window when the user cancels, and tells the daemon', async () => {
    const { sock } = await mountDevices()
    await userEvent.click(pairButton())
    offered(sock)

    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(sock.ofType('pairCancel')).toEqual([{ type: 'pairCancel' }])
    expect(screen.queryByText('http://127.0.0.1:7717/pair?t=zK3tokenzK3')).toBeNull()
  })

  it('will not retire a code it cannot retire the token behind', async () => {
    // `pairCancel` is dropped while the socket is down. Taking the click
    // anyway would clear the card while the daemon's window ran on for the
    // rest of its two minutes — a QR taken off the screen without the token
    // behind it being taken back.
    const { sock } = await mountDevices()
    await userEvent.click(pairButton())
    offered(sock)

    act(() => sock.close())

    expect(screen.getByRole('button', { name: 'Cancel' }).hasAttribute('disabled')).toBe(true)
    expect(sock.ofType('pairCancel')).toEqual([])
    expect(screen.getByText('http://127.0.0.1:7717/pair?t=zK3tokenzK3')).toBeTruthy()
  })

  it('confirms the pairing when a device that was not there arrives', async () => {
    const { sock } = await mountDevices()
    listed(sock, [device({ id: 'aa11bb22cc33', label: 'iPhone' })])
    await userEvent.click(pairButton())
    offered(sock)

    listed(sock, [
      device({ id: 'aa11bb22cc33', label: 'iPhone' }),
      device({ id: 'dd44ee55ff66', label: 'iPad' }),
    ])

    expect(notice()).toContain('iPad')
    expect(screen.queryByText('http://127.0.0.1:7717/pair?t=zK3tokenzK3')).toBeNull()
  })

  it('keeps the window open when the list changes for some other reason', async () => {
    // A revoke elsewhere broadcasts a new list to every connection. Reading
    // that as "a device paired" would close the window on a token the user is
    // still holding a phone up to.
    const { sock } = await mountDevices()
    listed(sock, [
      device({ id: 'aa11bb22cc33', label: 'iPhone' }),
      device({ id: 'dd44ee55ff66', label: 'iPad' }),
    ])
    await userEvent.click(pairButton())
    offered(sock)

    listed(sock, [device({ id: 'aa11bb22cc33', label: 'iPhone' })])

    expect(screen.getByText('http://127.0.0.1:7717/pair?t=zK3tokenzK3')).toBeTruthy()
    expect(notice()).not.toMatch(/paired/i)
  })

  it('claims no pairing when it had no list to compare against', async () => {
    // Open a window before the daemon's first answer and every device in that
    // answer is one this screen had not seen. Announcing one of them as newly
    // paired would be an invention, and a cold tab is exactly where it would
    // happen.
    const { sock } = await mountDevices()
    offered(sock)

    listed(sock, [device({ id: 'aa11bb22cc33', label: 'iPhone' })])

    expect(notice()).not.toMatch(/paired/i)
    expect(screen.getByText('http://127.0.0.1:7717/pair?t=zK3tokenzK3')).toBeTruthy()
  })

  it('disarms a row the daemon has stopped reporting', async () => {
    // A device id is derived from its key, so a device revoked from another
    // tab and paired again is the same row — which would return already
    // asking to be revoked.
    const { sock } = await mountDevices()
    listed(sock, [device({ id: 'aa11bb22cc33', label: 'iPhone' })])
    await userEvent.click(screen.getByRole('button', { name: /Revoke iPhone/i }))

    listed(sock, [])
    listed(sock, [device({ id: 'aa11bb22cc33', label: 'iPhone' })])

    expect(screen.queryByRole('button', { name: /Confirm/i })).toBeNull()
  })

  it('will not act on a click it cannot send', async () => {
    // Every op on this screen is dropped rather than held while the socket is
    // down, so a live button would be a click that silently did nothing.
    const { sock } = await mountDevices()
    listed(sock, [device({ id: 'aa11bb22cc33', label: 'iPhone' })])

    act(() => sock.close())

    expect(pairButton().hasAttribute('disabled')).toBe(true)
    expect(screen.getByRole('button', { name: /Revoke iPhone/i }).hasAttribute('disabled')).toBe(
      true,
    )
    expect(notice()).toMatch(/reconnecting/i)
  })

  it('says so when the daemon refuses a revoke, and stays usable', async () => {
    // A row revoked from another tab a moment ago is answered `unknown_device`
    // rather than with a new list, so this is the one op whose failure leaves
    // the screen looking untouched.
    const { sock } = await mountDevices()
    listed(sock, [
      device({ id: 'aa11bb22cc33', label: 'iPhone' }),
      device({ id: 'dd44ee55ff66', label: 'iPad' }),
    ])
    await userEvent.click(screen.getByRole('button', { name: /Revoke iPhone/i }))
    await userEvent.click(screen.getByRole('button', { name: /Confirm/i }))

    act(() => sock.emitControl({ type: 'error', code: 'unknown_device', msg: 'no such device' }))

    expect(notice()).toMatch(/already/i)
    await userEvent.click(screen.getByRole('button', { name: /Revoke iPad/i }))
    await userEvent.click(screen.getByRole('button', { name: /Confirm/i }))
    expect(sock.ofType('revoke')).toHaveLength(2)
  })

  it('ignores an error that answers some other screen’s request', async () => {
    // One client serves the whole tab, so this listener sees every error —
    // including a spawn the sessions screen is waiting on.
    const { sock } = await mountDevices()
    listed(sock, [device({ id: 'aa11bb22cc33' })])

    act(() =>
      sock.emitControl({ type: 'error', code: 'spawn_failed', msg: 'chdir /nope', reqId: 3 }),
    )

    expect(notice()).not.toContain('chdir')
  })

  it('gates pairing when no other device could reach the address the QR would carry', async () => {
    // jsdom serves this page from localhost — the loopback case — and the
    // daemon's welcome says its relay leg is off, so a pairing URL made now
    // would name 127.0.0.1: an address every other device resolves to itself.
    const { sock } = await mountDevices({ relay: { status: 'off' } })
    listed(sock, [])

    expect(pairButton().hasAttribute('disabled')).toBe(true)
    expect(screen.getByText(EXPLAINER)).toBeTruthy()
  })

  it('ties the shut Pair button to the sentence that explains it', async () => {
    // Proximity is not a relationship: the button and its explanation sit on
    // opposite sides of one flex row, so a keyboard reader who lands on the
    // shut button hears "Pair device, dimmed" and nothing else unless the two
    // are linked.
    const { sock } = await mountDevices({ relay: { status: 'off' } })
    listed(sock, [])

    const describedBy = pairButton().getAttribute('aria-describedby')
    expect(describedBy).toBeTruthy()
    expect(document.getElementById(describedBy as string)?.textContent).toContain(
      EXPLAINER,
    )
  })

  it('sends the reader to the screen that can do something about the gate', async () => {
    // The explainer names a command; /remote is where that command is
    // explained, and it is the only screen in the app with anything to say
    // about a relay.
    const { sock } = await mountDevices({ relay: { status: 'off' } })
    listed(sock, [])

    expect(
      screen.getByRole('link', { name: /set up remote access/i }).getAttribute('href'),
    ).toBe('/remote')
  })

  it('offers pairing while the relay is connected, and says nothing else about it', async () => {
    const { sock } = await mountDevices({ relay: RELAY_UP })
    listed(sock, [])

    expect(pairButton().hasAttribute('disabled')).toBe(false)
    expect(screen.queryByText(EXPLAINER)).toBeNull()
    // And nothing left to point at, so the button describes nothing.
    expect(pairButton().getAttribute('aria-describedby')).toBeNull()
  })

  it('re-evaluates the gate on the welcome each reconnect brings', async () => {
    // The welcome is a snapshot taken as each connection is accepted, so a
    // relay that fell over during an outage is only ever reported by the next
    // connection's greeting — the screen has to listen rather than remember.
    vi.useFakeTimers({ shouldAdvanceTime: true })
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const { sock, sockets } = await mountDevices()
    expect(pairButton().hasAttribute('disabled')).toBe(false)

    act(() => sock.close())
    await act(() => vi.advanceTimersByTimeAsync(2_000))
    const next = sockets[sockets.length - 1]!
    act(() => next.open())
    welcomed(next, { status: 'off' })

    // Shut by the gate, not by the outage: the connection is back up.
    expect(notice()).toBe('')
    expect(pairButton().hasAttribute('disabled')).toBe(true)
    expect(screen.getByText(EXPLAINER)).toBeTruthy()
  })

  it('has the live region on the page before it has anything to say', async () => {
    const { sock } = await mountDevices()
    expect(notice()).toBe('')

    act(() => sock.close())

    expect(notice()).toMatch(/reconnecting/i)
  })

  it('keeps one primary button on the screen', async () => {
    const { sock } = await mountDevices()
    listed(sock, [
      device({ id: 'aa11bb22cc33', label: 'iPhone' }),
      device({ id: 'dd44ee55ff66', label: 'iPad' }),
    ])
    await userEvent.click(pairButton())
    offered(sock)

    const filled = screen
      .getAllByRole('button')
      .filter((b) => b.getAttribute('data-variant') === 'default')

    expect(filled).toHaveLength(1)
    expect(filled[0]!.textContent).toBe('Pair device')
  })
})
