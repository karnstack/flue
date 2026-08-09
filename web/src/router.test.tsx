import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import { RouterProvider } from '@tanstack/react-router'
import { FlueClientProvider } from './client/provider'
import { FleetClient } from './fleet/fleet'
import { FleetProvider } from './fleet/provider'
import { fakeClient } from './testing/socket'
import { createFlueRouter, TERMINAL_ROUTE_ID } from './router'

function routeIds(path: string): string[] {
  return createFlueRouter()
    .matchRoutes(path, {})
    .map((m) => m.routeId)
}

/**
 * Mount the real router at `path`.
 *
 * createFlueRouter deliberately takes no history argument — it is the app's
 * router, not a test fixture — so the location is set on jsdom's own history
 * before the router reads it.
 *
 * The client provider is here because main.tsx puts one above the router and
 * the terminal route needs it. Without it that route throws into TanStack's
 * default error boundary, which renders "Something went wrong!" — and every
 * assertion below about the terminal is an assertion that something is
 * *absent*, so all of them would have gone on passing. That is why the
 * terminal case also asserts something positive.
 */
async function renderAt(path: string) {
  window.history.replaceState(null, '', path)
  const router = createFlueRouter()
  await router.load()
  const { client, sockets } = fakeClient()
  // Async act, not a bare render: mounting RouterProvider re-runs
  // router.load() from Transitioner's mount effect, and its continuations
  // update the router stores a microtask after RTL's synchronous act exits —
  // an act warning per mounted Match on a runner slow enough to print them.
  let view!: ReturnType<typeof render>
  await act(async () => {
    view = render(
      <FlueClientProvider client={client}>
        <RouterProvider router={router} />
      </FlueClientProvider>,
    )
  })
  return { ...view, client, sockets }
}

/**
 * Mount the real router at `path` under a scripted fleet: the local machine
 * beside one paired remote, each riding its own fake socket. The router's own
 * FleetProvider sees the fleet already in context and passes through, which is
 * exactly the seam a test is meant to reach the tree by.
 */
async function renderFleet(path: string) {
  window.history.replaceState(null, '', path)
  const router = createFlueRouter()
  await router.load()
  const local = fakeClient()
  const attic = fakeClient()
  const fleet = new FleetClient([
    { id: 'local', name: '', client: local.client },
    { id: 'attic-pi', name: 'Attic Pi', client: attic.client },
  ])
  // The same async act as renderAt, for the same post-mount load.
  let view!: ReturnType<typeof render>
  await act(async () => {
    view = render(
      <FleetProvider fleet={fleet}>
        <RouterProvider router={router} />
      </FleetProvider>,
    )
  })
  return { ...view, local, attic }
}

/**
 * Mount the real router at `path` as a browser with no machine selected:
 * served by a relay, and either never paired or holding several machines with
 * no selection made. No client provider, because the whole claim is that
 * nothing on these routes asks for one.
 */
async function renderPicker(path: string) {
  window.history.replaceState(null, '', path)
  const router = createFlueRouter({ picker: true })
  await router.load()
  // The same async act as renderAt, for the same post-mount load.
  let view!: ReturnType<typeof render>
  await act(async () => {
    view = render(<RouterProvider router={router} />)
  })
  return view
}

/**
 * Mount the real router with nothing above it, and record every socket the app
 * would have opened.
 *
 * No client provider from the test: the whole question here is which routes
 * mount one for themselves, so supplying one would answer it in advance. The
 * WebSocket constructor is the seam, because that is the only thing a daemon
 * ever sees.
 */
async function renderBare(path: string, picker = false): Promise<string[]> {
  const urls: string[] = []
  class RecordingWebSocket {
    binaryType = ''
    onopen: unknown = null
    onclose: unknown = null
    onmessage: unknown = null
    constructor(url: string) {
      urls.push(url)
    }
    send() {}
    close() {}
  }
  vi.stubGlobal('WebSocket', RecordingWebSocket)

  window.history.replaceState(null, '', path)
  const router = createFlueRouter({ picker })
  await router.load()
  // The same async act as renderAt, for the same post-mount load.
  await act(async () => {
    render(<RouterProvider router={router} />)
  })
  return urls
}

