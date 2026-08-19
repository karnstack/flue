import { act, render, screen } from '@testing-library/react'
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
import { createFlueRouter, FILE_ROUTE_ID } from '@/router'
import { fakeClient, type FakeSocket } from '@/testing/socket'
import { FilePeekRoute, validateFilePeekSearch } from './file-peek'

/**
 * Mount the page at an address, over a scripted fleet of two machines — the
 * mountNew arrangement from new-session.test.tsx, for the same kind of route:
 * the address is the whole input, and the socket opens after the first render
 * because a window.open tab always starts cold.
 */
async function mountFile(url: string) {
  // jsdom lays nothing out, and the virtualizer windows on measured boxes —
  // the same pretend geometry viewer.test.tsx uses.
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(480)
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(800)
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    width: 800,
    height: 480,
    top: 0,
    left: 0,
    right: 800,
    bottom: 480,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect)
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
      path: '/d/$deviceId/s/$sessionId/file',
      validateSearch: validateFilePeekSearch,
      component: FilePeekRoute,
    }),
  ])
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [url] }),
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
  return { ...view, router, local, attic }
}

const served = (sock: FakeSocket, reqId: unknown, over: Record<string, unknown> = {}) =>
  act(() => {
    sock.emitControl({
      type: 'file',
      ref: 7,
      path: '/home/k/notes.txt',
      size: 22,
      mime: 'text/plain; charset=utf-8',
      kind: 'text',
      reqId: reqId as number,
      ...over,
    })
  })

const flowed = async (sock: FakeSocket, body: string) => {
  await act(async () => {
    sock.emitFile(7, body)
    await new Promise((frame) => requestAnimationFrame(frame))
  })
}

afterEach(() => vi.restoreAllMocks())

describe('FilePeekRoute', () => {
  it('reads the named file over the session once the socket opens, and paints it', async () => {
    const { local } = await mountFile('/d/local/s/s1/file?path=%2Fhome%2Fk%2Fnotes.txt')
    const sock = local.sockets[0]!

    // A cold tab: nothing can be asked before the socket is up.
    expect(sock.ofType('read')).toEqual([])

    act(() => sock.open())
    const sent = sock.control().find((m) => m.type === 'read')
    expect(sent).toMatchObject({ type: 'read', id: 's1', path: '/home/k/notes.txt' })

    served(sock, sent!.reqId)
    await flowed(sock, 'plain words\nsecond line')
    expect(screen.getByText('plain words')).toBeTruthy()
    await act(async () => {
      sock.emitControl({ type: 'eof', ref: 7 })
      await new Promise((frame) => requestAnimationFrame(frame))
    })
    expect(screen.getByText('second line')).toBeTruthy()
  })

  it('sets the tab title to the file basename while mounted', async () => {
    document.title = 'flue'
    const view = await mountFile('/d/local/s/s1/file?path=%2Fhome%2Fk%2Fnotes.txt')
    expect(document.title).toBe('notes.txt')
    view.unmount()
    expect(document.title).toBe('flue')
  })

  it('reads over the machine the address names', async () => {
    const { local, attic } = await mountFile('/d/attic-pi/s/s1/file?path=a.go')
    act(() => attic.sockets[0]!.open())
    expect(attic.sockets[0]!.ofType('read')).toMatchObject([{ type: 'read', id: 's1', path: 'a.go' }])
    expect(local.sockets[0]!.ofType('read')).toEqual([])
  })

  it('refuses an address that names no path', async () => {
    document.title = 'flue'
    const { local } = await mountFile('/d/local/s/s1/file')
    act(() => local.sockets[0]!.open())
    expect(screen.getByRole('alert').textContent).toMatch(/Not a usable path/)
    expect(local.sockets[0]!.ofType('read')).toEqual([])
    expect(document.title).toBe('flue')
  })

  it('is registered in the app router, outside the shell like the terminal', () => {
    const ids = createFlueRouter()
      .matchRoutes('/d/local/s/abc123/file', {})
      .map((m) => m.routeId)
    expect(ids).toContain(FILE_ROUTE_ID)
    expect(ids.some((id) => id.includes('shell'))).toBe(false)
  })
})
