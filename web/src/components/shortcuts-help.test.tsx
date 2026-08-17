import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'

import { helpChordLabel, matchHelpChord, ShortcutsHelp } from './shortcuts-help'

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

describe('matchHelpChord', () => {
  it('reads ⌘/ on a Mac and Ctrl+Shift+/ elsewhere', () => {
    expect(matchHelpChord(key({ metaKey: true, key: '/', code: 'Slash' }), true)).toBe(true)
    expect(
      matchHelpChord(key({ ctrlKey: true, shiftKey: true, key: '?', code: 'Slash' }), false),
    ).toBe(true)
  })

  it('never claims plain Ctrl+/ — that is readline’s undo', () => {
    expect(matchHelpChord(key({ ctrlKey: true, key: '/', code: 'Slash' }), false)).toBe(false)
    expect(matchHelpChord(key({ ctrlKey: true, key: '/', code: 'Slash' }), true)).toBe(false)
  })

  it('refuses extra modifiers and other keys', () => {
    expect(
      matchHelpChord(key({ metaKey: true, shiftKey: true, key: '/', code: 'Slash' }), true),
    ).toBe(false)
    expect(matchHelpChord(key({ metaKey: true, key: 'k', code: 'KeyK' }), true)).toBe(false)
  })

  it('prints the platform spelling', () => {
    expect(helpChordLabel(true)).toBe('⌘/')
    expect(helpChordLabel(false)).toBe('Ctrl+Shift+/')
  })
})

describe('ShortcutsHelp', () => {
  it('opens from the chip and lists every section', async () => {
    render(<ShortcutsHelp chipStyle={{}} />)
    expect(screen.queryByRole('dialog')).toBeNull()

    await userEvent.click(screen.getByRole('button', { name: 'Keyboard shortcuts' }))
    expect(screen.getByRole('dialog')).toBeTruthy()
    for (const label of ['Sessions', 'This session', 'Terminal']) {
      expect(screen.getByRole('heading', { name: label })).toBeTruthy()
    }
    expect(screen.getByText('Split right')).toBeTruthy()
    expect(screen.getByText('Scratch terminal')).toBeTruthy()
  })

  it('hides the chip for a finger, keeping the chord for a hardware keyboard', () => {
    render(<ShortcutsHelp chipStyle={{}} chip={false} />)
    expect(screen.queryByRole('button', { name: 'Keyboard shortcuts' })).toBeNull()
    act(() => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: '?', code: 'Slash', ctrlKey: true, shiftKey: true }),
      )
    })
    expect(screen.getByRole('dialog')).toBeTruthy()
  })

  it('toggles on its own chord', () => {
    render(<ShortcutsHelp chipStyle={{}} />)
    // jsdom's navigator is not a Mac, so the chord is Ctrl+Shift+/.
    const chord = () =>
      act(() => {
        window.dispatchEvent(
          new KeyboardEvent('keydown', { key: '?', code: 'Slash', ctrlKey: true, shiftKey: true }),
        )
      })
    chord()
    expect(screen.getByRole('dialog')).toBeTruthy()
    chord()
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})
