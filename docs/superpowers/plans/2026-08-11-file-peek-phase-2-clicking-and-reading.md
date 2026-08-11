# File peek, phase 2: clicking and reading

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A path printed in a terminal session underlines when you hover it and
it is real, and clicking it opens the file in a modal over the session — the
same on loopback and over the relay.

**Architecture:** Phase 1 landed the wire (`stat`, `read`, `cancel`, `stats`,
`file`, `eof`, frame `0x02`) and the daemon behind it. This phase is entirely in
`web/`. Detection sits behind the existing `Emulator` seam as a `detectLinks`
method, so nothing above the seam learns xterm exists; matching, wrapped-line
assembly, verification caching and UTF-8 line accumulation are pure modules with
their own tests; the viewer is a Radix dialog rendering a windowed plain-text
list. No highlighter, no images, no persistent cache — those are phase 3.

**Tech Stack:** TypeScript, React 19, Radix (`radix-ui`), xterm.js 6, Tailwind
4, vitest + @testing-library/react, jsdom.

## Context

- The design this implements: `docs/superpowers/specs/2026-08-11-file-peek-design.md`
- The contract phase 1 wrote: `spec/protocol.md`, section **Reading files**
- Phase 1's plan, for what already exists:
  `docs/superpowers/plans/2026-08-11-file-peek-phase-1-wire-and-daemon.md`

Phase 1 shipped as PR #55 and is on `origin/main` (85036605). This branch is
`feat/file-peek-ui`, cut from it.

### What phase 1 already gives you

In `web/src/client/protocol.ts`, all present and exported:

- `FRAME_FILE = 0x02`, and `decodeBinary` already accepts it
- `StatMsg`, `ReadMsg`, `CancelMsg` in `ClientMessage`
- `PathEntry`, `StatsMsg`, `FileMsg`, `EofMsg` in `ServerMessage`

Nothing in `web/src/client/client.ts` sends or handles any of them yet. That is
Task 4.

## Global Constraints

Every task's requirements implicitly include all of these.

- **pnpm only.** `pnpm vitest run`, `pnpm run lint`. Never `npm`, `npx`, `yarn`.
  See `CLAUDE.md` for why.
- **Run before every commit:** `cd web && pnpm vitest run && pnpm run lint`.
  Both must be clean. `pnpm run lint` is `tsc --noEmit`.
- **`main` is protected.** Never commit to it. This branch is `feat/file-peek-ui`.
- **Tailwind scanner.** `web/src/styles.css` carries a note at the top about
  prose in scanned sources compiling stray CSS rules, and
  `web/src/styles.build.test.ts` is a real vite build that catches it. Read that
  note before writing comments in any new `web/src/**` file. In practice: never
  write a bare CSS-property-shaped word inside quotes or backticks in a comment.
- **Comment style.** This codebase comments *why*, at length, and never *what*.
  Match `web/src/client/client.ts` and `web/src/components/terminal.tsx`. A
  comment that restates the line under it is a defect here.
- **Prose style.** Simple global English. Never em dashes or en dashes in code
  comments or docs written by this plan; use a comma, a colon, or a full stop.
  (The existing sources use them; new prose does not add more.)
- **No new dependencies.** Everything here is buildable from what
  `web/package.json` already has. If a task seems to need a package, it is the
  wrong task.
- **The spec is the contract.** `spec/protocol.md` "Reading files" governs. In
  particular: a client must discard `0x02` frames and an `eof` naming a ref it
  has cancelled, `file.size` is a snapshot and not a length, and `stat` refuses
  more than 32 paths rather than clamping.
- **Every new module gets a sibling `.test.ts`.** Tests assert behaviour, never
  that a function exists.

## File structure

| File | Responsibility |
|---|---|
| `web/src/lib/paths.ts` *(new)* | Find path-shaped runs in one line of text. Pure. |
| `web/src/emulator/wrap.ts` *(new)* | Assemble a wrapped logical line and map ranges in it back to buffer rows. Pure. |
| `web/src/emulator/types.ts` | Gains `LinkMatch`, `LinkDetector`, and `Emulator.detectLinks`. |
| `web/src/emulator/link-provider.ts` *(new)* | The xterm link provider, written against a minimal structural terminal so it is testable without xterm. |
| `web/src/emulator/xterm.ts` | Implements `detectLinks` by registering that provider. |
| `web/src/testing/emulator.ts` | The fake emulator records the installed detector so views can be driven. |
| `web/src/client/client.ts` | `statPaths`, `readFile`, chunk routing by ref, cancel. |
| `web/src/files/verify.ts` *(new)* | The per-session path cache and the 32-path batcher over `statPaths`. |
| `web/src/files/text-stream.ts` *(new)* | Incremental UTF-8 decode and line splitting across chunk boundaries. Pure. |
| `web/src/files/use-file.ts` *(new)* | One read's lifecycle as React state. |
| `web/src/files/text-view.tsx` *(new)* | Windowed monospace rendering of a line array. |
| `web/src/files/file-viewer.tsx` *(new)* | The dialog: header, body, truncation notice. |
| `web/src/components/terminal.tsx` | Installs the detector, owns the open-file state, renders the viewer. |
| `web/e2e/fleet.e2e.ts` | One relayed read of a real file, chunked. |

---

### Task 1: Finding paths in a line of terminal text

**Files:**
- Create: `web/src/lib/paths.ts`
- Test: `web/src/lib/paths.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `PathCandidate` (`{path: string, start: number, end: number, line?: number, col?: number}`), `findPaths(line: string): PathCandidate[]`, `MAX_CANDIDATES = 64`.

- [ ] **Step 1: Write the failing test**

Create `web/src/lib/paths.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import { findPaths, MAX_CANDIDATES } from './paths'

/** Just the paths, for the cases where the offsets are not the point. */
const paths = (line: string) => findPaths(line).map((c) => c.path)

