import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Terminal } from '@xterm/xterm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createXtermEmulator,
  extractGrid,
  loadWebglRenderer,
  NEWLINE_CHORD_BYTES,
  openTerminalLink,
  TERMINAL_FONT_FAMILY,
} from './xterm'
import { findPaths } from '@/lib/paths'
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

  it('carries a link detector across detectLinks, and survives disposal', async () => {
    const em = createXtermEmulator({ cols: 40, rows: 6 })
    await settled(em, 'holds internal/a.go steady')
    const detector = {
      find: findPaths,
      verify: (p: string[]) => Promise.resolve(p.map(() => true)),
      open: () => {},
    }
    em.detectLinks(detector)
    em.detectLinks(detector) // replacing an installed one disposes the old
    em.detectLinks(null)
    em.dispose()
    em.detectLinks(null) // after dispose: a no-op, not a throw
  })

  describe('touch selection', () => {
    /** A mounted terminal with `text` on screen, ready to be selected from. */
    async function screen(text: string, cols = 40) {
      const el = document.createElement('div')
      document.body.appendChild(el)
      const em = createXtermEmulator({ cols, rows: 6 })
      em.attachTo(el)
      await settled(em, text)
      return { em, done: () => (em.dispose(), el.remove()) }
    }

    it('lifts the word under the finger and nothing either side of it', async () => {
      // The case the gesture exists for: a session id printed in a sentence,
      // wanted on its own and without the words around it.
      const { em, done } = await screen('resume c1ff4c66-5b72 now')

      em.selectWordAt({ col: 10, row: 0 })

      expect(em.selection()).toBe('c1ff4c66-5b72')
      done()
    })

    it('takes whitespace as no word at all', async () => {
      const { em, done } = await screen('one   two')
      em.selectWordAt({ col: 0, row: 0 })

      em.selectWordAt({ col: 4, row: 0 })

      // The earlier selection survives: a press on blank space is not a way
      // to lose what was already held.
      expect(em.selection()).toBe('one')
      done()
    })

    it('extends forward across a row boundary', async () => {
      const { em, done } = await screen('alpha bravo\r\ncharlie delta', 12)

      em.selectWordAt({ col: 6, row: 0 })
      // The last cell of "charlie", not the space after it: the cell under
      // the finger is inside the selection, so a drag onto the space would
      // rightly carry the space along.
      em.extendSelectionTo({ col: 6, row: 1 })

      expect(em.selection()).toBe('bravo\ncharlie')
      done()
    })

    it('extends backwards from the anchored word, keeping its far end', async () => {
      const { em, done } = await screen('alpha bravo charlie')

      em.selectWordAt({ col: 6, row: 0 })
      em.extendSelectionTo({ col: 0, row: 0 })

      expect(em.selection()).toBe('alpha bravo')
      done()
    })

    it('falls back to the anchored word when the drag returns inside it', async () => {
      const { em, done } = await screen('alpha bravo charlie')

      em.selectWordAt({ col: 6, row: 0 })
      em.extendSelectionTo({ col: 14, row: 0 })
      em.extendSelectionTo({ col: 8, row: 0 })

      expect(em.selection()).toBe('bravo')
      done()
    })

    it('ignores a drag that no press anchored', async () => {
      const { em, done } = await screen('alpha bravo')

      em.extendSelectionTo({ col: 8, row: 0 })

      expect(em.selection()).toBe('')
      done()
    })

    it('drops the anchor along with the selection', async () => {
      const { em, done } = await screen('alpha bravo charlie')
      em.selectWordAt({ col: 0, row: 0 })

      em.clearSelection()
      em.extendSelectionTo({ col: 14, row: 0 })

      expect(em.selection()).toBe('')
      done()
    })

    it('counts rows from the top of the viewport, not the scrollback', async () => {
      // Six rows of screen and ten lines written, so the buffer has scrolled
      // and viewport row 0 is no longer buffer line 0. A caller holding a
      // finger over the top line means the line it can see.
      const lines = Array.from({ length: 10 }, (_, i) => `line${i}`).join('\r\n')
      const { em, done } = await screen(lines)

      em.selectWordAt({ col: 0, row: 0 })

      expect(em.selection()).toBe('line4')
      done()
    })
  })

  describe('alt-screen scrolling', () => {
    // Fullscreen TUIs — claude's fullscreen mode, vim, less — live on the
    // alternate buffer, which keeps no scrollback, so the viewport scroll
    // behind scrollLines has nothing to move there and a touch drag went
    // nowhere. A desktop wheel scrolls those programs because xterm
    // translates it — into arrow keys, or into wheel reports when the
    // program tracks the mouse — and the seam owes a drag the same
    // translation.

    /** A mounted emulator with `modes` applied and its wire output captured. */
    async function mounted(modes: string) {
      const el = document.createElement('div')
      document.body.appendChild(el)
      const em = createXtermEmulator({ cols: 10, rows: 4 })
      em.attachTo(el)
      const seen: string[] = []
      em.onData((b) => seen.push(new TextDecoder().decode(b)))
      await settled(em, modes)
      return { el, em, seen }
    }

    it('scrolls an alt-screen program with arrow keys', async () => {
      const { el, em, seen } = await mounted('\x1b[?1049h')

      em.scrollLines(-3)
      expect(seen.join('')).toBe('\x1b[A\x1b[A\x1b[A')

      seen.length = 0
      em.scrollLines(2)
      expect(seen.join('')).toBe('\x1b[B\x1b[B')

      em.dispose()
      el.remove()
    })

    it('encodes those arrows the way the program asked for', async () => {
      // DECCKM. A program that turned application cursor keys on reads
      // ESC O A as an arrow and ESC [ A as something else entirely.
      const { el, em, seen } = await mounted('\x1b[?1049h\x1b[?1h')

      em.scrollLines(-1)
      expect(seen.join('')).toBe('\x1bOA')

      em.dispose()
      el.remove()
    })

    it('hands wheel events to xterm when the program tracks the mouse', async () => {
      // claude's fullscreen TUI turns tracking on (1000h, SGR) and scrolls
      // its transcript on wheel reports. Encoding a report by hand here
      // would fork xterm's protocol logic, so the seam dispatches real
      // wheel events at the screen and xterm's own encoder answers. jsdom
      // lays nothing out and xterm refuses to report coordinates it cannot
      // measure, so the report itself cannot be asserted — the events
      // crossing the seam are what this checks. Capture phase, because
      // xterm's own listener takes each event for its report and stops the
      // propagation right there; the bubble never comes back out.
      const { el, em, seen } = await mounted('\x1b[?1049h\x1b[?1000h\x1b[?1006h')
      const wheels: number[] = []
      el.addEventListener('wheel', (e) => wheels.push((e as WheelEvent).deltaY), {
        capture: true,
      })

      em.scrollLines(-2)
      expect(wheels).toEqual([-1, -1])
      // And no arrows: a tracking program hears wheel reports, and arrow
      // keys sent alongside them would move its cursor, not its viewport.
      expect(seen.join('')).toBe('')

      em.dispose()
      el.remove()
    })

    it('falls back to arrows under X10 tracking, which has no wheel', async () => {
      // Mode 9, the 1984 protocol: button presses only. xterm registers no
      // wheel listener for it, so the dispatched events fall through to the
      // same no-scrollback fallback a desktop wheel takes, and come out as
      // arrows — not as reports X10 cannot carry, and not as nothing.
      const { el, em, seen } = await mounted('\x1b[?1049h\x1b[?9h')

      em.scrollLines(-1)
      expect(seen.join('')).toBe('\x1b[A')

      em.dispose()
      el.remove()
    })

    it('leaves the main buffer to the viewport', async () => {
      // Outside the alternate buffer the scrollback is real and xterm's own
      // viewport scroll is the right thing; nothing may reach the wire.
      const { el, em, seen } = await mounted('')

      em.scrollLines(-2)
      expect(seen.join('')).toBe('')

      em.dispose()
      el.remove()
    })
  })

  it('reports no measurement before it is mounted', () => {
    // The sizing policy divides by whatever this returns. A zero-sized answer
    // dressed up as a real one becomes an Infinity one line later; jsdom lays
    // nothing out, so that is the answer here even after attachTo.
    const em = createXtermEmulator({ cols: 20, rows: 4 })
    expect(em.contentSize()).toBeNull()
    em.dispose()
  })

  it('reports the exact laid-out size, not whole pixels', () => {
    // The renderer writes the screen's true size into its style attribute,
    // and on a Retina display that value is fractional: a cell is a whole
    // count of device pixels, divided by the pixel ratio. offsetWidth rounds
    // it to an integer, and that half-pixel, divided into a cell width and
    // multiplied back out across the pane, is enough to flip cellsThatFit
    // between N and N+1 columns depending on the dimensions the screen
    // happens to wear — each answer reshapes the pty, the new dimensions
    // re-round the other way, and the pane flickers with prompt redraws
    // forever.
    const el = document.createElement('div')
    document.body.appendChild(el)
    const em = createXtermEmulator({ cols: 100, rows: 24 })
    em.attachTo(el)
    // jsdom lays nothing out, so the renderer's write is stated by hand:
    // 100 columns of a 7.8125px cell, 24 rows of a 17.02083…px line.
    const screen = el.querySelector<HTMLElement>('.xterm-screen')!
    screen.style.width = '781.25px'
    screen.style.height = '408.5px'

    expect(em.contentSize()).toEqual({ width: 781.25, height: 408.5 })
    em.dispose()
    el.remove()
  })

  it('takes a colour palette at build time and again afterwards', () => {
    // Both matter. The option is what stops a terminal painting one frame in
    // xterm's own colours before flue's land; setTheme is what lets a running
    // terminal follow prefers-color-scheme, which has no toggle to rebuild on.
    const em = createXtermEmulator({
      cols: 20,
      rows: 4,
      theme: { background: '#09090b', foreground: '#f4f4f5' },
    })
    expect(() => em.setTheme({ background: '#ffffff', foreground: '#18181b' })).not.toThrow()
    em.dispose()
  })

  it('survives every read and write that can outlive disposal', () => {
    // All of these are called from React effects and from event handlers that
    // can outlive the view by a frame — a queued animation frame, a
    // media-query change mid-teardown, a key bar tapped as the view goes
    // away. xterm throws on a disposed terminal — from the mode reads only by
    // luck of where they land today, which is why the answer this pins is the
    // seam's own and not whatever the wreckage still holds.
    const em = createXtermEmulator({ cols: 20, rows: 4 })
    em.dispose()

    expect(() => em.focus()).not.toThrow()
    expect(() => em.setTheme({ background: '#000000' })).not.toThrow()
    expect(em.contentSize()).toBeNull()
    expect(() => em.answerQueries(true)).not.toThrow()
    expect(em.applicationCursorKeys()).toBe(false)
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

describe('openTerminalLink', () => {
  it('opens http(s) in a new tab with no opener handle', () => {
    const open = vi.fn()
    vi.stubGlobal('open', open)
    openTerminalLink('https://flue.sh/docs')
    openTerminalLink('http://127.0.0.1:8080/')
    expect(open).toHaveBeenNthCalledWith(1, 'https://flue.sh/docs', '_blank', 'noopener')
    expect(open).toHaveBeenNthCalledWith(2, 'http://127.0.0.1:8080/', '_blank', 'noopener')
    vi.unstubAllGlobals()
  })

  it('refuses every other scheme — terminal output is untrusted input', () => {
    const open = vi.fn()
    vi.stubGlobal('open', open)
    // An OSC 8 sequence chooses the URI, and anything the shell prints can
    // be one; these must never reach window.open.
    openTerminalLink('javascript:alert(1)')
    openTerminalLink('file:///etc/passwd')
    openTerminalLink('data:text/html,<script>1</script>')
    openTerminalLink('vscode://open')
    openTerminalLink('HTTPS//not-a-scheme')
    expect(open).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })
})

describe('Shift+Enter', () => {
  /**
   * Mount an emulator and hand back what it sends and the element xterm
   * listens for keys on.
   *
   * The helper textarea is where every real keystroke lands: xterm keeps the
   * caret in it and reads keydown from it, so dispatching anywhere else would
   * measure a listener nobody uses.
   */
  function mounted() {
    const el = document.createElement('div')
    document.body.appendChild(el)
    const em = createXtermEmulator({ cols: 20, rows: 4 })
    em.attachTo(el)
    const out: string[] = []
    em.onData((b) => out.push(new TextDecoder().decode(b)))
    const textarea = el.querySelector('textarea')!
    const press = (init: KeyboardEventInit) =>
      textarea.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          keyCode: 13,
          bubbles: true,
          cancelable: true,
          ...init,
        }),
      )
    return {
      press,
      sent: () => out.join(''),
      done: () => {
        em.dispose()
        el.remove()
      },
    }
  }

  it('sends ESC CR, so an agent CLI takes a newline instead of a submit', () => {
    // The bug this exists for: xterm encodes Enter as a bare CR whatever
    // Shift is doing, and Claude Code and Codex both read a bare CR as
    // "send this message". A newline mid-prompt was unreachable in a browser.
    const t = mounted()
    t.press({ shiftKey: true })
    expect(t.sent()).toBe(NEWLINE_CHORD_BYTES)
    t.done()
  })

  it('leaves the browser out of it, so no line break lands in the helper', () => {
    // xterm's caret lives in a real textarea. An Enter left to the browser
    // puts a line break in that element's value, and xterm's own input
    // listener then reads a value it never wrote.
    const t = mounted()
    const event = new KeyboardEvent('keydown', {
      key: 'Enter',
      keyCode: 13,
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    })
    document.querySelector('textarea')!.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
    t.done()
  })

  it('leaves a plain Enter as the carriage return every shell expects', () => {
    const t = mounted()
    t.press({})
    expect(t.sent()).toBe('\r')
    t.done()
  })

  it('keeps its hands off the focus-mode chord', () => {
    // Ctrl+Shift+Enter belongs to the terminal view, which takes it on the
    // way down (components/terminal.tsx). Claiming it here as a newline would
    // mean the two agree only by accident of listener order.
    const t = mounted()
    t.press({ shiftKey: true, ctrlKey: true })
    expect(t.sent()).not.toBe(NEWLINE_CHORD_BYTES)
    t.done()
  })

  it('sends the same bytes for Alt+Enter, which is xterm doing it', () => {
    // Not a claim about this handler — a check that the sequence chosen is
    // the one xterm already emits for the other chord that means "newline",
    // so both spellings arrive at the CLI as one thing.
    const t = mounted()
    t.press({ altKey: true })
    expect(t.sent()).toBe(NEWLINE_CHORD_BYTES)
    t.done()
  })
})

