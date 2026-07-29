import { describe, expect, it } from 'vitest'
import { buildManifest } from './manifest'
import { chrome } from './theme'

const manifest = buildManifest()

describe('buildManifest', () => {
  it('installs as a standalone app rather than a browser tab', () => {
    expect(manifest.display).toBe('standalone')
  })

  // `flue open` hands the browser a URL carrying ?h=<one-time handoff token>.
  // A start_url that captured it would pin a spent, single-use credential
  // into the installed app for good, and every launch after the first would
  // land on a 401.
  it('starts at the bare origin, never at a captured handoff URL', () => {
    expect(manifest.start_url).toBe('/')
    expect(manifest.scope).toBe('/')
    expect(manifest.start_url).not.toContain('h=')
  })

  it('takes its chrome colours from the design tokens', () => {
    expect(manifest.theme_color).toBe(chrome.canvasDark)
    expect(manifest.background_color).toBe(chrome.canvasDark)
  })

  it('ships the icon sizes Android installs from', () => {
    const any = manifest.icons.filter((i) => i.purpose === 'any')
    expect(any.map((i) => i.sizes).sort()).toEqual(['192x192', '512x512'])
  })

  it('ships maskable icons at the same sizes', () => {
    const maskable = manifest.icons.filter((i) => i.purpose === 'maskable')
    expect(maskable.map((i) => i.sizes).sort()).toEqual(['192x192', '512x512'])
  })

  it('references every icon by a root-relative path', () => {
    expect(manifest.icons.length).toBeGreaterThan(0)
    for (const icon of manifest.icons) {
      expect(icon.src.startsWith('/')).toBe(true)
      expect(icon.type).toBe('image/png')
    }
  })

  it('is serialisable as the JSON the manifest link points at', () => {
    expect(() => JSON.parse(JSON.stringify(manifest))).not.toThrow()
  })
})
