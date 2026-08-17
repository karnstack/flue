import { useEffect, useMemo, useState, type CSSProperties } from 'react'
import { Dialog } from 'radix-ui'
import { KeyboardIcon, XIcon } from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  newTabChordLabel,
  splitChordLabel,
  tabCycleChordLabel,
} from '@/lib/split-keys'
import { cn } from '@/lib/utils'
import { isApplePlatform, openChordLabel } from '@/switcher/keys'

/**
 * Whether a keystroke asked for this card. ⌘/ on a Mac — the palette-help
 * spelling every app with a palette uses, and a Cmd chord never reaches the
 * shell. Elsewhere it is Ctrl+Shift+/, in the Ctrl+Shift namespace the
 * terminal reserves for its own chrome (#64): plain Ctrl+/ is readline's
 * undo and may not be taken. Matched on `code` first, as every chord here
 * is — Shift turns / into ? on most layouts.
 */
export function matchHelpChord(e: KeyboardEvent, apple: boolean): boolean {
  const slash = e.code === 'Slash' || e.key === '/' || e.key === '?'
  if (!slash) return false
  if (apple) return e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey
  return e.ctrlKey && e.shiftKey && !e.metaKey && !e.altKey
}

/** How the help chord is printed. */
export function helpChordLabel(apple: boolean): string {
  return apple ? '⌘/' : 'Ctrl+Shift+/'
}

interface Row {
  what: string
  keys: string
}

interface Section {
  label: string
  rows: Row[]
}

/**
 * Everything the keyboard can do here, spelled for this keyboard. A static
 * card rather than something detected: it is documentation, and a row for a
 * verb this daemon cannot serve still teaches what flue is.
 */
function sections(apple: boolean): Section[] {
  return [
    {
      label: 'Sessions',
      rows: [
        { what: 'Switch session', keys: openChordLabel(apple) },
        { what: 'Next / previous session', keys: apple ? '⌃⇧] ⌃⇧[' : 'Ctrl+Shift+] [' },
        { what: 'Pinned session 1–9', keys: apple ? '⌃⇧1–9' : 'Ctrl+Shift+1–9' },
      ],
    },
    {
      label: 'This session',
      rows: [
        { what: 'Split right', keys: splitChordLabel(apple, 'row') },
        { what: 'Split down', keys: splitChordLabel(apple, 'column') },
        { what: 'New tab', keys: newTabChordLabel(apple) },
        { what: 'Next / previous tab', keys: tabCycleChordLabel(apple) },
        { what: 'Scratch terminal', keys: apple ? '⌃ ⌃ (double-tap)' : 'Ctrl Ctrl (double-tap)' },
      ],
    },
    {
      label: 'Terminal',
      rows: [
        // The literal matches TERMINAL_SHORTCUT_HINT in terminal.tsx; spelled
        // out here because importing it would close a cycle.
        { what: 'Focus mode — every key to the shell', keys: 'Ctrl+Shift+Enter' },
        { what: 'Copy the selection', keys: apple ? '⌘C' : 'Ctrl+C (with a selection)' },
        { what: 'This card', keys: helpChordLabel(apple) },
      ],
    },
  ]
}

/**
 * The keyboard shortcuts card and the chip that opens it.
 *
 * A chip in the terminal's control strip, because the chords it teaches are
 * the terminal's — and because the pills that used to teach them are gone in
 * a hundred milliseconds on a local daemon. One instance per surface: the
 * route mounts the strip on one pane, so the chord listener here is single
 * too.
 */
export function ShortcutsHelp({
  chipStyle,
  chip = true,
}: {
  chipStyle: CSSProperties
  /**
   * Whether to draw the chip at all. False on a coarse pointer: a card of
   * keyboard chords is furniture on a phone. The chord listener stays either
   * way — an iPad grows a hardware keyboard without changing its pointer,
   * and ⌘/ should answer it.
   */
  chip?: boolean
}) {
  const apple = useMemo(() => isApplePlatform(), [])
  const [open, setOpen] = useState(false)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!matchHelpChord(e, apple)) return
      // Capture, and stopped, for the reason every chord here is: left to
      // bubble, xterm turns the keystroke into bytes first.
      e.preventDefault()
      e.stopPropagation()
      setOpen((v) => !v)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [apple])

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      {chip && (
        <Dialog.Trigger asChild>
          <button
            type="button"
            title={`Keyboard shortcuts · ${helpChordLabel(apple)}`}
            style={chipStyle}
            className={cn(
              'rounded-lg px-2.5 py-1.5',
              'bg-(--chip-bg) text-(--chip-dim) shadow-lg ring-1 ring-(--chip-ring) backdrop-blur-sm',
              'transition-colors hover:text-(--chip-fg) data-[state=open]:text-(--chip-fg)',
            )}
          >
            <KeyboardIcon aria-hidden="true" className="size-4" />
            <span className="sr-only">Keyboard shortcuts</span>
          </button>
        </Dialog.Trigger>
      )}
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/25" />
        <Dialog.Content
          aria-describedby={undefined}
          // The switcher's surface, like the scratch modal: the overlays a
          // chord can summon should read as siblings.
          className={cn(
            'fixed top-[12vh] left-1/2 z-50 w-[26rem] max-w-[calc(100vw-2rem)] -translate-x-1/2',
            'flex max-h-[76vh] flex-col overflow-hidden rounded-lg bg-popover text-popover-foreground shadow-high ring-1 ring-hairline outline-none',
          )}
        >
          <div className="flex h-11 shrink-0 items-center gap-x-2 border-b border-hairline pr-1.5 pl-3 sm:h-9">
            <KeyboardIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
            <Dialog.Title className="min-w-0 flex-1 truncate text-base font-medium text-foreground sm:text-control">
              Keyboard shortcuts
            </Dialog.Title>
            <Dialog.Close asChild>
              <Button variant="ghost" size="icon-sm" className="text-muted-foreground">
                <XIcon aria-hidden="true" />
                <span className="sr-only">Close the shortcuts card</span>
              </Button>
            </Dialog.Close>
          </div>
          <div className="overflow-y-auto overscroll-contain px-3 py-2">
            {sections(apple).map((section) => (
              <section key={section.label} className="py-2">
                <h3 className="pb-1 text-xs font-medium tracking-wide text-muted-foreground">
                  {section.label}
                </h3>
                <dl>
                  {section.rows.map((row) => (
                    <div key={row.what} className="flex items-baseline gap-x-3 py-1">
                      <dt className="min-w-0 flex-1 truncate text-base text-foreground sm:text-control">
                        {row.what}
                      </dt>
                      <dd className="shrink-0">
                        <kbd className="font-mono text-xs text-muted-foreground">{row.keys}</kbd>
                      </dd>
                    </div>
                  ))}
                </dl>
              </section>
            ))}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
