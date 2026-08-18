import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { PairPanel, scanTrouble } from './pair-panel'

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

  it('falls back to the paste box when there is no media stack at all', async () => {
    // jsdom ships no mediaDevices, which is the shape of a browser with no
    // camera plumbing — the panel says so and the paste box stays, without
    // ever loading the scanner.
    render(<PairPanel onClose={() => {}} />)

    expect(await screen.findByText(/paste the pairing link instead/)).toBeTruthy()
    expect(screen.getByRole('textbox', { name: 'Pairing link' })).toBeTruthy()
  })

  it('falls back the same way when the camera itself says no, real scanner and all', async () => {
    // The refusal a user taps on the permission sheet. The stubs are the
    // browser pieces jsdom lacks — a Worker for the engine, an object URL to
    // mint it from, a getUserMedia that refuses — so this path runs the real
    // qr-scanner import, its constructor and its start, not a stand-in.
    class IdleWorker {
      postMessage() {}
      terminate() {}
      addEventListener() {}
      removeEventListener() {}
    }
    vi.stubGlobal('Worker', IdleWorker)
    const url = URL as unknown as Record<string, unknown>
    url.createObjectURL = () => 'blob:fake'
    url.revokeObjectURL = () => {}
    vi.stubGlobal('navigator', {
      ...window.navigator,
      mediaDevices: {
        getUserMedia: () => Promise.reject(new DOMException('denied', 'NotAllowedError')),
        enumerateDevices: () => Promise.resolve([]),
      },
    })

    try {
      const { unmount } = render(<PairPanel onClose={() => {}} />)

      expect(await screen.findByText(/paste the pairing link instead/)).toBeTruthy()
      expect(screen.getByRole('textbox', { name: 'Pairing link' })).toBeTruthy()

      // The engine import can still be in flight when the assertions are
      // done; let it land while the stubs are alive, or its worker is
      // minted against a torn-down world and rejects where no test is
      // watching.
      unmount()
      await new Promise((settle) => setTimeout(settle, 50))
    } finally {
      delete url.createObjectURL
      delete url.revokeObjectURL
    }
  })

  it('tells routine empty frames apart from an engine that is broken', () => {
    // Every frame without a code in it reports NO_QR_CODE_FOUND; anything
    // else means the engine itself failed — a worker the policy refused, a
    // crash — and the panel must stop pretending the preview is scanning.
    expect(scanTrouble('No QR code found')).toBe(false)
    expect(scanTrouble(new Error('No QR code found'))).toBe(false)
    expect(scanTrouble('Scanner error: Worker is not defined')).toBe(true)
    expect(scanTrouble(new Error("Failed to construct 'Worker'"))).toBe(true)
    expect(scanTrouble(undefined)).toBe(true)
  })

  it('hands Cancel back to its owner', async () => {
    const onClose = vi.fn()
    render(<PairPanel onClose={onClose} />)

    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(onClose).toHaveBeenCalled()
  })
})
