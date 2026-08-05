import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  useRouterState,
} from '@tanstack/react-router'
import { AppShell } from '@/components/app-shell'
import { DevicesRoute } from '@/routes/devices'
import { PairRoute } from '@/routes/pair'
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

/**
 * The pairing page, beside the terminal and outside the shell for a related
 * reason: a device that reaches this route is not paired yet, and sidebar links
 * to sessions it cannot open would be chrome promising what the visitor does
 * not have. It is also the one route the daemon serves without a session token
 * — see `withProvenance` in internal/daemon/server.go — so the less of the app
 * it renders, the better.
 */
const pairRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/pair',
  /**
   * `t` is the pairing token the QR code carries. Narrowed to a non-empty
   * string or nothing at all, so a link that arrives with `?t` repeated (which
   * parses to an array) or with an empty value lands on the page's explainer
   * rather than posting something token-shaped at the daemon and spending the
   * user's window on it.
   */
  validateSearch: (search: Record<string, unknown>): { t?: string } =>
    typeof search.t === 'string' && search.t !== '' ? { t: search.t } : {},
  component: PairRoute,
})

const routeTree = rootRoute.addChildren([
  shellRoute.addChildren([indexRoute, sessionsRoute, devicesRoute, settingsRoute]),
  terminalRoute,
  pairRoute,
])

export function createFlueRouter() {
  return createRouter({ routeTree, defaultPreload: false })
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof createFlueRouter>
  }
}
