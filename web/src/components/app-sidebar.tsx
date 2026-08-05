import type { ComponentProps } from 'react'
import { Link } from '@tanstack/react-router'
import { cn } from '@/lib/utils'
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from '@/components/ui/sidebar'
import { isNavItemActive, NAV_ITEMS } from './nav'
import { Wordmark } from './wordmark'

export interface AppSidebarProps extends ComponentProps<typeof Sidebar> {
  currentPath: string
}

/**
 * The app's one sidebar: inset variant, so the content sits as a panel on the
 * sidebar's surface instead of splitting the page with a full-height border.
 * Below md the Sidebar primitive renders itself inside a Sheet, which is why
 * this component has no mobile branch of its own.
 */
export function AppSidebar({ currentPath, ...props }: AppSidebarProps) {
  // Unconditional on purpose: on desktop there is no sheet and the primitive
  // ignores setOpenMobile, so one call covers both layouts.
  const { setOpenMobile } = useSidebar()

  return (
    <Sidebar variant="inset" {...props}>
      <SidebarHeader>
        <Wordmark className="px-2 py-1.5" />
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          {/*
            The primitives are all divs and uls; the nav landmark and the
            explicit list role are this app's own, and router.test.tsx keys
            on the landmark to prove the terminal route has no chrome.
          */}
          <SidebarGroupContent>
            <nav>
              <SidebarMenu role="list" className="gap-1">
              {NAV_ITEMS.map((item) => {
                const active = isNavItemActive(currentPath, item.to)
                const Icon = item.icon
                return (
                  <SidebarMenuItem key={item.to}>
                    {/*
                      Active styling rides on `active` rather than the
                      button's isActive prop: the prop's data-active classes
                      (zinc surface, a font-medium step) fight the amber
                      treatment and the equal-weight rule at the same variant
                      level, where which one wins is a question of emission
                      order. Plain classes through cn() let tailwind-merge
                      settle it deterministically.
                    */}
                    <SidebarMenuButton
                      asChild
                      className={cn(
                        // Font weight is identical in every state. Only color
                        // and background change, per the navigation
                        // guidelines. Text is larger below sm, like every
                        // touch target in the app.
                        'h-9 gap-x-2.5 font-medium text-base/6 sm:h-8 sm:text-sm/6',
                        active &&
                          // Muted background plus accent text, never a
                          // high-contrast fill — and pinned across hover and
                          // press so the current page cannot look momentarily
                          // deselected.
                          'bg-amber-500/10 text-amber-700 hover:bg-amber-500/10 hover:text-amber-700 active:bg-amber-500/10 active:text-amber-700 dark:text-amber-400 dark:hover:text-amber-400 dark:active:text-amber-400',
                      )}
                    >
                      {/*
                        TanStack Link, never a plain anchor: a full page
                        reload on every nav click would tear down the
                        WebSocket and remount the app, which defeats the
                        point of the SPA.
                      */}
                      <Link
                        to={item.to}
                        aria-current={active ? 'page' : undefined}
                        onClick={() => setOpenMobile(false)}
                      >
                        <Icon className="size-4 shrink-0" aria-hidden="true" />
                        <span>{item.label}</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                )
              })}
              </SidebarMenu>
            </nav>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
    </Sidebar>
  )
}
