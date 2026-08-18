import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react'
import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router'
import { useVirtualizer } from '@tanstack/react-virtual'
import {
  AdjustmentsHorizontalIcon,
  ArrowDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
} from '@heroicons/react/16/solid'

import {
  AGENT_TOOLS,
  compactCost,
  compactTokens,
  dayLabel,
  dayStartMs,
  displayTitle,
  keyMessages,
  retryMissingTranscript,
  rowTokens,
  shortModel,
  type KeyedAgentMessage,
} from '@/agents/view'
import { ToolDot } from '@/components/agent-rows'
import { midCut, since } from '@/components/session-table'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Skeleton } from '@/components/ui/skeleton'
import type { FlueClient } from '@/client/client'
import type { AgentMessage, AgentSummary, AgentTool } from '@/client/protocol'
import { useFleet } from '@/fleet/provider'
import { cn } from '@/lib/utils'

/** The terminal's path, written out for sessions.tsx's cycle reason. */
const TERMINAL_PATH = '/d/$deviceId/s/$sessionId' as const

/** How many messages one page asks for. */
const PAGE_LIMIT = 100

/** The follow cadence once the end of the file has been seen. */
const FOLLOW_MS = 5_000

/** How close to the bottom still counts as being at it. */
const NEAR_BOTTOM_PX = 60

/** How close to the loaded end starts the next page on the way down. */
const NEAR_END_PX = 800

/** The summary re-ask cadence and budget while the index is still building. */
const SUMMARY_POLL_MS = 2_000
const SUMMARY_POLL_BUDGET_MS = 60_000

/** The error a spawn refusal names; see sessions.tsx. */
const SPAWN_FAILED = 'spawn_failed'

/** One loaded stretch of the transcript, in the wire's own terms — except
 *  the messages, which carry the list keys keyMessages derived per page. */
interface Window {
  msgs: KeyedAgentMessage[]
  /** The byte offset of the first loaded message's line. */
  start: number
  /** The offset after the last consumed line — where forward reads resume. */
  next: number
  eof: boolean
  fileSize: number
}

type Phase = 'loading' | 'ready' | 'gone' | 'failed'

/**
 * Whether a page rejection is worth retrying. The client's own refusals — a
 * timeout, a socket that was down — carry its prefix; anything else is the
 * daemon saying the transcript is not there to read.
 */
function transient(err: unknown): boolean {
  return err instanceof Error && err.message.startsWith('flue:')
}

/**
 * The transcript viewer: one agent conversation, read in pages addressed by
 * byte offset, exactly as the wire hands them out — forward from anywhere,
 * backward from anywhere, `fileSize` for the end. The message list is
 * virtualized because a long Claude session runs to thousands of blocks and
 * the row heights vary by two orders of magnitude.
 */
