import { useState, type ReactNode } from 'react'
import { Bars3Icon } from '@heroicons/react/16/solid'
import { Button } from '@/components/ui/button'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet'
import { Nav } from './nav'

export interface AppShellProps {
  currentPath: string
  children: ReactNode
}

/**
 * The favicon's mark, drawn in the markup so the sidebar, the tab icon and
 * the installed app icon are one image. Amber here is the mark rather than
 * an accent — theme.ts draws the same distinction for the app icon — and the
 * geometry is the favicon's own: chevron, cursor bar, 22.5 corner.
 */
function Mark() {
  return (
    <svg viewBox="0 0 100 100" aria-hidden="true" className="size-5 shrink-0">
      {/* zinc-900 in the dark theme, one step above the canvas, or the
          near-black field would dissolve into the near-black page. */}
      <rect width="100" height="100" rx="22.5" className="fill-zinc-950 dark:fill-zinc-900" />
      <path
        d="M20 26 L46 50 L20 74 M54.5 74 L80 74"
        fill="none"
        strokeWidth="10.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="stroke-amber-500"
      />
    </svg>
  )
}

/** Mono, like the landing page's wordmark: the name is something you type. */
function Wordmark() {
  return (
    <span className="flex items-center gap-x-2 px-2.5">
      <Mark />
      <span className="font-mono text-sm/6 font-semibold tracking-tight text-zinc-950 dark:text-white">
        flue
      </span>
    </span>
  )
}

/**
 * Sidebar on lg: and up, a Sheet below it. Every app needs a mobile
 * navigation affordance regardless of the desktop layout, and a
 * multi-column layout must collapse rather than shrink.
 */
export function AppShell({ currentPath, children }: AppShellProps) {
  const [open, setOpen] = useState(false)

  return (
    <div className="flex h-full flex-col lg:flex-row">
      <header className="flex items-center gap-x-3 border-b border-zinc-950/10 p-3 lg:hidden dark:border-white/10">
        <Sheet open={open} onOpenChange={setOpen}>
          <SheetTrigger asChild>
            <Button variant="ghost" size="sm" aria-label="Open navigation">
              <Bars3Icon className="size-4 shrink-0" aria-hidden="true" />
            </Button>
          </SheetTrigger>
          {/*
            The width has to be stated under the same variant the sheet
            states its own under. SheetContent ships
            `data-[side=left]:w-3/4`, and a bare `w-64` loses to it: same
            specificity, and the variant utility is emitted later.
          */}
          <SheetContent side="left" className="p-3 data-[side=left]:w-64">
            <SheetTitle>
              <Wordmark />
            </SheetTitle>
            <SheetDescription className="sr-only">
              Move between the flue management screens.
            </SheetDescription>
            <div className="mt-4">
              <Nav currentPath={currentPath} onNavigate={() => setOpen(false)} />
            </div>
          </SheetContent>
        </Sheet>
        <Wordmark />
      </header>

      <aside className="hidden w-56 shrink-0 flex-col gap-y-4 border-r border-zinc-950/10 p-3 lg:flex dark:border-white/10">
        <Wordmark />
        <Nav currentPath={currentPath} />
      </aside>

      {/*
        min-w-0 is required, not decorative: main is a flex-1 child beside a
        fixed-width sidebar, and a flex item's default min-width is auto, so
        without it a wide row or a terminal pushes the sidebar off screen
        instead of scrolling.
      */}
      <main className="min-w-0 flex-1 overflow-y-auto">{children}</main>
    </div>
  )
}