describe('findPaths', () => {
  it('takes the four shapes a path appears in', () => {
    expect(paths('wrote /etc/hosts')).toEqual(['/etc/hosts'])
    expect(paths('see ~/.claude/settings.json')).toEqual(['~/.claude/settings.json'])
    expect(paths('run ./scripts/build.sh')).toEqual(['./scripts/build.sh'])
    expect(paths('and ../sibling/main.go')).toEqual(['../sibling/main.go'])
    expect(paths('edited internal/wire/binary.go')).toEqual(['internal/wire/binary.go'])
    expect(paths('check CLAUDE.md')).toEqual(['CLAUDE.md'])
  })

  it('leaves a bare word alone', () => {
    // The one shape that must not match, because it is most of every line.
    expect(paths('I have written the new parser and it works')).toEqual([])
  })

  it('strips the punctuation a sentence puts after a path', () => {
    expect(paths('in src/main.ts.')).toEqual(['src/main.ts'])
    expect(paths('see (src/main.ts) for it')).toEqual(['src/main.ts'])
    expect(paths('"src/main.ts", then')).toEqual(['src/main.ts'])
    expect(paths('at src/main.ts; then')).toEqual(['src/main.ts'])
    expect(paths('[src/main.ts]')).toEqual(['src/main.ts'])
  })

  it('reads a line and column suffix off the end', () => {
    expect(findPaths('src/main.ts:42')).toEqual([
      { path: 'src/main.ts', start: 0, end: 14, line: 42 },
    ])
    expect(findPaths('src/main.ts:42:7')).toEqual([
      { path: 'src/main.ts', start: 0, end: 16, line: 42, col: 7 },
    ])
    // A trailing colon is punctuation, not an empty suffix.
    expect(paths('src/main.ts:')).toEqual(['src/main.ts'])
  })

  it('underlines the suffix along with the path', () => {
    // The range covers the whole thing a reader would click, so clicking the
    // ":42" opens the file at line 42 rather than doing nothing.
    const [only] = findPaths('at src/main.ts:42 today')
    expect(only).toMatchObject({ start: 3, end: 17 })
  })

  it('leaves URLs to the link addon that already owns them', () => {
    expect(paths('https://example.com/a/b')).toEqual([])
    expect(paths('git+ssh://host/repo.git')).toEqual([])
  })

  it('does not take a flag apart into a path', () => {
    // `=` ends a token, so the value is offered on its own and the flag is not.
    expect(paths('--config=web/vite.config.ts')).toEqual(['web/vite.config.ts'])
  })

  it('offers several candidates from one line, in order, with offsets', () => {
    const line = 'moved a/b.go to c/d.go'
    expect(findPaths(line)).toEqual([
      { path: 'a/b.go', start: 6, end: 12 },
      { path: 'c/d.go', start: 16, end: 22 },
    ])
  })

  it('repeats a path that appears twice, because each one underlines', () => {
    expect(paths('a/b.go and a/b.go')).toEqual(['a/b.go', 'a/b.go'])
  })

  it('stops at the cap rather than handing back a line-length list', () => {
    const line = Array.from({ length: 200 }, (_, i) => `d/f${i}.ts`).join(' ')
    expect(findPaths(line)).toHaveLength(MAX_CANDIDATES)
  })

  it('takes no candidate from an empty line', () => {
    expect(findPaths('')).toEqual([])
    expect(findPaths('   ')).toEqual([])
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd web && pnpm vitest run src/lib/paths.test.ts`
Expected: FAIL, cannot resolve `./paths`.

- [ ] **Step 3: Write the implementation**

Create `web/src/lib/paths.ts`:

```ts
/**
 * Path-shaped runs of text, found in one line of terminal output.
 *
 * Deliberately generous, and that is the whole design of this file. Whether a
 * candidate underlines is settled by asking the daemon (see files/verify.ts),
 * so a false positive costs one entry in a batched `stat` and nothing on
 * screen, while a false negative is a path a reader can see and cannot click.
 * A matcher tuned to avoid the first produces the second.
 */

/** One run of text that might name a file. */
export interface PathCandidate {
  /** The path itself: punctuation stripped, any line and column suffix removed. */
  path: string
  /** Where the whole match begins in the line it was found in. */
  start: number
  /** One past where it ends, suffix included, so a click on `:42` still lands. */
  end: number
  /** The 1-based line a `:42` suffix named. */
  line?: number
  /** The 1-based column, which only ever appears alongside a line. */
  col?: number
}

/**
 * The most candidates one logical line yields.
 *
 * A wrapped logical line can be thousands of characters long, and every
 * candidate on it costs an entry in a `stat` batch. Sixty-four is two full
 * batches at the daemon's 32-path ceiling, which is already far past any line
 * a human is reading.
 */
export const MAX_CANDIDATES = 64

/**
 * The characters a candidate may be made of.
 *
 * Quotes, angle brackets, every kind of bracket, the pipe, the comma and the
 * equals sign all end a token rather than being stripped afterwards, because
 * each of them is punctuation *around* a path far more often than a character
 * in one. That is what lets `(src/a.ts)` and `--flag=src/a.ts` both come out as
 * `src/a.ts` with no unwinding.
 */
const TOKEN = String.raw`[^\s'"\`<>|(){}\[\],=]+`

/** What a sentence leaves on the end of a path. */
const TRAILING = /[.;:]+$/

/** A `:42` or `:42:7` on the end of an otherwise complete path. */
const SUFFIX = /:(\d+)(?::(\d+))?$/

/** A file extension: a dot and a short run of letters or digits, at the end. */
const EXTENSION = /\.[\p{L}\p{N}]{1,12}$/u

/** Somewhere in this text there is a letter, a digit or an underscore. */
const SUBSTANTIAL = /[\p{L}\p{N}_]/u

/**
 * Every path-shaped run in `line`, in the order they appear.
 *
 * Duplicates are kept: two mentions of one file are two things to underline,
 * and the caller that batches them for verification is the one that dedupes.
 */
export function findPaths(line: string): PathCandidate[] {
  // Built per call rather than hoisted. A module-level regex with the global
  // flag carries `lastIndex` between calls, and this one is called from a
  // hover handler that can be re-entered while a previous verification is
  // still in flight.
  const scanner = new RegExp(TOKEN, 'gu')
  const out: PathCandidate[] = []
  for (let m = scanner.exec(line); m !== null; m = scanner.exec(line)) {
    if (out.length >= MAX_CANDIDATES) break
    const trimmed = m[0].replace(TRAILING, '')
    if (trimmed === '') continue
    const suffix = SUFFIX.exec(trimmed)
    const path = suffix === null ? trimmed : trimmed.slice(0, suffix.index)
    if (!pathish(path)) continue
    const found: PathCandidate = { path, start: m.index, end: m.index + trimmed.length }
    if (suffix !== null) {
      found.line = Number(suffix[1])
      if (suffix[2] !== undefined) found.col = Number(suffix[2])
    }
    out.push(found)
  }
  return out
}

/**
 * Whether this run of characters is worth asking the daemon about.
 *
 * A URL is refused rather than merely unmatched: xterm's own web-links addon
 * already underlines those, and two providers offering the same range is two
 * underlines and an ambiguous click.
 */
function pathish(text: string): boolean {
  if (text === '' || text.includes('://')) return false
  if (text === '~' || text === '.' || text === '..') return false
  if (text.startsWith('/') || text.startsWith('~/')) return true
  if (text.startsWith('./') || text.startsWith('../')) return true
  if (text.includes('/')) return true
  // A bare name has to carry an extension to be told from a word. A version
  // number satisfies that and will be asked about; the daemon says no, and
  // nothing underlines.
  return EXTENSION.test(text) && SUBSTANTIAL.test(text)
}
```

- [ ] **Step 4: Run the tests and the type check**

Run: `cd web && pnpm vitest run src/lib/paths.test.ts && pnpm run lint`
Expected: PASS, and no type errors.

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/paths.ts web/src/lib/paths.test.ts
git commit -m "Find the paths in a line of terminal output, generously"
```

---

### Task 2: Assembling a wrapped line, and mapping back out of it

**Files:**
- Create: `web/src/emulator/wrap.ts`
- Test: `web/src/emulator/wrap.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `BufferRows`, `LogicalLine`, `Span`, `logicalLineAt(buf, y, cols): LogicalLine | null`, `spansFor(line, start, end): Span[]`.

This is the part that decides whether the feature works on a phone. A
90-character path in an 80-column view is two buffer rows, and a matcher run
against one row at a time finds nothing.

- [ ] **Step 1: Write the failing test**

Create `web/src/emulator/wrap.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import { logicalLineAt, spansFor, type BufferRows } from './wrap'

/**
 * A buffer built from row texts, with `|` marking a row that continues the one
 * above it. Rows are padded to `cols` the way the real assembler pads them.
 */
function buffer(cols: number, ...rows: string[]): BufferRows {
  const parsed = rows.map((r) => ({ wrapped: r.startsWith('|'), text: r.replace(/^\|/, '') }))
  return {
    length: parsed.length,
    text: (y) => parsed[y]?.text ?? null,
    isWrapped: (y) => parsed[y]?.wrapped ?? false,
  }
}

describe('logicalLineAt', () => {
  it('pads a short row out to the width, so the arithmetic holds', () => {
    const line = logicalLineAt(buffer(8, 'ab'), 0, 8)
    expect(line).toEqual({ text: 'ab      ', top: 0, cols: 8 })
  })

  it('walks backward and forward across every wrapped row', () => {
    const buf = buffer(4, 'aaaa', '|bbbb', '|cccc', 'dddd')
    // Hovering the middle row finds the whole line, not the row.
    expect(logicalLineAt(buf, 1, 4)).toEqual({ text: 'aaaabbbbcccc', top: 0, cols: 4 })
    expect(logicalLineAt(buf, 2, 4)).toEqual({ text: 'aaaabbbbcccc', top: 0, cols: 4 })
    // And stops at the row that starts a new one.
    expect(logicalLineAt(buf, 3, 4)).toEqual({ text: 'dddd', top: 3, cols: 4 })
  })

  it('has nothing to say about a row that is not there', () => {
    const buf = buffer(4, 'aaaa')
    expect(logicalLineAt(buf, 5, 4)).toBeNull()
    expect(logicalLineAt(buf, -1, 4)).toBeNull()
    expect(logicalLineAt(buf, 0, 0)).toBeNull()
  })
})

describe('spansFor', () => {
  const line = { text: 'aaaabbbbcccc', top: 7, cols: 4 }

  it('keeps a range inside one row as one span', () => {
    expect(spansFor(line, 1, 3)).toEqual([{ y: 7, x1: 1, x2: 3 }])
  })

  it('breaks a range at every row boundary it crosses', () => {
    // This is the case the phone has and the laptop does not.
    expect(spansFor(line, 2, 10)).toEqual([
      { y: 7, x1: 2, x2: 4 },
      { y: 8, x1: 0, x2: 4 },
      { y: 9, x1: 0, x2: 2 },
    ])
  })

  it('clamps a range that runs past the text', () => {
    expect(spansFor(line, 10, 99)).toEqual([{ y: 9, x1: 2, x2: 4 }])
  })

  it('has no span for an empty or inverted range', () => {
    expect(spansFor(line, 4, 4)).toEqual([])
    expect(spansFor(line, 8, 2)).toEqual([])
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd web && pnpm vitest run src/emulator/wrap.test.ts`
Expected: FAIL, cannot resolve `./wrap`.

- [ ] **Step 3: Write the implementation**

Create `web/src/emulator/wrap.ts`:

```ts
/**
 * Wrapped lines, assembled and taken apart again.
 *
 * A terminal stores what it drew, not what it was given: a path longer than
 * the window occupies two rows, and a matcher handed one row at a time finds
 * half a path or none. So a hover assembles the whole logical line, matches
 * against that, and maps the ranges it found back to the rows they came from.
 *
 * Deliberately written against a tiny structural interface rather than against
 * xterm, so the arithmetic can be tested without a DOM. See link-provider.ts
 * for the adapter.
 *
 * One known limitation, shared with xterm's own web-links addon, whose
 * LinkComputer does exactly this arithmetic: a double-width character occupies
 * two cells and contributes one unit of text, so a line carrying one has its
 * columns reported low from that point on. The cost is an underline a cell or
 * two short of the glyph. The alternative is walking cells and carrying a
 * per-unit column table, which is a great deal of machinery for a path with
 * CJK in it.
 */

/** The little of a terminal buffer that assembly needs. */
export interface BufferRows {
  /** How many rows the buffer holds, history included. */
  readonly length: number
  /** Row `y` as text, untrimmed, or null if there is no such row. */
  text(y: number): string | null
  /** Whether row `y` continues the row above it. */
  isWrapped(y: number): boolean
}

/** One logical line: every row of it, joined. */
export interface LogicalLine {
  /** The rows concatenated, each padded to exactly `cols`. */
  text: string
  /** The buffer row `text[0]` sits on. */
  top: number
  /** The width every row contributes, which is what makes the mapping exact. */
  cols: number
}

/** A run of one buffer row, in cells. */
export interface Span {
  /** The buffer row, not the viewport row. */
  y: number
  /** The first column, counted from zero. */
  x1: number
  /** One past the last column. */
  x2: number
}

/** The whole logical line row `y` belongs to, or null if there is no such row. */
export function logicalLineAt(buf: BufferRows, y: number, cols: number): LogicalLine | null {
  if (cols <= 0 || y < 0 || y >= buf.length) return null
  if (buf.text(y) === null) return null

  let top = y
  while (top > 0 && buf.isWrapped(top)) top--
  let last = y
  while (last + 1 < buf.length && buf.isWrapped(last + 1)) last++

  let text = ''
  for (let at = top; at <= last; at++) {
    // Padded and cut to exactly `cols`. Every mapping below is index division
    // by the width, so a row that came back short — which is what a terminal
    // that trimmed its trailing blanks hands over — would silently shift every
    // row under it by however many cells it was missing.
    text += (buf.text(at) ?? '').padEnd(cols, ' ').slice(0, cols)
  }
  return { text, top, cols }
}

/** Where `[start, end)` of a logical line sits on screen, one span per row. */
export function spansFor(line: LogicalLine, start: number, end: number): Span[] {
  const from = Math.max(0, Math.min(start, line.text.length))
  const to = Math.max(from, Math.min(end, line.text.length))
  const out: Span[] = []
  for (let at = from; at < to; ) {
    const x1 = at % line.cols
    const x2 = Math.min(line.cols, x1 + (to - at))
    out.push({ y: line.top + Math.floor(at / line.cols), x1, x2 })
    at += x2 - x1
  }
  return out
}
```

- [ ] **Step 4: Run the tests and the type check**

Run: `cd web && pnpm vitest run src/emulator/wrap.test.ts && pnpm run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/emulator/wrap.ts web/src/emulator/wrap.test.ts
git commit -m "Assemble a wrapped line, and map a range in it back to rows"
```

---

### Task 3: The detectLinks seam

**Files:**
- Modify: `web/src/emulator/types.ts` (append to the `Emulator` interface and the type exports)
- Create: `web/src/emulator/link-provider.ts`
- Test: `web/src/emulator/link-provider.test.ts`
- Modify: `web/src/emulator/xterm.ts`
- Modify: `web/src/testing/emulator.ts`

**Interfaces:**
- Consumes: `logicalLineAt`, `spansFor`, `BufferRows` from Task 2.
- Produces: `LinkMatch<T>`, `LinkDetector<T>`, `Emulator.detectLinks<T>(d: LinkDetector<T> | null): void`, `createLinkProvider`, `FakeEmulator.detector`.

- [ ] **Step 1: Add the seam types**

In `web/src/emulator/types.ts`, add above the `Emulator` interface:

```ts
/**
 * One range of a logical terminal line that a detector wants underlined.
 *
 * `value` is opaque here on purpose. Every emulator can underline a range of
 * text and report a click on it; what the range *means* is the app's business,
 * and naming it in this file would put paths into the seam that exists to keep
 * xterm out of the app.
 */
export interface LinkMatch<T> {
  /** Where the underline starts in the logical line. */
  start: number
  /** One past where it ends. */
  end: number
  /** Whatever `find` wants handed back to `verify` and `open`. */
  value: T
}

/**
 * What decides which parts of a terminal line are links.
 *
 * `find` is cheap and synchronous, and runs on every hovered line. `verify` is
 * allowed a round trip, and is what actually settles the underline: a
 * rejection, or an empty result, underlines nothing. Splitting the two is what
 * lets `find` be generous without underlining text that turns out to be
 * nothing.
 */
export interface LinkDetector<T> {
  /** Candidate ranges in one logical line. */
  find(line: string): Array<LinkMatch<T>>
  /** Which of them are real. A rejection is "none", not an error to raise. */
  verify(matches: Array<LinkMatch<T>>): Promise<Array<LinkMatch<T>>>
  /** The reader clicked one. */
  open(match: LinkMatch<T>): void
  /** What to show while the pointer rests on one. */
  label?(match: LinkMatch<T>): string
}
```

And inside `interface Emulator`, after `applicationCursorKeys()`:

```ts
  /**
   * Install the detector that decides which text in the terminal is a link,
   * or null to remove the one that is installed.
   *
   * Here rather than in the view for the reason `setTheme` and `focus` are
   * here: the alternative is the view reaching past this seam into xterm's own
   * link API, which is the one thing this file exists to prevent. One detector
   * at a time; installing a second replaces the first.
   */
  detectLinks<T>(detector: LinkDetector<T> | null): void
```

- [ ] **Step 2: Write the failing provider test**

Create `web/src/emulator/link-provider.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'

import { createLinkProvider, type LinkTerminal, type ProvidedLink } from './link-provider'
import type { LinkDetector } from './types'

/**
 * A terminal, structurally. The provider reads four things off a real xterm
 * and this offers exactly those four, so a change to what it reads breaks the
 * type here rather than at runtime in a browser.
 */
function terminal(opts: {
  cols: number
  rows: number
  viewportY: number
  lines: string[]
  wrapped?: number[]
}): LinkTerminal {
  const wrapped = new Set(opts.wrapped ?? [])
  return {
    cols: opts.cols,
    rows: opts.rows,
    buffer: {
      active: {
        length: opts.lines.length,
        viewportY: opts.viewportY,
        getLine: (y) =>
          opts.lines[y] === undefined
            ? undefined
            : { translateToString: () => opts.lines[y] as string, isWrapped: wrapped.has(y) },
      },
    },
  }
}

/** A detector that matches one fixed substring and says yes to it. */
function detectorFor(needle: string, verify = true): LinkDetector<string> {
  return {
    find: (line) => {
      const at = line.indexOf(needle)
      return at < 0 ? [] : [{ start: at, end: at + needle.length, value: needle }]
    },
    verify: (matches) => Promise.resolve(verify ? matches : []),
    open: vi.fn(),
    label: (m) => m.value,
  }
}

describe('createLinkProvider', () => {
  /** Ask the provider about one viewport row and resolve with its answer. */
  const ask = (term: LinkTerminal, detector: LinkDetector<string>, row: number) =>
    new Promise<ProvidedLink[] | undefined>((resolve) => {
      createLinkProvider(term, detector, () => false).provideLinks(row, resolve)
    })

  it('underlines a match on the hovered row, in viewport coordinates', async () => {
    // viewportY 10 means buffer row 12 is the third row on screen.
    const rows = Array.from({ length: 20 }, () => '')
    rows[12] = 'see a/b.go now'
    const term = terminal({ cols: 20, rows: 5, viewportY: 10, lines: rows })
    const links = await ask(term, detectorFor('a/b.go'), 3)
    expect(links).toEqual([
      // 1-based, and `end.x` is inclusive: columns 5 through 10.
      {
        range: { start: { x: 5, y: 3 }, end: { x: 10, y: 3 } },
        text: 'a/b.go',
        activate: expect.any(Function),
      },
    ])
  })

  it('finds a path that wraps across two rows and underlines both halves', async () => {
    const term = terminal({
      cols: 8,
      rows: 4,
      viewportY: 0,
      lines: ['see a/bb', 'bb/c.go '],
      wrapped: [1],
    })
    const links = await ask(term, detectorFor('a/bbbb/c.go'), 1)
    expect(links?.map((l) => l.range)).toEqual([
      { start: { x: 5, y: 1 }, end: { x: 8, y: 1 } },
      { start: { x: 1, y: 2 }, end: { x: 8, y: 2 } },
    ])
  })

  it('offers nothing when the detector refuses every candidate', async () => {
    const term = terminal({ cols: 20, rows: 5, viewportY: 0, lines: ['see a/b.go now'] })
    expect(await ask(term, detectorFor('a/b.go', false), 1)).toBeUndefined()
  })

  it('offers nothing when verification fails outright', async () => {
    // A socket that went away mid-hover. Nothing underlines, and nothing is
    // raised: a hover is not a place to report an outage.
    const term = terminal({ cols: 20, rows: 5, viewportY: 0, lines: ['see a/b.go now'] })
    const detector = detectorFor('a/b.go')
    detector.verify = () => Promise.reject(new Error('flue: connection lost'))
    expect(await ask(term, detector, 1)).toBeUndefined()
  })

  it('says nothing at all once the terminal is gone', async () => {
    // A hover, a verification round trip, and an unmount inside it. Handing
    // ranges to a disposed terminal is how xterm ends up drawing over nothing.
    const term = terminal({ cols: 20, rows: 5, viewportY: 0, lines: ['see a/b.go now'] })
    const links = await new Promise((resolve) => {
      createLinkProvider(term, detectorFor('a/b.go'), () => true).provideLinks(1, resolve)
    })
    expect(links).toBeUndefined()
  })

  it('drops a span that scrolled off the top of the viewport', async () => {
    // A logical line can start above the screen. Its rows are still part of
    // the line and still match; only the ones on screen can be underlined.
    const term = terminal({
      cols: 8,
      rows: 2,
      viewportY: 1,
      lines: ['see a/bb', 'bb/c.go '],
      wrapped: [1],
    })
    const links = await ask(term, detectorFor('a/bbbb/c.go'), 1)
    expect(links?.map((l) => l.range.start.y)).toEqual([1])
  })

  it('hands the clicked match back to the detector', async () => {
    const term = terminal({ cols: 20, rows: 5, viewportY: 0, lines: ['see a/b.go now'] })
    const detector = detectorFor('a/b.go')
    const links = await ask(term, detector, 1)
    links![0]!.activate(new MouseEvent('click'), 'a/b.go')
    expect(detector.open).toHaveBeenCalledWith({ start: 4, end: 10, value: 'a/b.go' })
  })
})
```

- [ ] **Step 3: Run it and watch it fail**

Run: `cd web && pnpm vitest run src/emulator/link-provider.test.ts`
Expected: FAIL, cannot resolve `./link-provider`.

- [ ] **Step 4: Write the provider**

Create `web/src/emulator/link-provider.ts`:

```ts
import { logicalLineAt, spansFor, type BufferRows } from './wrap'
import type { LinkDetector, LinkMatch } from './types'

/**
 * The part of xterm's Terminal this provider reads.
 *
 * Structural rather than imported, so the arithmetic can be tested against a
 * few object literals instead of against a real terminal that lays nothing out
 * under jsdom. A real `Terminal` satisfies it, which the assignment in
 * xterm.ts checks at build time.
 */
export interface LinkTerminal {
  readonly cols: number
  readonly rows: number
  readonly buffer: { readonly active: LinkBuffer }
}

export interface LinkBuffer {
  readonly length: number
  /** The buffer row at the top of what is on screen. */
  readonly viewportY: number
  getLine(y: number): LinkBufferLine | undefined
}

export interface LinkBufferLine {
  translateToString(trimRight?: boolean): string
  readonly isWrapped: boolean
}

/** One link, in the shape xterm's ILinkProvider hands back. */
export interface ProvidedLink {
  /** 1-based, viewport-relative, and `end.x` is inclusive. */
  range: { start: { x: number; y: number }; end: { x: number; y: number } }
  text: string
  activate(event: MouseEvent, text: string): void
}

export interface LinkProvider {
  provideLinks(bufferLineNumber: number, callback: (links?: ProvidedLink[]) => void): void
}

/**
 * Turn a detector into something xterm can register.
 *
 * xterm asks about one row of the viewport at a time; this asks the detector
 * about the whole logical line that row belongs to, which is the only way a
 * path that wrapped is ever found. See wrap.ts.
 *
 * The answer may be slow, which xterm allows: the callback is not required to
 * be synchronous. That is what makes verification against the daemon possible
 * at all, and it is why every screen coordinate below is computed *inside* the
 * continuation. The reader can scroll while the round trip is in flight, and
 * ranges worked out before it would land on whatever rows had moved into their
 * place.
 */
export function createLinkProvider<T>(
  term: LinkTerminal,
  detector: LinkDetector<T>,
  isDisposed: () => boolean,
): LinkProvider {
  return {
    provideLinks(bufferLineNumber, callback) {
      if (isDisposed()) {
        callback(undefined)
        return
      }
      const buf = term.buffer.active
      const line = logicalLineAt(rowsOf(buf), buf.viewportY + bufferLineNumber - 1, term.cols)
      if (line === null) {
        callback(undefined)
        return
      }
      const matches = detector.find(line.text)
      if (matches.length === 0) {
        callback(undefined)
        return
      }
      detector.verify(matches).then(
        (verified) => {
          if (isDisposed()) {
            callback(undefined)
            return
          }
          const links = verified.flatMap((m) => linksFor(term, detector, line, m))
          callback(links.length > 0 ? links : undefined)
        },
        // A hover is not a place to report an outage. Nothing underlines, the
        // negative is not remembered, and the next hover asks again.
        () => callback(undefined),
      )
    },
  }
}

function rowsOf(buf: LinkBuffer): BufferRows {
  return {
    length: buf.length,
    // Untrimmed. A trimmed row is shorter than the width, and wrap.ts divides
    // by the width to find which row a character sits on.
    text: (y) => buf.getLine(y)?.translateToString(false) ?? null,
    isWrapped: (y) => buf.getLine(y)?.isWrapped ?? false,
  }
}

function linksFor<T>(
  term: LinkTerminal,
  detector: LinkDetector<T>,
  line: { text: string; top: number; cols: number },
  match: LinkMatch<T>,
): ProvidedLink[] {
  const text = detector.label?.(match) ?? line.text.slice(match.start, match.end)
  const out: ProvidedLink[] = []
  for (const span of spansFor(line, match.start, match.end)) {
    // A logical line can begin above the screen and end below it. Those rows
    // are part of the match and none of them can be underlined.
    const y = span.y - term.buffer.active.viewportY + 1
    if (y < 1 || y > term.rows) continue
    out.push({
      // xterm counts from one, and its `end.x` is the last cell rather than
      // one past it, so the exclusive x2 converts by doing nothing at all.
      range: { start: { x: span.x1 + 1, y }, end: { x: span.x2, y } },
      text,
      activate: () => detector.open(match),
    })
  }
  return out
}
```

- [ ] **Step 5: Run the provider tests**

Run: `cd web && pnpm vitest run src/emulator/link-provider.test.ts`
Expected: PASS.

- [ ] **Step 6: Implement it on xterm**

In `web/src/emulator/xterm.ts`:

Add to the imports:

```ts
import { createLinkProvider, type LinkTerminal } from './link-provider'
import type { Emulator, Grid, LinkDetector, PixelSize, TerminalTheme } from './types'
```

Beside `let answers = false`, add:

```ts
  // The registered path-link provider, or null. One at a time: a second
  // registration would underline every range twice and make a click ambiguous
  // about which handler it reached.
  let links: { dispose(): void } | null = null
```

Add to the returned object, after `applicationCursorKeys`:

```ts
    detectLinks<T>(detector: LinkDetector<T> | null) {
      links?.dispose()
      links = null
      if (disposed || detector === null) return
      // `term` satisfies LinkTerminal structurally, and this is where that is
      // checked: the provider is tested against object literals, so this
      // assignment is the only thing standing between it and a version of
      // xterm that renamed one of the four members it reads.
      const surface: LinkTerminal = term
      links = term.registerLinkProvider(createLinkProvider(surface, detector, () => disposed))
    },
```

And in `dispose()`, before `term.dispose()`:

```ts
      links?.dispose()
      links = null
```

Also add `detectLinks` to the comment block above `setTheme` that lists the
methods safe to call after disposal — it is one of them, and its own guard is
the `if (disposed)` above.

- [ ] **Step 7: Teach the fake emulator about it**

In `web/src/testing/emulator.ts`:

Import the type:

```ts
import type { Emulator, Grid, LinkDetector, PixelSize, TerminalTheme } from '@/emulator/types'
```

Add to `FakeEmulator`:

```ts
  /**
   * The detector the view installed, or null.
   *
   * Kept as the live one rather than as a log, because what a test wants is to
   * drive it: call `find`, resolve `verify`, and click through `open`. That is
   * the whole of the terminal view's link behaviour, and through a real xterm
   * under jsdom none of it is reachable.
   */
  readonly detector: LinkDetector<unknown> | null
```

And to the object:

```ts
    detector: null,

    detectLinks<T>(detector: LinkDetector<T> | null) {
      mutable(self).detector = detector as LinkDetector<unknown> | null
    },
```

- [ ] **Step 8: Run the whole web suite and the type check**

Run: `cd web && pnpm vitest run && pnpm run lint`
Expected: PASS, 1281+ tests. `emulator.test.ts` exercises the real xterm; if it
starts failing, the `LinkTerminal` assignment is the thing to look at.

- [ ] **Step 9: Commit**

```bash
git add web/src/emulator/types.ts web/src/emulator/link-provider.ts \
  web/src/emulator/link-provider.test.ts web/src/emulator/xterm.ts \
  web/src/testing/emulator.ts
git commit -m "Put link detection behind the emulator seam, wrapped lines and all"
```

---

### Task 4: stat, read and cancel on the client

**Files:**
- Modify: `web/src/client/client.ts`
- Test: `web/src/client/client.test.ts` (append two describes)

**Interfaces:**
- Consumes: `StatMsg`, `ReadMsg`, `CancelMsg`, `StatsMsg`, `FileMsg`, `EofMsg`, `PathEntry`, `FRAME_FILE` from `./protocol`.
- Produces:
  - `MAX_STAT_PATHS = 32`
  - `statPaths(id: string, paths: string[]): Promise<PathEntry[]>`
  - `FileHandlers` = `{open(file: FileMsg): void; chunk(bytes: Uint8Array): void; end(): void; fail(err: Error): void}`
  - `FileReader` = `{cancel(): void}`
  - `readFile(id: string, path: string, on: FileHandlers): FileReader`

- [ ] **Step 1: Write the failing tests**

Append to `web/src/client/client.test.ts`. Add `FRAME_FILE` to the existing
`./protocol` import if the earlier import list does not already carry it (it
does — phase 1 added it for the fixture tests).

```ts
/** A recording set of handlers, so a test can assert the whole sequence. */
function sink() {
  const opened: FileMsg[] = []
  const chunks: string[] = []
  const ends: number[] = []
  const fails: string[] = []
  return {
    opened,
    chunks,
    ends,
    fails,
    handlers: {
      open: (f: FileMsg) => opened.push(f),
      chunk: (b: Uint8Array) => chunks.push(text(b)),
      end: () => ends.push(1),
      fail: (e: Error) => fails.push(e.message),
    },
  }
}

/** Send a `0x02` frame under `ref`, as the daemon does. */
function emitChunk(sock: FakeSocket, ref: number, body: string) {
  sock.emitBinary(FRAME_FILE, ref, body)
}

describe('FlueClient statPaths', () => {
  it('asks about every path in one message', async () => {
    const { c, sock } = connected()
    const answer = c.statPaths('s1', ['a.ts', 'b.ts'])
    const sent = sock.sentControl().find((m) => m.type === 'stat')!
    expect(sent).toMatchObject({ type: 'stat', id: 's1', paths: ['a.ts', 'b.ts'] })
    sock.emitControl({
      type: 'stats',
      reqId: sent.reqId,
      entries: [
        { path: 'a.ts', exists: true, kind: 'file', size: 3 },
        { path: 'b.ts', exists: false },
      ],
    })
    await expect(answer).resolves.toEqual([
      { path: 'a.ts', exists: true, kind: 'file', size: 3 },
      { path: 'b.ts', exists: false },
    ])
  })

  it('answers an empty ask without a round trip', async () => {
    const { c, sock } = connected()
    await expect(c.statPaths('s1', [])).resolves.toEqual([])
    expect(sock.sentControl().filter((m) => m.type === 'stat')).toHaveLength(0)
  })

  it('refuses more paths than the daemon takes, rather than sending them', async () => {
    // The daemon refuses a batch over 32 with bad_path rather than clamping
    // it (spec/protocol.md). Refusing here names the caller's bug where the
    // caller is, instead of surfacing it as a protocol error.
    const { c, sock } = connected()
    const tooMany = Array.from({ length: 33 }, (_, i) => `f${i}.ts`)
    await expect(c.statPaths('s1', tooMany)).rejects.toThrow(/33 paths/)
    expect(sock.sentControl().filter((m) => m.type === 'stat')).toHaveLength(0)
  })

  it('hands each concurrent stat its own answer', async () => {
    const { c, sock } = connected()
    const first = c.statPaths('s1', ['a'])
    const second = c.statPaths('s2', ['b'])
    const asks = sock.sentControl().filter((m) => m.type === 'stat')
    sock.emitControl({ type: 'stats', reqId: asks[1]!.reqId, entries: [{ path: 'b', exists: true, kind: 'file' }] })
    sock.emitControl({ type: 'stats', reqId: asks[0]!.reqId, entries: [{ path: 'a', exists: false }] })
    await expect(first).resolves.toEqual([{ path: 'a', exists: false }])
    await expect(second).resolves.toEqual([{ path: 'b', exists: true, kind: 'file' }])
  })

  it('rejects a stat the daemon refused', async () => {
    const { c, sock } = connected()
    const answer = c.statPaths('gone', ['a'])
    const sent = sock.sentControl().find((m) => m.type === 'stat')!
    sock.emitControl({ type: 'error', code: 'not_found', msg: 'no such session', reqId: sent.reqId })
    await expect(answer).rejects.toThrow(/no such session/)
  })

  it('does not retire a reattach plan when a stat is refused', async () => {
    // not_found answers a stat and an attach alike. Only the attach's version
    // means "stop asking for this session", exactly as for a peek.
    const { c, sock } = connected()
    c.attach('s1', 0)
    const gone: string[] = []
    c.onSessionGone((id) => gone.push(id))
    const answer = c.statPaths('s1', ['a'])
    const sent = sock.sentControl().find((m) => m.type === 'stat')!
    sock.emitControl({ type: 'error', code: 'not_found', reqId: sent.reqId })
    await expect(answer).rejects.toThrow()
    expect(gone).toEqual([])
  })

  it('rejects a stat while the socket is down', async () => {
    // The house shape for "down": dialled and not open. `harness()` and
    // `connected()` are both already in this file.
    const h = harness()
    h.c.connect()
    await expect(h.c.statPaths('s1', ['a'])).rejects.toThrow(/not connected/)
  })

  it('rejects a stat the daemon never answers', async () => {
    // A daemon older than this page answers an unknown verb with an
    // uncorrelated error{bad_message}, which reaches no asker. Without the
    // deadline the hover would never resolve, on every line, forever.
    vi.useFakeTimers()
    try {
      const { c } = connected()
      const answer = c.statPaths('s1', ['a'])
      const settled = answer.catch((e: Error) => e.message)
      await vi.advanceTimersByTimeAsync(5_000)
      expect(await settled).toMatch(/did not answer/)
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects a stat the outage carried away', async () => {
    const { c, sock } = connected()
    const answer = c.statPaths('s1', ['a'])
    sock.onclose?.()
    await expect(answer).rejects.toThrow(/connection lost/)
  })
})

describe('FlueClient readFile', () => {
  it('opens, streams in order, and ends', async () => {
    const { c, sock } = connected()
    const s = sink()
    c.readFile('s1', 'a.ts', s.handlers)
    const sent = sock.sentControl().find((m) => m.type === 'read')!
    expect(sent).toMatchObject({ type: 'read', id: 's1', path: 'a.ts' })

    sock.emitControl({
      type: 'file',
      reqId: sent.reqId,
      ref: 4,
      path: '/home/k/a.ts',
      size: 6,
      mime: 'text/plain; charset=utf-8',
      kind: 'text',
    })
    emitChunk(sock, 4, 'abc')
    emitChunk(sock, 4, 'def')
    sock.emitControl({ type: 'eof', ref: 4 })

    expect(s.opened).toHaveLength(1)
    expect(s.opened[0]!.path).toBe('/home/k/a.ts')
    expect(s.chunks).toEqual(['abc', 'def'])
    expect(s.ends).toEqual([1])
    expect(s.fails).toEqual([])
  })

  it('does not hand a file chunk to the output listeners', async () => {
    // One socket carries both. A file chunk reaching an emulator would paint
    // the file into the scrollback.
    const { c, sock } = connected()
    const output: number[] = []
    c.onOutput((ref) => output.push(ref))
    const s = sink()
    c.readFile('s1', 'a.ts', s.handlers)
    const sent = sock.sentControl().find((m) => m.type === 'read')!
    sock.emitControl({ type: 'file', reqId: sent.reqId, ref: 4, path: '/a.ts', size: 3, mime: 'text/plain', kind: 'text' })
    emitChunk(sock, 4, 'abc')
    expect(output).toEqual([])
    expect(s.chunks).toEqual(['abc'])
  })

  it('cancels a read in flight and drops what was already on the wire', async () => {
    // spec/protocol.md: a cancel stops a stream, it does not un-send one. A
    // chunk and even an eof can arrive after the cancel was handled, and both
    // are discarded by ref rather than treated as a protocol violation.
    const { c, sock } = connected()
    const s = sink()
    const reader = c.readFile('s1', 'a.ts', s.handlers)
    const sent = sock.sentControl().find((m) => m.type === 'read')!
    sock.emitControl({ type: 'file', reqId: sent.reqId, ref: 4, path: '/a.ts', size: 9, mime: 'text/plain', kind: 'text' })
    emitChunk(sock, 4, 'abc')
    reader.cancel()
    expect(sock.sentControl().find((m) => m.type === 'cancel')).toMatchObject({ ref: 4 })

    emitChunk(sock, 4, 'def')
    sock.emitControl({ type: 'eof', ref: 4 })
    expect(s.chunks).toEqual(['abc'])
    expect(s.ends).toEqual([])
    expect(s.fails).toEqual([])
  })

  it('cancels the moment the ref lands, for a viewer closed inside the round trip', async () => {
    // The common case, not the exotic one: a reader opens a file and changes
    // their mind before the daemon has answered. There is no ref to name yet.
    const { c, sock } = connected()
    const s = sink()
    const reader = c.readFile('s1', 'a.ts', s.handlers)
    const sent = sock.sentControl().find((m) => m.type === 'read')!
    reader.cancel()
    expect(sock.sentControl().filter((m) => m.type === 'cancel')).toHaveLength(0)

    sock.emitControl({ type: 'file', reqId: sent.reqId, ref: 7, path: '/a.ts', size: 3, mime: 'text/plain', kind: 'text' })
    expect(sock.sentControl().find((m) => m.type === 'cancel')).toMatchObject({ ref: 7 })
    expect(s.opened).toEqual([])
    expect(s.fails).toEqual([])
  })

  it('is safe to cancel twice, and after the end', async () => {
    const { c, sock } = connected()
    const s = sink()
    const reader = c.readFile('s1', 'a.ts', s.handlers)
    const sent = sock.sentControl().find((m) => m.type === 'read')!
    sock.emitControl({ type: 'file', reqId: sent.reqId, ref: 4, path: '/a.ts', size: 3, mime: 'text/plain', kind: 'text' })
    sock.emitControl({ type: 'eof', ref: 4 })
    reader.cancel()
    reader.cancel()
    expect(sock.sentControl().filter((m) => m.type === 'cancel')).toHaveLength(0)
    expect(s.ends).toEqual([1])
  })

  it('fails a read the daemon refused', async () => {
    const { c, sock } = connected()
    const s = sink()
    c.readFile('s1', '/etc/shadow', s.handlers)
    const sent = sock.sentControl().find((m) => m.type === 'read')!
    sock.emitControl({ type: 'error', code: 'denied', msg: 'permission denied', reqId: sent.reqId })
    expect(s.fails).toEqual(['permission denied'])
    expect(s.opened).toEqual([])
  })

  it('fails a read while the socket is down, without inventing a stream', async () => {
    const h = harness()
    h.c.connect()
    const s = sink()
    h.c.readFile('s1', 'a.ts', s.handlers)
    expect(s.fails).toEqual(['flue: not connected'])
  })

  it('fails a read the outage carried away, open or not', async () => {
    const { c, sock } = connected()
    const opening = sink()
    const streaming = sink()
    c.readFile('s1', 'a.ts', opening.handlers)
    c.readFile('s1', 'b.ts', streaming.handlers)
    const reads = sock.sentControl().filter((m) => m.type === 'read')
    sock.emitControl({ type: 'file', reqId: reads[1]!.reqId, ref: 5, path: '/b.ts', size: 3, mime: 'text/plain', kind: 'text' })
    sock.onclose?.()
    expect(opening.fails).toEqual(['flue: connection lost'])
    expect(streaming.fails).toEqual(['flue: connection lost'])
  })

  it('fails a read the daemon never answered', async () => {
    vi.useFakeTimers()
    try {
      const { c } = connected()
      const s = sink()
      c.readFile('s1', 'a.ts', s.handlers)
      await vi.advanceTimersByTimeAsync(10_000)
      expect(s.fails).toEqual(['flue: the daemon did not answer'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not time out a stream that opened and is still arriving', async () => {
    // A multi-megabyte file over a relay takes as long as it takes. Only the
    // round trip to `file` has a deadline; the stream behind it has none.
    vi.useFakeTimers()
    try {
      const { c, sock } = connected()
      const s = sink()
      c.readFile('s1', 'a.ts', s.handlers)
      const sent = sock.sentControl().find((m) => m.type === 'read')!
      sock.emitControl({ type: 'file', reqId: sent.reqId, ref: 4, path: '/a.ts', size: 99, mime: 'text/plain', kind: 'text' })
      await vi.advanceTimersByTimeAsync(60_000)
      expect(s.fails).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('stops a stream nobody is behind', async () => {
    // A `file` correlating to no request at all: a reply that outlived a
    // teardown, or a daemon answering twice. Left alone it would stream
    // megabytes into a client with nowhere to put them.
    const { c, sock } = connected()
    sock.emitControl({ type: 'file', reqId: 9999, ref: 3, path: '/a.ts', size: 3, mime: 'text/plain', kind: 'text' })
    expect(sock.sentControl().find((m) => m.type === 'cancel')).toMatchObject({ ref: 3 })
    expect(c.status).toBe('open')
  })

  it('ignores a chunk and an eof for a ref it does not hold', async () => {
    const errors: ErrorMsg[] = []
    const { c, sock } = connected()
    c.onError((e) => errors.push(e))
    emitChunk(sock, 77, 'nobody')
    sock.emitControl({ type: 'eof', ref: 77 })
    expect(errors).toEqual([])
  })
})
```

These use helpers `client.test.ts` already defines at the top of the file:
`harness()` and `connected()`, and its own `FakeSocket` with `emitControl`,
`emitBinary(type, ref, body)`, `emitRaw` and `sentControl()`. Follow the file's
existing shapes for the two outage cases: a socket that was dialled and never
opened is "down", and `sock.onclose?.()` is "the connection went away". Do not
add a second harness, and do not import the unrelated `FakeSocket` from
`@/testing/socket` into this file.

- [ ] **Step 2: Run and watch it fail**

Run: `cd web && pnpm vitest run src/client/client.test.ts`
Expected: FAIL, `c.statPaths is not a function`.

- [ ] **Step 3: Implement it**

In `web/src/client/client.ts`:

Extend the import from `./protocol` with `FRAME_FILE`, `type FileMsg`, and
`type PathEntry`.

Add beside `PEEK_TIMEOUT_MS`:

```ts
/**
 * How long a `stat` waits, and how long a `read` waits for its `file`.
 *
 * Both for `PEEK_TIMEOUT_MS`'s reason and no other: these verbs are newer than
 * the protocol's original ones, so a daemon older than this page answers them
 * with an *uncorrelated* `error{bad_message}` that reaches no asker. Without a
 * deadline a hover would sit unresolved on every line, forever.
 *
 * The read gets longer because it is not a hover: somebody clicked, a modal is
 * open, and the daemon has to open and sniff a file before it can answer. Only
 * the round trip is covered. Once `file` has arrived the stream behind it has
 * no deadline at all, because how long a multi-megabyte file takes over a
 * relay is not a thing this client can put a number on.
 */
const STAT_TIMEOUT_MS = 5_000
const READ_OPEN_TIMEOUT_MS = 10_000

/**
 * The most paths one `stat` may carry.
 *
 * The daemon refuses a larger batch with `bad_path` rather than clamping it
 * (spec/protocol.md), so a caller with more sends more messages. Checked here
 * as well so the refusal names the caller instead of arriving as a protocol
 * error with nothing to point at.
 */
export const MAX_STAT_PATHS = 32
```

Add the public shapes above `export class FlueClient`:

```ts
/**
 * What a reader wants told about one file being read.
 *
 * Exactly one of `end` and `fail` ever runs, and nothing runs after either, or
 * after `cancel`. That is the contract a viewer is written against: a
 * component that has torn its state down cannot be handed another chunk.
 */
export interface FileHandlers {
  /** The daemon opened the stream. Once, before any chunk. */
  open(file: FileMsg): void
  /** One chunk of content, in order. */
  chunk(bytes: Uint8Array): void
  /** The stream ended. Note this is not a claim that the file arrived whole. */
  end(): void
  /** It was refused, or the connection went away. Terminal. */
  fail(err: Error): void
}

/** A read in progress. */
export interface FileReader {
  /**
   * Stop it. Safe at any point, including before the daemon has answered and
   * after the stream has ended, and safe to call more than once.
   */
  cancel(): void
}

/** One read this client is carrying. */
interface ReadState {
  reqId: number
  /** The daemon's handle, once `file` has brought one. */
  ref: number | null
  on: FileHandlers
  /** Set by whichever terminal event got here first, so only one ever does. */
  over: boolean
  timer: ReturnType<typeof setTimeout> | null
}
```

Add the fields, beside `peeks`:

```ts
  /** The stats on the wire, reqId -> whoever is waiting. Settled like `peeks`. */
  private stats = new Map<
    number,
    { resolve: (e: PathEntry[]) => void; reject: (e: Error) => void }
  >()

  /** Reads that have been asked for and not yet answered, by reqId. */
  private reads = new Map<number, ReadState>()

  /** Reads that are streaming, by the ref `file` handed out. */
  private readRefs = new Map<number, ReadState>()

  /**
   * Reads cancelled before their ref arrived, by reqId.
   *
   * A viewer closed inside the round trip has nothing to name yet, so the
   * intent is remembered and the `cancel` is sent the moment `file` lands.
   * The same shape as `abandoned` above, which does this for an attach.
   */
  private readsAbandoned = new Set<number>()
```

Add the two methods, after `peek`:

```ts
  /**
   * Ask whether paths exist, resolved against a session's working directory.
   *
   * Plural because of who asks: a hovered terminal line carries several
   * candidates, and one message per candidate would be one round trip per
   * candidate, on every line the pointer crosses.
   *
   * A promise rather than an emitter, for `peek`'s reason: this question has
   * exactly one asker and exactly one answer, and an emitter would hand every
   * answer to every listener and make each of them filter.
   */
  statPaths(id: string, paths: string[]): Promise<PathEntry[]> {
    // No round trip for nothing. A line with no candidates on it is the
    // ordinary case, not the edge one.
    if (paths.length === 0) return Promise.resolve([])
    if (paths.length > MAX_STAT_PATHS) {
      return Promise.reject(
        new Error(`flue: ${paths.length} paths in one stat; the daemon takes ${MAX_STAT_PATHS}`),
      )
    }
    if (!this.ready || !this.sock) return Promise.reject(new Error('flue: not connected'))
    const reqId = this.nextReqId++
    return new Promise<PathEntry[]>((resolve, reject) => {
      const deadline = setTimeout(() => {
        if (!this.stats.delete(reqId)) return
        reject(new Error('flue: the daemon did not answer'))
      }, STAT_TIMEOUT_MS)
      const settle =
        <T,>(cb: (v: T) => void) =>
        (v: T) => {
          clearTimeout(deadline)
          cb(v)
        }
      this.stats.set(reqId, { resolve: settle(resolve), reject: settle(reject) })
      // After the entry exists, so a send that throws cannot leave a promise
      // nothing will ever settle.
      if (!this.send({ type: 'stat', id, paths, reqId })) {
        clearTimeout(deadline)
        this.stats.delete(reqId)
        reject(new Error('flue: not connected'))
      }
    })
  }

  /**
   * Read one file, resolved the way `statPaths` resolves a path.
   *
   * Callbacks rather than a promise, because a read is a stream: the head of a
   * large file should be on screen long before the tail has been sent, and a
   * promise could only resolve once it all had.
   *
   * A read that cannot start fails synchronously, before this returns. The
   * handle is built first, so a handler that reaches for it has one.
   */
  readFile(id: string, path: string, on: FileHandlers): FileReader {
    const state: ReadState = { reqId: this.nextReqId++, ref: null, on, over: false, timer: null }
    const reader: FileReader = { cancel: () => this.cancelRead(state) }
    if (!this.ready || !this.sock) {
      state.over = true
      on.fail(new Error('flue: not connected'))
      return reader
    }
    this.reads.set(state.reqId, state)
    state.timer = setTimeout(() => {
      state.timer = null
      this.reads.delete(state.reqId)
      this.failRead(state, new Error('flue: the daemon did not answer'))
    }, READ_OPEN_TIMEOUT_MS)
    this.send({ type: 'read', id, path, reqId: state.reqId })
    return reader
  }

  /**
   * Stop a read.
   *
   * Nothing answers a `cancel` and nothing is expected to: the stream stopping
   * is the whole of the reply. What arrives after it — a chunk the outbox had
   * already taken, an `eof` whose check raced the cancel — is dropped by ref,
   * which is what dropping the ref from `readRefs` here accomplishes.
   */
  private cancelRead(state: ReadState) {
    if (state.over) return
    state.over = true
    if (state.timer !== null) {
      clearTimeout(state.timer)
      state.timer = null
    }
    this.reads.delete(state.reqId)
    if (state.ref === null) {
      // Nothing to name yet. The `file` arm below sends it when the ref lands.
      this.readsAbandoned.add(state.reqId)
      return
    }
    this.readRefs.delete(state.ref)
    this.send({ type: 'cancel', ref: state.ref })
  }

  private failRead(state: ReadState, err: Error) {
    if (state.over) return
    state.over = true
    if (state.timer !== null) {
      clearTimeout(state.timer)
      state.timer = null
    }
    if (state.ref !== null) this.readRefs.delete(state.ref)
    state.on.fail(err)
  }
```

In `receive`, replace the frame-type guard:

```ts
    if (frame.type === FRAME_FILE) {
      const reading = this.readRefs.get(frame.ref)
      // A ref this client does not hold is a chunk of a read it cancelled,
      // which the daemon may still have had in flight. Dropped in silence, not
      // raised: spec/protocol.md, "A cancel stops a stream; it does not un-send
      // one". Refs only ever go up, so a cancelled ref never names a later read.
      if (reading !== undefined) reading.on.chunk(frame.payload)
      return
    }
    if (frame.type !== FRAME_OUTPUT) return
```

In `handleControl`, add three arms. Put them after the `preview` arm:

```ts
      case 'stats': {
        if (msg.reqId === undefined) break
        const waiting = this.stats.get(msg.reqId)
        if (waiting === undefined) break
        this.stats.delete(msg.reqId)
        waiting.resolve(msg.entries)
        break
      }

      case 'file': {
        if (msg.reqId !== undefined && this.readsAbandoned.delete(msg.reqId)) {
          // Asked for, then let go of before the answer arrived. The ref is
          // handed straight back rather than a stream being adopted by nobody.
          this.send({ type: 'cancel', ref: msg.ref })
          break
        }
        const state = msg.reqId === undefined ? undefined : this.reads.get(msg.reqId)
        if (state === undefined) {
          // A stream correlating to no request this client made. Stopped
          // rather than ignored: ignored, it would go on delivering megabytes
          // into a client with nowhere to put them.
          this.send({ type: 'cancel', ref: msg.ref })
          break
        }
        this.reads.delete(state.reqId)
        if (state.timer !== null) {
          clearTimeout(state.timer)
          state.timer = null
        }
        state.ref = msg.ref
        this.readRefs.set(msg.ref, state)
        state.on.open(msg)
        break
      }

      case 'eof': {
        const state = this.readRefs.get(msg.ref)
        // An eof for a ref this client cancelled, dropped for the same reason
        // its chunks are.
        if (state === undefined) break
        this.readRefs.delete(msg.ref)
        state.over = true
        state.on.end()
        break
      }
```

In the `error` arm, ahead of the peek check, add:

```ts
          const statting = this.stats.get(msg.reqId)
          if (statting !== undefined) {
            this.stats.delete(msg.reqId)
            statting.reject(new Error(msg.msg || msg.code))
            this.errorListeners.emit(msg)
            break
          }
          const reading = this.reads.get(msg.reqId)
          if (reading !== undefined) {
            this.reads.delete(msg.reqId)
            this.failRead(reading, new Error(msg.msg || msg.code))
            this.errorListeners.emit(msg)
            break
          }
          // A read that was cancelled inside its own round trip, refused
          // rather than answered. Nothing to cancel and nobody to tell.
          if (this.readsAbandoned.delete(msg.reqId)) {
            this.errorListeners.emit(msg)
            break
          }
```

Both go before the existing `this.abandoned.delete(msg.reqId)` line, and for
the same reason the peek check is there: `not_found` answers all of these, and
only an attach's version means "stop asking for this session".

In `teardown`, beside the peek rejection:

```ts
    const orphanedStats = [...this.stats.values()]
    this.stats.clear()
    for (const s of orphanedStats) s.reject(new Error('flue: connection lost'))
    // Both maps, and the abandoned set with them: refs belong to the
    // connection that issued them, so nothing here survives it.
    const orphanedReads = [...this.reads.values(), ...this.readRefs.values()]
    this.reads.clear()
    this.readRefs.clear()
    this.readsAbandoned.clear()
    for (const r of orphanedReads) this.failRead(r, new Error('flue: connection lost'))
```

- [ ] **Step 4: Run the tests and the type check**

Run: `cd web && pnpm vitest run src/client && pnpm run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/client/client.ts web/src/client/client.test.ts
git commit -m "Ask the daemon about paths, and read one file down the same socket"
```

---

### Task 5: The verifier, batched and cached

**Files:**
- Create: `web/src/files/verify.ts`
- Test: `web/src/files/verify.test.ts`

**Interfaces:**
- Consumes: `FlueClient.statPaths`, `MAX_STAT_PATHS` from Task 4.
- Produces: `PathVerifier` (`{verify(sessionId, paths): Promise<Set<string>>; clear(): void}`), `createPathVerifier(client, now?)`, `HIT_MS = 30_000`, `MISS_MS = 2_000`.

- [ ] **Step 1: Write the failing test**

Create `web/src/files/verify.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import type { PathEntry } from '@/client/protocol'
import { createPathVerifier, HIT_MS, MISS_MS } from './verify'

/** Just enough client to answer a stat, with the asks recorded. */
function daemon(answer: (paths: string[]) => PathEntry[]) {
  const asks: Array<{ id: string; paths: string[] }> = []
  let fail: Error | null = null
  const client = {
    statPaths(id: string, paths: string[]) {
      asks.push({ id, paths })
      return fail === null ? Promise.resolve(answer(paths)) : Promise.reject(fail)
    },
  }
  return { asks, client, breaks: (e: Error) => (fail = e) }
}

/** Everything exists and is a file. */
const allFiles = (paths: string[]): PathEntry[] =>
  paths.map((path) => ({ path, exists: true, kind: 'file' as const }))

describe('createPathVerifier', () => {
  it('underlines a file and nothing else', async () => {
    // A directory exists and opens perfectly well in a shell, and this cannot
    // show one. Underlining it would promise something the click cannot keep.
    const d = daemon((paths) =>
      paths.map((path) => ({
        path,
        exists: path !== 'gone',
        kind: path === 'dir' ? ('dir' as const) : ('file' as const),
      })),
    )
    const v = createPathVerifier(d.client)
    expect(await v.verify('s1', ['a.ts', 'dir', 'gone'])).toEqual(new Set(['a.ts']))
  })

  it('asks once per line, not once per candidate', async () => {
    const d = daemon(allFiles)
    const v = createPathVerifier(d.client)
    await v.verify('s1', ['a.ts', 'b.ts', 'c.ts'])
    expect(d.asks).toEqual([{ id: 's1', paths: ['a.ts', 'b.ts', 'c.ts'] }])
  })

  it('dedupes a path a line mentions twice', async () => {
    const d = daemon(allFiles)
    const v = createPathVerifier(d.client)
    await v.verify('s1', ['a.ts', 'a.ts'])
    expect(d.asks[0]!.paths).toEqual(['a.ts'])
  })

  it('splits a batch the daemon would refuse', async () => {
    // 32 is a refusal, not a clamp (spec/protocol.md), so the split is here.
    const d = daemon(allFiles)
    const v = createPathVerifier(d.client)
    const many = Array.from({ length: 40 }, (_, i) => `f${i}.ts`)
    expect(await v.verify('s1', many)).toEqual(new Set(many))
    expect(d.asks.map((a) => a.paths.length)).toEqual([32, 8])
  })

  it('remembers a hit for half a minute', async () => {
    let clock = 0
    const d = daemon(allFiles)
    const v = createPathVerifier(d.client, () => clock)
    await v.verify('s1', ['a.ts'])
    clock += HIT_MS - 1
    await v.verify('s1', ['a.ts'])
    expect(d.asks).toHaveLength(1)
    clock += 2
    await v.verify('s1', ['a.ts'])
    expect(d.asks).toHaveLength(2)
  })

  it('forgets a miss almost at once', async () => {
    // The case this exists for: an agent says it is writing src/foo.ts, the
    // pointer arrives a moment early, and a long negative would leave that
    // path dead for the rest of the session.
    let clock = 0
    const d = daemon((paths) => paths.map((path) => ({ path, exists: false })))
    const v = createPathVerifier(d.client, () => clock)
    await v.verify('s1', ['a.ts'])
    clock += MISS_MS + 1
    await v.verify('s1', ['a.ts'])
    expect(d.asks).toHaveLength(2)
  })

  it('keeps one session's answer out of another's', async () => {
    // Paths resolve against a session's own working directory, so the same
    // text is a different file in a different session.
    const d = daemon((paths) => paths.map((path) => ({ path, exists: true, kind: 'file' as const })))
    const v = createPathVerifier(d.client)
    await v.verify('s1', ['a.ts'])
    await v.verify('s2', ['a.ts'])
    expect(d.asks.map((a) => a.id)).toEqual(['s1', 's2'])
  })

  it('folds two hovers of the same line into one ask', async () => {
    let release: (e: PathEntry[]) => void = () => {}
    const asks: string[][] = []
    const client = {
      statPaths(_id: string, paths: string[]) {
        asks.push(paths)
        return new Promise<PathEntry[]>((resolve) => (release = resolve))
      },
    }
    const v = createPathVerifier(client)
    const first = v.verify('s1', ['a.ts'])
    const second = v.verify('s1', ['a.ts'])
    release([{ path: 'a.ts', exists: true, kind: 'file' }])
    expect(await first).toEqual(new Set(['a.ts']))
    expect(await second).toEqual(new Set(['a.ts']))
    expect(asks).toHaveLength(1)
  })

  it('underlines nothing when the daemon cannot be reached, and remembers nothing', async () => {
    const d = daemon(allFiles)
    d.breaks(new Error('flue: not connected'))
    const v = createPathVerifier(d.client)
    expect(await v.verify('s1', ['a.ts'])).toEqual(new Set())
    expect(d.asks).toHaveLength(1)
    // Nothing was learned, so the next hover asks again rather than sitting on
    // a two-second silence that had nothing to do with the file.
    await v.verify('s1', ['a.ts'])
    expect(d.asks).toHaveLength(2)
  })

  it('answers an empty ask without a round trip', async () => {
    const d = daemon(allFiles)
    const v = createPathVerifier(d.client)
    expect(await v.verify('s1', [])).toEqual(new Set())
    expect(d.asks).toEqual([])
  })

  it('forgets everything on demand', async () => {
    const d = daemon(allFiles)
    const v = createPathVerifier(d.client)
    await v.verify('s1', ['a.ts'])
    v.clear()
    await v.verify('s1', ['a.ts'])
    expect(d.asks).toHaveLength(2)
  })
})
```

- [ ] **Step 2: Run and watch it fail**

Run: `cd web && pnpm vitest run src/files/verify.test.ts`
Expected: FAIL, cannot resolve `./verify`.

- [ ] **Step 3: Implement it**

Create `web/src/files/verify.ts`:

```ts
import { MAX_STAT_PATHS } from '@/client/client'
import type { PathEntry } from '@/client/protocol'

/**
 * How long a path that exists stays known, and how long one that does not.
 *
 * The two are wildly different on purpose. A file that is there is usually
 * still there thirty seconds later, and asking again on every pointer movement
 * would put a round trip under every line of a scrollback.
 *
 * The negative is short because of the case this whole feature exists for: an
 * agent announces a file a moment before it writes it, the reader's pointer
 * arrives in that moment, and a long negative would leave the path dead for
 * the rest of the session with nothing to say why.
 */
export const HIT_MS = 30_000
export const MISS_MS = 2_000

/** The part of FlueClient this needs, so a test can answer with a literal. */
interface StatSource {
  statPaths(id: string, paths: string[]): Promise<PathEntry[]>
}

export interface PathVerifier {
  /** Which of these paths, in this session, are files a click could open. */
  verify(sessionId: string, paths: string[]): Promise<Set<string>>
  /** Forget everything. */
  clear(): void
}

interface Known {
  ok: boolean
  until: number
}

/**
 * The thing that decides whether a candidate underlines.
 *
 * Keyed by session as well as by text, because a relative path is resolved
 * against the session's own working directory: the same nine characters are a
 * different file in the tab next door.
 *
 * `now` is injected for the tests, which have to be able to sit on the far
 * side of a cache lifetime without waiting there.
 */
export function createPathVerifier(
  client: StatSource,
  now: () => number = () => Date.now(),
): PathVerifier {
  const known = new Map<string, Known>()
  // Asks in flight, so a line hovered twice inside one round trip is one ask.
  // xterm re-asks its link provider on every pointer move to a new row, and a
  // wrapped line is several rows of the same question.
  const asking = new Map<string, Promise<boolean>>()

  const keyFor = (sessionId: string, path: string) => `${sessionId} ${path}`

  async function learn(sessionId: string, paths: string[]): Promise<void> {
    // Batched to what the daemon takes. It refuses a larger message rather
    // than clamping it, so a long line is several messages, not a truncation.
    const batches: string[][] = []
    for (let at = 0; at < paths.length; at += MAX_STAT_PATHS) {
      batches.push(paths.slice(at, at + MAX_STAT_PATHS))
    }
    await Promise.all(
      batches.map(async (batch) => {
        const settle = new Map<string, (ok: boolean) => void>()
        for (const path of batch) {
          asking.set(
            keyFor(sessionId, path),
            new Promise<boolean>((resolve) => settle.set(path, resolve)),
          )
        }
        try {
          const entries = await client.statPaths(sessionId, batch)
          const at = now()
          for (const entry of entries) {
            // Only a file. A directory exists and this cannot show one, and an
            // underline that opens an error is worse than no underline.
            const ok = entry.exists && entry.kind === 'file'
            known.set(keyFor(sessionId, entry.path), { ok, until: at + (ok ? HIT_MS : MISS_MS) })
          }
          for (const path of batch) {
            settle.get(path)?.(known.get(keyFor(sessionId, path))?.ok ?? false)
          }
        } catch {
          // Nothing was learned about these paths, so nothing is remembered.
          // Caching this as a miss would silence a perfectly good path for two
          // seconds over an outage that had nothing to do with it.
          for (const path of batch) settle.get(path)?.(false)
        } finally {
          for (const path of batch) asking.delete(keyFor(sessionId, path))
        }
      }),
    )
  }

  return {
    async verify(sessionId, paths) {
      const wanted = [...new Set(paths)]
      if (wanted.length === 0) return new Set()

      const at = now()
      const out = new Set<string>()
      const pending: Array<Promise<void>> = []
      const unknown: string[] = []

      for (const path of wanted) {
        const key = keyFor(sessionId, path)
        const held = known.get(key)
        if (held !== undefined && held.until > at) {
          if (held.ok) out.add(path)
          continue
        }
        const inFlight = asking.get(key)
        if (inFlight !== undefined) {
          pending.push(
            inFlight.then((ok) => {
              if (ok) out.add(path)
            }),
          )
          continue
        }
        unknown.push(path)
      }

      if (unknown.length > 0) {
        pending.push(
          learn(sessionId, unknown).then(() => {
            const after = now()
            for (const path of unknown) {
              const held = known.get(keyFor(sessionId, path))
              if (held !== undefined && held.until > after && held.ok) out.add(path)
            }
          }),
        )
      }

      await Promise.all(pending)
      return out
    },

    clear() {
      known.clear()
    },
  }
}
```

- [ ] **Step 4: Run the tests and the type check**

Run: `cd web && pnpm vitest run src/files/verify.test.ts && pnpm run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/files/verify.ts web/src/files/verify.test.ts
git commit -m "Ask about a whole line at once, and remember the answer briefly"
```

---

### Task 6: Turning chunks into lines

**Files:**
- Create: `web/src/files/text-stream.ts`
- Test: `web/src/files/text-stream.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `TextStream` (`{push(bytes): void; end(): void; readonly lines: string[]}`), `createTextStream()`.

- [ ] **Step 1: Write the failing test**

Create `web/src/files/text-stream.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import { createTextStream } from './text-stream'

const utf8 = new TextEncoder()

describe('createTextStream', () => {
  it('splits what it is given into lines', () => {
    const s = createTextStream()
    s.push(utf8.encode('one\ntwo\nthree'))
    s.end()
    expect(s.lines).toEqual(['one', 'two', 'three'])
  })

  it('does not invent a last empty line from a trailing newline', () => {
    const s = createTextStream()
    s.push(utf8.encode('one\ntwo\n'))
    s.end()
    expect(s.lines).toEqual(['one', 'two'])
  })

  it('joins a line that was split across two chunks', () => {
    // 32 KiB chunks land wherever they land. A line broken in half and
    // rendered as two would be a viewer that shows a different file.
    const s = createTextStream()
    s.push(utf8.encode('one\ntw'))
    expect(s.lines).toEqual(['one'])
    s.push(utf8.encode('o\nthree'))
    s.end()
    expect(s.lines).toEqual(['one', 'two', 'three'])
  })

  it('joins a character that was split across two chunks', () => {
    // The failure this prevents is a replacement glyph in the middle of a
    // word, once every 32 KiB, in any file that is not plain ASCII.
    const bytes = utf8.encode('héllo')
    const s = createTextStream()
    s.push(bytes.subarray(0, 2))
    s.push(bytes.subarray(2))
    s.end()
    expect(s.lines).toEqual(['héllo'])
  })

  it('drops the carriage return a Windows file carries', () => {
    const s = createTextStream()
    s.push(utf8.encode('one\r\ntwo\r\n'))
    s.end()
    expect(s.lines).toEqual(['one', 'two'])
  })

  it('has no lines at all for an empty file', () => {
    const s = createTextStream()
    s.end()
    expect(s.lines).toEqual([])
  })

  it('grows the same array rather than replacing it', () => {
    // The viewer holds this array and renders a window of it. A stream that
    // handed back a new array on every chunk would make a 256-chunk file 256
    // full copies.
    const s = createTextStream()
    const held = s.lines
    s.push(utf8.encode('one\n'))
    s.push(utf8.encode('two\n'))
    s.end()
    expect(held).toBe(s.lines)
    expect(held).toEqual(['one', 'two'])
  })
})
```

- [ ] **Step 2: Run and watch it fail**

Run: `cd web && pnpm vitest run src/files/text-stream.test.ts`
Expected: FAIL, cannot resolve `./text-stream`.

- [ ] **Step 3: Implement it**

Create `web/src/files/text-stream.ts`:

```ts
/**
 * A file's chunks, becoming lines as they land.
 *
 * Two joins happen here and both of them are the difference between a viewer
 * that works and one that quietly shows the wrong thing. A 32 KiB chunk
 * boundary falls wherever the file put it: in the middle of a line, and in the
 * middle of a multi-byte character. Decoding each chunk on its own would leave
 * a replacement glyph every 32 KiB of any file that is not plain ASCII, and
 * splitting each chunk on its own would cut lines in half.
 *
 * The line array grows in place rather than being rebuilt, because the viewer
 * renders a window of it: a fresh array per chunk would be a full copy per
 * chunk, and a large file arrives in hundreds of them.
 */
export interface TextStream {
  /** Feed one chunk. */
  push(bytes: Uint8Array): void
  /** No more chunks are coming. */
  end(): void
  /** The lines so far. The same array throughout; it grows. */
  readonly lines: string[]
}

export function createTextStream(): TextStream {
  const decoder = new TextDecoder()
  const lines: string[] = []
  // What has been decoded and not yet terminated by a newline.
  let tail = ''
  let over = false

  const take = (text: string) => {
    if (text === '') return
    tail += text
    let at = tail.indexOf('\n')
    while (at >= 0) {
      lines.push(strip(tail.slice(0, at)))
      tail = tail.slice(at + 1)
      at = tail.indexOf('\n')
    }
  }

  return {
    lines,

    push(bytes) {
      if (over) return
      take(decoder.decode(bytes, { stream: true }))
    },

    end() {
      if (over) return
      over = true
      // The flush, which is what turns a dangling incomplete character at the
      // very end of a file into a replacement glyph rather than into nothing.
      take(decoder.decode())
      // A file that ended with a newline has an empty tail, and pushing it
      // would put a blank line at the bottom of every well-formed file.
      if (tail !== '') {
        lines.push(strip(tail))
        tail = ''
      }
    },
  }
}

/** The carriage return of a CRLF, which is framing rather than content. */
function strip(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line
}
```

- [ ] **Step 4: Run the tests and the type check**

Run: `cd web && pnpm vitest run src/files/text-stream.test.ts && pnpm run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/files/text-stream.ts web/src/files/text-stream.test.ts
git commit -m "Turn a file's chunks into lines, across every boundary"
```

---

### Task 7: One read, as React state

**Files:**
- Create: `web/src/files/use-file.ts`
- Test: `web/src/files/use-file.test.tsx`

**Interfaces:**
- Consumes: `FlueClient.readFile`, `FileHandlers` (Task 4); `createTextStream` (Task 6); `useFlueClient` from `@/client/provider`.
- Produces: `FileRead` (`{status, file, lines, received, error}`), `useFileRead(sessionId: string | null, path: string | null): FileRead`.

- [ ] **Step 1: Write the failing test**

Create `web/src/files/use-file.test.tsx` (JSX, so `.tsx`):

```ts
import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import type { FileMsg } from '@/client/protocol'
import { FlueClientProvider } from '@/client/provider'
import { fakeClient, type FakeSocket } from '@/testing/socket'
import { useFileRead } from './use-file'

/** A `file` reply with only the interesting fields named. */
function file(over: Partial<FileMsg> & { ref: number; reqId: number }): FileMsg {
  return {
    type: 'file',
    path: '/home/k/a.ts',
    size: 6,
    mime: 'text/plain; charset=utf-8',
    kind: 'text',
    ...over,
  }
}

function mount(sessionId: string | null, path: string | null) {
  const { client, last } = fakeClient()
  client.connect()
  act(() => last().open())
  const view = renderHook(({ id, p }: { id: string | null; p: string | null }) => useFileRead(id, p), {
    initialProps: { id: sessionId, p: path },
    wrapper: ({ children }) => <FlueClientProvider client={client}>{children}</FlueClientProvider>,
  })
  return { view, sock: () => last() as FakeSocket }
}

const readReq = (sock: FakeSocket) => sock.ofType('read')[0]!.reqId as number

describe('useFileRead', () => {
  it('asks for nothing until it is given something to open', () => {
    const { sock } = mount(null, null)
    expect(sock().ofType('read')).toHaveLength(0)
  })

  it('opens, paints as chunks land, and finishes', async () => {
    const { view, sock } = mount('s1', 'a.ts')
    const reqId = readReq(sock())
    act(() => sock().emitControl(file({ ref: 3, reqId })))
    await waitFor(() => expect(view.result.current.status).toBe('reading'))
    expect(view.result.current.file?.path).toBe('/home/k/a.ts')

    act(() => sock().emitFile(3, 'one\ntw'))
    await waitFor(() => expect(view.result.current.lines).toEqual(['one']))
    act(() => sock().emitFile(3, 'o\n'))
    act(() => sock().emitControl({ type: 'eof', ref: 3 }))
    await waitFor(() => expect(view.result.current.status).toBe('done'))
    expect(view.result.current.lines).toEqual(['one', 'two'])
    expect(view.result.current.received).toBe(8)
  })

  it('reports a refusal in the daemon's own words', async () => {
    const { view, sock } = mount('s1', '/etc/shadow')
    const reqId = readReq(sock())
    act(() =>
      sock().emitControl({ type: 'error', code: 'denied', msg: 'permission denied', reqId }),
    )
    await waitFor(() => expect(view.result.current.status).toBe('failed'))
    expect(view.result.current.error).toBe('permission denied')
  })

  it('stops the stream when the reader closes the viewer', async () => {
    const { view, sock } = mount('s1', 'a.ts')
    const reqId = readReq(sock())
    act(() => sock().emitControl(file({ ref: 3, reqId })))
    view.unmount()
    expect(sock().ofType('cancel')[0]).toMatchObject({ ref: 3 })
  })

  it('stops a stream the reader never saw open', async () => {
    // The common case: opened, thought better of, and the round trip has not
    // finished. There is no ref to cancel yet.
    const { view, sock } = mount('s1', 'a.ts')
    const reqId = readReq(sock())
    view.unmount()
    expect(sock().ofType('cancel')).toHaveLength(0)
    act(() => sock().emitControl(file({ ref: 9, reqId })))
    expect(sock().ofType('cancel')[0]).toMatchObject({ ref: 9 })
  })

  it('starts over when the path changes, and lets the old one go', async () => {
    const { view, sock } = mount('s1', 'a.ts')
    const first = readReq(sock())
    act(() => sock().emitControl(file({ ref: 3, reqId: first })))
    act(() => sock().emitFile(3, 'old\n'))
    await waitFor(() => expect(view.result.current.lines).toEqual(['old']))

    view.rerender({ id: 's1', p: 'b.ts' })
    expect(sock().ofType('cancel')[0]).toMatchObject({ ref: 3 })
    expect(view.result.current.lines).toEqual([])
    expect(view.result.current.status).toBe('opening')

    const second = sock().ofType('read')[1]!.reqId as number
    act(() => sock().emitControl(file({ ref: 4, reqId: second, path: '/home/k/b.ts' })))
    act(() => sock().emitFile(4, 'new\n'))
    await waitFor(() => expect(view.result.current.lines).toEqual(['new']))
  })

  it('does not stream an image it cannot show', async () => {
    // Phase 2 shows text. Pulling four megabytes of PNG down a socket that is
    // also carrying a terminal, to render nothing, is worth stopping.
    const { view, sock } = mount('s1', 'shot.png')
    const reqId = readReq(sock())
    act(() =>
      sock().emitControl(file({ ref: 3, reqId, kind: 'image', mime: 'image/png', size: 4096 })),
    )
    await waitFor(() => expect(view.result.current.status).toBe('done'))
    expect(sock().ofType('cancel')[0]).toMatchObject({ ref: 3 })
    expect(view.result.current.file?.kind).toBe('image')
    expect(view.result.current.lines).toEqual([])
  })
})
```

`web/src/testing/socket.ts` has no `emitFile` yet. Add it, beside `emitOutput`:

```ts
  /** One chunk of a file being read, under the ref `file` handed out. */
  emitFile(ref: number, body: string) {
    this.onmessage?.(encodeBinary(FRAME_FILE, ref, utf8.encode(body)))
  }
```

with `FRAME_FILE` added to that file's `@/client/protocol` import.

- [ ] **Step 2: Run and watch it fail**

Run: `cd web && pnpm vitest run src/files/use-file.test.tsx`
Expected: FAIL, cannot resolve `./use-file`.

- [ ] **Step 3: Implement it**

Create `web/src/files/use-file.ts`:

```ts
import { useEffect, useRef, useState } from 'react'

import { useFlueClient } from '@/client/provider'
import type { FileMsg } from '@/client/protocol'
import { createTextStream } from './text-stream'

/**
 * Where a read has got to.
 *
 * `done` covers a stream that ended for any reason, which is deliberate and is
 * the protocol's own position: the daemon says `eof` when it reaches the end
 * of a file and when it hits a read error, and a partial delivery is
 * indistinguishable from a complete one on the wire (spec/protocol.md). What
 * the viewer can say honestly is how much arrived, next to how much the daemon
 * said there was.
 */
export type FileStatus = 'idle' | 'opening' | 'reading' | 'done' | 'failed'

export interface FileRead {
  status: FileStatus
  /** The daemon's terms, once they have arrived. */
  file: FileMsg | null
  /** The lines so far. The same array throughout one read; it grows. */
  lines: string[]
  /** Bytes received, which is not `file.size` and is not meant to be. */
  received: number
  /** What went wrong, in the daemon's words where they exist. */
  error: string | null
}

const IDLE: FileRead = { status: 'idle', file: null, lines: [], received: 0, error: null }

/**
 * Read one file, as state a component can render.
 *
 * A null session or a null path is nothing being read, which is what a closed
 * viewer is. Changing either starts a fresh read and cancels the one before
 * it, so a reader clicking a second path while the first is still arriving
 * does not end up with two streams and one screen.
 *
 * Renders are coalesced to an animation frame. An eight megabyte file arrives
 * in more than two hundred chunks, and a component that re-rendered on each of
 * them would spend the whole download laying out text nobody has scrolled to.
 */
export function useFileRead(sessionId: string | null, path: string | null): FileRead {
  const client = useFlueClient()
  const [state, setState] = useState<FileRead>(IDLE)
  // The live read's own bookkeeping, off to the side of React: the callbacks
  // below fire from the socket, and one of them can land after the effect that
  // owns them has been cleaned up.
  const frame = useRef(0)

  useEffect(() => {
    if (sessionId === null || path === null) {
      setState(IDLE)
      return
    }

    const stream = createTextStream()
    const held: FileRead = {
      status: 'opening',
      file: null,
      lines: stream.lines,
      received: 0,
      error: null,
    }
    let live = true
    setState({ ...held })

    // Coalesced, not debounced: the first chunk of a large file should be on
    // screen in the next frame, and every chunk after it should cost at most
    // one more.
    const paint = () => {
      if (!live || frame.current !== 0) return
      frame.current = requestAnimationFrame(() => {
        frame.current = 0
        if (live) setState({ ...held })
      })
    }

    const reader = client.readFile(sessionId, path, {
      open(file) {
        if (!live) return
        held.file = file
        // Nothing here can render an image, and four megabytes of PNG pulled
        // down a socket that is also carrying a terminal, to be thrown away,
        // is worth the one message it costs to stop.
        if (file.kind === 'image') {
          held.status = 'done'
          reader.cancel()
        } else {
          held.status = 'reading'
        }
        setState({ ...held })
      },
      chunk(bytes) {
        if (!live) return
        held.received += bytes.length
        stream.push(bytes)
        paint()
      },
      end() {
        if (!live) return
        stream.end()
        held.status = 'done'
        setState({ ...held })
      },
      fail(err) {
        if (!live) return
        held.status = 'failed'
        held.error = err.message.replace(/^flue: /, '')
        setState({ ...held })
      },
    })

    return () => {
      live = false
      if (frame.current !== 0) {
        cancelAnimationFrame(frame.current)
        frame.current = 0
      }
      // Safe whether or not the ref has arrived: the client remembers the
      // intent and sends the cancel when it does.
      reader.cancel()
    }
  }, [client, sessionId, path])

  return state
}
```

Note the `held` object is mutated and spread into state on every paint. That is
deliberate: `lines` is the stream's own growing array and is shared by
reference, so the spread is what gives React a new object to notice while the
line array itself is never copied.

- [ ] **Step 4: Run the tests and the type check**

Run: `cd web && pnpm vitest run src/files && pnpm run lint`
Expected: PASS. If `requestAnimationFrame` is missing under jsdom, check
`web/src/testing/test-setup.ts` — it stubs several globals already; add one
there rather than in the hook.

- [ ] **Step 5: Commit**

```bash
git add web/src/files/use-file.ts web/src/files/use-file.test.tsx web/src/testing/socket.ts
git commit -m "Carry one read as state, coalesced to a frame"
```

---

### Task 8: The windowed text view

**Files:**
- Create: `web/src/files/text-view.tsx`
- Test: `web/src/files/text-view.test.tsx`

**Interfaces:**
- Consumes: nothing but React.
- Produces: `TextView` component, props `{lines: string[]; focusLine?: number}`; `LINE_HEIGHT_PX = 20`; `OVERSCAN_ROWS = 8`.

- [ ] **Step 1: Write the failing test**

Create `web/src/files/text-view.test.tsx`:

```tsx
import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { LINE_HEIGHT_PX, TextView } from './text-view'

/** Pretend the scroller is this tall. jsdom lays nothing out. */
function scrollerHeight(px: number) {
  return vi
    .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
    .mockReturnValue({ height: px, width: 600, top: 0, left: 0, right: 600, bottom: px } as DOMRect)
}

const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`)
const scroller = () => document.querySelector<HTMLElement>('[data-flue-file-scroll]')!

afterEach(() => vi.restoreAllMocks())

describe('TextView', () => {
  it('renders a window of a long file and not the whole of it', () => {
    // The property that makes an eight megabyte file openable at all.
    scrollerHeight(400)
    render(<TextView lines={lines(50_000)} />)
    const drawn = document.querySelectorAll('[data-flue-file-line]')
    expect(drawn.length).toBeGreaterThan(0)
    expect(drawn.length).toBeLessThan(100)
  })

  it('draws the lines the scroll position is over', () => {
    scrollerHeight(400)
    render(<TextView lines={lines(1000)} />)
    expect(screen.getByText('line 1')).toBeTruthy()
    const el = scroller()
    Object.defineProperty(el, 'scrollTop', { value: 500 * LINE_HEIGHT_PX, writable: true })
    fireEvent.scroll(el)
    expect(screen.getByText('line 501')).toBeTruthy()
    expect(screen.queryByText('line 1')).toBeNull()
  })

  it('gives the scroller the height of the whole file', () => {
    // Whatever is drawn, the scrollbar has to describe the file rather than
    // the window, or the thumb reports a length that is not there.
    scrollerHeight(400)
    render(<TextView lines={lines(1000)} />)
    const spacer = document.querySelector<HTMLElement>('[data-flue-file-body]')!
    expect(spacer.style.height).toBe(`${1000 * LINE_HEIGHT_PX}px`)
  })

  it('numbers every line it draws', () => {
    scrollerHeight(400)
    render(<TextView lines={lines(3)} />)
    expect(screen.getByText('3')).toBeTruthy()
  })

  it('scrolls to the line the click named, and marks it', () => {
    scrollerHeight(400)
    render(<TextView lines={lines(1000)} focusLine={600} />)
    expect(scroller().scrollTop).toBe(599 * LINE_HEIGHT_PX)
    fireEvent.scroll(scroller())
    expect(document.querySelector('[data-flue-file-line][data-focused="true"]')).toBeTruthy()
  })

  it('does not scroll to a line the file does not have', () => {
    scrollerHeight(400)
    render(<TextView lines={lines(10)} focusLine={9999} />)
    expect(scroller().scrollTop).toBe(0)
  })

  it('draws nothing for an empty file without falling over', () => {
    scrollerHeight(400)
    render(<TextView lines={[]} />)
    expect(document.querySelectorAll('[data-flue-file-line]')).toHaveLength(0)
  })
})
```

- [ ] **Step 2: Run and watch it fail**

Run: `cd web && pnpm vitest run src/files/text-view.test.tsx`
Expected: FAIL, cannot resolve `./text-view`.

- [ ] **Step 3: Implement it**

Create `web/src/files/text-view.tsx`:

```tsx
import { useEffect, useLayoutEffect, useRef, useState } from 'react'

import { cn } from '@/lib/utils'

/**
 * The height of one line, in CSS pixels, fixed and known.
 *
 * This is why there is no virtualization library here. Every line of a file in
 * a monospace face is exactly as tall as every other, so which lines are on
 * screen is a division, and a library that measures rows to find out would be
 * doing at runtime what this knows at build time.
 *
 * It has to agree with the leading the lines are actually drawn with, which is
 * the `leading` utility on the row below. A disagreement does not look broken:
 * it looks like the file drifts as you scroll.
 */
export const LINE_HEIGHT_PX = 20

/** Rows drawn above and below the window, so a fast scroll has something in it. */
export const OVERSCAN_ROWS = 8

/** The window to draw before anything has been measured. */
const UNMEASURED_ROWS = 40

export interface TextViewProps {
  /** The lines so far. May grow between renders. */
  lines: string[]
  /** A 1-based line to open at and mark, if the path that was clicked named one. */
  focusLine?: number
}

/**
 * A file's text, drawn a window at a time.
 *
 * The whole point of the windowing is the file this feature exists to open: an
 * agent transcript or a log, megabytes long, on a phone. Every line in the DOM
 * would be hundreds of thousands of nodes.
 */
export function TextView({ lines, focusLine }: TextViewProps) {
  const scroller = useRef<HTMLDivElement>(null)
  const [top, setTop] = useState(0)
  const [height, setHeight] = useState(0)

  // Measured rather than assumed, and re-measured on every resize: a phone
  // rotating, or its keyboard appearing, changes how many rows fit while the
  // same file stays open.
  useLayoutEffect(() => {
    const el = scroller.current
    if (!el) return
    const measure = () => setHeight(el.getBoundingClientRect().height)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  // The line the click named. Applied once the file is long enough to hold it,
  // which for a file still arriving is usually a few chunks after it opened.
  const landed = useRef(false)
  useEffect(() => {
    const el = scroller.current
    if (!el || landed.current) return
    if (focusLine === undefined || focusLine < 1 || focusLine > lines.length) return
    landed.current = true
    el.scrollTop = (focusLine - 1) * LINE_HEIGHT_PX
    setTop(el.scrollTop)
  }, [focusLine, lines.length])

  const rows = Math.ceil((height || UNMEASURED_ROWS * LINE_HEIGHT_PX) / LINE_HEIGHT_PX)
  const first = Math.max(0, Math.floor(top / LINE_HEIGHT_PX) - OVERSCAN_ROWS)
  const last = Math.min(lines.length, first + rows + OVERSCAN_ROWS * 2)
  // Not named `window`: this file runs in a browser, and shadowing the global
  // is the kind of thing that reads fine until somebody adds a listener.
  const visible = lines.slice(first, last)

  return (
    <div
      ref={scroller}
      data-flue-file-scroll=""
      onScroll={(e) => setTop(e.currentTarget.scrollTop)}
      className="h-full overflow-auto font-mono text-xs"
    >
      {/* The full height of the file, so the scrollbar describes the file and
          not the window. Everything drawn is positioned inside it. */}
      <div
        data-flue-file-body=""
        style={{ height: `${lines.length * LINE_HEIGHT_PX}px` }}
        className="relative"
      >
        {visible.map((text, at) => {
          const number = first + at + 1
          return (
            <div
              key={number}
              data-flue-file-line=""
              data-focused={focusLine === number ? 'true' : undefined}
              style={{ top: `${(first + at) * LINE_HEIGHT_PX}px`, height: `${LINE_HEIGHT_PX}px` }}
              className={cn(
                'absolute inset-x-0 flex items-center gap-x-3 px-3 leading-5',
                focusLine === number && 'bg-accent/10',
              )}
            >
              <span className="w-10 shrink-0 text-right tabular-nums text-muted-foreground select-none">
                {number}
              </span>
              {/* Pre, so a file's own indentation survives, and no wrapping, so
                  a long line scrolls sideways rather than pushing every line
                  under it out of the fixed height this all rests on. */}
              <span className="whitespace-pre">{text}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
```

- [ ] **Step 4: Run the tests and the type check**

Run: `cd web && pnpm vitest run src/files/text-view.test.tsx && pnpm run lint`
Expected: PASS. If `ResizeObserver` never fires under jsdom, that is expected —
`test-setup.ts` stubs it inert, which is why `UNMEASURED_ROWS` exists and why
the tests stub `getBoundingClientRect` instead.

- [ ] **Step 5: Commit**

```bash
git add web/src/files/text-view.tsx web/src/files/text-view.test.tsx
git commit -m "Draw a file a window at a time, because the height of a line is known"
```

---

### Task 9: The viewer dialog

**Files:**
- Create: `web/src/files/file-viewer.tsx`
- Test: `web/src/files/file-viewer.test.tsx`

**Interfaces:**
- Consumes: `useFileRead` (Task 7), `TextView` (Task 8), `Dialog*` from `@/components/ui/dialog`, `Copyable` from `@/components/copyable`.
- Produces: `FileViewer` component, props `{sessionId: string; target: FileTarget | null; onClose(): void; onCloseAutoFocus?(): void}`; `FileTarget` = `{path: string; line?: number}`.

- [ ] **Step 1: Write the failing test**

Create `web/src/files/file-viewer.test.tsx`:

```tsx
import { act, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { FlueClientProvider } from '@/client/provider'
import type { FileMsg } from '@/client/protocol'
import { fakeClient, type FakeSocket } from '@/testing/socket'
import { FileViewer, type FileTarget } from './file-viewer'

function file(over: Partial<FileMsg> & { ref: number; reqId: number }): FileMsg {
  return {
    type: 'file',
    path: '/home/k/work/notes.md',
    size: 8,
    mime: 'text/markdown',
    kind: 'text',
    ...over,
  }
}

function open(target: FileTarget | null) {
  const { client, last } = fakeClient()
  client.connect()
  act(() => last().open())
  const view = render(
    <FlueClientProvider client={client}>
      <FileViewer sessionId="s1" target={target} onClose={() => {}} />
    </FlueClientProvider>,
  )
  return { view, sock: () => last() as FakeSocket }
}

describe('FileViewer', () => {
  it('shows nothing at all until a path is clicked', () => {
    const { sock } = open(null)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(sock().ofType('read')).toHaveLength(0)
  })

  it('names the file, and shows where it really came from', async () => {
    // The resolved path, not the clicked one: a symlink means the file on
    // screen is the target, which is not always what was clicked.
    const { sock } = open({ path: 'notes.md' })
    const reqId = sock().ofType('read')[0]!.reqId as number
    act(() => sock().emitControl(file({ ref: 3, reqId })))
    act(() => sock().emitFile(3, 'one\ntwo\n'))
    act(() => sock().emitControl({ type: 'eof', ref: 3 }))
    await waitFor(() => expect(screen.getByText('notes.md')).toBeTruthy())
    expect(screen.getByText(/\/home\/k\/work/)).toBeTruthy()
    await waitFor(() => expect(screen.getByText('one')).toBeTruthy())
  })

  it('says how much of a truncated file it is showing', async () => {
    const { sock } = open({ path: 'huge.log' })
    const reqId = sock().ofType('read')[0]!.reqId as number
    act(() =>
      sock().emitControl(
        file({ ref: 3, reqId, path: '/home/k/huge.log', size: 20_000_000, truncated: true }),
      ),
    )
    act(() => sock().emitControl({ type: 'eof', ref: 3 }))
    await waitFor(() => expect(screen.getByText(/showing the first/i)).toBeTruthy())
  })

  it('reports a refusal instead of an empty page', async () => {
    const { sock } = open({ path: '/etc/shadow' })
    const reqId = sock().ofType('read')[0]!.reqId as number
    act(() => sock().emitControl({ type: 'error', code: 'denied', msg: 'permission denied', reqId }))
    await waitFor(() => expect(screen.getByText('permission denied')).toBeTruthy())
  })

  it('says plainly that it does not show images', async () => {
    const { sock } = open({ path: 'shot.png' })
    const reqId = sock().ofType('read')[0]!.reqId as number
    act(() =>
      sock().emitControl(file({ ref: 3, reqId, path: '/home/k/shot.png', kind: 'image', mime: 'image/png' })),
    )
    await waitFor(() => expect(screen.getByText(/image/i)).toBeTruthy())
  })
})
```

- [ ] **Step 2: Run and watch it fail**

Run: `cd web && pnpm vitest run src/files/file-viewer.test.tsx`
Expected: FAIL, cannot resolve `./file-viewer`.

- [ ] **Step 3: Implement it**

Create `web/src/files/file-viewer.tsx`:

```tsx
import type { ReactNode } from 'react'

import { Copyable } from '@/components/copyable'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { TextView } from './text-view'
import { useFileRead, type FileRead } from './use-file'

/** What a click on a path asked for. */
export interface FileTarget {
  /** The text that was clicked, resolved by the daemon and not by this. */
  path: string
  /** The line a `:42` suffix named. */
  line?: number
}

export interface FileViewerProps {
  sessionId: string
  /** What to show, or null for a viewer that is closed. */
  target: FileTarget | null
  onClose(): void
  /** Where the keyboard goes when this closes. */
  onCloseAutoFocus?(): void
}

/**
 * A file, over the session that named it.
 *
 * The header shows the resolved path rather than the clicked one, and that is
 * not pedantry: symlinks are followed by the daemon, so the file on screen is
 * the target, and a header echoing what was clicked would name a file that is
 * not the one being read.
 */
export function FileViewer({ sessionId, target, onClose, onCloseAutoFocus }: FileViewerProps) {
  const read = useFileRead(target === null ? null : sessionId, target?.path ?? null)
  const resolved = read.file?.path ?? target?.path ?? ''
  const cut = resolved.lastIndexOf('/')
  const name = cut < 0 ? resolved : resolved.slice(cut + 1)
  const directory = cut <= 0 ? '/' : resolved.slice(0, cut)

  return (
    <Dialog
      open={target !== null}
      onOpenChange={(next) => {
        // Escape, the overlay and the corner X all arrive here as `false`.
        if (!next) onClose()
      }}
    >
      <DialogContent
        onCloseAutoFocus={(event) => {
          // Radix returns focus to whatever opened the dialog, and what opened
          // this was a click on terminal output, which is not a focusable
          // thing. Left alone the keyboard lands on the document and the next
          // keystroke goes nowhere.
          event.preventDefault()
          onCloseAutoFocus?.()
        }}
        className="flex h-[80vh] flex-col gap-3 sm:max-w-3xl lg:max-w-5xl"
      >
        <DialogHeader>
          <DialogTitle className="truncate">{name || 'File'}</DialogTitle>
          <DialogDescription className="truncate">
            {directory}
            {read.file !== null && ` · ${bytes(read.file.size)}`}
          </DialogDescription>
        </DialogHeader>
        {resolved !== '' && <Copyable text={resolved} breakable />}
        <div className="min-h-0 flex-1 rounded-lg ring-1 ring-hairline">
          <Body read={read} focusLine={target?.line} />
        </div>
        {read.file?.truncated === true && (
          <p role="status" className="text-xs text-muted-foreground">
            This file is {bytes(read.file.size)}. Showing the first {bytes(read.received)}.
          </p>
        )}
      </DialogContent>
    </Dialog>
  )
}

function Body({ read, focusLine }: { read: FileRead; focusLine?: number }) {
  if (read.status === 'failed') {
    return <Notice>{read.error ?? 'This file could not be read.'}</Notice>
  }
  if (read.file?.kind === 'image') {
    // Said plainly, with no promise attached. What this shows is text.
    return <Notice>This is an image ({read.file.mime}). flue shows text files.</Notice>
  }
  if (read.status === 'opening') return <Notice>Reading…</Notice>
  if (read.lines.length === 0 && read.status === 'done') return <Notice>This file is empty.</Notice>
  return <TextView lines={read.lines} focusLine={focusLine} />
}

function Notice({ children }: { children: ReactNode }) {
  return (
    <p role="status" className="p-4 text-sm text-muted-foreground">
      {children}
    </p>
  )
}

/** A size a human reads, in the units a file manager uses. */
function bytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}
```

Check the `ring-hairline`, `bg-accent/10` and `text-muted-foreground` tokens
against `web/src/styles.css` before committing; use what that file actually
defines, and follow `web/src/components/session-table.tsx` for how the app
spells a bordered surface.

- [ ] **Step 4: Run the tests and the whole suite**

Run: `cd web && pnpm vitest run && pnpm run lint`
Expected: PASS, `styles.build.test.ts` included. That one is a real vite build
and is the guard for prose in scanned sources.

- [ ] **Step 5: Commit**

```bash
git add web/src/files/file-viewer.tsx web/src/files/file-viewer.test.tsx
git commit -m "Show the file, and say what it could not show"
```

---

### Task 10: Wiring it into the terminal

**Files:**
- Modify: `web/src/components/terminal.tsx`
- Test: `web/src/components/terminal.test.tsx` (append one describe)

**Interfaces:**
- Consumes: `findPaths` (Task 1), `LinkDetector`/`LinkMatch` (Task 3), `createPathVerifier` (Task 5), `FileViewer`/`FileTarget` (Task 9), `FakeEmulator.detector` (Task 3).
- Produces: nothing for later tasks.

- [ ] **Step 1: Write the failing test**

Append to `web/src/components/terminal.test.tsx`. It already has
`mountTerminal(children)`, which takes a render function and returns
`{client, sockets, sock, em, view, show}`; use it rather than adding a second
helper.

```tsx
describe('opening a file the session named', () => {
  const mount = () =>
    mountTerminal((e) => <Terminal sessionId="s1" createEmulator={e.create} />)

  /** A `file` reply for a read the test just watched go out. */
  const opened = (reqId: unknown, ref: number) => ({
    type: 'file',
    reqId,
    ref,
    path: '/tmp/a.ts',
    size: 1,
    mime: 'text/plain',
    kind: 'text',
  })

  it('installs a detector as soon as it has an emulator', () => {
    const { em } = mount()
    expect(em.live().detector).not.toBeNull()
  })

  it('underlines only the paths the daemon says are files', async () => {
    const { sock, em } = mount()
    const detector = em.live().detector!
    const found = detector.find('wrote src/a.ts and src/gone.ts')
    expect(found).toHaveLength(2)

    // One message for the whole line, not one per candidate.
    const verifying = detector.verify(found)
    const stat = await waitFor(() => sock.ofType('stat')[0]!)
    expect(stat.paths).toEqual(['src/a.ts', 'src/gone.ts'])
    act(() =>
      sock.emitControl({
        type: 'stats',
        reqId: stat.reqId,
        entries: [
          { path: 'src/a.ts', exists: true, kind: 'file' },
          { path: 'src/gone.ts', exists: false },
        ],
      }),
    )
    const verified = await verifying
    expect(verified.map((m) => (m.value as { path: string }).path)).toEqual(['src/a.ts'])
  })

  it('opens the viewer on a click, and reads the path that was clicked', async () => {
    const { sock, em } = mount()
    const detector = em.live().detector!
    act(() => detector.open(detector.find('see src/a.ts:12 now')[0]!))

    const read = await waitFor(() => sock.ofType('read')[0]!)
    expect(read).toMatchObject({ id: 's1', path: 'src/a.ts' })
    expect(await screen.findByRole('dialog')).toBeTruthy()
  })

  it('cancels the read when the viewer is dismissed', async () => {
    const { sock, em } = mount()
    const detector = em.live().detector!
    act(() => detector.open(detector.find('see src/a.ts')[0]!))
    const read = await waitFor(() => sock.ofType('read')[0]!)
    act(() => sock.emitControl(opened(read.reqId, 9)))
    await screen.findByRole('dialog')

    fireEvent.keyDown(document.body, { key: 'Escape' })
    await waitFor(() => expect(sock.ofType('cancel')[0]).toMatchObject({ ref: 9 }))
  })

  it('puts the keyboard back in the terminal afterwards', async () => {
    // Radix hands focus back to whatever opened a dialog, and what opened this
    // was a click on terminal output. Left alone the next keystroke goes to the
    // document and the session looks like it stopped listening.
    const { sock, em } = mount()
    const detector = em.live().detector!
    act(() => detector.open(detector.find('see src/a.ts')[0]!))
    const read = await waitFor(() => sock.ofType('read')[0]!)
    act(() => sock.emitControl(opened(read.reqId, 9)))
    await screen.findByRole('dialog')

    const before = em.live().focusCalls
    fireEvent.keyDown(document.body, { key: 'Escape' })
    await waitFor(() => expect(em.live().focusCalls).toBeGreaterThan(before))
  })

  it('leaves no read running when the view goes away', async () => {
    const { sock, em, view } = mount()
    const detector = em.live().detector!
    act(() => detector.open(detector.find('see src/a.ts')[0]!))
    const read = await waitFor(() => sock.ofType('read')[0]!)
    act(() => sock.emitControl(opened(read.reqId, 9)))
    await screen.findByRole('dialog')

    view.unmount()
    await waitFor(() => expect(sock.ofType('cancel')[0]).toMatchObject({ ref: 9 }))
  })
})
```

- [ ] **Step 2: Run and watch it fail**

Run: `cd web && pnpm vitest run src/components/terminal.test.tsx`
Expected: FAIL, `em.live().detector` is undefined or null.

- [ ] **Step 3: Wire it up**

In `web/src/components/terminal.tsx`:

Add imports:

```ts
import { FileViewer, type FileTarget } from '@/files/file-viewer'
import { createPathVerifier } from '@/files/verify'
import { findPaths, type PathCandidate } from '@/lib/paths'
```

Beside the other state, in the component body:

```ts
  // The file a click opened, or null. Not effect-local like the emulator: the
  // dialog is rendered, and the effect only ever sets it.
  const [target, setTarget] = useState<FileTarget | null>(null)
  // One verifier per client, so its cache outlives a remount and a hovered
  // line the reader comes back to costs nothing the second time.
  const verifier = useMemo(() => createPathVerifier(client), [client])
```

Inside the effect, after `emulator.focus()`:

```ts
    // What makes a path in the output clickable. `find` is generous and cheap;
    // `verify` is what decides the underline, and it asks about the whole
    // hovered line in one message rather than one per candidate.
    emulator.detectLinks<PathCandidate>({
      find: (text) => findPaths(text).map((c) => ({ start: c.start, end: c.end, value: c })),
      verify: async (matches) => {
        const real = await verifier.verify(
          sessionId,
          matches.map((m) => m.value.path),
        )
        return matches.filter((m) => real.has(m.value.path))
      },
      open: (m) => setTarget({ path: m.value.path, line: m.value.line }),
      label: (m) => m.value.path,
    })
```

Add `focus` to the `actionsRef.current` object:

```ts
      focus: () => emulator.focus(),
```

and to its type declaration above.

Add `verifier` to the effect's dependency array:

```ts
  }, [client, sessionId, createEmulator, verifier])
```

Render the viewer inside the pane, as the last child before the closing `</div>`
and after the `ExitOverlay` block:

```tsx
      <FileViewer
        sessionId={sessionId}
        target={target}
        onClose={() => setTarget(null)}
        // The dialog took the keyboard when it opened. Radix hands focus back
        // to whatever opened it, and what opened this was a click on terminal
        // output rather than a focusable control, so the terminal has to be
        // told to take it back.
        onCloseAutoFocus={() => actionsRef.current?.focus()}
      />
```

- [ ] **Step 4: Run the tests and the whole suite**

Run: `cd web && pnpm vitest run && pnpm run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/components/terminal.tsx web/src/components/terminal.test.tsx
git commit -m "Make a path in a session clickable, and open it over the session"
```

---

### Task 11: One relayed read, end to end

**Files:**
- Modify: `web/e2e/fleet.e2e.ts`

**Interfaces:**
- Consumes: everything above; `FlueClient.readFile`.
- Produces: nothing.

The 1 MiB message cap and the 32 KiB chunking only exist for real over the
relay. jsdom and a fake socket prove the bookkeeping; only this proves the
transport.

- [ ] **Step 1: Write the test**

Add a new `it` to `web/e2e/fleet.e2e.ts`, **immediately after** the test named
`'lets a browser paired on A reach B with no second ceremony'` and **before**
`'kills a revoked browser on every machine in the fleet'`. That placement is
load-bearing twice over: the pairing test is what populates the relay origin's
storage this test reuses, and the revoke test takes it away again.

```ts
  it('reads a real file on machine B, in chunks, through the relay', async () => {
    // The two numbers this whole feature is shaped around only exist here: a
    // WebSocket message is capped at 1 MiB across the relay, and content is
    // chunked at 32 KiB so it does not sit in front of a keystroke. A fake
    // socket proves the bookkeeping and can prove neither of those.
    expect(paired).not.toBeNull()

    // Big enough to be several chunks and to be nothing like a single frame.
    const body = `${MARKER}\n`.repeat(20_000)
    const file = join(fleet.b.configHome, `peek-${NONCE}.txt`)
    writeFileSync(file, body)

    open(fleet.relayOrigin)
    try {
      const sources = await fleetSources({ loopback: false, relayOrigin: fleet.relayOrigin })
      const f = new FleetClient(sources)
      const view = watch(f)
      f.connect()
      await until(
        "machine B's sessions to reach the paired browser",
        () => view.latest().sessions.some((s) => s.machineId === fleet.b.machineId),
        60_000,
      )
      const client = f.clientFor(fleet.b.machineId as string) as FlueClient
      expect(client).not.toBeNull()

      // The path is absolute, so what the session's working directory happens
      // to be does not decide whether this passes.
      const seen = await new Promise<{ file: FileMsg; text: string; chunks: number }>(
        (resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('no file before the deadline')), 60_000)
          let opened: FileMsg | null = null
          let text = ''
          let chunks = 0
          client.readFile(markerSession, file, {
            open: (f) => (opened = f),
            chunk: (bytes) => {
              chunks++
              text += new TextDecoder().decode(bytes)
            },
            end: () => {
              clearTimeout(timer)
              if (opened === null) reject(new Error('eof with no file'))
              else resolve({ file: opened, text, chunks })
            },
            fail: (err) => {
              clearTimeout(timer)
              reject(err)
            },
          })
        },
      )

      expect(seen.file.kind).toBe('text')
      expect(seen.file.size).toBe(body.length)
      expect(seen.file.path).toBe(realpathSync(file))
      expect(seen.text).toBe(body)
      // Several frames, not one: this is the property the cap depends on.
      expect(seen.chunks).toBeGreaterThan(1)

      f.close()
    } finally {
      shut()
      rmSync(file, { force: true })
    }
  })
```

Add whatever of `join`, `writeFileSync`, `rmSync` and `realpathSync` the file
does not already import, from `node:path` and `node:fs`, and `type FileMsg`
from `@/client/protocol`. Check what `fleet.e2e.ts` already imports first;
several of these are likely there.

`realpathSync` rather than the raw path, because the daemon resolves symlinks
and a temp directory on macOS sits under `/var`, which is a link to
`/private/var`. That exact trap cost phase 1 a fix round.

- [ ] **Step 2: Run it**

Run: `make e2e`
Expected: PASS. This builds `bin/flue-e2e`, starts workerd and two daemons, and
takes minutes. If `make e2e` is not the target name, check the `Makefile`; the
`web/package.json` note says the suite is reached by name only.

- [ ] **Step 3: Commit**

```bash
git add web/e2e/fleet.e2e.ts
git commit -m "Read a file on the far machine, through the relay, in chunks"
```

---

## Finishing

- [ ] `cd web && pnpm vitest run && pnpm run lint` — both clean
- [ ] `make test-go` — unchanged by this branch, run anyway
- [ ] `make e2e` — the relayed read passes
- [ ] Push `feat/file-peek-ui` and open the PR with `gh pr create`, per `CLAUDE.md`

## Self-review notes

Checked against the design doc, section by section.

- **Detection behind the emulator seam** — Task 3. `detectLinks` is the one
  method added, and its types name no path.
- **Wrapped lines** — Task 2, and the provider test in Task 3 covers a path
  split across two rows and a row scrolled off the top.
- **Candidates** — Task 1. Absolute, `~`, `./`, `../`, relative with a
  separator, bare name with an extension, trailing punctuation, `:line[:col]`.
- **Verification on hover** — Task 5. One `stat` per line, 30 s and 2 s.
- **The viewer** — Tasks 8 and 9. Windowed by arithmetic, chunks paint as they
  arrive, header carries name, directory, size and a copy button, `:line`
  scrolls and marks.
- **Testing** — `paths.test.ts`, `client.test.ts` for the stat, read and cancel
  promises and chunk routing by ref, viewer tests for windowing and the
  truncation notice, and the relayed e2e read.

Two things the design lists that are **deliberately not here**, because they are
phase 3: Shiki and everything about highlighting, and images beyond an honest
refusal to draw one. The design's build order puts both in phase 3, and says
phase 2 lands "at zero bundle cost".

One thing added that the design does not mention: deadlines on `stat` and on a
`read`'s `file` reply. The reasoning is `peek`'s own, quoted in the code — these
verbs are newer than the daemon a page may be talking to, and an uncorrelated
`bad_message` reaches no asker. Without them a hover never resolves.
