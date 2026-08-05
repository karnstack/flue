import { THEME_SYSTEM } from '@/emulator/themes'

/**
 * Per-session theme persistence, in localStorage.
 *
 * Keyed by session id, so the choice follows the session — through reloads,
 * daemon restarts (revival keeps the id), and every tab looking at it from
 * this browser. Client-side on purpose: the daemon holds what a terminal
 * *is*; what it looks like in this browser is this browser's business.
 *
 * Every access is guarded because localStorage itself is optional — private
 * windows and storage-restricted contexts throw on touch, and a terminal
 * that cannot remember its theme still has to render.
 */
const key = (sessionId: string) => `flue:theme:${sessionId}`

export function loadSessionTheme(sessionId: string): string {
  try {
    return localStorage.getItem(key(sessionId)) ?? THEME_SYSTEM
  } catch {
    return THEME_SYSTEM
  }
}

export function saveSessionTheme(sessionId: string, themeId: string): void {
  try {
    // System is the absence of a choice, not a choice to store — a stored
    // default would survive preset renames as a stale key with no meaning.
    if (themeId === THEME_SYSTEM) localStorage.removeItem(key(sessionId))
    else localStorage.setItem(key(sessionId), themeId)
  } catch {
    // Nothing to do: the theme still applies for this view's lifetime.
  }
}
