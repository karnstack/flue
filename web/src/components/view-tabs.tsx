import { useId, useRef, useState, type RefObject } from 'react'
import { EllipsisHorizontalIcon, PlusIcon } from '@heroicons/react/16/solid'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import type { SavedView } from '@/sessions/views-store'

export interface ViewTabsProps {
  /** Every kept view, in the order their tabs should read. */
  views: SavedView[]
  /** The view being shown. `null` is the built-in "All", which nobody saved. */
  active: string | null
  /**
   * Whether the arrangement on screen has drifted from what `active` holds.
   *
   * Computed by the caller and only rendered here. It must be a comparison of
   * values: the controls upstream re-report a whole `ViewConfig` on every
   * touch, including touches that changed nothing, so a caller comparing
   * objects by identity would light this the first time somebody re-picked the
   * grouping it already had.
   */
  dirty: boolean
  /** A tab was pressed. `null` for "All". */
  onSelect(name: string | null): void
  /**
   * Keep the arrangement on screen under this name — from the + dialog, and
   * from "Update view" with the active view's own name.
   *
   * The name arrives trimmed and never blank. A name already in use is not
   * refused and is not asked about: the store replaces a view of the same name
   * where it sits, which is what "save this as Ops" means when Ops exists.
   */
  onSaveCurrent(name: string): void
  /** Forget this view. Fired from the tab's own ⋯ menu. */
  onDelete(name: string): void
}

/**
 * The strip of saved views under the page header.
 *
 * Buttons rather than links, and `aria-pressed` rather than `aria-selected`.
 * These are not tabs in the sense the tab pattern means: there is one panel —
 * the sessions list — and pressing one of these does not swap it for another,
 * it re-cuts the same rows. A `tablist` would also promise arrow-key
 * navigation between them, which nothing here implements. Pressed toggles are
 * the honest shape, and they carry state to a screen reader either way.
 *
 * "All" is first and has no ⋯ of its own, because it is not stored: it is the
 * absence of a saved view, so there is nothing to delete and nothing to
 * update. That is also why the update affordance is missing while it is
 * active — the edit is real, but it has no name to be written under, and the +
 * beside it is exactly the control for giving it one.
 *
 * Nothing is owned here but whether the name dialog is open. Both writing
 * controls report the same `onSaveCurrent`, since "save the arrangement under
 * this name" is one act whether the name is new or the one already on the tab.
 */
export function ViewTabs({
  views,
  active,
  dirty,
  onSelect,
  onSaveCurrent,
  onDelete,
}: ViewTabsProps) {
  const [naming, setNaming] = useState(false)
  const field = useRef<HTMLInputElement>(null)

  return (
    /*
      A group rather than a toolbar: a toolbar promises arrow keys move between
      its controls, and these are reached with Tab like every other button on
      the screen. Wrapping, because the strip grows with every view kept and a
      row of them must not push the page sideways.
    */
    <div role="group" aria-label="Saved views" className="flex flex-wrap items-center gap-1">
      <Tab pressed={active === null} onPress={() => onSelect(null)}>
        All
      </Tab>

      {views.map((view) => (
        // Keyed by name, which is a view's identity — there is no id, and two
        // views cannot share a name because the store keeps one row per name.
        <div key={view.name} className="flex items-center">
          <Tab pressed={active === view.name} onPress={() => onSelect(view.name)}>
            {view.name}
          </Tab>
          <ViewMenu name={view.name} onDelete={onDelete} />
        </div>
      ))}

      {/*
        The two ways to write the current arrangement down, kept together at
        the end of the strip: + puts it under a new name, Update puts it back
        under the one already pressed. Update is only there when there is
        something to update and a name to update it under — see the component
        note on why "All" gets no such button.
      */}
      <Dialog open={naming} onOpenChange={setNaming}>
        <DialogTrigger asChild>
          {/*
            Named, since a plus sign is not a word. It says what pressing it
            does rather than "new view": what gets kept is the arrangement on
            screen right now, not an empty one to fill in afterwards.
          */}
          <Button variant="ghost" size="icon-sm" aria-label="Save current view">
            <PlusIcon aria-hidden="true" />
          </Button>
        </DialogTrigger>
        <DialogContent
          onOpenAutoFocus={(event) => {
            // Said out loud rather than left to Radix's walk for the first
            // thing it can focus. Nothing is selected on the way in, unlike
            // the rename dialog: this field opens empty.
            event.preventDefault()
            field.current?.focus()
          }}
        >
          <DialogHeader>
            <DialogTitle>Save view</DialogTitle>
            <DialogDescription>
              Keeps the current grouping, ordering, search, columns and exited
              sessions under a name of your own.
            </DialogDescription>
          </DialogHeader>
          <SaveViewForm
            field={field}
            onCancel={() => setNaming(false)}
            onSubmit={(name) => {
              onSaveCurrent(name)
              setNaming(false)
            }}
          />
        </DialogContent>
      </Dialog>

      {active !== null && dirty ? (
        <Button variant="outline" size="sm" onClick={() => onSaveCurrent(active)}>
          Update view
        </Button>
      ) : null}
    </div>
  )
}

