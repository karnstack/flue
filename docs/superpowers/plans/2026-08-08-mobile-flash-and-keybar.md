# Mobile Flash Fix + Key Bar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Kill the both-axes shrink flash when the phone keyboard opens, and give touch devices an on-screen key bar (Esc, Tab, sticky Ctrl, mode-aware arrows) so TUIs like Claude Code are usable from a phone.

**Architecture:** (1) `relayout` in the terminal view currently scales the whole surface down whenever the pty stops fitting in either axis; when only *rows* stop fitting — exactly what a keyboard sliding over the pane does — it will now keep the surface one-to-one and let the bottom rows clip for the settle window, so nothing moves horizontally. (2) A new `lib/keys.ts` owns escape-sequence encoding (CSI vs SS3 arrows per DECCKM, Ctrl chords, sticky-Ctrl byte transform); a dumb `KeyBar` component renders chips inside the terminal pane on coarse-pointer devices; the Terminal effect wires presses into the same guarded input path keystrokes use. The emulator seam gains one method, `applicationCursorKeys()`, so arrows follow the mode the running program set.

**Tech Stack:** React + xterm.js (v6, `term.modes.applicationCursorKeysMode`) + vitest/jsdom in `web/`.

## Global Constraints

- Tailwind scans **prose** in every file under `web/` outside `*.test.*`, `src/testing/`, `src/client/` and `*.go` — a single English word that is also a utility name (even in a comment; even, for some words, as a bare identifier — `transform` was measured to leak) can compile a stray CSS rule and fail `web/src/styles.build.test.ts`. New scanned files in this plan: `web/src/lib/keys.ts`, `web/src/components/key-bar.tsx`. Known-dangerous words to keep out of their prose: `resize` (quoted), `transform`, `shrink`, `blur`, `collapse`, `grid`, `hidden`, `fixed`, `static`, `table`, `container`, `filter`, `outline`, `rounded`, `running`, `underline`, `truncate`, `visible`, `inline`, `isolate`. The guard measures build output, so after any edit to scanned sources run the full web suite (`cd web && npx vitest run` — its `styles.build.test.ts` does a real vite build, minutes; be patient) and reword whatever leaks.
- Test commands: `cd web && npx vitest run src/components/terminal.test.tsx` (or another file) focused; `cd web && npx vitest run` full.
- If a `web/package-lock.json` appears after npx runs, delete it; never stage it.
- Never edit `web/dist/`.
- Commit style: conventional prefix, body explains why, matching repo history.
- Base branch: `main`.

---

### Task 1: Clip instead of scale when only rows stop fitting

Today `relayout` (web/src/components/terminal.tsx) takes the one-to-one branch only when `want.cols >= dims.cols && want.rows >= dims.rows`, and otherwise scales the whole surface by a uniform factor. When the phone keyboard opens, the pane loses half its height for the ~150ms settle window before the pty follows, and the uniform factor pinches *both* axes — the reported "flashes to half horizontally". Fix: the one-to-one branch triggers whenever every **column** fits; rows overflowing alone means the bottom rows clip briefly (the pane has `overflow-hidden`), which the keyboard animation covers.

**Files:**
- Modify: `web/src/components/terminal.tsx` (the two-branch layout at the end of `relayout`, currently `if (want.cols >= dims.cols && want.rows >= dims.rows) {`)
- Test: `web/src/components/terminal.test.tsx` (inside `describe('the sizing policy', ...)`)

**Interfaces:**
- Consumes: existing test harness — `paneOf`, `resizeObservers`, `mountTerminal`, `attached`, `surfaceEl`, `GUTTER_PX`.
- Produces: nothing later tasks rely on.

- [ ] **Step 1: Write the failing test**

Add inside `describe('the sizing policy', ...)` in `web/src/components/terminal.test.tsx`:

```tsx
    it('stays one-to-one when only rows stop fitting, so a keyboard cannot pinch the width', async () => {
      const observers = resizeObservers()
      const box = paneOf(800 + GUTTER_PX, 408)
      const { sock, em } = mountTerminal((e) => (
        <Terminal sessionId="s1" createEmulator={e.create} />
      ))
      // 80x24 rendered at 800x408 puts a cell at 10 x 17.
      em.live().measured = { width: 800, height: 408 }
      act(() => sock.emitControl(attached({ ref: 1, id: 's1', cols: 80, rows: 24, primary: true })))

      // The keyboard takes half the pane's height: same columns, half the rows.
      box.mockReturnValue({ width: 800 + GUTTER_PX, height: 204 } as DOMRect)
      act(() => observers.fire())

      // The settled report proves the whole relayout → settle path ran…
      await waitFor(() =>
        expect(sock.ofType('resize')).toContainEqual({
          type: 'resize',
          ref: 1,
          cols: 80,
          rows: 12,
          primary: true,
        }),
      )
      // …and through all of it the surface was never scaled or resized: the
      // bottom rows clip behind the keyboard until the pty follows, and the
      // width never moves.
      expect(surfaceEl().style.scale).toBe('')
      expect(surfaceEl().style.width).toBe('')
      expect(surfaceEl().style.height).toBe('')
    })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/components/terminal.test.tsx -t 'only rows stop fitting'`
