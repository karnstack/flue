import { StrictMode } from 'react'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'

import type { SessionInfo } from '@/client/protocol'
import { SidebarProvider } from '@/components/ui/sidebar'
import { savePinnedDaemonKeyFor } from '@/crypto/keys'
import { FleetClient } from '@/fleet/fleet'
import { FleetProvider } from '@/fleet/provider'
import { saveMachine } from '@/relay/machines'
import { attached, fakeClient, type FakeSocket } from '@/testing/socket'
import { SessionsRoute } from './sessions'

function info(over: Partial<SessionInfo> & { id: string }): SessionInfo {
  return {
    title: 'zsh',
    name: '',
    tags: [],
    pinned: false,
    cwd: '/Users/karn/code/flue',
    cmd: ['zsh', '-l'],
    state: 'running',
    exitCode: 0,
    cols: 80,
    rows: 24,
    createdAt: '2026-07-28T09:00:00Z',
    lastActive: '2026-07-28T10:00:00Z',
    ...over,
  }
}

/**
 * Mount the screen under a router that really routes, over a scripted fleet.
 *
 * The fleet is the seam the provider was built with: two machines — the ridden
 * one and a paired remote — each on its own fake socket, injected whole via
 * `FleetProvider fleet=`, so the real FleetClient does the merging and the
 * routing while no socket ever opens. The local machine is born nameless, as
 * in production, and takes its name from the welcome a test emits when a
 * heading matters.
 *
 * Deliberately not `testing/render.tsx`'s helper, for the reason the previous
 * suite spelled out: the screen must be the component of `/` and `/sessions`
 * only, so navigating anywhere else tears it down exactly as the real router
 * does. The SidebarProvider is here because the route reads the sidebar's
 * expansion to place the bulk bar, and in the app that provider is the shell's.
 *
 * The socket is opened *after* the first render on purpose: a screen reached
 * by navigating mounts into a connection that is already established, but the
 * very first paint of the tab does not, and both have to work.
 */
async function mountSessions({ open = true, strict = false, solo = false } = {}) {
  const local = fakeClient()
  const attic = fakeClient()
  // `solo` is a browser paired with one machine, which is what a fresh
  // install is and what the machine-chip rule turns on. It is a whole fleet
  // rather than a flag because the rule reads the fleet, and a screen told
  // "one machine" by anything else would not be testing the rule.
  const fleet = new FleetClient(
    solo
      ? [{ id: 'local', name: '', client: local.client, pinned: false }]
      : [
          { id: 'local', name: '', client: local.client, pinned: false },
          { id: 'attic-pi', name: 'Attic Pi', client: attic.client, pinned: false },
        ],
  )

  const routeComponent = strict
    ? () => (
        <StrictMode>
          <SessionsRoute />
        </StrictMode>
      )
    : SessionsRoute

  const rootRoute = createRootRoute({ component: () => <Outlet /> })
  const routeTree = rootRoute.addChildren([
    ...['/', '/sessions'].map((path) =>
      createRoute({ getParentRoute: () => rootRoute, path, component: routeComponent }),
    ),
    ...['/devices', '/settings', '/new', '/d/$deviceId/s/$sessionId'].map((path) =>
      createRoute({ getParentRoute: () => rootRoute, path, component: () => null }),
    ),
  ])
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: ['/sessions'] }),
  })
  // The first match resolves asynchronously, so a bare render commits an empty
  // tree and every query misses.
  await router.load()

  // Async act, because mounting RouterProvider re-runs router.load() from
  // Transitioner's mount effect, and its continuations update the router
  // stores a microtask after RTL's synchronous act exits — an act warning per
  // mounted Match on a runner slow enough to print them. No socket is open
  // yet, so nothing else can settle early in here.
  let view!: ReturnType<typeof render>
  await act(async () => {
    view = render(
      <SidebarProvider>
        <FleetProvider fleet={fleet}>
          <RouterProvider router={router as never} />
        </FleetProvider>
      </SidebarProvider>,
    )
  })
  const sock = local.sockets[0]!
  if (open) act(() => sock.open())

  /** Navigate, and settle, so the screen has really gone by the next line. */
  const goTo = (to: string) => act(async () => void (await router.navigate({ to })))

  /** The local daemon's greeting, which is what names the ridden machine. */
  const welcomeLocal = () =>
    act(() =>
      sock.emitControl({ type: 'welcome', daemonId: 'd1', host: 'mesa.local', ver: '0.1.0' }),
    )

  return { ...view, router, goTo, fleet, local, attic, sock, welcomeLocal }
}

/** Whether the screen under test is still on show. */
const onScreen = () => screen.queryByRole('heading', { name: 'Sessions' }) !== null

function listed(sock: FakeSocket, sessions: SessionInfo[]) {
  act(() => sock.emitControl({ type: 'sessions', sessions }))
}

const newSession = () => screen.getByRole('button', { name: 'New session' })

/**
 * The route's own status line. By role alone it stopped being unique: the
 * drag layer (dnd-kit's DndContext) portals a live region onto document.body
 * that is also role=status. The route's is the one and only `p` — the drag
 * layer's is a div — and pinning the tag keeps every assertion about notices
 * reading the element the reader actually sees.
 */
function notice(): HTMLElement {
  const line = screen.getAllByRole('status').find((el) => el.tagName === 'P')
  if (line === undefined) throw new Error('the notice line is not on screen')
  return line
}

/** Open one of the display-options selects and take the option reading `label`. */
async function pick(user: ReturnType<typeof userEvent.setup>, of: string, label: string) {
  const trigger = screen.getByRole('combobox', { name: of })
  trigger.focus()
  await user.keyboard('{Enter}')
  await user.click(await screen.findByRole('option', { name: label }))
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  localStorage.clear()
})

