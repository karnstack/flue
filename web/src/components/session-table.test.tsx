import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import type { SessionInfo } from '@/client/protocol'
import { SessionTable } from './session-table'

function session(over: Partial<SessionInfo> & { id: string }): SessionInfo {
  return {
    title: 'zsh',
    cwd: '/Users/karn/code/flue',
    cmd: ['zsh', '-l'],
    state: 'running',
    exitCode: 0,
    cols: 120,
    rows: 40,
    lastActive: '2026-07-28T10:00:00Z',
    ...over,
  }
}

const sessions: SessionInfo[] = [
  session({ id: 'a1b2c3d4' }),
  session({
    id: 'e5f6a7b8',
    title: 'build',
    cwd: '/Users/karn/code/reins',
    cmd: ['pnpm', 'build'],
    state: 'exited',
    exitCode: 1,
    cols: 80,
    rows: 24,
    lastActive: '2026-07-28T09:30:00Z',
  }),
]

/** The directory cell of every body row, top to bottom. */
function directories(): string[] {
  const body = screen.getAllByRole('rowgroup')[1]!
  return within(body)
    .getAllByRole('row')
    .map((row) => within(row).getAllByRole('cell')[0]!.textContent!)
}

describe('SessionTable', () => {
  it('renders a row per session', () => {
    render(<SessionTable sessions={sessions} onOpen={() => {}} />)
    expect(screen.getByText('/Users/karn/code/flue')).toBeTruthy()
    expect(screen.getByText('/Users/karn/code/reins')).toBeTruthy()
  })

  it('shows the command that is running, not just the shell', () => {
    render(<SessionTable sessions={sessions} onOpen={() => {}} />)
    expect(screen.getByText('pnpm build')).toBeTruthy()
  })

  it('distinguishes running from exited', () => {
    render(<SessionTable sessions={sessions} onOpen={() => {}} />)
    expect(screen.getByText('Running')).toBeTruthy()
    expect(screen.getByText('Exited 1')).toBeTruthy()
  })

  it('calls onOpen with the session id', async () => {
    const onOpen = vi.fn()
    render(<SessionTable sessions={sessions} onOpen={onOpen} />)
    await userEvent.click(screen.getAllByRole('button', { name: /open/i })[0]!)
    expect(onOpen).toHaveBeenCalledWith('a1b2c3d4')
  })

  it('names each open control after its own row', () => {
    // Ten buttons all called "Open" are ten identical announcements. The
    // accessible name has to say which row it belongs to.
    render(<SessionTable sessions={sessions} onOpen={() => {}} />)
    expect(screen.getByRole('button', { name: /\/Users\/karn\/code\/reins/ })).toBeTruthy()
  })

  it('shows an empty state when there are no sessions', () => {
    render(<SessionTable sessions={[]} onOpen={() => {}} />)
    expect(screen.getByText(/No sessions yet/i)).toBeTruthy()
  })

  it('uses sentence case headings, never uppercase', () => {
    render(<SessionTable sessions={sessions} onOpen={() => {}} />)
    const heading = screen.getByRole('columnheader', { name: 'Directory' })
    expect(heading.className).not.toMatch(/\buppercase\b/)
  })

  it('puts the most recently active session first, whatever order it was given', () => {
    // Not cosmetic. The daemon builds `sessions` by ranging over a Go map, and
    // Go randomises that order per call — so unsorted rows would reshuffle
    // under the reader on every poll.
    const older = session({ id: 'older', cwd: '/older', lastActive: '2026-07-28T08:00:00Z' })
    const newer = session({ id: 'newer', cwd: '/newer', lastActive: '2026-07-28T12:00:00Z' })

    render(<SessionTable sessions={[older, newer]} onOpen={() => {}} />)
    expect(directories()).toEqual(['/newer', '/older'])
  })

  it('orders sessions that share a timestamp by id, so the order cannot drift', () => {
    const same = '2026-07-28T08:00:00Z'
    const b = session({ id: 'b', cwd: '/b', lastActive: same })
    const a = session({ id: 'a', cwd: '/a', lastActive: same })

    render(<SessionTable sessions={[b, a]} onOpen={() => {}} />)
    expect(directories()).toEqual(['/a', '/b'])
  })

  it('still renders every row when a timestamp is unusable', () => {
    // A comparator that returns NaN leaves Array#sort free to drop rows on the
    // floor in some engines and to reorder arbitrarily in all of them.
    const bad = session({ id: 'bad', cwd: '/bad', lastActive: 'not a date' })
    const worse = session({ id: 'worse', cwd: '/worse', lastActive: '' })
    const good = session({ id: 'good', cwd: '/good', lastActive: '2026-07-28T08:00:00Z' })

    render(<SessionTable sessions={[bad, good, worse]} onOpen={() => {}} />)
    expect(directories()).toEqual(['/good', '/bad', '/worse'])
  })

  it('does not draw the rows as cards', () => {
    // Sibling rows in a shared context take the lightest separation that
    // works. A card per row would claim each session is an independent object
    // when the set is one list, so: horizontal rules, no outer border, no
    // vertical rules, and the page background showing through.
    const { container } = render(<SessionTable sessions={sessions} onOpen={() => {}} />)
    const table = container.querySelector('table')!
    expect(table.className).toContain('w-full')

    for (const row of Array.from(table.querySelectorAll('tr'))) {
      expect(row.className).toMatch(/\bborder-b\b/)
      expect(row.className).not.toMatch(/\bborder-x\b|\bborder-t\b|\brounded/)
    }
    for (const cell of Array.from(table.querySelectorAll('td, th'))) {
      expect(cell.className).not.toMatch(/\bborder-/)
      expect(cell.className).not.toMatch(/\bbg-(?!transparent)/)
    }
  })
})
