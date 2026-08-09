import { Check, Copy } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import { cn } from '@/lib/utils'

/**
 * The install line. It is selectable text first and a button second: with JS
 * off or still loading, the command is right there to highlight and copy by
 * hand, which is how a shell command should behave.
 */
export function CopyCommand({ command, className }: { command: string; className?: string }) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => () => clearTimeout(timer.current), [])

  const copy = () => {
    navigator.clipboard.writeText(command).then(() => {
      setCopied(true)
      clearTimeout(timer.current)
      timer.current = setTimeout(() => setCopied(false), 1600)
    })
  }

  return (
    <div
      className={cn(
        'flex items-center gap-3 rounded-lg border border-border bg-card py-2 pr-2 pl-3 sm:pl-4',
        className,
      )}
    >
      <span aria-hidden="true" className="font-mono text-base text-primary sm:text-sm">
        $
      </span>
      <code className="min-w-0 flex-1 overflow-x-auto font-mono text-base whitespace-nowrap sm:text-sm">
        {command}
      </code>
      <Button copied={copied} onCopy={copy} />
    </div>
  )
}

function Button({ copied, onCopy }: { copied: boolean; onCopy: () => void }) {
  return (
    <button
      type="button"
      onClick={onCopy}
      aria-label={copied ? 'Copied' : 'Copy install command'}
      className="relative inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
    >
      <span
        aria-hidden="true"
        className="pointer-fine:hidden absolute top-1/2 left-1/2 size-[max(100%,3rem)] -translate-1/2"
      />
      {copied ? (
        <Check className="size-4 text-primary" aria-hidden="true" />
      ) : (
        <Copy className="size-4" aria-hidden="true" />
      )}
    </button>
  )
}
