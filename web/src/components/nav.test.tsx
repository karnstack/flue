import { describe, expect, it, vi } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWithRouter } from '@/testing/render'
import { isNavItemActive, Nav, NAV_ITEMS } from './nav'

/**
 * A location no nav item matches.
 *
 * TanStack's Link stamps `aria-current="page"` on itself whenever the router
 * is sitting on that link's route, so a nav rendered at /sessions would show
 * aria-current on Sessions even if this component never set it. Rendering the
 * nav from the terminal route removes the router's contribution, so what the
 * assertions see is this component's own `currentPath` logic.
 */
const OFF_NAV = '/d/local/s/abc123'

describe('NAV_ITEMS', () => {
  it('lists a label, a path, and an icon for every item', () => {
    expect(NAV_ITEMS.length).toBeGreaterThan(0)
    for (const item of NAV_ITEMS) {
      expect(item.to.startsWith('/')).toBe(true)
      expect(item.label.length).toBeGreaterThan(0)
      // Heroicons ship as forwardRef objects, not plain functions, so this
      // only asserts an icon is present; the render test below proves it
      // actually produces an svg.
      expect(item.icon).toBeTruthy()
    }
  })
})

describe('isNavItemActive', () => {
  it('matches the item exactly', () => {
    expect(isNavItemActive('/sessions', '/sessions')).toBe(true)
  })

  it('matches a path nested under the item', () => {
    expect(isNavItemActive('/settings/keyboard', '/settings')).toBe(true)
  })

  it('does not match a sibling that merely shares a prefix', () => {
    // startsWith alone would light up Settings on /settings-export.
    expect(isNavItemActive('/settings-export', '/settings')).toBe(false)
  })

  it('does not match an unrelated path', () => {
    expect(isNavItemActive('/d/local/s/abc123', '/sessions')).toBe(false)
  })
})

describe('Nav', () => {
  it('renders every nav item', async () => {
    await renderWithRouter(<Nav currentPath="/sessions" />, OFF_NAV)
    for (const item of NAV_ITEMS) {
      expect(screen.getByRole('link', { name: item.label })).toBeTruthy()
    }
  })

  it('marks the current route with aria-current', async () => {
    await renderWithRouter(<Nav currentPath="/sessions" />, OFF_NAV)
    const current = screen.getByRole('link', { name: 'Sessions' })
    expect(current.getAttribute('aria-current')).toBe('page')
    expect(screen.getByRole('link', { name: 'Settings' }).getAttribute('aria-current')).toBeNull()
  })

  it('marks exactly one item at a time', async () => {
    await renderWithRouter(<Nav currentPath="/settings" />, OFF_NAV)
    const marked = screen
      .getAllByRole('link')
      .filter((link) => link.getAttribute('aria-current') === 'page')
    expect(marked).toHaveLength(1)
    expect(marked[0]!.textContent).toContain('Settings')
  })

  it('never changes font weight between states', async () => {
    // Guideline: nav states differ by color and background only. A weight
    // change causes a layout shift and reads as a different element.
    await renderWithRouter(<Nav currentPath="/sessions" />, OFF_NAV)
    const active = screen.getByRole('link', { name: 'Sessions' })
    const inactive = screen.getByRole('link', { name: 'Settings' })
    const weightClass = /font-(thin|light|normal|medium|semibold|bold|extrabold|black)/
    const activeWeight = active.className.match(weightClass)?.[0]
    const inactiveWeight = inactive.className.match(weightClass)?.[0]
    expect(activeWeight).toBeDefined()
    expect(activeWeight).toBe(inactiveWeight)
  })

  it('calls onNavigate when a link is activated, so the mobile sheet can close', async () => {
    const onNavigate = vi.fn()
    await renderWithRouter(<Nav currentPath="/sessions" onNavigate={onNavigate} />)
    await userEvent.click(screen.getByRole('link', { name: 'Settings' }))
    expect(onNavigate).toHaveBeenCalled()
  })

  it('renders client-side router links, not full-reload anchors', async () => {
    // A plain <a href> would reload the page and drop the WebSocket. Two
    // signatures only a router-managed link has: TanStack stamps data-status
    // on whichever link matches the router's own location, and a click moves
    // the router rather than the document.
    const { router } = await renderWithRouter(<Nav currentPath="/sessions" />, '/sessions')
    expect(screen.getByRole('link', { name: 'Sessions' }).getAttribute('data-status')).toBe(
      'active',
    )

    const settings = screen.getByRole('link', { name: 'Settings' })
    expect(settings.getAttribute('href')).toBe('/settings')
    await userEvent.click(settings)
    await waitFor(() => expect(router.state.location.pathname).toBe('/settings'))
  })

  it('hides the decorative icons from assistive technology', async () => {
    await renderWithRouter(<Nav currentPath="/sessions" />, OFF_NAV)
    for (const link of screen.getAllByRole('link')) {
      const icon = link.querySelector('svg')
      expect(icon).not.toBeNull()
      expect(icon!.getAttribute('aria-hidden')).toBe('true')
      // Heroicons Micro at the guideline size, and never allowed to squash
      // when the label wraps.
      expect(icon!.getAttribute('class')).toContain('size-4')
      expect(icon!.getAttribute('class')).toContain('shrink-0')
    }
  })
})
