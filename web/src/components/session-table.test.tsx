import { fireEvent, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import type { FleetSession } from '@/fleet/types'
import { renderWithRouter } from '@/testing/render'
import { COLUMN_KEYS, SUBKEY_SEP, type Group } from '@/sessions/view'
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

/**
 * Mount with every callback spied and every prop defaulted but overridable.
 *
 * Under a real (memory) router now, not bare: each row is a TanStack Link to
 * its own session, and a Link throws without a router in context. The router
 * comes back with the render because it is also the only way to prove what a
 * click did — jsdom never navigates, so only `router.state.location` can say
 * whether the row opened.
 */
async function renderTable(over: Partial<Props> = {}) {
  const props: Props = {
    groups: [group('machine:m1', 'MacBook Pro', [fs({ id: 'a1' })])],
    columns: [...COLUMN_KEYS],
    selected: new Set<string>(),
    onToggleSelect: vi.fn(),
    onToggleGroup: vi.fn(),
    collapsed: new Set<string>(),
    onAction: vi.fn(),
    ...over,
  }
  const view = await renderWithRouter(<SessionTable {...props} />)
  return { ...view, props }
}

describe('SessionTable', () => {
  describe('groups', () => {
    it('heads each group with its label and a running/exited tally', async () => {
      await renderTable({
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

    it('says only what a tally has members for', async () => {
      await renderTable({
        groups: [group('machine:m1', 'MacBook Pro', [fs({ id: 'a1' })])],
      })
      expect(screen.getByText('1 running')).toBeTruthy()
      expect(screen.queryByText(/exited/)).toBeNull()
    })

    it('renders every group, in the order the view model decided', async () => {
      const { container } = await renderTable({
        groups: [
          group('machine:m1', 'MacBook Pro', [fs({ id: 'a1' })]),
          group('machine:m2', 'devbox', [fs({ id: 'b2', machineId: 'm2', machineName: 'devbox' })]),
        ],
      })
      const text = container.textContent!
      expect(text.indexOf('MacBook Pro')).toBeGreaterThan(-1)
      expect(text.indexOf('MacBook Pro')).toBeLessThan(text.indexOf('devbox'))
    })

    it('marks a machine heading as this machine or as a relay one', async () => {
      await renderTable({
        groups: [
          group('machine:m1', 'MacBook Pro', [fs({ id: 'a1' })]),
          group('machine:m2', 'devbox', [fs({ id: 'b2', machineId: 'm2', machineName: 'devbox' })]),
        ],
        columns: ['name'],
        machineMarks: { home: 'm1' },
      })
      expect(screen.getAllByLabelText('This machine').length).toBe(1)
      expect(screen.getAllByLabelText('Machine reached over the relay').length).toBe(1)
    })

    it('marks a machine subheading too, wherever the second cut puts it', async () => {
      const api = fs({ id: 'a1', tags: ['api'] })
      await renderTable({
        groups: [
          {
            ...group('tag:api', 'api', [api]),
            children: [group(`tag:api${SUBKEY_SEP}machine:m1`, 'MacBook Pro', [api])],
          },
        ],
        columns: ['name'],
        machineMarks: { home: 'm1' },
      })
      expect(screen.getAllByLabelText('This machine').length).toBe(1)
    })

    it('leaves a heading about anything but a machine unmarked', async () => {
      await renderTable({
        groups: [group('tag:api', 'api', [fs({ id: 'a1', tags: ['api'] })])],
        columns: ['name'],
        machineMarks: { home: 'm1' },
      })
      expect(screen.queryByLabelText('This machine')).toBeNull()
      expect(screen.queryByLabelText('Machine reached over the relay')).toBeNull()
    })

    it('keeps the fold control named after its group alone', async () => {
      // The mark stands beside the toggle, never inside it: the button's
      // accessible name is the heading's, and a glyph swallowed into it
      // would make every machine heading announce two facts as one name.
      await renderTable({ machineMarks: { home: 'm1' } })
      expect(screen.getByRole('button', { name: 'MacBook Pro' })).toBeTruthy()
    })

    it('folds a collapsed group down to its heading', async () => {
      await renderTable({ collapsed: new Set(['machine:m1']) })

      const toggle = screen.getByRole('button', { name: 'MacBook Pro' })
      expect(toggle.getAttribute('aria-expanded')).toBe('false')
      expect(screen.queryByText('zsh')).toBeNull()
    })

    it('renders the rows of a group exactly as given, never re-sorted', async () => {
      // The one ordering rule this component has is to have none: order is
      // decided by orderSessions, 30-second buckets and all, and a helpful
      // sort here would quietly undo it. These rows are deliberately out of
      // order by every key such a sort might reach for — name, directory,
      // recency, id — in either direction, so any comparison at all breaks
      // the expectation.
      await renderTable({
        groups: [
          group('machine:m1', 'MacBook Pro', [
            fs({ id: 'z9', title: 'zeta', cwd: '/b', lastActive: '2026-07-28T09:00:00Z' }),
            fs({ id: 'a1', title: 'alpha', cwd: '/a', lastActive: '2026-07-28T10:00:00Z' }),
            fs({ id: 'm5', title: 'mid', cwd: '/c', lastActive: '2026-07-28T08:00:00Z' }),
          ]),
        ],
      })

      const names = screen.getAllByRole('link').map((a) => a.getAttribute('aria-label'))
      expect(names).toEqual([
        'Open zeta in a new tab',
        'Open alpha in a new tab',
        'Open mid in a new tab',
      ])
    })

    it('asks for a toggle rather than deciding one', async () => {
      // Collapse state lives in the route; this component only reports the
      // click and renders whatever `collapsed` says next time.
      const { props } = await renderTable()

      await userEvent.click(screen.getByRole('button', { name: 'MacBook Pro' }))

      expect(props.onToggleGroup).toHaveBeenCalledWith('machine:m1')
      expect(
        screen.getByRole('button', { name: 'MacBook Pro' }).getAttribute('aria-expanded'),
      ).toBe('true')
    })
  })

  describe('groups cut twice', () => {
    const api = fs({ id: 'a1', title: 'api-shell', tags: ['api'] })
    const ops = fs({ id: 'b2', title: 'ops-shell', tags: ['ops'] })
    const nested: Group = {
      ...group('machine:m1', 'MacBook Pro', [api, ops]),
      children: [
        group(`machine:m1${SUBKEY_SEP}tag:api`, 'api', [api]),
        group(`machine:m1${SUBKEY_SEP}tag:ops`, 'ops', [ops]),
      ],
    }

    it('draws a subheading per child, with its own tally, under the parent', async () => {
      const { container } = await renderTable({ groups: [nested] })

      expect(screen.getByRole('button', { name: 'api' })).toBeTruthy()
      expect(screen.getByRole('button', { name: 'ops' })).toBeTruthy()
      const text = container.textContent!
      expect(text.indexOf('MacBook Pro')).toBeLessThan(text.indexOf('api'))
      expect(text.indexOf('api')).toBeLessThan(text.indexOf('ops'))
    })

    it('draws every row once, under its child and not again under the parent', async () => {
      // The parent carries the whole run for its tally; the table must not
      // print that run a second time above the subheadings.
      await renderTable({ groups: [nested] })
      expect(screen.getAllByRole('link', { name: /api-shell/ })).toHaveLength(1)
      expect(screen.getAllByRole('link', { name: /ops-shell/ })).toHaveLength(1)
    })

    it('tallies the parent over every row and the child over its own', async () => {
      await renderTable({ groups: [nested] })
      expect(screen.getByText('2 running')).toBeTruthy()
      expect(screen.getAllByText('1 running')).toHaveLength(2)
    })

    it('folds a child on its own key, leaving its siblings open', async () => {
      await renderTable({
        groups: [nested],
        collapsed: new Set([`machine:m1${SUBKEY_SEP}tag:api`]),
      })

      expect(screen.getByRole('button', { name: 'api' }).getAttribute('aria-expanded')).toBe(
        'false',
      )
      expect(screen.queryByRole('link', { name: /api-shell/ })).toBeNull()
      expect(screen.getByRole('link', { name: /ops-shell/ })).toBeTruthy()
    })

    it('folds the parent over every child', async () => {
      await renderTable({ groups: [nested], collapsed: new Set(['machine:m1']) })
      expect(screen.queryByRole('button', { name: 'api' })).toBeNull()
      expect(screen.queryByRole('link')).toBeNull()
    })

    it('reports a child toggle by the child’s key', async () => {
      const { props } = await renderTable({ groups: [nested] })
      await userEvent.click(screen.getByRole('button', { name: 'api' }))
      expect(props.onToggleGroup).toHaveBeenCalledWith(`machine:m1${SUBKEY_SEP}tag:api`)
    })

    it('offers a spawn control on a child, named for the child', async () => {
      const onSpawnIn = vi.fn()
      await renderTable({
        groups: [nested],
        onSpawnIn,
        spawnLabel: (g) => (g.children === undefined ? `New session tagged ${g.label}` : undefined),
      })

      expect(screen.queryByRole('button', { name: /on MacBook Pro/ })).toBeNull()
      await userEvent.click(screen.getByRole('button', { name: 'New session tagged api' }))
      expect(onSpawnIn).toHaveBeenCalledWith(nested.children![0])
    })

    it('wears a grip when only the children could take a drop', async () => {
      await renderTable({
        groups: [nested],
        drag: { droppable: (g) => g.children === undefined, onDrop: vi.fn() },
      })
      expect(screen.getAllByTitle('Drag to move to another group').length).toBeGreaterThan(0)
    })
  })

  describe('the fields a row carries', () => {
    it('draws no header row of field names at all', async () => {
      // The rows are one list, not a spreadsheet: what each piece is, its
      // rendering already says, and a band of labels over the first row
      // would spend the top of the screen restating it.
      const { container } = await renderTable()

      expect(screen.queryAllByRole('columnheader')).toEqual([])
      expect(container.querySelector('table, thead, th')).toBeNull()
    })

    it('drops the pieces of a column that is toggled off', async () => {
      await renderTable({ columns: ['name', 'state'] })

      expect(screen.queryByText('/Users/karn/code/flue')).toBeNull()
      expect(screen.queryByText('MacBook Pro', { selector: '[data-slot="badge"]' })).toBeNull()
      expect(screen.getByText('Running')).toBeTruthy()
    })

    it('keeps the name even when it is not asked for', async () => {
      // A row with no name is a row nothing identifies. The component treats
      // 'name' as always on, whatever the columns preference says.
      await renderTable({ columns: ['state'] })

      expect(screen.getByRole('link', { name: 'Open zsh in a new tab' })).toBeTruthy()
      expect(screen.getByText('zsh')).toBeTruthy()
    })

    it('ranges the details after the name in their fixed order', async () => {
      // Membership is the caller's; order is COLUMN_KEYS's. A preference list
      // that says ['lastActive', 'tags'] must not put the stamp before the
      // badges.
      const { container } = await renderTable({
        groups: [
          group('machine:m1', 'MacBook Pro', [fs({ id: 'a1', tags: ['api'] })]),
        ],
        columns: ['lastActive', 'directory', 'tags', 'name'],
      })

      const row = container.querySelector('li')!.textContent!
      expect(row.indexOf('zsh')).toBeLessThan(row.indexOf('api'))
      expect(row.indexOf('api')).toBeLessThan(row.indexOf('/Users/karn/code/flue'))
      expect(row.indexOf('/Users/karn/code/flue')).toBeLessThan(row.indexOf('ago'))
    })
  })

  describe('rows', () => {
    it('shows the display name with the command beside it', async () => {
      await renderTable({
        groups: [
          group('machine:m1', 'MacBook Pro', [
            fs({ id: 'a1', title: 'build', cmd: ['pnpm', 'build'] }),
          ]),
        ],
      })
      expect(screen.getByText('build')).toBeTruthy()
      expect(screen.getByText('pnpm build')).toBeTruthy()
    })

    it('distinguishes running from exited', async () => {
      // A live session says "Running" to assistive technology through its
      // dot; an ended one writes "Exited n" among the row's details, where
      // the code is on screen rather than in a tooltip.
      await renderTable({
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

    it('names the machine a row runs on', async () => {
      await renderTable({
        groups: [group('tag:api', 'api', [fs({ id: 'a1', tags: ['api'] })])],
      })
      expect(screen.getByText('MacBook Pro')).toBeTruthy()
    })

    it('marks a row on the machine this browser is running on', async () => {
      // The house half of the pair: the name alone answers "which machine",
      // and this answers "is that the one in front of me" — the question a
      // hostname nobody has memorised cannot.
      await renderTable({
        groups: [group('tag:api', 'api', [fs({ id: 'a1', tags: ['api'] })])],
        machineMarks: { home: 'm1' },
      })
      expect(screen.getAllByLabelText('This machine').length).toBe(1)
      expect(screen.queryByLabelText('Machine reached over the relay')).toBeNull()
    })

    it('marks a row on any other machine as reached over the relay', async () => {
      await renderTable({
        groups: [
          group('tag:api', 'api', [
            fs({ id: 'a1', tags: ['api'] }),
            fs({ id: 'b2', tags: ['api'], machineId: 'm2', machineName: 'devbox' }),
          ]),
        ],
        machineMarks: { home: 'm1' },
      })
      expect(screen.getAllByLabelText('This machine').length).toBe(1)
      expect(screen.getAllByLabelText('Machine reached over the relay').length).toBe(1)
    })

    it('calls every machine remote when no machine is the one in front of the reader', async () => {
      // A phone on a relay origin: it reaches all of them the long way round,
      // and a house on any of them would name a box in another room.
      await renderTable({
        groups: [
          group('tag:api', 'api', [
            fs({ id: 'a1', tags: ['api'] }),
            fs({ id: 'b2', tags: ['api'], machineId: 'm2', machineName: 'devbox' }),
          ]),
        ],
        machineMarks: { home: null },
      })
      expect(screen.queryByLabelText('This machine')).toBeNull()
      expect(screen.getAllByLabelText('Machine reached over the relay').length).toBe(2)
    })

    it('draws no marks at all when the caller offers none', async () => {
      // One machine on the fleet: there is nothing to tell apart, and a badge
      // wearing a glyph about it would be chrome answering a question nobody
      // asked.
      await renderTable({ groups: [group('tag:api', 'api', [fs({ id: 'a1', tags: ['api'] })])] })
      expect(screen.queryByLabelText('This machine')).toBeNull()
      expect(screen.queryByLabelText('Machine reached over the relay')).toBeNull()
      expect(screen.getByText('MacBook Pro')).toBeTruthy()
    })

    it('shows the tags as badges', async () => {
      await renderTable({
        groups: [group('machine:m1', 'MacBook Pro', [fs({ id: 'a1', tags: ['api', 'prod'] })])],
      })
      expect(screen.getByText('api')).toBeTruthy()
      expect(screen.getByText('prod')).toBeTruthy()
    })

    it('cuts a long directory in the middle, keeping both ends', async () => {
      // CSS ellipsis is end-only, and the end of a path is the half that
      // tells its sessions apart — so the cut is made in JS, in the middle.
      const cwd = '/Users/karn/code/karnstack/flue/web/src/components'
      await renderTable({
        groups: [group('machine:m1', 'MacBook Pro', [fs({ id: 'a1', cwd })])],
      })

      expect(screen.getByText('/Users/karn/cod…lue/web/src/components')).toBeTruthy()
      expect(screen.getByTitle(cwd)).toBeTruthy()
    })

    it('leaves a short directory whole', async () => {
      await renderTable()
      expect(screen.getByText('/Users/karn/code/flue')).toBeTruthy()
    })

    it('tells time relatively in the last active and created details', async () => {
      const now = Date.now()
      await renderTable({
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

    it('answers a hover with a soft rounded tint, not a card', async () => {
      // Linear's list grammar: rows rest on the page background with nothing
      // drawn between them, and the pointer's row answers with a rounded
      // wash. No box per row, no rules between siblings.
      const { container } = await renderTable()
      const row = container.querySelector('li')!
      expect(row.className).toMatch(/\brounded-md\b/)
      expect(row.className).toMatch(/\bhover:bg-/)
      expect(row.className).not.toMatch(/\bborder\b|\bborder-b\b|\bshadow/)
    })

    it('stacks every self-answering piece above the row link', async () => {
      // The link stretches over the row by its ::after box, and a browser
      // hit-tests that overlay first: anything that takes its own pointer —
      // the checkbox, the ⋯ trigger — or carries its own title tooltip has
      // to stand above it on z-10, or the anchor swallows the hover and the
      // click. jsdom does no hit-testing, so the class is the observable
      // contract here, exactly as the hover tint is pinned by its class.
      const { container } = await renderTable({
        groups: [
          group('machine:m1', 'MacBook Pro', [
            fs({ id: 'a1', tags: ['a', 'b', 'c', 'd'], state: 'exited', exitCode: 1 }),
          ]),
        ],
      })

      expect(screen.getByRole('checkbox', { name: 'Select zsh' }).className).toMatch(/\bz-10\b/)
      expect(screen.getByRole('button', { name: 'Actions for zsh' }).className).toMatch(
        /\bz-10\b/,
      )

      // The state dot, the directory, both stamps, and the folded tags: each
      // one promises a tooltip, so each one must be reachable by a hover.
      const titled = Array.from(container.querySelectorAll('li [title]'))
      expect(titled.length).toBeGreaterThanOrEqual(4)
      for (const el of titled) expect(el.className).toMatch(/\bz-10\b/)
    })

    it('caps the tag badges and folds the remainder into a +n', async () => {
      // A row is one line: the old layout could sideways-scroll a wide row,
      // this one must never push the pane. The folded names stay reachable
      // through the +n badge's tooltip.
      await renderTable({
        groups: [
          group('machine:m1', 'MacBook Pro', [
            fs({ id: 'a1', tags: ['api', 'edge', 'ops', 'prod', 'staging'] }),
          ]),
        ],
      })

      expect(screen.getByText('api')).toBeTruthy()
      expect(screen.getByText('edge')).toBeTruthy()
      expect(screen.getByText('ops')).toBeTruthy()
      expect(screen.queryByText('prod')).toBeNull()
      expect(screen.getByText('+2').getAttribute('title')).toBe('prod, staging')
    })

    it('keeps the machine chip at every width, shedding the directory first', async () => {
      // The headline use of this screen is a phone reading a desktop's
      // fleet, and on that phone "which machine" outranks "which directory".
      await renderTable()

      const chip = screen.getByText('MacBook Pro', { selector: '[data-slot="badge"]' })
      expect(chip.className).not.toMatch(/:hidden\b/)
      expect(screen.getByTitle('/Users/karn/code/flue').className).toMatch(/\bmax-md:hidden\b/)
    })
  })

  describe('selection', () => {
    it('toggles by the composite key, and does not open the session', async () => {
      const { props, router } = await renderTable()

      await userEvent.click(screen.getByRole('checkbox', { name: 'Select zsh' }))

      expect(props.onToggleSelect).toHaveBeenCalledWith('m1/a1')
      expect(router.state.location.pathname).toBe('/sessions')
    })

    it('shows a session selected under every heading it appears in', async () => {
      // A session tagged twice is the same object in two groups, and the
      // selection key repeats with it — one key, two checked boxes.
      const twice = fs({ id: 'a1', tags: ['api', 'ops'] })
      await renderTable({
        groups: [group('tag:api', 'api', [twice]), group('tag:ops', 'ops', [twice])],
        selected: new Set(['m1/a1']),
      })

      const boxes = screen.getAllByRole('checkbox', { name: 'Select zsh' })
      expect(boxes).toHaveLength(2)
      for (const box of boxes) expect(box.getAttribute('aria-checked')).toBe('true')
    })
  })

  describe('opening', () => {
    it('makes the whole row one link to its session, in a tab of its own', async () => {
      await renderTable()

      const link = screen.getByRole('link', { name: 'Open zsh in a new tab' })
      // A real href on a real anchor: this is what a middle click, a copied
      // address and a Ctrl/Cmd click all read.
      expect(link.getAttribute('href')).toBe('/d/m1/s/a1')
      expect(link.getAttribute('target')).toBe('_blank')
      expect(link.getAttribute('rel')).toBe('noopener')
    })

    it('leaves the click to the browser, which owns the new tab', async () => {
      // A target the router honours by standing aside — TanStack's Link hands
      // any click with a target other than _self straight to the browser — so
      // the location holds still here while a real browser opens the terminal
      // beside this list. Ctrl, Cmd and middle clicks were already the
      // browser's, and stay that way.
      const { router } = await renderTable()
      const link = screen.getByRole('link', { name: 'Open zsh in a new tab' })

      await userEvent.click(link)
      expect(router.state.location.pathname).toBe('/sessions')

      fireEvent.click(link, { ctrlKey: true })
      expect(router.state.location.pathname).toBe('/sessions')

      fireEvent.click(link, { metaKey: true })
      expect(router.state.location.pathname).toBe('/sessions')

      fireEvent.click(link, { button: 1 })
      expect(router.state.location.pathname).toBe('/sessions')
    })

    it('offers no Open button: the row itself is the affordance', async () => {
      await renderTable()
      expect(screen.queryByRole('button', { name: /^Open / })).toBeNull()
    })
  })

  describe('the row menu', () => {
    it('fires onAction for each item, and never opens the session', async () => {
      const user = userEvent.setup()
      const { props, router } = await renderTable()
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

      expect(router.state.location.pathname).toBe('/sessions')
    })

    it('offers unpin in place of pin for a pinned session', async () => {
      const user = userEvent.setup()
      const { props } = await renderTable({
        groups: [group('machine:m1', 'MacBook Pro', [fs({ id: 'a1', pinned: true })])],
      })

      await user.click(screen.getByRole('button', { name: 'Actions for zsh' }))
      expect(screen.queryByRole('menuitem', { name: 'Pin' })).toBeNull()
      await user.click(screen.getByRole('menuitem', { name: 'Unpin' }))

      expect(props.onAction).toHaveBeenLastCalledWith('unpin', props.groups[0]!.sessions[0])
    })
  })

  describe('pinned', () => {
    it('stars a pinned session and only a pinned one', async () => {
      await renderTable({
        groups: [
          group('machine:m1', 'MacBook Pro', [
            fs({ id: 'a1', pinned: true }),
            fs({ id: 'b2', title: 'vim' }),
          ]),
        ],
      })
      expect(screen.getAllByRole('img', { name: 'Pinned' })).toHaveLength(1)
    })

    it('rules off the pinned rows in the ungrouped list', async () => {
      const { container } = await renderTable({
        groups: [
          group('all', 'All sessions', [
            fs({ id: 'p1', pinned: true }),
            fs({ id: 'p2', pinned: true, title: 'vim' }),
            fs({ id: 'u1', title: 'top' }),
          ]),
        ],
      })

      const items = Array.from(container.querySelectorAll('li'))
      // Two pinned rows, the rule, then the rest.
      expect(items).toHaveLength(4)
      expect(items[2]!.hasAttribute('data-divider')).toBe(true)
      expect(items[2]!.className).toMatch(/\bborder-b\b/)
    })

    it('draws no rule when the list is grouped, unpinned, or pinned throughout', async () => {
      const grouped = await renderTable({
        groups: [
          group('machine:m1', 'MacBook Pro', [
            fs({ id: 'p1', pinned: true }),
            fs({ id: 'u1', title: 'top' }),
          ]),
        ],
      })
      expect(grouped.container.querySelector('[data-divider]')).toBeNull()
      grouped.unmount()

      const unpinned = await renderTable({
        groups: [group('all', 'All sessions', [fs({ id: 'u1' })])],
      })
      expect(unpinned.container.querySelector('[data-divider]')).toBeNull()
      unpinned.unmount()

      const allPinned = await renderTable({
        groups: [group('all', 'All sessions', [fs({ id: 'p1', pinned: true })])],
      })
      expect(allPinned.container.querySelector('[data-divider]')).toBeNull()
    })
  })

  describe('spawning', () => {
    it('offers a spawn control per group only when given somewhere to send it', async () => {
      const bare = await renderTable()
      expect(bare.queryByRole('button', { name: /New session on/ })).toBeNull()
      bare.unmount()

      const onSpawnIn = vi.fn()
      const spawnLabel = (g: Group) => `New session on ${g.label}`
      const { props } = await renderTable({ onSpawnIn, spawnLabel })

      await userEvent.click(screen.getByRole('button', { name: 'New session on MacBook Pro' }))

      // The whole group, not its key: what a `+` inherits depends on the
      // grouping, which only the caller knows — see spawnFromGroup.
      expect(onSpawnIn).toHaveBeenCalledWith(props.groups[0])
    })

    it('hides the spawn control for a group whose label answers undefined', async () => {
      // How "Exited" says it has no `+`: the caller refuses to name one, and
      // the band must not draw a control whose click the caller would refuse.
      const { container } = await renderTable({
        groups: [group('state:exited', 'Exited', [fs({ id: 'a1', state: 'exited' })])],
        onSpawnIn: vi.fn(),
        spawnLabel: () => undefined,
      })

      // Counted rather than queried by name, and that is the whole point of
      // the case: a `+` rendered without an accessible name is invisible to
      // every by-name query, so an assertion phrased as one passes while the
      // button sits there taking clicks.
      const band = container.querySelector('[class*="group/band"]')!
      expect(band.querySelectorAll('button')).toHaveLength(1)
      expect(band.querySelector('button')!.textContent).toContain('Exited')
    })
  })

  describe('dragging', () => {
    // What a drag *does* is dropOnGroup's, pinned in sessions/view.test.ts;
    // jsdom draws no layout, so the gesture itself — sensors, collision,
    // release — cannot be honestly simulated here. What this component owes
    // and can prove is the wiring around the gesture.

    it('leaves the native anchor drag alone until a drag contract arrives', async () => {
      const bare = await renderTable()
      expect(
        bare.getByRole('link', { name: 'Open zsh in a new tab' }).getAttribute('draggable'),
      ).toBeNull()
      bare.unmount()

      // With one: the browser's own href-drag would race the sensor for
      // every gesture starting on the link's stretched overlay, which is
      // most of the row — so it stands down.
      await renderTable({ drag: { droppable: () => true, onDrop: vi.fn() } })
      const link = screen.getByRole('link', { name: 'Open zsh in a new tab' })
      expect(link.getAttribute('draggable')).toBe('false')
      // And the row is still, above all, the link it always was.
      expect(link.getAttribute('href')).toBe('/d/m1/s/a1')
    })

    it('wears a grip only where a drop could actually land', async () => {
      // The grip is an advertisement, not the handle it looks like — the
      // gesture works from the whole row. It renders when some heading on
      // screen would take the drop, and stays away both from lists that
      // cannot drag and from groupings whose every heading refuses, where it
      // would promise a move that only ever says no.
      const bare = await renderTable()
      expect(bare.queryByTitle('Drag to move to another group')).toBeNull()
      bare.unmount()

      const refused = await renderTable({
        drag: { droppable: () => false, onDrop: vi.fn() },
      })
      expect(refused.queryByTitle('Drag to move to another group')).toBeNull()
      refused.unmount()

      await renderTable({ drag: { droppable: () => true, onDrop: vi.fn() } })
      expect(screen.getByTitle('Drag to move to another group')).toBeTruthy()
    })

    it('claims the long press only while dragging is on offer', async () => {
      // select-none and the callout suppression are what let a finger hold a
      // row without iOS answering with selection or the link preview — and
      // they cost real behaviour (copying a path), so they must not leak
      // into lists that cannot drag.
      const bare = await renderTable()
      expect(bare.container.querySelector('li')!.className).not.toMatch(/select-none/)
      bare.unmount()

      const { container } = await renderTable({
        drag: { droppable: () => true, onDrop: vi.fn() },
      })
      expect(container.querySelector('li')!.className).toMatch(/select-none/)
    })
  })

  describe('empty state', () => {
    it('shows the terminal card when there are no groups at all', async () => {
      const { container } = await renderTable({ groups: [] })

      expect(screen.getByText(/No sessions yet/)).toBeTruthy()
      const prompt = screen.getByText('$').closest('p')!
      expect(prompt.textContent).toContain('flue open')
      expect(container.querySelector('[class*="animate-blink"]')).toBeTruthy()
    })
  })
})
