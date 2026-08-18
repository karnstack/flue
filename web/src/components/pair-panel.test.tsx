import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { PairPanel } from './pair-panel'

/**
 * A location whose assign can be watched, origin intact.
 *
 * The whole global is swapped rather than one method spied on for the same
 * reason machines.test.tsx does it: jsdom's Location is [Unforgeable].
 */
function watchLocation() {
  const assign = vi.fn()
  vi.stubGlobal('location', {
    ...window.location,
    origin: 'http://localhost:3000',
    assign,
  })
  return { assign }
}

/** A link the panel should follow, minted for the test page's own origin. */
const GOOD = 'http://localhost:3000/pair?t=tok123&k=key456'

beforeEach(() => {
  watchLocation()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('the pair panel', () => {
  it('follows a pasted pairing link to the ceremony', async () => {
    render(<PairPanel onClose={() => {}} />)

    await userEvent.type(screen.getByRole('textbox', { name: 'Pairing link' }), GOOD)
    await userEvent.click(screen.getByRole('button', { name: 'Open link' }))

    expect(vi.mocked(location.assign)).toHaveBeenCalledWith('/pair?t=tok123&k=key456')
  })

  it('refuses a link minted for a different origin, in words', async () => {
    render(<PairPanel onClose={() => {}} />)

    await userEvent.type(
      screen.getByRole('textbox', { name: 'Pairing link' }),
      'https://other.example/pair?t=tok123&k=key456',
    )
    await userEvent.click(screen.getByRole('button', { name: 'Open link' }))

    expect(await screen.findByText(/different relay/)).toBeTruthy()
    expect(vi.mocked(location.assign)).not.toHaveBeenCalled()
  })

  it('says when the paste is not a pairing link at all', async () => {
    render(<PairPanel onClose={() => {}} />)

    await userEvent.type(
      screen.getByRole('textbox', { name: 'Pairing link' }),
      'scan the code with this device',
    )
    await userEvent.click(screen.getByRole('button', { name: 'Open link' }))

    expect(await screen.findByText(/whole link/)).toBeTruthy()
    expect(vi.mocked(location.assign)).not.toHaveBeenCalled()
  })

  it('says when the link lost its token or key', async () => {
    render(<PairPanel onClose={() => {}} />)

    await userEvent.type(
      screen.getByRole('textbox', { name: 'Pairing link' }),
      'http://localhost:3000/pair?t=tok123',
    )
    await userEvent.click(screen.getByRole('button', { name: 'Open link' }))

    expect(await screen.findByText(/token or key/)).toBeTruthy()
    expect(vi.mocked(location.assign)).not.toHaveBeenCalled()
  })

  it('falls back to the paste box when no camera can be had', async () => {
    // jsdom ships no mediaDevices, which is exactly the shape of a device
    // with no camera or a user who said no — the panel says so and the
    // paste box stays.
    render(<PairPanel onClose={() => {}} />)

    expect(await screen.findByText(/[Nn]o camera/)).toBeTruthy()
    expect(screen.getByRole('textbox', { name: 'Pairing link' })).toBeTruthy()
  })

  it('hands Cancel back to its owner', async () => {
    const onClose = vi.fn()
    render(<PairPanel onClose={onClose} />)

    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(onClose).toHaveBeenCalled()
  })
})
