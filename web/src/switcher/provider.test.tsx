import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { RouterProvider } from '@tanstack/react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { FleetClient } from '@/fleet/fleet'
import { FleetProvider } from '@/fleet/provider'
import { createFlueRouter } from '@/router'
import type { SessionInfo } from '@/client/protocol'
import { attached, fakeClient, type FakeSocket } from '@/testing/socket'
import { listRecents } from './recents'

/** One session as a daemon reports it, with the dull fields filled in. */
function row(over: Partial<SessionInfo> & { id: string }): SessionInfo {
  return {
    title: '',
    name: '',
    tags: [],
    pinned: false,
    cwd: '/home/karn',
    cmd: ['zsh'],
    state: 'running',
    exitCode: 0,
    cols: 80,
    rows: 24,
    createdAt: '2026-01-01T00:00:00Z',
    lastActive: '2026-01-01T00:00:00Z',
    ...over,
  }
}

/**
 * The real router, at `path`, over two scripted machines.
 *
 * The switcher provider lives in the root route, so this mounts it exactly as
 * the app does — including its chord listener, which is the part worth testing
 * through the real tree rather than in isolation: a listener registered in the
 * wrong phase, or on the wrong target, still passes every unit test in
 * switcher/keys.test.ts.
 */
async function mountApp(path: string) {
  window.history.replaceState(null, '', path)
  const router = createFlueRouter()
  await router.load()
  const local = fakeClient()
  const studio = fakeClient()
  const fleet = new FleetClient([
    { id: 'local', name: 'macbook', client: local.client, pinned: false },
    { id: 'studio', name: 'studio', client: studio.client, pinned: false },
  ])
  let view!: ReturnType<typeof render>
  await act(async () => {
    view = render(
      <FleetProvider fleet={fleet}>
        <RouterProvider router={router} />
      </FleetProvider>,
    )
  })
  return { ...view, router, local, studio }
}

/**
 * Open a machine's scripted socket and hand it a session list.
 *
 * The first socket, not the last: a client that reconnects opens another, and
 * the one the fleet is wired to is the one it dialled at mount.
 */
function listOn(machine: { sockets: FakeSocket[] }, sessions: SessionInfo[]) {
  const sock = machine.sockets[0]!
  act(() => {
    if (!sock.opened) sock.open()
    sock.emitControl({ type: 'sessions', sessions })
  })
  return sock
}

const path = (router: { state: { location: { pathname: string } } }) =>
  router.state.location.pathname

