import { DropdownMenu } from 'radix-ui'
import { PaletteIcon } from 'lucide-react'

import { prefersDark } from '@/emulator/palette'
import { resolveTheme, THEME_PRESETS, THEME_SYSTEM } from '@/emulator/themes'
import { cn } from '@/lib/utils'

/**
 * The terminal's theme picker: System plus the presets, one radio group.
 *
 * Styled like the terminal's other floating controls — dark in both app
 * themes, translucent over the canvas — because it lives in the same
 * top-right cluster. The swatch on each row is the preset's own background
 * with its foreground as a dot, which is more information than a name for
 * a decision that is entirely about looks.
 */
export function ThemeMenu({
  value,
  onChange,
}: {
  value: string
  onChange: (id: string) => void
}) {
  const rows = [
    { id: THEME_SYSTEM, label: 'System' },
    ...THEME_PRESETS.map((p) => ({ id: p.id, label: p.label })),
  ]

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          title="Terminal theme"
          className={cn(
            'rounded-lg px-2.5 py-1.5',
            'bg-zinc-950/80 text-zinc-400 shadow-lg ring-1 ring-white/10 backdrop-blur-sm',
            'transition-colors hover:text-zinc-100 data-[state=open]:text-zinc-100',
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
          className={cn(
            'z-20 min-w-44 rounded-lg p-1',
            'bg-zinc-950/90 shadow-xl ring-1 ring-white/10 backdrop-blur-sm',
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
                    'text-base/6 text-zinc-200 outline-none select-none sm:text-sm/6',
                    'data-[highlighted]:bg-white/10',
                  )}
                >
                  <span
                    aria-hidden="true"
                    className="flex size-3.5 shrink-0 items-center justify-center rounded-full ring-1 ring-white/20"
                    style={{ backgroundColor: theme.background }}
                  >
                    <span
                      className="size-1 rounded-full"
                      style={{ backgroundColor: theme.foreground }}
                    />
                  </span>
                  <span className="flex-1">{row.label}</span>
                  <DropdownMenu.ItemIndicator className="text-zinc-400">
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
