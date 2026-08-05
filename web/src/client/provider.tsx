import { createContext, useContext, useEffect, useRef, type ReactNode } from 'react'

import { daemonSocketUrl, FlueClient } from './client'

const FlueClientContext = createContext<FlueClient | null>(null)

export interface FlueClientProviderProps {
  children: ReactNode
  /**
   * A client to use instead of building one. The seam tests reach for; nothing
   * in the app passes it, because there is meant to be exactly one client and
   * this is where it lives.
   */
  client?: FlueClient
}

/**
 * One client per browser tab, mounted at the root of the routes that speak to
 * the daemon so a single WebSocket serves all of them.
 *
 * Per-component clients would open a fresh socket on every navigation, and two
 * components rendering at once would open two — each of which the daemon
 * counts as a separate attachment with its own byte offsets.
 *
 * Nested inside another provider it is a pass-through: the client already in
 * context is the tab's client, and building a second one here would be the very
 * thing this component exists to prevent. That is what lets a test put a
 * scripted client above the router and still exercise the real tree, in which
 * the router mounts one of these for itself.
 */
export function FlueClientProvider({ children, client }: FlueClientProviderProps) {
  const inherited = useContext(FlueClientContext)
  if (client === undefined && inherited !== null) return <>{children}</>
  return <OwnClientProvider client={client}>{children}</OwnClientProvider>
}

/**
 * The half that owns a client: builds one if it was not given one, connects it
 * on mount, and closes it on unmount.
 *
 * Split out so the connect/close effect belongs to the provider that is
 * actually responsible for the socket. A pass-through running it too would
 * close the tab's one client the moment the inner provider unmounted.
 */
function OwnClientProvider({ children, client }: FlueClientProviderProps) {
  // Built on the first render that needs one, and not before: an injected
  // client means no socket URL has to be derived at all, which keeps this
  // usable anywhere `location` is not what the client should be aimed at.
  const own = useRef<FlueClient | null>(null)
  let active = client
  if (!active) {
    own.current ??= new FlueClient(daemonSocketUrl())
    active = own.current
  }

  useEffect(() => {
    active.connect()
    // Stopping on unmount is what makes a closed tab a clean detach while the
    // daemon keeps the PTY running.
    //
    // React double-invokes this in development, so the pair has to survive
    // connect / close / connect on one client: `close` releases the socket
    // outright rather than waiting to be told it shut, and `connect` starts a
    // new one. The StrictMode case in provider.test.tsx checks that leaves
    // exactly one live socket and nothing armed behind it.
    return () => active.close()
  }, [active])

  return <FlueClientContext.Provider value={active}>{children}</FlueClientContext.Provider>
}

/** The tab's client. Throws outside the provider rather than returning null. */
export function useFlueClient(): FlueClient {
  const client = useContext(FlueClientContext)
  if (!client) throw new Error('flue: useFlueClient must be used inside FlueClientProvider')
  return client
}
