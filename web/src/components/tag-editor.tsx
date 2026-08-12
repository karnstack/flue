import { useRef, useState, type RefObject } from 'react'

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

export interface TagEditorProps {
  open: boolean
  /** The tags this session carries today. */
  current: string[]
  /** Every tag in use anywhere in the fleet, offered as one-click additions. */
  known: string[]
  /** Called with the whole set. `[]` is not a refusal — it is a clear. */
  onSubmit(tags: string[]): void
  /** Dismissal, however it happened, including after a submit. */
  onClose(): void
}

/**
 * The tag surface: what this session carries, beside what the fleet already
 * calls things.
 *
 * The suggestions are the reason it exists. Tags are free text, and free text
 * drifts — `api`, `apis`, `api-server` — until grouping by tag produces three
 * headings for one idea. So every tag in use across the fleet is offered as a
 * button, and reusing one costs a single click while inventing one costs a
 * sentence of typing. The order of the two is the whole argument.
 *
 * What happens to a typed tag here is politeness, not validation: blanks are
 * dropped, a repeat is a no-op, surrounding space is cut. The daemon settles
 * all of it again on arrival — it trims, dedupes and sorts — so none of this
 * is the last word. It only keeps the chips in front of the reader honest
 * between the keystroke and the next snapshot.
 *
 * An empty set is a legitimate answer, exactly as an empty name is: taking
 * every chip off and saving is how a session's tags are cleared, so nothing
 * here refuses to submit.
 */
export function TagEditor({ open, current, known, onSubmit, onClose }: TagEditorProps) {
  const field = useRef<HTMLInputElement>(null)

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // Escape, the overlay, and the corner X all arrive here as `false`.
        if (!next) onClose()
      }}
    >
      <DialogContent
        onOpenAutoFocus={(event) => {
          // Left to itself, Radix focuses the first thing it can reach, which
          // is the first chip — and a chip is a remove button. Opening the
          // dialog with "delete api" under the space bar is not a greeting.
          event.preventDefault()
          field.current?.focus()
        }}
      >
        <DialogHeader>
          <DialogTitle>Edit tags</DialogTitle>
          <DialogDescription>
            Reuse a tag the fleet already has, or type a new one. Removing every tag clears them.
          </DialogDescription>
        </DialogHeader>
        <TagForm
          field={field}
          current={current}
          known={known}
          onCancel={onClose}
          onSubmit={(tags) => {
            onSubmit(tags)
            onClose()
          }}
        />
      </DialogContent>
    </Dialog>
  )
}

/**
 * The chips, the field, the suggestions, and the two buttons.
 *
 * Deliberately not a form element, unlike the rename dialog's body. Enter here
 * means "add this tag", not "I am done", and a form would give the same
 * keystroke both meanings — one of them ending the dialog on a set the reader
 * had not finished assembling. So Enter is handled on the field and Save is an
 * ordinary click.
 *
 * State seeded once from `current` and never resynced: the content this sits
 * in is unmounted on close, so the seeding happens exactly when the dialog
 * opens and a set abandoned on one session cannot follow the reader to the
 * next. The draft is held here rather than inside the field for the reason
 * Save's own comment gives — it is part of the answer.
 */
function TagForm({
  field,
  current,
  known,
  onSubmit,
  onCancel,
}: {
  field: RefObject<HTMLInputElement | null>
  current: string[]
  known: string[]
  onSubmit(tags: string[]): void
  onCancel(): void
}) {
  const [tags, setTags] = useState<string[]>(() => [...current])
  const [draft, setDraft] = useState('')

  return (
    <div className="grid gap-4">
      <TagField
        field={field}
        tags={tags}
        onTags={setTags}
        draft={draft}
        onDraft={setDraft}
        known={known}
      />

      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        {/*
          The field is part of the answer. Someone who typed a tag and reached
          straight for Save is done, and a dialog that threw those keystrokes
          away on the way out would be disagreeing with them in silence — the
          worst way to disagree, since the chips are gone before anyone can
          read what was sent.
        */}
        <Button type="button" onClick={() => onSubmit(withTag(tags, draft))}>
          Save
        </Button>
      </DialogFooter>
    </div>
  )
}
