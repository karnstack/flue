import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  Outlet,
  useRouterState,
} from '@tanstack/react-router'
import type { FlueClient } from '@/client/client'
import { FleetProvider } from '@/fleet/provider'
import { AppShell } from '@/components/app-shell'
import { DevicesRoute } from '@/routes/devices'
import { MachinesRoute } from '@/routes/machines'
import { NewSessionRoute } from '@/routes/new-session'
import { PairRoute } from '@/routes/pair'
import { RemoteRoute } from '@/routes/remote'
import { SessionsRoute } from '@/routes/sessions'
import { SettingsRoute } from '@/routes/settings'
import { TerminalRoute } from '@/routes/terminal'
import { ScratchProvider } from '@/scratch/provider'
import { NEW_SESSION_PATH, validateNewSessionSearch } from '@/sessions/new-session'
import { SwitcherProvider } from '@/switcher/provider'

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
   * the daemon this browser pinned; on loopback this is absent and the fleet
   * provider below builds the plain /ws client for itself. Either way it is
   * the fleet's local source — the machine this tab rides.
   */
  client?: FlueClient
  /**
   * Whether that client authenticates its daemon against a key this browser
   * pinned at a pairing ceremony. Passed through untouched to the fleet, which
   * is where it decides something: a fleet key may be taken off a welcome from
   * a machine this browser paired with and from nowhere else (fleet/fleet.ts,
   * adoptFleetKey). Absent is false, which is the honest answer for the tab
   * that passes no client at all — the daemon's own origin, where a session
   * cookie is the whole of the authentication.
   */
  pinned?: boolean
  /**
   * True when this page came from a relay and no machine is selected — none
   * paired, or several with the choice not yet made. Every screen but /pair is
   * then the machine picker, because there is no handshake for any of them to
   * attempt until it has an answer.
   */
  picker?: boolean
  /**
   * True when the daemon on this machine served this page: the other side of
   * the same coin as `client`, and the case where the tab holds a session
   * cookie and no fleet identity at all.
   *
   * The fleet uses it for the two things only that tab does — enrolling itself
   * as a device of this machine's fleet, and reading the fleet directory
   * through the daemon, because the relay answers a cross-origin fetch without
   * the header a browser needs to hand it over. See fleet/enrol.ts.
   */
  loopback?: boolean
}

/**
 * The tab's one fleet, the one route that must not have it, and the case where
 * there is no client to be had.
 *
 * The fleet provider superseded FlueClientProvider here: it holds one client
 * per reachable machine — the tab's own ride first — and hands the local one
 * into the same context useFlueClient has always read, so every screen written
 * against the one-client world still works unchanged.
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
 * navigation, so this is still exactly one fleet per tab and one socket per
 * machine for sessions, the terminal and Devices alike. Only crossing in or
 * out of /pair changes which branch renders, and nothing in the app links
 * there.
 *
 * `picker` is answered here rather than per route for the same reason the
 * provider is: it is one fact about the whole tab. It sits below the /pair
 * branch deliberately — that page is the only way into a machine record, and a
 * flag that swallowed it would leave the user with a door pointing at a screen
 * the app refuses to render. The URL is left alone rather than redirected, so
 * the moment a machine is chosen, a reload of the same address is the app on
 * that machine — the picker itself does the reloading when a choice is made
 * (src/routes/machines.tsx).
 */
