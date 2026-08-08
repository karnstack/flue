import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import type { FleetSession } from '@/fleet/types'
import { COLUMN_KEYS, type Group } from '@/sessions/view'
import { SessionTable } from './session-table'

/**
 * One session, with everything a case did not care about filled in. The
 * defaults are inert — no name, one machine, one directory — so whatever a
 * case overrides is the only thing that can explain its result. `title: 'zsh'`
 * makes 'zsh' the display name unless a case says otherwise.
 */
function fs(over: Partial<FleetSession> & { id: string }): FleetSession {
  return {
    title: 'zsh',
    name: '',
    tags: [],
    pinned: false,
    cwd: '/Users/karn/code/flue',
    cmd: ['zsh', '-l'],
    state: 'running',
    exitCode: 0,
    cols: 120,
    rows: 40,
    createdAt: '2026-07-28T09:00:00Z',
    lastActive: '2026-07-28T10:00:00Z',
    machineId: 'm1',
    machineName: 'MacBook Pro',
    ...over,
  }
}

const group = (key: string, label: string, sessions: FleetSession[]): Group => ({
  key,
  label,
  sessions,
})

type Props = Parameters<typeof SessionTable>[0]

/** Mount with every callback spied and every prop defaulted but overridable. */
function renderTable(over: Partial<Props> = {}) {
  const props: Props = {
    groups: [group('machine:m1', 'MacBook Pro', [fs({ id: 'a1' })])],
    columns: [...COLUMN_KEYS],
    selected: new Set<string>(),
    onToggleSelect: vi.fn(),
    onToggleGroup: vi.fn(),
    collapsed: new Set<string>(),
    onOpen: vi.fn(),
    onAction: vi.fn(),
    ...over,
  }
  const view = render(<SessionTable {...props} />)
  return { ...view, props }
}

