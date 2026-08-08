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
 * Fold one typed key onto its control code, for the Ctrl the bar latches.
 *
 * Touch keyboards carry no Ctrl, so the bar arms one and the next keystroke
 * lands here. Null means "not foldable" — a digit, a paste, a multi-byte
 * character — and the caller sends the bytes untouched; the arming is spent
 * either way, as a latched modifier on a real keyboard would be.
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
