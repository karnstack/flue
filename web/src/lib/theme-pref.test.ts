import { afterEach, describe, expect, it } from 'vitest'

import { THEME_SYSTEM } from '@/emulator/themes'
import { loadThemePref, onThemePref, saveThemePref, THEME_PREF_KEY } from './theme-pref'

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

  it('announces every save to this document — how a split repaints all its panes', () => {
    // The storage event only reaches other tabs, so with several terminals
    // in one document (a split, the scratch modal) this listener is the only
    // way a sibling pane hears the choice.
    const heard: string[] = []
    const offA = onThemePref((id) => heard.push(`a:${id}`))
    const offB = onThemePref((id) => heard.push(`b:${id}`))
    saveThemePref('dracula')
    expect(heard).toEqual(['a:dracula', 'b:dracula'])

    // System announces too — back-to-default must sweep the panes as well.
    saveThemePref(THEME_SYSTEM)
    expect(heard.slice(2)).toEqual([`a:${THEME_SYSTEM}`, `b:${THEME_SYSTEM}`])

    // An unsubscribed listener stays quiet, and only its own registration
    // retires.
    offA()
    saveThemePref('nord')
    expect(heard.slice(4)).toEqual(['b:nord'])
    offB()
    saveThemePref('dracula')
    expect(heard).toHaveLength(5)
  })
})
