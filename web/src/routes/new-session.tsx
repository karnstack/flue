import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useNavigate, useSearch } from '@tanstack/react-router'

import { Button } from '@/components/ui/button'
import { useFleet } from '@/fleet/provider'
import { LOCAL_MACHINE_ID } from '@/fleet/types'
import { cn } from '@/lib/utils'
import type { NewSessionSearch } from '@/sessions/new-session'

/**
 * The terminal's path, written out rather than imported from src/router.tsx —
 * importing it would close a cycle, since the router imports this component.
 * The literal is not unchecked: `to` is typed against the registered route
 * tree, so a path that drifts is a compile error.
 */
const TERMINAL_PATH = '/d/$deviceId/s/$sessionId' as const

/** This page's own path, and its route id, for the typed search hook. */
const NEW_SESSION_PATH = '/new' as const

/**
 * The error a spawn is answered with when it is not answered with a session.
 * `internal/daemon/conn.go`, `case wire.Spawn`: the error path returns before
 * `attachTo`, so a failed spawn produces this and nothing else, ever.
 */
const SPAWN_FAILED = 'spawn_failed'

/** What this page is doing, which is the whole of what it renders. */
type Phase =
  /** The machine is not carrying a socket yet. Every cold tab starts here. */
  | { kind: 'waiting' }
  /** Asked, unanswered. */
  | { kind: 'starting' }
  /** The daemon refused, or the connection went before it answered. */
  | { kind: 'failed'; why: string }
  /** An address naming a machine the fleet does not hold. */
  | { kind: 'unknown' }

/**
 * The page that starts a session and then gets out of the way.
 *
 * It exists because starting one takes a round trip. `spawn` carries no id —
 * the daemon invents it and says so in `attached` — so a screen that wanted to
 * open the new session in its own tab had to spawn, wait, and then call
 * window.open from the reply, which Safari refuses outright and Chrome refuses
 * once the gesture has aged out. A link to this page opens on the click
 * itself, and the asking happens here, where nothing is racing a popup
 * blocker.
 *
 * It also replaces `/?cwd=` as the way the terminal's own `+` starts one. That
 * address is the sessions dashboard, so a new session used to come up behind
 * the entire list — page, shell, rows and all — for as long as the daemon took
 * to answer. This renders one pill on the terminal's own ground, and replaces
 * itself with the terminal the moment there is a session to show.
 *
 * Name and tags are applied here rather than left to the reader, and they have
 * to be: `spawn` carries no metadata at all, so the earliest moment either can
 * be sent is the first in which the session has an id.
 *
 * `replace`, so the back button leaves rather than starting a second session.
 */
