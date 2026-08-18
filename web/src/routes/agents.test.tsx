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

import type { AgentSummary } from '@/client/protocol'
import { SidebarProvider } from '@/components/ui/sidebar'
import { FleetClient } from '@/fleet/fleet'
import { FleetProvider } from '@/fleet/provider'
import { fakeClient, type FakeSocket } from '@/testing/socket'
import { AgentsRoute } from './agents'

function summary(over: Partial<AgentSummary> & { id: string }): AgentSummary {
  return {
    tool: 'claude',
    cwd: '/Users/karn/code/flue',
    startedAt: '2026-08-18T09:00:00Z',
    endedAt: new Date().toISOString(),
    messageCount: 12,
    toolCallCount: 3,
    models: ['claude-sonnet-4-5'],
    tokens: { input: 1000, output: 500, cacheRead: 0, cacheWrite: 0 },
    fileSize: 4096,
    ...over,
  }
}

/**
 * Mount the screen under a router that really routes, over a scripted fleet —
 * routes/sessions.test.tsx's harness, cut down to what this screen touches.
 * One machine by default, because the machine chips and headings are the
 * fleet's own tests' business; this suite is about the agent verbs.
 */
async function mountAgents() {
  const local = fakeClient()
  const fleet = new FleetClient([{ id: 'local', name: '', client: local.client, pinned: false }])

  const rootRoute = createRootRoute({ component: () => <Outlet /> })
  const routeTree = rootRoute.addChildren([
    createRoute({ getParentRoute: () => rootRoute, path: '/agents', component: AgentsRoute }),
    ...['/', '/sessions', '/agents/$machineId/$tool/$sessionId', '/d/$deviceId/s/$sessionId'].map(
      (path) => createRoute({ getParentRoute: () => rootRoute, path, component: () => null }),
    ),
  ])
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: ['/agents'] }),
  })
  await router.load()

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
  act(() => sock.open())

  /** The greeting that carries — or withholds — the agents capability. */
  const welcome = (caps?: string[]) =>
    act(() =>
      sock.emitControl({
        type: 'welcome',
        daemonId: 'd1',
        host: 'mesa.local',
        ver: '0.1.0',
        ...(caps === undefined ? {} : { caps }),
      }),
    )

  return { ...view, router, fleet, local, sock, welcome }
}

/** Answer the newest `agents` ask on `sock` with an index. */
function indexed(sock: FakeSocket, sessions: AgentSummary[], building = false) {
  const asks = sock.ofType('agents')
  const reqId = asks[asks.length - 1]!.reqId as number
  act(() => sock.emitControl({ type: 'agentIndex', reqId, building, sessions }))
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  localStorage.clear()
})