describe('copy and paste chords', () => {
  /**
   * A mounted terminal with `text` on screen, a keyboard to press, and a
   * record of what went to the pty.
   *
   * Keys are dispatched on the helper textarea for the same reason as in the
   * Shift+Enter block above: it is where xterm listens. `keyCode` is set
   * because xterm's encoder reads it — a KeyboardEvent built without one
   * encodes as nothing and the test would pass for the wrong reason.
   */
  async function screen(text: string, opts: { macKeyboard?: boolean } = {}) {
    const el = document.createElement('div')
    document.body.appendChild(el)
    const em = createXtermEmulator({ cols: 40, rows: 6, ...opts })
    em.attachTo(el)
    await settled(em, text)
    const out: string[] = []
    em.onData((b) => out.push(new TextDecoder().decode(b)))
    const textarea = el.querySelector('textarea')!
    const press = (key: string, init: KeyboardEventInit = {}) => {
      const event = new KeyboardEvent('keydown', {
        key,
        keyCode: key.toUpperCase().charCodeAt(0),
        bubbles: true,
        cancelable: true,
        ...init,
      })
      textarea.dispatchEvent(event)
      return event
    }
    return {
      em,
      press,
      sent: () => out.join(''),
      done: () => {
        em.dispose()
        el.remove()
      },
    }
  }

  afterEach(() => {
    // jsdom ships no navigator.clipboard; the stubs below must not outlive
    // this block into tests that read the absence.
    delete (navigator as { clipboard?: unknown }).clipboard
  })

  it('stands aside on Ctrl+C over a selection, so the browser copies', async () => {
    // The bug this exists for: xterm encodes Ctrl+C as ETX with no notion of
    // a selection, so copying output interrupted the program instead.
    const t = await screen('hello world')
    t.em.selectWordAt({ col: 0, row: 0 })

    const event = t.press('c', { ctrlKey: true })

    // Nothing on the wire — the program under the selection keeps running —
    // and the default not prevented, because the browser's own copy is the
    // copy. xterm fills the clipboard from its copy listener.
    expect(t.sent()).toBe('')
    expect(event.defaultPrevented).toBe(false)
    t.done()
  })

  it('clears a copied selection, so the next Ctrl+C interrupts', async () => {
    // Without this a held selection would make SIGINT unreachable from the
    // keyboard: every Ctrl+C would copy, forever.
    const t = await screen('hello world')
    t.em.selectWordAt({ col: 0, row: 0 })

    t.press('c', { ctrlKey: true })
    await new Promise((r) => setTimeout(r, 0))

    expect(t.em.selection()).toBe('')
    t.press('c', { ctrlKey: true })
    expect(t.sent()).toBe('\x03')
    t.done()
  })

  it('keeps Ctrl+C as the interrupt when nothing is selected', async () => {
    const t = await screen('hello')

    t.press('c', { ctrlKey: true })

    expect(t.sent()).toBe('\x03')
    t.done()
  })

  it('keeps Ctrl+C as the interrupt on a Mac keyboard, selection or not', async () => {
    // Cmd+C owns copy on a Mac and already works — no ctrlKey, so xterm's
    // encoder ignores it and the browser copies. Taking Ctrl+C too would
    // swallow the key entirely: macOS browsers do not copy on Ctrl+C, so the
    // press would neither copy nor interrupt.
    const t = await screen('hello world', { macKeyboard: true })
    t.em.selectWordAt({ col: 0, row: 0 })

    t.press('c', { ctrlKey: true })

    expect(t.sent()).toBe('\x03')
    t.done()
  })

  it('leaves Cmd+C alone, which is the browser copy working today', async () => {
    const t = await screen('hello world')
    t.em.selectWordAt({ col: 0, row: 0 })

    const event = t.press('c', { metaKey: true })

    expect(t.sent()).toBe('')
    expect(event.defaultPrevented).toBe(false)
    t.done()
  })

  it('claims Ctrl+Shift+C: copies the selection and clears it', async () => {
    const writeText = vi.fn(() => Promise.resolve())
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    const t = await screen('hello world')
    t.em.selectWordAt({ col: 0, row: 0 })

    const event = t.press('C', { ctrlKey: true, shiftKey: true })
    await new Promise((r) => setTimeout(r, 0))

    expect(writeText).toHaveBeenCalledWith('hello')
    expect(t.em.selection()).toBe('')
    expect(t.sent()).toBe('')
    // Claimed even from the browser: on Windows and Linux the unclaimed
    // chord opens the DevTools inspector over the terminal.
    expect(event.defaultPrevented).toBe(true)
    t.done()
  })

  it('swallows Ctrl+Shift+C over no selection rather than opening DevTools', async () => {
    const writeText = vi.fn(() => Promise.resolve())
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    const t = await screen('hello')

    const event = t.press('C', { ctrlKey: true, shiftKey: true })

    expect(writeText).not.toHaveBeenCalled()
    expect(t.sent()).toBe('')
    expect(event.defaultPrevented).toBe(true)
    t.done()
  })

  it('keeps the selection when the clipboard write is refused', async () => {
    // A failed copy that also cleared the selection would leave nothing on
    // the clipboard and nothing to try again with. The selection staying is
    // what makes the retry possible.
    const writeText = vi.fn(() => Promise.reject(new Error('denied')))
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    const t = await screen('hello world')
    t.em.selectWordAt({ col: 0, row: 0 })

    t.press('C', { ctrlKey: true, shiftKey: true })
    await new Promise((r) => setTimeout(r, 0))

    expect(t.em.selection()).toBe('hello')
    t.done()
  })

  it('stands aside on Ctrl+Shift+V, where the browser paste is the paste', async () => {
    // Chromium and Firefox on Windows and Linux bind the chord to a
    // plain-text paste themselves and fire a trusted paste event at the
    // helper textarea, which xterm's own paste handler consumes — bracketed
    // paste included. Claiming it and reading the async clipboard instead
    // would cost a permission prompt on the platforms that press it, and go
    // dead outright on insecure origins.
    const t = await screen('hello')

    const event = t.press('V', { ctrlKey: true, shiftKey: true })

    expect(t.sent()).toBe('')
    expect(event.defaultPrevented).toBe(false)
    t.done()
  })
})

