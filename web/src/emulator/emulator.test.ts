import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Terminal } from '@xterm/xterm'
import { describe, expect, it, vi } from 'vitest'
import {
  createXtermEmulator,
  extractGrid,
  loadWebglRenderer,
  NEWLINE_CHORD_BYTES,
  openTerminalLink,
  TERMINAL_FONT_FAMILY,
} from './xterm'
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

  it('stops reporting the pointer a replayed program had asked for', async () => {
    // The bug this is the floor for: a snapshot's scrollback carries the
    // mouse-tracking sequence of a program that died with the daemon, so
    // replaying it arms an emulator sitting in front of a fresh shell. From
    // there every mouse move is an SGR report typed at the prompt.
    const el = document.createElement('div')
    document.body.appendChild(el)
    const em = createXtermEmulator({ cols: 10, rows: 4 })
    em.attachTo(el)
    const seen: string[] = []
    em.onData((b) => seen.push(new TextDecoder().decode(b)))
    await settled(em, '\x1b[?1003h\x1b[?1006h\x1b[?1004h')

    expect(em.reportsPointer()).toBe(true)
    // Everything the arming itself put on the wire is the bug, not the fix —
    // an unfocused terminal answers ESC[?1004h with a focus-out report right
    // away, which is exactly the kind of typing-with-nobody-there this
    // clears. What matters below is that the clearing adds none of its own.
    seen.length = 0
    em.stopReporting()
    await settled(em, '')

    expect(em.reportsPointer()).toBe(false)
    expect(seen.join('')).toBe('')
    em.dispose()
    el.remove()
  })

  it('leaves a live program its pointer reporting', async () => {
    // stopReporting is aimed at a replay, never at output. A program that
    // turns tracking on after the backlog has drained keeps it.
    const el = document.createElement('div')
    document.body.appendChild(el)
    const em = createXtermEmulator({ cols: 10, rows: 4 })
    em.attachTo(el)
    em.stopReporting()
    await settled(em, '\x1b[?1002h')

    expect(em.reportsPointer()).toBe(true)
    em.dispose()
    el.remove()
  })

  it('reports no measurement before it is mounted', () => {
    // The sizing policy divides by whatever this returns. A zero-sized answer
    // dressed up as a real one becomes an Infinity one line later; jsdom lays
    // nothing out, so that is the answer here even after attachTo.
    const em = createXtermEmulator({ cols: 20, rows: 4 })
    expect(em.contentSize()).toBeNull()
    em.dispose()
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
    expect(() => em.stopReporting()).not.toThrow()
    expect(() => em.setTheme({ background: '#000000' })).not.toThrow()
    expect(em.contentSize()).toBeNull()
    expect(() => em.answerQueries(true)).not.toThrow()
    expect(em.applicationCursorKeys()).toBe(false)
    expect(em.reportsPointer()).toBe(false)
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
