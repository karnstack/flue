import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { FleetSession } from '@/fleet/types'
import type { RecentVisit } from '@/switcher/recents'

import { SessionSwitcher, type SessionSwitcherProps } from './session-switcher'

function s(over: Partial<FleetSession> = {}): FleetSession {
  return {
    id: 'id',
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
    machineId: 'local',
    machineName: 'macbook',
    ...over,
  }
}

function v(over: Partial<RecentVisit> = {}): RecentVisit {
  return {
    machineId: 'local',
    machineName: 'macbook',
    sessionId: 'id',
    label: 'zsh',
    cwd: '/home/karn',
    visitedAt: '2026-01-01T00:00:00Z',
    ...over,
  }
}

/** An answer a peek could give: one line of output, base64 as the wire has it. */
const PEEKED = { data: btoa('built in 1.24s'), cols: 80, rows: 24 }

function mount(over: Partial<SessionSwitcherProps> = {}) {
  const props: SessionSwitcherProps = {
    open: true,
    onOpenChange: vi.fn(),
    sessions: [s({ id: 'a', name: 'pnpm build' }), s({ id: 'b', name: 'go test' })],
    recents: [],
    currentKey: null,
    peek: vi.fn().mockResolvedValue(PEEKED),
    onPick: vi.fn(),
    onSpawn: vi.fn(),
    spawnLabel: 'New session in /home/karn',
    ...over,
  }
  const view = render(<SessionSwitcher {...props} />)
  return { ...view, props }
}

/** The rows on screen, in reading order. */
function rowNames(): string[] {
  return screen.getAllByRole('option').map((r) => r.textContent ?? '')
}

/** The row the keyboard is on. */
function selected(): string {
  return screen.getAllByRole('option').find((r) => r.getAttribute('aria-selected') === 'true')
    ?.textContent ?? ''
}

const field = () => screen.getByRole('combobox')

