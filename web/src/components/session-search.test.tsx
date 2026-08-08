import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SessionSearch } from './session-search'

/** The pause the field waits out before it reports. Mirrors the component. */
const SETTLE_MS = 150

/**
 * Keystrokes as `fireEvent`, deliberately, where the rest of this suite reaches
 * for `userEvent`.
 *
 * Every case here holds the clock still to measure a delay, and `userEvent`
 * cannot type while it is held: its own inter-key wait is a timer, so it
 * blocks on a clock nobody is advancing. Handing it `advanceTimers` does not
 * rescue it under this React and this jsdom — the wait resolves and the typing
 * never continues — and `shouldAdvanceTime` rescues it by letting real time
 * through, which is precisely what a 150ms assertion must not depend on.
 *
 * The fidelity given up is small: this is a controlled field, so a keystroke
 * reaches it as one change event carrying the whole value, which is exactly
 * what is fired below, one per letter.
 */
function type(text: string) {
  for (let at = 1; at <= text.length; at++) {
    fireEvent.change(field(), { target: { value: text.slice(0, at) } })
  }
}

/** Let the pause expire, inside act, so React sees the state it produces. */
async function settle(ms = SETTLE_MS) {
  await act(() => vi.advanceTimersByTimeAsync(ms))
}

const field = () => screen.getByLabelText('Search sessions') as HTMLInputElement

function mount(value = '') {
  const onChange = vi.fn()
  const view = render(<SessionSearch value={value} onChange={onChange} />)
  return { ...view, onChange }
}

describe('SessionSearch', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('is a named field carrying the search it was handed', () => {
    mount('api')
    expect(field().value).toBe('api')
  })

  it('collapses a burst of keystrokes into one report', async () => {
    const { onChange } = mount()

    type('api')

    // Three keystrokes, nothing said yet: each one re-armed the pause, so the
    // sessions list is never cut down to what matches `a`.
    expect(onChange).not.toHaveBeenCalled()
    expect(field().value).toBe('api')

    await settle()

    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith('api')
  })

  it('waits out the whole pause after the last keystroke, not the first', async () => {
    const { onChange } = mount()

    type('ap')
    await settle(SETTLE_MS - 20)
    type('api')
    await settle(SETTLE_MS - 20)

    expect(onChange).not.toHaveBeenCalled()

    await settle(20)

    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith('api')
  })

  it('reports the empty search when the field is cleared', async () => {
    // Clearing means "show everything", which is a report like any other; a
    // pause that only ever fired on text would leave the sessions list cut
    // down by a word nobody can read any more.
    const { onChange } = mount('api')

    fireEvent.change(field(), { target: { value: '' } })
    await settle()

    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith('')
  })

  it('says nothing at all when it is only re-rendered', async () => {
    const { onChange, rerender } = mount('api')

    rerender(<SessionSearch value="api" onChange={onChange} />)
    await settle()

    expect(onChange).not.toHaveBeenCalled()
  })

  it('drops a pending report when it leaves', async () => {
    // Cancelled rather than flushed. The pause exists because the reader is
    // still typing, and half a word arriving after the screen has been
    // navigated away from would narrow a list nobody is looking at — and,
    // once there are saved views, be written down as part of one.
    const { onChange, unmount } = mount()

    type('api')
    unmount()
    await settle()

    expect(onChange).not.toHaveBeenCalled()
  })

  it('adopts a search the view changed underneath it', async () => {
    // Saved-view tabs swap the whole arrangement, the search along with it.
    const { onChange, rerender } = mount('api')

    rerender(<SessionSearch value="ops" onChange={onChange} />)

    expect(field().value).toBe('ops')

    await settle()

    // And adopting is not reporting: echoing the value back at whoever just
    // set it is how two of these end up arguing with each other forever.
    expect(onChange).not.toHaveBeenCalled()
  })

  it('keeps the keystrokes it reported when the caller echoes them back', async () => {
    const { onChange, rerender } = mount()

    type('api')
    await settle()
    rerender(<SessionSearch value="api" onChange={onChange} />)

    expect(field().value).toBe('api')
    expect(onChange).toHaveBeenCalledTimes(1)
  })

  it('reports again when typing resumes after a report', async () => {
    const { onChange, rerender } = mount()

    type('api')
    await settle()
    rerender(<SessionSearch value="api" onChange={onChange} />)
    type('apis')
    await settle()

    expect(onChange).toHaveBeenNthCalledWith(2, 'apis')
  })
})
