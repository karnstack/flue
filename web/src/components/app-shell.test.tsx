import { afterEach, describe, expect, it } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWithRouter } from '@/testing/render'
import { AppShell } from './app-shell'
import { NAV_ITEMS } from './nav'

/**
 * A location no nav item matches.
 *
 * TanStack's Link stamps `aria-current="page"` on itself whenever the router
 * is sitting on that link's route, so a shell rendered at /sessions would
 * show aria-current on Sessions even if the sidebar never set it. Rendering
 * from the terminal route removes the router's contribution, so what the
 * assertions see is the shell's own `currentPath` logic.
 */
const OFF_NAV = '/d/local/s/abc123'

/**
 * useIsMobile reads window.innerWidth, which jsdom fixes at 1024 — every test
 * below runs the desktop layout unless it moves this. jsdom exposes
 * innerWidth as a plain value property, so defineProperty is the supported
 * way to move it; the hook re-reads it on mount, so no resize event is
 * needed.
 */
const DESKTOP_WIDTH = window.innerWidth
function setViewportWidth(width: number) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: width })
}
afterEach(() => setViewportWidth(DESKTOP_WIDTH))

describe('AppShell', () => {
  it('renders its children', async () => {
    await renderWithRouter(
      <AppShell currentPath="/sessions">
        <p>route content</p>
      </AppShell>,
    )
    expect(screen.getByText('route content')).toBeTruthy()
  })

  it('lets the main region shrink below its content', async () => {
    // main is a flex child beside the sidebar. Without min-w-0 a wide child
    // (a session list row, a terminal) pushes the sidebar off instead of
    // scrolling or truncating.
    await renderWithRouter(
      <AppShell currentPath="/sessions">
        <p>route content</p>
      </AppShell>,
    )
    expect(screen.getByRole('main').className).toContain('min-w-0')
  })

  it('renders every nav item as a link', async () => {
    await renderWithRouter(
      <AppShell currentPath="/sessions">
        <p>route content</p>
      </AppShell>,
      OFF_NAV,
    )
    for (const item of NAV_ITEMS) {
      expect(screen.getByRole('link', { name: item.label })).toBeTruthy()
    }
  })

  it('marks exactly the current route with aria-current', async () => {
    await renderWithRouter(
      <AppShell currentPath="/settings">
        <p>route content</p>
      </AppShell>,
      OFF_NAV,
    )
    const marked = screen
      .getAllByRole('link')
      .filter((link) => link.getAttribute('aria-current') === 'page')
    expect(marked).toHaveLength(1)
    expect(marked[0]!.textContent).toContain('Settings')
  })

  it('never changes font weight between nav states', async () => {
    // Guideline: nav states differ by color and background only. A weight
    // change causes a layout shift and reads as a different element.
    await renderWithRouter(
      <AppShell currentPath="/sessions">
        <p>route content</p>
      </AppShell>,
      OFF_NAV,
    )
    const active = screen.getByRole('link', { name: 'Sessions' })
    const inactive = screen.getByRole('link', { name: 'Settings' })
    const weightClass = /font-(thin|light|normal|medium|semibold|bold|extrabold|black)/
    const activeWeight = active.className.match(weightClass)?.[0]
    const inactiveWeight = inactive.className.match(weightClass)?.[0]
    expect(activeWeight).toBeDefined()
    expect(activeWeight).toBe(inactiveWeight)
  })

  it('renders client-side router links, not full-reload anchors', async () => {
    // A plain <a href> would reload the page and drop the WebSocket. Two
    // signatures only a router-managed link has: TanStack stamps data-status
    // on whichever link matches the router's own location, and a click moves
    // the router rather than the document.
    const { router } = await renderWithRouter(
      <AppShell currentPath="/sessions">
        <p>route content</p>
      </AppShell>,
      '/sessions',
    )
    expect(screen.getByRole('link', { name: 'Sessions' }).getAttribute('data-status')).toBe(
      'active',
    )

    const settings = screen.getByRole('link', { name: 'Settings' })
    expect(settings.getAttribute('href')).toBe('/settings')
    await userEvent.click(settings)
    await waitFor(() => expect(router.state.location.pathname).toBe('/settings'))
  })

  it('hides the decorative nav icons from assistive technology', async () => {
    await renderWithRouter(
      <AppShell currentPath="/sessions">
        <p>route content</p>
      </AppShell>,
      OFF_NAV,
    )
    for (const item of NAV_ITEMS) {
      const link = screen.getByRole('link', { name: item.label })
      const icon = link.querySelector('svg')
      expect(icon).not.toBeNull()
      expect(icon!.getAttribute('aria-hidden')).toBe('true')
      // Heroicons Micro at the guideline size, and never allowed to squash
      // when the label wraps.
      expect(icon!.getAttribute('class')).toContain('size-4')
      expect(icon!.getAttribute('class')).toContain('shrink-0')
    }
  })

  it('keeps its own top band for mobile only', async () => {
    // Below md the band is the sheet's opener and the wordmark's home. From
    // md up it used to hold one small button over a screenful of nothing —
    // the trigger rides each screen's PageHeader there instead, so the band
    // stands down and the routes' own headers meet the top of the screen.
    const { container } = await renderWithRouter(
      <AppShell currentPath="/sessions">
        <p>route content</p>
      </AppShell>,
    )
    const band = container.querySelector('header')!
    expect(band).not.toBeNull()
    expect(band.className).toMatch(/\bmd:hidden\b/)
  })

  it('collapses and reopens the desktop sidebar from the header trigger', async () => {
    await renderWithRouter(
      <AppShell currentPath="/sessions">
        <p>route content</p>
      </AppShell>,
    )
    // The primitive styles the collapse entirely off this attribute
    // (offcanvas width transitions), so the attribute is the observable
    // behavior — jsdom applies none of the CSS that follows from it.
    const sidebar = document.querySelector('[data-slot="sidebar"]')
    expect(sidebar).not.toBeNull()
    expect(sidebar!.getAttribute('data-state')).toBe('expanded')

    await userEvent.click(screen.getByRole('button', { name: 'Toggle Sidebar' }))
    expect(sidebar!.getAttribute('data-state')).toBe('collapsed')

    await userEvent.click(screen.getByRole('button', { name: 'Toggle Sidebar' }))
    expect(sidebar!.getAttribute('data-state')).toBe('expanded')
  })

  it('moves the sidebar into a sheet on mobile and closes it when a link is activated', async () => {
    setViewportWidth(375)
    await renderWithRouter(
      <AppShell currentPath="/sessions">
        <p>route content</p>
      </AppShell>,
    )
    // Below the breakpoint the nav lives only inside the sheet, which is
    // closed until the trigger opens it.
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.queryByRole('link', { name: 'Settings' })).toBeNull()

    await userEvent.click(screen.getByRole('button', { name: 'Toggle Sidebar' }))
    const sheet = await screen.findByRole('dialog')

    await userEvent.click(within(sheet).getByRole('link', { name: 'Settings' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })
})
