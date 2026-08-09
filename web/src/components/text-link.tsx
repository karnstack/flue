import type { ComponentProps } from 'react'

import { cn } from '@/lib/utils'

/**
 * The look of a control that lives inside a sentence.
 *
 * Not the Button component, and deliberately: every size Button has is a box
 * with a height and its own padding, and dropping one of those into the
 * middle of a paragraph pushes the line it lands on taller than the lines
 * around it. What belongs mid-sentence is text that is styled as text.
 *
 * So this is a class string rather than a variant, and there is one of it
 * because there were three: two spellings of the same idea had grown up on
 * the Cloudflare panel and the Devices header, differing in weight, in colour
 * and in how far the rule sits below the words — which is the kind of drift
 * nobody notices in one screen and everybody notices across two.
 *
 * The rule under the words is always drawn, never only on hover. In a
 * paragraph it is the entire affordance: there is no cursor change to rely on
 * before the pointer arrives, and colour alone is not something every reader
 * can use.
 */
export const TEXT_LINK =
  'font-medium text-zinc-950 underline decoration-zinc-950/30 underline-offset-2 transition-colors outline-none hover:decoration-zinc-950 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring dark:text-white dark:decoration-white/30 dark:hover:decoration-white'

/**
 * An anchor wearing it. `noreferrer` alongside `noopener` for anything that
 * leaves: this app is served from a loopback address as often as from a
 * relay, and neither is worth handing to a third party in a Referer header.
 */
export function TextLink({ className, target, rel, ...props }: ComponentProps<'a'>) {
  return (
    <a
      className={cn(TEXT_LINK, className)}
      target={target}
      rel={rel ?? (target === '_blank' ? 'noopener noreferrer' : undefined)}
      {...props}
    />
  )
}

/**
 * A button wearing it, for the ones that go nowhere — "use a different token"
 * changes what the panel is showing and has no address of its own, so it is a
 * button that reads as a destination rather than an anchor that is not one.
 */
export function TextButton({ className, ...props }: ComponentProps<'button'>) {
  return <button type="button" className={cn(TEXT_LINK, className)} {...props} />
}
