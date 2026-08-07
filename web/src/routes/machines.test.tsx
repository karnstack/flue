import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { loadPinnedDaemonKeyFor, savePinnedDaemonKeyFor } from '@/crypto/keys'
import { saveMachine, SELECTED_KEY } from '@/relay/machines'
import { MachinesRoute } from './machines'

/** A machine's static public key, as pairing would have pinned it. */
const PUB = Uint8Array.from({ length: 32 }, (_, i) => i + 1)

const MESA = { id: 'blue-mesa', name: 'Blue Mesa', pairedAt: 1_700_000_000_000 }
const ATTIC = { id: 'attic-pi', name: 'Attic Pi', pairedAt: 1_700_000_001_000 }

/**
 * A location whose reload and replace can be watched.
 *
 * The whole global is swapped rather than one method spied on — jsdom's
 * `Location` is [Unforgeable], so a spy on one method throws.
 */
function watchLocation(pathname = '/') {
  const reload = vi.fn()
  const replace = vi.fn()
  vi.stubGlobal('location', {
    ...window.location,
    href: window.location.href,
    pathname,
    reload,
    replace,
  })
  return { reload, replace }
}

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  vi.stubGlobal('indexedDB', new IDBFactory())
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('the machine picker', () => {
  it('lists every paired machine by name, with its id beside it', () => {
    saveMachine(MESA)
    saveMachine(ATTIC)

    render(<MachinesRoute />)

    expect(screen.getByText('Blue Mesa')).toBeTruthy()
    expect(screen.getByText('blue-mesa')).toBeTruthy()
    expect(screen.getByText('Attic Pi')).toBeTruthy()
    expect(screen.getByText('attic-pi')).toBeTruthy()
    expect(screen.getAllByRole('button', { name: /^Connect to / })).toHaveLength(2)
  })

  it('selects the machine and reloads, so the boot builds its client', async () => {
    // The client, its Noise transport and the router context are all built
    // once at the entry point from the selection — the same reason the old
    // unpaired explainer reloaded rather than flipping a flag.
    saveMachine(MESA)
    saveMachine(ATTIC)
    const { reload } = watchLocation('/sessions')

    render(<MachinesRoute />)
    await userEvent.click(screen.getByRole('button', { name: 'Connect to Attic Pi' }))

    expect(sessionStorage.getItem(SELECTED_KEY)).toBe(ATTIC.id)
    expect(reload).toHaveBeenCalled()
  })

  it('leaves /machines for home when connecting from the picker’s own address', async () => {
    // A tab that reloads at /machines lands back on the picker it just
    // answered; the selection is only visible from anywhere else.
    saveMachine(MESA)
    saveMachine(ATTIC)
    const { replace, reload } = watchLocation('/machines')

    render(<MachinesRoute />)
    await userEvent.click(screen.getByRole('button', { name: 'Connect to Blue Mesa' }))

    expect(sessionStorage.getItem(SELECTED_KEY)).toBe(MESA.id)
    expect(replace).toHaveBeenCalledWith('/')
    expect(reload).not.toHaveBeenCalled()
  })

  it('forgets a machine without asking, key and all', async () => {
    saveMachine(MESA)
    saveMachine(ATTIC)
    await savePinnedDaemonKeyFor(MESA.id, PUB)
    watchLocation('/machines')

    render(<MachinesRoute />)
    await userEvent.click(screen.getByRole('button', { name: 'Forget Blue Mesa' }))

    // The row goes at once, and the pinned key goes with the record: what is
    // left holds nothing that could open a channel to that machine.
    expect(screen.queryByText('Blue Mesa')).toBeNull()
    expect(screen.getByText('Attic Pi')).toBeTruthy()
    await waitFor(async () => expect(await loadPinnedDaemonKeyFor(MESA.id)).toBeNull())
  })

  it('returns to the picker when the forgotten machine was the selected one', async () => {
    saveMachine(MESA)
    saveMachine(ATTIC)
    sessionStorage.setItem(SELECTED_KEY, MESA.id)
    const { reload } = watchLocation('/machines')

    render(<MachinesRoute />)
    await userEvent.click(screen.getByRole('button', { name: 'Forget Blue Mesa' }))

    // The tab's client was built against that machine at boot, so the honest
    // move is the same reload every other selection change makes.
    expect(sessionStorage.getItem(SELECTED_KEY)).toBeNull()
    expect(reload).toHaveBeenCalled()
  })

  it('does not reload for forgetting a machine that was not selected', async () => {
    saveMachine(MESA)
    saveMachine(ATTIC)
    sessionStorage.setItem(SELECTED_KEY, ATTIC.id)
    const { reload } = watchLocation('/machines')

    render(<MachinesRoute />)
    await userEvent.click(screen.getByRole('button', { name: 'Forget Blue Mesa' }))

    expect(sessionStorage.getItem(SELECTED_KEY)).toBe(ATTIC.id)
    expect(reload).not.toHaveBeenCalled()
  })

  it('explains pairing when there is nothing to pick', () => {
    // The old unpaired explainer, as the picker's empty state: the way in is
    // still a ceremony that starts on the machine itself.
    render(<MachinesRoute />)

    expect(screen.getByRole('heading', { name: 'No machines paired yet' })).toBeTruthy()
    expect(screen.getByText(/Pair device/)).toBeTruthy()
    expect(screen.getByText(/Devices/)).toBeTruthy()
    expect(screen.getByText(/two minutes/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /^Connect/ })).toBeNull()
  })

  it('carries no chrome, because it is the door rather than a screen', () => {
    saveMachine(MESA)
    render(<MachinesRoute />)

    expect(screen.queryByRole('navigation')).toBeNull()
    expect(document.querySelector('[data-slot="sidebar"]')).toBeNull()
  })
})
