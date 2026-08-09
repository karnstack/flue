import { clsx, type ClassValue } from "clsx"
import { extendTailwindMerge } from "tailwind-merge"

/*
 * tailwind-merge, taught the one type token this app added.
 *
 * `--text-control` (0.8125rem, styles.css) is the type size every control in
 * the app is set in — buttons, menu items, dialogs, popovers, cards. It is a
 * Tailwind v4 theme variable, so `text-control` is a real font-size utility
 * that the compiler emits correctly and the browser applies correctly.
 *
 * tailwind-merge cannot see the theme. It reads a class name and decides which
 * group it belongs to from a built-in list, and its rule for `text-*` is: a
 * known scale step (`xs`, `sm`, `base`, …) or an arbitrary length is a
 * font-size, and anything else is a colour. `control` is on no such list, so
 * every `cn()` in the app was filing it beside `text-primary-foreground` and
 * `text-card-foreground` — one group — and dropping whichever came first.
 *
 * Which was the size, always, because the base string names the size and the
 * variant names the colour. So:
 *
 *   Button `default` and `secondary` shipped with no font-size at all and
 *   inherited the page's 16px, while `outline` and `ghost` — the two variants
 *   with no colour of their own — kept 13px. That is a filled button whose
 *   label is three pixels larger than the bordered one beside it, and a view
 *   tab whose text visibly *grows* when pressed, because pressing it swaps
 *   `ghost` for `secondary`.
 *
 *   Card, Dialog, Popover, HoverCard, Sheet, Select and the destructive menu
 *   item lost it the same way, out of a single class string — twMerge settles
 *   conflicts across the whole joined string, not only across arguments.
 *
 * None of it could fail a test as things stood: jsdom applies no stylesheet,
 * so the class that went missing was missing from the markup and nothing
 * measured the markup. utils.test.ts measures it now.
 */
const twMerge = extendTailwindMerge({
  extend: { classGroups: { "font-size": ["text-control"] } },
})

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
