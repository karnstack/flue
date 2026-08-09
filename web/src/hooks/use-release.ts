import { useEffect, useState } from 'react'

import { isRelayOrigin } from '@/relay/mode'

const RELEASE_ENDPOINT = '/api/flue/release'

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
 * Asked once per mount and never polled. The daemon's own check runs on a
 * twelve-hour interval and this is a read of its cache — polling it from the
 * tab would ask the same question of the same cache to no effect.
 */
export function useRelease(): ReleaseStatus | null {
  const [release, setRelease] = useState<ReleaseStatus | null>(null)

  useEffect(() => {
    if (isRelayOrigin()) return
    let cancelled = false
    void fetch(RELEASE_ENDPOINT, { credentials: 'same-origin' })
      .then((res) => (res.ok ? (res.json() as Promise<ReleaseStatus>) : null))
      .then((got) => {
        if (!cancelled && got) setRelease(got)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  return release
}
