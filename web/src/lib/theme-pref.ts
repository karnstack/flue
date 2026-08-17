import { THEME_SYSTEM } from '@/emulator/themes'

/**
 * The terminal theme preference: one choice, every session.
 *
 * Global on purpose — choosing a theme in one session applies to all of
 * them, and a session spawned out of another wears the same clothes with no
 * inheritance machinery at all. Per-session themes can come back later by
 * suffixing the key.
 *
 * A change travels two ways, because the browser splits the audience in two.
 * The storage event reaches every *other* tab — and only them; the document
 * that wrote never hears it. The listeners below are the other half: every
 * terminal mounted in *this* document — the panes of a split, the scratch
 * modal — hears a save the moment it is made. Before splits there was one
 * terminal per document and the first half sufficed; a theme picked from a
 * split's menu then repainted exactly one pane and left its siblings in the
 * old clothes until remount.
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
  // Announced whether or not the write stuck: the panes on screen should
  // follow the choice even where storage refuses to remember it.
  for (const cb of [...listeners]) cb(themeId)
}

type ThemePrefListener = (themeId: string) => void

const listeners = new Set<ThemePrefListener>()

/**
 * Hear theme choices made in this document — the half the storage event
 * cannot deliver. Every mounted terminal subscribes; the returned
 * unsubscribe retires exactly this registration.
 */
export function onThemePref(cb: ThemePrefListener): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}
