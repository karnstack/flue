import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createKeyboardModes } from './keyboard'

/** Install a Keyboard Lock API, or remove it when given nothing. */
function keyboardApi(api?: { lock: () => Promise<void>; unlock: () => void }) {
  Object.defineProperty(navigator, 'keyboard', { value: api, configurable: true })
}

/** Pretend the browser is showing `el` fullscreen. */
function fullscreen(el: Element | null) {
  Object.defineProperty(document, 'fullscreenElement', { value: el, configurable: true })
}

/**
 * A faithful `requestFullscreen` double.
 *
 * The real one resolves only once the transition is done, so
 * `document.fullscreenElement` is already set by the time the promise settles.
 * A double that only resolves is a double a caller cannot tell success from
 * failure with, and jsdom implements none of this itself.
 */
function grantsFullscreen(el: HTMLElement) {
  const fn = vi.fn(async () => {
    fullscreen(el)
  })
  el.requestFullscreen = fn
  return fn
}

describe('createKeyboardModes', () => {
  let el: HTMLElement

  beforeEach(() => {
    el = document.createElement('div')
    document.body.appendChild(el)
    fullscreen(null)
    document.exitFullscreen = vi.fn(async () => {
      fullscreen(null)
    })
  })

  afterEach(() => {
    el.remove()
    keyboardApi(undefined)
    fullscreen(null)
  })

  it('starts in tab mode, where the browser keeps Cmd+*', () => {
    const k = createKeyboardModes(el)
    expect(k.mode()).toBe('tab')
    k.dispose()
  })

  it('requests fullscreen and keyboard lock when entering focus mode', async () => {
    const requestFullscreen = grantsFullscreen(el)
    const lock = vi.fn().mockResolvedValue(undefined)
    keyboardApi({ lock, unlock: vi.fn() })

    const k = createKeyboardModes(el)
    await k.enterFocus()

    expect(requestFullscreen).toHaveBeenCalled()
    expect(lock).toHaveBeenCalled()
    expect(k.mode()).toBe('focus')
    k.dispose()
  })

  it('stays in tab mode when the Keyboard Lock API is unavailable', async () => {
    // And does not go fullscreen either. Fullscreen without the lock keeps
    // none of the browser's shortcuts out of the browser's hands and loses
    // every one of tab mode's benefits, so it is strictly worse than staying.
    const requestFullscreen = grantsFullscreen(el)
    keyboardApi(undefined)

    const k = createKeyboardModes(el)
    await k.enterFocus()

    expect(k.mode()).toBe('tab')
    expect(requestFullscreen).not.toHaveBeenCalled()
    k.dispose()
  })

  it('releases the lock when leaving focus mode', async () => {
    const unlock = vi.fn()
    grantsFullscreen(el)
    keyboardApi({ lock: vi.fn().mockResolvedValue(undefined), unlock })

    const k = createKeyboardModes(el)
    await k.enterFocus()
    await k.exitFocus()

    expect(unlock).toHaveBeenCalled()
    expect(document.exitFullscreen).toHaveBeenCalled()
    expect(k.mode()).toBe('tab')
    k.dispose()
  })

  it('backs out of fullscreen when the lock itself is refused', async () => {
    // Chromium refuses lock() outside a secure context, and other engines
    // refuse it outright. Leaving the page fullscreen after that is the worst
    // of both modes: no browser shortcuts on screen and none captured either.
    grantsFullscreen(el)
    keyboardApi({ lock: vi.fn().mockRejectedValue(new Error('refused')), unlock: vi.fn() })

    const k = createKeyboardModes(el)
    await k.enterFocus()

    expect(k.mode()).toBe('tab')
    expect(document.exitFullscreen).toHaveBeenCalled()
    k.dispose()
  })

  it('stays in tab mode when the browser refuses fullscreen', async () => {
    const lock = vi.fn().mockResolvedValue(undefined)
    el.requestFullscreen = vi.fn().mockRejectedValue(new Error('gesture required'))
    keyboardApi({ lock, unlock: vi.fn() })

    const k = createKeyboardModes(el)
    await k.enterFocus()

    expect(k.mode()).toBe('tab')
    // No point locking the keyboard of a page that is not fullscreen: Chromium
    // only honours the lock in fullscreen, so this would be a lock that
    // captures nothing and that hold-Esc cannot release.
    expect(lock).not.toHaveBeenCalled()
    k.dispose()
  })

  it('does not claim focus mode when fullscreen ended during the lock', async () => {
    // Both steps await, and the user can hold Esc across either one. Reporting
    // focus mode then would leave the view showing a mode the browser is not
    // in, with no further event coming to correct it.
    const unlock = vi.fn()
    grantsFullscreen(el)
    keyboardApi({
      lock: vi.fn(async () => {
        fullscreen(null)
      }),
      unlock,
    })

    const k = createKeyboardModes(el)
    await k.enterFocus()

    expect(k.mode()).toBe('tab')
    expect(unlock).toHaveBeenCalled()
    k.dispose()
  })

  it('returns to tab mode when the browser drops fullscreen on its own', async () => {
    // Chromium's hold-Esc gesture is the documented way out of focus mode, and
    // it is the browser that acts, not the page: nothing calls exitFocus.
    const unlock = vi.fn()
    const seen: string[] = []
    grantsFullscreen(el)
    keyboardApi({ lock: vi.fn().mockResolvedValue(undefined), unlock })

    const k = createKeyboardModes(el, (m) => seen.push(m))
    await k.enterFocus()
    expect(seen).toEqual(['focus'])

    fullscreen(null)
    document.dispatchEvent(new Event('fullscreenchange'))

    expect(k.mode()).toBe('tab')
    expect(unlock).toHaveBeenCalled()
    expect(seen).toEqual(['focus', 'tab'])
    k.dispose()
  })

  it('stops watching fullscreen once disposed', async () => {
    // The listener is on `document`, which outlives every view that mounts one
    // of these. Without a way to release it, a route the user visits twenty
    // times leaves twenty handlers behind, each holding its own closure.
    const unlock = vi.fn()
    grantsFullscreen(el)
    keyboardApi({ lock: vi.fn().mockResolvedValue(undefined), unlock })

    const k = createKeyboardModes(el)
    await k.enterFocus()
    k.dispose()
    unlock.mockClear()

    fullscreen(null)
    document.dispatchEvent(new Event('fullscreenchange'))

    expect(unlock).not.toHaveBeenCalled()
  })

  it('releases a held lock when disposed mid-focus', async () => {
    const unlock = vi.fn()
    grantsFullscreen(el)
    keyboardApi({ lock: vi.fn().mockResolvedValue(undefined), unlock })

    const k = createKeyboardModes(el)
    await k.enterFocus()
    k.dispose()

    expect(unlock).toHaveBeenCalled()
  })

  it('ignores a second enterFocus while already in focus mode', async () => {
    const requestFullscreen = grantsFullscreen(el)
    keyboardApi({ lock: vi.fn().mockResolvedValue(undefined), unlock: vi.fn() })

    const k = createKeyboardModes(el)
    await k.enterFocus()
    await k.enterFocus()

    expect(requestFullscreen).toHaveBeenCalledTimes(1)
    k.dispose()
  })
})
