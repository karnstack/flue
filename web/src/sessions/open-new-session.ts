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
 * A blocked popup falls back to this tab rather than to nothing at all. It is
 * not what was asked for, but a button that visibly does nothing is worse than
 * a button that does the old thing, and the reader can still get back with the
 * browser's own back button.
 */
export function useOpenNewSession(): (want: NewSessionRequest) => void {
  const router = useRouter()
  return useCallback(
    (want: NewSessionRequest) => {
      const href = router.buildLocation({
        to: NEW_SESSION_PATH,
        search: newSessionSearch(want),
      }).href
      const tab = window.open(href, '_blank', 'noopener')
      if (tab === null) void router.navigate({ to: href })
    },
    [router],
  )
}
