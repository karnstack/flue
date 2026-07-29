import palette from 'tailwindcss/colors'

/**
 * The colours the PWA surface needs as literal values.
 *
 * A web app manifest is static JSON and the iOS status bar is driven by a
 * meta tag, so neither can read a CSS custom property — but neither should
 * carry a hand-picked hex either, or the installed app drifts away from the
 * stylesheet the moment a token moves. Everything here is resolved from the
 * same `tailwindcss/colors` module that produces the `--color-zinc-*` and
 * `--color-amber-*` variables in styles.css.
 */

const OKLCH = /^oklch\(\s*([\d.]+)(%?)\s+([\d.]+)\s+([\d.]+)\s*\)$/i
const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i

/**
 * Convert a Tailwind palette entry to a six-digit sRGB hex.
 *
 * Tailwind v4 states its palette in oklch. Chrome parses a manifest colour
 * with the full CSS colour parser and would cope, but Safari's PWA handling
 * and older Android WebViews do not reliably, and a colour they cannot read
 * falls back to white — a white splash screen on a dark-first terminal. So
 * the conversion happens here, once, at build time.
 *
 * Throws rather than returning a fallback: a silent wrong colour is exactly
 * the failure this function exists to prevent.
 */
export function toHex(css: string): string {
  const value = css.trim()

  const hex = HEX.exec(value)
  if (hex) {
    const digits = hex[1]!.toLowerCase()
    return digits.length === 3
      ? `#${digits[0]!}${digits[0]!}${digits[1]!}${digits[1]!}${digits[2]!}${digits[2]!}`
      : `#${digits}`
  }

  const oklch = OKLCH.exec(value)
  if (!oklch) throw new Error(`toHex: unsupported colour ${css}`)

  // A bare number is already 0..1; a percentage is 0..100.
  const l = Number(oklch[1]) / (oklch[2] === '%' ? 100 : 1)
  const c = Number(oklch[3])
  const h = (Number(oklch[4]) * Math.PI) / 180

  return oklabToHex(l, c * Math.cos(h), c * Math.sin(h))
}

/** Björn Ottosson's oklab -> linear sRGB matrix, then the sRGB transfer curve. */
function oklabToHex(l: number, a: number, b: number): string {
  const lp = l + 0.3963377774 * a + 0.2158037573 * b
  const mp = l - 0.1055613458 * a - 0.0638541728 * b
  const sp = l - 0.0894841775 * a - 1.291485548 * b

  const lc = lp * lp * lp
  const mc = mp * mp * mp
  const sc = sp * sp * sp

  const rgb = [
    4.0767416621 * lc - 3.3077115913 * mc + 0.2309699292 * sc,
    -1.2684380046 * lc + 2.6097574011 * mc - 0.3413193965 * sc,
    -0.0041960863 * lc - 0.7034186147 * mc + 1.707614701 * sc,
  ]

  return `#${rgb.map(encodeChannel).join('')}`
}

function encodeChannel(linear: number): string {
  const gamma =
    linear <= 0.0031308
      ? 12.92 * linear
      : 1.055 * Math.pow(linear, 1 / 2.4) - 0.055
  // Out-of-gamut oklch values land outside 0..1; clamping is the standard
  // treatment and keeps the output a legal colour.
  const byte = Math.round(Math.min(1, Math.max(0, gamma)) * 255)
  return byte.toString(16).padStart(2, '0')
}

/**
 * flue's installable-app chrome.
 *
 * Both the manifest's `theme_color` and its `background_color` are the dark
 * canvas, not the accent. Amber is the single accent and carries active nav
 * state, focus rings and the one primary button per screen; browser chrome
 * and the splash screen are surfaces, so they take the canvas colour. Amber
 * appears in the app icon, where it is a mark rather than a surface.
 */
export const chrome = {
  canvasLight: toHex(palette.white),
  canvasDark: toHex(palette.zinc[950]),
  accent: toHex(palette.amber[500]),
} as const
