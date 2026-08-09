import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import type { FleetSession } from '@/fleet/types'
import { cursorAlignOffset, PreviewCard, SessionPreview } from './session-preview'

/** One session, with everything a case did not care about filled in. */
function fs(over: Partial<FleetSession> = {}): FleetSession {
  return {
    id: 's1',
    title: 'zsh',
    name: '',
    tags: [],
    pinned: false,
    cwd: '/Users/karn/code/flue',
    cmd: ['zsh', '-l'],
    state: 'running',
    exitCode: 0,
    cols: 120,
    rows: 40,
    createdAt: '2026-07-28T09:00:00Z',
    lastActive: '2026-07-28T10:00:00Z',
    machineId: 'm1',
    machineName: 'MacBook Pro',
    ...over,
  }
}

describe('cursorAlignOffset', () => {
  it('hangs the card just left of where the pointer actually is', () => {
    // A row is the full width of the screen, so a card pinned to its leading
    // edge opened a thousand pixels away from a reader looking at a session's
    // machine or its timestamp. Measured across the row from its own left,
    // which is the frame Radix positions in.
    expect(cursorAlignOffset(24, 824)).toBe(776)
  })

  it('sits a little left of the pointer rather than under it', () => {
    // Not zero: a card whose corner is exactly beneath the cursor reads as
    // though it is about to swallow it.
    expect(cursorAlignOffset(100, 100)).toBeLessThan(0)
  })

  it('falls back to the leading edge of the row when no pointer opened the card', () => {
    // Keyboard focus opens this too, and there is nothing to aim at then —
    // the focus ring the reader is following is already at the row's start.
    expect(cursorAlignOffset(24, null)).toBe(0)
    expect(cursorAlignOffset(undefined, 824)).toBe(0)
  })
})

describe('PreviewCard', () => {
  it('names the session, its machine and its directory', () => {
    render(<PreviewCard session={fs({ name: 'api' })} preview={{ at: 'loading' }} />)

    expect(screen.getByText('api')).toBeTruthy()
    expect(screen.getByText('MacBook Pro')).toBeTruthy()
    expect(screen.getByText('/Users/karn/code/flue')).toBeTruthy()
  })

  it('prints the lines it was given, in order, as one block', () => {
    render(
      <PreviewCard
        session={fs()}
        preview={{ at: 'ready', lines: ['$ go test ./...', 'ok  flue/internal/wire'] }}
      />,
    )

    const block = screen.getByText(/go test/)
    expect(block.textContent).toBe('$ go test ./...\nok  flue/internal/wire')
  })

  it('says so rather than showing an empty box when nothing has been drawn', () => {
    render(<PreviewCard session={fs()} preview={{ at: 'ready', lines: [] }} />)

    expect(screen.getByText('Nothing drawn yet.')).toBeTruthy()
  })

  it('names the exit code when an ended session drew nothing', () => {
    render(
      <PreviewCard
        session={fs({ state: 'exited', exitCode: 130 })}
        preview={{ at: 'ready', lines: [] }}
      />,
    )

    expect(screen.getByText('Ended with 130 and drew nothing.')).toBeTruthy()
  })

  it('says it cannot show anything rather than diagnosing the transport', () => {
    // A machine that went away, a session reaped a moment ago and a daemon
    // mid-reconnect are one sentence to a reader hovering a row.
    render(<PreviewCard session={fs()} preview={{ at: 'unavailable' }} />)

    expect(screen.getByText('No preview right now.')).toBeTruthy()
  })
})

describe('SessionPreview', () => {
  it('asks nothing until the pointer has rested on the row', async () => {
    const peek = vi.fn().mockResolvedValue({ data: '', cols: 80, rows: 24 })
    render(
      <SessionPreview session={fs()} peek={peek}>
        <a href="/s1">api</a>
      </SessionPreview>,
    )

    // Rendered, never hovered: a list of twenty rows must cost twenty
    // nothings until one of them is actually looked at.
    expect(peek).not.toHaveBeenCalled()
  })

  it('asks the daemon once the row is hovered, and shows what came back', async () => {
    const peek = vi.fn().mockResolvedValue({
      data: btoa('building...\r\nok'),
      cols: 80,
      rows: 24,
    })
    render(
      <SessionPreview session={fs()} peek={peek}>
        <a href="/s1">api</a>
      </SessionPreview>,
    )

    await userEvent.hover(screen.getByRole('link', { name: 'api' }))

    await waitFor(() => expect(screen.getByText(/building/)).toBeTruthy(), { timeout: 3000 })
    expect(peek).toHaveBeenCalledWith(expect.objectContaining({ id: 's1' }), expect.any(Number))
  })

  it('does not restart when the fleet hands the same row back as a new object', async () => {
    // The fleet re-lists every three seconds and builds fresh objects each
    // time, so a re-render with an identical row is the *ordinary* case rather
    // than an edge. Restarting on it put the card back to "Reading…" three
    // times a second-and-a-half, which on screen is a preview that blinks
    // while the pointer rests on it.
    const peek = vi.fn().mockResolvedValue({ data: btoa('steady'), cols: 80, rows: 24 })
    const { rerender } = render(
      <SessionPreview session={fs()} peek={peek}>
        <a href="/s1">api</a>
      </SessionPreview>,
    )

    await userEvent.hover(screen.getByRole('link', { name: 'api' }))
    await waitFor(() => expect(screen.getByText('steady')).toBeTruthy(), { timeout: 3000 })
    const asked = peek.mock.calls.length

    // A new object, same session, exactly as a poll would deliver it.
    rerender(
      <SessionPreview session={fs()} peek={peek}>
        <a href="/s1">api</a>
      </SessionPreview>,
    )

    expect(peek.mock.calls.length).toBe(asked)
    expect(screen.getByText('steady')).toBeTruthy()
  })

  it('shows the refusal rather than a card that never fills in', async () => {
    const peek = vi.fn().mockRejectedValue(new Error('flue: connection lost'))
    render(
      <SessionPreview session={fs()} peek={peek}>
        <a href="/s1">api</a>
      </SessionPreview>,
    )

    await userEvent.hover(screen.getByRole('link', { name: 'api' }))

    await waitFor(() => expect(screen.getByText('No preview right now.')).toBeTruthy(), {
      timeout: 3000,
    })
  })

  it('renders the row untouched when previews are turned off', () => {
    const peek = vi.fn()
    render(
      <SessionPreview session={fs()} peek={peek} disabled>
        <a href="/s1">api</a>
      </SessionPreview>,
    )

    const link = screen.getByRole('link', { name: 'api' })
    // No trigger state, no listeners, no card: `disabled` is how a caller with
    // no hover to offer opts out entirely rather than paying for a card that
    // can never open.
    expect(link.getAttribute('data-state')).toBeNull()
    expect(peek).not.toHaveBeenCalled()
  })
})
