import { useEffect, useRef } from 'react'

import { isRelayOrigin } from '@/relay/mode'

/** How often a stale screen asks the daemon whether the relay came up. */
const POLL_MS = 2_000

/**
 * Polls /api/relay/info while `active`, and reports the relay origin the
 * moment the daemon's transport says connected.
 *
 * This closes the welcome gap: the relay's state rides each connection's
 * welcome as a snapshot, so a tab greeted while the daemon was still
 * dialling shows "connecting" until its socket happens to reconnect — which
 * on a stable loopback socket is never. The daemon knows the moment the leg
 * comes up (SetRelayStatus); this is the screens' way of hearing it without
 * a wire change. Callers pass `active` only while their snapshot claims
 * something short of connected, so a healthy screen polls nothing.
 *
 * Never on a relay origin: the endpoint is the daemon's own, and a remote
 * tab's relay state is its own socket, not this API.
 */
export function useRelayTransport(active: boolean, onConnected: (origin: string) => void): void {
  const latest = useRef(onConnected)
  latest.current = onConnected

  useEffect(() => {
    if (!active || isRelayOrigin()) return
    let stopped = false
    const ask = () => {
      void fetch('/api/relay/info', { credentials: 'same-origin' })
        .then((res) => (res.ok ? (res.json() as Promise<Record<string, unknown>>) : null))
        .then((info) => {
          if (stopped || !info) return
          const origin = info.transport_origin
          if (info.transport === 'connected' && typeof origin === 'string' && origin !== '') {
            latest.current(origin)
          }
        })
        .catch(() => {})
    }
    ask()
    const poll = setInterval(ask, POLL_MS)
    return () => {
      stopped = true
      clearInterval(poll)
    }
  }, [active])
}