const rootRoute = createRootRouteWithContext<FlueRouterOptions>()({
  component: function Root() {
    const pathname = useRouterState({ select: (s) => s.location.pathname })
    const { client, pinned, picker, loopback } = rootRoute.useRouteContext()
    if (pathname === PAIR_PATH) return <Outlet />
    if (picker === true) return <MachinesRoute />
    return (
      <FleetProvider client={client} pinned={pinned} loopback={loopback}>
        {/*
          Inside the fleet and above every screen that can see one. The palette
          it holds is about every machine's sessions at once, so the fleet has
          to be above it; and a chord that worked on the terminal but not on
          Sessions would be a chord nobody trusts, so it has to be above them
          all. The two routes it does not reach are the two that have no daemon
          to list — /pair, which is how a device gets a token in the first
          place, and the machine picker, which is the screen for a tab that has
          not chosen one.
        */}
        <SwitcherProvider>
          {/*
            The scratch terminal rides beside the switcher for the same
            reason the switcher is here: its chord has to answer on any
            screen with a session, and its anchor is whatever session the
            route says is on screen.
          */}
          <ScratchProvider>
            <Outlet />
          </ScratchProvider>
        </SwitcherProvider>
      </FleetProvider>
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

const devicesRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/devices',
  component: DevicesRoute,
})

/**
 * Remote access, inside the shell unlike /pair: this is a screen for the
 * browser that is already paired with the daemon, read while the app's own
 * chrome is up, and its whole subject is the state of a leg the daemon reports
 * on the connection that chrome is riding.
 */
const remoteRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/remote',
  component: RemoteRoute,
})

const settingsRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/settings',
  component: SettingsRoute,
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
 * The page that starts a session, beside the terminal and outside the shell on
 * purpose: it is the terminal a moment before there is one, it replaces itself
 * with that terminal, and app chrome around it would be a dashboard flashing
 * past on the way — which is the exact complaint it was built to answer.
 *
 * The schema is `validateNewSessionSearch`'s, so the narrowing lives beside
 * the builder that writes these links and the two cannot drift.
 */
const newSessionRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: NEW_SESSION_PATH,
  validateSearch: validateNewSessionSearch,
  component: NewSessionRoute,
})

/**
 * The machine picker's own address, beside the terminal and outside the shell:
 * it is the relay door, and a door with a sidebar of links to one machine's
 * sessions would be chrome answering the very question the screen is asking.
 * Registered as a route — not only as the `picker` flag's rendering — so a tab
 * already riding one machine can come back and switch to another.
 */
const machinesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/machines',
  component: MachinesRoute,
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
   * What a QR code carries.
   *
   * `t` is the single-use pairing token. `k` is the daemon's static public key,
   * unpadded URL-safe base64 of 32 bytes — the thing the scanning device pins,
   * and the reason the QR is the trusted channel rather than the answer to the
   * device's own POST. `internal/daemon/conn.go` writes both. On a relay that
   * fronts more than one machine the link also names which: `d` is the machine
   * id — the slot to post at and the record to pin under — and `n` its display
   * name, which is why `n` may only ever be a query parameter and never a path.
   * The Devices screen appends those two (src/routes/devices.tsx, pairLink).
   *
   * Each is narrowed to a non-empty string or dropped, so a link that arrives
   * with a parameter repeated (which parses to an array) or empty lands on the
   * page's refusal rather than posting something token-shaped at the daemon and
   * spending the user's window on it. The page re-checks every type anyway: a
   * route's search is its parent's merged with its own and the root route has
   * no schema, so what reaches the component is the raw parse.
   */
  validateSearch: (
    search: Record<string, unknown>,
  ): { t?: string; k?: string; f?: string; d?: string; n?: string } => {
    const out: { t?: string; k?: string; f?: string; d?: string; n?: string } = {}
    if (typeof search.t === 'string' && search.t !== '') out.t = search.t
    if (typeof search.k === 'string' && search.k !== '') out.k = search.k
    if (typeof search.f === 'string' && search.f !== '') out.f = search.f
    if (typeof search.d === 'string' && search.d !== '') out.d = search.d
    if (typeof search.n === 'string' && search.n !== '') out.n = search.n
    return out
  },
  component: PairRoute,
})

const routeTree = rootRoute.addChildren([
  shellRoute.addChildren([indexRoute, sessionsRoute, devicesRoute, remoteRoute, settingsRoute]),
  terminalRoute,
  newSessionRoute,
  machinesRoute,
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
