import { useVirtualizer } from '@tanstack/react-virtual'
import { Check, Copy, FileText, WrapText, X } from 'lucide-react'
import { Dialog } from 'radix-ui'
import { useEffect, useRef, useState, type CSSProperties } from 'react'

import { useFlueClient } from '@/client/provider'
import type { FileMsg, PathEntry } from '@/client/protocol'
import type { ReadHandle } from '@/client/client'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { cachedFile, rememberFile, CACHE_ENTRY_MAX } from './cache'
import { HIGHLIGHT_MAX_BYTES, HIGHLIGHT_MAX_LINES } from './caps'
import { highlight } from './highlight'
import { languageFor } from './lang'
import type { PeekToken } from './tokenize'

export interface FileTarget {
  path: string
  line?: number
  col?: number
}

export interface FileViewerProps {
  sessionId: string
  target: FileTarget
  onClose: () => void
}

/** An unwrapped monospace row's height (leading-5), the size estimate the
 * virtualizer starts from; a wrapped row measures taller and is measured. */
const LINE_PX = 20

/** The daemon's ceiling on text; past it only the head was sent. */
const TEXT_CAP = 8 << 20

/**
 * The most characters one rendered row may carry. File content is untrusted,
 * and without this an 8 MiB single-line file is one eight-million-character
 * DOM row — and a stream with no newline in it would paint nothing at all
 * until eof. A longer line continues on the next row; for a file holding
 * lines that size, the row numbering is presentation, not truth.
 */
const ROW_CAP = 8192

const REFUSALS: Record<string, string> = {
  not_found: 'Nothing at this path under the session.',
  is_dir: 'That path is a directory.',
  too_large: 'This image is too large to send.',
  denied: 'The machine may not read this file.',
  busy: 'Two files are already streaming from this machine. Close one first.',
  unsupported: 'Neither text nor an image, so nothing sensible to show.',
  bad_path: 'Not a usable path.',
  timeout: 'The machine did not answer in time.',
  lost: 'The connection dropped before the file arrived whole.',
}

type Phase =
  | { at: 'opening' }
  | { at: 'text'; meta: FileMsg }
  | { at: 'image'; meta: FileMsg }
  | { at: 'refused'; code: string }

/**
 * A file over the session: the answer to clicking a path the session named.
 *
 * Content paints as it arrives — the head of a large file is on screen before
 * the tail has left the daemon, which over a relay is the difference between
 * reading now and watching a spinner. Painting is paced to one state change
 * per animation frame so a fast stream cannot outrun the renderer. A complete
 * file colours afterwards, off the main thread, and is remembered in memory
 * so reopening it costs one stat and no read.
 */
