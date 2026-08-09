# Mobile Terminal Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the terminal usable on a phone: pinch-zoom works, the prompt stays visible above the virtual keyboard, and the pty follows the device the user is actually using instead of the largest attached view.

**Architecture:** Three independent fixes. (1) The terminal surface's `touch-action: none` becomes `touch-action: pinch-zoom` so the browser gets the pinch gesture back while single-finger drags still feed the custom scrollback handler. (2) A new `trackVisualViewport` helper sizes the terminal pane to the *visual* viewport, so an iOS keyboard opening shrinks the pane, the ResizeObserver refits, and the pty rows land above the keyboard; while pinch-zoomed it instead hands single-finger panning back to the browser. (3) The daemon's sizing policy changes from "componentwise maximum across views" to "the most recently active view's fit" (tmux `window-size latest` semantics) — activity being input, a size report, a signal, or the attach itself — so a phone gets a phone-sized pty the moment it speaks and the laptop takes it back on its first keystroke.

**Tech Stack:** React + xterm + vitest (jsdom) in `web/`, Go daemon in `internal/daemon/` with `go test`.

## Global Constraints

- Tailwind scans **prose** in every file under `web/` outside `*.test.*`, `src/testing/`, `src/client/` and `*.go` — a quoted single English word that is also a utility name (e.g. `'resize'`) compiles a stray CSS rule and fails `styles.build.test.ts`. Never write the event name `resize` as a quoted string in web sources; use `onresize`/`onscroll` property assignment instead (bare identifiers are not scanner candidates).
- Comments in `web/` sources are scanned too. After any comment edit under `web/`, run `npm test -- --run src/styles.build.test.ts` (from `web/`) to prove no bare utility leaked.
- Test commands: `cd web && npx vitest run <file>` for web; `go test ./internal/daemon/ -run <Name>` for daemon; `make test` for everything.
- Commit style: conventional prefix (`fix:`, `feat:`), body explains why, matching repo history.
- Never edit `web/dist/` (build output, committed by `make web`).

---

### Task 1: Give pinch-zoom back to the browser

The terminal surface carries `touch-action: none` (`web/src/styles.css`, `@utility flue-term-surface`), added when touch-drag scrollback landed. `none` also swallows two-finger pinch, which is why the page cannot be zoomed on a phone. `pinch-zoom` keeps single-finger pans out of the browser's hands (the drag handler in `terminal.tsx` still gets them, and it already bails on multi-touch: `e.touches.length !== 1`) while letting two fingers zoom.

**Files:**
- Modify: `web/src/styles.css` (the `@utility flue-term-surface` block, ~line 296)
- Test: `web/src/styles.build.test.ts` (add one assertion to the existing `describe('compiled stylesheet')`)

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: the compiled stylesheet contains `touch-action:pinch-zoom` on the surface utility. Task 2's zoomed-pan behavior assumes pinch is browser-handled.

- [ ] **Step 1: Write the failing test**

In `web/src/styles.build.test.ts`, inside `describe('compiled stylesheet', ...)`, add:

```ts
  it('leaves the pinch gesture to the browser on the terminal surface', () => {
    // touch-action: none once shipped here and made the page unzoomable on
    // phones; pinch-zoom keeps single-finger drags for the scrollback
    // handler while two fingers still zoom.
    expect(css).toContain('touch-action:pinch-zoom')
    expect(css).not.toContain('touch-action:none')
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/styles.build.test.ts -t 'pinch gesture'`
Expected: FAIL — compiled css contains `touch-action:none`, not `touch-action:pinch-zoom`. (The build in `beforeAll` takes up to a couple of minutes.)

- [ ] **Step 3: Change the utility**

In `web/src/styles.css`, replace the `flue-term-surface` utility body:

```css
/* The terminal fills its pane; xterm manages its own internal scrolling. */
@utility flue-term-surface {
  block-size: 100%;
  inline-size: 100%;
  /* Single-finger gestures are ours: touches become scrollLines() calls
   * (terminal.tsx), and a browser allowed to pan the page would eat them
   * first. The pinch stays with the browser — `none` here once made the
   * page unzoomable on phones, which is too much to take. */
  touch-action: pinch-zoom;
}
```

- [ ] **Step 4: Run the build test file to verify it passes**

Run: `cd web && npx vitest run src/styles.build.test.ts`
Expected: PASS, including the pre-existing prose-leak guard (the new CSS comment is inside a `.css` file, which is outside the scan perimeter).

