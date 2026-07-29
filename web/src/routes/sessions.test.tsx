import { act, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { FlueClientProvider } from '@/client/provider'
import type { SessionInfo } from '@/client/protocol'
import { renderWithRouter } from '@/testing/render'
import { attached, fakeClient, type FakeSocket } from '@/testing/socket'
import { SessionsRoute } from './sessions'

function info(over: Partial<SessionInfo> & { id: string }): SessionInfo {
  return {
    title: 'zsh',
    cwd: '/Users/karn/code/flue',
    cmd: ['zsh', '-l'],
    state: 'running',
    exitCode: 0,
    cols: 80,
    rows: 24,
    lastActive: '2026-07-28T10:00:00Z',
    ...over,
  }
}

/**
 * Mount the screen under a router, with a client whose socket is up unless
 * asked otherwise.
 *
 * The socket is opened *after* the first render on purpose: a screen reached
 * by navigating mounts into a connection that is already established, but the
 * very first paint of the tab does not, and `list` has to survive both.
 */
async function mountSessions({ open = true } = {}) {
  const { client, sockets } = fakeClient()
  const view = await renderWithRouter(
    <FlueClientProvider client={client}>
      <SessionsRoute />
    </FlueClientProvider>,
  )
  const sock = sockets[0]!
  if (open) act(() => sock.open())
  return { ...view, client, sockets, sock }
}

function listed(sock: FakeSocket, sessions: SessionInfo[]) {
  act(() => sock.emitControl({ type: 'sessions', sessions }))
}

const newSession = () => screen.getByRole('button', { name: 'New session' })

afterEach(() => {
  vi.useRealTimers()
})

describe('SessionsRoute', () => {
  it('asks for the session list on mount, even before the socket is up', async () => {
    // The client holds one `list` while it is down for exactly this reason: a
    // request dropped here leaves the screen permanently empty.
    const { sock } = await mountSessions({ open: false })
    expect(sock.ofType('list')).toEqual([])

    act(() => sock.open())

    expect(sock.ofType('list')).toEqual([{ type: 'list' }])
  })

  it('renders what the daemon reports', async () => {
    const { sock } = await mountSessions()

    listed(sock, [info({ id: 's1', cwd: '/one' }), info({ id: 's2', cwd: '/two' })])

    expect(screen.getByText('/one')).toBeTruthy()
    expect(screen.getByText('/two')).toBeTruthy()
  })

  it('does not claim the daemon has no sessions before it has answered', async () => {
    // "No sessions yet" is a statement about the daemon. Showing it while the
    // first `list` is still in flight makes it up, and it is exactly the state
    // every cold load passes through.
    const { sock } = await mountSessions()
    expect(screen.queryByText(/No sessions yet/i)).toBeNull()

    listed(sock, [])

    expect(screen.getByText(/No sessions yet/i)).toBeTruthy()
  })

  it('keeps the list fresh while the screen is open, and stops polling on unmount', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const { client, sock, sockets, unmount } = await mountSessions()
    expect(sock.ofType('list')).toHaveLength(1)

    await act(() => vi.advanceTimersByTimeAsync(3_000))
    expect(sock.ofType('list')).toHaveLength(2)

    unmount()
    await act(() => vi.advanceTimersByTimeAsync(9_000))

    // Asserting on the dead socket would prove nothing: unmounting also closes
    // the client, so a leaked interval would send nothing either way. It is
    // still visible from outside, because `list` is the one request the client
    // holds while it is down — so a leaked tick leaves a request owed, and the
    // next connection replays it.
    act(() => client.connect())
    act(() => sockets[1]!.open())
    expect(sockets[1]!.ofType('list')).toEqual([])
  })

  it('opens a session that is already there', async () => {
    const { sock, router } = await mountSessions()
    listed(sock, [info({ id: 'abc123', cwd: '/one' })])

    await userEvent.click(screen.getByRole('button', { name: /open/i }))

    await waitFor(() => expect(router.state.location.pathname).toBe('/d/local/s/abc123'))
  })

  it('starts a session only when the user asks, and never from an effect', async () => {
    // `spawn` carries no idempotency key, so a spawn in a mount effect starts
    // two shells under StrictMode and can only ever detach one. Creation is a
    // click, always.
    const { sock } = await mountSessions()
    expect(sock.ofType('spawn')).toEqual([])

    await userEvent.click(newSession())

    expect(sock.ofType('spawn')).toEqual([{ type: 'spawn', cols: 80, rows: 24 }])
  })

  it('hands back the attachment the daemon gave it, then opens the new session', async () => {
    // The daemon attaches whoever spawns. This screen renders no terminal, and
    // the terminal route attaches on its own — so keeping that ref would leave
    // one tab holding two attachments to one session, which is the one shape
    // FlueClient's reattach plan cannot carry.
    const { sock, router } = await mountSessions()
    await userEvent.click(newSession())

    act(() => sock.emitControl(attached({ ref: 4, id: 'fresh1' })))

    expect(sock.ofType('detach')).toEqual([{ type: 'detach', ref: 4 }])
    await waitFor(() => expect(router.state.location.pathname).toBe('/d/local/s/fresh1'))
  })

  it('ignores an attached it did not ask for', async () => {
    // One client serves the whole tab, so this listener sees every reply —
    // including a reattach replayed after a reconnect. Navigating on one of
    // those would move the user somewhere they never asked to go.
    const { sock, router } = await mountSessions()

    act(() => sock.emitControl(attached({ ref: 9, id: 'someone-else' })))

    expect(sock.ofType('detach')).toEqual([])
    expect(router.state.location.pathname).toBe('/sessions')
  })

  it('takes one attached per spawn, not the next one that happens by', async () => {
    const { sock, router } = await mountSessions()
    await userEvent.click(newSession())

    act(() => sock.emitControl(attached({ ref: 1, id: 'mine' })))
    act(() => sock.emitControl(attached({ ref: 2, id: 'not-mine' })))

    expect(sock.ofType('detach')).toEqual([{ type: 'detach', ref: 1 }])
    await waitFor(() => expect(router.state.location.pathname).toBe('/d/local/s/mine'))
  })

  it('starts one session per click, not one per impatient click', async () => {
    // The second shell's `attached` would land after this screen has navigated
    // away on the first, with no listener to hand its ref back — an attachment
    // streaming output to nothing, held open across every reconnect.
    const { sock } = await mountSessions()

    await userEvent.click(newSession())
    await userEvent.click(newSession())

    expect(sock.ofType('spawn')).toHaveLength(1)
  })

  it('lets the user try again once a spawn has been answered', async () => {
    const { sock } = await mountSessions()
    await userEvent.click(newSession())
    act(() => sock.emitControl({ type: 'error', code: 'spawn_failed', msg: 'nope' }))

    await userEvent.click(newSession())

    expect(sock.ofType('spawn')).toHaveLength(2)
  })

  it('says so when the daemon refuses to start a session', async () => {
    const { sock } = await mountSessions()
    await userEvent.click(newSession())

    act(() =>
      sock.emitControl({ type: 'error', code: 'spawn_failed', msg: 'chdir /nope: no such file' }),
    )

    expect(screen.getByRole('status').textContent).toContain('chdir /nope')
  })

  it('does not silently drop a spawn it could not send', async () => {
    // `spawn` is deliberately not held while the socket is down — a shell
    // started minutes later at a screen nobody is looking at is worse than
    // none. That makes saying so this screen's job.
    const { sock } = await mountSessions({ open: false })

    await userEvent.click(newSession())

    expect(sock.ofType('spawn')).toEqual([])
    expect(screen.getByRole('status').textContent).toMatch(/not connected/i)
  })

  it('stops waiting for a reply that is never coming', async () => {
    // A failed spawn owes an `attached` that will not arrive. If that debt
    // stayed on the books, the next reattach to land would be mistaken for it.
    const { sock, router } = await mountSessions()
    await userEvent.click(newSession())
    act(() => sock.emitControl({ type: 'error', code: 'spawn_failed', msg: 'nope' }))

    act(() => sock.emitControl(attached({ ref: 6, id: 'unrelated' })))

    expect(sock.ofType('detach')).toEqual([])
    expect(router.state.location.pathname).toBe('/sessions')
  })

  it('reports a lost daemon rather than showing an empty screen', async () => {
    const { sock } = await mountSessions()
    listed(sock, [info({ id: 's1' })])

    act(() => sock.close())

    expect(screen.getByRole('status').textContent).toMatch(/reconnecting/i)
  })

  it('forgets a spawn the outage carried away', async () => {
    // The reply is never coming: it was owed on a socket that is gone. Left on
    // the books, it would claim the first `attached` of the next connection —
    // a reattach for some other view — and navigate away from under the user.
    vi.useFakeTimers({ shouldAdvanceTime: true })
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const { router, sock, sockets } = await mountSessions()
    await userEvent.click(newSession())

    act(() => sock.close())
    await act(() => vi.advanceTimersByTimeAsync(125))
    act(() => sockets[1]!.open())
    act(() => sockets[1]!.emitControl(attached({ ref: 1, id: 'someone-else' })))

    expect(sockets[1]!.ofType('detach')).toEqual([])
    expect(router.state.location.pathname).toBe('/sessions')
    vi.restoreAllMocks()
  })

  it('keeps one primary button on the screen', async () => {
    const { sock } = await mountSessions()
    listed(sock, [info({ id: 's1' }), info({ id: 's2', cwd: '/two' })])

    const filled = screen
      .getAllByRole('button')
      .filter((b) => b.getAttribute('data-variant') === 'default')

    expect(filled).toHaveLength(1)
    expect(filled[0]!.textContent).toBe('New session')
  })
})
