import { useId, useRef, useState, type RefObject } from 'react'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'

export interface RenameDialogProps {
  open: boolean
  /** The name the session carries today; '' for one that has never been named. */
  initial: string
  /** Called with the trimmed name. '' is not a refusal — it is a clear. */
  onSubmit(name: string): void
  /** Dismissal, however it happened, including after a submit. */
  onClose(): void
}

/**
 * The rename surface a row's ⋯ menu opens.
 *
 * Two things about it are load-bearing and neither announces itself. The
 * first: an empty submit is a real answer. '' is how the daemon is told to
 * forget the name and let the title the program announces speak for the
 * session again, so Save never disables itself and nothing stands between an
 * emptied field and the wire. The second: the field opens selected rather
 * than merely focused, because a rename is nearly always a replacement, and a
 * caret parked at the end would begin the common act with a held Backspace.
 *
 * The editing state lives one component down, inside the content Radix
 * unmounts on close. That is what makes an abandoned edit forgettable without
 * an effect copying `initial` into state on every open: the next open builds
 * a new form over a new prop. One dialog serves every row in the list, and
 * carrying half a name from the row before would be the worst kind of bug —
 * the kind that saves.
 */
export function RenameDialog({ open, initial, onSubmit, onClose }: RenameDialogProps) {
  const field = useRef<HTMLInputElement>(null)

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // Escape, the overlay, and the corner X all arrive here as `false`.
        // The dialog is controlled by the caller, so this is a request to
        // close rather than a closing.
        if (!next) onClose()
      }}
    >
      <DialogContent
        onOpenAutoFocus={(event) => {
          // Radix would focus the first thing it can reach and, for a text
          // input, select it too. This says so out loud instead: the one
          // behaviour the dialog exists for should not rest on where the
          // markup happens to put the field.
          event.preventDefault()
          field.current?.focus()
          field.current?.select()
        }}
      >
        <DialogHeader>
          <DialogTitle>Rename session</DialogTitle>
          <DialogDescription>
            Leave it empty to fall back to the title the program announces.
          </DialogDescription>
        </DialogHeader>
        <RenameForm
          field={field}
          initial={initial}
          onCancel={onClose}
          onSubmit={(name) => {
            onSubmit(name)
            onClose()
          }}
        />
      </DialogContent>
    </Dialog>
  )
}

/**
 * The field and its two buttons.
 *
 * A real form element, so Enter submits the way Enter submits everywhere else
 * — the browser's own implicit submission, reached identically by the Save
 * button and by the keyboard, with no key handler of ours to keep in step
 * with it.
 *
 * The trim is the one liberty taken with what the reader typed. The daemon
 * stores a name verbatim and the list prefers a name over every other source,
 * so a field holding nothing but spaces would name a session with a run of
 * blanks and there would be no way to tell it from a bug.
 */
function RenameForm({
  field,
  initial,
  onSubmit,
  onCancel,
}: {
  field: RefObject<HTMLInputElement | null>
  initial: string
  onSubmit(name: string): void
  onCancel(): void
}) {
  const id = useId()
  const [value, setValue] = useState(initial)

  return (
    <form
      className="grid gap-4"
      onSubmit={(event) => {
        event.preventDefault()
        onSubmit(value.trim())
      }}
    >
      <div className="grid gap-1.5">
        <label htmlFor={id} className="text-sm font-medium text-zinc-950 dark:text-white">
          Name
        </label>
        <Input
          id={id}
          ref={field}
          value={value}
          autoComplete="off"
          onChange={(event) => setValue(event.target.value)}
        />
      </div>
      <DialogFooter>
        {/*
          Cancel first in the markup and last to the eye on a narrow screen,
          which is what the footer's reversed column is for. It is a button
          rather than a DialogClose so that the reason for the dismissal is
          the same one line of code as every other reason.
        */}
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit">Save</Button>
      </DialogFooter>
    </form>
  )
}
