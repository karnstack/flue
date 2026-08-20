import { useId } from 'react'
import { AdjustmentsHorizontalIcon } from '@heroicons/react/16/solid'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  COLUMN_KEYS,
  COLUMN_LABELS,
  DEFAULT_DIRECTIONS,
  DIRECTION_LABELS,
  DIRECTIONS,
  GROUPING_LABELS,
  GROUPINGS,
  ORDERING_LABELS,
  ORDERINGS,
  SUBGROUPING_LABELS,
  type ColumnKey,
  type ViewConfig,
} from '@/sessions/view'

export interface DisplayOptionsProps {
  /** The arrangement the sessions list is showing now. */
  view: ViewConfig
  /** A whole new arrangement. Never the same object back with a field moved. */
  onChange(view: ViewConfig): void
}

/**
 * The ⚙ panel: how the sessions list is cut, ordered, and how much of it there
 * is.
 *
 * Everything a person can say about the shape of the list lives behind this
 * one trigger, and that is the argument for it existing at all. The controls
 * are five, they are each used rarely, and left out in the header they would
 * turn a page title into a form — while the two things done constantly, search
 * and starting a session, stay one click away beside it.
 *
 * It owns nothing. Each control reports a whole new `ViewConfig` with exactly
 * its own field replaced, and the caller decides what that means: the sessions
 * list re-cuts, and a saved view goes dirty. Two consequences worth naming.
 * The object handed in is never edited — `DEFAULT_VIEW` is one shared object
 * and is frozen precisely so a slip here fails at the line rather than three
 * screens later. And a control that reports a field it was not asked about is
 * a bug this file's cases are written to catch, because the field it would
 * quietly carry along is whatever the reader last changed somewhere else.
 */
