// The browser APIs jsdom does not implement, stubbed for the `dom` project —
// and the teardown that has to outlast them.
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
import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

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

/**
 * How long input-otp's longest orphaned timer runs for, in milliseconds.
 *
 * `syncTimeouts` fires its callback three times — at 0ms, 10ms and 50ms — and
 * the effect that calls it (on every value or focus change) returns no cleanup,
 * so unmounting cannot cancel them. This is that 50, read off input-otp 1.4.2.
 */
const INPUT_OTP_SYNC_TIMEOUT_MS = 50

/**
 * Unmount, then let the timers no unmount can cancel finish while there is
 * still a `window` for them to land in.
 *
 * The orphaned `syncTimeouts` callbacks above call `setState`, and react-dom
 * reads the bare global `window` (for `window.event`, to pick an update
 * priority) on the way into *any* `setState` — including one aimed at a fiber
 * that is already gone, because the priority is resolved before the update is
 * discarded. Harmless while the test file is running. But vitest deletes the
 * jsdom globals the moment the file's last test ends, and these are Node
 * timers, so `window.close()` does not sweep them either: a callback that had
 * not fired yet then throws `ReferenceError: window is not defined` from a bare
 * timer — outside React, outside any test's stack — and vitest reports it as an
 * unhandled error, failing the run while all 326 assertions still pass. It only
 * showed when the last thing a test did was touch the code field, which is why
 * it read as flaky.
 *
 * The wait is ordered by construction rather than generously long: this timer
 * is scheduled *after* input-otp's and for *longer* than any of them, so it
 * expires strictly last however loaded the machine is. Node runs timers by
 * expiry, so by the time this resolves all three have run.
 */
afterEach(async () => {
  cleanup()
  await new Promise((resolve) => setTimeout(resolve, INPUT_OTP_SYNC_TIMEOUT_MS + 10))
})
