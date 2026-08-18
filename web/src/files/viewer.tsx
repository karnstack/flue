import { Check, Copy, FileText, X } from 'lucide-react'
import { Dialog } from 'radix-ui'
import { useEffect, useRef, useState } from 'react'

import { useFlueClient } from '@/client/provider'
import type { FileMsg } from '@/client/protocol'
import { Button } from '@/components/ui/button'

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

/* One monospace row is exactly this tall (leading-5), which is what lets the
 * body be a window computed by arithmetic instead of a virtualization
 * library: the daemon promises monospace text and the row height is ours. */
const LINE_PX = 20
const OVERSCAN = 20

/** The daemon's ceiling on text; past it only the head was sent. */
const TEXT_CAP = 8 << 20

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
 * per animation frame so a fast stream cannot outrun the renderer.
 */
export function FileViewer({ sessionId, target, onClose }: FileViewerProps) {
  const client = useFlueClient()
  const [phase, setPhase] = useState<Phase>({ at: 'opening' })
  const [, setPainted] = useState(0)
  const linesRef = useRef<string[]>([])
  const frame = useRef(0)

  useEffect(() => {
    linesRef.current = []
    setPhase({ at: 'opening' })
    const decoder = new TextDecoder()
    let tail = ''
    let kind: 'text' | 'image' = 'text'
    const repaint = () => {
      if (frame.current !== 0) return
      frame.current = requestAnimationFrame(() => {
        frame.current = 0
        setPainted((n) => n + 1)
      })
    }
    const push = (piece: string) => {
      if (piece === '') return
      const parts = (tail + piece).split('\n')
      tail = parts.pop() ?? ''
      for (const p of parts) linesRef.current.push(p.endsWith('\r') ? p.slice(0, -1) : p)
    }
    const handle = client.read(sessionId, target.path, {
      file: (meta) => {
        kind = meta.kind
        if (meta.kind === 'image') {
          setPhase({ at: 'image', meta })
          // The stream is already coming; nothing here can show it yet.
          queueMicrotask(() => handle.cancel())
          return
        }
        setPhase({ at: 'text', meta })
      },
      chunk: (bytes) => {
        if (kind === 'image') return
        push(decoder.decode(bytes, { stream: true }))
        repaint()
      },
      eof: () => {
        push(decoder.decode())
        if (tail !== '') {
          linesRef.current.push(tail)
          tail = ''
        }
        repaint()
      },
      fail: (f) => setPhase({ at: 'refused', code: f.code }),
    })
    return () => {
      handle.cancel()
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
          {phase.at === 'image' && (
            <p role="alert" className="flex-1 px-4 py-3 text-control text-muted-foreground">
              An image ({phase.meta.mime}, {fmtBytes(phase.meta.size)}). The viewer cannot show one
              yet.
            </p>
          )}
          {phase.at === 'text' && <TextWindow lines={linesRef.current} mark={target.line} />}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function TextWindow({ lines, mark }: { lines: string[]; mark?: number }) {
  const boxRef = useRef<HTMLDivElement | null>(null)
  const jumped = useRef(false)
  const [top, setTop] = useState(0)
  const [tall, setTall] = useState(0)

  useEffect(() => {
    const box = boxRef.current
    if (box === null) return
    const measure = () => setTall(box.clientHeight)
    measure()
    const watcher = new ResizeObserver(measure)
    watcher.observe(box)
    return () => watcher.disconnect()
  }, [])

  // One jump to the named line, as soon as enough of the file has arrived.
  useEffect(() => {
    const box = boxRef.current
    if (box === null || mark === undefined || jumped.current || lines.length < mark) return
    jumped.current = true
    box.scrollTop = Math.max(0, (mark - 4) * LINE_PX)
    setTop(box.scrollTop)
  }, [lines.length, mark])

  const rows = Math.max(1, Math.ceil((tall > 0 ? tall : 480) / LINE_PX))
  const first = Math.max(0, Math.floor(top / LINE_PX) - OVERSCAN)
  const last = Math.min(lines.length, first + rows + OVERSCAN * 2)

  return (
    <div
      ref={boxRef}
      data-file-body
      tabIndex={-1}
      onScroll={(e) => setTop(e.currentTarget.scrollTop)}
      className="min-h-0 flex-1 overflow-auto overscroll-contain py-2 font-mono text-[12.5px] leading-5 outline-none"
    >
      <div
        className="w-max min-w-full"
        style={{ paddingTop: first * LINE_PX, paddingBottom: (lines.length - last) * LINE_PX }}
      >
        {lines.slice(first, last).map((text, i) => {
          const n = first + i + 1
          return (
            <div
              key={n}
              data-file-row
              data-marked={n === mark ? 'true' : undefined}
              className="h-5 pr-6 pl-4 whitespace-pre data-marked:bg-teal-500/15"
            >
              {text}
            </div>
          )
        })}
      </div>
    </div>
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