describe('SessionTable', () => {
  describe('groups', () => {
    it('heads each group with its label and a running/exited tally', () => {
      renderTable({
        groups: [
          group('machine:m1', 'MacBook Pro', [
            fs({ id: 'a1' }),
            fs({ id: 'b2', title: 'vim' }),
            fs({ id: 'c3', title: 'build', state: 'exited', exitCode: 1 }),
          ]),
        ],
      })

      const toggle = screen.getByRole('button', { name: 'MacBook Pro' })
      expect(toggle.getAttribute('aria-expanded')).toBe('true')
      expect(screen.getByText('2 running · 1 exited')).toBeTruthy()
    })

    it('says only what a tally has members for', () => {
      renderTable({
        groups: [group('machine:m1', 'MacBook Pro', [fs({ id: 'a1' })])],
      })
      expect(screen.getByText('1 running')).toBeTruthy()
      expect(screen.queryByText(/exited/)).toBeNull()
    })

    it('renders every group, in the order the view model decided', () => {
      const { container } = renderTable({
        groups: [
          group('machine:m1', 'MacBook Pro', [fs({ id: 'a1' })]),
          group('machine:m2', 'devbox', [fs({ id: 'b2', machineId: 'm2', machineName: 'devbox' })]),
        ],
      })
      const text = container.textContent!
      expect(text.indexOf('MacBook Pro')).toBeGreaterThan(-1)
      expect(text.indexOf('MacBook Pro')).toBeLessThan(text.indexOf('devbox'))
    })

    it('folds a collapsed group down to its heading', () => {
      renderTable({ collapsed: new Set(['machine:m1']) })

      const toggle = screen.getByRole('button', { name: 'MacBook Pro' })
      expect(toggle.getAttribute('aria-expanded')).toBe('false')
      expect(screen.queryByText('zsh')).toBeNull()
    })

    it('asks for a toggle rather than deciding one', async () => {
      // Collapse state lives in the route; this component only reports the
      // click and renders whatever `collapsed` says next time.
      const { props } = renderTable()

      await userEvent.click(screen.getByRole('button', { name: 'MacBook Pro' }))

      expect(props.onToggleGroup).toHaveBeenCalledWith('machine:m1')
      expect(
        screen.getByRole('button', { name: 'MacBook Pro' }).getAttribute('aria-expanded'),
      ).toBe('true')
    })
  })

  describe('columns', () => {
    it('renders the chosen columns in their fixed order, whatever order they arrive in', () => {
      renderTable({ columns: ['created', 'directory', 'name'] })

      const head = screen.getAllByRole('rowgroup')[0]!
      const headings = within(head)
        .getAllByRole('columnheader')
        .map((h) => h.textContent)
      expect(headings).toEqual(['Select', 'Name', 'Directory', 'Created', 'Actions'])
    })

    it('drops the cells of a column that is toggled off', () => {
      renderTable({ columns: ['name', 'state'] })

      expect(screen.queryByRole('columnheader', { name: 'Directory' })).toBeNull()
      expect(screen.queryByText('/Users/karn/code/flue')).toBeNull()
      expect(screen.getByText('Running')).toBeTruthy()
    })

    it('keeps the name column even when it is not asked for', () => {
      // A row with no name is a row nothing identifies. The component treats
      // 'name' as always on, whatever the columns preference says.
      renderTable({ columns: ['state'] })

      expect(screen.getByRole('columnheader', { name: 'Name' })).toBeTruthy()
      expect(screen.getByText('zsh')).toBeTruthy()
    })
  })

  describe('rows', () => {
    it('shows the display name with the command as its subtitle', () => {
      renderTable({
        groups: [
          group('machine:m1', 'MacBook Pro', [
            fs({ id: 'a1', title: 'build', cmd: ['pnpm', 'build'] }),
          ]),
        ],
      })
      expect(screen.getByText('build')).toBeTruthy()
      expect(screen.getByText('pnpm build')).toBeTruthy()
    })

    it('distinguishes running from exited', () => {
      renderTable({
        groups: [
          group('machine:m1', 'MacBook Pro', [
            fs({ id: 'a1' }),
            fs({ id: 'b2', title: 'build', state: 'exited', exitCode: 1 }),
          ]),
        ],
      })
      expect(screen.getByText('Running')).toBeTruthy()
      expect(screen.getByText('Exited 1')).toBeTruthy()
    })

    it('names the machine a row runs on', () => {
      renderTable({
        groups: [group('tag:api', 'api', [fs({ id: 'a1', tags: ['api'] })])],
      })
      expect(screen.getByText('MacBook Pro')).toBeTruthy()
    })

    it('shows the tags as chips', () => {
      renderTable({
        groups: [group('machine:m1', 'MacBook Pro', [fs({ id: 'a1', tags: ['api', 'prod'] })])],
      })
      expect(screen.getByText('api')).toBeTruthy()
      expect(screen.getByText('prod')).toBeTruthy()
    })

    it('cuts a long directory in the middle, keeping both ends', () => {
      // CSS ellipsis is end-only, and the end of a path is the half that
      // tells its sessions apart — so the cut is made in JS, in the middle.
      const cwd = '/Users/karn/code/karnstack/flue/web/src/components'
      renderTable({
        groups: [group('machine:m1', 'MacBook Pro', [fs({ id: 'a1', cwd })])],
      })

      expect(screen.getByText('/Users/karn/cod…lue/web/src/components')).toBeTruthy()
      expect(screen.getByTitle(cwd)).toBeTruthy()
    })

    it('leaves a short directory whole', () => {
      renderTable()
      expect(screen.getByText('/Users/karn/code/flue')).toBeTruthy()
    })

    it('tells time relatively in the last active and created cells', () => {
      const now = Date.now()
      renderTable({
        groups: [
          group('machine:m1', 'MacBook Pro', [
            fs({
              id: 'a1',
              lastActive: new Date(now - 5 * 60_000).toISOString(),
              createdAt: new Date(now - 2 * 24 * 60 * 60_000).toISOString(),
            }),
          ]),
        ],
      })
      expect(screen.getByText('5m ago')).toBeTruthy()
      expect(screen.getByText('2d ago')).toBeTruthy()
    })
  })

  describe('selection', () => {
    it('toggles by the composite key, and does not open the session', async () => {
      const { props } = renderTable()

      await userEvent.click(screen.getByRole('checkbox', { name: 'Select zsh' }))

      expect(props.onToggleSelect).toHaveBeenCalledWith('m1/a1')
      expect(props.onOpen).not.toHaveBeenCalled()
    })

    it('shows a session selected under every heading it appears in', () => {
      // A session tagged twice is the same object in two groups, and the
      // selection key repeats with it — one key, two checked boxes.
      const twice = fs({ id: 'a1', tags: ['api', 'ops'] })
      renderTable({
        groups: [group('tag:api', 'api', [twice]), group('tag:ops', 'ops', [twice])],
        selected: new Set(['m1/a1']),
      })

      const boxes = screen.getAllByRole('checkbox', { name: 'Select zsh' })
      expect(boxes).toHaveLength(2)
      for (const box of boxes) expect(box.getAttribute('aria-checked')).toBe('true')
    })
  })

  describe('opening', () => {
    it('opens from the name cell', async () => {
      const { props } = renderTable()

      await userEvent.click(screen.getByText('zsh'))

      expect(props.onOpen).toHaveBeenCalledWith(props.groups[0]!.sessions[0])
    })

    it('keeps an explicit open control named after its row', async () => {
      const { props } = renderTable()

      await userEvent.click(screen.getByRole('button', { name: 'Open zsh' }))

      expect(props.onOpen).toHaveBeenCalledWith(props.groups[0]!.sessions[0])
    })
  })

  describe('the row menu', () => {
    it('fires onAction for each item, and never opens the session', async () => {
      const user = userEvent.setup()
      const { props } = renderTable()
      const s = props.groups[0]!.sessions[0]!

      const pick = async (item: string) => {
        await user.click(screen.getByRole('button', { name: 'Actions for zsh' }))
        await user.click(screen.getByRole('menuitem', { name: item }))
      }

      await pick('Rename')
      expect(props.onAction).toHaveBeenLastCalledWith('rename', s)
      await pick('Edit tags')
      expect(props.onAction).toHaveBeenLastCalledWith('tags', s)
      await pick('Pin')
      expect(props.onAction).toHaveBeenLastCalledWith('pin', s)
      await pick('Close')
      expect(props.onAction).toHaveBeenLastCalledWith('close', s)

      expect(props.onOpen).not.toHaveBeenCalled()
    })

    it('offers unpin in place of pin for a pinned session', async () => {
      const user = userEvent.setup()
      const { props } = renderTable({
        groups: [group('machine:m1', 'MacBook Pro', [fs({ id: 'a1', pinned: true })])],
      })

      await user.click(screen.getByRole('button', { name: 'Actions for zsh' }))
      expect(screen.queryByRole('menuitem', { name: 'Pin' })).toBeNull()
      await user.click(screen.getByRole('menuitem', { name: 'Unpin' }))

      expect(props.onAction).toHaveBeenLastCalledWith('unpin', props.groups[0]!.sessions[0])
    })
  })

  describe('pinned', () => {
    it('stars a pinned session and only a pinned one', () => {
      renderTable({
        groups: [
          group('machine:m1', 'MacBook Pro', [
            fs({ id: 'a1', pinned: true }),
            fs({ id: 'b2', title: 'vim' }),
          ]),
        ],
      })
      expect(screen.getAllByRole('img', { name: 'Pinned' })).toHaveLength(1)
    })

    it('rules off the pinned rows in the ungrouped list', () => {
      const { container } = renderTable({
        groups: [
          group('all', 'All sessions', [
            fs({ id: 'p1', pinned: true }),
            fs({ id: 'p2', pinned: true, title: 'vim' }),
            fs({ id: 'u1', title: 'top' }),
          ]),
        ],
      })

      const rows = Array.from(container.querySelectorAll('tbody tr'))
      // Heading, two pinned rows, the rule, then the rest.
      expect(rows).toHaveLength(5)
      expect(rows[3]!.hasAttribute('data-divider')).toBe(true)
      // The rule is a rule, not a card edge: the same horizontal treatment
      // as every other row, just a step firmer.
      expect(rows[3]!.className).toMatch(/\bborder-b\b/)
    })

    it('draws no rule when the list is grouped, unpinned, or pinned throughout', () => {
      const grouped = renderTable({
        groups: [
          group('machine:m1', 'MacBook Pro', [
            fs({ id: 'p1', pinned: true }),
            fs({ id: 'u1', title: 'top' }),
          ]),
        ],
      })
      expect(grouped.container.querySelector('[data-divider]')).toBeNull()
      grouped.unmount()

      const unpinned = renderTable({
        groups: [group('all', 'All sessions', [fs({ id: 'u1' })])],
      })
      expect(unpinned.container.querySelector('[data-divider]')).toBeNull()
      unpinned.unmount()

      const allPinned = renderTable({
        groups: [group('all', 'All sessions', [fs({ id: 'p1', pinned: true })])],
      })
      expect(allPinned.container.querySelector('[data-divider]')).toBeNull()
    })
  })

  describe('spawning', () => {
    it('offers a spawn control per group only when given somewhere to send it', async () => {
      const bare = renderTable()
      expect(bare.queryByRole('button', { name: /New session on/ })).toBeNull()
      bare.unmount()

      const onSpawnIn = vi.fn()
      renderTable({ onSpawnIn })

      await userEvent.click(screen.getByRole('button', { name: 'New session on MacBook Pro' }))

      expect(onSpawnIn).toHaveBeenCalledWith('machine:m1')
    })
  })

  describe('empty state', () => {
    it('shows the terminal card when there are no groups at all', () => {
      const { container } = renderTable({ groups: [] })

      expect(screen.getByText(/No sessions yet/)).toBeTruthy()
      const prompt = screen.getByText('$').closest('p')!
      expect(prompt.textContent).toContain('flue open')
      expect(container.querySelector('[class*="animate-blink"]')).toBeTruthy()
    })
  })

  describe('dress', () => {
    it('uses sentence case headings, never uppercase', () => {
      renderTable()
      const heading = screen.getByRole('columnheader', { name: 'Directory' })
      expect(heading.className).not.toMatch(/\buppercase\b/)
    })

    it('does not draw the rows as cards', () => {
      // Sibling rows in a shared context take the lightest separation that
      // works. A card per row would claim each session is an independent
      // object when the set is one list, so: horizontal rules, no outer
      // border, no vertical rules, and the page background showing through.
      const { container } = renderTable({
        groups: [
          group('machine:m1', 'MacBook Pro', [fs({ id: 'a1' }), fs({ id: 'b2', title: 'vim' })]),
          group('all', 'All sessions', [fs({ id: 'p1', pinned: true }), fs({ id: 'u1' })]),
        ],
      })
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
})
