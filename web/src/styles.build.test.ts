// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import { beforeAll, describe, expect, it } from 'vitest'

/**
 * Guards on the build output, not on source.
 *
 * The product of the scaffolding task is a compiled stylesheet, and every
 * design decision here is one a later task can undo without touching a line
 * of code that any other test looks at. The specific hazard: `shadcn init`
 * and `shadcn apply --preset` both write
 * `@custom-variant dark (&:is(.dark *))` into the CSS entry, which is an
 * entirely ordinary thing for Tasks 9-14 to run when adding a component.
 * That one line redefines `dark:` to require a `.dark` ancestor. This app
 * has no theme toggle and never sets that class, so every `dark:` utility
 * would compile to a selector that can never match, the app would render
 * light-on-light in dark mode — and a suite that only reads source modules
 * would stay green.
 *
 * Note that src/styles.css excludes `*.test.*` from Tailwind's source
 * scanning. Without that, naming a utility in this file would compile it
 * into the very stylesheet being asserted on.
 */

let css = ''
let html = ''

beforeAll(async () => {
  const result = await build({ logLevel: 'silent', build: { write: false } })

  const bundles = (Array.isArray(result) ? result : [result]) as Array<{
    output?: Array<{ fileName?: string; source?: unknown }>
  }>

  for (const bundle of bundles) {
    for (const item of bundle.output ?? []) {
      const name = item.fileName ?? ''
      const source = typeof item.source === 'string' ? item.source : ''
      if (name.endsWith('.css')) css += source
      if (name.endsWith('.html')) html += source
    }
  }

  // If the harvest above ever silently yields nothing, every assertion below
  // would vacuously pass.
  expect(css.length).toBeGreaterThan(1000)
  expect(html.length).toBeGreaterThan(100)
}, 180_000)

describe('compiled stylesheet', () => {
  it('has no class-based dark variant', () => {
    expect(css).not.toContain(':is(.dark')
    // The descendant form `.dark .dark\:x` that the custom variant compiles to.
    expect(css).not.toContain('.dark .')
  })

  it('drives the dark theme from prefers-color-scheme', () => {
    expect(css).toContain('prefers-color-scheme:dark')
  })

  it('puts every dark: utility inside a prefers-color-scheme query', () => {
    const found = darkUtilities(css)

    // `button.tsx` and `sheet.tsx` between them carry several `dark:`
    // utilities; if this ever reaches zero the assertion has stopped
    // measuring anything.
    expect(found.length).toBeGreaterThan(0)

    for (const { selector, enclosing } of found) {
      expect(
        enclosing.some((prelude) => prelude.includes('prefers-color-scheme:dark')),
        `${selector} is not inside a prefers-color-scheme query`,
      ).toBe(true)
    }
  })

  it('ships zinc as the only neutral', () => {
    // Assembled rather than written out, so that a future reader copying a
    // literal from this file cannot turn the assertion into its own evidence.
    for (const banned of ['gray', 'slate']) {
      expect(css).not.toContain(`-${banned}-`)
    }
    expect(css).toContain('-zinc-')
  })

  it('compiles no utility that only a wire-protocol message name summoned', () => {
    // The daemon's control message for changing a terminal's dimensions has
    // to appear in src/client/ as a quoted string, and a quoted string is a
    // scanner candidate exactly as a className is — it shipped
    // `.resize{resize:both}` until src/styles.css excluded that directory.
    // Naming it here is safe because this file is outside the scan.
    expect(css).not.toMatch(/\.resize\s*\{/)
  })

  it('keeps amber out of every neutral surface token', () => {
    // Amber is the single accent: active nav state, focus rings, and the one
    // primary button. It reaches components only through --primary and
    // --ring, never a background or body-text token.
    for (const token of ['--background:', '--foreground:', '--muted-foreground:']) {
      const at = css.indexOf(token)
      expect(at).toBeGreaterThan(-1)
      expect(css.slice(at, at + 80)).not.toContain('amber')
    }
  })
})

/**
 * Every `.dark\:` selector in the sheet, with the preludes of the blocks
 * enclosing it. A single pass, because `dark:hover:` nests two media queries
 * and "the nearest preceding @media" finds the wrong one.
 */
function darkUtilities(source: string) {
  const found: Array<{ selector: string; enclosing: string[] }> = []
  const stack: string[] = []
  let start = 0

  for (let i = 0; i < source.length; i++) {
    const ch = source[i]
    if (ch === '{') {
      stack.push(source.slice(start, i))
      start = i + 1
    } else if (ch === '}') {
      stack.pop()
      start = i + 1
    } else if (ch === ';') {
      start = i + 1
    } else if (source.startsWith('.dark\\:', i)) {
      const end = source.slice(i).search(/[{,]/)
      found.push({
        selector: source.slice(i, end > 0 ? i + end : i + 40),
        enclosing: [...stack],
      })
    }
  }

  return found
}

describe('the directory held outside the scan', () => {
  /**
   * src/styles.css excludes src/client/ so that the `resize` control message —
   * a quoted string, and therefore a scanner candidate — stops compiling a
   * `.resize` rule. The cost is that a utility class named in there would
   * silently never be compiled, which looks like nothing at all: the markup
   * renders unstyled and no build step complains. A comment alone is not a
   * guard against that, so this is.
   */
  it('names no utility class, because none of it would ever compile', () => {
    const dir = join(dirname(fileURLToPath(import.meta.url)), 'client')
    const files = readdirSync(dir).filter((f) => !f.includes('.test.'))

    expect(files.length).toBeGreaterThan(0)
    for (const file of files) {
      const source = readFileSync(join(dir, file), 'utf8')
      expect(source, `${file} is outside Tailwind's scan; move markup elsewhere`).not.toMatch(
        /className|class=/,
      )
    }
  })
})

describe('compiled document', () => {
  it('carries antialiased on the root element', () => {
    expect(html).toMatch(/<html[^>]*\sclass="[^"]*antialiased/)
  })

  it('carries isolate on the app container', () => {
    expect(html).toMatch(/<div[^>]*\sid="root"[^>]*\sclass="[^"]*isolate/)
  })
})
