import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildManifest } from './manifest'
import { chrome } from './theme'

const manifest = buildManifest()
// Vitest resolves the cwd to the Vite root, which is web/. Not
// import.meta.url: Vite rewrites that to an http URL under the test
// transform, and fileURLToPath then rejects it.
const PUBLIC = join(process.cwd(), 'public')

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

  // The manifest is only as good as the files it names. A renamed or missing
  // icon does not fail the build, does not fail any other test here, and
  // shows up only as an install prompt that never appears — so read the
  // committed PNGs and check they are the size the manifest advertises.
  it('names icons that exist, are PNGs, and are the advertised size', () => {
    for (const icon of manifest.icons) {
      const [width, height] = icon.sizes.split('x').map(Number)
      expect(pngSize(icon.src)).toEqual({ width, height })
    }
  })

  it('ships the apple-touch icon index.html points at', () => {
    expect(pngSize('/icons/apple-touch-icon.png')).toEqual({
      width: 180,
      height: 180,
    })
  })
})

/** Read a committed icon's real dimensions out of its PNG IHDR chunk. */
function pngSize(src: string) {
  const bytes = readFileSync(join(PUBLIC, src))
  expect(bytes.subarray(1, 4).toString('latin1')).toBe('PNG')
  expect(bytes.subarray(12, 16).toString('latin1')).toBe('IHDR')
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
}
