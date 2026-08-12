import { cn } from '@/lib/utils'

/**
 * Which end of the terminal the menu sits at.
 *
 * There are two positions and not a coordinate, because the only thing the
 * placement has to get right is not covering what was just selected. A menu
 * pinned beside the selection would also have to dodge the control strip, the
 * key bar and the edges of a scaled screen, for a precision nobody reading it
 * would notice.
 */
export type MenuEnd = 'top' | 'bottom'

/**
 * Copy and paste for a device with no keyboard to do either from.
 *
 * The gesture behind it lives in the terminal view: a long press selects the
 * word under the finger and a drag widens the range, which is a thing flue has
 * to do for itself. The OS would offer a menu of its own over real editable
 * text, but a terminal rendered to a canvas has none — there is nothing on
 * the page for a press to land on, and the browser has no idea the glyphs it
 * drew are text at all.
 *
 * Presses land on pointerdown for the same reason the key bar's do: the press
 * must not take focus from xterm's textarea, because losing it closes the
 * keyboard. The onClick beside each is the assistive-technology path, where a
 * double-tap synthesises a click and dispatches no pointer event; `detail` is
 * 0 for exactly those and keeps a finger's own follow-up click from firing
 * the action twice.
 */
export function SelectionMenu({
  at,
  canCopy,
  onCopy,
  onPaste,
  onCancel,
}: {
  at: MenuEnd
  /**
   * Whether the press found a word.
   *
   * False leaves Copy out rather than showing it greyed, because the press
   * that opens an empty prompt is a press asking to paste: the shortest menu
   * that answers it is the right one, and a disabled button is a thing to
   * read past on the way to the button you wanted.
   */
  canCopy: boolean
  onCopy: () => void
  onPaste: () => void
  onCancel: () => void
}) {
  const chip = 'rounded-md px-3 py-1.5 text-sm/4 transition-colors select-none'
  const press = (act: () => void) => ({
    onPointerDown: (e: React.PointerEvent) => {
      e.preventDefault()
      act()
    },
    onClick: (e: React.MouseEvent) => {
      if (e.detail === 0) act()
    },
  })
  return (
    <div
      data-flue-selection-menu=""
      role="toolbar"
      aria-label="Selection"
      className={cn(
        'absolute left-1/2 z-20 flex -translate-x-1/2 items-center gap-x-1',
        'rounded-lg bg-(--chip-bg) p-1 shadow-lg ring-1 ring-(--chip-ring) backdrop-blur-sm',
        // Clear of the control strip at the top and of the key bar at the
        // bottom, both of which are already spoken for.
        at === 'top' ? 'top-16' : 'bottom-20',
      )}
    >
      {canCopy && (
        <button
          type="button"
          {...press(onCopy)}
          className={cn(chip, 'font-medium text-(--chip-fg) active:bg-(--chip-wash)')}
        >
          Copy
        </button>
      )}
      <button
        type="button"
        {...press(onPaste)}
        className={cn(
          chip,
          'active:bg-(--chip-wash)',
          // Whichever verb the press was asking for reads as the loud one.
          canCopy ? 'text-(--chip-dim)' : 'font-medium text-(--chip-fg)',
        )}
      >
        Paste
      </button>
      <button
        type="button"
        {...press(onCancel)}
        className={cn(chip, 'text-(--chip-dim) active:bg-(--chip-wash)')}
      >
        Cancel
      </button>
    </div>
  )
}
