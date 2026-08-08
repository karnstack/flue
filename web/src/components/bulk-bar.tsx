import { XMarkIcon } from '@heroicons/react/16/solid'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Separator } from '@/components/ui/separator'
import { cn } from '@/lib/utils'

export interface BulkBarProps {
  /** How many rows are checked. 0 is not a state this bar has. */
  count: number
  /**
   * Whether any checked session still has a live process. False means every
   * one of them has already exited, which is the only reason the confirm is
   * allowed to soften — the copy makes a claim about what closing costs, and
   * that claim is read straight off this flag.
   */
  anyRunning: boolean
  onTag(): void
  onPin(): void
  /** Fired once, and only from the confirm. Never from the bar's own button. */
  onClose(): void
  /** Drop the selection without doing anything to it. */
  onClear(): void
  /**
   * Merged last onto the bar itself, so a caller's utility beats the one
   * written here.
   *
   * This exists for one reason and it is not decoration. The bar is pinned to
   * the window, and from md up the sidebar takes `--sidebar-width` off the
   * left of the content — which the window knows nothing about. Centred on the
   * window, the bar reads left of the list it acts on at every desktop width,
   * and in the band just past the md breakpoint its left edge slides under the
   * sidebar, where it would win on stacking order. Nothing outside can correct
   * a pinned element it cannot reach, so the correction arrives here:
   * `md:left-(--sidebar-width)` from the route moves the bar's own left edge
   * past the sidebar, and only while the sidebar is expanded — the route reads
   * that from useSidebar, since no peer selector can reach in here.
   */
  className?: string
}

/**
 * The bar that appears along the bottom edge once rows are checked.
 *
 * It owns no selection and no session — every button is a report to the
 * caller — with one exception, and the exception is the point of the
 * component. Close asks first, and the asking lives here rather than in the
 * route, because a confirm that names the count has to be rendered by
 * something that knows the count. The route would otherwise carry a second
 * piece of dialog state whose only job is to re-derive a number it already
 * handed down.
 *
 * `onClose` fires from the confirm's own button and from nowhere else. Escape,
 * the overlay, the corner X and Cancel all leave the selection exactly as it
 * was — they do not even clear it, because a reader who backed out of closing
 * three sessions still has three sessions in mind. Confirming does not clear
 * it either: the caller closes what was selected and drops the selection in
 * the same breath, and a clear from in here would be this bar holding a second
 * opinion about state it does not own.
 *
 * No hooks, deliberately. The dialog keeps its own open state inside Radix, so
 * the early return at 0 cannot become a hook-order bug later, and a selection
 * emptied while the confirm is up takes the question away with it — which is
 * right: the sessions it named are no longer the ones in hand.
 */
export function BulkBar({
  count,
  anyRunning,
  onTag,
  onPin,
  onClose,
  onClear,
  className,
}: BulkBarProps) {
  if (count <= 0) return null

  // One noun, agreed with the count, and used everywhere the count is spoken.
  const sessions = count === 1 ? 'session' : 'sessions'

  return (
    /*
      Held against the bottom edge of the window rather than the end of the
      list: the rows it acts on are scrolled through while it is up, and a bar
      that scrolled away with them would make the reader chase the button for
      the thing they had just checked.

      Centred with `mx-auto` between two pinned edges rather than by shifting
      it back half its own width: the text lands on whole pixels either way,
      and this leaves no stacking context behind for a later change to trip
      over. Centred on the *window*, though — the sidebar's width is not in
      that sum, which is what `className` is for; see the prop.

      The surface is the app-shell's: a panel over the canvas, elevated
      in light, and in dark a hairline instead, since elevation says nothing
      there. The hairline is 10% rather than the shell's 5% because this
      floats over the list's own rows, where a 5% edge would go missing
      against them.
    */
    <div
      role="toolbar"
      aria-label="Bulk actions"
      className={cn(
        'fixed inset-x-0 bottom-4 z-30 mx-auto flex w-fit items-center gap-x-1 rounded-xl bg-card p-1.5 shadow-lg ring-1 ring-zinc-950/10 dark:inset-ring dark:inset-ring-white/10 dark:ring-0',
        className,
      )}
    >
      {/*
        Announced, because the checkboxes this counts are somewhere else
        entirely: a reader working down the rows by keyboard never brings the
        count into focus, and a number that only changed on screen would
        change in silence. Polite, since it is a running total and not news —
        it must not interrupt the row being read out.
      */}
      <span aria-live="polite" className="px-2 text-sm text-muted-foreground tabular-nums">
        {`${count} selected`}
      </span>
      <Separator orientation="vertical" className="mx-1 h-5" />

      <Button variant="ghost" size="sm" onClick={onTag}>
        Tag
      </Button>
      <Button variant="ghost" size="sm" onClick={onPin}>
        Pin
      </Button>

      {/*
        Uncontrolled: the trigger opens it, both footer buttons close it, and
        the answer travels on the confirming button's own click. Nothing else
        in the component needs to know whether the question is on screen.
      */}
      <Dialog>
        <DialogTrigger asChild>
          <Button variant="destructive" size="sm">
            Close
          </Button>
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{`Close ${count} ${sessions}?`}</DialogTitle>
            {/*
              The description is what changes with `anyRunning`, and it is the
              whole of the difference. A running session is killed by this and
              the reader is owed that sentence; an exited one is already gone,
              and repeating the warning over a list of corpses would teach the
              reader to click through the warning that matters.
            */}
            <DialogDescription>
              {anyRunning
                ? 'Running processes will be killed.'
                : count === 1
                  ? 'It has already exited.'
                  : 'They have already exited.'}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            {/*
              Cancel first in the markup and last to the eye on a narrow
              screen, which is what the footer's reversed column is for.

              The confirming button says the noun rather than repeating the
              bare word Close: the corner X is already named "Close" to a
              screen reader, and two controls by that name in one dialog —
              one of which dismisses and one of which kills — is the worst
              possible pair to have to tell apart by position.
            */}
            <DialogClose asChild>
              <Button variant="outline">Cancel</Button>
            </DialogClose>
            <DialogClose asChild>
              <Button variant="destructive" onClick={onClose}>
                {`Close ${sessions}`}
              </Button>
            </DialogClose>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Separator orientation="vertical" className="mx-1 h-5" />
      {/*
        Named, because an X is not a word. It sits past a separator from the
        three actions on purpose: it is the way out of this bar, not a fourth
        thing to do to the sessions.
      */}
      <Button variant="ghost" size="icon-sm" aria-label="Clear selection" onClick={onClear}>
        <XMarkIcon aria-hidden="true" />
      </Button>
    </div>
  )
}
