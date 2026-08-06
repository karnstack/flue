import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  Outlet,
  useRouterState,
} from '@tanstack/react-router'
import type { FlueClient } from '@/client/client'
import { FlueClientProvider } from '@/client/provider'
import { AppShell } from '@/components/app-shell'
import { DevicesRoute } from '@/routes/devices'
import { PairRoute } from '@/routes/pair'
import { SessionsRoute } from '@/routes/sessions'
import { TerminalRoute } from '@/routes/terminal'
import { UnpairedRoute } from '@/routes/unpaired'

/** The pairing page's path. Its own constant because two routing decisions
 *  turn on it: the route below, and whether the tab opens a socket at all. */
const PAIR_PATH = '/pair'

/**
 * What the entry point has worked out about this page before the router exists,
 * handed to the route tree as router context.
 *
 * Both fields describe the same one thing — how, and whether, this tab can
 * reach a daemon — and only src/main.tsx is in a position to answer it: the
 * answer depends on the origin that served the page and on a key store that has
 * to be awaited. Everything left empty is the daemon's own origin, which is the
 * app as it has always been.
 */
export interface FlueRouterOptions {
  /**
   * The tab's client, when the entry point has already built one. It does that
   * on a relay origin, where the socket has to carry a Noise channel keyed to
   * the daemon this browser pinned; on loopback this is absent and the provider
   * below builds the plain /ws client for itself.
   */
  client?: FlueClient
  /**
   * True when this page came from a relay and this browser holds no key for any
   * daemon. Every screen but /pair is then an explainer, because there is no
   * handshake for any of them to attempt.
   */
  unpaired?: boolean
}

/**
 * The tab's one client, the one route that must not have it, and the case where
 * there is no client to be had.
 *
 * The provider is here rather than above the router in main.tsx for a single
 * reason: /pair is served to a device that holds no session token — getting one
 * is the entire purpose of the page — so the socket it would open is answered
 * with 401, and the client's backoff then retries it for as long as the tab is
 * open. That is a WARN in the daemon's audit log every few seconds and a phone
 * radio kept awake, in exchange for a socket the page never reads: /pair speaks
 * to the daemon with one fetch and nothing else.
 *
 * The root route is where it goes because the root match outlives every
 * navigation, so this is still exactly one client per tab and one socket for
 * sessions, the terminal and Devices alike. Only crossing in or out of /pair
 * changes which branch renders, and nothing in the app links there.
 *
 * `unpaired` is answered here rather than per route for the same reason the
 * provider is: it is one fact about the whole tab. It sits below the /pair
 * branch deliberately — that page is the only way out of the state, and a flag
 * that swallowed it would leave the user with an explainer pointing at a screen
 * the app refuses to render. The URL is left alone rather than redirected, so
 * the moment a pairing lands, a reload of the same address is the app.
 */
const rootRoute = createRootRouteWithContext<FlueRouterOptions>()({
  component: function Root() {
    const pathname = useRouterState({ select: (s) => s.location.pathname })
    const { client, unpaired } = rootRoute.useRouteContext()
    if (pathname === PAIR_PATH) return <Outlet />
    if (unpaired === true) return <UnpairedRoute />
    return (
      <FlueClientProvider client={client}>
        <Outlet />
      </FlueClientProvider>
    )
  },
})

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
  path: PAIR_PATH,
  /**
   * The two halves of what a QR code carries.
   *
   * `t` is the single-use pairing token. `k` is the daemon's static public key,
   * unpadded URL-safe base64 of 32 bytes — the thing the scanning device pins,
   * and the reason the QR is the trusted channel rather than the answer to the
   * device's own POST. `internal/daemon/conn.go` writes both.
   *
   * Each is narrowed to a non-empty string or dropped, so a link that arrives
   * with a parameter repeated (which parses to an array) or empty lands on the
   * page's refusal rather than posting something token-shaped at the daemon and
   * spending the user's window on it. The page re-checks both types anyway: a
   * route's search is its parent's merged with its own and the root route has
   * no schema, so what reaches the component is the raw parse.
   */
  validateSearch: (search: Record<string, unknown>): { t?: string; k?: string } => {
    const out: { t?: string; k?: string } = {}
    if (typeof search.t === 'string' && search.t !== '') out.t = search.t
    if (typeof search.k === 'string' && search.k !== '') out.k = search.k
    return out
  },
  component: PairRoute,
})

const routeTree = rootRoute.addChildren([
  shellRoute.addChildren([indexRoute, sessionsRoute, devicesRoute, settingsRoute]),
  terminalRoute,
  pairRoute,
])

export function createFlueRouter(options: FlueRouterOptions = {}) {
  return createRouter({ routeTree, defaultPreload: false, context: options })
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof createFlueRouter>
  }
}
