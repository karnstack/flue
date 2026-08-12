import { act, render, screen, waitFor } from '@testing-library/react'
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

import { FleetClient } from '@/fleet/fleet'
import { FleetProvider } from '@/fleet/provider'
import { attached, fakeClient } from '@/testing/socket'
import { validateNewSessionSearch } from '@/sessions/new-session'
import { NewSessionRoute } from './new-session'

/**
 * Mount the page at an address, over a scripted fleet of two machines.
 *
 * The address is the whole input to this route — it takes no props — so every
 * case here is written as a URL, which is also exactly how the dialog reaches
 * it in the app.
 *
 * The socket opens after the first render, because that is what a cold tab is:
 * this page is reached by window.open, so its client starts connecting at the
 * moment it mounts and the spawn cannot go out until the socket is up.
 *
 * `from` is the other arrival: a tab that is already connected and navigates
 * here, which is what a blocked popup falls back to. The page then mounts into
 * an open socket and spawns from its effect body rather than from a status
 * change — a different code path, and the one the double-mount guard is for.
 */
async function mountNew(
  url: string,
  { open = true, from }: { open?: boolean; from?: string } = {},
) {
  const local = fakeClient()
  const attic = fakeClient()
  const fleet = new FleetClient([
    { id: 'local', name: '', client: local.client, pinned: false },
    { id: 'attic-pi', name: 'Attic Pi', client: attic.client, pinned: false },
  ])

  const rootRoute = createRootRoute({ component: () => <Outlet /> })
  const routeTree = rootRoute.addChildren([
    createRoute({
      getParentRoute: () => rootRoute,
      path: '/new',
      validateSearch: validateNewSessionSearch,
      component: NewSessionRoute,
    }),
    ...['/', '/d/$deviceId/s/$sessionId'].map((path) =>
      createRoute({ getParentRoute: () => rootRoute, path, component: () => null }),
    ),
  ])
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [from ?? url] }),
  })
  await router.load()

  let view!: ReturnType<typeof render>
  await act(async () => {
    view = render(
      <FleetProvider fleet={fleet}>
        <RouterProvider router={router as never} />
      </FleetProvider>,
    )
  })
  const sock = local.sockets[0]!
  if (open) act(() => sock.open())
  if (from !== undefined) await act(async () => void (await router.navigate({ to: url })))

  return { ...view, router, sock, attic, local }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('NewSessionRoute', () => {
  it('spawns on the ridden machine and replaces itself with the terminal', async () => {
    const { sock, router } = await mountNew('/new')

    expect(sock.ofType('spawn')).toEqual([{ type: 'spawn', cols: 80, rows: 24, reqId: 1 }])

    await act(async () => sock.emitControl(attached({ ref: 3, id: 'fresh1', reqId: 1 })))

    // The daemon attaches whoever spawns, and this page renders no terminal —
    // the route it hands over to attaches on its own, so keeping the ref would
    // leave one tab holding two attachments to one session.
    expect(sock.ofType('detach')).toEqual([{ type: 'detach', ref: 3 }])
    await waitFor(() => expect(router.state.location.pathname).toBe('/d/local/s/fresh1'))
  })

  it('leaves nothing behind the back button', async () => {
    // A `replace`, so going back leaves rather than landing on this page again
    // — which would start a second session for one press.
    const { sock, router } = await mountNew('/new')
    await act(async () => sock.emitControl(attached({ ref: 1, id: 'fresh1', reqId: 1 })))
    await waitFor(() => expect(router.state.location.pathname).toBe('/d/local/s/fresh1'))

    await act(async () => void router.history.back())

    expect(router.state.location.pathname).not.toBe('/new')
  })

  it('starts in the directory the address named', async () => {
    const { sock } = await mountNew('/new?cwd=%2FUsers%2Fkarn%2Fproj')

    expect(sock.ofType('spawn')).toEqual([
      { type: 'spawn', cwd: '/Users/karn/proj', cols: 80, rows: 24, reqId: 1 },
    ])
  })

  it('starts on the machine the address named', async () => {
    const { sock, attic } = await mountNew('/new?d=attic-pi')
    act(() => attic.sockets[0]!.open())

    expect(sock.ofType('spawn')).toEqual([])
    expect(attic.sockets[0]!.ofType('spawn')).toHaveLength(1)
  })

  it('applies the name and tags the moment there is an id to apply them to', async () => {
    // The whole reason this page exists rather than a click handler: `spawn`
    // carries no metadata at all, so the earliest moment either can be sent is
    // the `attached` that answers it.
    const { sock } = await mountNew('/new?name=deploy&tags=%5B%22api%22%2C%22ops%22%5D')

    expect(sock.ofType('update')).toEqual([])

    await act(async () => sock.emitControl(attached({ ref: 1, id: 'fresh1', reqId: 1 })))

    expect(sock.ofType('update')).toEqual([
      { type: 'update', id: 'fresh1', name: 'deploy', tags: ['api', 'ops'] },
    ])
  })

  it('says nothing about metadata nobody asked for', async () => {
    // `name: ''` and `tags: []` are two deliberate clears on the wire. Sending
    // them for a session that was never given either would be this page making
    // an edit on the reader's behalf.
    const { sock } = await mountNew('/new')

    await act(async () => sock.emitControl(attached({ ref: 1, id: 'fresh1', reqId: 1 })))

    expect(sock.ofType('update')).toEqual([])
  })

  it('holds the spawn until the socket is up', async () => {
    // What every real visit is: this page is reached by window.open, so it
    // mounts into a client that is still dialling.
    const { sock } = await mountNew('/new', { open: false })
    expect(sock.ofType('spawn')).toEqual([])
    expect(screen.getByRole('status').textContent).toMatch(/connecting/i)

    act(() => sock.open())

    expect(sock.ofType('spawn')).toHaveLength(1)
    expect(screen.getByRole('status').textContent).toMatch(/starting/i)
  })

  it('says why when the daemon refuses, and offers another go', async () => {
    const { sock } = await mountNew('/new?cwd=%2Fnope')

    await act(async () =>
      sock.emitControl({
        type: 'error',
        code: 'spawn_failed',
        msg: 'chdir /nope: no such file',
        reqId: 1,
      }),
    )

    expect(screen.getByRole('status').textContent).toContain('chdir /nope')

    await userEvent.click(screen.getByRole('button', { name: 'Retry' }))

    expect(sock.ofType('spawn')).toHaveLength(2)
  })

  it('does not quietly ask again when the connection takes the answer away', async () => {
    // Whether the daemon got as far as starting a shell is unknowable from
    // here. A silent retry would leave a session behind for every answer an
    // outage swallowed, so this says what happened and waits to be asked.
    //
    // A real redial, not just a close: the client dials a *new* socket after
    // its backoff, and it is that socket coming up — a genuine second `open`
    // — that would send the second spawn if nothing stopped it.
    vi.useFakeTimers({ shouldAdvanceTime: true })
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const { sock, local } = await mountNew('/new')
    expect(sock.ofType('spawn')).toHaveLength(1)

    act(() => sock.close())
    await act(() => vi.advanceTimersByTimeAsync(125))
    act(() => local.sockets[1]!.open())

    expect(local.sockets[1]!.ofType('spawn')).toEqual([])
    expect(screen.getByRole('status').textContent).toMatch(/before the daemon answered/i)
    vi.useRealTimers()
  })

  it('refuses an address naming a machine this browser does not hold', async () => {
    const { sock } = await mountNew('/new?d=somebody-elses-laptop')

    expect(sock.ofType('spawn')).toEqual([])
    expect(screen.getByRole('status').textContent).toMatch(/not paired/i)
  })

  it('ignores an attached it did not ask for', async () => {
    const { sock, router } = await mountNew('/new')

    act(() => sock.emitControl(attached({ ref: 9, id: 'someone-else' })))

    expect(sock.ofType('detach')).toEqual([])
    expect(router.state.location.pathname).toBe('/new')
  })
})
