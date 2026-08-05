import { afterEach, describe, expect, it } from 'vitest'

import { THEME_SYSTEM } from '@/emulator/themes'
import { loadSessionTheme, saveSessionTheme } from './session-theme'

afterEach(() => localStorage.clear())

describe('session theme storage', () => {
  it('round-trips per session', () => {
    saveSessionTheme('s1', 'dracula')
    saveSessionTheme('s2', 'nord')
    expect(loadSessionTheme('s1')).toBe('dracula')
    expect(loadSessionTheme('s2')).toBe('nord')
  })

  it('an unset session is system', () => {
    expect(loadSessionTheme('never-seen')).toBe(THEME_SYSTEM)
  })

  it('choosing system removes the key rather than storing a default', () => {
    saveSessionTheme('s1', 'dracula')
    saveSessionTheme('s1', THEME_SYSTEM)
    expect(localStorage.getItem('flue:theme:s1')).toBeNull()
    expect(loadSessionTheme('s1')).toBe(THEME_SYSTEM)
  })
})
