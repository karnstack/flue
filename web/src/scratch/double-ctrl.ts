/*
 * The double-Ctrl chord: two bare Ctrl press-and-release taps, close
 * together, with no other key anywhere between them.
 *
 * A bare Ctrl tap is the one modifier gesture that cannot collide with
 * terminal input — a lone modifier sends nothing to the pty — and it is not
 * on any browser's reserved list (#64 is about Ctrl+W and friends, which are
 * chords). The hazard is the real chord: Ctrl+C ends with a Ctrl keyup, and
 * counting that release as half a tap would open the scratch terminal on
 * every second interrupt. Hence "bare": a tap is spoiled by any other key
 * going down while Ctrl is held, and the gap between taps is spoiled by any
 * other key at all.
 *
 * This is a pure state machine over keydown/keyup so the timing rules are
 * testable without a DOM. The caller wires it to window listeners in the
 * capture phase — the same reason the switcher's chords run there: left to
 * bubble, xterm's handler would never let the events out of the terminal.
 */

export interface DoubleCtrlOptions {
  /**
   * How close the two taps must be: the second press within this many
   * milliseconds of the first release. Roomier than a double-click default
   * because two taps of the same finger on the same key are slower than two
   * clicks of a button.
   */
  windowMs?: number
  /** The clock, for tests. */
  now?: () => number
}

export interface DoubleCtrl {
  /** Feed a keydown. True when this event completed the chord. */
  keydown(e: Pick<KeyboardEvent, 'key' | 'repeat'>): boolean
  /** Feed a keyup. True when this event completed the chord. */
  keyup(e: Pick<KeyboardEvent, 'key'>): boolean
  /** Forget everything — call when the window loses focus and releases go missing. */
  reset(): void
}

const DEFAULT_WINDOW_MS = 350

export function createDoubleCtrl(opts: DoubleCtrlOptions = {}): DoubleCtrl {
  const windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS
  const now = opts.now ?? (() => performance.now())

  /** Ctrl is currently held. */
  let held = false
  /** Another key went down while this Ctrl was held — it is a chord. */
  let chorded = false
  /** When the first bare tap's release landed, or null when no tap stands. */
  let tappedAt: number | null = null
  /**
   * The standing second press: Ctrl went down in time and bare so far, and
   * only its release remains. Kept apart from `tappedAt` so a second press
   * that turns into a chord (Ctrl tap, then Ctrl+C) cancels cleanly.
   */
  let arming = false

  const reset = () => {
    held = false
    chorded = false
    tappedAt = null
    arming = false
  }

  return {
    keydown(e) {
      if (e.key === 'Control') {
        if (e.repeat) return false
        held = true
        chorded = false
        arming = tappedAt !== null && now() - tappedAt <= windowMs
        return false
      }
      // Any other key: a held Ctrl becomes a chord, and a standing tap is
      // spoiled — "no other key in between" is what keeps Ctrl+C, C, Ctrl+C
      // from reading as taps around a keystroke.
      chorded = true
      tappedAt = null
      arming = false
      return false
    },

    keyup(e) {
      if (e.key !== 'Control') return false
      // A release with no press behind it — focus returned mid-hold, or the
      // browser ate the keydown — proves nothing.
      if (!held) return false
      held = false
      if (chorded) {
        chorded = false
        tappedAt = null
        arming = false
        return false
      }
      if (arming) {
        reset()
        return true
      }
      tappedAt = now()
      return false
    },

    reset,
  }
}
