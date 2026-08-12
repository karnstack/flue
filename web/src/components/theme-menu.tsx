import type { CSSProperties } from 'react'
import { DropdownMenu } from 'radix-ui'
import { PaletteIcon } from 'lucide-react'

import { prefersDark } from '@/emulator/palette'
import { controlColors, resolveTheme, THEME_PRESETS, THEME_SYSTEM } from '@/emulator/themes'
import { cn } from '@/lib/utils'

/**
 * The terminal's theme picker: System plus the presets, one radio group.
 *
 * Dressed in the *current* theme's control colours, like every chip in the
 * terminal's strip — choosing Dracula turns this menu Dracula too. The menu
 * content renders in a portal, outside the pane that carries the --chip-*
 * variables, so the same values are computed here and set on both ends
 * explicitly. The swatch on each row is that preset's own background with
 * its foreground as a dot: more information than a name for a decision that
 * is entirely about looks.
 */
export function ThemeMenu({
  value,
  dark,
  onChange,
}: {
  value: string
  dark: boolean
  onChange: (id: string) => void
}) {
  const rows = [
    { id: THEME_SYSTEM, label: 'System' },
    ...THEME_PRESETS.map((p) => ({ id: p.id, label: p.label })),
  ]

  const c = controlColors(resolveTheme(value, dark))
  const chipStyle = {
    '--chip-bg': c.bg,
    '--chip-fg': c.fg,
    '--chip-dim': c.dim,
    '--chip-ring': c.ring,
    '--chip-wash': c.wash,
  } as CSSProperties

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          title="Terminal theme"
          style={chipStyle}
          className={cn(
            'inline-flex size-12 shrink-0 items-center justify-center rounded-lg sm:size-auto sm:px-2.5 sm:py-1.5',
            'bg-(--chip-bg) text-(--chip-dim) shadow-lg ring-1 ring-(--chip-ring) backdrop-blur-sm',
            'transition-colors hover:text-(--chip-fg) data-[state=open]:text-(--chip-fg)',
          )}
        >
          <PaletteIcon aria-hidden="true" className="size-4" />
          <span className="sr-only">Terminal theme</span>
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={6}
          style={chipStyle}
          className={cn(
            'z-20 min-w-44 rounded-lg p-1',
            'bg-(--chip-bg) shadow-xl ring-1 ring-(--chip-ring) backdrop-blur-sm',
          )}
        >
          <DropdownMenu.RadioGroup value={value} onValueChange={onChange}>
            {rows.map((row) => {
              const theme = resolveTheme(row.id, prefersDark())
              return (
                <DropdownMenu.RadioItem
                  key={row.id}
                  value={row.id}
                  className={cn(
                    'flex cursor-default items-center gap-x-2.5 rounded-md px-2.5 py-1.5',
                    'text-base/6 text-(--chip-fg) outline-none select-none sm:text-sm/6',
                    'data-[highlighted]:bg-(--chip-wash)',
                  )}
                >
                  <span
                    aria-hidden="true"
                    className="flex size-3.5 shrink-0 items-center justify-center rounded-full ring-1 ring-(--chip-ring)"
                    style={{ backgroundColor: theme.background }}
                  >
                    <span
                      className="size-1 rounded-full"
                      style={{ backgroundColor: theme.foreground }}
                    />
                  </span>
                  <span className="flex-1">{row.label}</span>
                  <DropdownMenu.ItemIndicator className="text-(--chip-dim)">
                    ✓
                  </DropdownMenu.ItemIndicator>
                </DropdownMenu.RadioItem>
              )
            })}
          </DropdownMenu.RadioGroup>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}
