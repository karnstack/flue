import { useCallback, useEffect, useRef, useState } from 'react'

import { useRefetchOnFocus } from '@/hooks/use-refetch-on-focus'
import { isRelayOrigin } from '@/relay/mode'

const RELEASE_ENDPOINT = '/api/flue/release'

/**
 * How often an open tab re-reads the daemon's cache.
 *
 * Shorter than the daemon's own interval on purpose. This is a local read of
 * a value that changes on the daemon's schedule, so asking more often than it
 * refreshes costs nothing and means the news is on screen within a poll of
 * landing rather than within a page load — and a tab someone leaves open for
 * a week is the normal way to run flue, not the exception.
 */
const RELEASE_POLL_MS = 5 * 60 * 1000

/** GET /api/flue/release, verbatim (daemon.ReleaseStatus). */
export interface ReleaseStatus {
  current: string
  latest?: string
  url?: string
  update: boolean
}

/**
 * Whether a newer flue than this daemon has been published.
 *
 * Never asked on a relay origin, and this one is not merely a boundary — it is
 * the answer being useless there. Upgrading flue replaces a binary on the
 * machine the daemon runs on; a phone reading a laptop's fleet cannot do it,
 * and telling that phone about it would be an offer it has no way to accept.
 *
 * Null while unanswered, and null forever on a daemon too old to carry the
 * endpoint (404) or one that cannot reach GitHub. Nothing renders in any of
 * those cases: a version nobody could look up is not news, and "could not
 * check for updates" is a sentence about the app's plumbing rather than about
 * flue.
 *
 * Asked on mount, on a timer, and whenever the tab is looked at again. It
 * used to be asked once per mount and never again, on the reasoning that this
 * only reads a cache the daemon refreshes on its own schedule — but the
 * daemon has no timer of its own. Its refresh is started *by* a read of this
 * endpoint, so a tab that never asks twice is a daemon that never checks
 * twice, and a machine left running with flue open never heard about a
 * release at all. The ask is a local GET behind the loopback token; the poll
 * is the cheapest thing in the app.
 *
 * A refresh the daemon starts is for the next reader rather than this one, so
 * the news lands on the ask after the one that triggered it. That is what the
 * interval buys beyond the focus listener: a tab left open and focused fires
 * no focus events, and would otherwise wait for a reload it may never get.
 */
export function useRelease(): ReleaseStatus | null {
  const [release, setRelease] = useState<ReleaseStatus | null>(null)
  // Not a cancelled flag per request: the timer outlives any one of them, and
  // what must not happen is a setState after unmount from whichever is still
  // in flight when the tab goes away.
  const live = useRef(true)

  const ask = useCallback(() => {
    if (isRelayOrigin()) return
    void fetch(RELEASE_ENDPOINT, { credentials: 'same-origin' })
      .then((res) => (res.ok ? (res.json() as Promise<ReleaseStatus>) : null))
      .then((got) => {
        if (live.current && got) setRelease(got)
      })
      .catch(() => {})
  }, [])

  useEffect(() => {
    live.current = true
    ask()
    const timer = setInterval(ask, RELEASE_POLL_MS)
    return () => {
      live.current = false
      clearInterval(timer)
    }
  }, [ask])

  useRefetchOnFocus(ask)

  return release
}
