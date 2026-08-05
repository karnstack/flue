import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  useRouterState,
} from '@tanstack/react-router'
import { AppShell } from '@/components/app-shell'
import { DevicesRoute } from '@/routes/devices'
import { SessionsRoute } from '@/routes/sessions'
import { TerminalRoute } from '@/routes/terminal'

const rootRoute = createRootRoute({ component: () => <Outlet /> })

/**
 * Pathless layout for management screens. The terminal deliberately sits
 * outside it: a session is the tab, so app chrome around it would defeat
 * the premise.
 */
const shellRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: 'shell',
  component: function ShellLayout() {
    const pathname = useRouterState({ select: (s) => s.location.pathname })
    // `/` renders the sessions screen, so the nav has to say Sessions there.
    // Without this the index route is the one screen with nothing selected.
    return (
      <AppShell currentPath={pathname === '/' ? '/sessions' : pathname}>
        <Outlet />
      </AppShell>
    )
  },
})

const indexRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/',
  component: SessionsRoute,
})

const sessionsRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/sessions',
  component: SessionsRoute,
})

/** Thin placeholder so the nav link resolves. Settings are a later build
 *  step; a Link to a route that does not exist is a type error and a dead
 *  link. */
function Placeholder({ title, blurb }: { title: string; blurb: string }) {
  return (
    <div className="p-4 sm:p-6 lg:p-8">
      <h1 className="text-2xl/8 font-semibold tracking-tight text-zinc-950 sm:text-xl/7 dark:text-white">
        {title}
      </h1>
      <p className="mt-2 max-w-[65ch] text-base/7 text-pretty text-zinc-600 sm:text-sm/6 dark:text-zinc-400">
        {blurb}
      </p>
    </div>
  )
}

const devicesRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/devices',
  component: DevicesRoute,
})

const settingsRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/settings',
  component: () => (
    <Placeholder
      title="Settings"
      blurb="Scrollback size, keyboard bindings, and themes arrive with the next build step."
    />
  ),
})

/**
 * The terminal's path, exported because it is also its route id and two
 * tests key on that.
 *
 * No `id` option alongside it: TanStack refuses a route that has both
 * ("Route cannot have both an 'id' and a 'path' option") and throws at module
 * evaluation, which would take the whole app down at import time. `id` is for
 * pathless layout routes — shellRoute below — and a route with a path is
 * identified by that path.
 */
export const TERMINAL_ROUTE_ID = '/d/$deviceId/s/$sessionId'

const terminalRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: TERMINAL_ROUTE_ID,
  component: TerminalRoute,
})

const routeTree = rootRoute.addChildren([
  shellRoute.addChildren([indexRoute, sessionsRoute, devicesRoute, settingsRoute]),
  terminalRoute,
])

export function createFlueRouter() {
  return createRouter({ routeTree, defaultPreload: false })
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof createFlueRouter>
  }
}