export function NewSessionRoute() {
  const fromUrl = useSearch({ from: NEW_SESSION_PATH })
  const navigate = useNavigate()
  const fleet = useFleet()

  /**
   * The request, read off the address once and held.
   *
   * A ref rather than the hook's own answer, and not for tidiness: the effect
   * below acts on `tags`, which is an array, and an array in a dependency list
   * is compared by identity. One re-render that hands back a fresh one would
   * re-run the whole effect, and the only thing standing between that and a
   * second shell would be the guard inside it. This page reads the URL exactly
   * once, so saying so is both honest and the fix.
   */
  const want = useRef<NewSessionSearch | undefined>(undefined)
  want.current ??= fromUrl
  const search = want.current

  const machineId = search.d ?? LOCAL_MACHINE_ID
  const [phase, setPhase] = useState<Phase>({ kind: 'waiting' })
  /**
   * Which attempt this is. Retry bumps it, which re-runs the effect below
   * with a fresh guard — and only ever on a press, because a page that
   * re-spawned by itself on every reconnect would leave a session behind for
   * each reply the outage carried away.
   */
  const [attempt, setAttempt] = useState(0)

  /**
   * The attempt a spawn has already been sent for, and the request it went out
   * under.
   *
   * Refs rather than state, and that is what makes one press one session. The
   * effect below can be entered more than once for a single attempt — the
   * socket opening after the effect body has already looked at it, a mount
   * effect double-invoked in development — and the daemon deduplicates
   * nothing, because `spawn` carries no key it could deduplicate on. A guard
   * in state would be reset by the very remount it is there to survive.
   *
   * The reqId is a ref for the second half of the same story: whichever run of
   * the effect is listening has to recognise the answer to a spawn an earlier
   * one sent.
   *
   * The suite covers the socket half of that — a redial after a spawn that
   * was never answered sends nothing on the new socket — and not the
   * development remount, which cannot be staged: TanStack renders a match
   * through its own Suspense boundary, and React does not simulate a remount
   * inside one, so a StrictMode wrapper in a test proves nothing either way.
   */
  const sentFor = useRef(-1)
  const reqId = useRef<number | null>(null)

  useEffect(() => {
    const client = fleet.clientFor(machineId)
    if (client === null) {
      setPhase({ kind: 'unknown' })
      return
    }

    const send = () => {
      if (sentFor.current === attempt) return
      // 80x24 is a starting point, not a decision; the terminal corrects it
      // the moment it can measure a pane.
      const id = client.spawn({ cwd: search.cwd, cols: 80, rows: 24 })
      // Null is a socket that is down. The status listener below sends on the
      // next open, which is what a cold tab always takes.
      if (id === null) return
      sentFor.current = attempt
      reqId.current = id
      setPhase({ kind: 'starting' })
    }

    const offs = [
      client.onAttached((a) => {
        if (a.reqId !== reqId.current) return
        reqId.current = null
        // The one moment either of these can be sent: `spawn` carries no
        // metadata, so until now there was no id to address the edit to.
        const patch: { id: string; name?: string; tags?: string[] } = { id: a.id }
        if (search.name !== undefined) patch.name = search.name
        if (search.tags !== undefined) patch.tags = search.tags
        if (patch.name !== undefined || patch.tags !== undefined) client.update(patch)
        // Hand the ref straight back: this page renders no terminal, and the
        // route it navigates to attaches on its own.
        client.detach(a.ref)
        void navigate({
          to: TERMINAL_PATH,
          params: { deviceId: machineId, sessionId: a.id },
          replace: true,
        })
      }),
      client.onError((e) => {
        if (e.reqId !== reqId.current) return
        reqId.current = null
        if (e.code === SPAWN_FAILED) setPhase({ kind: 'failed', why: e.msg })
      }),
      client.onStatus((s) => {
        if (s === 'open') {
          send()
          return
        }
        // A reply does not survive its socket. Whether the daemon got as far
        // as starting a shell is genuinely unknown from here, which is why
        // this says what happened rather than asking again: a silent retry
        // would leave a session behind for every answer an outage swallowed.
        if (reqId.current === null) return
        client.abandon(reqId.current)
        reqId.current = null
        setPhase({
          kind: 'failed',
          why: 'The connection went before the daemon answered. It may have started one anyway — check the sessions list before trying again.',
        })
      }),
    ]

    if (client.status === 'open') send()

    return () => {
      for (const off of offs) off()
    }
    // `search` is the held ref above, stable for the life of the page, so it
    // is deliberately absent from here: what re-runs this is a retry and
    // nothing else.
  }, [fleet, machineId, navigate, attempt])

  return (
    <Pane>
      {phase.kind === 'unknown' ? (
        <Pill dim>This machine is not paired on this browser</Pill>
      ) : phase.kind === 'failed' ? (
        <Pill dim detail={phase.why}>
          Could not start a session
          <Button
            variant="ghost"
            size="sm"
            className="-my-1 text-inherit hover:bg-white/10 hover:text-inherit"
            onClick={() => setAttempt((n) => n + 1)}
          >
            Retry
          </Button>
        </Pill>
      ) : (
        <Pill>{phase.kind === 'waiting' ? 'Connecting to the flue daemon…' : 'Starting…'}</Pill>
      )}
    </Pane>
  )
}

/**
 * The terminal's own ground, so the session this becomes does not arrive as a
 * change of scenery. This route sits outside AppShell for the same reason the
 * terminal does: what it is on its way to being *is* the tab.
 */
function Pane({ children }: { children: ReactNode }) {
  return (
    <div className="relative h-full w-full overflow-hidden bg-white dark:bg-zinc-950">
      <div className="absolute top-3 right-3 z-10">{children}</div>
    </div>
  )
}

/**
 * The terminal's status pill, in the same corner and the same clothes: dark in
 * both themes, over a translucent ground. The dot pulses while an answer is
 * still expected and holds still once waiting will not change anything, which
 * is the same sentence the terminal's own pill tells.
 */
function Pill({
  children,
  detail,
  dim = false,
}: {
  children: ReactNode
  detail?: string
  dim?: boolean
}) {
  return (
    <div
      role="status"
      className="max-w-xs rounded-lg bg-zinc-900/90 px-3 py-1.5 text-base/4 font-medium text-zinc-100 shadow-lg ring-1 ring-white/10 backdrop-blur-sm sm:text-sm/4"
    >
      <span className="flex items-center gap-x-2">
        <span
          aria-hidden="true"
          className={cn(
            'size-1.5 shrink-0 rounded-full',
            dim ? 'bg-zinc-500' : 'bg-zinc-100 motion-safe:animate-pulse',
          )}
        />
        {children}
      </span>
      {detail !== undefined && detail !== '' && (
        <span className="mt-0.5 block pl-3.5 text-xs/5 font-normal text-zinc-400">{detail}</span>
      )}
    </div>
  )
}