describe('SwitcherProvider', () => {
  beforeEach(() => {
    localStorage.clear()
    sessionStorage.clear()
    // jsdom lays nothing out, and the terminal route's emulator reaches for the
    // legacy addListener pair as well as the modern one — a stub missing either
    // half throws inside xterm and takes the route's render with it.
    vi.stubGlobal(
      'matchMedia',
      vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('opens the palette on Ctrl+Shift+K, from the sessions screen', async () => {
    const user = userEvent.setup()
    const { local } = await mountApp('/sessions')
    listOn(local, [row({ id: 'a', name: 'pnpm build' })])
    expect(screen.queryByRole('combobox')).toBeNull()
    await user.keyboard('{Control>}{Shift>}K{/Shift}{/Control}')
    expect(await screen.findByRole('combobox')).toBeTruthy()
    expect(screen.getAllByRole('option')[0]?.textContent).toContain('pnpm build')
  })

  it('lists every machine’s sessions, not just the one the tab rides', async () => {
    const user = userEvent.setup()
    const { local, studio } = await mountApp('/sessions')
    listOn(local, [row({ id: 'a', name: 'here' })])
    listOn(studio, [row({ id: 'b', name: 'over there' })])
    await user.keyboard('{Control>}{Shift>}K{/Shift}{/Control}')
    const rows = (await screen.findAllByRole('option')).map((r) => r.textContent ?? '')
    expect(rows.join(' ')).toContain('here')
    expect(rows.join(' ')).toContain('over there')
  })

  it('navigates to the session picked, on the machine that holds it', async () => {
    const user = userEvent.setup()
    const { local, studio, router } = await mountApp('/sessions')
    listOn(local, [row({ id: 'a', name: 'here' })])
    listOn(studio, [row({ id: 'b', name: 'over there' })])
    await user.keyboard('{Control>}{Shift>}K{/Shift}{/Control}')
    await user.type(await screen.findByRole('combobox'), 'over there')
    await act(async () => {
      await user.keyboard('{Enter}')
    })
    await waitFor(() => expect(path(router)).toBe('/d/studio/s/b'))
  })

  it('shuts on a second press of the chord that opened it', async () => {
    const user = userEvent.setup()
    const { local } = await mountApp('/sessions')
    listOn(local, [row({ id: 'a' })])
    await user.keyboard('{Control>}{Shift>}K{/Shift}{/Control}')
    expect(await screen.findByRole('combobox')).toBeTruthy()
    await user.keyboard('{Control>}{Shift>}K{/Shift}{/Control}')
    await waitFor(() => expect(screen.queryByRole('combobox')).toBeNull())
  })

  it('steps to the next session on Ctrl+Shift+], with nothing opened', async () => {
    const user = userEvent.setup()
    const { local, router } = await mountApp('/d/local/s/a')
    listOn(local, [
      row({ id: 'a', createdAt: '2026-01-01T00:00:00Z' }),
      row({ id: 'b', createdAt: '2026-02-01T00:00:00Z' }),
    ])
    await act(async () => {
      await user.keyboard('{Control>}{Shift>}{]}{/Shift}{/Control}')
    })
    await waitFor(() => expect(path(router)).toBe('/d/local/s/b'))
    expect(screen.queryByRole('combobox')).toBeNull()
  })

  it('wraps backwards on Ctrl+Shift+[', async () => {
    const user = userEvent.setup()
    const { local, router } = await mountApp('/d/local/s/a')
    listOn(local, [
      row({ id: 'a', createdAt: '2026-01-01T00:00:00Z' }),
      row({ id: 'b', createdAt: '2026-02-01T00:00:00Z' }),
    ])
    await act(async () => {
      await user.keyboard('{Control>}{Shift>}{[}{/Shift}{/Control}')
    })
    await waitFor(() => expect(path(router)).toBe('/d/local/s/b'))
  })

  it('jumps to a pinned session by number without opening anything', async () => {
    const user = userEvent.setup()
    const { local, router } = await mountApp('/sessions')
    listOn(local, [
      row({ id: 'p1', pinned: true, createdAt: '2026-01-01T00:00:00Z' }),
      row({ id: 'p2', pinned: true, createdAt: '2026-02-01T00:00:00Z' }),
      row({ id: 'loose' }),
    ])
    await act(async () => {
      await user.keyboard('{Control>}{Shift>}2{/Shift}{/Control}')
    })
    await waitFor(() => expect(path(router)).toBe('/d/local/s/p2'))
  })

  it('does nothing for a pinned number nobody has pinned', async () => {
    const user = userEvent.setup()
    const { local, router } = await mountApp('/sessions')
    listOn(local, [row({ id: 'a' })])
    await act(async () => {
      await user.keyboard('{Control>}{Shift>}7{/Shift}{/Control}')
    })
    expect(path(router)).toBe('/sessions')
  })

  it('writes down the session this tab is in, with enough to draw it later', async () => {
    const { local } = await mountApp('/d/local/s/a')
    listOn(local, [row({ id: 'a', name: 'the build one', cwd: '/srv/app' })])
    await waitFor(() => expect(listRecents()).toHaveLength(1))
    expect(listRecents()[0]).toMatchObject({
      machineId: 'local',
      machineName: 'macbook',
      sessionId: 'a',
      label: 'the build one',
      cwd: '/srv/app',
    })
  })

  it('writes it once, not on every poll', async () => {
    const { local } = await mountApp('/d/local/s/a')
    const sock = listOn(local, [row({ id: 'a', name: 'steady' })])
    await waitFor(() => expect(listRecents()).toHaveLength(1))
    const first = listRecents()[0]?.visitedAt
    act(() => sock.emitControl({ type: 'sessions', sessions: [row({ id: 'a', name: 'steady' })] }))
    expect(listRecents()[0]?.visitedAt).toBe(first)
  })

  it('remembers a renamed session under its new name', async () => {
    const { local } = await mountApp('/d/local/s/a')
    const sock = listOn(local, [row({ id: 'a', name: 'before' })])
    await waitFor(() => expect(listRecents()[0]?.label).toBe('before'))
    act(() => sock.emitControl({ type: 'sessions', sessions: [row({ id: 'a', name: 'after' })] }))
    await waitFor(() => expect(listRecents()[0]?.label).toBe('after'))
  })

  it('forgets a session its machine says is gone, so no ghost outlives it', async () => {
    const { local } = await mountApp('/d/local/s/a')
    const sock = listOn(local, [row({ id: 'a' })])
    await waitFor(() => expect(listRecents()).toHaveLength(1))
    act(() => sock.emitControl({ type: 'sessions', sessions: [] }))
    await waitFor(() => expect(listRecents()).toHaveLength(0))
  })

  it('starts a session where the tab is, when a search runs out', async () => {
    const user = userEvent.setup()
    const { local, router } = await mountApp('/d/local/s/a')
    const sock = listOn(local, [row({ id: 'a', cwd: '/srv/app' })])
    await user.keyboard('{Control>}{Shift>}K{/Shift}{/Control}')
    await user.type(await screen.findByRole('combobox'), 'nothing like this')
    await user.click(screen.getByRole('button', { name: 'New session in /srv/app' }))
    // The spawn goes out, and the route follows its `attached`, not the click.
    // The reqId is read back off the wire rather than assumed: the terminal
    // already on screen has spent one on its own attach.
    const spawn = sock.ofType('spawn').at(-1)
    expect(spawn).toMatchObject({ cwd: '/srv/app' })
    act(() => sock.emitControl(attached({ ref: 7, id: 'fresh', reqId: spawn?.reqId as number })))
    await waitFor(() => expect(path(router)).toBe('/d/local/s/fresh'))
  })
})
