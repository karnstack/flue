import { Toaster as Sonner, type ToasterProps } from 'sonner'

/*
 * The app's notification corner.
 *
 * `unstyled`, and that is the whole configuration decision here. Sonner ships
 * its look as a stylesheet it injects into the head at runtime, which lands
 * unlayered — and unlayered CSS outranks every layered rule regardless of
 * specificity, so a Tailwind utility could not have overridden a single one of
 * its colours. (styles.css opens with the same problem in the same words,
 * about xterm's stylesheet.) Turning its own styling off and naming every
 * class here is not a preference; it is the only way the toast wears this
 * app's tokens rather than sonner's defaults.
 *
 * Bottom right, and lifted clear of the credit line in the same corner — see
 * credit.tsx. Below md that line is not drawn and the offset comes back down.
 */
export function Toaster(props: ToasterProps) {
  return (
    <Sonner
      theme="system"
      position="bottom-right"
      offset={{ bottom: '2.5rem', right: '1rem' }}
      mobileOffset={{ bottom: '1rem', right: '1rem', left: '1rem' }}
      toastOptions={{
        unstyled: true,
        classNames: {
          toast:
            'flex w-full items-start gap-x-3 rounded-lg bg-popover p-3 text-control text-popover-foreground shadow-high ring-1 ring-hairline',
          content: 'flex min-w-0 flex-col gap-y-0.5',
          title: 'font-medium text-zinc-950 dark:text-white',
          description: 'text-xs/5 text-pretty text-zinc-600 dark:text-zinc-400',
          actionButton:
            'ml-auto inline-flex h-7 shrink-0 cursor-pointer items-center rounded-md bg-primary px-2.5 font-medium text-control text-primary-foreground shadow-lip transition-colors outline-none hover:bg-[color-mix(in_oklch,var(--primary),white_10%)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
          cancelButton:
            'inline-flex h-7 shrink-0 cursor-pointer items-center rounded-md px-2 font-medium text-control text-zinc-600 transition-colors outline-none hover:bg-row-hover hover:text-zinc-950 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring dark:text-zinc-400 dark:hover:text-white',
        },
      }}
      {...props}
    />
  )
}
