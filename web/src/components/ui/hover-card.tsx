'use client'

import * as React from 'react'
import { HoverCard as HoverCardPrimitive } from 'radix-ui'

import { cn } from '@/lib/utils'

/*
 * A card that opens on hover and on keyboard focus, and takes neither.
 *
 * Not a Popover, and the difference is the whole reason this file exists: a
 * Popover is a dialog — it moves focus into itself when it opens and traps it
 * there. Opening one per row on hover would take the caret out of the list on
 * every pointer move, which is unusable with a keyboard and merely strange
 * with a mouse. HoverCard is the primitive for content that is *shown* rather
 * than *entered*: it is marked away as supplementary, it opens for a focused
 * trigger as well as a hovered one, and it never takes the focus.
 *
 * `openDelay` is the caller's, deliberately. A card of live terminal output
 * costs a round trip to the daemon, so the delay is not a matter of taste — it
 * is what stops a pointer crossing a list of twenty rows from asking the
 * daemon twenty questions.
 */
function HoverCard({ ...props }: React.ComponentProps<typeof HoverCardPrimitive.Root>) {
  return <HoverCardPrimitive.Root data-slot="hover-card" {...props} />
}

function HoverCardTrigger({
  ...props
}: React.ComponentProps<typeof HoverCardPrimitive.Trigger>) {
  return <HoverCardPrimitive.Trigger data-slot="hover-card-trigger" {...props} />
}

function HoverCardContent({
  className,
  align = 'start',
  sideOffset = 8,
  ...props
}: React.ComponentProps<typeof HoverCardPrimitive.Content>) {
  return (
    <HoverCardPrimitive.Portal>
      <HoverCardPrimitive.Content
        data-slot="hover-card-content"
        align={align}
        sideOffset={sideOffset}
        className={cn(
          'z-50 w-96 origin-(--radix-hover-card-content-transform-origin) overflow-hidden rounded-lg bg-popover text-control text-popover-foreground shadow-medium ring-1 ring-hairline outline-hidden duration-100 data-[side=bottom]:slide-in-from-top-1 data-[side=left]:slide-in-from-right-1 data-[side=right]:slide-in-from-left-1 data-[side=top]:slide-in-from-bottom-1 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-98 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-98',
          className,
        )}
        {...props}
      />
    </HoverCardPrimitive.Portal>
  )
}

export { HoverCard, HoverCardContent, HoverCardTrigger }
