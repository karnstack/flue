import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Terminal } from '@xterm/xterm'
import { describe, expect, it } from 'vitest'
import { createXtermEmulator, extractGrid, loadWebglRenderer, TERMINAL_FONT_FAMILY } from './xterm'
import type { Emulator } from './types'

/**
 * The corpus is deliberately emulator-agnostic: it names inputs and the grid
 * they should extract to, and never mentions xterm. It runs against xterm.js
 * today and would run unchanged against any replacement.
 *
 * It is also deliberately small. Every case in it guards flue's own
 * extraction code — row count and row order, the trim, wide characters,
 * escape sequences. The cases that only re-verified xterm's parser (cursor
 * addressing, erase-in-line, clear-screen, SGR, backspace, tab stops) are not
 * here: a failure flue cannot act on is not a test flue should own.
 */
interface Case {
  name: string
  /** What flue-side property this case guards; surfaced on failure. */
  why: string
  cols: number
  rows: number
  input: string
  lines: string[]
}

// `__dirname` would also work — vite-node injects it and @types/node types
// it — but it is a CommonJS global this project has no other use for. What
// does not work, and is the trap worth naming, is the obvious ESM spelling
// `new URL(literal, import.meta.url)`: Vite rewrites that form into an asset
// URL, so it arrives as an http:// URL that fileURLToPath refuses.
const here = dirname(fileURLToPath(import.meta.url))
const read = (path: string) => readFileSync(resolve(here, path), 'utf8')

const corpus: Case[] = JSON.parse(read('../../../testdata/vt/basic.json'))

const encode = (s: string) => new TextEncoder().encode(s)

/**
 * Write and wait for the parser to have consumed it.
 *
 * xterm parses on a later task, so a bare `write` followed by `snapshot`
 * reads the screen as it was before the write. The callback is the signal
 * that it has caught up. A fixed sleep would in practice also work — 20ms
 * against a setTimeout(0) parse task essentially always wins — but using a
 * signal that exists beats approximating it with a duration.
 */
function settled(em: Emulator, text: string): Promise<void> {
  return new Promise((parsed) => em.write(encode(text), () => parsed()))
}

describe('VT conformance corpus', () => {
  // The corpus is data, so an empty or unparseable file would quietly turn
  // this whole block into zero assertions.
  it('is loaded', () => {
    expect(corpus.length).toBeGreaterThan(0)
  })

  for (const c of corpus) {
    it(c.name, async () => {
      const em = createXtermEmulator({ cols: c.cols, rows: c.rows })
      await settled(em, c.input)

      const grid = em.snapshot()
      expect(grid.cols).toBe(c.cols)
      expect(grid.rows).toBe(c.rows)
      expect(grid.lines, c.why).toEqual(c.lines)

      em.dispose()
    })
  }
})

describe('Emulator interface', () => {
  it('reports resized dimensions in the snapshot', () => {
    const em = createXtermEmulator({ cols: 10, rows: 4 })
    em.resize(30, 12)

    const grid = em.snapshot()
    expect(grid.cols).toBe(30)
    expect(grid.rows).toBe(12)
    // The row count is part of the contract, not merely the reported number.
    expect(grid.lines).toHaveLength(12)

    em.dispose()
  })

  it('delivers typed input to the onData callback as bytes', () => {
    const em = createXtermEmulator({ cols: 10, rows: 4 })
    const seen: Uint8Array[] = []
    em.onData((b) => seen.push(b))

    em.injectForTest('x')

    expect(seen.length).toBe(1)
    expect(new TextDecoder().decode(seen[0]!)).toBe('x')

    em.dispose()
  })

  it('encodes input as UTF-8, not as UTF-16 code units', () => {
    // The bytes go to a pty. A charCodeAt-per-character encoding would send
    // 0xE9 for "é" and mangle everything outside Latin-1 outright, and the
    // ASCII case above cannot tell the two apart.
    const em = createXtermEmulator({ cols: 10, rows: 4 })
    const seen: Uint8Array[] = []
    em.onData((b) => seen.push(b))

    em.injectForTest('é')

    expect(Array.from(seen[0]!)).toEqual([0xc3, 0xa9])

    em.dispose()
  })

  it('attaches to an element with no WebGL context available', () => {
    // jsdom has no WebGL, which is the same shape of failure a real browser
    // hits when the GPU process is gone: mounting still has to succeed, on
    // the DOM renderer.
    const el = document.createElement('div')
    document.body.appendChild(el)

    const em = createXtermEmulator({ cols: 20, rows: 4 })
    expect(() => em.attachTo(el)).not.toThrow()
    expect(el.childElementCount).toBeGreaterThan(0)

    em.dispose()
    el.remove()
  })
})

describe('extractGrid', () => {
  it('reads the live grid rather than wherever the user has scrolled to', async () => {
    // A snapshot is of the terminal grid, so it must not change under the
    // user's feet while they read back through history. Anchoring extraction
    // to the viewport rather than to the buffer base is the easy mistake, and
    // it stays invisible until there is enough output to scroll.
    const term = new Terminal({ cols: 20, rows: 3, scrollback: 100 })
    await new Promise<void>((r) => term.write('l1\r\nl2\r\nl3\r\nl4\r\nl5', () => r()))
    expect(extractGrid(term).lines).toEqual(['l3', 'l4', 'l5'])

    term.scrollToTop()

    expect(extractGrid(term).lines).toEqual(['l3', 'l4', 'l5'])
    term.dispose()
  })
})

describe('loadWebglRenderer', () => {
  it('reports failure instead of throwing when WebGL is unavailable', async () => {
    // Awaited directly rather than through attachTo: attachTo cannot return
    // the promise without putting a renderer-shaped concern into the seam,
    // and an unawaited rejection here would be an unhandled rejection in the
    // browser rather than a fallback.
    const el = document.createElement('div')
    document.body.appendChild(el)
    const term = new Terminal({ cols: 20, rows: 4 })
    term.open(el)

    await expect(loadWebglRenderer(term)).resolves.toBe(false)

    term.dispose()
    el.remove()
  })

  it('does not load the addon into a terminal disposed while it was loading', async () => {
    // The import is async and dispose is not, so the terminal can be gone by
    // the time the module lands. Loading an addon into a disposed terminal
    // leaks it and logs from inside xterm.
    let loaded = false
    const fake = { loadAddon: () => (loaded = true) } as unknown as Terminal

    await expect(loadWebglRenderer(fake, () => true)).resolves.toBe(false)
    expect(loaded).toBe(false)
  })
})

describe('terminal typography', () => {
  it('uses the same monospace stack as the rest of the app', () => {
    // xterm measures glyph widths on a canvas, where `var(--font-mono)` does
    // not resolve, so the stack has to be a literal here. That makes it the
    // one place in the app where the terminal font can drift away from the
    // token with nothing rendering visibly wrong until you compare the two.
    const css = read('../styles.css')
    const token = /--font-mono:\s*([^;]+);/.exec(css)

    expect(token, '--font-mono is gone from styles.css').not.toBeNull()
    // The token is written across two lines in the stylesheet.
    const collapse = (s: string) => s.replace(/\s+/g, ' ').trim()
    expect(collapse(token![1]!)).toBe(collapse(TERMINAL_FONT_FAMILY))
  })
})