describe('SessionSwitcher', () => {
  beforeEach(() => {
    // jsdom lays nothing out, so the preview pane's media query has to be
    // answered explicitly; the desktop answer is the one with a pane in it.
    vi.stubGlobal(
      'matchMedia',
      vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('shows nothing at all while shut', () => {
    mount({ open: false })
    expect(screen.queryByRole('combobox')).toBeNull()
  })

  it('opens with every machine’s sessions already in it, never a spinner', () => {
    mount({
      sessions: [
        s({ id: 'a', name: 'pnpm build' }),
        s({ id: 'b', name: 'ssh vps', machineId: 'studio', machineName: 'studio' }),
      ],
    })
    expect(rowNames().join(' ')).toContain('pnpm build')
    expect(rowNames().join(' ')).toContain('ssh vps')
    expect(screen.queryByText(/loading/i)).toBeNull()
  })

  it('does not summon the keyboard when opened on mobile', async () => {
    vi.stubGlobal('innerWidth', 390)
    mount()

    const dialog = screen.getByRole('dialog')
    await waitFor(() => expect(document.activeElement).toBe(dialog))
    expect(dialog.className).toContain('max-md:max-w-none')
    expect(screen.getByRole('listbox').parentElement!.className).toContain('min-w-0')

    // Search remains available by explicit intent.
    await userEvent.setup().click(field())
    expect(document.activeElement).toBe(field())
  })

  it('reads pinned first, under its own heading, with the chord on the row', () => {
    mount({ sessions: [s({ id: 'a', name: 'loose' }), s({ id: 'p', name: 'kept', pinned: true })] })
    expect(screen.getByText('Pinned')).toBeTruthy()
    expect(rowNames()[0]).toContain('kept')
    expect(rowNames()[0]).toContain('⌃⇧1')
  })

  it('opens on the first row that is not the session you are already in', () => {
    mount({ currentKey: 'local/a' })
    expect(selected()).toContain('go test')
  })

  it('moves the highlight with the arrow keys, and wraps', async () => {
    const user = userEvent.setup()
    mount()
    expect(selected()).toContain('pnpm build')
    await user.keyboard('{ArrowDown}')
    expect(selected()).toContain('go test')
    await user.keyboard('{ArrowDown}')
    expect(selected()).toContain('pnpm build')
    await user.keyboard('{ArrowUp}')
    expect(selected()).toContain('go test')
  })

  it('goes to the highlighted session on Enter, and shuts on the way', async () => {
    const user = userEvent.setup()
    const { props } = mount()
    await user.keyboard('{ArrowDown}{Enter}')
    expect(props.onPick).toHaveBeenCalledWith({ machineId: 'local', sessionId: 'b' })
    expect(props.onOpenChange).toHaveBeenCalledWith(false)
  })

  it('goes to a session clicked with the pointer', async () => {
    const user = userEvent.setup()
    const { props } = mount()
    await user.click(screen.getAllByRole('option')[1]!)
    expect(props.onPick).toHaveBeenCalledWith({ machineId: 'local', sessionId: 'b' })
  })

  it('narrows on the keystroke, with nothing to wait for', async () => {
    const user = userEvent.setup()
    mount()
    await user.type(field(), 'go')
    expect(rowNames()).toHaveLength(1)
    expect(rowNames()[0]).toContain('go test')
  })

  it('searches a session’s machine and directory as well as its name', async () => {
    const user = userEvent.setup()
    mount({
      sessions: [s({ id: 'a', name: 'one', machineId: 'studio', machineName: 'studio' })],
    })
    await user.type(field(), 'studio')
    expect(rowNames()).toHaveLength(1)
  })

  it('jumps to a pinned session by its chord', async () => {
    const user = userEvent.setup()
    const { props } = mount({
      sessions: [
        s({ id: 'p1', name: 'first', pinned: true, createdAt: '2026-01-01T00:00:00Z' }),
        s({ id: 'p2', name: 'second', pinned: true, createdAt: '2026-02-01T00:00:00Z' }),
      ],
    })
    await user.keyboard('{Control>}{Shift>}2{/Shift}{/Control}')
    expect(props.onPick).toHaveBeenCalledWith({ machineId: 'local', sessionId: 'p2' })
  })

  it('shows a remembered session whose machine has gone, and still opens it', async () => {
    const user = userEvent.setup()
    const { props } = mount({
      sessions: [],
      recents: [v({ machineId: 'studio', machineName: 'studio', sessionId: 'g', label: 'ssh vps' })],
    })
    const ghost = screen.getAllByRole('option')[0]!
    expect(ghost.textContent).toContain('ssh vps')
    expect(ghost.textContent).toContain('unreachable')
    await user.click(ghost)
    expect(props.onPick).toHaveBeenCalledWith({ machineId: 'studio', sessionId: 'g' })
  })

  it('says why an unreachable machine has no preview to show', () => {
    mount({
      sessions: [],
      recents: [v({ machineId: 'studio', machineName: 'studio', sessionId: 'g', label: 'ssh vps' })],
    })
    expect(screen.getByText(/not reachable from here right now/)).toBeTruthy()
  })

  it('peeks the highlighted session, once it has settled', async () => {
    const peek = vi.fn().mockResolvedValue(PEEKED)
    mount({ peek })
    await waitFor(() => expect(peek).toHaveBeenCalledWith({ machineId: 'local', sessionId: 'a' }))
    expect(await screen.findByText(/built in 1.24s/)).toBeTruthy()
  })

  it('does not peek every row an arrow key travels past', async () => {
    const user = userEvent.setup()
    const peek = vi.fn().mockResolvedValue(PEEKED)
    mount({
      peek,
      sessions: [s({ id: 'a' }), s({ id: 'b' }), s({ id: 'c' }), s({ id: 'd' })],
    })
    await user.keyboard('{ArrowDown}{ArrowDown}{ArrowDown}')
    await waitFor(() => expect(peek).toHaveBeenCalled())
    // Only where the highlight came to rest.
    expect(peek).toHaveBeenCalledTimes(1)
    expect(peek).toHaveBeenCalledWith({ machineId: 'local', sessionId: 'd' })
  })

  it('does not re-ask for an answer it is already holding', async () => {
    const user = userEvent.setup()
    const peek = vi.fn().mockResolvedValue(PEEKED)
    mount({ peek })
    await waitFor(() => expect(peek).toHaveBeenCalledTimes(1))
    await user.keyboard('{ArrowDown}')
    await waitFor(() => expect(peek).toHaveBeenCalledTimes(2))
    await user.keyboard('{ArrowUp}')
    await new Promise((r) => setTimeout(r, 200))
    expect(peek).toHaveBeenCalledTimes(2)
  })

  it('keeps the pane quiet when a machine cannot answer', async () => {
    mount({ peek: vi.fn().mockRejectedValue(new Error('down')) })
    expect(await screen.findByText('No preview right now.')).toBeTruthy()
  })

  it('offers a new session when a search runs out', async () => {
    const user = userEvent.setup()
    const { props } = mount()
    await user.type(field(), 'nothing like this')
    expect(screen.getByText(/Nothing matching/)).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'New session in /home/karn' }))
    expect(props.onSpawn).toHaveBeenCalled()
    expect(props.onOpenChange).toHaveBeenCalledWith(false)
  })

  it('starts one on Enter too, when there is nothing else Enter could mean', async () => {
    const user = userEvent.setup()
    const { props } = mount()
    await user.type(field(), 'nothing like this')
    await user.keyboard('{Enter}')
    expect(props.onSpawn).toHaveBeenCalled()
  })

  it('offers no such row where there is no machine to start one on', async () => {
    const user = userEvent.setup()
    mount({ spawnLabel: null })
    await user.type(field(), 'nothing like this')
    expect(screen.queryByRole('button', { name: /New session/ })).toBeNull()
  })

  it('says how many rows the cap left out rather than swallowing them', () => {
    mount({ sessions: Array.from({ length: 60 }, (_, i) => s({ id: `s${i}` })) })
    expect(screen.getByText(/10 more — keep typing/)).toBeTruthy()
  })

  it('holds the highlight on its session while the fleet re-lists under it', () => {
    const { rerender, props } = mount({ currentKey: null })
    expect(selected()).toContain('pnpm build')
    // The same two sessions in fresh objects, as a poll hands them over, plus a
    // new one that would have taken the first row had the palette re-sorted.
    rerender(
      <SessionSwitcher
        {...props}
        sessions={[
          s({ id: 'c', name: 'brand new', lastActive: '2026-12-01T00:00:00Z' }),
          s({ id: 'a', name: 'pnpm build' }),
          s({ id: 'b', name: 'go test' }),
        ]}
      />,
    )
    expect(selected()).toContain('pnpm build')
    expect(rowNames()).toHaveLength(2)
  })

  it('redraws a row when its session is renamed under it', () => {
    const { rerender, props } = mount()
    rerender(
      <SessionSwitcher
        {...props}
        sessions={[s({ id: 'a', name: 'renamed' }), s({ id: 'b', name: 'go test' })]}
      />,
    )
    expect(rowNames()[0]).toContain('renamed')
  })

  it('keeps a row whose session has gone rather than moving the list', () => {
    const { rerender, props } = mount()
    rerender(<SessionSwitcher {...props} sessions={[s({ id: 'b', name: 'go test' })]} />)
    expect(rowNames()).toHaveLength(2)
    expect(rowNames()[0]).toContain('pnpm build')
  })

  it('marks the session the tab is already in', () => {
    mount({ currentKey: 'local/a' })
    const row = screen.getAllByRole('option')[0]!
    expect(within(row).getByText('current')).toBeTruthy()
  })
})
