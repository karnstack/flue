import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { Slot } from "radix-ui"

import { cn } from "@/lib/utils"

/*
 * The app's one button.
 *
 * It began as stock shadcn and read like it: 14px labels, 10px corners, a 3px
 * translucent halo on focus, and a one-pixel drop on press. Those are fine
 * defaults for a marketing page and wrong for this app, which is a dense list
 * of small controls that has to look precise at 28 pixels tall. What follows
 * is that same component with four decisions changed, each of which shows up
 * on every screen:
 *
 *   Type. 13px (`text-control`), set once as a token so a menu item and a
 *   button beside it cannot disagree. At 14px the label was the loudest thing
 *   in a toolbar of short verbs.
 *
 *   Corners. `rounded-md` — 6px off the 8px --radius, rather than the 10px a
 *   stock `rounded-lg` gave. On a 28px control a 10px corner is more than a
 *   third of the height, which is a pill pretending to be a button.
 *
 *   Focus. An outline with an offset, not a ring. A 3px translucent ring at
 *   50% alpha reads as a glow and, on the split button and the button groups,
 *   bled into the control next door. `outline-offset-2` puts a clean gap
 *   between the control and its indicator, which stays legible against both
 *   the canvas and the sidebar's own surface.
 *
 *   Press. No `translate-y`. Nudging a control down moves the label the user
 *   is reading, and does it on every one of the twenty in a toolbar; the
 *   feedback belongs in the surface instead, so each variant darkens under
 *   the pointer with `active:`.
 *
 * The filled variant additionally carries `shadow-lip`, an inset highlight
 * along its top edge. It is the difference between a solid teal rectangle and
 * something that looks like it could be pressed, and it is the one piece of
 * ornament in the whole system.
 */
const buttonVariants = cva(
  "group/button inline-flex shrink-0 items-center justify-center rounded-md border border-transparent bg-clip-padding text-control font-medium whitespace-nowrap transition-[background-color,border-color,color,box-shadow,opacity] duration-100 outline-none select-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:outline-2 aria-invalid:outline-offset-2 aria-invalid:outline-destructive/60 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        // color-mix rather than an alpha step: `bg-primary/80` thins the fill
        // toward whatever is behind it, so the same hover read teal-on-white
        // in one theme and teal-on-near-black in the other. Mixing toward a
        // fixed white/black keeps the hover a lightening in both.
        default:
          "bg-primary text-primary-foreground shadow-lip hover:bg-[color-mix(in_oklch,var(--primary),white_10%)] active:bg-[color-mix(in_oklch,var(--primary),black_6%)] dark:hover:bg-[color-mix(in_oklch,var(--primary),white_8%)]",
        outline:
          "border-border bg-background shadow-low hover:bg-row-hover active:bg-row-press aria-expanded:bg-row-press dark:border-input dark:bg-input/20 dark:hover:bg-input/40",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-[color-mix(in_oklch,var(--secondary),var(--foreground)_6%)] active:bg-[color-mix(in_oklch,var(--secondary),var(--foreground)_10%)] aria-expanded:bg-[color-mix(in_oklch,var(--secondary),var(--foreground)_10%)]",
        ghost:
          "hover:bg-row-hover hover:text-foreground active:bg-row-press aria-expanded:bg-row-press aria-expanded:text-foreground",
        destructive:
          "bg-destructive/10 text-destructive hover:bg-destructive/18 active:bg-destructive/25 focus-visible:outline-destructive/60",
        // Upstream is `text-primary`, but --primary is teal here and teal
        // is never body text: teal-500 on the light canvas is 2.13:1, under
        // even the 3:1 non-text floor. The underline carries the affordance.
        link: "text-foreground underline-offset-4 hover:underline",
      },
      size: {
        default:
          "h-8 gap-1.5 px-2.5 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2",
        xs: "h-6 gap-1 rounded-sm px-1.5 text-xs in-data-[slot=button-group]:rounded-md has-data-[icon=inline-end]:pr-1 has-data-[icon=inline-start]:pl-1 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-7 gap-1 px-2 in-data-[slot=button-group]:rounded-md has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3.5",
        lg: "h-9 gap-1.5 px-3 text-sm has-data-[icon=inline-end]:pr-2.5 has-data-[icon=inline-start]:pl-2.5",
        icon: "size-8",
        "icon-xs":
          "size-6 rounded-sm in-data-[slot=button-group]:rounded-md [&_svg:not([class*='size-'])]:size-3",
        "icon-sm":
          "size-7 in-data-[slot=button-group]:rounded-md [&_svg:not([class*='size-'])]:size-3.5",
        "icon-lg": "size-9",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) {
  const Comp = asChild ? Slot.Root : "button"

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
