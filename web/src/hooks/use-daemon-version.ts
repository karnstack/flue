import { useContext, useEffect, useState } from 'react'

import { FlueClientContext } from '@/client/provider'

/**
 * Which flue this tab is talking to, or null until it has been told.
 *
 * Seeded from the client and refreshed on every welcome, which is the pattern
 * anything reading a claim-about-the-daemon has to follow: a welcome is the
 * only event that carries one, so a component mounting between welcomes would
 * otherwise wait for a reconnect that may never come on a stable socket.
 *
 * The context is read directly rather than through useFlueClient, which
 * throws outside the provider. This is for chrome — the sidebar's footer —
 * and chrome renders on /pair and in a bare test tree where there is no
 * client to be had. A missing client is not an error here, it is one line
 * that has nothing to say yet.
 */
export function useDaemonVersion(): string | null {
  const client = useContext(FlueClientContext)
  const [version, setVersion] = useState<string | null>(client?.version ?? null)

  useEffect(() => {
    if (!client) return
    // Re-seeded here as well as in the initial state: the client may have been
    // greeted between this component mounting and the effect running, and a
    // welcome that landed in that window fires no listener of ours.
    setVersion(client.version)
    return client.onWelcome((w) => setVersion(w.ver))
  }, [client])

  return version
}
