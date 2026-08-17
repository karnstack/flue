import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useRouterState } from '@tanstack/react-router'
import { Dialog } from 'radix-ui'
import { SquareTerminalIcon, XIcon } from 'lucide-react'

import { Button } from '@/components/ui/button'

import type { FlueClient } from '@/client/client'
import type { SessionInfo } from '@/client/protocol'
import { FlueClientContext } from '@/client/provider'
import { Terminal } from '@/components/terminal'
import { useFleet } from '@/fleet/provider'
import { LOCAL_MACHINE_ID } from '@/fleet/types'
import { useIsMobile } from '@/hooks/use-mobile'
import { createDoubleCtrl } from './double-ctrl'
import { ScratchContext } from './context'

/** 80x24 is a starting point, not a decision; the terminal corrects it. */
const SPAWN_COLS = 80
const SPAWN_ROWS = 24

/** The modal header's height in px (h-11 on mobile below), for the viewport pinning. */
const HEADER_PX = 44

/** What the modal is showing: which machine's client, whose scratch, and whose cwd it started in. */
interface OpenScratch {
  machineId: string
  sessionId: string
  parentId: string
}

/**
 * The scratch terminal: double-tap Ctrl over a session and a modal opens with
 * a shell on the same machine, in that session's directory.
 *
 * The shell is an `ephemeral` session grouped under the one on screen, and
 * that grouping is its whole lifecycle: dismissing the modal only detaches,
 * so a dev server started in it keeps serving; tapping the chord again finds
 * the same session still running and reattaches; and the daemon closes it
 * when the parent session ends (spec/protocol.md, "Groups and ephemeral
 * sessions"). "Keep" is the way out of that bargain — it clears the flag and
 * the scratch becomes an ordinary member of the group, a split pane from the
 * next render on.
 *
 * Mounted above the terminal route like the switcher, and for the same
 * reason: the chord has to work wherever a session is on screen. It renders
 * nothing and listens for two keys while closed.
 */
