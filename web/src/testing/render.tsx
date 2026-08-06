import type { ReactNode } from 'react'
import { render } from '@testing-library/react'
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router'

/**
 * Render `ui` inside a minimal router. TanStack's Link throws without a
 * router in context, and the real routes pull in the whole app, so this
 * mirrors only the paths the app links to.
 *
 * The router is returned alongside the render result because it is the only
 * way to prove a click was handled client-side: jsdom does not navigate, so
 * a plain `<a href>` and a router Link are indistinguishable in the DOM after
 * the click — but only the Link moves `router.state.location`.
 */
export async function renderWithRouter(ui: ReactNode, initialPath = '/sessions') {
  const rootRoute = createRootRoute({ component: () => ui })
  // The terminal path is here so a test can put the router somewhere no nav
  // item matches. TanStack marks a Link active on its own whenever the router
  // is on that link's route, so a nav test run at /sessions cannot tell our
  // active-state logic from the router's.
  const paths = [
    '/',
    '/sessions',
    '/devices',
    '/remote',
    '/settings',
    '/d/$deviceId/s/$sessionId',
  ]
  const routeTree = rootRoute.addChildren(
    paths.map((path) =>
      createRoute({ getParentRoute: () => rootRoute, path, component: () => null }),
    ),
  )
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [initialPath] }),
  })
  // The first match resolves asynchronously, so a bare render() commits an
  // empty tree and every query in the test misses. Loading first is what
  // makes the render synchronous, which is why this helper is async.
  await router.load()
  return { router, ...render(<RouterProvider router={router as never} />) }
}
