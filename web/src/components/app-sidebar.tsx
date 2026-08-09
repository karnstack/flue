import type { ComponentProps } from 'react'
import { Link } from '@tanstack/react-router'
import { ChatBubbleLeftRightIcon } from '@heroicons/react/16/solid'
import { ISSUES_URL, REPO_URL } from '@/lib/links'
import { cn } from '@/lib/utils'
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from '@/components/ui/sidebar'
import { isNavItemActive, NAV_ITEMS } from './nav'
import { UpdateNotice } from './update-notice'
import { GithubMark, Wordmark } from './wordmark'

/**
 * The two places outside the app a reader might want to go, and the only
 * reason the sidebar has a footer.
 *
 * Both leave the SPA, so both are plain anchors and neither is a router Link
 * — and both are quieter than the nav above them: they are not screens, they
 * never carry the current-page treatment, and a reader scanning the sidebar
 * for where they are should not have to read past them.
 */
const OUTBOUND = [
  { href: ISSUES_URL, label: 'Feedback', icon: ChatBubbleLeftRightIcon },
  { href: REPO_URL, label: 'GitHub', icon: GithubMark },
] as const

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

            Named, because it is not the only navigation on the page: every
            management screen carries its own header's Breadcrumb landmark,
            and two nav elements a rotor lists as just "navigation" twice
            leave the reader picking one by luck.
          */}
          <SidebarGroupContent>
            <nav aria-label="Main">
              <SidebarMenu role="list" className="gap-1">
              {NAV_ITEMS.map((item) => {
                const active = isNavItemActive(currentPath, item.to)
                const Icon = item.icon
                return (
                  <SidebarMenuItem key={item.to}>
                    {/*
                      Active styling rides on `active` rather than the
                      button's isActive prop: the prop's data-active classes
                      (zinc surface, a font-medium step) fight the teal
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
                          'bg-teal-500/10 text-teal-700 hover:bg-teal-500/10 hover:text-teal-700 active:bg-teal-500/10 active:text-teal-700 dark:text-teal-400 dark:hover:text-teal-400 dark:active:text-teal-400',
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
      {/*
        Pinned to the bottom by the primitive, not by the list above it: the
        nav is short enough that the sidebar's empty middle would otherwise
        leave these two sitting directly under Settings, reading as two more
        screens the app has.
      */}
      <SidebarFooter>
        <UpdateNotice />
        <nav aria-label="Project">
          <SidebarMenu role="list" className="gap-0.5">
            {OUTBOUND.map(({ href, label, icon: Icon }) => (
              <SidebarMenuItem key={href}>
                <SidebarMenuButton
                  asChild
                  className="h-8 gap-x-2.5 font-medium text-sm/6 text-zinc-500 hover:text-zinc-950 sm:h-7 sm:text-control dark:text-zinc-400 dark:hover:text-white"
                >
                  {/*
                    `noreferrer` alongside `noopener` deliberately: this app is
                    served from a machine's own loopback address as often as
                    from a relay, and neither is an address worth handing to
                    GitHub in a Referer header.
                  */}
                  <a href={href} target="_blank" rel="noopener noreferrer">
                    <Icon className="size-4 shrink-0" aria-hidden="true" />
                    <span>{label}</span>
                  </a>
                </SidebarMenuButton>
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
        </nav>
      </SidebarFooter>
    </Sidebar>
  )
}
