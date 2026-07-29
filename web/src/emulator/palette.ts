import type { TerminalTheme } from './types'

/**
 * The colours flue's terminal wears.
 *
 * Two palettes, chosen by `prefers-color-scheme`, because that is how the rest
 * of the app themes itself and there is no toggle to offer instead.
 *
 * The split that matters: the four surface roles — background, foreground,
 * cursor, selection — are flue's, and follow the design system's zinc neutrals
 * with amber for the cursor, the one place an accent belongs in a terminal.
 * The sixteen ANSI slots are the *program's*, and stay a conventional palette:
 * a program that asked for red asked for red, and answering in amber would be
 * flue misreporting its own output. They are drawn from the same Tailwind
 * ramps as the chrome, so the two read as one product without either pretending
 * to be the other.
 *
 * These are literal sRGB hex rather than the CSS tokens, and cannot be derived
 * from them. xterm parses hex, rgb() and named colours; Tailwind v4 emits its
 * palette as `oklch(...)`, which xterm's colour parser does not accept, and
 * WebGL rendering never touches CSS at all. So the values below are the sRGB
 * renderings of --color-zinc-* and --color-amber-*, kept by hand. If the
 * design system's neutral ever moves off zinc, this file moves with it.
 */

// Tailwind zinc, as sRGB.
const ZINC_50 = '#fafafa'
const ZINC_300 = '#d4d4d8'
const ZINC_600 = '#52525b'
const ZINC_800 = '#27272a'
const ZINC_900 = '#18181b'
const ZINC_950 = '#09090b'

// Tailwind amber, as sRGB. The accent, and in a terminal the cursor is the
// only thing that should carry it.
const AMBER_400 = '#fbbf24'
const AMBER_600 = '#d97706'

/**
 * Dark: zinc-950 canvas, matching --flue-canvas in the dark block.
 *
 * ANSI black is zinc-800, not #000. On a near-black canvas a true-black
 * "black" is invisible, and plenty of programs colour ordinary punctuation
 * with it.
 */
export const TERMINAL_PALETTE_DARK: TerminalTheme = {
  background: ZINC_950,
  foreground: '#e4e4e7',
  cursor: AMBER_400,
  cursorAccent: ZINC_950,
  // Alpha rather than a flat colour, so a selection over coloured output still
  // shows what it is sitting on.
  selectionBackground: 'rgba(250, 250, 250, 0.22)',
  selectionInactiveBackground: 'rgba(250, 250, 250, 0.12)',

  black: ZINC_800,
  red: '#f87171',
  green: '#4ade80',
  yellow: '#fbbf24',
  blue: '#60a5fa',
  magenta: '#c084fc',
  cyan: '#22d3ee',
  white: ZINC_300,
  brightBlack: ZINC_600,
  brightRed: '#fca5a5',
  brightGreen: '#86efac',
  brightYellow: '#fcd34d',
  brightBlue: '#93c5fd',
  brightMagenta: '#d8b4fe',
  brightCyan: '#67e8f9',
  brightWhite: ZINC_50,
}

/**
 * Light: white canvas, matching --flue-canvas in :root.
 *
 * The ANSI slots drop to the 600/700 ramps. The 400s used above are chosen for
 * contrast against near-black and are close to unreadable on white — yellow
 * especially, which is why terminal light themes are usually worse than their
 * dark counterparts and why this one does not simply reuse the palette.
 */
export const TERMINAL_PALETTE_LIGHT: TerminalTheme = {
  background: '#ffffff',
  foreground: ZINC_900,
  cursor: AMBER_600,
  cursorAccent: '#ffffff',
  selectionBackground: 'rgba(9, 9, 11, 0.16)',
  selectionInactiveBackground: 'rgba(9, 9, 11, 0.08)',

  black: ZINC_800,
  red: '#dc2626',
  green: '#16a34a',
  yellow: '#a16207',
  blue: '#2563eb',
  magenta: '#9333ea',
  cyan: '#0891b2',
  white: ZINC_300,
  brightBlack: ZINC_600,
  brightRed: '#b91c1c',
  brightGreen: '#15803d',
  brightYellow: '#854d0e',
  brightBlue: '#1d4ed8',
  brightMagenta: '#7e22ce',
  brightCyan: '#0e7490',
  brightWhite: ZINC_50,
}

/** The media query the whole app themes by. There is no toggle. */
export const DARK_SCHEME_QUERY = '(prefers-color-scheme: dark)'

export function terminalPalette(dark: boolean): TerminalTheme {
  return dark ? TERMINAL_PALETTE_DARK : TERMINAL_PALETTE_LIGHT
}

/**
 * Whether the OS is asking for a dark UI right now.
 *
 * Defaults to dark when `matchMedia` is missing. A terminal that guesses wrong
 * on a dark desktop flashes white across the whole viewport; guessing wrong on
 * a light one is a dark rectangle, which is what a terminal usually looks like
 * anyway.
 */
export function prefersDark(): boolean {
  return globalThis.matchMedia?.(DARK_SCHEME_QUERY).matches ?? true
}