describe('device-query suppression', () => {
  const bytes = (s: string) => new TextEncoder().encode(s)

  it('is silent by default and answers once told it is primary', async () => {
    const em = createXtermEmulator({ cols: 10, rows: 4 })
    const out: string[] = []
    em.onData((b) => out.push(new TextDecoder().decode(b)))

    // A mirror must not answer DA — the primary's answer already went.
    await new Promise<void>((r) => em.write(bytes('\x1b[c'), r))
    await new Promise<void>((r) => em.write(bytes('\x1b[6n'), r))
    expect(out).toEqual([])

    em.answerQueries(true)
    await new Promise<void>((r) => em.write(bytes('\x1b[c'), r))
    expect(out.join('')).toMatch(/\x1b\[\?/)
    em.dispose()
  })

  it('swallows a colour question while silent, without muting the terminal', async () => {
    const em = createXtermEmulator({ cols: 10, rows: 4 })
    const out: string[] = []
    em.onData((b) => out.push(new TextDecoder().decode(b)))

    // A colour *set* passes through even while silent — a mirror that
    // dropped it would drift from the primary's screen. The "?" form is the
    // query that used to land at the prompt as "11;rgb:2828/2a2a/3636" once
    // per extra tab.
    await new Promise<void>((r) => em.write(bytes('\x1b]11;#282a36\x07'), r))
    await new Promise<void>((r) => em.write(bytes('\x1b]11;?\x07'), r))
    expect(out).toEqual([])

    // The positive control is DA rather than the colour query itself:
    // headless xterm answers DA but ties its colour reports to an opened
    // renderer, so "no reply above" must be shown to be the handler's doing
    // and not a muted terminal.
    em.answerQueries(true)
    await new Promise<void>((r) => em.write(bytes('\x1b[c'), r))
    expect(out.join('')).toMatch(/\x1b\[\?/)
    em.dispose()
  })
})
