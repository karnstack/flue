import type { BarKey } from '@/lib/keys'
import { cn } from '@/lib/utils'

const KEYS: ReadonlyArray<{ key: BarKey; label: string; name: string }> = [
  { key: 'esc', label: 'esc', name: 'Escape' },
  { key: 'tab', label: 'tab', name: 'Tab' },
  { key: 'left', label: '←', name: 'Arrow left' },
  { key: 'down', label: '↓', name: 'Arrow down' },
  { key: 'up', label: '↑', name: 'Arrow up' },
  { key: 'right', label: '→', name: 'Arrow right' },
]

/**
 * The touch device's missing keys, floated over the terminal's bottom edge.
 *
 * Presses land on pointerdown, and the handler prevents the default so the
 * press never takes focus from xterm's textarea — losing it would close the
 * very keyboard the bar exists to work beside. Ctrl is latched: one press
 * arms it for the next key, bar or typed, and the Terminal owns that state
 * because the fold happens on the input path, not here.
 */
export function KeyBar(props: {
  ctrl: boolean
  onCtrl: () => void
  onKey: (key: BarKey) => void
}) {
  const chip = 'rounded-md px-2.5 py-1.5 font-mono text-sm/4 transition-colors select-none'
  return (
    <div
      data-flue-keybar=""
      className={cn(
        'absolute bottom-3 left-1/2 z-10 flex -translate-x-1/2 items-center gap-x-1',
        'rounded-lg bg-(--chip-bg) p-1 shadow-lg ring-1 ring-(--chip-ring) backdrop-blur-sm',
      )}
    >
      <button
        type="button"
        aria-pressed={props.ctrl}
        title="Ctrl, for the next key"
        onPointerDown={(e) => {
          e.preventDefault()
          props.onCtrl()
        }}
        className={cn(
          chip,
          props.ctrl
            ? 'bg-(--chip-wash) text-(--chip-fg)'
            : 'text-(--chip-dim) hover:text-(--chip-fg)',
        )}
      >
        ctrl
      </button>
      {KEYS.map((k) => (
        <button
          key={k.key}
          type="button"
          title={k.name}
          onPointerDown={(e) => {
            e.preventDefault()
            props.onKey(k.key)
          }}
          className={cn(chip, 'text-(--chip-dim) hover:text-(--chip-fg) active:bg-(--chip-wash)')}
        >
          {k.label}
          <span className="sr-only">{k.name}</span>
        </button>
      ))}
    </div>
  )
}
