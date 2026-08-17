/*
 * The switcher's chords, and the reasons each one is the shape it is.
 *
 * Every binding here has to survive three things at once: a browser that
 * reserves some combinations outright, a terminal underneath that would
 * otherwise swallow the keystroke and send it to a shell, and a keyboard layout
 * this code has never heard of. What is left after those three is narrower than
 * it looks, which is why the choices are written down rather than assumed.
 */

/** What a keystroke asked the switcher to do, if it asked for anything. */
export type SwitcherChord =
  | { kind: 'open' }
  | { kind: 'next' }
  | { kind: 'prev' }
  /** One-based, as the badge on the row reads. */
  | { kind: 'pinned'; index: number }

/**
 * The UA-Client-Hints platform string, which TypeScript's DOM lib does not
 * declare. Absent everywhere but Chromium, which is what the fallback is for.
 */
interface UADataLike {
  platform?: string
}

/**
 * Whether this is a Mac keyboard: whether Cmd+K opens the palette, which
 * glyphs the hints print, and whether the terminal keeps Ctrl+C as the
 * interrupt over a selection (see XtermOptions.macKeyboard).
 *
 * `navigator.platform` is deprecated and every engine still answers it, which
 * for this question is the right trade: the modern replacement is Chromium-only
 * and the consequence of guessing wrong is a hint that names the other
 * platform's modifier — the universal chord below works either way.
 *
 * iPadOS is deliberately included. It reports `MacIntel`, it has a Cmd key when
 * a keyboard is attached, and a hint saying Ctrl+Shift there would be wrong.
 */
export function isApplePlatform(nav: Navigator = navigator): boolean {
  const hinted = (nav as Navigator & { userAgentData?: UADataLike }).userAgentData?.platform
  if (typeof hinted === 'string' && hinted !== '') return hinted === 'macOS'
  return /mac|iphone|ipad|ipod/i.test(nav.platform ?? '')
}

/**
 * What the switcher should do about a keystroke, or null for "not ours".
 *
 * Two families, and both are always live regardless of platform. Cmd+K is what
 * every app with a palette in it has taught people to press, and on a Mac it
 * costs nothing to take: the terminal never sends a Cmd-modified key to the
 * shell, so unlike Ctrl+K — which readline spends on kill-to-end-of-line — no
 * shell binding is lost to it. Ctrl+Shift+K is the one that works on Linux and
 * Windows, where there is no Cmd at all, and it stays bound on a Mac too so
 * that a single chord can be documented for everybody. It also lands in the
 * family Ctrl+Shift+Enter already opened (lib/keyboard.ts): Ctrl+Shift is what
 * a terminal emulator conventionally reserves for its own chrome.
 *
 * `metaKey` is excluded from the Ctrl+Shift family and `ctrlKey` from Cmd+K, so
 * a chord with an extra modifier riding on it is somebody else's.
 */
export function matchChord(e: KeyboardEvent, apple: boolean): SwitcherChord | null {
  if (e.altKey) return null

  // Cmd+K. Guarded on the platform rather than merely on metaKey, because on
  // Windows the Meta key is the Start key and taking it would fight the OS.
  if (apple && e.metaKey && !e.ctrlKey && !e.shiftKey && letter(e) === 'k') {
    return { kind: 'open' }
  }

  if (!e.ctrlKey || !e.shiftKey || e.metaKey) return null

  if (letter(e) === 'k') return { kind: 'open' }

  /*
   * The bracket pair, matched on `code` first.
   *
   * This is the trap the digits below share: `key` is the character the layout
   * *produces*, and Shift is held. On a US layout Ctrl+Shift+] arrives as `}`,
   * never as `]`, so a comparison against the unshifted character matches
   * nothing at all. `code` names the physical key and is stable under Shift,
   * which is exactly the question being asked — with the known cost that a
   * Dvorak typist's physical BracketRight is somewhere else on their board.
   * Hence both: the physical key, or either character it could have produced.
   */
  if (e.code === 'BracketRight' || e.key === ']' || e.key === '}') return { kind: 'next' }
  if (e.code === 'BracketLeft' || e.key === '[' || e.key === '{') return { kind: 'prev' }

  /*
   * Ctrl+Shift+1..9, and not Cmd+1..9, which Chrome spends on tab switching and
   * a page cannot preventDefault. Shifted digits are the same trap as the
   * brackets and worse — Ctrl+Shift+1 is `!` on a US layout, `"` on a UK one —
   * so `code` leads and the bare digit is accepted behind it for the layouts
   * and platforms that report one.
   */
  const digit = e.code.startsWith('Digit') ? e.code.slice(5) : e.key
  if (/^[1-9]$/.test(digit)) return { kind: 'pinned', index: Number(digit) }

  return null
}

/** The letter a keystroke produced, folded to lower case. Shift makes `K`. */
function letter(e: KeyboardEvent): string {
  return e.key.length === 1 ? e.key.toLowerCase() : ''
}

/** How the open chord should be printed, for hints and tooltips. */
export function openChordLabel(apple: boolean): string {
  return apple ? '⌘K' : 'Ctrl+Shift+K'
}
