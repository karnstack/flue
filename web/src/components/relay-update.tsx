import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'

import {
  RelayUpdateDialog,
  updateAvailable,
  useRelayUIInfo,
} from '@/components/cloudflare-connect'

/**
 * One id for the whole session, so a second call replaces the notice rather
 * than stacking a duplicate beside it.
 */
const TOAST_ID = 'relay-update'

/** The screen that already says all of this, at length, on a card. */
const REMOTE_PATH = '/remote'

/**
 * The standing notice that this daemon has outgrown its relay.
 *
 * A stale relay is not an error and nothing is broken — the old Worker keeps
 * carrying sessions — so this is not a screen, a bar across the top, or
 * anything that has to be dealt with before the app can be used. It is a
 * corner of the window saying a thing is available, with the thing one click
 * away, and it can be sent away.
 *
 * Raised once per version pair per session. `useRelayUIInfo` re-asks the
 * daemon every time the tab is focused, which is right for the card on the
 * Remote screen and would be intolerable here: a notice the reader dismissed
 * that reappears every time they come back from their editor is not a notice,
 * it is nagging. The pair it was raised for is remembered, so a *newer* daemon
 * later in the same session still gets to speak up.
 *
 * Never on the Remote screen, and dismissed on arriving there. That screen's
 * Cloudflare card carries the version numbers, the account, the worker and the
 * update button; a notice repeating it in the corner would be the same
 * sentence twice on one page.
 *
 * Never on a relay origin either, which costs nothing to guarantee here —
 * useRelayUIInfo refuses to ask at all from a remote tab, so `info` stays null
 * and this renders nothing.
 */
export function RelayUpdateNotice({ currentPath }: { currentPath: string }) {
  const info = useRelayUIInfo()
  const [open, setOpen] = useState(false)
  const raisedFor = useRef<string | null>(null)

  const stale = updateAvailable(info)
  const onRemote = currentPath === REMOTE_PATH

  useEffect(() => {
    if (!info || !stale) return
    if (onRemote) {
      toast.dismiss(TOAST_ID)
      return
    }
    const pair = `${info.deployed_version}->${info.version}`
    if (raisedFor.current === pair) return
    raisedFor.current = pair

    toast('Your relay is out of date', {
      id: TOAST_ID,
      description: `It is running flue ${info.deployed_version}; this daemon is ${info.version}.`,
      // Until it is acted on or sent away. A relay that lagged a release
      // yesterday still lags it four seconds from now, and a notice that
      // disappears on its own leaves the reader with a memory of having been
      // told something and no way back to it.
      duration: Infinity,
      action: {
        label: 'Update',
        // The default is to close on the way out; suppressed, because opening
        // the window is not the same as doing the update. Somebody who reads
        // the window and closes it should still have the notice waiting.
        onClick: (event) => {
          event.preventDefault()
          setOpen(true)
        },
      },
      cancel: { label: 'Later', onClick: () => {} },
    })
  }, [info, stale, onRemote])

  // Mounted on `info` alone and not on `stale`, which is the difference
  // between a window and a flicker: a successful update re-asks the daemon,
  // the versions come back equal, and a window gated on the difference would
  // vanish at exactly the moment it had the deploy's own steps to show.
  if (!info) return null
  return (
    <RelayUpdateDialog
      info={info}
      open={open}
      onOpenChange={setOpen}
      // Sent away only once the deploy has actually landed. The window stays
      // where it is, holding the steps it took.
      onDone={() => toast.dismiss(TOAST_ID)}
    />
  )
}
