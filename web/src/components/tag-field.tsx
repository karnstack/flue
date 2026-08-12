import { useId, type RefObject } from 'react'
import { PlusIcon, XMarkIcon } from '@heroicons/react/16/solid'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

/**
 * The set with one more tag in it: trimmed, and unchanged if the tag is blank
 * or already there.
 *
 * Three routes reach this rule and it cannot hold for two of them — a typed
 * Enter, a clicked suggestion, and a Save over a field the reader never
 * pressed Enter on. That third one is the reason this is a function rather
 * than four lines inside the first handler that needed them, and the reason it
 * is exported: every caller of TagField owes its reader the same courtesy of
 * counting a half-typed tag as part of the answer.
 *
 * The comparison is exact rather than case-folded: `API` and `api` are two
 * strings until the daemon says otherwise, and folding them here would drop a
 * tag the reader had just watched themselves type.
 */
export function withTag(held: string[], tag: string): string[] {
  const clean = tag.trim()
  if (clean === '' || held.includes(clean)) return held
  return [...held, clean]
}

export interface TagFieldProps {
  /** The tags chosen so far. */
  tags: string[]
  onTags(tags: string[]): void
  /** What is half-typed in the field. Owned above, because Save must see it. */
  draft: string
  onDraft(draft: string): void
  /** Every tag in use across the fleet, offered as one-click additions. */
  known: string[]
  /** The field itself, for a dialog that opens focus on it. */
  field?: RefObject<HTMLInputElement | null>
  /** What the field is called. The surrounding form owns the wording. */
  label?: string
  /** What an empty set says. */
  empty?: string
  /**
   * Whether the chips lead or follow the field.
   *
   * Leading is right for a dialog whose whole subject is tags: the title says
   * what the screen is, and what is already there should be the first thing
   * under it. Following is right for one field among several, where a row of
   * chips above the label reads as a stray sentence belonging to the field
   * before it — which is exactly how "No tags yet." landed between a
   * directory and a heading called Tags.
   */
  chipsFirst?: boolean
}

/**
 * Tag chips, a field to add to them, and the fleet's own tags as buttons.
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
 * Fully controlled, draft included, and that second half is not tidiness: the
 * forms above this decide what a Save does with a field nobody pressed Enter
 * on, and a draft held privately here would be a keystroke they could not
 * reach. Enter adds a tag and is stopped here, so a field sitting inside a
 * real form cannot submit it by accident — a set the reader was still
 * assembling is not an answer.
 */
export function TagField({
  tags,
  onTags,
  draft,
  onDraft,
  known,
  field,
  label = 'Add tag',
  empty = 'No tags yet.',
  chipsFirst = true,
}: TagFieldProps) {
  const fieldId = useId()
  const suggestionsId = useId()

  /** A typed Enter and a clicked suggestion, both of which empty the field. */
  const add = (tag: string) => {
    onDraft('')
    onTags(withTag(tags, tag))
  }

  // What the fleet knows, minus what is already chosen, narrowed by what has
  // been typed so far. A prefix rather than a substring: a reader typing `de`
  // is reaching for a tag they can already half-remember, and matching the
  // middle of words would answer with tags they were not naming.
  const needle = draft.trim().toLowerCase()
  const offered = known.filter((tag) => !tags.includes(tag) && tag.toLowerCase().startsWith(needle))

  const chips = (
    <div className="flex flex-wrap items-center gap-1.5">
      {tags.length === 0 ? (
        <p className="text-sm text-muted-foreground">{empty}</p>
      ) : (
        tags.map((tag) => (
          /*
            The chip is the remove control, which is why its accessible name
            says so: the word on screen is the tag, and a reader hearing only
            "api, button" would have no idea that pressing it takes the tag
            away. The X, and the destructive tint under the pointer, say the
            same thing to the eye.
          */
          <Badge key={tag} asChild variant="secondary">
            <button
              type="button"
              aria-label={`Remove ${tag}`}
              onClick={() => onTags(tags.filter((other) => other !== tag))}
              className="cursor-pointer hover:bg-destructive/10 hover:text-destructive dark:hover:bg-destructive/20"
            >
              {tag}
              <XMarkIcon data-icon="inline-end" aria-hidden="true" />
            </button>
          </Badge>
        ))
      )}
    </div>
  )

  return (
    <div className="grid gap-4">
      {chipsFirst && chips}

      <div className="grid gap-1.5">
        <label htmlFor={fieldId} className="text-sm font-medium text-zinc-950 dark:text-white">
          {label}
        </label>
        <Input
          id={fieldId}
          ref={field}
          value={draft}
          autoComplete="off"
          placeholder="Type a tag, then press Enter"
          onChange={(event) => onDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Enter') return
            // Stopped whether or not it adds anything. This field sits inside a
            // real form in the new-session dialog, and an Enter left to bubble
            // would submit that form — starting a session on the keystroke that
            // was meant to finish a tag.
            event.preventDefault()
            add(draft)
          }}
        />
        {!chipsFirst && chips}
      </div>

      {offered.length > 0 && (
        <div role="group" aria-labelledby={suggestionsId} className="grid gap-1.5">
          <p id={suggestionsId} className="text-xs text-muted-foreground">
            Suggestions
          </p>
          {/* Capped in height and scrolled: a fleet with forty tags in it must
              not push the buttons off the bottom of the screen. */}
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
    </div>
  )
}
