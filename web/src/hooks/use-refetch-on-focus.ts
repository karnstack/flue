import { useEffect, useRef } from 'react'

/**
 * Runs fn when the tab comes back — window focus, or the document coming out
 * of hiding — so a screen left open overnight shows this morning's truth the
 * moment it is looked at.
 *
 * This is the poor tab's react-query: flue's lists are one-shot requests
 * (sessions, devices) or plain local reads (machines, /api/relay/info), and
 * nothing but a reconnect refreshes them otherwise. Both events fire on an
 * ordinary tab switch — visibilitychange for the switch, focus for a click
 * back into a shown-but-blurred window — so fn must be idempotent and
 * cheap, which every list request here is.
 *
 * The ref dance keeps the listener stable across renders: the latest fn is
 * called, but the subscription is made once.
 */
export function useRefetchOnFocus(fn: () => void): void {
  const latest = useRef(fn)
  latest.current = fn

  useEffect(() => {
    const run = () => {
      if (!document.hidden) latest.current()
    }
    window.addEventListener('focus', run)
    document.addEventListener('visibilitychange', run)
    return () => {
      window.removeEventListener('focus', run)
      document.removeEventListener('visibilitychange', run)
    }
  }, [])
}
