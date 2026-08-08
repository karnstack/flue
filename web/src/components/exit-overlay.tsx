import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

/**
 * The card shown over a session whose shell has exited.
 *
 * The wrapper is pointer-transparent on purpose: the dimmed scrollback under
 * it stays scrollable and selectable, and only the card itself takes events.
 * Dressed in the --chip-* variables the pane above it carries, so the card
 * wears the terminal's own theme like every other floating control.
 */
export function ExitOverlay({
  code,
  onRestart,
  onClose,
}: {
  code: number
  onRestart: () => void
  onClose: () => void
}) {
  return (
    <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
      <div
        role="alertdialog"
        aria-label={`shell exited (${code})`}
        className={cn(
          'pointer-events-auto flex flex-col items-center gap-y-4 rounded-lg px-8 py-6',
          'bg-(--chip-bg) text-(--chip-fg) shadow-xl ring-1 ring-(--chip-ring) backdrop-blur-sm',
        )}
      >
        <p className="text-sm/6 font-medium">
          shell exited{' '}
          <span className={code === 0 ? 'text-(--chip-dim)' : 'text-red-400'}>({code})</span>
        </p>
        <div className="flex items-center gap-x-3">
          <Button size="sm" onClick={onRestart}>
            Restart
          </Button>
          <Button size="sm" variant="outline" onClick={onClose}>
            Close
          </Button>
        </div>
      </div>
    </div>
  )
}
