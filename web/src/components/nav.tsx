import type { ComponentType } from 'react'
import { Link } from '@tanstack/react-router'
import { Cog6ToothIcon, CommandLineIcon, DevicePhoneMobileIcon } from '@heroicons/react/16/solid'
import { cn } from '@/lib/utils'

export const NAV_ITEMS = [
  { to: '/sessions', label: 'Sessions', icon: CommandLineIcon },
  { to: '/devices', label: 'Devices', icon: DevicePhoneMobileIcon },
  { to: '/settings', label: 'Settings', icon: Cog6ToothIcon },
] as const satisfies ReadonlyArray<{
  to: string
  label: string
  icon: ComponentType<{ className?: string }>
}>

/**
 * Whether `to` is the nav item that owns `currentPath`.
 *
 * Exact match, or a path nested under it — `/settings/keyboard` belongs to
 * Settings. A bare `startsWith` would also light Settings up on
 * `/settings-export`, so the boundary is part of the test.
 */
export function isNavItemActive(currentPath: string, to: string): boolean {
  return currentPath === to || currentPath.startsWith(`${to}/`)
}

export interface NavProps {
  currentPath: string
  /** Called after a link is activated, so the mobile sheet can close itself. */
  onNavigate?: () => void
}

export function Nav({ currentPath, onNavigate }: NavProps) {
  return (
    <nav className="flex flex-col gap-y-1">
      <ul role="list" className="flex flex-col gap-y-1">
        {NAV_ITEMS.map((item) => {
          const active = isNavItemActive(currentPath, item.to)
          const Icon = item.icon
          return (
            <li key={item.to}>
              {/*
                TanStack Link, never a plain anchor: a full page reload on
                every nav click would tear down the WebSocket and remount
                the app, which defeats the point of the SPA.
              */}
              <Link
                to={item.to}
                aria-current={active ? 'page' : undefined}
                onClick={onNavigate}
                className={cn(
                  // Font weight is identical in every state. Only color and
                  // background change, per the navigation guidelines.
                  'flex items-center gap-x-2.5 rounded-md px-2.5 py-2 text-base/6 font-medium sm:py-1.5 sm:text-sm/6',
                  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-500',
                  active
                    ? // Muted background plus accent text, never a
                      // high-contrast fill.
                      'bg-amber-500/10 text-amber-700 dark:text-amber-400'
                    : 'text-zinc-600 hover:bg-zinc-950/5 hover:text-zinc-950 dark:text-zinc-400 dark:hover:bg-white/5 dark:hover:text-white',
                )}
              >
                <Icon className="size-4 shrink-0" aria-hidden="true" />
                {item.label}
              </Link>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}
