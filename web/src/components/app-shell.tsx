import type { ReactNode } from 'react'
import { SidebarInset, SidebarProvider, SidebarTrigger } from '@/components/ui/sidebar'
import { AppSidebar } from './app-sidebar'
import { Wordmark } from './wordmark'

export interface AppShellProps {
  currentPath: string
  children: ReactNode
}

/**
 * Inset sidebar layout. The Sidebar primitive owns the responsive split:
 * a fixed sidebar from md up, a Sheet below it — every app needs a mobile
 * navigation affordance regardless of the desktop layout, and a multi-column
 * layout must collapse rather than shrink.
 */
export function AppShell({ currentPath, children }: AppShellProps) {
  return (
    /*
      h-svh, not the wrapper's own min-h-svh: the routes expect to scroll
      inside the shell (the old layout's main did the same), and a wrapper
      that grows with its content would instead hand scrolling to the page —
      taking the sidebar and header along with it.
    */
    <SidebarProvider className="h-svh">
      <AppSidebar currentPath={currentPath} />
      {/*
        bg-card only from md: that is where the inset margins start, and below
        them the panel is full-bleed, where the canvas is the right surface.
        Dark mode swaps the panel's elevation for an inset ring, per the
        dark-mode guidelines: elevation reads as nothing on a near-black
        gutter, a hairline does not.
      */}
      <SidebarInset className="min-w-0 md:bg-card dark:md:inset-ring dark:md:inset-ring-white/5 dark:md:shadow-none">
        {/*
          Mobile only. Below md the sheet needs an opener and the wordmark
          needs a home, and there is no header row of the route's own to fold
          them into. From md up this band held one small button over a
          screenful of nothing, so the trigger rides the PageHeader instead —
          see page-header.tsx — and the band is gone.
        */}
        <header className="flex h-14 shrink-0 items-center gap-x-1.5 px-3 md:hidden">
          <SidebarTrigger className="-ml-1.5" />
          <Wordmark />
        </header>
        {/*
          min-w-0 on the inset and min-h-0 here are required, not decorative:
          both are flex children, and a flex item's default minimum size is
          its content, so without them a wide session row pushes the sidebar
          off screen instead of scrolling.
        */}
        <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
      </SidebarInset>
    </SidebarProvider>
  )
}
