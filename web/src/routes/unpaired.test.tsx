import { render, screen, waitFor } from '@testing-library/react'
import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { savePinnedDaemonKey } from '@/crypto/keys'
import { UnpairedRoute } from './unpaired'

/** A daemon's static public key, as a pairing would have left it behind. */
const DAEMON_PUB = Uint8Array.from({ length: 32 }, (_, i) => i + 1)

/**
 * A location whose reload can be watched.
 *
 * jsdom's own `Location` is [Unforgeable] — `vi.spyOn(location, 'reload')`
 * throws "Cannot redefine property" — so the whole global is replaced for the
 * duration of a test rather than one method of it.
 */
function watchReload(): ReturnType<typeof vi.fn> {
  const reload = vi.fn()
  vi.stubGlobal('location', { ...window.location, href: window.location.href, reload })
  return reload
}

beforeEach(() => {
  // jsdom ships no IndexedDB, and this screen reaches for the default factory
  // the way a browser does.
  vi.stubGlobal('indexedDB', new IDBFactory())
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('the unpaired screen', () => {
  it('says what is wrong rather than spinning on a connection', () => {
    render(<UnpairedRoute />)
    expect(screen.getByRole('heading', { name: 'Not paired with a daemon yet' })).toBeTruthy()
  })

  it('says the one thing that gets the user out of it', () => {
    // The way in is a ceremony that starts on another screen, so the copy has
    // to name that screen. A page that only reported the problem would leave
    // the user with nowhere to go.
    render(<UnpairedRoute />)
    expect(screen.getByText(/Pair device/)).toBeTruthy()
    expect(screen.getByText(/Devices/)).toBeTruthy()
  })

  it('carries no chrome, because there is nothing here to navigate to', () => {
    // The same layout decision /pair makes, for the same reason: a sidebar of
    // links to sessions this browser cannot open would be chrome promising
    // what it does not have.
    render(<UnpairedRoute />)
    expect(screen.queryByRole('navigation')).toBeNull()
    expect(screen.queryAllByRole('link')).toHaveLength(0)
    expect(document.querySelector('[data-slot="sidebar"]')).toBeNull()
  })

  it('reloads the tab when a key turned up after all', async () => {
    // The flag that mounts this screen is answered once, in main.tsx, before
    // the router exists. A tab that pairs at /pair and then navigates back into
    // the app — same document, client-side routing — is still holding the
    // startup answer, and would be told it is not paired while its key sits in
    // the store. Asking again on mount is what closes that gap.
    const reload = watchReload()
    await savePinnedDaemonKey(DAEMON_PUB)

    render(<UnpairedRoute />)

    // Reloaded rather than re-rendered: the client, its Noise transport and the
    // router's context are all built from that identity at the entry point.
    await waitFor(() => expect(reload).toHaveBeenCalled())
  })

  it('stays put when there is still no key, rather than reloading on a loop', async () => {
    const reload = watchReload()

    render(<UnpairedRoute />)

    // The store is empty, so the answer has not changed and neither has the
    // screen. Waited on rather than asserted immediately: the check is
    // asynchronous, and a synchronous expectation would pass before it ran.
    await screen.findByRole('heading', { name: 'Not paired with a daemon yet' })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(reload).not.toHaveBeenCalled()
  })
})
