import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'

import { Toaster } from '@/components/ui/sonner'
import type { RelayUIInfo } from './cloudflare-connect'
import { RelayUpdateNotice } from './relay-update'

/**
 * The daemon's answer to GET /api/relay/info, and nothing else.
 *
 * Every case here begins with the fetch already stubbed, because the notice
 * asks on mount and an unstubbed relative URL is a rejected promise the hook
 * swallows — which would leave every assertion below waiting on a notice that
 * was never going to arrive, for a reason nothing on screen explains.
 */
function stubInfo(info: RelayUIInfo) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve(info) }),
  )
}

const STALE: RelayUIInfo = {
  configured: true,
  can_deploy: true,
  version: '0.3.0',
  deployed_version: '0.2.0',
  worker: 'flue-relay',
  has_token: true,
  account_name: 'personal',
}

/** The Toaster first, so it has subscribed before anything raises a notice. */
function mount(currentPath: string) {
  return render(
    <>
      <Toaster />
      <RelayUpdateNotice currentPath={currentPath} />
    </>,
  )
}

afterEach(() => {
  // Sonner's store outlives a render, so a notice left standing would be on
  // screen for whichever case ran next.
  toast.dismiss()
  vi.unstubAllGlobals()
})

describe('RelayUpdateNotice', () => {
  it('names both versions when the relay lags this daemon', async () => {
    stubInfo(STALE)
    mount('/sessions')

    expect(await screen.findByText('Your relay is out of date')).toBeTruthy()
    expect(screen.getByText(/running flue 0\.2\.0; this daemon is 0\.3\.0/)).toBeTruthy()
  })

  it('says nothing when the deployed relay is this release', async () => {
    stubInfo({ ...STALE, deployed_version: '0.3.0' })
    mount('/sessions')

    // Waiting on the fetch the hook made rather than on a timer: without it
    // this passes before the answer has arrived and would pass just as well
    // with the notice broken.
    await waitFor(() => expect(fetch).toHaveBeenCalled())
    expect(screen.queryByText('Your relay is out of date')).toBeNull()
  })

  it('leaves the Remote screen to say it, at length, on its own card', async () => {
    stubInfo(STALE)
    mount('/remote')

    await waitFor(() => expect(fetch).toHaveBeenCalled())
    expect(screen.queryByText('Your relay is out of date')).toBeNull()
  })

  it('opens the update window in place, and keeps the notice until it lands', async () => {
    stubInfo(STALE)
    mount('/sessions')
    await screen.findByText('Your relay is out of date')

    await userEvent.click(screen.getByRole('button', { name: 'Update' }))

    // The window, over the screen the reader was already on — the point of it
    // being a window rather than a nav to /remote.
    expect(await screen.findByRole('dialog')).toBeTruthy()
    expect(screen.getByText('Update the relay')).toBeTruthy()

    // And the notice survives it. Opening the window is not doing the update,
    // so somebody who reads it and changes their mind still has the notice
    // waiting rather than a thing they have to remember on their own.
    expect(screen.getByText('Your relay is out of date')).toBeTruthy()
  })
})