/**
 * One tab, pressed or not.
 *
 * Filled when pressed and bare otherwise, so the state is a difference in
 * surface rather than a difference in weight — text that thickened on the
 * pressed tab would move every tab after it. The teal is spent on the one
 * primary button this screen has and on focus rings; a tab strip is not where
 * a page's accent goes.
 */
function Tab({
  pressed,
  onPress,
  children,
}: {
  pressed: boolean
  onPress(): void
  children: string
}) {
  return (
    <Button
      variant={pressed ? 'secondary' : 'ghost'}
      size="sm"
      aria-pressed={pressed}
      onClick={onPress}
    >
      {children}
    </Button>
  )
}

/**
 * A saved view's own ⋯ menu.
 *
 * Delete asks nothing first, deliberately. A view is a handful of words about
 * how a list is cut — it costs seconds to make again, and it takes nothing
 * with it: no session is touched, no arrangement leaves the screen, since the
 * sessions list goes on showing exactly what it was showing. A confirm here
 * would be the same dialog the bulk bar raises before killing processes, spent
 * on something that cannot lose work, and that is how a reader learns to click
 * through the one that matters. An undo would be better than either; if one
 * arrives it belongs to whoever owns the store, not to this strip.
 */
function ViewMenu({ name, onDelete }: { name: string; onDelete(name: string): void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`View options for ${name}`}
          className="text-zinc-500 dark:text-zinc-400"
        >
          <EllipsisHorizontalIcon aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      {/*
        `w-auto` unseats the content's default trigger-width sizing, which
        measured against this small ⋯ button would pin the menu to its floor
        regardless of what is in it. Aligned to the start, since the trigger
        sits at the left of a strip that grows rightwards.
      */}
      <DropdownMenuContent align="start" className="w-auto">
        <DropdownMenuItem variant="destructive" onSelect={() => onDelete(name)}>
          Delete view
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/**
 * The name field and its two buttons.
 *
 * A real form, so Enter submits the way Enter submits everywhere else — the
 * browser's own implicit submission, reached identically from the Save button
 * and from the keyboard.
 *
 * Blank is refused twice over, and both halves are load-bearing. Save disables
 * itself so the refusal can be seen before it is earned; the handler checks
 * again because Enter reaches a form without going past its buttons, and
 * because the store drops a blank-named row on the next read — a tab that
 * lives until the page reloads is worse than no tab at all.
 *
 * The state lives here, one component below the `Dialog`, inside the content
 * Radix unmounts on close. That is what makes an abandoned name forgettable
 * without an effect clearing it: the next open builds a new form.
 */
function SaveViewForm({
  field,
  onSubmit,
  onCancel,
}: {
  field: RefObject<HTMLInputElement | null>
  onSubmit(name: string): void
  onCancel(): void
}) {
  const id = useId()
  const [value, setValue] = useState('')
  const name = value.trim()

  return (
    <form
      className="grid gap-4"
      onSubmit={(event) => {
        event.preventDefault()
        if (name === '') return
        onSubmit(name)
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
          which is what the footer's reversed column is for. A button rather
          than a DialogClose, so that every dismissal leaves by the same line.
        */}
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={name === ''}>
          Save
        </Button>
      </DialogFooter>
    </form>
  )
}
