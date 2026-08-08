import { useId, useRef, useState, type RefObject } from 'react'
import { PlusIcon, XMarkIcon } from '@heroicons/react/16/solid'

import { Badge } from '@/components/ui/badge'
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
 * next.
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
  const fieldId = useId()
  const suggestionsId = useId()
  const [tags, setTags] = useState<string[]>(() => [...current])
  const [draft, setDraft] = useState('')

  /**
   * Both routes in — a typed Enter and a clicked suggestion — end here, so
   * the trim and the duplicate check cannot apply to one and not the other.
   * The comparison is exact rather than case-folded: `API` and `api` are two
   * strings until the daemon says otherwise, and guessing here would silently
   * drop a tag the reader watched themselves type.
   */
  const add = (tag: string) => {
    const clean = tag.trim()
    setDraft('')
    if (clean === '') return
    setTags((held) => (held.includes(clean) ? held : [...held, clean]))
  }

  // What the fleet knows, minus what this session already carries, narrowed by
  // what has been typed so far. A prefix rather than a substring: a reader
  // typing `de` is reaching for a tag they can already half-remember, and
  // matching the middle of words would answer with tags they were not naming.
  const needle = draft.trim().toLowerCase()
  const offered = known.filter(
    (tag) => !tags.includes(tag) && tag.toLowerCase().startsWith(needle),
  )

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center gap-1.5">
        {tags.length === 0 ? (
          <p className="text-sm text-muted-foreground">No tags yet.</p>
        ) : (
          tags.map((tag) => (
            /*
              The chip is the remove control, which is why its accessible name
              says so: the word on screen is the tag, and a reader hearing
              only "api, button" would have no idea that pressing it takes the
              tag away. The X, and the destructive tint under the pointer, say
              the same thing to the eye.
            */
            <Badge key={tag} asChild variant="secondary">
              <button
                type="button"
                aria-label={`Remove ${tag}`}
                onClick={() => setTags((held) => held.filter((other) => other !== tag))}
                className="cursor-pointer hover:bg-destructive/10 hover:text-destructive dark:hover:bg-destructive/20"
              >
                {tag}
                <XMarkIcon data-icon="inline-end" aria-hidden="true" />
              </button>
            </Badge>
          ))
        )}
      </div>

      <div className="grid gap-1.5">
        <label htmlFor={fieldId} className="text-sm font-medium text-zinc-950 dark:text-white">
          Add tag
        </label>
        <Input
          id={fieldId}
          ref={field}
          value={draft}
          autoComplete="off"
          placeholder="Type a tag, then press Enter"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Enter') return
            // Nothing above would submit on Enter today, but this field will
            // one day sit inside something that does.
            event.preventDefault()
            add(draft)
          }}
        />
      </div>

      {offered.length > 0 && (
        <div role="group" aria-labelledby={suggestionsId} className="grid gap-1.5">
          <p id={suggestionsId} className="text-xs text-muted-foreground">
            Suggestions
          </p>
          {/* Capped in height and scrolled: a fleet with forty tags in it
              must not push Save off the bottom of the screen. */}
          <div className="flex max-h-24 flex-wrap gap-1.5 overflow-y-auto">
            {offered.map((tag) => (
              <Button
                key={tag}
                type="button"
                variant="outline"
                size="xs"
                aria-label={`Add ${tag}`}
                onClick={() => add(tag)}
              >
                <PlusIcon data-icon="inline-start" aria-hidden="true" />
                {tag}
              </Button>
            ))}
          </div>
        </div>
      )}

      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="button" onClick={() => onSubmit(tags)}>
          Save
        </Button>
      </DialogFooter>
    </div>
  )
}