export function FileViewer({ sessionId, target, onClose }: FileViewerProps) {
  const client = useFlueClient()
  const [phase, setPhase] = useState<Phase>({ at: 'opening' })
  const [tokens, setTokens] = useState<PeekToken[][] | null>(null)
  const [imageUrl, setImageUrl] = useState<string | null>(null)
  const [wrap, setWrap] = useState(true)
  const [, setPainted] = useState(0)
  const linesRef = useRef<string[]>([])
  const frame = useRef(0)

  useEffect(() => {
    let gone = false
    linesRef.current = []
    setPhase({ at: 'opening' })
    setTokens(null)
    setImageUrl(null)
    const decoder = new TextDecoder()
    const parts: Uint8Array[] = []
    let tail = ''
    let meta: FileMsg | null = null
    let handle: ReadHandle | null = null

    const repaint = () => {
      if (frame.current !== 0) return
      frame.current = requestAnimationFrame(() => {
        frame.current = 0
        setPainted((n) => n + 1)
      })
    }
    const emit = (row: string) => {
      const clean = row.endsWith('\r') ? row.slice(0, -1) : row
      if (clean.length <= ROW_CAP) {
        linesRef.current.push(clean)
        return
      }
      for (let at = 0; at < clean.length; at += ROW_CAP) {
        linesRef.current.push(clean.slice(at, at + ROW_CAP))
      }
    }
    const push = (piece: string) => {
      if (piece === '') return
      const rows = (tail + piece).split('\n')
      tail = rows.pop() ?? ''
      for (const r of rows) emit(r)
      // A newline may never come. Overflow leaves the tail as finished rows,
      // which both bounds the tail and lets a newline-less stream paint.
      while (tail.length >= ROW_CAP) {
        linesRef.current.push(tail.slice(0, ROW_CAP))
        tail = tail.slice(ROW_CAP)
      }
    }

    const deliverMeta = (m: FileMsg) => {
      meta = m
      if (gone) return
      setPhase(m.kind === 'image' ? { at: 'image', meta: m } : { at: 'text', meta: m })
    }
    const deliverChunk = (bytes: Uint8Array) => {
      parts.push(bytes)
      if (meta?.kind !== 'image') {
        push(decoder.decode(bytes, { stream: true }))
        repaint()
      }
    }
    const colour = () => {
      if (meta === null || meta.kind !== 'text' || meta.truncated === true) return
      const lang = languageFor(meta.path)
      if (lang === null) return
      // The caps hold before the join, so an oversized file never pays for
      // a multi-megabyte string and a worker round trip to be told null.
      if (meta.size > HIGHLIGHT_MAX_BYTES || linesRef.current.length > HIGHLIGHT_MAX_LINES) return
      void highlight(linesRef.current.join('\n'), lang).then((rows) => {
        if (!gone && rows !== null) setTokens(rows)
      })
    }
    // Keyed per session as well as per clicked text: a relative path
    // resolves against a session's live working directory, so the same
    // spelling in another session may name a different file entirely.
    const cacheKey = `${sessionId}\u0000${target.path}`
    const statOne = () => client.stat(sessionId, [target.path]).then(([e]) => e)
    const deliverEof = (before: Promise<PathEntry | undefined> | null) => {
      if (meta?.kind === 'image') {
        if (!gone) setImageUrl(assembleDataUrl(meta.mime, parts))
      } else {
        push(decoder.decode())
        if (tail !== '') {
          linesRef.current.push(tail)
          tail = ''
        }
        repaint()
      }
      colour()
      if (before === null || meta === null || meta.truncated === true) return
      const total = parts.reduce((n, p) => n + p.length, 0)
      if (total > CACHE_ENTRY_MAX) return
      // Remembered only when the stat taken as the read began and the stat
      // taken after it agree on size and stamp, and both agree with the
      // stream's own size. mtime is unix seconds, so a same-second edit can
      // still slip this — but an edit during the stream cannot, which is
      // what an after-only check got wrong: it blessed post-edit bytes with
      // a post-edit stamp and served them stale on every reopen.
      const settled = meta
      void Promise.all([before, statOne()])
        .then(([pre, post]) => {
          if (pre?.exists !== true || pre.kind !== 'file') return
          if (post?.exists !== true || post.kind !== 'file') return
          if ((pre.size ?? 0) !== settled.size || (post.size ?? 0) !== settled.size) return
          if ((pre.mtime ?? 0) !== (post.mtime ?? 0)) return
          rememberFile(client, cacheKey, {
            meta: settled,
            mtime: post.mtime ?? 0,
            bytes: joinBytes(parts, total),
          })
        })
        .catch(() => {})
    }

    const readFromWire = (before: Promise<PathEntry | undefined> | null) => {
      if (gone) return
      handle = client.read(sessionId, target.path, {
        file: deliverMeta,
        chunk: deliverChunk,
        eof: () => deliverEof(before),
        fail: (f) => {
          if (!gone) setPhase({ at: 'refused', code: f.code })
        },
      })
    }

    const start = async () => {
      const held = cachedFile(client, cacheKey)
      if (held === null) {
        // The before-stat rides in parallel with the read, so the cache's
        // integrity costs the open no latency at all.
        readFromWire(statOne().catch(() => undefined))
        return
      }
      let confirmed: PathEntry | undefined
      try {
        confirmed = await statOne()
        if (gone) return
        if (
          confirmed?.exists === true &&
          confirmed.kind === 'file' &&
          (confirmed.size ?? 0) === held.meta.size &&
          (confirmed.mtime ?? 0) === held.mtime
        ) {
          deliverMeta(held.meta)
          deliverChunk(held.bytes)
          deliverEof(null)
          return
        }
      } catch {
        // The stat could not confirm the memory; the wire is the truth, and
        // with nothing to agree with, this read is not remembered either.
      }
      if (gone) return
      readFromWire(confirmed === undefined ? null : Promise.resolve(confirmed))
    }
    void start()

    return () => {
      gone = true
      handle?.cancel()
      if (frame.current !== 0) cancelAnimationFrame(frame.current)
      frame.current = 0
    }
  }, [client, sessionId, target.path])

  const meta = phase.at === 'text' || phase.at === 'image' ? phase.meta : null
  const shownPath = meta?.path ?? target.path
  const slash = shownPath.lastIndexOf('/')
  const base = slash >= 0 ? shownPath.slice(slash + 1) : shownPath
  const dir = slash > 0 ? shownPath.slice(0, slash) : slash === 0 ? '/' : ''

  return (
    <Dialog.Root
      open
      onOpenChange={(stillOpen) => {
        if (!stillOpen) onClose()
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/25" />
        <Dialog.Content
          aria-describedby={undefined}
          onOpenAutoFocus={(e) => {
            e.preventDefault()
            document.querySelector<HTMLElement>('[data-file-body]')?.focus()
          }}
          className={
            'fixed inset-0 z-50 flex flex-col overflow-hidden bg-popover text-popover-foreground outline-none ' +
            'sm:inset-auto sm:top-[8vh] sm:left-1/2 sm:h-[78vh] sm:w-[64rem] sm:max-w-[calc(100vw-2rem)] sm:-translate-x-1/2 ' +
            'sm:rounded-lg sm:shadow-high sm:ring-1 sm:ring-hairline'
          }
        >
          <div className="flex h-11 shrink-0 items-center gap-2 border-b border-hairline pr-1.5 pl-4 sm:h-9">
            <FileText aria-hidden className="size-4 shrink-0 text-muted-foreground" />
            <Dialog.Title className="shrink-0 font-heading text-sm font-medium">{base}</Dialog.Title>
            <span className="min-w-0 flex-1 truncate text-control text-muted-foreground">{dir}</span>
            {meta !== null && (
              <span className="shrink-0 text-control whitespace-nowrap text-muted-foreground">
                {fmtBytes(meta.size)}
              </span>
            )}
            {phase.at === 'text' && (
              <Button
                aria-label="Wrap lines"
                aria-pressed={wrap}
                size="icon-sm"
                variant="ghost"
                className={wrap ? 'bg-muted/60' : undefined}
                onClick={() => setWrap((w) => !w)}
              >
                <WrapText />
              </Button>
            )}
            <CopyPath path={shownPath} />
            <Dialog.Close asChild>
              <Button aria-label="Close file" size="icon-sm" variant="ghost">
                <X />
              </Button>
            </Dialog.Close>
          </div>
          {phase.at === 'text' && phase.meta.truncated === true && (
            <p
              role="status"
              className="shrink-0 border-b border-hairline bg-muted/40 px-4 py-1.5 text-control text-muted-foreground"
            >
              Showing the first {fmtBytes(TEXT_CAP)} of {fmtBytes(phase.meta.size)}. The rest stayed
              on the machine.
            </p>
          )}
          {phase.at === 'opening' && (
            <p role="status" className="flex-1 px-4 py-3 text-control text-muted-foreground">
              Opening…
            </p>
          )}
          {phase.at === 'refused' && (
            <p role="alert" className="flex-1 px-4 py-3 text-control text-destructive">
              {REFUSALS[phase.code] ?? 'The machine refused this read.'}
            </p>
          )}
          {phase.at === 'image' &&
            (imageUrl !== null ? (
              <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-4">
                <img alt={base} src={imageUrl} className="max-h-full max-w-full object-contain" />
              </div>
            ) : (
              <p role="status" className="flex-1 px-4 py-3 text-control text-muted-foreground">
                Receiving the image…
              </p>
            ))}
          {phase.at === 'text' && (
            // Keyed by path, so a viewer whose target changes under it — a
            // later phase reuses the mounted dialog — starts its scroll and
            // its one-shot jump over rather than inheriting the old file's.
            <TextWindow
              key={target.path}
              lines={linesRef.current}
              tokens={tokens}
              mark={target.line}
              wrap={wrap}
            />
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function TextWindow({
  lines,
  tokens,
  mark,
  wrap,
}: {
  lines: string[]
  tokens: PeekToken[][] | null
  mark?: number
  wrap: boolean
}) {
  const boxRef = useRef<HTMLDivElement | null>(null)
  const jumped = useRef(false)

  // Measured rather than arithmetic, because a wrapped line is as tall as
  // the width made it; the estimate only has to be right for the unwrapped
  // common case and the virtualizer corrects the rest as rows mount.
  const virtualizer = useVirtualizer({
    count: lines.length,
    getScrollElement: () => boxRef.current,
    estimateSize: () => LINE_PX,
    overscan: 24,
    getItemKey: (index) => index,
    // Both fallbacks are for an unlaid-out environment (jsdom): a rect so
    // the first render windows instead of rendering nothing, and the
    // estimate standing in for a measured height of zero, which would
    // otherwise put every row of the file inside a zero-height viewport.
    initialRect: { width: 800, height: 480 },
    measureElement: (el) => {
      const measured = el.getBoundingClientRect().height
      return measured > 0 ? measured : LINE_PX
    },
  })

  // One jump to the named line, as soon as enough of the file has arrived.
  useEffect(() => {
    if (mark === undefined || jumped.current || lines.length < mark) return
    jumped.current = true
    virtualizer.scrollToIndex(mark - 1, { align: 'center' })
  }, [lines.length, mark, virtualizer])

  // Flipping the wrap invalidates every height the virtualizer has learned.
  useEffect(() => {
    virtualizer.measure()
  }, [wrap, virtualizer])

  return (
    <div
      ref={boxRef}
      data-file-body
      tabIndex={-1}
      className="min-h-0 flex-1 overflow-auto overscroll-contain py-2 font-mono text-[12.5px] leading-5 outline-none"
    >
      <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((item) => {
          const n = item.index + 1
          return (
            <div
              key={item.key}
              data-index={item.index}
              ref={virtualizer.measureElement}
              data-file-row
              data-marked={n === mark ? 'true' : undefined}
              className={cn(
                'absolute top-0 left-0 min-h-5 translate-y-(--row-y) pr-6 pl-4 data-marked:bg-teal-500/15',
                wrap ? 'w-full break-words whitespace-pre-wrap' : 'w-max min-w-full whitespace-pre',
              )}
              style={{ '--row-y': `${item.start}px` } as CSSProperties}
            >
              {tokens?.[item.index] !== undefined ? (
                <TokenRow row={tokens[item.index]!} />
              ) : (
                lines[item.index]
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function TokenRow({ row }: { row: PeekToken[] }) {
  return (
    <>
      {row.map((t, i) => (
        <span
          key={i}
          // Both colours ride in as custom properties and come out through
          // classes, never as a `color` on the style attribute: a style
          // attribute outranks every stylesheet rule, so it would pin the
          // light colour under a dark scheme no matter what the dark:
          // variant asked for.
          className={cn(
            t.light !== undefined && 'text-(--peek-light)',
            t.dark !== undefined && 'dark:text-(--peek-dark)',
          )}
          style={{ '--peek-light': t.light, '--peek-dark': t.dark } as CSSProperties}
        >
          {t.text}
        </span>
      ))}
    </>
  )
}

function CopyPath({ path }: { path: string }) {
  const [held, setHeld] = useState(false)
  return (
    <Button
      aria-label="Copy path"
      size="icon-sm"
      variant="ghost"
      onClick={() => {
        void navigator.clipboard?.writeText(path).then(() => {
          setHeld(true)
          setTimeout(() => setHeld(false), 1500)
        })
      }}
    >
      {held ? <Check /> : <Copy />}
    </Button>
  )
}

function joinBytes(parts: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total)
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

function assembleDataUrl(mime: string, parts: Uint8Array[]): string {
  let bin = ''
  for (const part of parts) {
    for (let at = 0; at < part.length; at += 0x8000) {
      bin += String.fromCharCode(...part.subarray(at, at + 0x8000))
    }
  }
  return `data:${mime};base64,${btoa(bin)}`
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  const units = ['KiB', 'MiB', 'GiB']
  let v = n
  let u = -1
  do {
    v /= 1024
    u++
  } while (v >= 1024 && u < units.length - 1)
  const shown = v >= 10 ? Math.round(v) : Math.round(v * 10) / 10
  return `${shown} ${units[u]}`
}
