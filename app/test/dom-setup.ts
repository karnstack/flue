// The browser APIs jsdom does not implement, stubbed for the `dom` project.
//
// jsdom is a DOM, not a browser: it has no layout engine, so everything that
// reports a *measurement* is simply absent. Two shadcn components this app
// renders reach for one of those APIs on mount — `InputOTP` (input-otp) and
// every Radix popper-backed overlay (`DropdownMenu`) observe their own size —
// and an absent global is a `ReferenceError` thrown from inside an effect,
// which React reports as a render failure of the whole tree.
//
// These are stubs, not polyfills, and the difference matters when reading a
// test: nothing here measures anything, so no assertion may depend on a size.
// What they buy is that a component which *asks* for a measurement mounts.

/**
 * A ResizeObserver that observes nothing.
 *
 * Both consumers use it to keep a rendered size in step with a real layout;
 * with no layout to be in step with, never firing is the honest answer, and
 * both fall back to the sizes their CSS gives them.
 */
class NoopResizeObserver implements ResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

globalThis.ResizeObserver ??= NoopResizeObserver

/*
 * Pointer capture, which Radix asks about while deciding whether a press that
 * started on a trigger is still on it. jsdom implements `setPointerCapture` as
 * a no-op and does not implement the query at all, so the honest stub is "no
 * element has capture" — which is what a test driving clicks rather than drags
 * would want anyway.
 */
Element.prototype.hasPointerCapture ??= () => false
Element.prototype.setPointerCapture ??= () => {}
Element.prototype.releasePointerCapture ??= () => {}

/*
 * And scrolling, which a menu does to bring the focused item into view. There
 * is nothing to scroll and nothing to bring into view.
 */
Element.prototype.scrollIntoView ??= () => {}

/*
 * And hit testing. input-otp schedules a check on a timer for a password
 * manager's badge overlapping its slots, by asking what is painted at a point;
 * nothing is painted anywhere here. Without this the call throws from a bare
 * `setTimeout` — outside React, outside the test's own stack — and vitest
 * reports it as an unhandled error while every assertion still passes.
 */
document.elementFromPoint ??= () => null
