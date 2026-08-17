import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { useOpenNewSession } from '@/sessions/open-new-session'
import { renderWithRouter } from '@/testing/render'

function OpenButton() {
  const openNewSession = useOpenNewSession()
  return (
    <button onClick={() => openNewSession({ machineId: 'attic-pi', cwd: '/tmp', name: '', tags: [] })}>
      open
    </button>
  )
}

describe('useOpenNewSession', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('opens the new-session page in a tab, with the request in the query', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    await renderWithRouter(<OpenButton />)

    await userEvent.click(screen.getByRole('button', { name: 'open' }))

    expect(open).toHaveBeenCalledTimes(1)
    const [href, target, features] = open.mock.calls[0] ?? []
    expect(String(href)).toMatch(/^\/new\?/)
    expect(String(href)).toContain('d=attic-pi')
    expect(target).toBe('_blank')
    expect(features).toBe('noopener')
  })

  it('does not also navigate this tab: noopener makes window.open return null on every call, not only on a blocked popup', async () => {
    // The regression this pins: a popup-blocked fallback keyed on the return
    // value fires unconditionally under noopener, so one click spawned two
    // sessions — one in the new tab, one here (#69).
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    const { router } = await renderWithRouter(<OpenButton />)

    await userEvent.click(screen.getByRole('button', { name: 'open' }))

    expect(open).toHaveBeenCalledTimes(1)
    expect(router.state.location.pathname).toBe('/sessions')
  })
})