- [ ] **Step 5: Commit**

```bash
git add web/src/styles.css web/src/styles.build.test.ts
git commit -m "fix(web): let two fingers pinch-zoom the terminal

touch-action: none routed every touch to the scrollback handler and
silently ate the pinch gesture with it. pinch-zoom keeps single-finger
drags ours and hands the zoom back to the browser."
```

---

### Task 2: Size the pane to the visual viewport (keyboard, zoomed panning)

The pane is `h-full` of the *layout* viewport. An iOS keyboard shrinks only the *visual* viewport, the page cannot scroll (`overflow-hidden`), so the prompt sits behind the keyboard. Fix: track `window.visualViewport`; at scale ≈ 1, pin the pane's height (and vertical offset) to the visual viewport — the existing ResizeObserver on the inner box then refits and reports smaller rows, and the pty follows. At scale > 1 (pinch-zoomed, Task 1), stop fighting the browser: release `touch-action` on the surface so one finger pans the zoomed page, and leave the pane alone so zooming never refits the pty.

**Files:**
- Create: `web/src/lib/viewport.ts`
- Create: `web/src/lib/viewport.test.ts`
- Modify: `web/src/components/terminal.tsx` (wire into the main effect + cleanup)
- Modify: `web/index.html` (viewport meta)

**Interfaces:**
- Consumes: nothing from other tasks (behaviorally pairs with Task 1's `touch-action: pinch-zoom`).
- Produces: `trackVisualViewport(opts: { pane: HTMLElement; surface: HTMLElement; viewport: ViewportLike | null }): () => void` — installs handlers, applies once immediately, returned function removes handlers and clears every style it set. `ViewportLike` is `{ readonly height: number; readonly offsetTop: number; readonly scale: number; onresize: ((ev: Event) => void) | null; onscroll: ((ev: Event) => void) | null }`.

- [ ] **Step 1: Write the failing test**

Create `web/src/lib/viewport.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest'
import { trackVisualViewport, type ViewportLike } from './viewport'

/** A hand-cranked visualViewport double; fire() plays both handler slots. */
function fakeViewport(init: { height: number; offsetTop?: number; scale?: number }) {
  const vv = {
    height: init.height,
    offsetTop: init.offsetTop ?? 0,
    scale: init.scale ?? 1,
    onresize: null as ViewportLike['onresize'],
    onscroll: null as ViewportLike['onscroll'],
    fire() {
      vv.onresize?.(new Event('x'))
    },
  }
  return vv
}

describe('trackVisualViewport', () => {
  let pane: HTMLElement
  let surface: HTMLElement

  beforeEach(() => {
    pane = document.createElement('div')
    surface = document.createElement('div')
  })

  it('is a no-op without a viewport, as on browsers that lack one', () => {
    const dispose = trackVisualViewport({ pane, surface, viewport: null })
    expect(pane.getAttribute('style')).toBeNull()
    dispose()
  })

  it('pins the pane to the visual viewport height when the keyboard opens', () => {
    const vv = fakeViewport({ height: 700 })
    trackVisualViewport({ pane, surface, viewport: vv })
    expect(pane.style.height).toBe('700px')

    vv.height = 400 // keyboard up
    vv.fire()
    expect(pane.style.height).toBe('400px')
  })

  it('follows the viewport down the page when focusing scrolls it', () => {
    const vv = fakeViewport({ height: 400, offsetTop: 120 })
    trackVisualViewport({ pane, surface, viewport: vv })
    expect(pane.style.transform).toBe('translateY(120px)')
  })

  it('releases the surface to the browser while pinch-zoomed', () => {
    const vv = fakeViewport({ height: 700 })
    trackVisualViewport({ pane, surface, viewport: vv })

    vv.scale = 2
    vv.height = 350
    vv.fire()
    // One finger must pan the zoomed page, and a zoom is not a layout change:
    // the pane keeps its unzoomed size so the pty never refits on a pinch.
    expect(surface.style.touchAction).toBe('auto')
    expect(pane.style.height).toBe('700px')

    vv.scale = 1
    vv.height = 700
    vv.fire()
    expect(surface.style.touchAction).toBe('')
    expect(pane.style.height).toBe('700px')
  })

  it('clears everything it set on dispose', () => {
    const vv = fakeViewport({ height: 500, offsetTop: 40 })
    const dispose = trackVisualViewport({ pane, surface, viewport: vv })
    dispose()
    expect(pane.getAttribute('style')).toBe('')
    expect(surface.style.touchAction).toBe('')
    expect(vv.onresize).toBeNull()
    expect(vv.onscroll).toBeNull()

    vv.height = 300
    vv.fire() // a dead handler set would throw or restyle; neither may happen
    expect(pane.style.height).toBe('')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/lib/viewport.test.ts`
Expected: FAIL — `./viewport` does not exist.

- [ ] **Step 3: Implement `web/src/lib/viewport.ts`**

```ts
/**
 * The slice of VisualViewport this needs, as a seam for tests — and with the
 * handlers as *properties*, not addEventListener: the event's name is also a
 * Tailwind utility name, and a quoted string of it in any scanned source
 * compiles a stray rule (see the scanner notes in src/styles.css).
 */
export interface ViewportLike {
  readonly height: number
  readonly offsetTop: number
  readonly scale: number
  onresize: ((ev: Event) => void) | null
  onscroll: ((ev: Event) => void) | null
}

/**
 * Keep the pane inside the *visual* viewport.
 *
 * The pane fills the layout viewport, but a phone's keyboard shrinks only the
 * visual one — the page cannot scroll under the terminal, so without this the
 * bottom rows (and the prompt) sit behind the keyboard. Pinning the pane's
 * height to the visual viewport lets the ResizeObserver in terminal.tsx do
 * the rest: the inner box shrinks, the fit is re-reported, the pty rows land
 * above the keyboard.
 *
 * While pinch-zoomed (scale > 1) the rules invert. A zoom is not a layout
 * change, so the pane is left alone — refitting the pty on a pinch would
 * reflow the very text being magnified — and the surface's touch-action is
 * released so a single finger pans the zoomed page, which the stylesheet
 * otherwise reserves for the scrollback drag handler.
 */
export function trackVisualViewport(opts: {
  pane: HTMLElement
  surface: HTMLElement
  viewport: ViewportLike | null
}): () => void {
  const { pane, surface, viewport } = opts
  if (!viewport) return () => {}

  const apply = () => {
    if (viewport.scale > 1.01) {
      surface.style.touchAction = 'auto'
      return
    }
    surface.style.touchAction = ''
    pane.style.height = `${viewport.height}px`
    pane.style.transform = `translateY(${viewport.offsetTop}px)`
  }

  viewport.onresize = apply
  viewport.onscroll = apply
  apply()

  return () => {
    viewport.onresize = null
    viewport.onscroll = null
    surface.style.touchAction = ''
    pane.style.height = ''
    pane.style.transform = ''
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && npx vitest run src/lib/viewport.test.ts`
Expected: PASS (5 tests).

Note the dispose test asserts `pane.getAttribute('style')` is `''` — jsdom leaves an empty `style` attribute after properties are cleared. If it reports `null` instead, relax that one assertion to `expect(pane.style.height).toBe('')` plus `expect(pane.style.transform).toBe('')`; the behavior under test is "nothing remains set", not the attribute's presence.

- [ ] **Step 5: Wire into the terminal effect**

In `web/src/components/terminal.tsx`:

Add to the imports from `@/lib`:

```ts
import { trackVisualViewport } from '@/lib/viewport'
```

Inside the main effect, directly after the four `surface.addEventListener('touch…')` registrations:

```ts
    // The pane hugs the visual viewport: a phone keyboard shrinks it and the
    // ResizeObserver below refits the terminal above the keyboard. While
    // pinch-zoomed it instead releases the surface so one finger pans.
    const untrackViewport = trackVisualViewport({
      pane,
      surface,
      viewport: window.visualViewport,
    })
```

In the cleanup, next to the touch listener removals:

```ts
      untrackViewport()
```

- [ ] **Step 6: Ask Android's keyboard to resize the layout too**

In `web/index.html`, extend the viewport meta:

```html
    <meta
      name="viewport"
      content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content"
    />
```

(`interactive-widget=resizes-content` makes Chrome on Android shrink the layout viewport under the keyboard; iOS ignores it and is covered by the visualViewport tracker. Both paths converge on the same ResizeObserver.)

- [ ] **Step 7: Run the web suite and the build guard**

Run: `cd web && npx vitest run`
Expected: PASS. `styles.build.test.ts` matters most here — the comments added to `viewport.ts` and `terminal.tsx` are inside Tailwind's scan perimeter, and this proves no bare utility rule leaked from their prose.

- [ ] **Step 8: Commit**

```bash
git add web/src/lib/viewport.ts web/src/lib/viewport.test.ts web/src/components/terminal.tsx web/index.html
git commit -m "fix(web): keep the prompt above the phone keyboard

The pane filled the layout viewport, but a phone keyboard shrinks only
the visual one and the page under the terminal cannot scroll — so the
prompt sat behind the keys. The pane now pins itself to the visual
viewport and the existing ResizeObserver refits the pty above the
keyboard; Android gets the same through interactive-widget. While
pinch-zoomed the tracker instead releases touch-action so one finger
pans the magnified page."
```

---

### Task 3: Pty follows the most recently active view

The daemon keeps the pty at the componentwise maximum across attached views (`effectiveLocked`, `internal/daemon/server.go`), so a phone beside an open laptop tab always renders scaled down. Chosen replacement (tmux `window-size latest` semantics): the pty wears the fitted size of the **most recently active** view. The activity order already exists — `touch()` moves a conn to the back of `s.attached[id]` on input, resize and signal, and attach appends — so the policy change is: `effectiveLocked` walks that list from the back and returns the first recorded desire, and the *input* path also re-syncs the pty, because typing is how a view takes the size back without re-reporting.

The web client needs no behavioral change: a view whose fit is at or above the pty already renders one-to-one (letterboxed in its pane), a smaller view already scales down.

**Files:**
- Modify: `internal/daemon/server.go` (`effectiveLocked`, `recordDesire`, new `effective`)
- Modify: `internal/daemon/conn.go` (input path, `wire.Resize` handler, new `syncSize`)
- Modify: `internal/daemon/server_test.go` (replace `TestResizeKeepsTheLargestAttachedView`)
- Modify: `spec/protocol.md` (Sizing section)
- Modify: `web/src/components/terminal.tsx` (the "## The sizing policy" doc comment only)

**Interfaces:**
- Consumes: nothing from Tasks 1–2.
- Produces: `(s *Server) effective(id string) (viewSize, bool)` — the most recently active view's desire, behind `primaryMu`. `(c *conn) syncSize(a *attachment)` — resizes the pty to `effective` and broadcasts when it differs from the session's current size. `recordDesire(id string, c *conn, cols, rows uint16)` loses its return values.

- [ ] **Step 1: Write the failing test**

In `internal/daemon/server_test.go`, replace `TestResizeKeepsTheLargestAttachedView` (keep its position in the file) with:

```go
// TestPtySizeFollowsTheActiveView pins the sizing policy: the PTY wears the
// fitted size of the most recently active view — attaching, reporting a size
// and typing all count as activity. A phone that attaches beside a laptop
// gets a phone-sized terminal the moment it reports, and the laptop takes
// the size back with its first keystroke, no re-report needed.
func TestPtySizeFollowsTheActiveView(t *testing.T) {
	ts, reg := newTestServer(t)
	s, err := reg.Spawn(session.SpawnOpts{Cmd: []string{"sleep", "2"}, Cols: 80, Rows: 24})
	if err != nil {
		t.Fatalf("Spawn: %v", err)
	}
	defer s.Close()

	laptop := dial(t, ts)
	writeControl(t, laptop, wire.Hello{Ver: "test"})
	writeControl(t, laptop, wire.Attach{ID: s.ID(), LastSeq: 0})
	var laptopRef uint32
	readUntil(t, laptop, func(msg any, _ []byte) bool {
		a, ok := msg.(wire.Attached)
		if ok {
			laptopRef = a.Ref
		}
		return ok
	})
	writeControl(t, laptop, wire.Resize{Ref: laptopRef, Cols: 120, Rows: 40, Primary: true})
	waitFor(t, func() bool { return s.Info().Cols == 120 && s.Info().Rows == 40 })

	phone := dial(t, ts)
	writeControl(t, phone, wire.Hello{Ver: "test"})
	writeControl(t, phone, wire.Attach{ID: s.ID(), LastSeq: 0})
	var phoneRef uint32
	readUntil(t, phone, func(msg any, _ []byte) bool {
		a, ok := msg.(wire.Attached)
		if ok {
			phoneRef = a.Ref
		}
		return ok
	})

	// The phone just attached and reported, which makes it the active view:
	// the PTY reshapes to the phone rather than staying with the largest.
	writeControl(t, phone, wire.Resize{Ref: phoneRef, Cols: 40, Rows: 10, Primary: false})
	waitFor(t, func() bool { return s.Info().Cols == 40 && s.Info().Rows == 10 })

	// A keystroke on the laptop moves the activity back; its recorded desire
	// is applied without the laptop re-reporting anything.
	frame := wire.EncodeBinary(wire.FrameInput, laptopRef, []byte("k"))
	if err := laptop.Write(context.Background(), websocket.MessageBinary, frame); err != nil {
		t.Fatalf("write input: %v", err)
	}
	waitFor(t, func() bool { return s.Info().Cols == 120 && s.Info().Rows == 40 })

	// The phone's keyboard opening is a fresh report, and a report is
	// activity: the size follows the phone again.
	writeControl(t, phone, wire.Resize{Ref: phoneRef, Cols: 40, Rows: 15, Primary: false})
	waitFor(t, func() bool { return s.Info().Cols == 40 && s.Info().Rows == 15 })

	// The phone leaves; the laptop is what remains, and its desire returns
	// without anyone asking again.
	writeControl(t, phone, wire.Detach{Ref: phoneRef})
	waitFor(t, func() bool { return s.Info().Cols == 120 && s.Info().Rows == 40 })
}
```

(`context`, `websocket`, `wire` and `session` are already imported by this file; `waitFor` already exists below the old test — keep it.)

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/daemon/ -run TestPtySizeFollowsTheActiveView`
Expected: FAIL at the second `waitFor` — under the max policy the phone's 40x10 report leaves the pty at 120x40.

- [ ] **Step 3: Implement the policy in server.go**

Replace `recordDesire` and `effectiveLocked` in `internal/daemon/server.go`:

```go
// recordDesire notes c's fitted size for a session. What the PTY is actually
// set to is effective's business: the desire of the most recently active
// view, which after a report is usually — but not necessarily — the reporter.
func (s *Server) recordDesire(id string, c *conn, cols, rows uint16) {
	s.primaryMu.Lock()
	defer s.primaryMu.Unlock()
	m := s.desired[id]
	if m == nil {
		m = map[*conn]viewSize{}
		s.desired[id] = m
	}
	m[c] = viewSize{cols: cols, rows: rows}
}

// effective is effectiveLocked behind its lock, for callers outside the
// primaryMu critical sections.
func (s *Server) effective(id string) (viewSize, bool) {
	s.primaryMu.Lock()
	defer s.primaryMu.Unlock()
	return s.effectiveLocked(id)
}

// effectiveLocked computes, under primaryMu, the size the PTY should wear:
// the fitted size of the most recently active view that has reported one.
// The attachment list already encodes recency — touch keeps each session's
// most recent client at the back — so the walk is from the back, skipping
// views that have yet to report. One pty has one grid, so someone must be
// chosen; choosing the view being *used* is what lets a phone pick a session
// up at phone size and a laptop take it back with a keystroke.
func (s *Server) effectiveLocked(id string) (viewSize, bool) {
	list := s.attached[id]
	desires := s.desired[id]
	for i := len(list) - 1; i >= 0; i-- {
		if v, ok := desires[list[i]]; ok {
			return v, true
		}
	}
	return viewSize{}, false
}
```

(`releasePrimary` already calls `effectiveLocked` and its callers already resize to the result, so detach hand-back needs no change.)

- [ ] **Step 4: Sync the pty on activity in conn.go**

Add to `internal/daemon/conn.go`:

```go
// syncSize points the PTY at the effective size — the most recently active
// view's desire — and broadcasts when that is a change. Called wherever
// activity may have moved which view is effective: after a size report, and
// after every input frame, because typing is how a view takes the size back
// without re-reporting it.
func (c *conn) syncSize(a *attachment) {
	eff, ok := c.srv.effective(a.s.ID())
	if !ok {
		return
	}
	info := a.s.Info()
	if eff.cols == info.Cols && eff.rows == info.Rows {
		return
	}
	if err := a.s.Resize(eff.cols, eff.rows); err != nil {
		c.sendError("resize_failed", err.Error())
		return
	}
	c.srv.broadcastSize(a.s.ID(), eff.cols, eff.rows)
}
```

In `handleBinary`, after the existing `c.srv.touch(a.s.ID(), c)`:

```go
	c.srv.touch(a.s.ID(), c)
	c.syncSize(a)
	if err := a.s.Write(payload); err != nil {
```

In `handleControl`'s `case wire.Resize:`, replace everything from the policy comment through the `broadcastSize` call with:

```go
		c.srv.touch(a.s.ID(), c)
		if m.Primary {
			c.srv.setPrimary(a.s.ID(), c)
		}
		// The report is recorded for every view, but the PTY follows the most
		// recently active one — which this reporter, having just been touched,
		// now is. An idle view's desire therefore waits, and is applied the
		// moment that view speaks again (see syncSize on the input path). The
		// primary role above still decides who answers device queries; it
		// does not own the dimensions.
		c.srv.recordDesire(a.s.ID(), c, m.Cols, m.Rows)
		c.syncSize(a)
```

- [ ] **Step 5: Run the daemon tests**

Run: `go test ./internal/daemon/`
Expected: PASS, including `TestPtySizeFollowsTheActiveView`, `TestPrimarySeizureResizesPTY` (single view: its desire is the effective one) and the promotion tests (primary logic untouched).

- [ ] **Step 6: Rewrite the policy prose**

`spec/protocol.md`, replace the first paragraph of the `### Sizing` section with:

```markdown
Every attached view sends `resize` with the cells that fit its own pane. The
daemon records one desired size per attachment and keeps the PTY at the fit
of the **most recently active** view — activity being an input frame, a size
report, a signal, or the attach itself. It recomputes when a report lands,
when activity moves between views, and when an attachment ends, broadcasting
the result as `sizeChanged`. A view whose fit is below the broadcast size
renders the full screen scaled down; one whose fit is at or above it renders
the grid one-to-one. One pty has one grid, so someone must be chosen, and it
is the view being used: picking up the phone reshapes the session to the
phone as soon as it reports, and the laptop's next keystroke reshapes it
back — an idle view's report is never lost, only waiting.
```

`web/src/components/terminal.tsx`, replace the "## The sizing policy" paragraph of the component doc comment (keep the surrounding sections) with:

```
 * ## The sizing policy
 *
 * Every attached view measures its own pane and reports the cells that fit
 * it; the daemon sizes the pty to the fit of the most recently active view
 * (`effectiveLocked` in internal/daemon) — activity being input, a report,
 * a signal or the attach itself. A view whose own fit matches or exceeds
 * the pty renders it one-to-one; a smaller view renders the full screen and
 * scales the whole surface down, staying fully interactive. Picking up the
 * phone therefore reshapes the session to the phone the moment its report
 * lands, and the first keystroke back on the laptop reshapes it back; a
 * detaching view hands the size to whichever remaining view was active
 * last. Ownership of the *primary* role never moves with any of this — the
 * daemon keeps one client primary purely to answer device queries.
```

- [ ] **Step 7: Verify the whole tree**

Run: `make test`
Expected: PASS across Go, web and relay. `styles.build.test.ts` re-proves the edited `terminal.tsx` comment leaked no utility rule.

- [ ] **Step 8: Commit**

```bash
git add internal/daemon/server.go internal/daemon/conn.go internal/daemon/server_test.go spec/protocol.md web/src/components/terminal.tsx
git commit -m "feat(daemon): pty follows the most recently active view

The componentwise-max policy meant a phone beside an open laptop tab
always rendered the laptop's grid scaled down to unreadable. The pty now
wears the fit of the most recently active view — attach, resize report,
signal and input all count — so the phone gets a phone-sized terminal
the moment it speaks and the laptop takes the size back with its first
keystroke, its recorded desire applied without a re-report. tmux calls
this window-size latest. Detach hand-back is unchanged: the size goes to
whichever remaining view was active last."
```

---

## Self-Review Notes

- Spec coverage: pinch-zoom (Task 1), keyboard/visual viewport including Android meta (Task 2), sizing policy per the user's "follow active device" choice (Task 3). The "AI agent disabled scrolling stuff" concern is Task 1's `touch-action` plus Task 2's zoomed-pan release; touch-drag scrollback is deliberately preserved.
- Type consistency: `ViewportLike` shape matches between Task 2's test and implementation; `effective`/`syncSize`/`recordDesire` signatures consistent across Task 3 steps.
- Known risk, called out in Task 2 Step 4: jsdom's `style` attribute serialization after clearing properties; the step says exactly how to relax the assertion without weakening the behavior under test.
- Deliberate semantics, decided with the user: a size report *is* activity (an idle laptop whose browser window is being resized has a human at it; a phone whose keyboard opens should win the pty immediately). The input-path `syncSize` covers the one case reports cannot: switching devices without any layout change on the destination.
