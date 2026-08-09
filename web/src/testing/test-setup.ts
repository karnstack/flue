import { afterEach, beforeEach } from 'vitest'
import '@testing-library/dom'

// jsdom implements neither of these, and both are exercised by the terminal
// view's geometry handling and by focus mode.
if (!globalThis.ResizeObserver) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
}

if (!globalThis.matchMedia) {
  globalThis.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    // The pre-2018 MediaQueryList listener API. Deprecated, but every real
    // browser still ships it, so a stub that omits it is not a MediaQueryList
    // — and xterm 6 uses exactly this pair to watch devicePixelRatio. Without
    // them, `Terminal.open()` throws
    // "this._resolutionMediaMatchList.addListener is not a function" and no
    // test can mount a terminal at all.
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof matchMedia
}

// Nor this one, and it is not optional for anything built on Radix's Select:
// on open it walks its items and calls `scrollIntoView` on the one to focus,
// unguarded, so a bare `render(<Select defaultOpen>)` dies with
// "candidate?.scrollIntoView is not a function" before a single assertion
// runs. A no-op is the honest stub — the real method scrolls, and nothing in
// jsdom scrolls.
//
// `globalThis.Element` first, and for the same reason the two above test
// globalThis rather than the bare name: this file is the setup for *every*
// suite, and the three `@vitest-environment node` build tests have no DOM at
// all. A bare `Element.prototype` there is a ReferenceError that fails them
// before they compile anything.
if (globalThis.Element && !Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = function scrollIntoView() {}
}

// Nor the pointer-capture trio, which jsdom omits entirely. Sonner's toast
// grabs the pointer on the way down so a swipe keeps tracking after the
// finger leaves the toast's own box; unstubbed, the very first press on a
// notice throws out of the event handler — past the test that pressed it, so
// it lands as an unhandled error rather than a failure with a stack anyone
// can read.
if (globalThis.Element && !Element.prototype.setPointerCapture) {
  Element.prototype.setPointerCapture = function setPointerCapture() {}
  Element.prototype.releasePointerCapture = function releasePointerCapture() {}
  Element.prototype.hasPointerCapture = function hasPointerCapture() {
    return false
  }
}

/*
 * Fail a test that logged one of flue's own swallowed errors.
 *
 * FlueClient's Emitter catches whatever a listener throws and reports it with
 * console.error, on purpose: delivery happens one line before a reconnect is
 * armed, so an exception escaping it would strand a tab at `reconnecting` for
 * good. The cost is that a bug in an onOutput or onAttached handler — the two
 * callbacks that write into a live xterm instance — logs and lets the suite
 * stay green. Nothing trapped console before this.
 *
 * Only flue's own prefix is matched. React logs plenty through console.error
 * that no test here is trying to police, and a blanket trap would make this a
 * source of failures rather than a guard against one. A test that means to
 * exercise the swallow spies on console.error itself, which replaces this
 * wrapper for the duration and opts out on its own.
 */
const FLUE_PREFIX = 'flue:'
const swallowed: string[] = []
const passThrough = console.error.bind(console)

console.error = (...args: unknown[]) => {
  if (typeof args[0] === 'string' && args[0].startsWith(FLUE_PREFIX)) {
    swallowed.push(args.map(String).join(' '))
  }
  passThrough(...args)
}

beforeEach(() => {
  swallowed.length = 0
})

afterEach(() => {
  if (swallowed.length === 0) return
  const reported = swallowed.join('\n')
  swallowed.length = 0
  throw new Error(
    `a listener threw and FlueClient swallowed it; delivery continued but the bug is real:\n${reported}`,
  )
})
