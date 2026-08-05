import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

/**
 * The card shown over a session whose shell has exited.
 *
 * The wrapper is pointer-transparent on purpose: the dimmed scrollback under
 * it stays scrollable and selectable, and only the card itself takes events.
 * Dark in both themes, like the status pill — it floats over the terminal's
 * canvas, not the app's.
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
          'pointer-events-auto flex flex-col items-center gap-y-4 rounded-xl px-8 py-6',
          'bg-zinc-950/85 text-zinc-100 shadow-xl ring-1 ring-white/10 backdrop-blur-sm',
        )}
      >
        <p className="text-sm/6 font-medium">
          shell exited{' '}
          <span className={code === 0 ? 'text-zinc-400' : 'text-red-400'}>({code})</span>
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
