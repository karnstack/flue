// @vitest-environment node
import { build } from 'vite'
import { beforeAll, describe, expect, it } from 'vitest'

/**
 * Guards the emitted service worker, not its source.
 *
 * Everything asserted here exists only after the bundler and the build plugin
 * have both run, so no source-level test can see it:
 *
 *   - the worker must land at a stable, unhashed /sw.js, because a service
 *     worker's default scope is its own URL's directory and a hashed name
 *     would orphan every previously registered worker instead of updating it;
 *   - the precache list is injected in generateBundle from the real emitted
 *     filenames, and if that injection ever silently stops happening — or
 *     stops including the stylesheet — the worker installs with an incomplete
 *     shell and the offline story is gone while every unit test stays green;
 *   - the worker must be a self-contained classic script. It is registered
 *     without `type: 'module'`, so one `import` statement left in the chunk is
 *     a SyntaxError at registration time in every browser.
 */

interface FlueBuild {
  version: string
  precache: string[]
}

let sw = ''
let injection = ''
let flueBuild: FlueBuild = { version: '', precache: [] }
const emittedAssets: string[] = []

beforeAll(async () => {
  const result = await build({ logLevel: 'silent', build: { write: false } })

  const bundles = (Array.isArray(result) ? result : [result]) as Array<{
    output?: Array<{ fileName?: string; code?: unknown }>
  }>

  for (const bundle of bundles) {
    for (const item of bundle.output ?? []) {
      const name = item.fileName ?? ''
      if (name === 'sw.js') sw = typeof item.code === 'string' ? item.code : ''
      // assets/peek/ is the highlighter — grammars and worker loaded on the
      // first file of a language, runtime-cached, and deliberately never
      // precached; the assertion for that is its own case below.
      if (name.startsWith('assets/peek/')) continue
      if (name.startsWith('assets/') && /\.(js|css)$/.test(name)) emittedAssets.push(name)
    }
  }

  // Without these, every assertion below would vacuously pass on an empty
  // harvest.
  expect(sw.length).toBeGreaterThan(500)
  expect(emittedAssets.length).toBeGreaterThan(1)

  // Parsed rather than string-matched, so an assertion can never accidentally
  // read the worker's own minified source — which does mention /api and /ws,
  // in the list of paths it refuses to cache.
  const match = /^var __FLUE_BUILD__ = (\{.*\});\n/.exec(sw)
  expect(match, 'no __FLUE_BUILD__ injection at the top of sw.js').not.toBeNull()
  injection = match![1]!
  flueBuild = JSON.parse(injection) as FlueBuild
}, 180_000)

describe('emitted service worker', () => {
  it('is emitted at an unhashed path so its scope stays the origin root', () => {
    expect(sw).not.toBe('')
  })

  it('is a self-contained classic script', () => {
    expect(sw).not.toMatch(/(^|[;\s])import\s*[({'"]/)
    expect(sw).not.toMatch(/(^|[;\s])export\s/)
  })

  it('precaches the shell and every emitted build asset', () => {
    expect(flueBuild.precache).toContain('/')
    for (const asset of emittedAssets) {
      // Root-absolute: a bare `assets/...` would resolve against the worker's
      // own URL rather than the origin root.
      expect(flueBuild.precache).toContain(`/${asset}`)
    }
  })

  it('pushes no highlighter chunk onto a device that never opened a file', () => {
    // One chunk per grammar lives under assets/peek/. They load on the first
    // file of their language and the runtime cache keeps them; precaching
    // would download every language against the chance any is ever wanted.
    expect(flueBuild.precache.filter((p) => p.startsWith('/assets/peek/'))).toEqual([])
  })

  it('precaches the stylesheet, not only the script', () => {
    // The list is assembled in a generateBundle hook by reading other
    // plugins' output. Emit the compiled stylesheet after that hook and the
    // worker ships a JS-only precache — an offline load with no styles at
    // all, and nothing else in the suite would notice.
    expect(flueBuild.precache.some((url) => url.endsWith('.css'))).toBe(true)
    expect(flueBuild.precache.some((url) => url.endsWith('.js'))).toBe(true)
  })

  it('carries a build version that changes with the assets', () => {
    expect(flueBuild.version).toBeTruthy()
    expect(flueBuild.version).not.toBe('dev')
  })

  it('never lists the API or the WebSocket as something to cache', () => {
    // The strategy module refuses them by path prefix at request time; this
    // is the build-output backstop, so a later task cannot slip them in by
    // widening the emit filter in vite.config.ts.
    for (const url of flueBuild.precache) {
      expect(url === '/api' || url.startsWith('/api/')).toBe(false)
      expect(url === '/ws' || url.startsWith('/ws/')).toBe(false)
    }
  })

  it('does not precache itself', () => {
    expect(flueBuild.precache).not.toContain('/sw.js')
    expect(injection).not.toContain('sw.js')
  })
})
