import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { PaneTree } from '@/sessions/pane-tree'
import { SessionGroup } from './session-group'

type Props = Parameters<typeof SessionGroup>[0]

/**
 * useIsMobile reads window.innerWidth once at mount and then listens to a
 * media query; jsdom's default width is desktop-shaped, so mobile is opted
 * into per test by shrinking the window before render.
 */
function setWidth(px: number) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: px })
}

const AB_ROW: PaneTree = { split: 'row', ratio: 0.5, a: { leaf: 'a' }, b: { leaf: 'b' } }

function renderGroup(over: Partial<Props> = {}) {
  const props: Props = {
    tabs: [AB_ROW],
    panes: [
      { id: 'a', label: 'api server' },
      { id: 'b', label: 'logs' },
    ],
    onRatio: vi.fn(),
    active: 'a',
    onActivate: vi.fn(),
    renderPane: (id, inset, fit) => (
      <output data-inset={inset} data-fit={fit}>
        pane:{id}
      </output>
    ),
    ...over,
  }
  const view = render(<SessionGroup {...props} />)
  return { ...view, props }
}

afterEach(() => {
  setWidth(1024)
  localStorage.clear()
})

describe('SessionGroup', () => {
  it('renders a group of one as nothing but the pane — the degenerate case', () => {
    renderGroup({ panes: [{ id: 'solo', label: '' }], tabs: [{ leaf: 'solo' }] })
    expect(screen.getByText('pane:solo')).toBeTruthy()
    expect(screen.queryByRole('tablist')).toBeNull()
    expect(screen.queryByRole('separator')).toBeNull()
    expect(screen.getByText('pane:solo').dataset.inset).toBe('0')
  })

  it('renders one tab of splits with a divider and no strip on a desktop', () => {
    setWidth(1280)
    renderGroup()
    expect(screen.getByText('pane:a')).toBeTruthy()
    expect(screen.getByText('pane:b')).toBeTruthy()
    expect(screen.getByRole('separator').getAttribute('aria-orientation')).toBe('vertical')
    expect(screen.queryByRole('tablist')).toBeNull()
    // Split panes must not pin themselves to the visual viewport — the
    // pinning slots are single-occupancy, and siblings would steal them
    // from each other. See renderPane's `fit` on the props.
    expect(screen.getByText('pane:a').dataset.fit).toBe('false')
    expect(screen.getByText('pane:b').dataset.fit).toBe('false')
  })

  it('renders a stacked split with a horizontal divider', () => {
    setWidth(1280)
    renderGroup({ tabs: [{ split: 'column', ratio: 0.5, a: { leaf: 'a' }, b: { leaf: 'b' } }] })
    expect(screen.getByRole('separator').getAttribute('aria-orientation')).toBe('horizontal')
  })

  it('renders a nested tree — a column stacked inside one side of a row', () => {
    setWidth(1280)
    renderGroup({
      panes: [
        { id: 'a', label: '' },
        { id: 'b', label: '' },
        { id: 'c', label: '' },
      ],
      tabs: [
        {
          split: 'row',
          ratio: 0.5,
          a: { leaf: 'a' },
          b: { split: 'column', ratio: 0.5, a: { leaf: 'b' }, b: { leaf: 'c' } },
        },
      ],
    })
    expect(screen.getByText('pane:a')).toBeTruthy()
    expect(screen.getByText('pane:b')).toBeTruthy()
    expect(screen.getByText('pane:c')).toBeTruthy()
    const separators = screen.getAllByRole('separator')
    expect(separators.map((s) => s.getAttribute('aria-orientation')).sort()).toEqual([
      'horizontal',
      'vertical',
    ])
  })

  it('renders a strip when there is more than one tab, splits inside the active one', () => {
    setWidth(1280)
    renderGroup({
      panes: [
        { id: 'a', label: 'api server' },
        { id: 'b', label: 'logs' },
        { id: 'c', label: 'scratchpad' },
      ],
      tabs: [AB_ROW, { leaf: 'c' }],
      active: 'a',
    })
    expect(screen.getByRole('tablist')).toBeTruthy()
    // The active tab holds the split pair; the other tab's pane stays
    // unmounted. The multi-pane tab's label carries its pane count.
    expect(screen.getByText('pane:a')).toBeTruthy()
    expect(screen.getByText('pane:b')).toBeTruthy()
    expect(screen.queryByText('pane:c')).toBeNull()
    expect(screen.getByRole('tab', { name: 'api server · 2' })).toBeTruthy()
    expect(screen.getByRole('tab', { name: 'scratchpad' })).toBeTruthy()
  })

  it('shows the tab holding the active pane, and a lone tab pane pins under the strip', () => {
    setWidth(1280)
    renderGroup({
      panes: [
        { id: 'a', label: '' },
        { id: 'b', label: '' },
        { id: 'c', label: '' },
      ],
      tabs: [AB_ROW, { leaf: 'c' }],
      active: 'c',
    })
    expect(screen.getByText('pane:c')).toBeTruthy()
    expect(screen.queryByText('pane:a')).toBeNull()
    // Alone under the strip, the pane is the page again: it pins, inset by
    // the strip's height.
    expect(screen.getByText('pane:c').dataset.fit).toBe('true')
    expect(screen.getByText('pane:c').dataset.inset).not.toBe('0')
  })

  it('offers the strip + when a new-tab handler is given', async () => {
    setWidth(1280)
    const onNewTab = vi.fn()
    renderGroup({ tabs: [AB_ROW, { leaf: 'c' }], panes: [
      { id: 'a', label: '' },
      { id: 'b', label: '' },
      { id: 'c', label: '' },
    ], onNewTab })
    await userEvent.click(screen.getByRole('button', { name: 'New tab in this group' }))
    expect(onNewTab).toHaveBeenCalled()
  })

  it('renders a flat tab strip and one pane on show on a phone, whatever the trees say', () => {
    setWidth(390)
    renderGroup()
    expect(screen.getByRole('tablist')).toBeTruthy()
    expect(screen.getByText('pane:a')).toBeTruthy()
    expect(screen.queryByText('pane:b')).toBeNull()
    expect(screen.queryByRole('separator')).toBeNull()
    // The pane is told about the strip above it, for the viewport pinning.
    expect(screen.getByText('pane:a').dataset.inset).not.toBe('0')
  })

  it('reports a tab pick and marks the shown tab selected', async () => {
    setWidth(390)
    const { props } = renderGroup()
    expect(screen.getByRole('tab', { name: 'api server' }).getAttribute('aria-selected')).toBe(
      'true',
    )
    await userEvent.click(screen.getByRole('tab', { name: 'logs' }))
    expect(props.onActivate).toHaveBeenCalledWith('b')
  })

  it('falls back to the first pane when the active id has gone', () => {
    setWidth(390)
    renderGroup({ active: 'gone' })
    expect(screen.getByText('pane:a')).toBeTruthy()
    expect(screen.getByRole('tab', { name: 'api server' }).getAttribute('aria-selected')).toBe(
      'true',
    )
  })

  it('names an unnamed pane by its position', () => {
    setWidth(390)
    renderGroup({
      panes: [
        { id: 'a', label: '' },
        { id: 'b', label: '' },
      ],
    })
    expect(screen.getByRole('tab', { name: 'Terminal 1' })).toBeTruthy()
    expect(screen.getByRole('tab', { name: 'Terminal 2' })).toBeTruthy()
  })
})
