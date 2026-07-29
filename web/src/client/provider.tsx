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
 * One client per browser tab, mounted above the router so a single WebSocket
 * serves every route.
 *
 * Per-component clients would open a fresh socket on every navigation, and two
 * components rendering at once would open two — each of which the daemon
 * counts as a separate attachment with its own byte offsets.
 */
export function FlueClientProvider({ children, client }: FlueClientProviderProps) {
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
