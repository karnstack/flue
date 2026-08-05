import { THEME_SYSTEM } from '@/emulator/themes'

/**
 * The terminal theme preference: one choice, every session.
 *
 * Global on purpose — choosing a theme in one session applies to all of
 * them, and a session spawned out of another wears the same clothes with no
 * inheritance machinery at all. Per-session themes can come back later by
 * suffixing the key; the storage-event listeners in the terminal views are
 * what make a change land in every open tab the moment it is made.
 *
 * Client-side because the daemon holds what a terminal *is*; what it looks
 * like in this browser is this browser's business. Every access is guarded:
 * localStorage itself is optional — private windows and storage-restricted
 * contexts throw on touch — and a terminal that cannot remember its theme
 * still has to render.
 */
export const THEME_PREF_KEY = 'flue:theme'

export function loadThemePref(): string {
  try {
    return localStorage.getItem(THEME_PREF_KEY) ?? THEME_SYSTEM
  } catch {
    return THEME_SYSTEM
  }
}

export function saveThemePref(themeId: string): void {
  try {
    // System is the absence of a choice, not a choice to store — a stored
    // default would survive preset renames as a stale key with no meaning.
    if (themeId === THEME_SYSTEM) localStorage.removeItem(THEME_PREF_KEY)
    else localStorage.setItem(THEME_PREF_KEY, themeId)
  } catch {
    // Nothing to do: the theme still applies for this view's lifetime.
  }
}