describe('SessionsRoute', () => {
  it('asks each machine for its sessions the moment it comes up', async () => {
    const { sock, attic } = await mountSessions({ open: false })
    expect(sock.ofType('list')).toEqual([])

    act(() => sock.open())
    expect(sock.ofType('list')).toHaveLength(1)

    act(() => attic.sockets[0]!.open())
    expect(attic.sockets[0]!.ofType('list')).toHaveLength(1)
  })

  it('renders rows from two machines under their machine headings', async () => {
    const { sock, attic, welcomeLocal } = await mountSessions()
    welcomeLocal()
    act(() => attic.sockets[0]!.open())

    listed(sock, [info({ id: 's1', cwd: '/one' })])
    listed(attic.sockets[0]!, [info({ id: 's2', cwd: '/two' })])

    // The group toggles carry the machine names; the rows ride under them.
    expect(screen.getByRole('button', { name: 'mesa.local' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Attic Pi' })).toBeTruthy()
    expect(screen.getByText('/one')).toBeTruthy()
    expect(screen.getByText('/two')).toBeTruthy()
  })

  it('drops the machine chip when this browser reaches only one machine', async () => {
    // The same word down every row, and on a phone it costs the name the
    // width it needs. The preference is untouched; only the rendering is.
    const solo = await mountSessions({ solo: true })
    solo.welcomeLocal()
    listed(solo.sock, [info({ id: 's1' })])

    expect(screen.queryByText('mesa.local', { selector: '[data-slot="badge"]' })).toBeNull()
    // The row is still there and still named — only the chip went.
    expect(screen.getByRole('link', { name: 'Open zsh in a new tab' })).toBeTruthy()
    solo.unmount()

    // Two machines, and it is back: it now tells two rows apart.
    const pair = await mountSessions()
    pair.welcomeLocal()
    act(() => pair.attic.sockets[0]!.open())
    listed(pair.sock, [info({ id: 's1' })])
    listed(pair.attic.sockets[0]!, [info({ id: 's2' })])

    expect(screen.getByText('Attic Pi', { selector: '[data-slot="badge"]' })).toBeTruthy()
  })

  it('keeps the chip while a second machine is merely unreachable', async () => {
    // Read off the fleet this browser holds, not off the machines answering
    // right now: a column that vanished when a laptop slept and came back
    // when it woke would be worse than one that is briefly redundant.
    const { sock, fleet, welcomeLocal } = await mountSessions()
    welcomeLocal()
    act(() => fleet.clientFor('attic-pi')!.close())
    listed(sock, [info({ id: 's1' })])

    expect(screen.getByText('mesa.local', { selector: '[data-slot="badge"]' })).toBeTruthy()
  })

  it('does not claim there are no sessions before the machines have answered', async () => {
    // "No sessions yet" is a claim about the fleet. Before the first list has
    // come back it is invented — and every cold load passes through that state.
    const { sock, attic } = await mountSessions()
    act(() => attic.sockets[0]!.open())
    expect(screen.queryByText(/No sessions yet/i)).toBeNull()

    listed(sock, [])
    listed(attic.sockets[0]!, [])

    expect(screen.getByText(/No sessions yet/i)).toBeTruthy()
  })

  it('folds a heading shut and open again', async () => {
    const { sock, welcomeLocal } = await mountSessions()
    welcomeLocal()
    listed(sock, [info({ id: 's1', cwd: '/one' })])

    await userEvent.click(screen.getByRole('button', { name: 'mesa.local' }))
    expect(screen.queryByText('/one')).toBeNull()

    await userEvent.click(screen.getByRole('button', { name: 'mesa.local' }))
    expect(screen.getByText('/one')).toBeTruthy()
  })

  it('narrows the rows as the search settles', async () => {
    const { sock } = await mountSessions()
    listed(sock, [
      info({ id: 's1', cwd: '/apps/web' }),
      info({ id: 's2', cwd: '/apps/api' }),
    ])

    await userEvent.type(screen.getByRole('searchbox', { name: 'Search sessions' }), 'web')

    await waitFor(() => expect(screen.queryByText('/apps/api')).toBeNull())
    expect(screen.getByText('/apps/web')).toBeTruthy()
  })

  it('regroups when the grouping changes', async () => {
    const user = userEvent.setup()
    const { sock } = await mountSessions()
    listed(sock, [info({ id: 's1' }), info({ id: 's2', state: 'exited' })])

    // The ended session has to be on show before State can have two headings:
    // the default folds it away.
    await user.click(screen.getByRole('button', { name: 'Show exited sessions' }))
    await user.click(screen.getByRole('button', { name: 'Display options' }))
    await pick(user, 'Grouping', 'State')

    expect(screen.getByRole('button', { name: 'Running' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Exited' })).toBeTruthy()
  })

  describe('the ended fold', () => {
    it('folds ended sessions away by default and says how many', async () => {
      const { sock } = await mountSessions()
      listed(sock, [
        info({ id: 's1', cwd: '/live' }),
        info({ id: 's2', cwd: '/dead', state: 'exited' }),
        info({ id: 's3', cwd: '/dead-too', state: 'exited' }),
      ])

      expect(screen.getByText('/live')).toBeTruthy()
      expect(screen.queryByText('/dead')).toBeNull()
      expect(screen.getByText('exited sessions')).toBeTruthy()
      expect(screen.getByText('2')).toBeTruthy()

      await userEvent.click(screen.getByRole('button', { name: 'Show exited sessions' }))

      expect(screen.getByText('/dead')).toBeTruthy()
      expect(screen.getByText('/dead-too')).toBeTruthy()
      // An open fold hides nothing, so the count would be a claim about
      // nothing; the display options own the way back.
      expect(screen.queryByRole('button', { name: 'Show exited sessions' })).toBeNull()
    })

    it('does not claim an empty fleet when everything on it has ended', async () => {
      // "No sessions yet" is a claim about the fleet, and a fleet whose every
      // session has ended is not one that has none — the fold line stands in
      // for the rows it hides.
      const { sock, welcomeLocal, attic } = await mountSessions()
      welcomeLocal()
      act(() => attic.sockets[0]!.open())
      listed(sock, [info({ id: 's1', cwd: '/dead', state: 'exited' })])
      listed(attic.sockets[0]!, [])

      expect(screen.queryByText(/No sessions yet/i)).toBeNull()
      expect(screen.getByText('exited session')).toBeTruthy()

      await userEvent.click(screen.getByRole('button', { name: 'Show exited sessions' }))

      expect(screen.getByText('/dead')).toBeTruthy()
    })
  })

  it('opens a session on the machine that owns it, from the row itself', async () => {
    const { sock, attic, router } = await mountSessions()
    act(() => attic.sockets[0]!.open())
    listed(attic.sockets[0]!, [info({ id: 'abc123', name: 'remote-one' })])
    listed(sock, [])

    // The row is a link, not a button: its href carries the machine that owns
    // the session, and it opens in a tab of its own so this list — the thing
    // people come back to between sessions — stays where it was.
    const row = screen.getByRole('link', { name: 'Open remote-one in a new tab' })
    expect(row.getAttribute('href')).toBe('/d/attic-pi/s/abc123')
    expect(row.getAttribute('target')).toBe('_blank')

    // And the router stands aside for it, which is what makes that a real new
    // tab rather than a navigation wearing the attribute.
    await userEvent.click(row)
    expect(router.state.location.pathname).toBe('/sessions')
  })

  describe('metadata actions', () => {
    it('round-trips a rename through fleet.update, clears surviving', async () => {
      const user = userEvent.setup()
      const { sock } = await mountSessions()
      listed(sock, [info({ id: 's1', name: 'old-name' })])

      await user.click(screen.getByRole('button', { name: 'Actions for old-name' }))
      await user.click(screen.getByRole('menuitem', { name: 'Rename' }))
      await user.clear(screen.getByRole('textbox', { name: 'Name' }))
      await user.click(screen.getByRole('button', { name: 'Save' }))

      // The clear travels as an explicit empty string: a truthiness copy on
      // the way to the wire would have dropped the one field this edit is.
      expect(sock.ofType('update')).toEqual([{ type: 'update', id: 's1', name: '' }])
    })

    it('round-trips a tag edit, and a clear of the last tag', async () => {
      const user = userEvent.setup()
      const { sock } = await mountSessions()
      listed(sock, [info({ id: 's1', name: 'alpha', tags: ['api'] })])

      await user.click(screen.getByRole('button', { name: 'Actions for alpha' }))
      await user.click(screen.getByRole('menuitem', { name: 'Edit tags' }))
      await user.click(screen.getByRole('button', { name: 'Remove api' }))
      await user.click(screen.getByRole('button', { name: 'Save' }))

      expect(sock.ofType('update')).toEqual([{ type: 'update', id: 's1', tags: [] }])
    })

    it('pins and unpins from the row menu', async () => {
      const user = userEvent.setup()
      const { sock } = await mountSessions()
      listed(sock, [
        info({ id: 's1', name: 'alpha' }),
        info({ id: 's2', name: 'beta', pinned: true }),
      ])

      await user.click(screen.getByRole('button', { name: 'Actions for alpha' }))
      await user.click(screen.getByRole('menuitem', { name: 'Pin' }))
      await user.click(screen.getByRole('button', { name: 'Actions for beta' }))
      await user.click(screen.getByRole('menuitem', { name: 'Unpin' }))

      expect(sock.ofType('update')).toEqual([
        { type: 'update', id: 's1', pinned: true },
        { type: 'update', id: 's2', pinned: false },
      ])
    })

    it('closes a row by id, with no confirm, and says so', async () => {
      // The ⋯ close is direct, as the exit overlay's is: one session the
      // reader just named, not a bulk sweep. The confirm lives on the bulk
      // bar, where the blast radius earns it.
      const user = userEvent.setup()
      const { sock } = await mountSessions()
      listed(sock, [info({ id: 's1', name: 'alpha' })])

      await user.click(screen.getByRole('button', { name: 'Actions for alpha' }))
      await user.click(screen.getByRole('menuitem', { name: 'Close' }))

      expect(sock.ofType('close')).toEqual([{ type: 'close', id: 's1' }])
      expect(notice().textContent).toContain('Closing alpha')
    })

    it('announces a refusal that answers an act nobody can correlate', async () => {
      // An update and a close-by-id carry no reqId, because success has no
      // reply to correlate to — so their one failure mode comes back as a
      // bare not_found. Nothing but this screen is left to say it: dropped,
      // the row sits there unchanged and the reader is told nothing at all.
      const user = userEvent.setup()
      const { sock } = await mountSessions()
      listed(sock, [info({ id: 's1', name: 'alpha' })])

      await user.click(screen.getByRole('button', { name: 'Actions for alpha' }))
      await user.click(screen.getByRole('menuitem', { name: 'Close' }))
      act(() => sock.emitControl({ type: 'error', code: 'not_found', msg: 'no such session' }))

      expect(notice().textContent).toBe('That session is gone.')
    })

    it('announces one from a remote machine too, not only the ridden one', async () => {
      const { attic } = await mountSessions()
      act(() => attic.sockets[0]!.open())

      act(() =>
        attic.sockets[0]!.emitControl({ type: 'error', code: 'not_found', msg: 'no such session' }),
      )

      expect(notice().textContent).toBe('That session is gone.')
    })

    it('leaves a correlated refusal to whoever holds its request', async () => {
      // A reqId means somebody asked and is waiting: a spawn settles in the
      // route's own per-spawn listener, an attach inside the client. Saying
      // it here as well would double-announce the ones that are handled and
      // invent a sentence for the ones that are not.
      const { sock } = await mountSessions()

      act(() =>
        sock.emitControl({ type: 'error', code: 'not_found', msg: 'no such session', reqId: 9 }),
      )

      expect(notice().textContent).toBe('')
    })

    it('says nothing about an error that is not a missing session', async () => {
      const { sock } = await mountSessions()

      act(() => sock.emitControl({ type: 'error', code: 'lagged', msg: 'too far behind' }))

      expect(notice().textContent).toBe('')
    })
  })

  describe('selection and the bulk bar', () => {
    async function selectTwo() {
      const mounted = await mountSessions()
      const { sock, attic } = mounted
      act(() => attic.sockets[0]!.open())
      listed(sock, [info({ id: 's1', name: 'alpha', tags: ['api', 'prod'] })])
      listed(attic.sockets[0]!, [info({ id: 's2', name: 'beta', tags: ['api'] })])

      await userEvent.click(screen.getByRole('checkbox', { name: 'Select alpha' }))
      await userEvent.click(screen.getByRole('checkbox', { name: 'Select beta' }))
      expect(screen.getByText('2 selected')).toBeTruthy()
      return mounted
    }

    it('closes the selection after a confirm, one close per machine', async () => {
      const { sock, attic } = await selectTwo()

      const bar = within(screen.getByRole('toolbar', { name: 'Bulk actions' }))
      await userEvent.click(bar.getByRole('button', { name: 'Close' }))
      await userEvent.click(screen.getByRole('button', { name: 'Close sessions' }))

      expect(sock.ofType('close')).toEqual([{ type: 'close', id: 's1' }])
      expect(attic.sockets[0]!.ofType('close')).toEqual([{ type: 'close', id: 's2' }])
      // The act consumes the selection: the bar leaves with it.
      expect(screen.queryByRole('toolbar', { name: 'Bulk actions' })).toBeNull()
      expect(notice().textContent).toContain('Closing 2 sessions')
    })

    it('pins the whole selection', async () => {
      const { sock, attic } = await selectTwo()

      await userEvent.click(screen.getByRole('button', { name: 'Pin' }))

      expect(sock.ofType('update')).toEqual([{ type: 'update', id: 's1', pinned: true }])
      expect(attic.sockets[0]!.ofType('update')).toEqual([
        { type: 'update', id: 's2', pinned: true },
      ])
      expect(screen.queryByRole('toolbar', { name: 'Bulk actions' })).toBeNull()
    })

    it('tags the selection from the shared tags, replacing each list whole', async () => {
      const user = userEvent.setup()
      const { sock, attic } = await selectTwo()

      await user.click(screen.getByRole('button', { name: 'Tag' }))

      // Seeded with the intersection: api is on both rows, prod on one only.
      expect(screen.getByRole('button', { name: 'Remove api' })).toBeTruthy()
      expect(screen.queryByRole('button', { name: 'Remove prod' })).toBeNull()

      await user.type(screen.getByRole('textbox', { name: 'Add tag' }), 'ops{Enter}')
      await user.click(screen.getByRole('button', { name: 'Save' }))

      // Replace semantics, honestly: each selected session's tags become the
      // edited list — beta gains ops, alpha loses the prod the editor never
      // showed. That is what editing a shared set means.
      expect(sock.ofType('update')).toEqual([{ type: 'update', id: 's1', tags: ['api', 'ops'] }])
      expect(attic.sockets[0]!.ofType('update')).toEqual([
        { type: 'update', id: 's2', tags: ['api', 'ops'] },
      ])
      expect(screen.queryByRole('toolbar', { name: 'Bulk actions' })).toBeNull()
    })

    it('prunes the selection when a selected session disappears', async () => {
      const { sock, attic } = await selectTwo()

      listed(attic.sockets[0]!, [])
      expect(screen.getByText('1 selected')).toBeTruthy()

      listed(sock, [])
      expect(screen.queryByRole('toolbar', { name: 'Bulk actions' })).toBeNull()
    })
  })

  describe('machine health', () => {
    it('shows an unreachable machine as a band with a retry', async () => {
      const { fleet, attic, welcomeLocal, sock } = await mountSessions()
      welcomeLocal()
      listed(sock, [info({ id: 's1' })])

      // A machine whose reconnection has stopped is the honest way to hold
      // the unreachable state still, with no timer to advance: Retry redials
      // a closed client and a backing-off one alike (client.test.ts pins the
      // mid-backoff half, where the wait is stood down rather than waited out).
      act(() => fleet.clientFor('attic-pi')!.close())

      expect(screen.getByText(/is unreachable/)).toBeTruthy()
      expect(screen.getByText('Attic Pi')).toBeTruthy()

      await userEvent.click(screen.getByRole('button', { name: 'Retry Attic Pi' }))
      expect(attic.sockets).toHaveLength(2)

      act(() => attic.sockets[1]!.open())
      expect(screen.queryByText(/is unreachable/)).toBeNull()
    })

    it('keeps the band when the grouping is not by machine', async () => {
      const user = userEvent.setup()
      const { fleet, sock } = await mountSessions()
      listed(sock, [info({ id: 's1' })])
      act(() => fleet.clientFor('attic-pi')!.close())

      await user.click(screen.getByRole('button', { name: 'Display options' }))
      await pick(user, 'Grouping', 'State')

      expect(screen.getByText(/is unreachable/)).toBeTruthy()
    })

    it('says the fleet is out of reach instead of quietly listing one machine', async () => {
      // A browser that pinned no fleet key reaches the machine it paired with
      // and no other. The fleet builder skipped the rest in silence, so the
      // reader saw a short list and nothing anywhere to say it was short, on a
      // screen whose whole subject is "what is running everywhere".
      //
      // This tab has performed no ceremony at all — a loopback tab, where the
      // pairing link the daemon draws points at the relay's address rather
      // than this one, so the ceremony the band used to name could never have
      // admitted *this* browser. What such a tab has instead is enrolment on
      // every load (fleet/enrol.ts), and reaching this band despite it means
      // the machine itself holds no fleet key — which is what the band now
      // says, because it is the only thing anybody can act on.
      vi.stubGlobal('indexedDB', new IDBFactory())
      localStorage.clear()
      const { sock } = await mountSessions()
      listed(sock, [info({ id: 's1' })])

      // The relay origin is what a loopback tab learns from its daemon, and
      // what sends the fleet off to build its remote sources.
      act(() =>
        sock.emitControl({
          type: 'welcome',
          daemonId: 'd1',
          host: 'mesa.local',
          ver: '0.1.0',
          relay: { status: 'connected', origin: 'https://relay.example' },
        }),
      )

      await waitFor(() => expect(screen.getByText(/holds\s+no key for the fleet/)).toBeTruthy())
      expect(screen.getByText(/then reload/)).toBeTruthy()
    })

    it('does not tell a browser to pair again when a machine is about to hand it a key', async () => {
      // The same missing fleet key, one ceremony to its name. Telling this
      // reader to pair again is telling them to redo something that is already
      // repairing itself: the machine they paired with hands the key over on
      // its next welcome (fleet.ts, adoptFleetKey). So the band states the one
      // thing still worth stating — that nothing has answered with one yet.
      vi.stubGlobal('indexedDB', new IDBFactory())
      localStorage.clear()
      saveMachine({ id: 'loft-9f9f', name: 'Loft', pairedAt: 1_700_000_000_000 })
      await savePinnedDaemonKeyFor('loft-9f9f', new Uint8Array(32).fill(7))

      const { sock } = await mountSessions()
      listed(sock, [info({ id: 's1' })])
      act(() =>
        sock.emitControl({
          type: 'welcome',
          daemonId: 'd1',
          host: 'mesa.local',
          ver: '0.1.0',
          relay: { status: 'connected', origin: 'https://relay.example' },
        }),
      )

      await waitFor(() => expect(screen.getByText(/as soon as that machine answers/)).toBeTruthy())
      expect(screen.queryByText(/pair there/)).toBeNull()
    })

    it('says nothing at all about a fleet on a machine with no relay', async () => {
      // The state a fresh install is in, and the first screen anybody sees:
      // one machine, no relay.json, no fleet. Every sentence the band has is
      // false here — there are no others to be missing, and nothing to pair
      // against — so the honest band is no band. Setting up remote access is
      // the Remote screen's offer to make, not this one's.
      vi.stubGlobal('indexedDB', new IDBFactory())
      localStorage.clear()
      const { sock } = await mountSessions({ solo: true })
      listed(sock, [info({ id: 's1' })])

      act(() =>
        sock.emitControl({ type: 'welcome', daemonId: 'd1', host: 'mesa.local', ver: '0.1.0' }),
      )
      // Long enough for an expansion to have run and reported, had this tab had
      // anything to expand into.
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0))
      })

      expect(screen.queryByText(/no key for the fleet/)).toBeNull()
      expect(screen.queryByText(/this fleet/)).toBeNull()
      // And the machine itself is on screen, working, which is the whole of
      // what that state is.
      expect(screen.getByRole('link', { name: 'Open zsh in a new tab' })).toBeTruthy()
    })

    it('takes the band down when its machine leaves the relay', async () => {
      // The way the wrong advice actually reached a reader: the band is right
      // while the machine is on a relay, and the machine then leaves — `flue
      // relay leave`, or a relay.json deleted by hand — and the daemon comes
      // back naming no relay. The snapshot the band spoke from used to outlive
      // the fleet it described, so a tab left open kept telling its reader to
      // go and repair a fleet that no longer existed.
      vi.stubGlobal('indexedDB', new IDBFactory())
      localStorage.clear()
      const { sock } = await mountSessions()
      listed(sock, [info({ id: 's1' })])
      act(() =>
        sock.emitControl({
          type: 'welcome',
          daemonId: 'd1',
          host: 'mesa.local',
          ver: '0.1.0',
          relay: { status: 'connected', origin: 'https://relay.example' },
        }),
      )
      await waitFor(() => expect(screen.getByText(/holds\s+no key for the fleet/)).toBeTruthy())

      act(() =>
        sock.emitControl({ type: 'welcome', daemonId: 'd1', host: 'mesa.local', ver: '0.1.0' }),
      )

      await waitFor(() => expect(screen.queryByText(/no key for the fleet/)).toBeNull())
    })

    it('reports a lost local daemon rather than showing an empty screen', async () => {
      const { sock } = await mountSessions()
      listed(sock, [info({ id: 's1' })])

      act(() => sock.close())

      expect(notice().textContent).toMatch(/reconnecting/i)
    })

    it('shows a revoked machine as a final band, with no retry to press', async () => {
      // The daemon says why before it hangs up, and the fleet answers by
      // closing that machine's client — the consumer FlueClient.onRevoked's
      // doc names. Without that, this tab would redial a daemon whose
      // registry no longer holds its key every ten seconds forever, behind
      // the unreachable band's promise of a reconnect.
      const { fleet, attic, sock } = await mountSessions()
      listed(sock, [info({ id: 's1' })])
      act(() => attic.sockets[0]!.open())

      act(() =>
        attic.sockets[0]!.emitControl({ type: 'revoked', reason: 'revoked from Blue Mesa' }),
      )
      act(() => attic.sockets[0]!.close())

      // The band: which machine, the daemon's own words, and the way back.
      expect(screen.getByText('Attic Pi')).toBeTruthy()
      expect(screen.getByText(/revoked this device/)).toBeTruthy()
      expect(screen.getByText(/revoked from Blue Mesa/)).toBeTruthy()
      expect(screen.getByText(/Pair this device again/)).toBeTruthy()

      // Not the unreachable treatment: no reconnect claim, and no Retry —
      // every dial one offered could only fail the handshake.
      expect(screen.queryByText(/is unreachable/)).toBeNull()
      expect(screen.queryByRole('button', { name: 'Retry Attic Pi' })).toBeNull()

      // And the retries really stopped: the client is closed for good, so the
      // socket the revocation ended is the last one this tab ever dialled.
      expect(fleet.clientFor('attic-pi')!.status).toBe('closed')
      expect(attic.sockets).toHaveLength(1)
    })

    it('reports a revoked local daemon instead of promising a reconnect', async () => {
      const { sock, welcomeLocal } = await mountSessions()
      welcomeLocal()
      listed(sock, [info({ id: 's1' })])

      act(() => sock.emitControl({ type: 'revoked', reason: 'revoked by another device' }))
      act(() => sock.close())

      // The live region announces the fact; the reconnect line would be a
      // promise nothing is keeping.
      expect(notice().textContent).toMatch(/access was revoked/i)
      expect(notice().textContent).not.toMatch(/reconnecting/i)
      // And the band names the ridden machine as its welcome named it.
      expect(screen.getByText('mesa.local')).toBeTruthy()
      expect(screen.getByText(/revoked by another device/)).toBeTruthy()
    })

    it('has the live region on the page before it has anything to say', async () => {
      // Several screen readers announce only changes to a live region that was
      // already in the accessibility tree, so one that arrives together with
      // its first message is a message nobody hears.
      const { sock } = await mountSessions()
      expect(notice().textContent).toBe('')

      act(() => sock.close())

      expect(notice().textContent).toMatch(/reconnecting/i)
    })
  })

  describe('starting sessions', () => {
    /**
     * Watch the tab this screen opens.
     *
     * Nothing on this screen spawns any more: a press opens the new-session
     * dialog, and submitting it opens `/new` in a tab of its own, which is
     * where the spawn happens. See sessions/new-session.ts for why that has to
     * be a page rather than a reply this screen waits on.
     */
    function watchOpen() {
      const open = vi.fn().mockReturnValue({})
      vi.stubGlobal('open', open)
      return {
        opened: () => (open.mock.calls[0]?.[0] as string | undefined) ?? null,
        target: () => open.mock.calls[0]?.[1] as string | undefined,
        count: () => open.mock.calls.length,
      }
    }

    /** Fill nothing in and press Start. */
    const start = () => userEvent.click(screen.getByRole('button', { name: 'Start session' }))

    it('opens the dialog on the ridden machine, and starts nothing by itself', async () => {
      const tabs = watchOpen()
      const { sock } = await mountSessions()

      await userEvent.click(newSession())

      // A form, not a shell: the press has asked a question, and the daemon
      // has not been told anything yet.
      expect(screen.getByRole('dialog')).toBeTruthy()
      expect(sock.ofType('spawn')).toEqual([])
      expect(tabs.count()).toBe(0)

      await start()

      expect(sock.ofType('spawn')).toEqual([])
      expect(tabs.opened()).toBe('/new?d=local')
      expect(tabs.target()).toBe('_blank')
    })

    it('falls back to the first online machine when the ridden one is down', async () => {
      const tabs = watchOpen()
      const { attic } = await mountSessions({ open: false })
      act(() => attic.sockets[0]!.open())

      await userEvent.click(newSession())
      await start()

      expect(tabs.opened()).toBe('/new?d=attic-pi')
    })

    it('opens on the machine picked from the chevron menu', async () => {
      const tabs = watchOpen()
      const user = userEvent.setup()
      const { attic } = await mountSessions()
      act(() => attic.sockets[0]!.open())

      await user.click(
        screen.getByRole('button', { name: 'Choose a machine for the new session' }),
      )
      await user.click(screen.getByRole('menuitem', { name: 'Attic Pi' }))
      await start()

      expect(tabs.opened()).toBe('/new?d=attic-pi')
    })

    it('carries a name and tags the reader typed', async () => {
      // The whole reason the dialog is in front of the press: `spawn` carries
      // no metadata, so a name and a tag can only be applied after the session
      // exists — and nobody goes back to a list to do that. Asked here, they
      // ride the address to the page that starts it.
      const tabs = watchOpen()
      const user = userEvent.setup()
      await mountSessions()

      await user.click(newSession())
      await user.type(screen.getByLabelText('Name'), 'deploy')
      await user.type(screen.getByLabelText('Tags'), 'ops{Enter}')
      await start()

      const url = new URL(tabs.opened()!, 'http://localhost')
      expect(url.pathname).toBe('/new')
      expect(url.searchParams.get('name')).toBe('deploy')
      // An array, JSON-shaped, because that is what the router's own search
      // serialiser writes and what the page parses back — so a tag with a
      // comma in it survives the trip.
      expect(JSON.parse(url.searchParams.get('tags')!)).toEqual(['ops'])
    })

    it('counts a tag typed but never entered as part of the answer', async () => {
      // Somebody who typed a tag and reached straight for Start is done.
      // Throwing that keystroke away would be disagreeing with them in
      // silence — the chips are gone before anyone can read what was sent.
      const tabs = watchOpen()
      const user = userEvent.setup()
      await mountSessions()

      await user.click(newSession())
      await user.type(screen.getByLabelText('Tags'), 'staging')
      await start()

      const url = new URL(tabs.opened()!, 'http://localhost')
      expect(JSON.parse(url.searchParams.get('tags')!)).toEqual(['staging'])
    })

    it('prefills the dialog from a machine heading', async () => {
      const tabs = watchOpen()
      const { attic, sock, welcomeLocal } = await mountSessions()
      welcomeLocal()
      act(() => attic.sockets[0]!.open())
      listed(sock, [])
      listed(attic.sockets[0]!, [info({ id: 's2' })])

      await userEvent.click(screen.getByRole('button', { name: 'New session on Attic Pi' }))
      await start()

      expect(tabs.opened()).toBe('/new?d=attic-pi')
    })

    it("prefills the dialog with a tag heading's own tag", async () => {
      // The heading names a property its rows share, so the `+` on it makes
      // one of *these* — which for a tag means a session that will land under
      // the same heading rather than under "No tag" beside it. It is a prefill
      // and not a decision: the chip is there to be taken off again.
      const tabs = watchOpen()
      const user = userEvent.setup()
      const { sock, welcomeLocal } = await mountSessions()
      welcomeLocal()
      listed(sock, [info({ id: 's1', tags: ['api'] })])
      await user.click(screen.getByRole('button', { name: 'Display options' }))
      await pick(user, 'Grouping', 'Tag')
      await user.keyboard('{Escape}')

      await user.click(screen.getByRole('button', { name: 'New session tagged api' }))

      expect(screen.getByRole('button', { name: 'Remove api' })).toBeTruthy()

      await start()

      const url = new URL(tabs.opened()!, 'http://localhost')
      expect(JSON.parse(url.searchParams.get('tags')!)).toEqual(['api'])
    })

    it("prefills the dialog with a directory heading's own directory", async () => {
      const tabs = watchOpen()
      const user = userEvent.setup()
      const { sock, welcomeLocal } = await mountSessions()
      welcomeLocal()
      listed(sock, [info({ id: 's1', cwd: '/Users/karn/code/flue' })])
      await user.click(screen.getByRole('button', { name: 'Display options' }))
      await pick(user, 'Grouping', 'Directory')
      await user.keyboard('{Escape}')

      await user.click(
        screen.getByRole('button', { name: 'New session in /Users/karn/code/flue' }),
      )

      expect(screen.getByLabelText('Directory')).toHaveProperty('value', '/Users/karn/code/flue')

      await start()

      const url = new URL(tabs.opened()!, 'http://localhost')
      expect(url.searchParams.get('cwd')).toBe('/Users/karn/code/flue')
    })

    it('forgets an abandoned draft rather than carrying it to the next press', async () => {
      // One dialog serves every way of asking. A name half-typed under one
      // heading and then cancelled must not turn up under the next — the worst
      // kind of bug, the kind that saves.
      const user = userEvent.setup()
      await mountSessions()

      await user.click(newSession())
      await user.type(screen.getByLabelText('Name'), 'abandoned')
      await user.click(screen.getByRole('button', { name: 'Cancel' }))

      await user.click(newSession())

      expect(screen.getByLabelText('Name')).toHaveProperty('value', '')
    })

    it('offers no spawn control on the Exited heading', async () => {
      // The one heading whose members cannot be made: a session is exited
      // because its process ended, so anything started here would leave the
      // heading it was started from on its first frame.
      const user = userEvent.setup()
      const { sock, welcomeLocal } = await mountSessions()
      welcomeLocal()
      listed(sock, [
        info({ id: 's1' }),
        info({ id: 's2', state: 'exited', exitCode: 1 }),
      ])
      await user.click(screen.getByRole('button', { name: 'Display options' }))
      // The default folds the ended session away, and a heading that is not
      // there can prove nothing about its controls.
      await user.click(screen.getByRole('checkbox', { name: 'Show exited sessions' }))
      await pick(user, 'Grouping', 'State')
      await user.keyboard('{Escape}')

      // Two, not three: the toolbar's own button and the Running heading's.
      // Grouped by state there are two headings on screen and only one of them
      // may offer to make something.
      expect(screen.getAllByRole('button', { name: 'New session' })).toHaveLength(2)
    })

    it('ignores an attached it did not ask for', async () => {
      const { sock, router } = await mountSessions()

      act(() => sock.emitControl(attached({ ref: 9, id: 'someone-else' })))

      expect(sock.ofType('detach')).toEqual([])
      expect(router.state.location.pathname).toBe('/sessions')
    })

    it('refuses in words when no machine is reachable', async () => {
      // The dialog opens from a button that was pressed, so a form that
      // silently did nothing would leave the reader pressing Start at a fleet
      // that is not there.
      const tabs = watchOpen()
      const { sock } = await mountSessions({ open: false })

      await userEvent.click(newSession())

      expect(screen.getByText(/no machine is reachable/i)).toBeTruthy()
      expect(screen.getByRole('button', { name: 'Start session' })).toHaveProperty(
        'disabled',
        true,
      )

      await start()

      expect(sock.ofType('spawn')).toEqual([])
      expect(tabs.count()).toBe(0)
    })

    it('keeps the teal on the new-session control alone', async () => {
      const { sock } = await mountSessions()
      listed(sock, [info({ id: 's1' }), info({ id: 's2', cwd: '/two' })])

      const filled = screen
        .getAllByRole('button')
        .filter((b) => b.getAttribute('data-variant') === 'default')

      // Two halves, one control: the primary verb and its machine picker.
      expect(filled).toHaveLength(2)
      expect(filled[0]!.textContent).toBe('New session')
      expect(filled[1]!.getAttribute('aria-label')).toBe('Choose a machine for the new session')
    })
  })

  describe('saved views', () => {
    async function saveAs(user: ReturnType<typeof userEvent.setup>, name: string) {
      await user.click(screen.getByRole('button', { name: 'Save current view' }))
      await user.type(screen.getByRole('textbox', { name: 'Name' }), name)
      await user.click(screen.getByRole('button', { name: 'Save' }))
    }

    it('saves the arrangement, applies a view, and comes back to All', async () => {
      const user = userEvent.setup()
      const { sock } = await mountSessions()
      listed(sock, [info({ id: 's1', cwd: '/live' }), info({ id: 's2', cwd: '/dead', state: 'exited' })])

      // Arrange: ended sessions in — the default folds them away — then keep
      // that under a name.
      await user.click(screen.getByRole('button', { name: 'Display options' }))
      await user.click(screen.getByRole('checkbox', { name: 'Show exited sessions' }))
      await user.keyboard('{Escape}')
      expect(screen.getByText('/dead')).toBeTruthy()

      await saveAs(user, 'Ops')
      expect(screen.getByRole('button', { name: 'Ops' }).getAttribute('aria-pressed')).toBe('true')

      // All is the built-in default: the ended session folds away again.
      await user.click(screen.getByRole('button', { name: 'All' }))
      expect(screen.queryByText('/dead')).toBeNull()

      // And the tab re-applies what it kept.
      await user.click(screen.getByRole('button', { name: 'Ops' }))
      expect(screen.getByText('/dead')).toBeTruthy()

      const kept = JSON.parse(localStorage.getItem('flue.views')!) as Array<{
        name: string
        showExited: boolean
      }>
      expect(kept).toHaveLength(1)
      expect(kept[0]).toMatchObject({ name: 'Ops', showExited: true })
    })

    it('marks dirty by value, so an edit undone is no edit at all', async () => {
      const user = userEvent.setup()
      const { sock } = await mountSessions()
      listed(sock, [info({ id: 's1' })])
      await saveAs(user, 'Ops')
      expect(screen.queryByRole('button', { name: 'Update view' })).toBeNull()

      const search = screen.getByRole('searchbox', { name: 'Search sessions' })
      await user.type(search, 'web')
      await waitFor(() =>
        expect(screen.getByRole('button', { name: 'Update view' })).toBeTruthy(),
      )

      // Clearing the search restores the saved values exactly. An identity
      // comparison would stay dirty here for good: the controls hand back a
      // fresh ViewConfig object on every touch, equal values or not.
      await user.clear(search)
      await waitFor(() =>
        expect(screen.queryByRole('button', { name: 'Update view' })).toBeNull(),
      )
    })

    it('resets to All when the active view is deleted', async () => {
      const user = userEvent.setup()
      const { sock } = await mountSessions()
      listed(sock, [info({ id: 's1' })])
      await saveAs(user, 'Ops')

      await user.click(screen.getByRole('button', { name: 'View options for Ops' }))
      await user.click(screen.getByRole('menuitem', { name: 'Delete view' }))

      expect(screen.queryByRole('button', { name: 'Ops' })).toBeNull()
      expect(screen.getByRole('button', { name: 'All' }).getAttribute('aria-pressed')).toBe('true')
    })

    it('announces a save the store refused', async () => {
      const user = userEvent.setup()
      const { sock } = await mountSessions()
      listed(sock, [info({ id: 's1' })])

      vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
        throw new Error('quota exceeded')
      })
      await saveAs(user, 'Ops')

      expect(notice().textContent).toContain('Could not save the view')
      expect(screen.queryByRole('button', { name: 'Ops' })).toBeNull()
    })
  })

  describe('the arrangement kept between visits', () => {
    it('restores a changed grouping after a remount', async () => {
      // The bug this closes: change the grouping, reload the page, and the
      // list snapped back to machine. The arrangement now rides
      // localStorage on every change and the next mount opens on it.
      const user = userEvent.setup()
      const first = await mountSessions()
      listed(first.sock, [info({ id: 's1' }), info({ id: 's2', state: 'exited' })])
      await user.click(screen.getByRole('button', { name: 'Display options' }))
      await user.click(screen.getByRole('checkbox', { name: 'Show exited sessions' }))
      await pick(user, 'Grouping', 'State')
      await user.keyboard('{Escape}')
      first.unmount()

      const second = await mountSessions()
      listed(second.sock, [info({ id: 's1' }), info({ id: 's2', state: 'exited' })])

      expect(screen.getByRole('button', { name: 'Running' })).toBeTruthy()
      expect(screen.getByRole('button', { name: 'Exited' })).toBeTruthy()
    })

    it('opens on the default when the kept arrangement is corrupt', async () => {
      localStorage.setItem('flue.view.current', '{not json')
      const { sock, welcomeLocal } = await mountSessions()
      welcomeLocal()
      listed(sock, [info({ id: 's1' })])

      expect(screen.getByRole('button', { name: 'mesa.local' })).toBeTruthy()
    })

    it('restores the pressed tab', async () => {
      const user = userEvent.setup()
      const first = await mountSessions()
      listed(first.sock, [info({ id: 's1' })])
      await user.click(screen.getByRole('button', { name: 'Save current view' }))
      await user.type(screen.getByRole('textbox', { name: 'Name' }), 'Ops')
      await user.click(screen.getByRole('button', { name: 'Save' }))
      expect(screen.getByRole('button', { name: 'Ops' }).getAttribute('aria-pressed')).toBe(
        'true',
      )
      first.unmount()

      await mountSessions()

      expect(screen.getByRole('button', { name: 'Ops' }).getAttribute('aria-pressed')).toBe(
        'true',
      )
    })

    it('falls back to All when the restored tab is gone, keeping the arrangement', async () => {
      // A view deleted in another browser tab can still be named by this
      // one's record. The strip cannot press a tab that is not there, so the
      // name falls away — but the arrangement stays: it is what the reader
      // was looking at, whatever it used to be called.
      localStorage.setItem(
        'flue.view.current',
        JSON.stringify({
          view: {
            grouping: 'machine',
            ordering: 'lastActive',
            search: '',
            columns: ['name', 'directory'],
            showExited: false,
          },
          active: 'Ops',
        }),
      )
      const { sock } = await mountSessions()
      listed(sock, [
        info({ id: 's1', cwd: '/live' }),
        info({ id: 's2', cwd: '/dead', state: 'exited' }),
      ])

      expect(screen.getByRole('button', { name: 'All' }).getAttribute('aria-pressed')).toBe(
        'true',
      )
      expect(screen.getByText('/live')).toBeTruthy()
      expect(screen.queryByText('/dead')).toBeNull()
    })
  })

  describe('the cwd flue open hands over', () => {
    afterEach(() => history.replaceState(null, '', '/'))

    it('spawns a session in that directory on the ridden machine and navigates to it', async () => {
      history.replaceState(null, '', '/?cwd=%2FUsers%2Fkarn%2Fproj')
      const { sock, router } = await mountSessions()

      expect(sock.ofType('spawn')).toEqual([
        { type: 'spawn', cwd: '/Users/karn/proj', cols: 80, rows: 24, reqId: 1 },
      ])
      expect(location.search).toBe('') // consumed, so a reload spawns nothing

      act(() => sock.emitControl(attached({ ref: 1, id: 'fresh', reqId: 1 })))
      await waitFor(() => expect(router.state.location.pathname).toBe('/d/local/s/fresh'))
    })

    it('holds the spawn until the socket opens', async () => {
      history.replaceState(null, '', '/?cwd=%2Ftmp')
      const { sock } = await mountSessions({ open: false })
      expect(sock.ofType('spawn')).toEqual([])

      act(() => sock.open())

      expect(sock.ofType('spawn')).toEqual([
        { type: 'spawn', cwd: '/tmp', cols: 80, rows: 24, reqId: 1 },
      ])
    })

    it('spawns nothing when no cwd was handed over', async () => {
      const { sock } = await mountSessions()
      expect(sock.ofType('spawn')).toEqual([])
    })

    it('never spawns for a screen the user navigated away from before the socket opened', async () => {
      history.replaceState(null, '', '/?cwd=%2Ftmp')
      const { sock, unmount } = await mountSessions({ open: false })

      unmount()
      act(() => sock.open())

      expect(sock.ofType('spawn')).toEqual([])
    })

    it('spawns exactly once under a StrictMode double mount, cold', async () => {
      // The mount effect that carries the cwd spawn double-fires under
      // StrictMode exactly like every other effect here: the URL param is
      // consumed on the first render only, and whichever of the two mounts
      // survives is the one whose status listener answers the open.
      history.replaceState(null, '', '/?cwd=%2FUsers%2Fkarn%2Fproj')
      const { sock } = await mountSessions({ open: false, strict: true })
      expect(sock.ofType('spawn')).toEqual([])

      act(() => sock.open())

      expect(sock.ofType('spawn')).toEqual([
        { type: 'spawn', cwd: '/Users/karn/proj', cols: 80, rows: 24, reqId: 1 },
      ])
      expect(location.search).toBe('') // taken on the first render, not the second
    })
  })
})
