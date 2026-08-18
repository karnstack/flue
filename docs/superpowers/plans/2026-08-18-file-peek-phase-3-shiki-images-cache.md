# File peek, phase 3: Shiki, images, and the cache

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The viewer phase 2 shipped learns to colour code, to show images,
and to reopen a file for free — without touching the CSP, the wire, or the
daemon.

**Architecture:** All of Shiki loads behind dynamic imports in a module the
main bundle never references statically, driven from a Web Worker (with an
inline fallback where workers do not exist, which is also what jsdom tests
exercise). Tokens carry a light and a dark colour and render through a CSS
custom property, so the page's `prefers-color-scheme` theming keeps working
untouched. Images assemble their chunks into a `data:` URL, which
`img-src 'self' data:` already permits. An in-memory LRU keyed by client,
path, size, and mtime makes reopening free, validated by one `stat` and never
persisted to disk.

**Tech Stack:** `shiki` (fine-grained `shiki/core`, `shiki/engine/javascript`,
per-language and per-theme dynamic chunks), Vite module workers, and the
phase 2 client verbs. No Go changes.

**Spec:** `docs/superpowers/specs/2026-08-11-file-peek-design.md` (issue #79)

## Global Constraints

- The CSP does not change. The JavaScript regex engine exists precisely so
  `script-src 'self'` survives; a same-origin module worker passes under it
  (no `worker-src` is declared, so `script-src` governs), and `data:` images
  are already allowed. If an approach needs a CSP edit, the approach is wrong.
- The main bundle does not grow by Shiki. Every `shiki/*` import is dynamic,
  inside code that only runs when a file is actually highlighted. Grammars
  and themes load per language as separate chunks.
- Highlighting caps: 1 MiB or 20,000 lines, whichever comes first, and only a
  complete (`eof`, not truncated) text file with a recognised language.
  Everything past a cap renders exactly as phase 2 did: plain, windowed.
- The cache is memory only — never IndexedDB, never disk — keyed by client
  identity, path, `size`, and `mtime`, holding at most 8 MiB of bytes and
  4 MiB for any one entry. A stale pair misses; a miss reads as phase 2 does.
- Images stay under the daemon's contract: refused past 4 MiB with
  `too_large`, assembled here only on `eof`.
- **pnpm only** in `web/`. Prose in scanned sources minds the Tailwind
  scanner (`styles.build.test.ts` is the judge); `src/client/` and
  `src/testing/` are outside the perimeter.
- Branch `feat/file-peek-polish`, stacked on `feat/file-peek-viewer` (#90);
  the PR targets that branch until it lands, then retargets `main`.
  Commit after every task.

## File Structure

| File | Responsibility |
|---|---|
| `web/package.json` (modify) | The one new dependency: `shiki` |
| `web/src/files/lang.ts` (create) | Filename → Shiki language id, or null |
| `web/src/files/lang.test.ts` (create) | The mapping table |
| `web/src/files/tokenize.ts` (create) | Dynamic Shiki: caps, dual-theme tokens, per-language loading |
| `web/src/files/tokenize.test.ts` (create) | Real engine, both colours, caps, unknown language |
| `web/src/files/highlight.worker.ts` (create) | Thin worker: one message in, one answer out |
| `web/src/files/highlight.ts` (create) | The façade: worker where one exists, inline where not, stale answers dropped |
| `web/src/files/highlight.test.ts` (create) | The façade's inline path and staleness |
| `web/src/files/cache.ts` (create) | The LRU: byte budget, eviction, client-keyed |
| `web/src/files/cache.test.ts` (create) | Budget, eviction order, validator mismatch |
| `web/src/files/viewer.tsx` (modify) | Images, highlighted rows, cache consult and fill |
| `web/src/files/viewer.test.tsx` (modify) | The three new behaviours over the fake socket |

Interfaces the tasks share:

```ts
// files/lang.ts
export function languageFor(path: string): string | null

// files/tokenize.ts
export interface PeekToken { text: string; light?: string; dark?: string }
export const HIGHLIGHT_MAX_BYTES = 1 << 20
export const HIGHLIGHT_MAX_LINES = 20_000
export function tokenizePeek(text: string, lang: string): Promise<PeekToken[][] | null>

// files/highlight.ts
export function highlight(text: string, lang: string | null): Promise<PeekToken[][] | null>

// files/cache.ts
export interface CachedFile { meta: FileMsg; bytes: Uint8Array }
export function cachedFile(client: object, path: string): CachedFile | null
export function rememberFile(client: object, path: string, meta: FileMsg, bytes: Uint8Array): void
// (matching size+mtime is the caller's check, against a fresh stat)
```

---

### Task 1: the dependency

- [ ] **Step 1:** `cd web && pnpm add shiki`
- [ ] **Step 2:** `pnpm vitest run src/styles.build.test.ts` — the build must
  stay green and the main bundle must not reference shiki (assert by
  inspection: `grep -r shiki dist/assets/index-*.js` finds nothing after a
  `pnpm build`; no shiki import exists yet, so this is the baseline).
- [ ] **Step 3:** Commit `web/package.json`, `web/pnpm-lock.yaml`:
  `build(web): shiki, loaded dynamically and never in the main bundle`

### Task 2: filename → language

- [ ] **Step 1: failing tests** — `lang.test.ts`, table-driven:
  `a.ts → typescript`, `a.tsx → tsx`, `a.go → go`, `a.py → python`,
  `a.rs → rust`, `a.md → markdown`, `a.json → json`, `a.css → css`,
  `a.sh`/`a.zsh` → `shellscript`, `a.yml` → `yaml`, `Dockerfile → docker`,
  `Makefile → make`, `a.sql → sql`, `a.rb → ruby`, `a.c → c`, `a.cpp → cpp`,
  `a.java → java`, `a.swift → swift`, `a.html → html`, `a.toml → toml`,
  `a.diff → diff`, `go.mod → go-mod`? (no — keep to what shiki bundles;
  `go.mod` maps null), `a.weird → null`, `noext → null`, case-insensitive
  extensions, names matched on basename (`/x/y/Makefile`).
- [ ] **Step 2:** run, fail. **Step 3:** implement `languageFor` — lowercase
  basename; special names first (`dockerfile`, `makefile`); then a
  `Record<string, string>` of ~25 extensions. Every id must exist in
  `shiki/langs/*` (verify against `node_modules/shiki/dist/langs` while
  writing). **Step 4:** run, pass. **Step 5:** commit
  `feat(web): map a clicked file's name to a highlighter language`.

### Task 3: tokenize, capped, dual theme

- [ ] **Step 1: failing tests** — `tokenize.test.ts` drives the real engine
  (no wasm, so node/jsdom run it):

```ts
it('colours a keyword differently from a string, in both schemes', async () => {
  const lines = await tokenizePeek('const x = "hi"\n', 'typescript')
  const flat = lines!.flat()
  const kw = flat.find((t) => t.text.includes('const'))!
  const str = flat.find((t) => t.text.includes('hi'))!
  expect(kw.light).toBeTruthy()
  expect(kw.dark).toBeTruthy()
  expect(kw.light).not.toBe(str.light)
  expect(kw.dark).not.toBe(str.dark)
})
it('answers one token row per input line', async () => {
  const lines = await tokenizePeek('a\nb\nc', 'typescript')
  expect(lines).toHaveLength(3)
})
it('declines past the byte cap', async () => {
  expect(await tokenizePeek('x'.repeat(HIGHLIGHT_MAX_BYTES + 1), 'typescript')).toBeNull()
})
it('declines past the line cap', async () => {
  expect(await tokenizePeek('\n'.repeat(HIGHLIGHT_MAX_LINES + 1), 'typescript')).toBeNull()
})
it('declines a language it does not know', async () => {
  expect(await tokenizePeek('hello', 'made-up-lang')).toBeNull()
})
```

- [ ] **Step 2:** run, fail. **Step 3:** implement: a module-level lazy
  `createHighlighterCore` from `shiki/core` with
  `createJavaScriptRegexEngine()` from `shiki/engine/javascript` and the
  theme pair loaded via dynamic import (pick a restrained pair sitting with
  the zinc/teal palette — `min-light` and `min-dark`; both from
  `shiki/themes/*`); languages loaded on demand into the same core, a
  `Set` remembering which; `codeToTokens` with
  `themes: { light, dark }, defaultColor: false` and an adapter reading each
  token's CSS variables into `{ text, light, dark }`. Inspect the real token
  shape in `node_modules/shiki` while writing the adapter and pin it with the
  colour test above. Unknown language ids and every thrown grammar error
  answer `null` — plain text is the fallback, never an error.
  **Step 4:** run, pass. **Step 5:** commit
  `feat(web): capped dual-theme tokenizing behind dynamic shiki`.

### Task 4: the worker and the façade

- [ ] **Step 1: failing tests** — `highlight.test.ts`, jsdom (no `Worker`
  global), so the façade's inline path runs:

```ts
it('highlights through the inline path when no worker exists', async () => {
  const lines = await highlight('const x = 1\n', 'typescript')
  expect(lines!.flat().some((t) => t.light)).toBe(true)
})
it('answers null for a null language without loading anything', async () => {
  expect(await highlight('text', null)).toBeNull()
})
```

- [ ] **Step 2:** run, fail. **Step 3:** implement.
  `highlight.worker.ts`: `onmessage` of `{ id, text, lang }`, answers
  `{ id, lines }` via `tokenizePeek`, catches into `{ id, lines: null }`.
  `highlight.ts`: `null` lang short-circuits; if `typeof Worker` is
  undefined, dynamic-import `tokenize.ts` and run inline; otherwise a lazy
  singleton `new Worker(new URL('./highlight.worker.ts', import.meta.url), { type: 'module' })`,
  asks correlated by an increasing id, each ask's promise resolved by its
  answer alone (a stale viewer's answer resolves a promise nobody awaits —
  harmless), rejected-to-null on worker error. **Step 4:** run, pass; also
  `pnpm build` locally to prove Vite splits the worker and the shiki chunks
  out of `index-*.js` (`grep` as in Task 1). **Step 5:** commit
  `feat(web): highlighting off the main thread, plain text where it cannot be`.

### Task 5: the LRU

- [ ] **Step 1: failing tests** — `cache.test.ts`:

```ts
const meta = (over: Partial<FileMsg> = {}): FileMsg => ({
  type: 'file', ref: 1, path: '/a', size: 4, mime: 'text/plain', kind: 'text', ...over,
})
it('returns what it was given, keyed by client and path', ...)
it('answers null for a client it never saw', ...)
it('evicts the least recently used entry once the byte budget is crossed', ...)
  // three entries sized near the budget; touch the first; add a fourth;
  // the second is gone, the first stays
it('refuses any single entry past its own cap', ...)
it('a fresh remember replaces the old bytes for the same path', ...)
```

- [ ] **Step 2:** run, fail. **Step 3:** implement `cache.ts`: a module-level
  `WeakMap<object, Map<string, CachedFile>>` (the client object is the
  machine identity, and a closed client's map falls to the collector), one
  shared byte budget `CACHE_MAX_BYTES = 8 << 20`, per-entry cap
  `CACHE_ENTRY_MAX = 4 << 20`, `Map` insertion order as recency (delete +
  re-set on hit), eviction walking oldest-first across a flat list of
  `[clientMap, path]` pairs — simplest correct: keep a module-level total and
  a FIFO of `{ map, path, size }` touched-order entries. **Step 4:** run,
  pass. **Step 5:** commit
  `feat(web): reopening a file costs nothing, in memory only`.

### Task 6: the viewer learns all three

- [ ] **Step 1: failing tests** — additions to `viewer.test.tsx`:

```ts
it('renders an image from its assembled chunks as a data URL', async () => {
  // serve kind image, emit two chunks of fake PNG bytes, eof;
  // expect screen.getByRole('img', { name: 'shot.png' }).src to start with
  // 'data:image/png;base64,' and no cancel to have been sent
})
it('swaps plain rows for highlighted spans once the file is complete', async () => {
  // target a.ts; serve text; chunks; eof; await the (inline) highlighter;
  // expect a span inside a [data-file-row] carrying a style attribute
})
it('keeps plain rows for a truncated file', ...)
it('serves a reopen from the cache after one confirming stat', async () => {
  // read once to fill; unmount viewer (keep provider); remount same target;
  // expect a stat and NO second read once stats answers with the same
  // size+mtime; content on screen
})
it('re-reads when the stat says the file changed', ...)
```

- [ ] **Step 2:** run, fail. **Step 3:** implement in `viewer.tsx`:
  - **Images:** the `file` handler no longer cancels on `kind: 'image'`;
    chunks accumulate into a byte list; on `eof` assemble
    `data:${mime};base64,${b64}` (btoa over 32 KiB slices) and render
    `<img>` (alt: the basename) centred in a scrollable body,
    `max-w-full max-h-full object-contain`. The refusal copy for images
    goes; `too_large` copy stays.
  - **Highlight:** on `eof` of a complete (`!truncated`) text file, call
    `highlight(fullText, languageFor(meta.path))`; keep the raw text
    accumulated alongside the split lines (one string join is fine at these
    caps); when tokens arrive and the viewer still shows the same path, set
    them in state; `TextWindow` rows render token spans —
    `<span style={{ color: t.light, '--peek-dark': t.dark }} className="dark:text-(--peek-dark)">` —
    falling back to the plain string row when tokens are absent. The `:line`
    mark stays on the row, independent of spans.
  - **Cache:** on open, `cachedFile(client, path)`; a hit sends `stat`
    instead of `read`, and a matching `size`+`mtime` answer replays the
    cached bytes through the same paint path (chunk + eof, locally) with no
    wire read; a mismatch or a stat failure falls through to a normal read.
    On a complete, uncached `eof` (text or image, `!truncated`, within the
    entry cap) `rememberFile` with the accumulated bytes.
- [ ] **Step 4:** run the file, then the whole suite and
  `pnpm run lint`, then `pnpm vitest run src/styles.build.test.ts`.
- [ ] **Step 5:** commit
  `feat(web): colour, images, and a free reopen for the file viewer`.

### Task 7: sweep and the pull request

- [ ] `cd web && pnpm vitest run && pnpm run lint`; `go test ./...` from the
  root (unchanged, proven).
- [ ] `pnpm build` once more; confirm shiki appears only in lazy chunks.
- [ ] Push `feat/file-peek-polish`; `gh pr create --base feat/file-peek-viewer`
  titled for phase 3, body covering the CSP argument, the bundle argument,
  the caps, `Closes #79`; note it retargets `main` when #90 lands.

## Self-Review

- Spec coverage: Shiki on the JS engine with per-language lazy grammars and a
  worker (Tasks 3-4), the 1 MiB / 20k line cap (Task 3), `data:` images
  (Task 6), the memory LRU keyed by machine+path+size+mtime with stat
  validation (Tasks 5-6), theme pair sitting with the palette (Task 3). CSP
  untouched throughout.
- The one deliberate deviation from the letter of the design: tokenizing
  happens after `eof` rather than streaming, because a capped input (≤1 MiB)
  tokenizes in well under a frame budget on the JS engine and streaming
  grammar state across chunks buys nothing at that size.
- Types: `PeekToken` is defined once in `tokenize.ts` and imported by the
  worker, the façade, and the viewer; `CachedFile.meta` is the `FileMsg` the
  replay path feeds back.
