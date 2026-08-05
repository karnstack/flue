import { describe, expect, it } from 'vitest'
import { isNavItemActive, NAV_ITEMS } from './nav'

// Rendering NAV_ITEMS — links, active state, icons — is exercised through
// AppShell's tests: the items only ever appear inside the sidebar, and the
// sidebar primitives need the shell's provider around them anyway.

describe('NAV_ITEMS', () => {
  it('lists a label, a path, and an icon for every item', () => {
    expect(NAV_ITEMS.length).toBeGreaterThan(0)
    for (const item of NAV_ITEMS) {
      expect(item.to.startsWith('/')).toBe(true)
      expect(item.label.length).toBeGreaterThan(0)
      // Heroicons ship as forwardRef objects, not plain functions, so this
      // only asserts an icon is present; the shell's render tests prove it
      // actually produces an svg.
      expect(item.icon).toBeTruthy()
    }
  })
})

describe('isNavItemActive', () => {
  it('matches the item exactly', () => {
    expect(isNavItemActive('/sessions', '/sessions')).toBe(true)
  })

  it('matches a path nested under the item', () => {
    expect(isNavItemActive('/settings/keyboard', '/settings')).toBe(true)
  })

  it('does not match a sibling that merely shares a prefix', () => {
    // startsWith alone would light up Settings on /settings-export.
    expect(isNavItemActive('/settings-export', '/settings')).toBe(false)
  })

  it('does not match an unrelated path', () => {
    expect(isNavItemActive('/d/local/s/abc123', '/sessions')).toBe(false)
  })
})
