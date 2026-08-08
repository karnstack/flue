import { useEffect, useRef, useState } from 'react'
import { MagnifyingGlassIcon } from '@heroicons/react/16/solid'

import { Input } from '@/components/ui/input'

/**
 * How long the field waits after the last keystroke before it says anything.
 *
 * Short enough that nobody waits for it — 150ms is under the threshold where a
 * response reads as a delay — and long enough to swallow a whole word typed at
 * speed. What it is protecting is not arithmetic: `filterSessions` over a
 * fleet's worth of rows costs nothing. It is the screen. Reporting on every
 * keystroke re-cuts the groups five times for `flue`, and the reader watches
 * headings appear and vanish under their own typing.
 */
const SETTLE_MS = 150

export interface SessionSearchProps {
  /** The search the sessions list is showing now. */
  value: string
  /** Called once the typing has stopped, never mid-word. */
  onChange(value: string): void
}

/**
 * The search field over the sessions list.
 *
 * Two clocks meet here, and keeping them apart is the whole of it. The field
 * must answer every keystroke instantly, because a field that lags behind the
 * keyboard is the most broken-feeling thing a screen can do; the list it
 * narrows must not, for the reason on SETTLE_MS. So the keystrokes land in
 * local state and the caller hears about them once, after the pause.
 *
 * `value` is still the authority. When it changes to something this field did
 * not report — a saved view tab swapped the whole arrangement, say — the field
 * adopts it and abandons whatever was half-typed, exactly as any other
 * controlled input would. What it will not do is adopt the value it just
 * reported, which is the same string arriving back and would otherwise reset
 * the cursor of someone who has already typed two more letters.
 *
 * A pending report is cancelled on unmount, not flushed. The pause exists
 * because the reader is still typing; a half-word arriving after the screen
 * has been navigated away from would narrow a list nobody is looking at, and
 * with saved views it would be written down as part of one.
 */
export function SessionSearch({ value, onChange }: SessionSearchProps) {
  const [draft, setDraft] = useState(value)
  /** The last string this field and its caller agreed on. */
  const settled = useRef(value)
  /*
   * The caller's newest handler, held aside rather than watched.
   *
   * The timer below must be armed by keystrokes and by nothing else. A caller
   * that re-renders — and this one polls its fleet every three seconds — hands
   * over a fresh closure each time, and an effect that depended on it would
   * disarm and re-arm the pause on every poll: type one letter, and the report
   * is pushed 150ms further away every three seconds, forever.
   */
  const handler = useRef(onChange)
  useEffect(() => {
    handler.current = onChange
  })

  useEffect(() => {
    if (draft === settled.current) return
    const timer = setTimeout(() => {
      settled.current = draft
      handler.current(draft)
    }, SETTLE_MS)
    return () => clearTimeout(timer)
  }, [draft])

  useEffect(() => {
    if (value === settled.current) return
    settled.current = value
    setDraft(value)
  }, [value])

  return (
    <div className="relative">
      {/*
        Decoration, and marked as such: the field is named by its own label,
        and a reader who hears "search" twice learns nothing the second time.
      */}
      <MagnifyingGlassIcon
        aria-hidden="true"
        className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
      />
      <Input
        type="search"
        aria-label="Search sessions"
        placeholder="Search sessions"
        autoComplete="off"
        spellCheck={false}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        className="w-44 pl-8 sm:w-56"
      />
    </div>
  )
}
