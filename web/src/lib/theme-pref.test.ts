import { afterEach, describe, expect, it } from 'vitest'

import { THEME_SYSTEM } from '@/emulator/themes'
import { loadThemePref, saveThemePref, THEME_PREF_KEY } from './theme-pref'

afterEach(() => localStorage.clear())

describe('the theme preference', () => {
  it('round-trips one global choice', () => {
    saveThemePref('dracula')
    expect(loadThemePref()).toBe('dracula')
    saveThemePref('nord')
    expect(loadThemePref()).toBe('nord')
  })

  it('defaults to system', () => {
    expect(loadThemePref()).toBe(THEME_SYSTEM)
  })

  it('choosing system removes the key rather than storing a default', () => {
    saveThemePref('dracula')
    saveThemePref(THEME_SYSTEM)
    expect(localStorage.getItem(THEME_PREF_KEY)).toBeNull()
    expect(loadThemePref()).toBe(THEME_SYSTEM)
  })
})
