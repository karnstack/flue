import { describe, expect, it } from 'vitest'
import { cn } from './utils'

describe('cn', () => {
  it('joins class names', () => {
    expect(cn('a', 'b')).toBe('a b')
  })

  it('drops falsy values', () => {
    expect(cn('a', false && 'b', undefined, 'c')).toBe('a c')
  })

  it('lets a later Tailwind class win over an earlier conflicting one', () => {
    expect(cn('p-2', 'p-4')).toBe('p-4')
  })

  /*
   * What cn() has to get right about this app's one custom type token.
   *
   * `text-control` is a Tailwind v4 theme variable, which the compiler and the
   * browser both handle. tailwind-merge does not read the theme: it decides a
   * class's group from a built-in list, and `text-<anything unrecognised>` is
   * a colour to it. Unextended, that put the app's control size in the same
   * group as every control's text colour and dropped the size — leaving
   * filled buttons, cards, dialogs and popovers with no size at all,
   * inheriting the page's 16px.
   *
   * Every string below is one a real component builds, so a later change to
   * the merge config fails here rather than on somebody's screen. Nothing
   * else can catch it: jsdom applies no stylesheet, so a missing size is a
   * missing class and no other test reads the class.
   */
  describe('and the control type token', () => {
    it('keeps the size beside a control colour', () => {
      // Button, `default`. The label used to come out at the page's 16px
      // while the `outline` button beside it sat at 13px — outline names no
      // colour, so it had nothing to displace the size with.
      expect(cn('text-control font-medium', 'bg-primary text-primary-foreground')).toContain(
        'text-control',
      )
    })

    it('keeps it across a pressed state that swaps the variant', () => {
      // The view tabs: `ghost` unpressed, `secondary` pressed. Losing the size
      // on one side of that swap is a tab whose text grows when it is pressed.
      expect(cn('text-control font-medium', 'hover:bg-row-hover')).toContain('text-control')
      expect(
        cn('text-control font-medium', 'bg-secondary text-secondary-foreground'),
      ).toContain('text-control')
    })

    it('keeps it inside one class string, not only across arguments', () => {
      // Card, Dialog, Popover, HoverCard, Sheet: size and colour sit adjacent
      // in a single literal, and twMerge settles conflicts across the whole
      // joined string. A fix that only worked between arguments misses these.
      expect(cn('rounded-lg bg-card text-control text-card-foreground shadow-low')).toContain(
        'text-control',
      )
    })

    it('still lets one font-size override another, in both directions', () => {
      // The point of the group: it conflicts with sizes, and with nothing else.
      expect(cn('text-control', 'text-xs')).toBe('text-xs')
      expect(cn('text-xs', 'text-control')).toBe('text-control')
    })

    it('leaves a size behind a breakpoint alone', () => {
      // The app's mobile-first pattern — larger below sm, the control size
      // above it. A variant-prefixed utility is its own group and must live.
      expect(cn('text-base/6 sm:text-control')).toBe('text-base/6 sm:text-control')
    })

    it('still settles an ordinary colour conflict', () => {
      // The extension must not have taken text-* colours out of their group.
      expect(cn('text-zinc-500', 'text-zinc-950')).toBe('text-zinc-950')
    })
  })
})
