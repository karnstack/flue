import { useId, useRef, useState, type RefObject } from 'react'

import { TagField, withTag } from '@/components/tag-field'
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import type { NewSessionRequest } from '@/sessions/new-session'

/** A machine this dialog may start a session on. */
export interface NewSessionMachine {
  id: string
  /** What to call it. Empty falls back to the id, as every other screen does. */
  name: string
}

export interface NewSessionDialogProps {
  open: boolean
  /**
   * What the press that opened this already implies: the machine of the
   * heading, the directory of the terminal underneath, the tag of the group.
   * Everything absent opens empty.
   */
  initial: Partial<NewSessionRequest>
  /** The machines that can carry one. An empty list disables the dialog. */
  machines: NewSessionMachine[]
  /** Every tag in use across the fleet, offered as one-click additions. */
  known: string[]
  /** Called with the whole request. The caller decides where it opens. */
  onSubmit(want: NewSessionRequest): void
  /** Dismissal, however it happened, including after a submit. */
  onClose(): void
}

/**
 * The one place a session is asked for.
 *
 * It exists because of the order the daemon imposes: `spawn` carries no
 * metadata, so a name and a tag can only be applied after the session already
 * exists. Left to that order, naming a session means starting it, watching a
 * terminal come up, going back to the list and renaming the row — and nobody
 * does that, so sessions stay called after whatever shell they run. Asking
 * first turns the same two round trips into one form: what is typed here is
 * carried to the page that starts the session, which applies it the moment
 * there is an id to apply it to.
 *
 * Nothing is required. Every field opens either empty or on what the press
 * implied, and submitting all four untouched is exactly the old one-click
 * behaviour — which is the bar this had to clear to be allowed in front of it.
 *
 * The form state lives one component down, inside the content Radix unmounts
 * on close, for the reason the rename dialog gives: the next open builds a new
 * form over new props, so a name abandoned on one press cannot follow the
 * reader to the next.
 */
export function NewSessionDialog({
  open,
  initial,
  machines,
  known,
  onSubmit,
  onClose,
}: NewSessionDialogProps) {
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
          // The name, which is the field this dialog exists for. Left to
          // itself Radix takes the first thing it can reach, and where that
          // lands depends on which prefills happened to render.
          event.preventDefault()
          field.current?.focus()
        }}
      >
        <DialogHeader>
          <DialogTitle>New session</DialogTitle>
          <DialogDescription>
            Everything here is optional. The session opens in a tab of its own.
          </DialogDescription>
        </DialogHeader>
        <NewSessionForm
          field={field}
          initial={initial}
          machines={machines}
          known={known}
          onCancel={onClose}
          onSubmit={(want) => {
            onSubmit(want)
            onClose()
          }}
        />
      </DialogContent>
    </Dialog>
  )
}

/**
 * The four fields and the two buttons.
 *
 * A real form element, so Enter starts the session the way Enter submits
 * everywhere else — the browser's own implicit submission, reached identically
 * by the button and by the keyboard. The tag field stops its own Enter (see
 * TagField), which is what keeps "finish this tag" from meaning "start now".
 *
 * The machine picker renders only when there is a choice to make. A fleet of
 * one is the ordinary case, and a select holding a single option is a control
 * that asks a question with one answer.
 */
function NewSessionForm({
  field,
  initial,
  machines,
  known,
  onSubmit,
  onCancel,
}: {
  field: RefObject<HTMLInputElement | null>
  initial: Partial<NewSessionRequest>
  machines: NewSessionMachine[]
  known: string[]
  onSubmit(want: NewSessionRequest): void
  onCancel(): void
}) {
  const nameId = useId()
  const cwdId = useId()
  const machineId = useId()

  const [name, setName] = useState(initial.name ?? '')
  const [cwd, setCwd] = useState(initial.cwd ?? '')
  const [tags, setTags] = useState<string[]>(() => [...(initial.tags ?? [])])
  const [draft, setDraft] = useState('')
  /**
   * The machine the reader picked, or null for "nobody has picked one".
   *
   * Null rather than a seeded id, so `on` below stays a *derivation* of the
   * list rather than a snapshot of it taken once. The list moves: a machine
   * can drop while the form is open, and on the terminal screen the fleet's
   * first delivery can land after the dialog has already rendered. A seeded
   * value would leave the trigger blank and the form pointing at an id no
   * option carries.
   */
  const [picked, setPicked] = useState<string | null>(null)
  const wanted = picked ?? initial.machineId
  const on = machines.find((m) => m.id === wanted)?.id ?? machines[0]?.id ?? ''

  const nothingReachable = machines.length === 0

  return (
    <form
      className="grid gap-4"
      onSubmit={(event) => {
        event.preventDefault()
        if (nothingReachable) return
        // The tag field is part of the answer: somebody who typed a tag and
        // reached straight for Start is done, and throwing that keystroke away
        // on the way out would be disagreeing with them in silence.
        onSubmit({ machineId: on, cwd: cwd.trim(), name: name.trim(), tags: withTag(tags, draft) })
      }}
    >
      <div className="grid gap-1.5">
        <label htmlFor={nameId} className="text-sm font-medium text-zinc-950 dark:text-white">
          Name
        </label>
        <Input
          id={nameId}
          ref={field}
          value={name}
          autoComplete="off"
          placeholder="Leave empty to use the title the program announces"
          onChange={(event) => setName(event.target.value)}
        />
      </div>

      <div className="grid gap-1.5">
        <label htmlFor={cwdId} className="text-sm font-medium text-zinc-950 dark:text-white">
          Directory
        </label>
        <Input
          id={cwdId}
          value={cwd}
          autoComplete="off"
          spellCheck={false}
          placeholder="Leave empty for the daemon's own default"
          onChange={(event) => setCwd(event.target.value)}
          className="font-mono"
        />
      </div>

      {machines.length > 1 && (
        <div className="grid gap-1.5">
          <label htmlFor={machineId} className="text-sm font-medium text-zinc-950 dark:text-white">
            Machine
          </label>
          <Select value={on} onValueChange={setPicked}>
            <SelectTrigger id={machineId} aria-label="Machine" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {machines.map((m) => (
                <SelectItem key={m.id} value={m.id}>
                  {m.name || m.id}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      <TagField
        tags={tags}
        onTags={setTags}
        draft={draft}
        onDraft={setDraft}
        known={known}
        label="Tags"
        empty="No tags yet."
        // One field among four, so the chips follow it. Leading, they read as
        // a stray line belonging to the field above rather than as this one's
        // answer.
        chipsFirst={false}
      />

      {nothingReachable && (
        // Said rather than hidden. The dialog opens from a button that was
        // pressed, and a form that silently refused would leave the reader
        // pressing Start at a fleet that is not there.
        <p role="status" className="text-sm text-muted-foreground">
          No machine is reachable, so nothing can be started right now.
        </p>
      )}

      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={nothingReachable}>
          Start session
        </Button>
      </DialogFooter>
    </form>
  )
}