export function ScratchProvider({ children }: { children: ReactNode }) {
  const fleet = useFleet()
  const isMobile = useIsMobile()
  const [open, setOpen] = useState<OpenScratch | null>(null)

  // Which session the chord would anchor to: the deepest route match, read
  // the way the switcher reads it — a param hook here would answer for the
  // root route, which has no params on any screen.
  const params = useRouterState({
    select: (s) =>
      (s.matches[s.matches.length - 1]?.params ?? {}) as {
        deviceId?: string
        sessionId?: string
      },
  })
  const machineId = params.deviceId ?? LOCAL_MACHINE_ID
  const parentId = params.sessionId ?? null

  // Whether the chord and the chip do anything right now: a session on
  // screen, its machine reachable, and its daemon speaking `multiplex`. The
  // cap arrives on the welcome, so this listens rather than reads once.
  const [enabled, setEnabled] = useState(false)
  useEffect(() => {
    if (parentId === null) {
      setEnabled(false)
      return
    }
    // Re-resolved on every fleet reshaping, not read once: a direct load of
    // a remote machine's session renders before the fleet has adopted its
    // remote sources, so the first look legitimately finds no client — and a
    // welcome subscription is only worth holding on the client that exists.
    const offs: Array<() => void> = []
    let offWelcome: (() => void) | null = null
    let heard: unknown = null
    const recompute = () => {
      const client = fleet.clientFor(machineId)
      setEnabled(client !== null && client.hasCap('multiplex'))
      if (client !== null && heard !== client) {
        heard = client
        offWelcome?.()
        offWelcome = client.onWelcome(recompute)
      }
    }
    recompute()
    offs.push(fleet.onFleet(recompute))
    return () => {
      for (const off of offs) off()
      offWelcome?.()
    }
  }, [fleet, machineId, parentId])

  // One resolution in flight at a time: a chord tapped thrice while the list
  // round-trip is out must not spawn three scratches.
  const resolving = useRef(false)
  const openRef = useRef(open)
  openRef.current = open

  const dismiss = useCallback(() => {
    // Detach only — the Terminal's unmount does that by itself. The shell
    // runs on; that is the point.
    setOpen(null)
  }, [])

  const toggle = useCallback(() => {
    if (openRef.current !== null) {
      setOpen(null)
      return
    }
    if (parentId === null || resolving.current) return
    const client = fleet.clientFor(machineId)
    if (client === null || !client.hasCap('multiplex')) return

    // Resolve against the daemon's own list rather than the fleet's rows,
    // which hide ephemeral sessions on purpose: the running scratch this
    // parent already has is exactly what those rows will not say.
    resolving.current = true
    const offs: Array<() => void> = []
    const settle = () => {
      resolving.current = false
      for (const off of offs) off()
    }

    const anchor = parentId
    const adopt = (rows: SessionInfo[]) => {
      const existing = rows.find(
        (s) => s.group === anchor && s.ephemeral === true && s.state === 'running',
      )
      if (existing !== undefined) {
        settle()
        setOpen({ machineId, sessionId: existing.id, parentId: anchor })
        return
      }
      const cwd = rows.find((s) => s.id === anchor)?.cwd
      const reqId = client.spawn({
        cwd,
        cols: SPAWN_COLS,
        rows: SPAWN_ROWS,
        group: anchor,
        ephemeral: true,
      })
      if (reqId === null) {
        settle()
        return
      }
      offs.push(
        client.onAttached((a) => {
          if (a.reqId !== reqId) return
          settle()
          // Hand the ref straight back — the modal's Terminal attaches for
          // itself, exactly as every navigation target does.
          client.detach(a.ref)
          setOpen({ machineId, sessionId: a.id, parentId: anchor })
        }),
        client.onError((e) => {
          if (e.reqId === reqId) settle()
        }),
      )
    }

    let answered = false
    offs.push(
      client.onSessions((rows) => {
        // The first list after the ask answers the "is one already running"
        // question; later ones are other screens' polls.
        if (answered) return
        answered = true
        adopt(rows)
      }),
      // Replies do not survive their socket.
      client.onStatus((s) => {
        if (s !== 'open') settle()
      }),
    )
    client.list()
  }, [fleet, machineId, parentId])

  const toggleRef = useRef(toggle)
  toggleRef.current = toggle
  const enabledRef = useRef(enabled)
  enabledRef.current = enabled

  /*
   * The chord, in the capture phase for the switcher's reason: left to
   * bubble, xterm turns keys into bytes before anything above it runs. A
   * bare Ctrl tap sends nothing to the pty, so listening costs the terminal
   * nothing; the detector (scratch/double-ctrl.ts) is what keeps a real
   * Ctrl+C chord from counting as half a tap.
   *
   * Escape, while the modal is up, dismisses — also captured, and stopped,
   * so it cannot double as input to the scratch shell it is closing.
   */
  useEffect(() => {
    const chord = createDoubleCtrl()
    const onKeyDown = (e: KeyboardEvent) => {
      if (openRef.current !== null && e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        chord.reset()
        setOpen(null)
        return
      }
      if (chord.keydown(e) && (enabledRef.current || openRef.current !== null)) {
        toggleRef.current()
      }
    }
    const onKeyUp = (e: KeyboardEvent) => {
      if (chord.keyup(e) && (enabledRef.current || openRef.current !== null)) {
        toggleRef.current()
      }
    }
    const onFocusLost = () => chord.reset()
    // The focus-loss event's name is spelled in two halves because it is also
    // a Tailwind utility name, and a quoted string of it in any scanned
    // source compiles a stray rule into the shipped stylesheet — see the
    // scanner notes at the top of src/styles.css and styles.build.test.ts.
    const focusLost = 'blu' + 'r'
    window.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('keyup', onKeyUp, true)
    window.addEventListener(focusLost, onFocusLost)
    return () => {
      window.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('keyup', onKeyUp, true)
      window.removeEventListener(focusLost, onFocusLost)
    }
  }, [])

  const client = open !== null ? fleet.clientFor(open.machineId) : null

  const keep = useCallback(() => {
    if (openRef.current === null) return
    const c = fleet.clientFor(openRef.current.machineId)
    // Clearing the flag is the promotion: the daemon moves it to ordinary
    // retention and stops tying it to the parent, and the refreshed list
    // surfaces it as a member — a pane in the group view — now rather than
    // on the fleet's next three-second poll.
    c?.update({ id: openRef.current.sessionId, ephemeral: false })
    c?.list()
    setOpen(null)
  }, [fleet])

  // Memoised, and load-bearing rather than tidy: every terminal's control
  // strip reads this context for its chip, and a fresh value object per
  // provider render would re-render every mounted terminal on every
  // navigation this provider sees.
  const scratch = useMemo(() => ({ toggle, enabled }), [toggle, enabled])

  return (
    <ScratchContext.Provider value={scratch}>
      {children}
      <Dialog.Root open={open !== null && client !== null} onOpenChange={(o) => !o && dismiss()}>
        <Dialog.Portal>
          {/* A dim and nothing frosted: the session underneath is what the scratch
              is *about*, and frosting it over reads as leaving the page. */}
          <Dialog.Overlay className="fixed inset-0 z-50 bg-black/25" />
          <Dialog.Content
            aria-describedby={undefined}
            onEscapeKeyDown={(e) => e.preventDefault()}
            // Autofocus is refused so the terminal keeps the keyboard it
            // takes for itself on mount. Radix would otherwise focus the
            // first tabbable — the Keep button — and the first Enter typed
            // at the shell would silently promote the scratch instead.
            onOpenAutoFocus={(e) => e.preventDefault()}
            // The switcher's box, deliberately: same width, same anchor
            // height, same popover surface and hairline — the two overlays a
            // chord can summon should read as siblings.
            className={
              'fixed inset-0 z-50 flex flex-col overflow-hidden bg-popover text-popover-foreground outline-none ' +
              'sm:inset-auto sm:top-[12vh] sm:left-1/2 sm:h-[64vh] sm:w-[56rem] sm:max-w-[calc(100vw-2rem)] sm:-translate-x-1/2 ' +
              'sm:rounded-lg sm:shadow-high sm:ring-1 sm:ring-hairline'
            }
          >
            {/*
              The frame is one slim header: hairline, a quiet title, the two
              verbs. The Terminal below renders minimal chrome, so nothing in
              it navigates away from under the dialog.
            */}
            <div className="flex h-11 shrink-0 items-center gap-x-2 border-b border-hairline pr-1.5 pl-3 sm:h-9">
              <SquareTerminalIcon
                aria-hidden="true"
                className="size-4 shrink-0 text-muted-foreground"
              />
              <Dialog.Title className="min-w-0 flex-1 truncate text-base font-medium text-foreground sm:text-control">
                Scratch terminal
              </Dialog.Title>
              <kbd className="font-mono text-xs text-muted-foreground max-sm:hidden">esc</kbd>
              <Button
                variant="ghost"
                size="sm"
                onClick={keep}
                title="Keep this shell as a real session in this group"
                className="text-muted-foreground"
              >
                Keep
              </Button>
              <Dialog.Close asChild>
                <Button variant="ghost" size="icon-sm" className="text-muted-foreground">
                  <XIcon aria-hidden="true" />
                  <span className="sr-only">Dismiss the scratch terminal</span>
                </Button>
              </Dialog.Close>
            </div>
            <div className="relative min-h-0 w-full flex-1">
              {open !== null && client !== null && (
                <FlueClientContext.Provider value={client}>
                  <Terminal
                    key={`${open.machineId}:${open.sessionId}`}
                    sessionId={open.sessionId}
                    chrome="minimal"
                    ownsTitle={false}
                    fitViewport={isMobile}
                    viewportInset={isMobile ? HEADER_PX : 0}
                    // The exit is the close now: typing `exit` in a scratch
                    // puts the modal away, and the fast ephemeral reap does
                    // the rest.
                    onClosed={dismiss}
                  />
                </FlueClientContext.Provider>
              )}
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </ScratchContext.Provider>
  )
}
