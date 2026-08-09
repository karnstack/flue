import { useEffect, useReducer } from 'react'

import { cn } from '@/lib/utils'

export type Line =
  | { kind: 'prompt'; text: string }
  | { kind: 'output'; text: string }
  | { kind: 'ok'; text: string }

export const prompt = (text: string): Line => ({ kind: 'prompt', text })
export const output = (text: string): Line => ({ kind: 'output', text })
export const ok = (text: string): Line => ({ kind: 'ok', text })

/** How long a prompt line takes to "type", per character. */
const CHAR_MS = 34
/** The beat between a command finishing and its output appearing. */
const OUTPUT_MS = 260

function cost(line: Line): number {
  return line.kind === 'prompt' ? line.text.length * CHAR_MS : OUTPUT_MS
}

/**
 * A terminal that types itself out and then holds.
 *
 * The whole transcript is in the DOM from the first render — lines that have
 * not been reached yet are `invisible`, not absent — so the panel never
 * changes height, the layout never reflows, and a reader with reduced motion
 * or no JS sees the finished transcript rather than an empty box.
 */
export function MockTerminal({
  lines,
  title,
  startDelay = 300,
  className,
  bodyClassName,
}: {
  lines: Line[]
  title?: string
  startDelay?: number
  className?: string
  bodyClassName?: string
}) {
  const [shown, advance] = useReducer((n: number) => n + 1, 0)

  useEffect(() => {
    if (shown >= lines.length) return
    const delay = shown === 0 ? startDelay : cost(lines[shown - 1]!)
    const t = setTimeout(advance, delay)
    return () => clearTimeout(t)
  }, [shown, lines, startDelay])

  return (
    <div
      className={cn(
        'overflow-hidden rounded-xl bg-zinc-950 ring-1 ring-zinc-950/10 dark:ring-white/10',
        className,
      )}
    >
      {title && (
        <div className="flex items-center gap-2 border-b border-white/8 px-3 py-2">
          <span className="flex gap-1.5" aria-hidden="true">
            <span className="size-2.5 rounded-full bg-white/15" />
            <span className="size-2.5 rounded-full bg-white/15" />
            <span className="size-2.5 rounded-full bg-white/15" />
          </span>
          <p className="flex-1 truncate text-center font-mono text-xs text-zinc-500">{title}</p>
          <span className="w-11 shrink-0" aria-hidden="true" />
        </div>
      )}
      <div className={cn('overflow-x-auto p-4 font-mono text-sm/6 text-zinc-300', bodyClassName)}>
        {lines.map((line, i) => (
          <p
            // The transcript is a fixed literal; index is its identity.
            key={i}
            className={cn(
              'whitespace-pre motion-safe:transition-opacity',
              i < shown ? 'opacity-100' : 'opacity-0 motion-reduce:opacity-100',
            )}
          >
            {line.kind === 'prompt' && (
              <>
                <span className="text-teal-400">$ </span>
                {line.text}
              </>
            )}
            {line.kind === 'ok' && (
              <>
                <span className="text-teal-400">{'  ✓ '}</span>
                {line.text}
              </>
            )}
            {line.kind === 'output' && <span className="text-zinc-500">{line.text}</span>}
          </p>
        ))}
        <p className="whitespace-pre">
          <span className="text-teal-400">$ </span>
          <span className="term-cursor bg-teal-400 text-teal-400" aria-hidden="true" />
        </p>
      </div>
    </div>
  )
}
