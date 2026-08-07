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

  it('keeps teal out of every neutral surface token', () => {
    // Teal is the single accent: active nav state, focus rings, and the one
    // primary button. It reaches components only through --primary and
    // --ring, never a background or body-text token.
    for (const token of ['--background:', '--foreground:', '--muted-foreground:']) {
      const at = css.indexOf(token)
      expect(at).toBeGreaterThan(-1)
      expect(css.slice(at, at + 80)).not.toContain('teal')
    }
  })

  it('leaves the pinch gesture to the browser on the terminal surface', () => {
    // touch-action: none once shipped here and made the page unzoomable on
    // phones; pinch-zoom keeps single-finger drags for the scrollback
    // handler while two fingers still zoom.
    expect(css).toContain('touch-action:pinch-zoom')
    expect(css).not.toContain('touch-action:none')
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

/**
 * Every bare single-word utility rule the build emitted, from the utilities
 * layer only.
 *
 * The layer is the cut that matters. `.xterm` and tw-animate-css's `.shimmer`
 * are ordinary imported CSS living in other layers, and neither has anything
 * to do with what a scanner found in a comment.
 *
 * Single-word, because that is the shape prose produces. A hyphenated
 * candidate like `overflow-hidden` cannot fall out of an English sentence.
 */
function bareUtilities(source: string): Set<string> {
  const at = source.indexOf('@layer utilities{')
  if (at < 0) return new Set()
  const start = source.indexOf('{', at)
  let depth = 0
  let body = ''
  for (let i = start; i < source.length; i++) {
    if (source[i] === '{') depth++
    else if (source[i] === '}' && --depth === 0) {
      body = source.slice(start + 1, i)
      break
    }
  }
  const found = new Set<string>()
  for (const m of body.matchAll(/(^|[}{;])\s*\.([a-z]+)\s*\{/g)) found.add(m[2]!)
  return found
}

/** The text from `at` to the delimiter that closes it. */
function delimited(src: string, at: number): string {
  const open = src[at]
  if (open === '"' || open === "'") {
    const end = src.indexOf(open, at + 1)
    return end < 0 ? '' : src.slice(at, end + 1)
  }
  if (open !== '{' && open !== '(') return ''
  const close = open === '{' ? '}' : ')'
  let depth = 0
  for (let i = at; i < src.length; i++) {
    if (src[i] === open) depth++
    else if (src[i] === close && --depth === 0) return src.slice(at, i)
  }
  return ''
}

/**
 * Every class name this codebase actually puts into markup.
 *
 * Collected from the four routes a class takes here — a `class`/`className`
 * attribute, the `cn`/`clsx`/`cva` helpers, and `classList` — and from the
 * delimited expression that follows each, never from a window of nearby text.
 * A loose window picks up the prose in the next comment, which would
 * allowlist the very thing this is meant to catch.
 */
function classesInMarkup(root: string): Set<string> {
  const SITES =
    /(?:className|class)\s*=\s*|(?:\bcn|\bclsx|\bcva|classList\.(?:add|remove|toggle|replace))\s*(?=\()/g
  const STRINGS = /"([^"]*)"|'([^']*)'|`([^`]*)`/g

  const used = new Set<string>()
  for (const file of sources(root)) {
    if (!/\.(tsx?|jsx?|mjs|html)$/.test(file)) continue
    const src = readFileSync(file, 'utf8')
    for (const site of src.matchAll(SITES)) {
      let at = site.index + site[0].length
      while (at < src.length && /\s/.test(src[at]!)) at++
      for (const s of delimited(src, at).matchAll(STRINGS)) {
        const body = (s[1] ?? s[2] ?? s[3] ?? '').replace(/\$\{[^}]*\}/g, ' ')
        for (const token of body.split(/\s+/)) if (token) used.add(token)
      }
    }
  }
  return used
}

/** Every file inside Tailwind's scan perimeter, as src/styles.css defines it. */
function sources(root: string): string[] {
  const out: string[] = []
  const skip = new Set(['node_modules', 'dist', '.git'])
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (skip.has(e.name)) continue
      const p = join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (!/\.test\./.test(e.name) && !/\.css$/.test(e.name)) out.push(p)
    }
  }
  walk(root)
  return out.filter((p) => !p.includes('/src/testing/') && !p.includes('/src/client/'))
}

