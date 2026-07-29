import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { RouterProvider } from '@tanstack/react-router'
import { createFlueRouter, TERMINAL_ROUTE_ID } from './router'

function routeIds(path: string): string[] {
  return createFlueRouter()
    .matchRoutes(path, {})
    .map((m) => m.routeId)
}

/**
 * Mount the real router at `path`.
 *
 * createFlueRouter deliberately takes no history argument — it is the app's
 * router, not a test fixture — so the location is set on jsdom's own history
 * before the router reads it.
 */
async function renderAt(path: string) {
  window.history.replaceState(null, '', path)
  const router = createFlueRouter()
  await router.load()
  return render(<RouterProvider router={router} />)
}

describe('createFlueRouter', () => {
  it('matches the sessions route', () => {
    const router = createFlueRouter()
    const match = router.matchRoutes('/sessions', {})
    expect(match.some((m) => m.routeId.includes('sessions'))).toBe(true)
  })

  it('matches a session terminal route and extracts its params', () => {
    const router = createFlueRouter()
    const match = router.matchRoutes('/d/local/s/abc123', {})
    const terminal = match.find((m) => m.routeId === TERMINAL_ROUTE_ID)
    expect(terminal).toBeDefined()
    expect(terminal!.params).toMatchObject({ deviceId: 'local', sessionId: 'abc123' })
  })

  it('matches the index route', () => {
    const router = createFlueRouter()
    const match = router.matchRoutes('/', {})
    expect(match.length).toBeGreaterThan(0)
  })

  it('renders management routes inside the app shell', () => {
    for (const path of ['/', '/sessions', '/devices', '/settings']) {
      expect(routeIds(path).some((id) => id.includes('shell'))).toBe(true)
    }
  })

  it('renders the terminal outside the app shell', () => {
    // The one layout decision this router exists to encode: a terminal
    // session *is* the tab, so it must not be wrapped in sidebar chrome. That
    // is why the shell is a pathless layout route rather than the whole tree.
    const ids = routeIds('/d/local/s/abc123')
    expect(ids).toContain(TERMINAL_ROUTE_ID)
    expect(ids.some((id) => id.includes('shell'))).toBe(false)
  })

  it('wraps a management route in the app shell when it renders', async () => {
    await renderAt('/sessions')
    expect(screen.getByRole('complementary')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Sessions' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Sessions' })).toBeTruthy()
  })

  it('renders the terminal with no app chrome around it at all', async () => {
    // The route-tree assertions above prove the shape; this proves the
    // consequence. A terminal session *is* the tab, so there must be no
    // sidebar, no header and no nav on screen — not merely a different
    // parent route.
    await renderAt('/d/local/s/abc123')
    expect(screen.queryByRole('complementary')).toBeNull()
    expect(screen.queryByRole('banner')).toBeNull()
    expect(screen.queryByRole('navigation')).toBeNull()
    expect(screen.queryAllByRole('link')).toHaveLength(0)
  })

  it('marks Sessions as the current item on the index route', async () => {
    // `/` renders the sessions screen, so leaving nothing selected there
    // would be the one screen where the nav disagrees with the content.
    await renderAt('/')
    expect(screen.getByRole('link', { name: 'Sessions' }).getAttribute('aria-current')).toBe('page')
  })

  it('matches every path the nav links to', async () => {
    const { NAV_ITEMS } = await import('./components/nav')
    for (const item of NAV_ITEMS) {
      // A nav link to a path with no route is a dead link that silently
      // renders the not-found tree. matchRoutes always returns the root
      // match, so a real hit is more than one.
      expect(routeIds(item.to).length).toBeGreaterThan(1)
    }
  })
})