Expected: FAIL — under the current branch condition the rows-only overflow takes the scaling path, so `surface.style.scale` is a number, not `''`.

- [ ] **Step 3: Change the branch condition**

In `relayout` in `web/src/components/terminal.tsx`, replace the first branch's condition and comment (currently "The pty fits this pane — whatever view set the size, this one can show it whole — so the surface simply fills the pane and nothing is transformed."):

```ts
      if (want.cols >= dims.cols) {
        // Every column fits, so the surface lays out one-to-one whatever the
        // row count says. Rows overflowing alone is almost always this view's
        // own keyboard sliding over the pane: for the settle window the bottom
        // rows clip behind it and then the pty takes the new height. Scaling
        // here instead used to pinch both axes for that window — a lurch on
        // every keyboard open. The cost is deliberate: a view whose columns
        // fit while its rows do not shows the top of the screen until the pty
        // follows, and in the rare enduring cross-device shape of that kind,
        // scrollback still reaches what the pane cannot.
        surface.style.removeProperty('width')
        surface.style.removeProperty('height')
        surface.style.removeProperty('scale')
        return
      }

      // Columns overflow: a wider view is setting the size, and columns
      // clipping would amputate lines mid-word. Lay the surface out at the
      // screen's true size and scale the whole thing down, rather than
      // reflowing text.
```

Keep the rest of the scaling branch (the gutter comment and the three style assignments) unchanged.

- [ ] **Step 4: Run test to verify it passes, then the file, then the full suite**

Run: `cd web && npx vitest run src/components/terminal.test.tsx -t 'only rows stop fitting'` → PASS.
Run: `cd web && npx vitest run src/components/terminal.test.tsx` → PASS (the existing `scales its surface to the larger view…` test still passes: its overflow is in columns).
Run: `cd web && npx vitest run` → PASS, including `styles.build.test.ts` (the rewritten comment is scanned prose — if the guard names a leaked word, reword the comment and re-run).

- [ ] **Step 5: Commit**

```bash
git add web/src/components/terminal.tsx web/src/components/terminal.test.tsx
git commit -m "fix(web): keep the width still while the keyboard settles

Rows-only overflow now renders one-to-one with the bottom rows briefly
clipped instead of scaling the whole surface down: the uniform factor
pinched both axes for the settle window, a visible lurch on every
keyboard open. Scaling remains for column overflow, where clipping
would amputate lines."
```

---

### Task 2: Key sequences library

