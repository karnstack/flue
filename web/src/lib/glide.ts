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
