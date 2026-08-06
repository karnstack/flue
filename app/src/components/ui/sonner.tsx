// shadcn's Sonner wrapper, with one deliberate edit.
//
// What `shadcn add sonner` generates reads the active theme from `next-themes`
// and passes it down, which is why the generator also installs that package.
// This app has no theme *state* to read: styles.css ships both palettes and
// selects between them with `prefers-color-scheme` alone — there is no toggle,
// no provider, and deliberately no `.dark` class (see the note in styles.css).
// A `useTheme()` here would therefore return the provider's default forever,
// pinning every toast to one palette on a page whose surroundings follow the
// system. Sonner's own `theme="system"` does the same media query the
// stylesheet does, so the two agree without a provider — and `next-themes` was
// removed from package.json rather than left as a dependency nothing imports.
import {
  CircleCheckIcon,
  InfoIcon,
  Loader2Icon,
  OctagonXIcon,
  TriangleAlertIcon,
} from 'lucide-react'
import { Toaster as Sonner, type ToasterProps } from 'sonner'

const Toaster = ({ ...props }: ToasterProps) => {
  return (
    <Sonner
      theme="system"
      className="toaster group"
      icons={{
        success: <CircleCheckIcon className="size-4" />,
        info: <InfoIcon className="size-4" />,
        warning: <TriangleAlertIcon className="size-4" />,
        error: <OctagonXIcon className="size-4" />,
        loading: <Loader2Icon className="size-4 animate-spin" />,
      }}
      style={
        {
          '--normal-bg': 'var(--popover)',
          '--normal-text': 'var(--popover-foreground)',
          '--normal-border': 'var(--border)',
          '--border-radius': 'var(--radius)',
        } as React.CSSProperties
      }
      toastOptions={{ classNames: { toast: 'cn-toast' } }}
      {...props}
    />
  )
}

export { Toaster }
