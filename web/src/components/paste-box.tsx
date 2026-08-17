import { useEffect, useRef } from 'react'

/**
 * Somewhere to paste into, for when the browser will not be asked.
 *
 * Reading the clipboard from script is a permission, and a phone browser is
 * entitled to refuse it — Safari in particular grants it only for a gesture
 * it approves of, and answers everything else by doing nothing at all. That
 * leaves flue's Paste looking broken for a reason no message can explain,
 * because no error is raised: the promise simply never resolves the way it
 * was asked to.
 *
 * Pasting *into a text field* is not a permission. It is the person choosing
 * their own clipboard through their own operating system, and no browser has
 * ever gated it. So this is the way that cannot be refused: a real, plain,
 * ordinary input on the screen, long-pressed like any other, with the
 * platform's own Paste in the callout above it. What lands here goes on to
 * the terminal.
 *
 * A fallback and not the front door. When the clipboard can be read, one tap
 * is better than three, and this never appears.
 */
export function PasteBox({ onText, onCancel }: { onText: (text: string) => void; onCancel: () => void }) {
  const field = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    // Focused on arrival so the callout is one press away rather than two,
    // and so the keyboard that was already up does not drop while this opens.
    field.current?.focus({ preventScroll: true })
  }, [])

  const send = (text: string) => {
    if (text !== '') onText(text)
  }

  return (
    <div
      data-flue-paste-box=""
      className="absolute right-3 bottom-20 left-3 z-20 rounded-lg bg-(--chip-bg) p-2 shadow-lg ring-1 ring-(--chip-ring) backdrop-blur-sm"
    >
      <p className="px-1 pb-1.5 text-xs text-(--chip-dim)">
        This browser will not hand over the clipboard. Press and hold here, choose Paste, and it
        goes to the terminal.
      </p>
      <div className="flex items-center gap-x-2">
        <textarea
          ref={field}
          rows={1}
          aria-label="Paste here"
          // 16px, because iOS zooms the page in on a field any smaller and
          // this one is meant to be typed into.
          className="min-w-0 flex-1 resize-none rounded-md bg-(--chip-wash) px-2 py-1.5 text-[1rem] text-(--chip-fg) outline-none"
          onPaste={(e) => {
            // The paste event carries the text, and taking it from here rather
            // than from the field a tick later is what keeps the terminal from
            // seeing a half-applied value.
            e.preventDefault()
            send(e.clipboardData.getData('text'))
          }}
          // Not every keyboard raises a paste event — some clipboard managers
          // and dictation insert text as ordinary input. Whatever arrives, the
          // whole of it is the paste.
          onInput={(e) => send(e.currentTarget.value)}
        />
        <button
          type="button"
          onPointerDown={(e) => e.preventDefault()}
          onClick={onCancel}
          className="shrink-0 rounded-md px-3 py-1.5 text-sm/4 text-(--chip-dim) active:bg-(--chip-wash)"
        >
          Cancel
        </button>
      </div>
    </div>
  )
}
