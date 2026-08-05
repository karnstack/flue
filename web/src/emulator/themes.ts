import { terminalPalette } from './palette'
import type { TerminalTheme } from './types'

/**
 * Terminal theme presets.
 *
 * "System" is not in this list because it is not a palette: it is the
 * default behaviour — flue's own light/dark pair, following
 * `prefers-color-scheme` — and `resolveTheme` answers for it. The presets
 * are the classics people already have muscle memory for, values taken from
 * their canonical definitions, not re-derived.
 *
 * Every preset carries all sixteen ANSI slots plus the four surface roles,
 * because a partial theme falls back to xterm's own defaults slot by slot —
 * which is how a theme ends up wearing another theme's red.
 */
export interface ThemePreset {
  id: string
  label: string
  theme: TerminalTheme
}

/** The id meaning "no preset — follow the OS scheme with flue's palette". */
export const THEME_SYSTEM = 'system'

export const THEME_PRESETS: ThemePreset[] = [
  {
    id: 'dracula',
    label: 'Dracula',
    theme: {
      background: '#282a36',
      foreground: '#f8f8f2',
      cursor: '#f8f8f2',
      cursorAccent: '#282a36',
      selectionBackground: 'rgba(248, 248, 242, 0.22)',
      selectionInactiveBackground: 'rgba(248, 248, 242, 0.12)',
      black: '#21222c',
      red: '#ff5555',
      green: '#50fa7b',
      yellow: '#f1fa8c',
      blue: '#bd93f9',
      magenta: '#ff79c6',
      cyan: '#8be9fd',
      white: '#f8f8f2',
      brightBlack: '#6272a4',
      brightRed: '#ff6e6e',
      brightGreen: '#69ff94',
      brightYellow: '#ffffa5',
      brightBlue: '#d6acff',
      brightMagenta: '#ff92df',
      brightCyan: '#a4ffff',
      brightWhite: '#ffffff',
    },
  },
  {
    id: 'nord',
    label: 'Nord',
    theme: {
      background: '#2e3440',
      foreground: '#d8dee9',
      cursor: '#d8dee9',
      cursorAccent: '#2e3440',
      selectionBackground: 'rgba(216, 222, 233, 0.22)',
      selectionInactiveBackground: 'rgba(216, 222, 233, 0.12)',
      black: '#3b4252',
      red: '#bf616a',
      green: '#a3be8c',
      yellow: '#ebcb8b',
      blue: '#81a1c1',
      magenta: '#b48ead',
      cyan: '#88c0d0',
      white: '#e5e9f0',
      brightBlack: '#4c566a',
      brightRed: '#bf616a',
      brightGreen: '#a3be8c',
      brightYellow: '#ebcb8b',
      brightBlue: '#81a1c1',
      brightMagenta: '#b48ead',
      brightCyan: '#8fbcbb',
      brightWhite: '#eceff4',
    },
  },
  {
    id: 'gruvbox-dark',
    label: 'Gruvbox Dark',
    theme: {
      background: '#282828',
      foreground: '#ebdbb2',
      cursor: '#ebdbb2',
      cursorAccent: '#282828',
      selectionBackground: 'rgba(235, 219, 178, 0.22)',
      selectionInactiveBackground: 'rgba(235, 219, 178, 0.12)',
      black: '#282828',
      red: '#cc241d',
      green: '#98971a',
      yellow: '#d79921',
      blue: '#458588',
      magenta: '#b16286',
      cyan: '#689d6a',
      white: '#a89984',
      brightBlack: '#928374',
      brightRed: '#fb4934',
      brightGreen: '#b8bb26',
      brightYellow: '#fabd2f',
      brightBlue: '#83a598',
      brightMagenta: '#d3869b',
      brightCyan: '#8ec07c',
      brightWhite: '#ebdbb2',
    },
  },
  {
    id: 'solarized-light',
    label: 'Solarized Light',
    theme: {
      background: '#fdf6e3',
      foreground: '#657b83',
      cursor: '#657b83',
      cursorAccent: '#fdf6e3',
      selectionBackground: 'rgba(101, 123, 131, 0.22)',
      selectionInactiveBackground: 'rgba(101, 123, 131, 0.12)',
      black: '#073642',
      red: '#dc322f',
      green: '#859900',
      yellow: '#b58900',
      blue: '#268bd2',
      magenta: '#d33682',
      cyan: '#2aa198',
      white: '#eee8d5',
      brightBlack: '#002b36',
      brightRed: '#cb4b16',
      brightGreen: '#586e75',
      brightYellow: '#657b83',
      brightBlue: '#839496',
      brightMagenta: '#6c71c4',
      brightCyan: '#93a1a1',
      brightWhite: '#fdf6e3',
    },
  },
]

/**
 * The palette a theme id names right now.
 *
 * `dark` matters only to THEME_SYSTEM — a preset is the same palette on any
 * OS scheme; that is the point of choosing one. An unknown id resolves as
 * system rather than throwing, because ids arrive from localStorage and a
 * renamed preset must not brick a session's view.
 */
export function resolveTheme(id: string, dark: boolean): TerminalTheme {
  const preset = THEME_PRESETS.find((p) => p.id === id)
  return preset ? preset.theme : terminalPalette(dark)
}

/**
 * What the terminal's floating controls wear under a theme.
 *
 * Derived from the theme's own two surface colours rather than designed per
 * preset: a chip is the terminal's background lifted to translucency with
 * the foreground for text, so the control strip always reads as part of the
 * terminal it floats over — Dracula's chips are Dracula, Solarized Light's
 * are light. Alpha does the rest of the work everywhere, so the values hold
 * on any palette without per-theme tuning.
 */
export interface ControlColors {
  /** The chip's ground: the theme background at 85%. */
  bg: string
  /** Full-strength text — the theme foreground. */
  fg: string
  /** Resting text and quiet dots. */
  dim: string
  /** Hairline borders. */
  ring: string
  /** Hover and highlight wash. */
  wash: string
}

export function controlColors(theme: TerminalTheme): ControlColors {
  const bg = theme.background ?? '#09090b'
  const fg = theme.foreground ?? '#e4e4e7'
  return {
    bg: alpha(bg, 0.85),
    fg,
    dim: alpha(fg, 0.65),
    ring: alpha(fg, 0.18),
    wash: alpha(fg, 0.1),
  }
}

/** #rgb or #rrggbb to rgba(). Anything else comes back unchanged — better a
 *  fully opaque chip than a CSS parse error that drops the declaration. */
function alpha(color: string, a: number): string {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color)
  if (!m) return color
  let hex = m[1]!
  if (hex.length === 3) hex = [...hex].map((c) => c + c).join('')
  const n = parseInt(hex, 16)
  return `rgba(${(n >> 16) & 0xff}, ${(n >> 8) & 0xff}, ${n & 0xff}, ${a})`
}