Pure functions for what the bar sends. Arrows are mode-aware — a full-screen program that sets DECCKM (vim, less, Claude Code's TUI) expects SS3 (`ESC O A`), a shell expects CSI (`ESC [ A`) — and Ctrl-chorded arrows are `ESC [ 1 ; 5 X` regardless of mode, which is what xterm itself emits. Sticky Ctrl over typed text is a byte transform: `c` → 0x03.

**Files:**
- Create: `web/src/lib/keys.ts`
- Test: `web/src/lib/keys.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces (Task 3 relies on these exact names): `type BarKey = 'esc' | 'tab' | 'up' | 'down' | 'left' | 'right'`; `barKeyBytes(key: BarKey, opts: { appCursor: boolean; ctrl: boolean }): Uint8Array`; `ctrlTransform(bytes: Uint8Array): Uint8Array | null`.

- [ ] **Step 1: Write the failing test**

Create `web/src/lib/keys.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { barKeyBytes, ctrlTransform } from './keys'

const text = (b: Uint8Array) => new TextDecoder().decode(b)

describe('barKeyBytes', () => {
  it('encodes arrows as CSI when the program has not asked for more', () => {
    expect(text(barKeyBytes('up', { appCursor: false, ctrl: false }))).toBe('\x1b[A')
    expect(text(barKeyBytes('down', { appCursor: false, ctrl: false }))).toBe('\x1b[B')
    expect(text(barKeyBytes('right', { appCursor: false, ctrl: false }))).toBe('\x1b[C')
    expect(text(barKeyBytes('left', { appCursor: false, ctrl: false }))).toBe('\x1b[D')
  })

  it('switches arrows to SS3 under application cursor keys', () => {
    expect(text(barKeyBytes('up', { appCursor: true, ctrl: false }))).toBe('\x1bOA')
    expect(text(barKeyBytes('left', { appCursor: true, ctrl: false }))).toBe('\x1bOD')
  })

  it('encodes Ctrl-arrows as modified CSI, whatever the cursor mode', () => {
    // xterm sends CSI 1;5 for ctrl-arrows even in application mode.
    expect(text(barKeyBytes('up', { appCursor: false, ctrl: true }))).toBe('\x1b[1;5A')
    expect(text(barKeyBytes('right', { appCursor: true, ctrl: true }))).toBe('\x1b[1;5C')
  })

  it('sends esc and tab as their single bytes, ctrl or not', () => {
    expect(text(barKeyBytes('esc', { appCursor: false, ctrl: false }))).toBe('\x1b')
    expect(text(barKeyBytes('tab', { appCursor: true, ctrl: true }))).toBe('\x09')
  })
})

describe('ctrlTransform', () => {
  const of = (...b: number[]) => Uint8Array.from(b)

  it('folds letters onto control codes, either case', () => {
    expect(ctrlTransform(of(0x63))).toEqual(of(0x03)) // c → ETX (Ctrl+C)
    expect(ctrlTransform(of(0x43))).toEqual(of(0x03)) // C too
    expect(ctrlTransform(of(0x64))).toEqual(of(0x04)) // d → EOT
  })

  it('covers the punctuation controls a terminal actually uses', () => {
    expect(ctrlTransform(of(0x5b))).toEqual(of(0x1b)) // [ → ESC
    expect(ctrlTransform(of(0x20))).toEqual(of(0x00)) // space → NUL
    expect(ctrlTransform(of(0x3f))).toEqual(of(0x7f)) // ? → DEL
  })

  it('declines anything it cannot fold', () => {
    expect(ctrlTransform(of(0x31))).toBeNull() // digit
    expect(ctrlTransform(new TextEncoder().encode('é'))).toBeNull() // multi-byte
    expect(ctrlTransform(new TextEncoder().encode('ls'))).toBeNull() // paste
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/lib/keys.test.ts`
Expected: FAIL — `./keys` does not exist.

- [ ] **Step 3: Implement `web/src/lib/keys.ts`**

```ts
/** The keys the on-screen bar offers. Ctrl is a modifier, not a key here. */
export type BarKey = 'esc' | 'tab' | 'up' | 'down' | 'left' | 'right'

const encoder = new TextEncoder()

/** VT arrow finals: CSI/SS3 A B C D are up, down, right, left — in that order. */
const ARROW_FINAL = { up: 'A', down: 'B', right: 'C', left: 'D' } as const

/**
 * The bytes a bar key sends.
 *
 * Arrows follow DECCKM — CSI for a shell, SS3 once a full-screen program has
 * asked for application cursor keys — because a bar that always sent CSI
 * would move the cursor in vim and type `A` in less. Ctrl-arrows are the
 * modified CSI form whatever the mode, which is what xterm itself emits.
 * Esc and tab are single bytes with no Ctrl form worth sending.
 */
export function barKeyBytes(key: BarKey, opts: { appCursor: boolean; ctrl: boolean }): Uint8Array {
  if (key === 'esc') return encoder.encode('\x1b')
  if (key === 'tab') return encoder.encode('\x09')
  const fin = ARROW_FINAL[key]
  if (opts.ctrl) return encoder.encode(`\x1b[1;5${fin}`)
  return encoder.encode(opts.appCursor ? `\x1bO${fin}` : `\x1b[${fin}`)
}

/**
 * Fold one typed key onto its control code, for the bar's sticky Ctrl.
 *
 * Touch keyboards carry no Ctrl, so the bar arms one and the next keystroke
 * lands here. Null means "not foldable" — a digit, a paste, a multi-byte
 * character — and the caller sends the bytes untouched; the arming is spent
 * either way, like a real sticky modifier.
 */
export function ctrlTransform(bytes: Uint8Array): Uint8Array | null {
  if (bytes.length !== 1) return null
  const b = bytes[0]!
  if (b === 0x20) return Uint8Array.of(0x00) // Ctrl+Space
  if (b === 0x3f) return Uint8Array.of(0x7f) // Ctrl+?
  if (b >= 0x61 && b <= 0x7a) return Uint8Array.of(b & 0x1f) // a-z
  if (b >= 0x40 && b <= 0x5f) return Uint8Array.of(b & 0x1f) // @, A-Z, [ \ ] ^ _
  return null
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && npx vitest run src/lib/keys.test.ts`
Expected: PASS (11 assertions across 7 tests).

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/keys.ts web/src/lib/keys.test.ts
git commit -m "feat(web): encode what an on-screen key bar sends

Arrows follow DECCKM (CSI for a shell, SS3 for vim and friends),
Ctrl-arrows are the modified CSI form either way, and a sticky Ctrl
folds the next typed byte onto its control code. Pure functions ahead
of the bar that will press them."
```

---

### Task 3: The key bar — seam method, component, wiring

Three pieces: the emulator seam gains `applicationCursorKeys()` (xterm: `term.modes.applicationCursorKeysMode`; fake: a settable field); a dumb `KeyBar` component renders the chips; the Terminal component shows it on coarse-pointer devices, reserves bottom room for it inside the inset, and routes presses and the sticky Ctrl through the same ref/mute-guarded path typed input uses.

**Files:**
- Modify: `web/src/emulator/types.ts` (add one method to `Emulator`)
- Modify: `web/src/emulator/xterm.ts` (implement it)
- Modify: `web/src/testing/emulator.ts` (fake: `appCursor` field + method)
- Create: `web/src/components/key-bar.tsx`
- Modify: `web/src/components/terminal.tsx` (state, onData transform, `sendKey` action, render)
- Test: `web/src/components/terminal.test.tsx` (new `describe('the key bar', ...)`)

**Interfaces:**
- Consumes: `BarKey`, `barKeyBytes`, `ctrlTransform` from `@/lib/keys` (Task 2, exact signatures there).
- Produces: `Emulator.applicationCursorKeys(): boolean`; `KeyBar(props: { ctrl: boolean; onCtrl: () => void; onKey: (key: BarKey) => void })`; `FakeEmulator.appCursor: boolean`.

- [ ] **Step 1: Write the failing tests**

Add to `web/src/components/terminal.test.tsx` (top-level import: add `fireEvent` is already imported; nothing new needed):

```tsx
  describe('the key bar', () => {
    /** jsdom has no matchMedia; a coarse pointer is claimed explicitly. */
    function coarsePointer() {
      vi.stubGlobal('matchMedia', (query: string) => ({
        matches: query.includes('coarse'),
        addEventListener: () => {},
        removeEventListener: () => {},
      }))
    }
    const bar = () => document.querySelector<HTMLElement>('[data-flue-keybar]')
    const key = (label: string) =>
      Array.from(document.querySelectorAll<HTMLButtonElement>('[data-flue-keybar] button')).find(
        (b) => b.textContent === label,
      )!

    it('exists only for touch', () => {
      const { sock } = mountTerminal((e) => <Terminal sessionId="s1" createEmulator={e.create} />)
      act(() => sock.emitControl(attached({ ref: 1, id: 's1' })))
      expect(bar()).toBeNull()
    })

    it('sends CSI arrows for a shell and SS3 once the program asks', () => {
      coarsePointer()
      const { sock, em } = mountTerminal((e) => (
        <Terminal sessionId="s1" createEmulator={e.create} />
      ))
      act(() => sock.emitControl(attached({ ref: 1, id: 's1' })))

      fireEvent.pointerDown(key('↑'))
      expect(sock.input()).toEqual([{ ref: 1, text: '\x1b[A' }])

      em.live().appCursor = true
      fireEvent.pointerDown(key('↓'))
      expect(sock.input()).toEqual([
        { ref: 1, text: '\x1b[A' },
        { ref: 1, text: '\x1bOB' },
      ])
    })

    it('arms Ctrl for exactly one following keystroke', () => {
      coarsePointer()
      const { sock, em } = mountTerminal((e) => (
        <Terminal sessionId="s1" createEmulator={e.create} />
      ))
      act(() => sock.emitControl(attached({ ref: 1, id: 's1' })))

      fireEvent.pointerDown(key('ctrl'))
      expect(key('ctrl').getAttribute('aria-pressed')).toBe('true')
      act(() => em.live().send('c'))
      act(() => em.live().send('c'))
      expect(sock.input()).toEqual([
        { ref: 1, text: '\x03' },
        { ref: 1, text: 'c' },
      ])
      expect(key('ctrl').getAttribute('aria-pressed')).toBe('false')
    })

    it('chords Ctrl with an arrow', () => {
      coarsePointer()
      const { sock } = mountTerminal((e) => <Terminal sessionId="s1" createEmulator={e.create} />)
      act(() => sock.emitControl(attached({ ref: 1, id: 's1' })))

      fireEvent.pointerDown(key('ctrl'))
      fireEvent.pointerDown(key('→'))
      expect(sock.input()).toEqual([{ ref: 1, text: '\x1b[1;5C' }])
      expect(key('ctrl').getAttribute('aria-pressed')).toBe('false')
    })

    it('drops bar keys pressed before the attach comes back', () => {
      coarsePointer()
      const { sock } = mountTerminal((e) => <Terminal sessionId="s1" createEmulator={e.create} />)
      fireEvent.pointerDown(key('esc'))
      expect(sock.input()).toEqual([])
    })

    it('reserves bottom room in the inset so the bar covers no rows', () => {
      coarsePointer()
      mountTerminal((e) => <Terminal sessionId="s1" createEmulator={e.create} />)
      expect(inset().className).toContain('bottom-16')
    })
  })
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web && npx vitest run src/components/terminal.test.tsx -t 'key bar'`
Expected: FAIL — no `[data-flue-keybar]` renders (and `appCursor` does not exist on the fake yet). The `exists only for touch` case may pass vacuously; the rest must fail.

- [ ] **Step 3: Add the seam method**

`web/src/emulator/types.ts`, append to the `Emulator` interface (after `answerQueries`); also amend the interface's opening doc comment ("talks to these ten methods") to not count methods — reword that clause to "talks to this interface", since the count is now wrong either way:

```ts
  /**
   * Whether the program has asked for application cursor keys (DECCKM).
   *
   * The on-screen key bar synthesises arrow presses, and an arrow's encoding
   * is the program's choice, not the bar's: CSI moves history at a shell,
   * SS3 is what vim and friends expect once they have set the mode. Reading
   * it here keeps the bar as mode-honest as a hardware keyboard through
   * xterm would be.
   */
  applicationCursorKeys(): boolean
```

`web/src/emulator/xterm.ts`, inside the returned emulator object (beside `answerQueries`):

```ts
    applicationCursorKeys: () => term.modes.applicationCursorKeysMode,
```

`web/src/testing/emulator.ts`: add `appCursor: boolean` to the `FakeEmulator` interface with the doc `/** What applicationCursorKeys() reports; set by hand like measured. */`, initialise `appCursor: false` in the object literal, and add the method:

```ts
    applicationCursorKeys: () => self.appCursor,
```

- [ ] **Step 4: Create `web/src/components/key-bar.tsx`**

```tsx
import type { BarKey } from '@/lib/keys'
import { cn } from '@/lib/utils'

const KEYS: ReadonlyArray<{ key: BarKey; label: string; name: string }> = [
  { key: 'esc', label: 'esc', name: 'Escape' },
  { key: 'tab', label: 'tab', name: 'Tab' },
  { key: 'left', label: '←', name: 'Arrow left' },
  { key: 'down', label: '↓', name: 'Arrow down' },
  { key: 'up', label: '↑', name: 'Arrow up' },
  { key: 'right', label: '→', name: 'Arrow right' },
]

/**
 * The touch device's missing keys, floated over the terminal's bottom edge.
 *
 * Presses land on pointerdown, and the handler prevents the default so the
 * press never takes focus from xterm's textarea — losing it would close the
 * very keyboard the bar exists to work beside. Ctrl is sticky: one press
 * arms it for the next key, bar or typed, and the Terminal owns that state
 * because the fold happens on the input path, not here.
 */
export function KeyBar(props: {
  ctrl: boolean
  onCtrl: () => void
  onKey: (key: BarKey) => void
}) {
  const chip = 'rounded-md px-2.5 py-1.5 font-mono text-sm/4 transition-colors select-none'
  return (
    <div
      data-flue-keybar=""
      className={cn(
        'absolute bottom-3 left-1/2 z-10 flex -translate-x-1/2 items-center gap-x-1',
        'rounded-lg bg-(--chip-bg) p-1 shadow-lg ring-1 ring-(--chip-ring) backdrop-blur-sm',
      )}
    >
      <button
        type="button"
        aria-pressed={props.ctrl}
        title="Ctrl, for the next key"
        onPointerDown={(e) => {
          e.preventDefault()
          props.onCtrl()
        }}
        className={cn(
          chip,
          props.ctrl
            ? 'bg-(--chip-wash) text-(--chip-fg)'
            : 'text-(--chip-dim) hover:text-(--chip-fg)',
        )}
      >
        ctrl
      </button>
      {KEYS.map((k) => (
        <button
          key={k.key}
          type="button"
          title={k.name}
          onPointerDown={(e) => {
            e.preventDefault()
            props.onKey(k.key)
          }}
          className={cn(chip, 'text-(--chip-dim) hover:text-(--chip-fg) active:bg-(--chip-wash)')}
        >
          {k.label}
          <span className="sr-only">{k.name}</span>
        </button>
      ))}
    </div>
  )
}
```

(Note the `label` and the visible text are what the tests select on: `esc`, `tab`, `ctrl`, `←`, `↓`, `↑`, `→`. The `sr-only` span rides inside the button, so `textContent` for arrows is `'↑Arrow up'` — **therefore the test's `key()` helper must match with `startsWith`, not equality.** Use `b.textContent?.startsWith(label)` in Step 1's helper; this note wins over the equality form if you wrote that first.)

- [ ] **Step 5: Wire into Terminal**

In `web/src/components/terminal.tsx`:

Imports:

```ts
import { KeyBar } from '@/components/key-bar'
import { barKeyBytes, ctrlTransform, type BarKey } from '@/lib/keys'
```

State, beside the existing `mode` state:

```ts
  // Coarse pointer once per mount: whether this device's primary pointer is a
  // finger decides the key bar's existence, and a pointer does not change
  // class mid-session in any way worth re-rendering for.
  const [coarse] = useState(() => globalThis.matchMedia?.('(pointer: coarse)')?.matches ?? false)
  // The sticky Ctrl: state for the chip's pressed look, a ref for the input
  // path, which lives inside the effect and must read it without re-running.
  const [ctrlArmed, setCtrlArmed] = useState(false)
  const ctrlArmedRef = useRef(ctrlArmed)
  ctrlArmedRef.current = ctrlArmed
```

Replace the `emulator.onData` registration body:

```ts
    emulator.onData((bytes) => {
      // No ref, no destination — and no input while the backlog replays.
      if (ref === null || consumed < muteUntil) return
      let out = bytes
      if (ctrlArmedRef.current) {
        // The bar's sticky Ctrl folds this keystroke, and is spent on it
        // whether or not it could fold — like a real sticky modifier.
        out = ctrlTransform(bytes) ?? bytes
        setCtrlArmed(false)
      }
      client.sendInput(ref, out)
    })
```

Extend the `actionsRef` type and object with `sendKey` (type field: `sendKey: (key: BarKey) => void`; object, beside `restart` and `applyTheme`):

```ts
      sendKey: (key) => {
        if (ref === null || consumed < muteUntil) return
        const bytes = barKeyBytes(key, {
          appCursor: emulator.applicationCursorKeys(),
          ctrl: ctrlArmedRef.current,
        })
        if (ctrlArmedRef.current) setCtrlArmed(false)
        client.sendInput(ref, bytes)
      },
```

Render: the inset div's `className` gains bottom room when the bar exists —

```tsx
        className={cn(
          'absolute inset-3 transition-opacity',
          coarse && 'bottom-16',
          phase === 'exited' && 'opacity-60',
        )}
```

— and after the inset div's closing tag (before the top-right controls block), render the bar:

```tsx
      {coarse && (
        <KeyBar
          ctrl={ctrlArmed}
          onCtrl={() => setCtrlArmed((v) => !v)}
          onKey={(k) => actionsRef.current?.sendKey(k)}
        />
      )}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd web && npx vitest run src/components/terminal.test.tsx`
Expected: PASS, all describes — the pre-existing tests never stub `matchMedia`, so `coarse` is false and the bar changes nothing for them.

- [ ] **Step 7: Full suite (scanner guard included)**

Run: `cd web && npx vitest run`
Expected: PASS. `key-bar.tsx` and the `terminal.tsx` edits are scanned prose + markup; the class strings here are all hyphenated or var-referencing (safe shapes), and if `styles.build.test.ts` names a leaked bare word from a comment, reword and re-run. Also `tsc --noEmit` via `npm run lint`.

- [ ] **Step 8: Commit**

```bash
git add web/src/emulator/types.ts web/src/emulator/xterm.ts web/src/testing/emulator.ts web/src/components/key-bar.tsx web/src/components/terminal.tsx web/src/components/terminal.test.tsx
git commit -m "feat(web): an on-screen key bar for touch devices

Esc, tab, a sticky ctrl and the four arrows, floated over the
terminal's bottom edge on coarse-pointer devices only. Arrows follow
DECCKM through a new emulator seam method, ctrl folds the next
keystroke on the input path, and presses ride pointerdown with the
default prevented so the soft keyboard stays open. The inset reserves
the bar's room, so it covers no rows."
```

---

### Task 4: Momentum for touch scrolling

Drags today translate one-to-one into whole-line `scrollLines()` calls and stop dead the instant the finger lifts — accurate, but rigid. This adds inertia: `touchmove` keeps a short window of `(timeStamp, clientY)` samples, `touchend` turns them into a line-per-second velocity, and a glide loop decays it with iOS-feel friction (`0.998^ms`), emitting whole lines with the fractional carry. A new touch, a pinch-zoom, or unmount cancels the glide.

**Files:**
- Create: `web/src/lib/glide.ts`
- Create: `web/src/lib/glide.test.ts`
- Modify: `web/src/components/terminal.tsx` (touch handlers + cleanup)
- Test: `web/src/components/terminal.test.tsx` (inside `describe('touch scrolling', ...)`)

**Interfaces:**
- Consumes: existing touch handlers, `zoomedIn` from `@/lib/viewport`, the `touch()` test helper (extended with a timestamp).
- Produces: `startGlide(opts: { velocity: number; onLines: (lines: number) => void; raf?: typeof requestAnimationFrame; caf?: typeof cancelAnimationFrame }): () => void` — starts a decaying scroll, returns cancel. Velocity is in lines per second, positive toward newer output, matching `scrollLines`.

- [ ] **Step 1: Write the failing unit test**

Create `web/src/lib/glide.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { startGlide } from './glide'

/** A hand-cranked animation frame loop. step() advances the clock. */
function frames() {
  const queue: Array<{ id: number; cb: (t: number) => void }> = []
  let nextId = 1
  let now = 0
  return {
    raf: (cb: (t: number) => void) => {
      const id = nextId++
      queue.push({ id, cb })
      return id
    },
    caf: (id: number) => {
      const at = queue.findIndex((f) => f.id === id)
      if (at >= 0) queue.splice(at, 1)
    },
    step(ms: number) {
      now += ms
      const due = queue.splice(0, queue.length)
      for (const f of due) f.cb(now)
    },
    pending: () => queue.length,
  }
}

describe('startGlide', () => {
  it('keeps scrolling after the finger lifts, in decaying whole lines', () => {
    const f = frames()
    let lines = 0
    startGlide({ velocity: 60, onLines: (n) => (lines += n), raf: f.raf, caf: f.caf })

    f.step(16) // first frame establishes the clock; no time has passed yet
    const after1 = lines
    for (let i = 0; i < 30; i++) f.step(16)
    const after31 = lines

    expect(after31).toBeGreaterThan(after1)
    // Half a second of 0.998^ms friction eats most of 60 lines/s: the total
    // lands well under what the starting velocity alone would cover…
    expect(after31).toBeLessThan(30)
    expect(after31).toBeGreaterThan(5)
  })

  it('carries fractions so slow glides still add up to whole lines', () => {
    const f = frames()
    let lines = 0
    startGlide({ velocity: 4, onLines: (n) => (lines += n), raf: f.raf, caf: f.caf })
    f.step(16)
    for (let i = 0; i < 20; i++) f.step(16)
    // 4 lines/s over ~0.32s is roughly one line — deliverable only by carry.
    expect(lines).toBeGreaterThanOrEqual(1)
  })

  it('emits only whole lines, never fractions', () => {
    const f = frames()
    const emitted: number[] = []
    startGlide({ velocity: 25, onLines: (n) => emitted.push(n), raf: f.raf, caf: f.caf })
    f.step(16)
    for (let i = 0; i < 10; i++) f.step(16)
    for (const n of emitted) expect(Number.isInteger(n)).toBe(true)
  })

  it('scrolls the other way for a negative velocity', () => {
    const f = frames()
    let lines = 0
    startGlide({ velocity: -60, onLines: (n) => (lines += n), raf: f.raf, caf: f.caf })
    f.step(16)
    for (let i = 0; i < 10; i++) f.step(16)
    expect(lines).toBeLessThan(0)
  })

  it('comes to rest on its own and stops asking for frames', () => {
    const f = frames()
    startGlide({ velocity: 10, onLines: () => {}, raf: f.raf, caf: f.caf })
    for (let i = 0; i < 400 && f.pending(); i++) f.step(16)
    expect(f.pending()).toBe(0)
  })

  it('cancel stops it mid-glide', () => {
    const f = frames()
    let lines = 0
    const cancel = startGlide({ velocity: 60, onLines: (n) => (lines += n), raf: f.raf, caf: f.caf })
    f.step(16)
    f.step(16)
    const before = lines
    cancel()
    f.step(16)
    f.step(16)
    expect(lines).toBe(before)
    expect(f.pending()).toBe(0)
  })

  it('declines a velocity too small to glide', () => {
    const f = frames()
    startGlide({ velocity: 0.2, onLines: () => {}, raf: f.raf, caf: f.caf })
    expect(f.pending()).toBe(0)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd web && npx vitest run src/lib/glide.test.ts`
Expected: FAIL — `./glide` does not exist.

- [ ] **Step 3: Implement `web/src/lib/glide.ts`**

```ts
/**
 * Friction per millisecond. UIKit's "normal" deceleration rate — velocity
 * multiplied by 0.998 every millisecond — which is the feel a finger that
 * has used any phone expects, and the reason the constant is not tunable.
 */
const FRICTION = 0.998

/** Below this many lines per second a glide has visibly stopped. */
const REST = 0.5

/**
 * Scroll on after the finger lifts.
 *
 * The drag handlers translate touch motion into whole-line scrolls while the
 * finger is down; this carries the motion past the lift, decaying an initial
 * lines-per-second velocity and emitting whole lines with the fraction
 * carried between frames — the same carry trick the drag itself uses.
 * Returns a cancel; the caller cancels on the next touch, on a pinch, and
 * on unmount, because a glide must never outlive the surface it scrolls.
 */
export function startGlide(opts: {
  velocity: number
  onLines: (lines: number) => void
  raf?: typeof requestAnimationFrame
  caf?: typeof cancelAnimationFrame
}): () => void {
  const raf = opts.raf ?? requestAnimationFrame
  const caf = opts.caf ?? cancelAnimationFrame
  let v = opts.velocity
  if (Math.abs(v) < REST) return () => {}

  let carry = 0
  let last: number | null = null
  let frame = 0

  const tick = (t: number) => {
    frame = 0
    if (last !== null) {
      const dt = t - last
      // Integrate at the frame's start velocity, then decay: at 60fps the
      // difference from exact integration is under a line per flick.
      const delta = (v * dt) / 1000 + carry
      const lines = Math.trunc(delta)
      carry = delta - lines
      if (lines !== 0) opts.onLines(lines)
      v *= FRICTION ** dt
      if (Math.abs(v) < REST) return
    }
    last = t
    frame = raf(tick)
  }

  frame = raf(tick)
  return () => {
    if (frame) caf(frame)
    frame = 0
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd web && npx vitest run src/lib/glide.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Write the failing integration test**

In `web/src/components/terminal.test.tsx`, first extend the `touch()` helper with an explicit clock — jsdom stamps events at creation time, so consecutive dispatches are indistinguishable without it:

```tsx
function touch(type: 'touchstart' | 'touchmove' | 'touchend', ys: number[], at?: number) {
  const e = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(e, 'touches', { value: ys.map((clientY) => ({ clientY })) })
  if (at !== undefined) Object.defineProperty(e, 'timeStamp', { value: at })
  return e
}
```

(Existing callers pass no `at` and are unaffected.) Then add inside `describe('touch scrolling', ...)` — it already sets `em.live().measured = { width: 800, height: 408 }` and attaches at 80x24, a 17px line:

```tsx
    it('glides on after a flick, and a new touch stops the glide', () => {
      const rafCbs: Array<(t: number) => void> = []
      vi.stubGlobal('requestAnimationFrame', (cb: (t: number) => void) => rafCbs.push(cb))
      vi.stubGlobal('cancelAnimationFrame', () => {})
      const surface = surfaceEl()

      // A fast upward drag: 34px (2 lines) per 16ms step.
      act(() => {
        surface.dispatchEvent(touch('touchstart', [300], 0))
        surface.dispatchEvent(touch('touchmove', [266], 16))
        surface.dispatchEvent(touch('touchmove', [232], 32))
        surface.dispatchEvent(touch('touchend', [], 48))
      })
      const dragged = em.live().scrolled
      expect(dragged).toBeGreaterThan(0)

      // The glide keeps scrolling without any finger on the glass.
      act(() => {
        let t = 48
        while (rafCbs.length) rafCbs.shift()!(t += 16)
        // Runs the loop to rest: each callback re-queues the next until the
        // velocity dies, so draining until empty is running the whole glide.
      })
      expect(em.live().scrolled).toBeGreaterThan(dragged)

      // A finger back on the glass pins the content: no glide survives it.
      act(() => {
        surface.dispatchEvent(touch('touchstart', [200], 400))
      })
      expect(rafCbs.length).toBe(0)
    })
```

- [ ] **Step 6: Run to verify it fails**

Run: `cd web && npx vitest run src/components/terminal.test.tsx -t 'glides'`
Expected: FAIL — `scrolled` does not grow after `touchend`.

- [ ] **Step 7: Wire the glide into the touch handlers**

In `web/src/components/terminal.tsx`, import `startGlide` (beside the other `@/lib` imports):

```ts
import { startGlide } from '@/lib/glide'
```

Amend the touch-handler block. New locals beside `touchY`/`touchCarry`:

```ts
    // The flick record: the last few moves' clocks and positions, enough to
    // read a release velocity from. Cleared whenever a gesture starts.
    let flick: Array<{ t: number; y: number }> = []
    let glide: (() => void) | null = null
```

`touchStart` gains a cancel and a sample reset (full replacement of the handler):

```ts
    const touchStart = (e: TouchEvent) => {
      // A finger on the glass pins the content — any glide in flight ends.
      glide?.()
      glide = null
      flick = []
      if (e.touches.length !== 1 || zoomedIn(window.visualViewport)) {
        touchY = null
        return
      }
      touchY = e.touches[0]!.clientY
      touchCarry = 0
    }
```

`touchMove` records a sample after its existing work — add before the final `if (lines !== 0)`:

```ts
      flick.push({ t: e.timeStamp, y })
      if (flick.length > 6) flick.shift()
```

`touchEnd` reads the velocity and starts the glide (full replacement):

```ts
    const touchEnd = (e: TouchEvent) => {
      const wasDragging = touchY !== null
      touchY = null
      touchCarry = 0
      // Velocity over the sample window. Two samples and thirty milliseconds
      // are the floor: a tap or a hold-then-lift reads as no flick at all.
      const a = flick[0]
      const b = flick[flick.length - 1]
      flick = []
      if (!wasDragging || !a || !b || b.t - a.t < 30) return
      const dt = (b.t - a.t) / 1000
      const lps = (a.y - b.y) / lineHeightPx() / dt
      glide = startGlide({ velocity: lps, onLines: (n) => emulator.scrollLines(n) })
      void e
    }
```

Cleanup: in the effect's return, beside the touch listener removals, add:

```ts
      glide?.()
```

- [ ] **Step 8: Run tests, then full suite**

Run: `cd web && npx vitest run src/components/terminal.test.tsx` → PASS (the pre-existing `touchend` tests pass `[]` with no timestamps: `flick` is empty or the span is under 30ms, so no glide starts and their assertions hold).
Run: `cd web && npx vitest run` → PASS including the scanner guard (new scanned prose in `glide.ts` and `terminal.tsx`; reword on any leak).

- [ ] **Step 9: Commit**

```bash
git add web/src/lib/glide.ts web/src/lib/glide.test.ts web/src/components/terminal.tsx web/src/components/terminal.test.tsx
git commit -m "feat(web): let a flick glide the scrollback

Drags scrolled line-for-line and stopped dead at the lift, which reads
as rigid to a thumb calibrated by every other scrolling surface on a
phone. A release velocity now decays at UIKit's 0.998-per-millisecond
rate, emitting whole lines with the fraction carried, and dies at the
next touch, a pinch, or unmount."
```

---

## Self-Review Notes

- Spec coverage: flash (Task 1), arrows/Esc/Tab/sticky-Ctrl bar shown only on mobile (Tasks 2–3), mode-aware arrows (Tasks 2–3 via seam method), scroll momentum (Task 4). The user's pty-policy point needs no work.
- Task 4 sign convention: drag delta is `(touchY - y) / lineHeight` — finger moving down produces negative lines (older). The flick velocity `(a.y - b.y)` preserves exactly that sign, and the glide unit tests pin both directions.
- Type consistency: `BarKey`/`barKeyBytes`/`ctrlTransform` signatures match across Tasks 2 and 3; `applicationCursorKeys()` name matches across seam, xterm, fake, and wiring; `appCursor` field name matches test usage.
- Known risk: `pointerDown` events in jsdom — `fireEvent.pointerDown` dispatches a PointerEvent-shaped event that React's `onPointerDown` receives; this is established @testing-library behavior. If an environment quirk surfaces, `fireEvent.mouseDown` on the same handler is NOT equivalent — instead dispatch `new Event('pointerdown', { bubbles: true, cancelable: true })`.
- Known risk: the `key()` helper matching — resolved in Task 3 Step 4's note (use `startsWith`).
- Deliberate scope cuts (do not add): no long-press auto-repeat on arrows, no PgUp/PgDn/Home/End, no haptics, no user-configurable keys. All are follow-ups if the bar earns its place.