export function AgentViewerRoute() {
  const fleet = useFleet()
  const navigate = useNavigate()
  // Non-strict rather than a RouteApi keyed by route id: the registered id
  // carries the shell layout's prefix, and the test harness mounts this
  // component under a plain path — non-strict reads work under both.
  const params = useParams({ strict: false }) as {
    machineId?: string
    tool?: string
    sessionId?: string
  }
  const search = useSearch({ strict: false }) as { at?: number }
  const machineId = params.machineId ?? ''
  const sessionId = params.sessionId ?? ''
  const at = search.at
  const tool: AgentTool | null =
    params.tool !== undefined && (AGENT_TOOLS as readonly string[]).includes(params.tool)
      ? (params.tool as AgentTool)
      : null

  const [win, setWin] = useState<Window | null>(null)
  const [phase, setPhase] = useState<Phase>('loading')
  const [summary, setSummary] = useState<AgentSummary | 'missing' | null>(null)
  const [machineUp, setMachineUp] = useState(false)
  const [machineName, setMachineName] = useState('')
  const [showSystem, setShowSystem] = useState(false)
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set())
  const [flash, setFlash] = useState<string | null>(null)
  const [newBelow, setNewBelow] = useState(false)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [atBottom, setAtBottom] = useState(true)
  const [notice, setNotice] = useState<string | null>(null)
  const [spawning, setSpawning] = useState(false)
  const [pageVisible, setPageVisible] = useState(() => !document.hidden)

  /** The one-counter race guard, per session-preview.tsx: bumped on unmount
   *  and on every fresh initial load, so a late answer sets nothing. The
   *  summary keeps a counter of its own, because a jump-to-end retires the
   *  page in flight and must not retire the summary with it. */
  const generation = useRef(0)
  const summaryGeneration = useRef(0)
  const winRef = useRef(win)
  winRef.current = win
  const atBottomRef = useRef(true)
  const busyForward = useRef(false)
  const stickBottom = useRef(false)
  /** The shown count as of the viewport-fill effect's last ask, or null when
   *  no fill is in flight. See the fill effect below. */
  const fillAsked = useRef<number | null>(null)
  const prepended = useRef<{ prevTotal: number; prevOffset: number } | null>(null)
  const anchored = useRef(false)
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const summaryTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const summaryAskedAt = useRef<number | null>(null)
  /** Whether the machine's index answer settled — the session was found, or
   *  the sweep finished without it — which is what turns a page not_found
   *  from "not indexed yet, ask again" into "really gone". */
  const indexSettled = useRef(false)
  /** When the first not_found landed, for retryMissingTranscript's budget. */
  const missingSince = useRef<number | null>(null)
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingSpawn = useRef<{ reqId: number; client: FlueClient; offs: Array<() => void> } | null>(
    null,
  )

  const scrollRef = useRef<HTMLDivElement | null>(null)

  // ------------------------------------------------------------------ fleet

  useEffect(() => {
    const off = fleet.onFleet((_sessions, machines) => {
      const mine = machines.find((m) => m.id === machineId)
      setMachineUp(mine?.status === 'online')
      setMachineName(mine?.name ?? '')
    })
    fleet.list()
    return off
  }, [fleet, machineId])

  useEffect(() => {
    const onVisibility = () => setPageVisible(!document.hidden)
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [])

  useEffect(
    () => () => {
      generation.current++
      summaryGeneration.current++
      if (flashTimer.current !== null) clearTimeout(flashTimer.current)
      if (summaryTimer.current !== null) clearTimeout(summaryTimer.current)
      if (retryTimer.current !== null) clearTimeout(retryTimer.current)
      const spawn = pendingSpawn.current
      if (spawn !== null) {
        spawn.client.abandon(spawn.reqId)
        for (const off of spawn.offs) off()
        pendingSpawn.current = null
      }
    },
    [],
  )

  // ---------------------------------------------------------------- summary

  const askSummary = useCallback(() => {
    if (tool === null) return
    const mine = summaryGeneration.current
    fleet.agentsOn(machineId).then(
      (msg) => {
        if (summaryGeneration.current !== mine) return
        const found = msg.sessions.find((s) => s.tool === tool && s.id === sessionId)
        if (found !== undefined) {
          summaryAskedAt.current = null
          indexSettled.current = true
          setSummary(found)
          return
        }
        // Not indexed yet. While a sweep is in flight that may only mean not
        // indexed *yet*, so the question is repeated for a while before the
        // absence is believed.
        const startedAt = summaryAskedAt.current ?? Date.now()
        summaryAskedAt.current = startedAt
        if (msg.building && Date.now() - startedAt < SUMMARY_POLL_BUDGET_MS) {
          summaryTimer.current = setTimeout(askSummary, SUMMARY_POLL_MS)
        } else {
          indexSettled.current = true
          setSummary('missing')
        }
      },
      () => {
        // Unanswerable right now; the machine-up effect below asks again.
      },
    )
  }, [fleet, machineId, sessionId, tool])

  useEffect(() => {
    askSummary()
  }, [askSummary])

  // ------------------------------------------------------------------ pages

  const load = useCallback(() => {
    if (tool === null) return
    if (retryTimer.current !== null) {
      clearTimeout(retryTimer.current)
      retryTimer.current = null
    }
    const mine = ++generation.current
    anchored.current = false
    fillAsked.current = null
    setPhase('loading')
    setWin(null)
    setNewBelow(false)
    const from = at ?? 0
    fleet.agentReadOn(machineId, tool, sessionId, from, { dir: 'forward', limit: PAGE_LIMIT }).then(
      (page) => {
        if (generation.current !== mine) return
        missingSince.current = null
        setWin({
          msgs: keyMessages(page.messages),
          // From the top of the file there is nothing earlier even when the
          // first renderable message sits past offset 0 (skipped harness
          // lines) — page.start would offer a "Load earlier" that loads
          // nothing. An anchored open keeps the daemon's answer.
          start: from === 0 ? 0 : page.start,
          next: page.next,
          eof: page.eof,
          fileSize: page.fileSize,
        })
        setPhase('ready')
      },
      (err) => {
        if (generation.current !== mine) return
        if (transient(err)) {
          setPhase('failed')
          return
        }
        // The daemon says not_found — which on a cold index may only mean
        // not indexed *yet*, so the read is re-asked on the summary poll's
        // cadence and budget before the absence is believed.
        const firstMissAt = missingSince.current ?? Date.now()
        missingSince.current = firstMissAt
        if (
          retryMissingTranscript(
            indexSettled.current,
            firstMissAt,
            Date.now(),
            SUMMARY_POLL_BUDGET_MS,
          )
        ) {
          retryTimer.current = setTimeout(load, SUMMARY_POLL_MS)
          return
        }
        setPhase('gone')
      },
    )
  }, [fleet, machineId, sessionId, tool, at])

  useEffect(() => {
    // A fresh target restarts the not_found patience; only the timer above
    // re-enters load with the budget still running.
    missingSince.current = null
    load()
  }, [load])

  // A machine that comes up answers what a cold deep link could not ask.
  useEffect(() => {
    if (!machineUp) return
    if (phase === 'failed') load()
    if (summary === null) askSummary()
    // phase and summary are read, not watched: this effect is about the
    // machine's arrival, and re-running it on every phase change would
    // re-ask for pages that are already on their way.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [machineUp])

  const fetchForward = useCallback(() => {
    if (tool === null) return
    const w = winRef.current
    if (w === null || busyForward.current) return
    busyForward.current = true
    // Whether this read is the tail growing rather than ordinary paging: only
    // growth earns the pill, and only growth pins the reader to the bottom.
    const wasTail = w.eof
    const mine = generation.current
    fleet.agentReadOn(machineId, tool, sessionId, w.next, { dir: 'forward', limit: PAGE_LIMIT }).then(
      (page) => {
        busyForward.current = false
        if (generation.current !== mine) return
        if (page.messages.length === 0) {
          setWin((prev) =>
            prev === null
              ? prev
              : { ...prev, next: page.next, eof: page.eof, fileSize: page.fileSize },
          )
          return
        }
        if (wasTail && atBottomRef.current) stickBottom.current = true
        else if (wasTail) setNewBelow(true)
        setWin((prev) =>
          prev === null
            ? prev
            : {
                msgs: [...prev.msgs, ...keyMessages(page.messages)],
                start: prev.start,
                next: page.next,
                eof: page.eof,
                fileSize: page.fileSize,
              },
        )
      },
      () => {
        busyForward.current = false
      },
    )
  }, [fleet, machineId, sessionId, tool])

  const loadOlder = useCallback(() => {
    if (tool === null) return
    const w = winRef.current
    if (w === null || w.start <= 0 || loadingOlder) return
    setLoadingOlder(true)
    const mine = generation.current
    fleet
      .agentReadOn(machineId, tool, sessionId, w.start, { dir: 'backward', limit: PAGE_LIMIT })
      .then(
        (page) => {
          setLoadingOlder(false)
          if (generation.current !== mine) return
          if (page.messages.length === 0) {
            setWin((prev) => (prev === null ? prev : { ...prev, start: page.start }))
            return
          }
          prepended.current = {
            prevTotal: totalSizeRef.current(),
            prevOffset: scrollRef.current?.scrollTop ?? 0,
          }
          setWin((prev) =>
            prev === null
              ? prev
              : {
                  msgs: [...keyMessages(page.messages), ...prev.msgs],
                  start: page.start,
                  next: prev.next,
                  eof: prev.eof,
                  fileSize: page.fileSize,
                },
          )
        },
        () => setLoadingOlder(false),
      )
  }, [fleet, machineId, sessionId, tool, loadingOlder])

  const jumpToEnd = useCallback(() => {
    if (tool === null) return
    const size = winRef.current?.fileSize ?? (typeof summary === 'object' && summary !== null ? summary.fileSize : null)
    if (size === null) return
    const mine = ++generation.current
    fleet.agentReadOn(machineId, tool, sessionId, size, { dir: 'backward', limit: PAGE_LIMIT }).then(
      (page) => {
        if (generation.current !== mine) return
        stickBottom.current = true
        setNewBelow(false)
        fillAsked.current = null
        setWin({
          msgs: keyMessages(page.messages),
          start: page.start,
          next: page.next,
          eof: page.eof,
          fileSize: page.fileSize,
        })
        setPhase('ready')
      },
      (err) => {
        if (generation.current !== mine) return
        setPhase(transient(err) ? 'failed' : 'gone')
      },
    )
  }, [fleet, machineId, sessionId, tool, summary])

  // Follow the tail: only at the bottom, only while looked at, only once the
  // end of the file has been reached — anything else re-reads for nobody.
  const eof = win?.eof ?? false
  useEffect(() => {
    if (phase !== 'ready' || !eof || !pageVisible || !atBottom) return
    const timer = setInterval(fetchForward, FOLLOW_MS)
    return () => clearInterval(timer)
  }, [phase, eof, pageVisible, atBottom, fetchForward])

  // ------------------------------------------------------------ virtualizer

  const shown = useMemo(() => {
    const msgs = win?.msgs ?? []
    return showSystem ? msgs : msgs.filter((m) => m.role !== 'system')
  }, [win, showSystem])

  const virtualizer = useVirtualizer({
    count: shown.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 72,
    overscan: 12,
    getItemKey: (index) => shown[index]!.key,
  })
  const totalSizeRef = useRef<() => number>(() => 0)
  totalSizeRef.current = () => virtualizer.getTotalSize()

  /**
   * After a prepend, keep what was on screen on screen: the scroll position
   * moves by exactly what the new rows added above it. Estimated heights make
   * the delta an estimate too, but the virtualizer corrects as the new rows
   * measure, and the reading position never leaps.
   */
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (el === null) return
    if (prepended.current !== null) {
      const { prevTotal, prevOffset } = prepended.current
      prepended.current = null
      el.scrollTop = prevOffset + (virtualizer.getTotalSize() - prevTotal)
      return
    }
    if (stickBottom.current) {
      stickBottom.current = false
      if (shown.length > 0) virtualizer.scrollToIndex(shown.length - 1, { align: 'end' })
    }
  }, [shown.length, virtualizer])

  // A first page shorter than the viewport leaves nothing to scroll, so the
  // next page has to be asked for rather than waited for — but only while
  // the pages still add rows. A fetched page that contributes nothing to
  // `shown` (every message of it screened out by the system toggle) stops
  // the chain, or a transcript of system events alone would be paged to the
  // end of the file for nobody. Manual paging and the jump still work, and
  // any growth of `shown` re-arms the fill.
  useEffect(() => {
    const el = scrollRef.current
    if (phase !== 'ready' || win === null || win.eof || el === null) return
    if (fillAsked.current !== null && shown.length === fillAsked.current) return
    fillAsked.current = null
    if (virtualizer.getTotalSize() <= el.clientHeight) {
      fillAsked.current = shown.length
      fetchForward()
    }
  }, [phase, win, shown, virtualizer, fetchForward])

  // The `?at=` anchor: once the first page holding it has rendered, land on
  // it and let it glow for a moment so the eye finds the matched line. The
  // glow goes to the first message at the anchored offset alone — a line can
  // carry several messages, and lighting the whole line says less.
  useEffect(() => {
    if (anchored.current || at === undefined || phase !== 'ready') return
    anchored.current = true
    const index = shown.findIndex((m) => m.offset === at)
    if (index < 0) return
    virtualizer.scrollToIndex(index, { align: 'center' })
    setFlash(shown[index]!.key)
    flashTimer.current = setTimeout(() => setFlash(null), 1_500)
  }, [at, phase, shown, virtualizer])

  const onScroll = () => {
    const el = scrollRef.current
    if (el === null) return
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight
    const bottom = distance < NEAR_BOTTOM_PX
    atBottomRef.current = bottom
    setAtBottom(bottom)
    if (bottom) setNewBelow(false)
    const w = winRef.current
    if (w !== null && !w.eof && distance < NEAR_END_PX) fetchForward()
  }

  // ------------------------------------------------------------------ resume

  const resumeSession = () => {
    if (typeof summary !== 'object' || summary === null || summary.resume === undefined) return
    // One spawn at a time: a second press while the first is settling would
    // start a second session and strand the first entry's listeners.
    if (pendingSpawn.current !== null) return
    const client = fleet.clientFor(machineId)
    const reqId = fleet.spawnOn(machineId, {
      cwd: summary.resume.cwd,
      cmd: summary.resume.cmd,
      cols: 80,
      rows: 24,
    })
    if (client === null || reqId === null) {
      setNotice('Could not start a session: the machine is not reachable.')
      return
    }
    const entry = { reqId, client, offs: [] as Array<() => void> }
    const settle = () => {
      if (pendingSpawn.current !== entry) return
      pendingSpawn.current = null
      setSpawning(false)
      for (const off of entry.offs) off()
    }
    entry.offs.push(
      client.onAttached((a) => {
        if (a.reqId !== reqId) return
        settle()
        // Hand the ref straight back, exactly as sessions.tsx adopt() does:
        // this screen renders no terminal, and the route it navigates to
        // attaches on its own.
        client.detach(a.ref)
        void navigate({ to: TERMINAL_PATH, params: { deviceId: machineId, sessionId: a.id } })
      }),
      client.onError((e) => {
        if (e.reqId !== reqId) return
        settle()
        if (e.code === SPAWN_FAILED) setNotice(`Could not start a session: ${e.msg}`)
      }),
      client.onStatus((s) => {
        if (s !== 'open') settle()
      }),
    )
    pendingSpawn.current = entry
    setSpawning(true)
  }

  // ------------------------------------------------------------------ render

  const gone = tool === null || phase === 'gone' || summary === 'missing'
  const known = typeof summary === 'object' && summary !== null ? summary : null
  const title = known !== null ? displayTitle(known) : sessionId
  const now = Date.now()

  const canResume = known !== null && known.resume !== undefined && machineUp

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 flex-col gap-y-1 border-b border-hairline px-4 py-3 sm:px-6">
        <div className="flex min-w-0 items-center gap-x-2">
          <Button asChild variant="ghost" size="icon-sm" aria-label="Back to agents">
            <Link to="/agents">
              <ChevronLeftIcon aria-hidden="true" />
            </Link>
          </Button>
          {tool !== null && <ToolDot tool={tool} label={`${tool} transcript`} />}
          <h1 className="min-w-0 truncate text-sm font-semibold text-zinc-950 dark:text-white">
            {title}
          </h1>
          <div className="ml-auto flex shrink-0 items-center gap-x-1.5">
            {!gone && (
              <>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Jump to end"
                  onClick={jumpToEnd}
                >
                  <ArrowDownIcon aria-hidden="true" />
                </Button>
                <ViewerDisplayOptions showSystem={showSystem} onShowSystem={setShowSystem} />
              </>
            )}
            {canResume && (
              <Button onClick={resumeSession} disabled={spawning}>
                {spawning ? 'Opening…' : 'Resume in a terminal'}
              </Button>
            )}
          </div>
        </div>
        {known !== null && !gone && <MetaLine summary={known} machineName={machineName} />}
        {/*
          Always rendered, as the sessions screen's status line is: several
          screen readers announce only changes to a region that was already in
          the tree. Empty it contributes no line box, so it costs nothing.
        */}
        <p role="status" className="pl-9 text-control text-destructive">
          {notice}
        </p>
      </header>

      {gone ? (
        <GoneState />
      ) : phase === 'failed' ? (
        <RetryRow onRetry={load} />
      ) : phase === 'loading' ? (
        <div className="flex flex-col gap-y-3 p-4 sm:p-6">
          <Skeleton className="h-8 w-2/3" />
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-8 w-1/2" />
        </div>
      ) : (
        <div className="relative flex min-h-0 flex-1 flex-col">
          <div ref={scrollRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto">
            <div className="mx-auto w-full max-w-[72ch] px-4 py-4">
              {win !== null && win.start > 0 && (
                <div className="flex justify-center pb-3">
                  <Button variant="outline" size="sm" disabled={loadingOlder} onClick={loadOlder}>
                    {loadingOlder ? 'Loading…' : 'Load earlier'}
                  </Button>
                </div>
              )}
              {shown.length === 0 ? (
                <p className="py-8 text-center text-base/6 text-zinc-500 sm:text-sm/6 dark:text-zinc-400">
                  Nothing to show in this transcript.
                </p>
              ) : (
                <div
                  className="relative w-full"
                  style={{ height: virtualizer.getTotalSize() }}
                >
                  {virtualizer.getVirtualItems().map((item) => {
                    const m = shown[item.index]!
                    const prev = item.index > 0 ? shown[item.index - 1] : undefined
                    return (
                      <div
                        key={item.key}
                        data-index={item.index}
                        ref={virtualizer.measureElement}
                        // Placed with a variable the class consumes rather
                        // than a style property, which keeps the property
                        // name out of the Tailwind scanner's reach.
                        className="absolute top-0 left-0 w-full translate-y-(--row-y)"
                        style={{ '--row-y': `${item.start}px` } as CSSProperties}
                      >
                        <MessageBlock
                          m={m}
                          prev={prev}
                          open={expanded.has(m.key)}
                          onToggle={() =>
                            setExpanded((prevSet) => {
                              const next = new Set(prevSet)
                              if (!next.delete(m.key)) next.add(m.key)
                              return next
                            })
                          }
                          flashed={flash === m.key}
                          now={now}
                        />
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          </div>
          {newBelow && (
            <Button
              variant="outline"
              size="sm"
              className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full shadow-medium"
              onClick={() => {
                setNewBelow(false)
                stickBottom.current = true
                if (shown.length > 0) {
                  virtualizer.scrollToIndex(shown.length - 1, { align: 'end' })
                }
              }}
            >
              New messages
            </Button>
          )}
        </div>
      )}
    </div>
  )
}

/** The header's second line: where, on what, with which models, at what cost. */
function MetaLine({ summary, machineName }: { summary: AgentSummary; machineName: string }) {
  const parts: Array<{ key: string; text: string; title?: string }> = [
    { key: 'cwd', text: midCut(summary.cwd), title: summary.cwd },
  ]
  if (machineName !== '') {
    parts.push({ key: 'machine', text: machineName })
  }
  if (summary.models.length > 0) {
    parts.push({
      key: 'models',
      text: summary.models.map(shortModel).join(', '),
      title: summary.models.join(', '),
    })
  }
  const started = since(summary.startedAt)
  if (started !== '') parts.push({ key: 'started', text: `started ${started}` })
  parts.push({ key: 'tokens', text: `${compactTokens(rowTokens(summary))} tok` })
  if (summary.costUsd !== undefined) {
    parts.push({ key: 'cost', text: compactCost(summary.costUsd) })
  }
  return (
    <p className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5 pl-9 text-control text-muted-foreground">
      {parts.map((part, index) => (
        <span key={part.key} className="flex min-w-0 items-baseline gap-x-2">
          {index > 0 && <span aria-hidden="true">·</span>}
          <span title={part.title} className="min-w-0 truncate">
            {part.text}
          </span>
        </span>
      ))}
    </p>
  )
}

/** The one display choice this screen has: whether system events show. */
function ViewerDisplayOptions({
  showSystem,
  onShowSystem,
}: {
  showSystem: boolean
  onShowSystem(next: boolean): void
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label="Display options">
          <AdjustmentsHorizontalIcon aria-hidden="true" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" aria-label="Display options" className="w-64">
        <div className="flex items-center justify-between gap-2">
          <label htmlFor="agent-show-system" className="cursor-pointer text-muted-foreground">
            Show system events
          </label>
          <Checkbox
            id="agent-show-system"
            checked={showSystem}
            onCheckedChange={(next) => onShowSystem(next === true)}
          />
        </div>
      </PopoverContent>
    </Popover>
  )
}

function GoneState() {
  return (
    <div className="flex flex-col items-center px-4 py-16 text-center">
      <p className="text-base/6 font-medium text-balance text-zinc-950 dark:text-white">
        This transcript is gone
      </p>
      <p className="mt-1 max-w-[40ch] text-base/7 text-pretty text-zinc-600 sm:text-sm/6 dark:text-zinc-400">
        It may have been removed on the machine that recorded it.
      </p>
      <Button asChild variant="outline" className="mt-4">
        <Link to="/agents">Back to agents</Link>
      </Button>
    </div>
  )
}

function RetryRow({ onRetry }: { onRetry(): void }) {
  return (
    <p className="flex items-center gap-x-1.5 px-4 py-6 text-base/6 text-zinc-500 sm:px-6 sm:text-sm/6 dark:text-zinc-400">
      The machine did not answer.
      <Button variant="ghost" size="sm" onClick={onRetry}>
        Retry
      </Button>
    </p>
  )
}

/**
 * One message, rendered by kind. The day separator and the subagent chip both
 * need the previous message, which the virtual list hands over by index —
 * they belong to the crossing, not to either side of it.
 */
function MessageBlock({
  m,
  prev,
  open,
  onToggle,
  flashed,
  now,
}: {
  m: AgentMessage
  prev?: AgentMessage
  open: boolean
  onToggle(): void
  flashed: boolean
  now: number
}) {
  const crossing = crossesDay(prev, m)
  const sidechainStart = m.sidechain === true && prev?.sidechain !== true
  return (
    <div className="py-1">
      {crossing !== null && (
        <div className="flex items-center gap-x-3 py-2" aria-hidden="true">
          <span className="h-px min-w-0 flex-1 bg-hairline" />
          <span className="shrink-0 text-xs text-muted-foreground">
            {dayLabel(crossing, now)}
          </span>
          <span className="h-px min-w-0 flex-1 bg-hairline" />
        </div>
      )}
      <div
        className={cn(
          'rounded-md transition-colors duration-1000',
          flashed && 'bg-accent-bg/10',
          m.sidechain === true && 'border-l-2 border-zinc-950/10 pl-3 dark:border-white/10',
        )}
      >
        {sidechainStart && (
          <span className="mb-1 inline-flex rounded-sm bg-muted px-1.5 text-xs text-muted-foreground">
            subagent
          </span>
        )}
        <MessageBody m={m} open={open} onToggle={onToggle} />
      </div>
    </div>
  )
}

/** The day the pair crosses into, or null when they share one. */
function crossesDay(prev: AgentMessage | undefined, m: AgentMessage): number | null {
  if (prev?.ts === undefined || m.ts === undefined) return null
  const before = Date.parse(prev.ts)
  const after = Date.parse(m.ts)
  if (Number.isNaN(before) || Number.isNaN(after)) return null
  const day = dayStartMs(after)
  return dayStartMs(before) === day ? null : day
}

function MessageBody({
  m,
  open,
  onToggle,
}: {
  m: AgentMessage
  open: boolean
  onToggle(): void
}) {
  if (m.role === 'system') {
    return (
      <div className="flex items-baseline gap-x-2 py-0.5 text-xs text-muted-foreground">
        <span className="shrink-0 rounded-sm bg-muted px-1.5">system</span>
        <span className="min-w-0 break-words whitespace-pre-wrap">{m.text}</span>
      </div>
    )
  }
  switch (m.kind) {
    case 'thinking':
      return (
        <Foldaway
          open={open}
          onToggle={onToggle}
          summary={<span className="text-xs text-muted-foreground italic">Thinking</span>}
        >
          <div className="text-sm break-words whitespace-pre-wrap text-muted-foreground italic">
            {m.text}
          </div>
        </Foldaway>
      )
    case 'tool_call':
      return <ToolBlock m={m} open={open} onToggle={onToggle} />
    case 'tool_result':
      return (
        <div className="pl-5">
          <ToolBlock m={m} open={open} onToggle={onToggle} fallbackName="result" />
        </div>
      )
    default:
      if (m.role === 'user') {
        return (
          <div className="rounded-lg bg-row-hover px-3 py-2">
            <p className="text-xs font-medium text-muted-foreground">You</p>
            <div className="text-sm break-words whitespace-pre-wrap text-zinc-950 dark:text-zinc-50">
              {m.text}
            </div>
          </div>
        )
      }
      return (
        <div className="py-1 text-sm break-words whitespace-pre-wrap text-zinc-950 dark:text-zinc-50">
          {m.text}
        </div>
      )
  }
}

/** A disclosure line and, opened, whatever it was keeping short. */
function Foldaway({
  open,
  onToggle,
  summary,
  children,
}: {
  open: boolean
  onToggle(): void
  summary: ReactNode
  children: ReactNode
}) {
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        className="flex w-full min-w-0 items-center gap-x-1.5 rounded-sm px-1 py-0.5 text-left outline-none hover:bg-row-hover focus-visible:outline-2 focus-visible:outline-ring"
      >
        <ChevronRightIcon
          aria-hidden="true"
          className={cn(
            'size-3.5 shrink-0 text-zinc-400 transition-transform dark:text-zinc-500',
            open && 'rotate-90',
          )}
        />
        {summary}
      </button>
      {open && <div className="mt-1 pl-6">{children}</div>}
    </div>
  )
}

/** A tool call or result: name, first line shut, the whole payload open. */
function ToolBlock({
  m,
  open,
  onToggle,
  fallbackName,
}: {
  m: AgentMessage
  open: boolean
  onToggle(): void
  fallbackName?: string
}) {
  const name = m.toolName ?? fallbackName ?? 'tool'
  return (
    <Foldaway
      open={open}
      onToggle={onToggle}
      summary={
        <>
          <span className="shrink-0 rounded-sm bg-muted px-1.5 font-mono text-xs text-zinc-950 dark:text-zinc-50">
            {name}
          </span>
          {!open && (
            <span className="min-w-0 truncate font-mono text-xs text-muted-foreground">
              {firstLine(m.text)}
            </span>
          )}
        </>
      }
    >
      <pre className="max-h-80 overflow-x-auto overflow-y-auto rounded-md bg-muted/50 p-3 font-mono text-xs break-words whitespace-pre-wrap">
        {m.text}
      </pre>
      {m.truncated === true && (
        <p className="mt-1 text-xs text-muted-foreground">· clipped by the daemon</p>
      )}
    </Foldaway>
  )
}

function firstLine(text: string): string {
  const cut = text.indexOf('\n')
  return cut < 0 ? text : text.slice(0, cut)
}
