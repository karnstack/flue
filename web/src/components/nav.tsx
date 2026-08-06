import type { ComponentType } from 'react'
import {
  Cog6ToothIcon,
  CommandLineIcon,
  DevicePhoneMobileIcon,
  GlobeAltIcon,
} from '@heroicons/react/16/solid'

export const NAV_ITEMS = [
  { to: '/sessions', label: 'Sessions', icon: CommandLineIcon },
  { to: '/devices', label: 'Devices', icon: DevicePhoneMobileIcon },
  // Beneath Devices because it is the answer to the question Devices raises:
  // pairing is gated shut until this machine has an address a second device
  // could reach, and this is the screen that says how it gets one.
  { to: '/remote', label: 'Remote access', icon: GlobeAltIcon },
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