beforeEach(() => {
  // The picker reads its rows out of localStorage, so a record another test
  // file left behind would put a machine on a screen asserting emptiness.
  localStorage.clear()
  sessionStorage.clear()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('the daemon socket', () => {
  it('is not opened on the pairing route', async () => {
    // The device on this route has no session token — getting one is what the
    // page is for — so /ws answers 401, the client backs off and retries, and
    // it does that for as long as the tab is open: a WARN in the daemon's audit
    // log every few seconds, and a phone radio kept awake for a page that only
    // ever makes one fetch. The route needs no socket, so it opens none.
    expect(await renderBare('/pair')).toEqual([])
  })

  it('is opened on a route that has one to use', async () => {
    // The other half, so the assertion above cannot pass by the app having
    // stopped connecting anywhere. Sessions, the terminal and Devices all speak
    // to the daemon over this socket, and they share exactly one.
    expect(await renderBare('/sessions')).toEqual(['ws://localhost:3000/ws'])
  })
})

describe('createFlueRouter', () => {
  it('matches the sessions route', () => {
    const router = createFlueRouter()
    const match = router.matchRoutes('/sessions', {})
    expect(match.some((m) => m.routeId.includes('sessions'))).toBe(true)
  })

  it('matches a session terminal route and extracts its params', () => {
    const router = createFlueRouter()
    const match = router.matchRoutes('/d/local/s/abc123', {})
    const terminal = match.find((m) => m.routeId === TERMINAL_ROUTE_ID)
    expect(terminal).toBeDefined()
    expect(terminal!.params).toMatchObject({ deviceId: 'local', sessionId: 'abc123' })
  })

  it('matches the index route', () => {
    const router = createFlueRouter()
    const match = router.matchRoutes('/', {})
    expect(match.length).toBeGreaterThan(0)
  })

  it('renders management routes inside the app shell', () => {
    for (const path of ['/', '/sessions', '/devices', '/remote', '/settings']) {
      expect(routeIds(path).some((id) => id.includes('shell'))).toBe(true)
    }
  })

  it('renders the terminal outside the app shell', () => {
    // The one layout decision this router exists to encode: a terminal
    // session *is* the tab, so it must not be wrapped in sidebar chrome. That
    // is why the shell is a pathless layout route rather than the whole tree.
    const ids = routeIds('/d/local/s/abc123')
    expect(ids).toContain(TERMINAL_ROUTE_ID)
    expect(ids.some((id) => id.includes('shell'))).toBe(false)
  })

  it('renders the pairing page outside the app shell', () => {
    // The device on this route is not paired yet, so a sidebar of links to
    // sessions it cannot open would be chrome promising what it does not have.
    // It is also the one route the daemon serves without a session token.
    const ids = routeIds('/pair')
    expect(ids).toContain('/pair')
    expect(ids.some((id) => id.includes('shell'))).toBe(false)
  })

  it('gives the pairing page nothing when the token is not one', async () => {
    // A link carrying ?t twice parses to an array, and an array is not a
    // token. The route's validateSearch says so, but a route's search is its
    // parent's merged with its own and the root route has no schema — so what
    // reaches the page is the raw parse, and the page is what has to refuse it.
    // The explainer is the evidence it did: with a token it renders a form.
    await renderAt('/pair?t=first&t=second')
    expect(screen.getByRole('heading', { name: 'Nothing to pair with yet' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Pair' })).toBeNull()
  })

  it('renders the pairing page with no app chrome around it either', async () => {
    // As with the terminal, the route tree proves the shape and this proves
    // the consequence. Without a token the page explains itself and asks the
    // daemon for nothing, so no client provider is needed here — which is the
    // point: the device reading it has no session token to open one with.
    await renderAt('/pair')

    expect(screen.getByRole('heading', { name: 'Nothing to pair with yet' })).toBeTruthy()
    expect(screen.queryByRole('navigation')).toBeNull()
    expect(document.querySelector('[data-slot="sidebar"]')).toBeNull()
    expect(screen.queryAllByRole('link')).toHaveLength(0)
  })

  it('wraps a management route in the app shell when it renders', async () => {
    await renderAt('/sessions')
    // The shell's chrome, by its landmarks: the two navs inside the sidebar,
    // and the content region the sidebar primitives render as <main>. Every
    // nav is asked for by name — Main and Project belong to the shell,
    // Breadcrumb to the route's own header — and by name only: a rotor
    // listing anonymous "navigation" landmarks would leave the reader picking
    // one by luck, so an unlabeled landmark appearing here is a regression,
    // not a baseline.
    expect(screen.getAllByRole('navigation')).toHaveLength(3)
    expect(screen.getByRole('navigation', { name: 'Main' })).toBeTruthy()
    expect(screen.getByRole('navigation', { name: 'Project' })).toBeTruthy()
    expect(screen.getByRole('navigation', { name: 'Breadcrumb' })).toBeTruthy()
    expect(screen.getByRole('main')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Sessions' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Sessions' })).toBeTruthy()
  })

  it('renders the terminal with no app chrome around it at all', async () => {
    // The route-tree assertions above prove the shape; this proves the
    // consequence. A terminal session *is* the tab, so there must be no
    // sidebar, no header and no nav on screen — not merely a different
    // parent route.
    const { container } = await renderAt('/d/local/s/abc123')

    // First that a terminal is on screen at all. Every other assertion here
    // is about absence, and a route that threw would satisfy all of them.
    expect(container.querySelector('[data-flue-surface]')).not.toBeNull()

    expect(screen.queryByRole('navigation')).toBeNull()
    expect(screen.queryByRole('main')).toBeNull()
    expect(document.querySelector('[data-slot="sidebar"]')).toBeNull()
    // The only links are the terminal's own control strip — the way back to
    // the dashboard and the new-session control, both part of the terminal,
    // not chrome around it. Anything beyond these two is chrome creeping
    // back in.
    const links = screen.queryAllByRole('link')
    expect(links).toHaveLength(2)
    const texts = links.map((l) => l.textContent ?? '')
    expect(texts.some((t) => t.includes('dashboard'))).toBe(true)
    expect(texts.some((t) => t.includes('New session'))).toBe(true)
  })

  it('hands the session id from the path to the terminal', async () => {
    // The route reads its param with a hard-coded `from`. TypeScript checks
    // that against the registered tree, but only a render proves the param
    // arrives: a `from` that drifted would hand back an empty params object,
    // not an error, and the terminal would attach to `undefined`.
    const { sockets } = await renderAt('/d/local/s/abc123')

    act(() => sockets[0]!.open())

    expect(sockets[0]!.ofType('attach')).toEqual([
      { type: 'attach', id: 'abc123', lastSeq: 0, reqId: 1 },
    ])
  })

  it('marks Sessions as the current item on the index route', async () => {
    // `/` renders the sessions screen, so leaving nothing selected there
    // would be the one screen where the nav disagrees with the content.
    await renderAt('/')
    expect(screen.getByRole('link', { name: 'Sessions' }).getAttribute('aria-current')).toBe('page')
  })

  it('sends every screen of the app to the machine picker', async () => {
    // Served by a relay to a browser with no machine selected. There is no
    // handshake to be had on any of these screens until one is, so none of
    // them may render the app's own chrome and sit at "reconnecting" for ever.
    for (const path of ['/', '/sessions', '/devices', '/remote', '/settings']) {
      const view = await renderPicker(path)
      expect(screen.getByRole('heading', { name: 'No machines paired yet' })).toBeTruthy()
      expect(screen.queryByRole('navigation')).toBeNull()
      expect(screen.queryByRole('heading', { name: 'Sessions' })).toBeNull()
      view.unmount()
    }
  })

  it('sends the terminal to it as well', async () => {
    // A bookmarked session URL on the relay's origin. Rendering the terminal
    // would mount a client with no key to hand it, which is a socket that can
    // never open — and a black screen while it tries.
    const { container } = await renderPicker('/d/local/s/abc123')
    expect(screen.getByRole('heading', { name: 'No machines paired yet' })).toBeTruthy()
    expect(container.querySelector('[data-flue-surface]')).toBeNull()
  })

  it('still serves the pairing page under the picker, because it is the way out', async () => {
    // The one route that must survive the flag: every word on the empty
    // picker points at a ceremony that finishes here.
    await renderPicker('/pair')
    expect(screen.getByRole('heading', { name: 'Nothing to pair with yet' })).toBeTruthy()
    expect(screen.queryByRole('heading', { name: 'No machines paired yet' })).toBeNull()
  })

  it('opens no socket at all while the picker is up', async () => {
    // The point of the flag. Without it the app would connect on a loop with
    // nothing to authenticate with — a phone radio kept awake for a handshake
    // that cannot complete.
    expect(await renderBare('/sessions', true)).toEqual([])
  })

  it('registers the picker at /machines, outside the shell', async () => {
    // The door has an address of its own, so a connected tab can come back and
    // switch machines — and like every door, no sidebar chrome around it.
    const ids = routeIds('/machines')
    expect(ids).toContain('/machines')
    expect(ids.some((id) => id.includes('shell'))).toBe(false)

    await renderAt('/machines')
    expect(screen.getByRole('heading', { name: 'No machines paired yet' })).toBeTruthy()
    expect(screen.queryByRole('navigation')).toBeNull()
  })

  it('matches every path the nav links to', async () => {
    const { NAV_ITEMS } = await import('./components/nav')
    for (const item of NAV_ITEMS) {
      // A nav link to a path with no route is a dead link that silently
      // renders the not-found tree. matchRoutes always returns the root
      // match, so a real hit is more than one.
      expect(routeIds(item.to).length).toBeGreaterThan(1)
    }
  })

  it('routes a machine-addressed terminal through that machine’s client', async () => {
    // The deviceId segment stops being decoration here: /d/attic-pi/... must
    // attach on the attic's own connection, and ask nothing of the local one.
    const { container, local, attic } = await renderFleet('/d/attic-pi/s/abc123')

    expect(container.querySelector('[data-flue-surface]')).not.toBeNull()

    act(() => attic.sockets[0]!.open())

    expect(attic.sockets[0]!.ofType('attach')).toEqual([
      { type: 'attach', id: 'abc123', lastSeq: 0, reqId: 1 },
    ])
    expect(local.sockets[0]!.ofType('attach')).toEqual([])
  })

  it('mounts the terminal the moment the fleet adopts the machine', async () => {
    // F5 on a remote machine's terminal is the bookmark case: at first render
    // the fleet holds only the local source — remote sources are built only
    // after the local daemon's welcome names the relay — so the route
    // legitimately finds no client yet, and has to recover on its own the
    // moment the slot is adopted. A one-shot resolve would leave the
    // not-paired pill up for good, on a pane with no way out.
    window.history.replaceState(null, '', '/d/attic-pi/s/abc123')
    const router = createFlueRouter()
    await router.load()
    const local = fakeClient()
    const attic = fakeClient()
    const fleet = new FleetClient(
      [{ id: 'local', name: '', client: local.client }],
      () => Promise.resolve([{ id: 'attic-pi', name: 'Attic Pi', client: attic.client }]),
    )
    // The same async act as renderAt, for the same post-mount load. The fleet
    // has not been welcomed yet, so nothing here settles the adoption early.
    let container!: HTMLElement
    await act(async () => {
      container = render(
        <FleetProvider fleet={fleet}>
          <RouterProvider router={router} />
        </FleetProvider>,
      ).container
    })

    // Before the welcome, not paired is all this browser can truthfully say.
    expect(screen.getByRole('status').textContent).toContain('Machine not paired on this browser')
    expect(container.querySelector('[data-flue-surface]')).toBeNull()

    act(() => {
      local.sockets[0]!.open()
      local.sockets[0]!.emitControl({
        type: 'welcome',
        daemonId: 'd1',
        host: 'mesa.local',
        ver: '0.1.0',
        relay: { status: 'connected', origin: 'https://relay.example' },
      })
    })
    // Adoption is a promise away: the fleet awaits its source builder.
    await act(async () => {})

    expect(container.querySelector('[data-flue-surface]')).not.toBeNull()

    act(() => attic.sockets[0]!.open())
    expect(attic.sockets[0]!.ofType('attach')).toEqual([
      { type: 'attach', id: 'abc123', lastSeq: 0, reqId: 1 },
    ])
  })

  it('tells a machine the fleet does not hold apart from a dead session', async () => {
    // A bookmarked session URL for a machine this browser never paired with,
    // or whose pinned key is gone. There is no client to attach with, so the
    // route answers the way the terminal answers a session the daemon has
    // never heard of: a still pill naming the fact.
    const { container } = await renderFleet('/d/ghost/s/abc123')

    expect(screen.getByRole('status').textContent).toContain('Machine not paired on this browser')
    expect(container.querySelector('[data-flue-surface]')).toBeNull()
  })

  it('reaches remote access from the nav', async () => {
    // The loop above is only as strong as the list it reads, so the one item
    // this route exists for is named. Relay setup and status were terminal-only
    // until this screen, and a screen nothing links to is one nobody finds.
    const { NAV_ITEMS } = await import('./components/nav')
    const item = NAV_ITEMS.find((i) => i.to === '/remote')
    expect(item?.label).toBe('Remote access')

    await renderAt('/remote')

    expect(screen.getByRole('link', { name: 'Remote access' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Remote access' })).toBeTruthy()
  })
})
