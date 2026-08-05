import { describe, expect, it } from 'vitest'

import { TERMINAL_PALETTE_DARK, TERMINAL_PALETTE_LIGHT } from './palette'
import { resolveTheme, THEME_PRESETS, THEME_SYSTEM } from './themes'
import type { TerminalTheme } from './types'

/** Every slot a complete terminal theme carries. A preset missing one falls
 *  back to xterm's own default for that slot — a theme wearing another
 *  theme's red — so completeness is asserted, not assumed. */
const REQUIRED: Array<keyof TerminalTheme> = [
  'background',
  'foreground',
  'cursor',
  'cursorAccent',
  'selectionBackground',
  'selectionInactiveBackground',
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
  'brightBlack',
  'brightRed',
  'brightGreen',
  'brightYellow',
  'brightBlue',
  'brightMagenta',
  'brightCyan',
  'brightWhite',
]

describe('THEME_PRESETS', () => {
  it('every preset is complete', () => {
    for (const preset of THEME_PRESETS) {
      for (const slot of REQUIRED) {
        expect(preset.theme[slot], `${preset.id} is missing ${slot}`).toBeTruthy()
      }
    }
  })

  it('ids are unique and never the system id', () => {
    const ids = THEME_PRESETS.map((p) => p.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).not.toContain(THEME_SYSTEM)
  })
})

describe('resolveTheme', () => {
  it('a preset is the same palette on either OS scheme — that is the point', () => {
    expect(resolveTheme('dracula', true)).toBe(resolveTheme('dracula', false))
    expect(resolveTheme('dracula', true).background).toBe('#282a36')
  })

  it('system follows the OS scheme with flue’s own pair', () => {
    expect(resolveTheme(THEME_SYSTEM, true)).toBe(TERMINAL_PALETTE_DARK)
    expect(resolveTheme(THEME_SYSTEM, false)).toBe(TERMINAL_PALETTE_LIGHT)
  })

  it('an unknown id resolves as system — stale localStorage must not brick a view', () => {
    expect(resolveTheme('a-preset-we-renamed', true)).toBe(TERMINAL_PALETTE_DARK)
  })
})
