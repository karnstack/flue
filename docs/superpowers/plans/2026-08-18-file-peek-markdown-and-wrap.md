# File peek: rendered markdown, and lines that wrap

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `.md` file opens rendered with a Raw toggle beside it, and long
lines in the text view wrap by default with a toggle to turn wrapping off.

**Architecture:** Rendering is react-markdown + remark-gfm — React elements
only, raw HTML in the file is dropped by construction, so there is no
sanitizer to get wrong and the CSP stays untouched. The renderer lives in a
lazy `files/markdown.tsx` loaded the way shiki is: on the first rendered
markdown file, never in the main bundle, never precached. Wrapping replaces
the hand-rolled fixed-height window in `TextWindow` with
`@tanstack/react-virtual` (already a dependency; `routes/agent-viewer.tsx` is
the in-repo precedent), because a wrapped line's height is measured, not
arithmetic.

**Tech Stack:** react-markdown 10, remark-gfm 4, @tanstack/react-virtual.

**Spec:** this document; the parent design is
`docs/superpowers/specs/2026-08-11-file-peek-design.md`.

## Global Constraints

- No CSP change, no `dangerouslySetInnerHTML` anywhere, raw HTML in markdown
  is dropped (react-markdown's default), and links open only `http(s)` with
  `rel="noreferrer noopener"` — the `openTerminalLink` rule, applied here.
- Markdown-ecosystem chunks route to `assets/peek/` beside shiki and stay out
  of the service worker precache; the main bundle does not grow by the
  renderer.
- Rendered view exists only for a complete (`eof`, not truncated) file whose
  `languageFor` is `markdown`. Truncated markdown, and a click that carried a
  `:line` target, open raw — half a table renders as garbage, and a line
  number only means anything against raw lines.
- Wrapping defaults on, toggles off to the old horizontal-scroll behaviour,
  and the `:line` mark and scroll-to-line keep working in both.
- **pnpm only**; prose in scanned sources minds the Tailwind scanner.
- Branch `feat/file-peek-markdown`, stacked on `feat/file-peek-polish` (#91).
  Commit per task.

## File Structure

| File | Responsibility |
|---|---|
| `web/package.json` (modified) | react-markdown, remark-gfm |
| `web/src/files/markdown.tsx` (create) | `MarkdownView({ text })`: component map styled with app tokens, safe links, dropped raw HTML |
| `web/src/files/markdown.test.tsx` (create) | Headings/lists/GFM table render; script/HTML dropped; link rel/target; relative image degrades to its alt text |
| `web/src/files/viewer.tsx` (modify) | View-mode state (`rendered`/`raw`), header toggles, lazy rendered body, `TextWindow` on react-virtual with wrap |
| `web/src/files/viewer.test.tsx` (modify) | Toggle visibility rules, default choice, wrap class flip, windowing still bounded |
| `web/vite.config.ts` (modify) | Route the markdown ecosystem's chunks under `assets/peek/` |

Interfaces:

```ts
// files/markdown.tsx
export function MarkdownView({ text }: { text: string }): ReactElement
// viewer-internal
type BodyMode = 'rendered' | 'raw'
```

## Tasks

### Task 1: MarkdownView

- [ ] Failing tests: renders `# Title` as a level-1 heading role; a GFM table
  as a `table` role; `<script>alert(1)</script>` and `<img onerror=...>`
  produce no element and no text of their kind; `[x](https://a)` carries
  `rel="noreferrer noopener"` and `target="_blank"`; `[x](javascript:1)`
  renders as text, not a link; `![alt](./local.png)` renders its alt text,
  not an `img` (a relative image has no origin to load from and the CSP
  would refuse a remote one anyway).
- [ ] Implement: react-markdown with `remarkPlugins={[remarkGfm]}`, a
  `components` map covering headings, paragraphs, lists, code (both spans
  and fenced blocks, mono on `bg-muted`), blockquote, table parts, `hr`,
  `a` (scheme-checked), `img` (alt text). Classes from the app's tokens;
  container is the caller's.
- [ ] Commit: `feat(web): render markdown safely, React elements only`.

### Task 2: wrap, via react-virtual

- [ ] Failing tests: rows wrap by default (`whitespace-pre-wrap` on a row);
  the wrap toggle flips to `whitespace-pre` and back; 10k lines still mount
  fewer than ~200 row elements; the `:line` mark still lands.
- [ ] Implement: `TextWindow` moves to `useVirtualizer` —
  `estimateSize: () => 20`, `overscan: 24`, `measureElement`, item keyed by
  line number, the translate-y-by-variable idiom from
  `routes/agent-viewer.tsx:620-670`. Wrapped rows drop the `h-5` fixed
  height and use `whitespace-pre-wrap break-words`; unwrapped keeps
  `whitespace-pre` inside a `w-max min-w-full` inner box. `scrollToIndex`
  replaces the arithmetic jump. Wrap state lives in the viewer, toggled by a
  header button (`WrapText` icon, `aria-pressed`).
- [ ] Commit: `feat(web): the viewer wraps long lines, measured not assumed`.

### Task 3: the rendered/raw choice

- [ ] Failing tests: a complete `.md` opens rendered (heading visible, no
  `[data-file-row]`); the Raw toggle swaps to the text window and back; a
  `.go` file shows no such toggle; truncated markdown opens raw with no
  rendered option; a `.md` clicked with `:line` opens raw, toggle still
  offered.
- [ ] Implement: `BodyMode` state defaulting per the rules above;
  `React.lazy(() => import('./markdown'))` behind `Suspense` with a quiet
  `role="status"` fallback; header segmented pair (Rendered / Raw) shown
  only when both views exist; rendered body scrolls in
  `mx-auto w-full max-w-[72ch] px-6 py-4`.
- [ ] Commit: `feat(web): a markdown file opens readable, raw one press away`.

### Task 4: chunks and the sweep

- [ ] `vite.config.ts`: extend the peek predicate so the markdown chunks land
  under `assets/peek/` (match `files/markdown` plus the remark/micromark
  package family in module ids); `pnpm build` and verify `index-*.js` has no
  react-markdown and no new non-peek chunks appeared; `sw.build.test.ts`
  already asserts the precache rule.
- [ ] Full: `pnpm vitest run && pnpm run lint`, `go test ./...`.
- [ ] Push; PR stacked on `feat/file-peek-polish`, noting the retarget chain.

## Self-Review

- Both asks covered: rendered/raw markdown (Tasks 1, 3) and wrapping
  (Task 2). Security stance stated and tested (no raw HTML, scheme-checked
  links). Bundle and precache rules preserved (Task 4). The `:line`/raw rule
  keeps the phase 2 contract meaningful.
