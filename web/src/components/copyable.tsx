import { useState } from 'react'
import { ClipboardIcon } from '@heroicons/react/16/solid'

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

/** What a copy that worked says, and what a browser that refused one says. */
export const COPIED = 'Copied ✓'
export const BY_HAND =
  'This browser would not hand flue the clipboard — select the command and copy it yourself.'

const NOTE = 'text-sm/6 text-pretty text-zinc-600 sm:text-xs/5 dark:text-zinc-400'

/**
 * One string the reader wants somewhere else — a command, an address, a join
 * line — with a button that puts it there.
 *
 * The text is `select-all` as well as copyable, because the clipboard is not
 * always there to be had and a command nobody can select is a dead end. The
 * outcome is stated rather than assumed: `navigator.clipboard` is absent
 * outside a secure context, and `writeText` can reject on a page that has
 * lost focus or on a hardened browser — both land on the same honest line,
 * since what the reader has to do about either is the same.
 *
 * Neither line is cleared on a timer. The reader's next move is usually a
 * terminal in another window, and a confirmation that had vanished by the
 * time they looked back would leave them wondering whether the click landed.
 */
export function Copyable({ text, breakable = false }: { text: string; breakable?: boolean }) {
  const [said, setSaid] = useState('')

  function copy() {
    const clipboard = navigator.clipboard
    if (!clipboard) {
      setSaid(BY_HAND)
      return
    }
    void clipboard.writeText(text).then(
      () => setSaid(COPIED),
      () => setSaid(BY_HAND),
    )
  }

  return (
    <div>
      {/*
        The string sits on a tinted strip rather than in a bordered box: it is
        a quotation — from a terminal, or from the relay — and the card around
        it is already doing the containing.

        A command scrolls sideways on its own so a narrow phone shows a long
        one whole rather than wrapping it into something that would be pasted
        with a line break in it. An address is the opposite: it is read, not
        pasted into a shell, so it wraps at any character.
      */}
      <div className="flex items-center gap-x-2 rounded-lg bg-zinc-950/5 py-1 pr-1 pl-2.5 dark:bg-white/5">
        <code
          className={cn(
            'min-w-0 flex-1 font-mono text-sm/6 text-zinc-950 select-all sm:text-xs/6 dark:text-white',
            breakable ? 'break-all' : 'overflow-x-auto whitespace-nowrap',
          )}
        >
          {text}
        </code>
        {/*
          Named after what it copies: a screen reader announcing "Copy" three
          times on one screen says nothing about which one is which.
        */}
        <Button variant="ghost" size="icon-sm" aria-label={`Copy ${text}`} onClick={copy}>
          <ClipboardIcon aria-hidden="true" />
        </Button>
      </div>
      {/*
        Always on the page, never mounted with its text. Several screen
        readers announce only changes to a live region that was already in the
        accessibility tree, so a region that appears alongside its first
        message is a message nobody hears — which is also why it is not
        dropped when empty. Empty, it contributes no line box at all, and
        `empty:mt-0` takes its own spacing with it.
      */}
      <p role="status" className={cn(NOTE, 'mt-1.5 empty:mt-0')}>
        {said}
      </p>
    </div>
  )
}

/** A command, ready to be taken to a terminal. */
export function Command({ command }: { command: string }) {
  return <Copyable text={command} />
}
