import { useCallback } from 'react'
import { useRouter } from '@tanstack/react-router'

import {
  NEW_SESSION_PATH,
  newSessionSearch,
  type NewSessionRequest,
} from '@/sessions/new-session'

/**
 * What a press already implies about the session it is asking for: the machine
 * of the heading it sits under, the directory of the terminal beneath it, the
 * tag of the group. Everything absent opens the dialog empty.
 */
export type NewSessionOrigin = Partial<NewSessionRequest>

/**
 * Open the new-session page in a new tab.
 *
 * The address is built by the router rather than by hand, and that is the
 * point of the hook: the page narrows what arrives with `validateNewSessionSearch`,
 * the router's own serialiser is what writes arrays and strings into a query,
 * and going through `buildLocation` is what makes the two halves agree by
 * construction. A tag with a comma in it survives; a hand-joined string would
 * quietly become two tags.
 *
 * Called straight out of a click or a form submission, never out of a reply,
 * which is the whole reason the page exists — see the note on NewSessionRoute.
 *
 * The tab is the only path: there is deliberately no popup-blocked fallback.
 * With `noopener`, window.open returns null on every call — that is specified
 * behaviour, the option severs the handle the caller would otherwise get — so
 * the return value cannot distinguish a block from success. A fallback keyed
 * on it fired unconditionally and spawned two sessions per click, one in the
 * new tab and one here. A genuinely blocked popup is rare, and the browser's
 * own blocked-popup UI is the recovery.
 */
export function useOpenNewSession(): (want: NewSessionRequest) => void {
  const router = useRouter()
  return useCallback(
    (want: NewSessionRequest) => {
      const href = router.buildLocation({
        to: NEW_SESSION_PATH,
        search: newSessionSearch(want),
      }).href
      window.open(href, '_blank', 'noopener')
    },
    [router],
  )
}
