import { act, render, screen } from '@testing-library/react'
import { RouterProvider } from '@tanstack/react-router'
import { describe, expect, it } from 'vitest'

import { FleetClient } from '@/fleet/fleet'
import { FleetProvider } from '@/fleet/provider'
import { createFlueRouter } from '@/router'
import type { SessionInfo } from '@/client/protocol'
import { fakeClient, type FakeSocket } from '@/testing/socket'

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
 * The real router at `path` over one scripted machine, exactly as the
 * switcher's tests mount it: the scratch provider lives in the root route,
 * and the chord listener is the part worth testing through the real tree.
 */
async function mountApp(path: string) {
  window.history.replaceState(null, '', path)
  const router = createFlueRouter()
  await router.load()
  const local = fakeClient()
  const fleet = new FleetClient([
    { id: 'local', name: 'macbook', client: local.client, pinned: false },
  ])
  let view!: ReturnType<typeof render>
  await act(async () => {
    view = render(
      <FleetProvider fleet={fleet}>
        <RouterProvider router={router} />
      </FleetProvider>,
    )
  })
  return { ...view, router, local }
}

/** Open the machine's first socket speaking `multiplex`, and list `sessions`. */
function connect(machine: { sockets: FakeSocket[] }, sessions: SessionInfo[]) {
  const sock = machine.sockets[0]!
  act(() => {
    if (!sock.opened) sock.open()
    sock.emitControl({
      type: 'welcome',
      daemonId: 'local',
      host: 'macbook',
      ver: '0.5.0',
      caps: ['multiplex'],
    })
    sock.emitControl({ type: 'sessions', sessions })
  })
  return sock
}

/** Two bare Ctrl taps — the scratch chord, played on the window. */
function tapCtrlTwice() {
  act(() => {
    for (let i = 0; i < 2; i++) {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Control', bubbles: true }))
      window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Control', bubbles: true }))
    }
  })
}

describe('ScratchProvider', () => {
  it('adopts the running scratch the chord finds and opens the modal', async () => {
    const { local } = await mountApp('/d/local/s/s1')
    const sock = connect(local, [row({ id: 's1' })])

    tapCtrlTwice()
    expect(sock.ofType('list').length).toBeGreaterThan(0)
    act(() => {
      sock.emitControl({
        type: 'sessions',
        sessions: [
          row({ id: 's1' }),
          row({ id: 'sc1', group: 's1', ephemeral: true }),
        ],
      })
    })

    expect(screen.getByText('Scratch terminal')).toBeTruthy()
    expect(sock.ofType('spawn')).toEqual([])
  })

  it('stays closed when the answer arrives after navigating to another session', async () => {
    const { router, local } = await mountApp('/d/local/s/s1')
    const sock = connect(local, [row({ id: 's1' }), row({ id: 's2' })])

    tapCtrlTwice()
    // The route moves while the list round-trip is out: the scratch that
    // resolves belongs to s1, and popping it over s2 would be a modal about
    // a session that is no longer on screen.
    await act(async () => {
      await router.navigate({
        to: '/d/$deviceId/s/$sessionId',
        params: { deviceId: 'local', sessionId: 's2' },
        replace: true,
      })
    })
    act(() => {
      sock.emitControl({
        type: 'sessions',
        sessions: [
          row({ id: 's1' }),
          row({ id: 's2' }),
          row({ id: 'sc1', group: 's1', ephemeral: true }),
        ],
      })
    })

    expect(screen.queryByText('Scratch terminal')).toBeNull()
    expect(sock.ofType('spawn')).toEqual([])
  })

  it('declines to spawn when the anchor is no longer a running session', async () => {
    const { local } = await mountApp('/d/local/s/s1')
    const sock = connect(local, [row({ id: 's1' })])

    tapCtrlTwice()
    // The parent exited between the chord and the answer. A scratch grouped
    // under an exited parent is closed by the daemon's next sweep within
    // seconds of being born — spawning it is a shell with a death warrant,
    // in the daemon's default directory no less.
    act(() => {
      sock.emitControl({
        type: 'sessions',
        sessions: [row({ id: 's1', state: 'exited', exitCode: 0 })],
      })
    })

    expect(sock.ofType('spawn')).toEqual([])
    expect(screen.queryByText('Scratch terminal')).toBeNull()
  })
})
