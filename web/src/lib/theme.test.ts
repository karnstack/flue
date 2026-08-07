import { describe, expect, it } from 'vitest'
import palette from 'tailwindcss/colors'
import { chrome, toHex } from './theme'

describe('toHex', () => {
  it('normalises a short hex to six digits', () => {
    expect(toHex('#fff')).toBe('#ffffff')
    expect(toHex('#09F')).toBe('#0099ff')
  })

  it('passes a six-digit hex through, lowercased', () => {
    expect(toHex('#F59E0B')).toBe('#f59e0b')
  })

  // Tailwind v4 states its palette in oklch. A web app manifest is parsed by
  // the browser's own colour parser, and a value it cannot read is silently
  // replaced by the default white — which on a dark-first app means a white
  // splash flash. These assertions pin the conversion against the sRGB hexes
  // Tailwind v4 publishes for the same swatches. They are NOT the v3 hexes:
  // v4 restated the palette in oklch and several swatches moved (teal-500
  // was #14b8a6 in v3, zinc-500 was #71717a). Each expectation below was
  // cross-checked against a second, independent conversion route
  // (oklab -> LMS -> XYZ D65 -> linear sRGB, CSS Color 4 matrices).
  it('converts the zinc-950 oklch swatch to its published sRGB hex', () => {
    expect(toHex(palette.zinc[950])).toBe('#09090b')
  })

  it('converts the teal-500 oklch swatch to its published sRGB hex', () => {
    expect(toHex(palette.teal[500])).toBe('#00bba7')
  })

  it('converts a mid-chroma neutral, where a matrix sign error would show', () => {
    expect(toHex(palette.zinc[500])).toBe('#71717b')
  })

  // Tailwind v4 targets P3, so parts of its ramps sit outside sRGB (teal's
  // greens clip on the red channel). Clamping is what keeps the manifest a
  // legal colour rather than a negative-channel string.
  it('clamps a colour outside the sRGB gamut instead of emitting garbage', () => {
    expect(toHex('oklch(100% 0.4 30)')).toMatch(/^#[0-9a-f]{6}$/)
    expect(toHex(palette.teal[500])).toMatch(/^#[0-9a-f]{6}$/)
  })

  // Tailwind v4 states achromatic swatches with a missing hue —
  // `oklch(98.5% 0 none)` — which CSS Color 4 defines as "treat as zero".
  // 13 entries in the palette look like this, zinc-50 among them, and
  // zinc-50 is already the dark theme's --foreground. Because vite.config.ts
  // imports this module at config-load time, throwing here does not fail a
  // test, it fails the whole build.
  it('accepts a missing component, as CSS Color 4 requires', () => {
    expect(toHex(palette.zinc[50])).toBe('#fafafa')
    expect(toHex('oklch(none none none)')).toBe('#000000')
  })

  it('converts every swatch in the palette without throwing', () => {
    for (const entry of Object.values(palette)) {
      const swatches = typeof entry === 'string' ? [entry] : Object.values(entry)
      for (const swatch of swatches) {
        // Keywords, not colours: nothing to convert.
        if (/^(inherit|currentcolor|transparent)$/i.test(swatch)) continue
        expect(toHex(swatch)).toMatch(/^#[0-9a-f]{6}$/)
      }
    }
  })

  it('rejects a colour it cannot parse rather than guessing', () => {
    expect(() => toHex('rebeccapurple')).toThrow()
    expect(() => toHex('oklch(50%)')).toThrow()
  })
})

describe('chrome', () => {
  it('derives every value from the zinc/teal palette, never a literal', () => {
    expect(chrome.canvasDark).toBe(toHex(palette.zinc[950]))
    expect(chrome.canvasLight).toBe(toHex(palette.white))
    expect(chrome.accent).toBe(toHex(palette.teal[500]))
  })

  it('emits hexes a manifest parser accepts', () => {
    for (const value of Object.values(chrome)) {
      expect(value).toMatch(/^#[0-9a-f]{6}$/)
    }
  })
})
