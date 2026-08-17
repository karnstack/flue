import { describe, expect, it } from 'vitest'

import { matchSplitChord, splitChordLabel } from './split-keys'

function key(over: Partial<KeyboardEvent>): KeyboardEvent {
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

describe('matchSplitChord', () => {
  it('reads ⌘D as a side-by-side split and ⇧⌘D as a stacked one on a Mac', () => {
    expect(matchSplitChord(key({ metaKey: true, key: 'd', code: 'KeyD' }), true)).toBe('row')
    expect(
      matchSplitChord(key({ metaKey: true, shiftKey: true, key: 'D', code: 'KeyD' }), true),
    ).toBe('column')
  })

  it('reads Ctrl+Shift+D and Ctrl+Alt+Shift+D elsewhere', () => {
    expect(
      matchSplitChord(key({ ctrlKey: true, shiftKey: true, key: 'D', code: 'KeyD' }), false),
    ).toBe('row')
    expect(
      matchSplitChord(
        key({ ctrlKey: true, shiftKey: true, altKey: true, key: 'D', code: 'KeyD' }),
        false,
      ),
    ).toBe('column')
  })

  it('never claims plain Ctrl+D — that is the shell EOF, not ours', () => {
    expect(matchSplitChord(key({ ctrlKey: true, key: 'd', code: 'KeyD' }), false)).toBeNull()
    expect(matchSplitChord(key({ ctrlKey: true, key: 'd', code: 'KeyD' }), true)).toBeNull()
  })

  it('refuses extra modifiers riding along', () => {
    expect(
      matchSplitChord(key({ metaKey: true, ctrlKey: true, key: 'd', code: 'KeyD' }), true),
    ).toBeNull()
    expect(
      matchSplitChord(
        key({ ctrlKey: true, shiftKey: true, metaKey: true, key: 'D', code: 'KeyD' }),
        false,
      ),
    ).toBeNull()
  })

  it('matches on the physical key when the layout produced another character', () => {
    // Shift over a non-US layout can spell D as something else entirely;
    // `code` names the key itself, as the switcher's brackets do.
    expect(matchSplitChord(key({ metaKey: true, key: 'Δ', code: 'KeyD' }), true)).toBe('row')
  })

  it('ignores other keys entirely', () => {
    expect(matchSplitChord(key({ metaKey: true, key: 'e', code: 'KeyE' }), true)).toBeNull()
  })
})

describe('splitChordLabel', () => {
  it('prints the platform spelling', () => {
    expect(splitChordLabel(true, 'row')).toBe('⌘D')
    expect(splitChordLabel(true, 'column')).toBe('⇧⌘D')
    expect(splitChordLabel(false, 'row')).toBe('Ctrl+Shift+D')
    expect(splitChordLabel(false, 'column')).toBe('Ctrl+Alt+Shift+D')
  })
})
