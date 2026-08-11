import { describe, expect, it } from 'vitest'

import { isApplePlatform, matchChord, openChordLabel } from './keys'

/**
 * A keystroke, as a KeyboardEvent-shaped object.
 *
 * Built rather than dispatched: `matchChord` reads six fields and nothing else,
 * and a real event would drag a document into a test about arithmetic on
 * modifiers. `code` defaults to the physical key a US layout would have used
 * for `key`, which is what makes the shifted-digit cases below honest.
 */
function press(over: Partial<KeyboardEvent> = {}): KeyboardEvent {
  return {
    key: '',
    code: '',
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    metaKey: false,
    ...over,
  } as KeyboardEvent
}

describe('matchChord', () => {
  it('opens on Cmd+K on a Mac', () => {
    expect(matchChord(press({ key: 'k', code: 'KeyK', metaKey: true }), true)).toEqual({
      kind: 'open',
    })
  })

  it('leaves Cmd+K alone off a Mac, where Meta belongs to the OS', () => {
    expect(matchChord(press({ key: 'k', code: 'KeyK', metaKey: true }), false)).toBeNull()
  })

  it('opens on Ctrl+Shift+K everywhere, Mac included', () => {
    const chord = press({ key: 'K', code: 'KeyK', ctrlKey: true, shiftKey: true })
    expect(matchChord(chord, false)).toEqual({ kind: 'open' })
    expect(matchChord(chord, true)).toEqual({ kind: 'open' })
  })

  it('reads the shifted letter K, which is what Shift actually produces', () => {
    expect(matchChord(press({ key: 'K', code: 'KeyK', ctrlKey: true, shiftKey: true }), false))
      .toEqual({ kind: 'open' })
  })

  it('ignores plain Ctrl+K, which readline spends on kill-to-end-of-line', () => {
    expect(matchChord(press({ key: 'k', code: 'KeyK', ctrlKey: true }), false)).toBeNull()
  })

  it('steps on the bracket keys by their physical code, under Shift', () => {
    // A US layout reports `}` here, never `]` — the trap the code names.
    const next = press({ key: '}', code: 'BracketRight', ctrlKey: true, shiftKey: true })
    const prev = press({ key: '{', code: 'BracketLeft', ctrlKey: true, shiftKey: true })
    expect(matchChord(next, false)).toEqual({ kind: 'next' })
    expect(matchChord(prev, false)).toEqual({ kind: 'prev' })
  })

  it('also accepts a bracket reported as its unshifted character', () => {
    expect(matchChord(press({ key: ']', code: '', ctrlKey: true, shiftKey: true }), false)).toEqual({
      kind: 'next',
    })
  })

  it('reads Ctrl+Shift+1 as pinned 1 though the layout says !', () => {
    expect(matchChord(press({ key: '!', code: 'Digit1', ctrlKey: true, shiftKey: true }), false))
      .toEqual({ kind: 'pinned', index: 1 })
  })

  it('reads a bare digit too, for the platforms that report one', () => {
    expect(matchChord(press({ key: '9', code: '', ctrlKey: true, shiftKey: true }), false)).toEqual({
      kind: 'pinned',
      index: 9,
    })
  })

  it('has no chord for zero: the badges run 1..9', () => {
    expect(matchChord(press({ key: '0', code: 'Digit0', ctrlKey: true, shiftKey: true }), false))
      .toBeNull()
  })

  it('refuses a chord with Alt riding on it', () => {
    expect(
      matchChord(press({ key: 'K', code: 'KeyK', ctrlKey: true, shiftKey: true, altKey: true }), false),
    ).toBeNull()
  })

  it('refuses Ctrl+Shift+Cmd+K, which is somebody else’s chord', () => {
    expect(
      matchChord(
        press({ key: 'K', code: 'KeyK', ctrlKey: true, shiftKey: true, metaKey: true }),
        true,
      ),
    ).toBeNull()
  })

  it('says nothing about an ordinary letter', () => {
    expect(matchChord(press({ key: 'a', code: 'KeyA' }), true)).toBeNull()
  })
})

describe('isApplePlatform', () => {
  it('believes the client hint when there is one', () => {
    const nav = { userAgentData: { platform: 'macOS' }, platform: 'Linux x86_64' } as unknown as Navigator
    expect(isApplePlatform(nav)).toBe(true)
  })

  it('reads Windows from the hint as not Apple, whatever platform says', () => {
    const nav = {
      userAgentData: { platform: 'Windows' },
      platform: 'MacIntel',
    } as unknown as Navigator
    expect(isApplePlatform(nav)).toBe(false)
  })

  it('falls back to navigator.platform where no hint exists', () => {
    expect(isApplePlatform({ platform: 'MacIntel' } as Navigator)).toBe(true)
    expect(isApplePlatform({ platform: 'Linux x86_64' } as unknown as Navigator)).toBe(false)
  })

  it('counts an iPad, which has a Cmd key when a keyboard is attached', () => {
    expect(isApplePlatform({ platform: 'iPad' } as Navigator)).toBe(true)
  })
})

describe('openChordLabel', () => {
  it('prints the modifier the reader actually has', () => {
    expect(openChordLabel(true)).toBe('⌘K')
    expect(openChordLabel(false)).toBe('Ctrl+Shift+K')
  })
})