describe('utilities compiled from prose rather than from markup', () => {
  /**
   * Rules that ship today, are reachable from no markup at all, and predate
   * the guard. Each is a word a comment happens to contain.
   *
   * Pinned rather than fixed, deliberately: the point of the guard is to stop
   * the *next* one, and rewriting other people's comments to satisfy it would
   * bury that in noise. The list can only shrink — the second assertion below
   * fails on any entry that has stopped being emitted, so fixing one forces
   * its line to be deleted and the baseline cannot rot into fiction.
   */
  const KNOWN_DEAD: Record<string, string> = {
    collapse: 'app-shell.tsx:29 "must collapse rather than shrink."',
    filter: 'scripts/generate-icons.mjs:159 "// filter type: none"',
    outline: 'ui/button.tsx:13 — a cva variant key, not a class',
    rounded: 'scripts/generate-icons.mjs, six mentions of a rounded box',
    running: 'scripts/generate-icons.mjs:5 "builds without running this"',
    static: 'lib/theme.ts:6 and sw.ts:142, both describing static files',
    underline: 'ui/button.tsx:23 "The underline carries the affordance."',
  }

  /**
   * An allowlist, not a blocklist, and that inversion is the whole point.
   *
   * The previous guard named four words someone had thought of. It could only
   * ever catch a repeat of a mistake already made, and it missed every one of
   * the four this very task went on to ship: `.blur` from "would blur every
   * glyph", `.transform` twice from "no CSS transform on it", `.shrink` from
   * "shrink the whole thing". Note that `terminal.tsx`'s own "a CSS transform,"
   * with a trailing comma was *not* a candidate while "CSS transform:" with a
   * colon was, and "rather than shrink." with a full stop was not while
   * "shrink the whole thing," was. That cannot be reasoned about, only
   * measured — so this measures the output instead of guessing at the input.
   */
  it('emits no bare utility that no class attribute in the tree asks for', () => {
    const root = dirname(dirname(fileURLToPath(import.meta.url)))
    const emitted = bareUtilities(css)
    const used = classesInMarkup(root)

    // Both halves must be finding things, or this passes by measuring nothing.
    expect(emitted.size).toBeGreaterThan(5)
    expect(used.size).toBeGreaterThan(20)

    const unexplained = [...emitted].filter((w) => !used.has(w) && !(w in KNOWN_DEAD)).sort()
    expect(
      unexplained,
      `these rules ship but no className asks for them — a comment or a quoted ` +
        `string summoned each one. Reword it, rebuild, and measure again; the ` +
        `words that do this cannot be predicted.`,
    ).toEqual([])
  })

  it('has no entry left in its baseline that the build no longer emits', () => {
    const emitted = bareUtilities(css)
    const fixed = Object.keys(KNOWN_DEAD).filter((w) => !emitted.has(w))
    expect(fixed, 'these were fixed — delete them from KNOWN_DEAD').toEqual([])
  })
})

describe('the directory held outside the scan', () => {
  /**
   * src/styles.css excludes src/client/ so that the `resize` control message —
   * a quoted string, and therefore a scanner candidate — stops compiling a
   * `.resize` rule. The cost is that a utility class named in there would
   * silently never be compiled, which looks like nothing at all: the markup
   * renders unstyled and no build step complains. A comment alone is not a
   * guard against that, so this is.
   *
   * What it catches is every route a class takes into markup in this codebase:
   * a JSX or HTML attribute, the `cn`/`clsx`/`cva` helpers, and `classList`.
   * What it cannot catch is a bare string assembled here and applied
   * elsewhere, which is undecidable from one directory. That is why the rule
   * this backs is "no markup in src/client/" rather than "no class names".
   */
  it('names no utility class, because none of it would ever compile', () => {
    const dir = join(dirname(fileURLToPath(import.meta.url)), 'client')
    // Recursive: a non-recursive read would hand a subdirectory name to
    // readFileSync and die with EISDIR instead of checking anything under it.
    const files = readdirSync(dir, { recursive: true, withFileTypes: true }).filter(
      (e) => e.isFile() && !e.name.includes('.test.'),
    )

    expect(files.length).toBeGreaterThan(0)
    for (const entry of files) {
      const source = readFileSync(join(entry.parentPath, entry.name), 'utf8')
      expect(source, `${entry.name} is outside Tailwind's scan; move markup elsewhere`).not.toMatch(
        /className|class=|\bcn\(|\bclsx\(|\bcva\(|classList/,
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