export function DisplayOptions({ view, onChange }: DisplayOptionsProps) {
  const exitedId = useId()
  const propertiesId = useId()

  return (
    <Popover>
      <PopoverTrigger asChild>
        {/*
          Named, because the icon is the only thing on it. Two sliders is the
          convention for "how this reads" — a gear would promise settings that
          outlive the screen, which none of these do.
        */}
        <Button variant="outline" size="icon" aria-label="Display options">
          <AdjustmentsHorizontalIcon aria-hidden="true" />
        </Button>
      </PopoverTrigger>
      {/*
        Anchored to the end, since this rides at the right of a page header and
        content centred on the trigger would hang off the edge of the screen.
        Radix gives the content a dialog role, and a dialog with no name is
        announced as just "dialog" — so it borrows the trigger's.
      */}
      <PopoverContent align="end" aria-label="Display options" className="w-72">
        <Choice
          label="Grouping"
          value={view.grouping}
          options={GROUPINGS}
          labels={GROUPING_LABELS}
          // The first cut taking the second's key, or going away entirely,
          // takes the second cut with it: tag then tag draws as tag alone,
          // and nothing cut once cannot be cut twice. A select left reading
          // "Tag" underneath would claim a second cut that is not there.
          onPick={(grouping) =>
            onChange({
              ...view,
              grouping,
              subgrouping:
                grouping === 'none' || grouping === view.subgrouping ? 'none' : view.subgrouping,
            })
          }
        />
        <Choice
          label="Then by"
          value={view.subgrouping}
          // Every key but the first cut's own — see above for why — and the
          // way out, which reads "Nothing" here rather than "No grouping".
          options={GROUPINGS.filter((g) => g !== view.grouping)}
          labels={SUBGROUPING_LABELS}
          disabled={view.grouping === 'none'}
          onPick={(subgrouping) => onChange({ ...view, subgrouping })}
        />
        <Choice
          label="Ordering"
          value={view.ordering}
          options={ORDERINGS}
          labels={ORDERING_LABELS}
          // A new key brings its own natural direction along rather than
          // inheriting the old key's: whoever flipped Name to z–a and then
          // switched to Created wants the newest first, not a reversal they
          // asked of a different column.
          onPick={(ordering) =>
            onChange({ ...view, ordering, direction: DEFAULT_DIRECTIONS[ordering] })
          }
        />
        <Choice
          label="Direction"
          value={view.direction}
          options={DIRECTIONS}
          labels={DIRECTION_LABELS}
          onPick={(direction) => onChange({ ...view, direction })}
        />

        <div className="flex items-center justify-between gap-2">
          {/*
            A real label rather than an `aria-label`, so that the words are a
            second hit area for the checkbox — which is 16px square, and 16px
            square is a target only a mouse enjoys.
          */}
          <label htmlFor={exitedId} className="cursor-pointer text-muted-foreground">
            Show exited sessions
          </label>
          <Checkbox
            id={exitedId}
            checked={view.showExited}
            // Radix admits a third state its checkboxes never enter here; the
            // comparison keeps `showExited` a boolean rather than trusting it.
            onCheckedChange={(next) => onChange({ ...view, showExited: next === true })}
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <p id={propertiesId} className="text-xs text-muted-foreground">
            Display properties
          </p>
          {/*
            A group, so the chips are announced under the heading that says
            what pressing one does. Iterated from COLUMN_KEYS rather than
            listed: a column added to the model with no chip to reach it is a
            column nobody can turn on.
          */}
          <div role="group" aria-labelledby={propertiesId} className="flex flex-wrap gap-1.5">
            {COLUMN_KEYS.map((key) => (
              <ColumnChip
                key={key}
                column={key}
                view={view}
                onToggle={() => onChange({ ...view, columns: toggled(view.columns, key) })}
              />
            ))}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}

/**
 * One column, on or off.
 *
 * The name column is the exception, and it is a deliberate one. The sessions
 * list prints the name whether or not `columns` asks for it — a list of
 * unnamed rows identifies nothing to click on — so this chip says "on" and
 * declines the press, with the reason on its `title`. The alternative was a
 * chip that toggles the flag honestly and watches the list ignore it, which is
 * worse: a control that does nothing teaches the reader that the panel is
 * unreliable, and they have no way to find out which of the seven are real.
 *
 * `disabled` rather than `aria-disabled`, so the press is refused by the
 * platform rather than by a handler that silently returns. The cost is that
 * keyboard focus skips it and the `title` goes unread there; the state it
 * carries — pressed — is the whole of what that sentence would say anyway.
 */
function ColumnChip({
  column,
  view,
  onToggle,
}: {
  column: ColumnKey
  view: ViewConfig
  onToggle(): void
}) {
  const locked = column === 'name'
  // Reflects what the list does, not what the config says: a stored view whose
  // columns lost 'name' still gets a name column, and the chip must not claim
  // otherwise.
  const on = locked || view.columns.includes(column)

  return (
    <Badge asChild variant={on ? 'secondary' : 'outline'}>
      <button
        type="button"
        aria-pressed={on}
        disabled={locked}
        title={locked ? 'The name always shows — an unnamed row identifies nothing' : undefined}
        onClick={onToggle}
        className="cursor-pointer disabled:cursor-default"
      >
        {COLUMN_LABELS[column]}
      </button>
    </Badge>
  )
}

/**
 * One labelled select over a fixed set of words.
 *
 * Both selects here have the same shape and neither has anything to say about
 * the other, so they share this rather than being written twice. `labels` is a
 * total map over `options`, which is what stops a new grouping from reaching
 * the screen as the identifier a programmer typed.
 */
function Choice<T extends string>({
  label,
  value,
  options,
  labels,
  disabled = false,
  onPick,
}: {
  label: string
  value: T
  options: readonly T[]
  labels: Record<T, string>
  /** A choice with nothing to choose right now; it keeps its place and its word. */
  disabled?: boolean
  onPick(value: T): void
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-muted-foreground">{label}</span>
      {/*
        The word printed beside it is not the trigger's label — nothing
        associates the two — so the trigger carries its own name. Radix types
        `onValueChange` as a bare string; the only values it can emit are the
        ones rendered below, which are `T`.
      */}
      <Select value={value} disabled={disabled} onValueChange={(next) => onPick(next as T)}>
        <SelectTrigger size="sm" aria-label={label} className="w-40">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option} value={option}>
              {labels[option]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}

/**
 * The column list with one column added or taken away, in reading order.
 *
 * Rebuilt from COLUMN_KEYS rather than pushed onto, so the answer is always in
 * the order the headings run. Appending would put a column back wherever the
 * chip happened to be pressed — turn Directory off and on and it reappears at
 * the far right, past Created — and the sessions list would have to sort the
 * preference back into shape on every render to undo it.
 */
function toggled(columns: ColumnKey[], column: ColumnKey): ColumnKey[] {
  const wanted = new Set(columns)
  if (!wanted.delete(column)) wanted.add(column)
  return COLUMN_KEYS.filter((key) => wanted.has(key))
}