describe('AgentsRoute', () => {
  it('asks a capable machine for its transcripts and renders the rows', async () => {
    const { sock, welcome } = await mountAgents()

    // No welcome yet: the capability is unknown, so nothing is asked.
    expect(sock.ofType('agents')).toEqual([])

    welcome(['agents'])
    await waitFor(() => expect(sock.ofType('agents')).toHaveLength(1))

    indexed(sock, [
      summary({ id: 'abc123', title: 'Fix the tailwind build' }),
      summary({ id: 'def456', tool: 'codex', firstPrompt: 'add dark mode' }),
    ])

    // Rows under the day heading, each row one link into the viewer.
    await waitFor(() =>
      expect(
        screen.getByRole('link', { name: 'Open the Fix the tailwind build transcript' }),
      ).toBeTruthy(),
    )
    expect(screen.getByText('Today')).toBeTruthy()
    const row = screen.getByRole('link', { name: 'Open the add dark mode transcript' })
    expect(row.getAttribute('href')).toBe('/agents/local/codex/def456')
  })

  it('shows the empty state once a capable machine answers with nothing', async () => {
    const { sock, welcome } = await mountAgents()
    welcome(['agents'])
    await waitFor(() => expect(sock.ofType('agents')).toHaveLength(1))

    indexed(sock, [])

    await waitFor(() => expect(screen.getByText('No agent transcripts')).toBeTruthy())
    expect(screen.getByText(/Claude Code, Codex, and Pi/)).toBeTruthy()
  })

  it('does not claim emptiness before the machine has answered', async () => {
    const { sock, welcome } = await mountAgents()
    welcome(['agents'])
    await waitFor(() => expect(sock.ofType('agents')).toHaveLength(1))

    expect(screen.queryByText('No agent transcripts')).toBeNull()
  })

  it('says a welcomed machine without the capability is too old', async () => {
    const { sock, welcome } = await mountAgents()
    welcome(['multiplex'])

    await waitFor(() => expect(screen.getByText(/too old to index agent transcripts/)).toBeTruthy())
    // And it is never asked: the verbs would only earn a bad_message.
    expect(sock.ofType('agents')).toEqual([])
  })

  it('narrows the rows through the tool chips', async () => {
    const { sock, welcome } = await mountAgents()
    welcome(['agents'])
    await waitFor(() => expect(sock.ofType('agents')).toHaveLength(1))
    indexed(sock, [
      summary({ id: 'a1', title: 'claude work' }),
      summary({ id: 'b2', tool: 'codex', title: 'codex work' }),
    ])
    await waitFor(() => expect(screen.getByText('claude work')).toBeTruthy())

    await userEvent.click(screen.getByRole('button', { name: 'Codex' }))

    expect(screen.queryByText('claude work')).toBeNull()
    expect(screen.getByText('codex work')).toBeTruthy()

    // All brings everything back.
    await userEvent.click(screen.getByRole('button', { name: 'All' }))
    expect(screen.getByText('claude work')).toBeTruthy()
  })

  it('promotes a submitted search to results and lands hits on the anchor', async () => {
    const { sock, welcome, router } = await mountAgents()
    welcome(['agents'])
    await waitFor(() => expect(sock.ofType('agents')).toHaveLength(1))
    indexed(sock, [summary({ id: 'abc123', title: 'Fix the tailwind build' })])

    await userEvent.type(
      screen.getByRole('searchbox', { name: 'Search transcripts' }),
      'tailwind{Enter}',
    )

    // The query rides the URL, so back undoes the search.
    await waitFor(() =>
      expect((router.state.location.search as { q?: string }).q).toBe('tailwind'),
    )
    await waitFor(() => expect(sock.ofType('agentSearch')).toHaveLength(1))
    expect(sock.ofType('agentSearch')[0]!.query).toBe('tailwind')

    const reqId = sock.ofType('agentSearch')[0]!.reqId as number
    act(() =>
      sock.emitControl({
        type: 'agentHits',
        reqId,
        building: false,
        truncated: false,
        hits: [
          {
            tool: 'claude',
            id: 'abc123',
            cwd: '/Users/karn/code/flue',
            title: 'Fix the tailwind build',
            role: 'user',
            snippet: 'please fix the tailwind build',
            offset: 512,
          },
        ],
      }),
    )

    // The hit is a link into the viewer, anchored on the matched line.
    const hit = await screen.findByRole('link', { name: /please fix the tailwind build/ })
    expect(hit.getAttribute('href')).toBe('/agents/local/claude/abc123?at=512')
    // The matched span is lit.
    expect(hit.querySelector('mark')?.textContent).toBe('tailwind')
  })

  it('keeps two hits on one source line apart in the results list', async () => {
    const { sock, welcome } = await mountAgents()
    welcome(['agents'])
    await waitFor(() => expect(sock.ofType('agents')).toHaveLength(1))
    indexed(sock, [summary({ id: 'abc123' })])

    const errors = vi.spyOn(console, 'error')

    await userEvent.type(
      screen.getByRole('searchbox', { name: 'Search transcripts' }),
      'tailwind{Enter}',
    )
    await waitFor(() => expect(sock.ofType('agentSearch')).toHaveLength(1))
    const reqId = sock.ofType('agentSearch')[0]!.reqId as number
    const shared = { tool: 'claude', id: 'abc123', cwd: '/Users/karn/code/flue' }
    act(() =>
      sock.emitControl({
        type: 'agentHits',
        reqId,
        building: false,
        truncated: false,
        // One Pi line holds two matched messages, so both hits carry the one
        // line's byte offset.
        hits: [
          { ...shared, role: 'assistant', snippet: 'thought about tailwind', offset: 512 },
          { ...shared, role: 'assistant', snippet: 'then said tailwind', offset: 512 },
        ],
      }),
    )

    // Both render, each under a key of its own: a shared-offset pair used to
    // collide and earn React's duplicate-key complaint.
    await waitFor(() =>
      expect(screen.getAllByRole('link', { name: /tailwind/ })).toHaveLength(2),
    )
    const collisions = errors.mock.calls.filter((args) => String(args[0]).includes('same key'))
    expect(collisions).toEqual([])
  })

  it('drops the build re-poll of a machine that left, not just its rows', async () => {
    const { sock, welcome, local } = await mountAgents()
    welcome(['agents'])
    await waitFor(() => expect(sock.ofType('agents')).toHaveLength(1))

    vi.useFakeTimers()
    // A partial answer while the sweep runs arms the re-poll, on a clock the
    // test now owns.
    indexed(sock, [summary({ id: 'a1', title: 'partial answer' })], true)
    await act(() => vi.advanceTimersByTimeAsync(0))

    // The machine drops off before the re-poll fires, and time passes it. An
    // orphan timer would ask the unreachable machine and write a failed entry
    // back for an id the screen no longer tracks.
    act(() => sock.close())
    await act(() => vi.advanceTimersByTimeAsync(2_500))

    // The client has redialled on its backoff; the machine returns, capable.
    const next = local.last()
    expect(next).not.toBe(sock)
    act(() => next.open())
    act(() =>
      next.emitControl({
        type: 'welcome',
        daemonId: 'd1',
        host: 'mesa.local',
        ver: '0.1.0',
        caps: ['agents'],
      }),
    )
    await act(() => vi.advanceTimersByTimeAsync(0))

    // Freshly asked and not yet answered, the screen must keep waiting: the
    // ghost entry the orphan would have written ends the loading state early
    // and claims emptiness for a machine that never got to answer.
    expect(next.ofType('agents')).toHaveLength(1)
    expect(screen.queryByText('No agent transcripts')).toBeNull()
  })

  it('reports an empty search in words', async () => {
    const { sock, welcome } = await mountAgents()
    welcome(['agents'])
    await waitFor(() => expect(sock.ofType('agents')).toHaveLength(1))
    indexed(sock, [summary({ id: 'abc123' })])

    await userEvent.type(
      screen.getByRole('searchbox', { name: 'Search transcripts' }),
      'zebra{Enter}',
    )
    await waitFor(() => expect(sock.ofType('agentSearch')).toHaveLength(1))
    const reqId = sock.ofType('agentSearch')[0]!.reqId as number
    act(() =>
      sock.emitControl({ type: 'agentHits', reqId, building: false, truncated: false, hits: [] }),
    )

    await waitFor(() => expect(screen.getByText(/No matches for/)).toBeTruthy())
  })

  it('switches to insights and totals what the range admits', async () => {
    const { sock, welcome } = await mountAgents()
    welcome(['agents'])
    await waitFor(() => expect(sock.ofType('agents')).toHaveLength(1))
    indexed(sock, [
      summary({
        id: 'a1',
        startedAt: new Date().toISOString(),
        tokens: { input: 1200, output: 800, cacheRead: 50, cacheWrite: 0 },
      }),
    ])
    await waitFor(() => expect(screen.getByRole('button', { name: 'Insights' })).toBeTruthy())

    await userEvent.click(screen.getByRole('button', { name: 'Insights' }))

    // The stat labels are dt elements; reading them by role keeps 'Sessions'
    // the stat rather than the mode tab of the same name. No cost column:
    // no transcript recorded one, so the column is dropped whole.
    const labels = screen.getAllByRole('term').map((el) => el.textContent)
    expect(labels).toEqual(['Sessions', 'Input tokens', 'Output tokens', 'Cache read'])
    expect(screen.getByText('1.2K')).toBeTruthy()
    expect(screen.getByText('Tokens per day')).toBeTruthy()
  })
})
