import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'

import type { ConnStatus } from '@/client/client'
import { useFlueClient } from '@/client/provider'
import type { SessionInfo } from '@/client/protocol'
import { SessionTable } from '@/components/session-table'
import { Button } from '@/components/ui/button'
import { takeCwd } from '@/lib/url'

/**
 * How often the session set is re-read while this screen is on show.
 *
 * The protocol has no push for it: `sessions` only ever answers a `list`, and
 * a session started from another tab or by `flue open` would otherwise never
 * appear. Cheap on loopback, and it stops when this screen does.
 */
const REFRESH_MS = 3_000

/**
 * The terminal's path, written out rather than imported from src/router.tsx.
 *
 * Importing TERMINAL_ROUTE_ID from there would close a cycle, since the router
 * imports this component. The literal is not unchecked: `to` is typed against
 * the registered route tree, so a path that drifts is a compile error.
 *
 * Every session is local until remote transports land. The device is already
 * in the path so that adding them does not move every session's URL.
 */
const TERMINAL_PATH = '/d/$deviceId/s/$sessionId' as const
const LOCAL_DEVICE = 'local'

/**
 * The error a spawn is answered with when it is not answered with a session.
 *
 * A spawn is settled by exactly one of three things: the `attached` or the
 * `error` echoing its reqId, or the connection going away.
 *
 * `internal/daemon/conn.go`, `case wire.Spawn`: the error path returns before
 * `attachTo`, so a failed spawn produces this and nothing else, ever.
 */
const SPAWN_FAILED = 'spawn_failed'

/** What to say about a connection that is not currently carrying anything. */
function connectionNotice(status: ConnStatus): string | null {
  if (status === 'connecting') return 'Connecting to the flue daemon…'
  if (status === 'reconnecting') return 'Lost the flue daemon. Reconnecting…'
  return null
}

/**
 * The session set, and the one place a session is created.
 *
 * Creation lives here rather than in `<Terminal>` because `spawn` carries no
 * key the daemon could deduplicate on: a view that fired one on every mount
 * would start two shells under StrictMode, which mounts everything twice in
 * development, and could only ever detach one of them. Every session but one
 * is started by a click for exactly that reason, and the terminal is reached
 * by navigating to a session that already exists.
 *
 * The one exception is the directory `flue open` hands over in `?cwd=`,
 * sent from this screen's own mount effect by `spawnPendingCwd` — and it
 * survives the double mount on two separate guards, not one. The URL param
 * behind `pendingCwd` is consumed on the very first render, so whichever of
 * the two mounts StrictMode runs second finds the ref already holding the
 * answer rather than reading the URL again; and `pendingCwd` is cleared the
 * instant a spawn actually reaches the daemon, on whichever of the two
 * mounts that turns out to be. The mount that does not get to send one
 * either finds the ref already emptied by the other, or — cold, with the
 * socket still connecting — has had its `onStatus` listener removed by
 * cleanup before the socket ever opens, leaving only the surviving mount's
 * listener to answer it.
 */
export function SessionsRoute() {
  const client = useFlueClient()
  const navigate = useNavigate()
  /**
   * null until the daemon has answered once, which is not the same as an empty
   * set. "No sessions yet" is a claim about the daemon; making it before the
   * first `list` has come back invents it, and every cold load passes through
   * that state on its way to a screen full of rows.
   */
  const [sessions, setSessions] = useState<SessionInfo[] | null>(null)
  // Seeded from the client, because onStatus reports only changes: a screen
  // mounted into a connection that is already up would otherwise sit at
  // "Connecting…" until something else went wrong.
  const [status, setStatus] = useState<ConnStatus>(() => client.status)
  const [notice, setNotice] = useState<string | null>(null)

  /**
   * The reqIds of spawns this screen asked for and has not yet seen
   * answered. A ref, because listeners read it without re-registering;
   * `starting` shadows its emptiness for the one thing that renders.
   */
  const spawns = useRef(new Set<number>())
  const [starting, setStarting] = useState(false)

  /**
   * The directory flue open asked for, taken from the URL exactly once —
   * `undefined` before the first render has looked. Held until the socket
   * can carry the spawn: a cold load from flue open mounts this screen
   * while the client is still connecting.
   */
  const pendingCwd = useRef<string | null | undefined>(undefined)
  if (pendingCwd.current === undefined) pendingCwd.current = takeCwd()

  const settle = useCallback((reqId: number): boolean => {
    if (!spawns.current.delete(reqId)) return false
    setStarting(spawns.current.size > 0)
    return true
  }, [])

  const spawnPendingCwd = useCallback(() => {
    const cwd = pendingCwd.current
    if (typeof cwd !== 'string') return
    const reqId = client.spawn({ cwd, cols: 80, rows: 24 })
    if (reqId === null) return // still down; the next open retries
    pendingCwd.current = null
    spawns.current.add(reqId)
    setStarting(true)
  }, [client])

  useEffect(() => {
    const offs = [
      client.onSessions(setSessions),

      client.onStatus((s) => {
        setStatus(s)
        setNotice(null)
        // Replies do not survive their socket: a spawn whose answer the
        // outage carried away is never coming, and the client cleared its
        // own bookkeeping the same way.
        if (s !== 'open') {
          spawns.current.clear()
          setStarting(false)
        }
        if (s === 'open') spawnPendingCwd()
      }),

      client.onError((e) => {
        // Only an error echoing one of this screen's reqIds is this
        // screen's to act on.
        if (e.reqId === undefined || !settle(e.reqId)) return
        if (e.code === SPAWN_FAILED) setNotice(`Could not start a session: ${e.msg}`)
      }),

      client.onAttached((a) => {
        if (a.reqId === undefined || !settle(a.reqId)) return
        // Hand the ref straight back: this screen renders no terminal, and
        // the route it navigates to attaches on its own.
        client.detach(a.ref)
        void navigate({
          to: TERMINAL_PATH,
          params: { deviceId: LOCAL_DEVICE, sessionId: a.id },
        })
      }),
    ]

    client.list()
    spawnPendingCwd()
    const poll = setInterval(() => client.list(), REFRESH_MS)

    return () => {
      clearInterval(poll)
      for (const off of offs) off()
      // Whatever this screen asked for and did not live to see answered:
      // the client hands each reply back when it lands.
      for (const reqId of spawns.current) client.abandon(reqId)
      spawns.current.clear()
    }
  }, [client, navigate, settle, spawnPendingCwd])

  const open = useCallback(
    (id: string) => {
      void navigate({ to: TERMINAL_PATH, params: { deviceId: LOCAL_DEVICE, sessionId: id } })
    },
    [navigate],
  )

  function startSession() {
    setNotice(null)
    // 80x24 is a starting point, not a decision; the terminal corrects it
    // the moment it can measure a pane.
    const reqId = client.spawn({ cols: 80, rows: 24 })
    if (reqId !== null) {
      spawns.current.add(reqId)
      setStarting(true)
      return
    }
    setNotice('Not connected to the flue daemon, so nothing was started.')
  }

  const message = notice ?? connectionNotice(status)

  return (
    <div className="flex flex-col gap-y-6 p-4 sm:p-6 lg:p-8">
      <div className="flex items-start justify-between gap-x-4">
        <div className="min-w-0">
          <h1 className="text-2xl/8 font-semibold tracking-tight text-zinc-950 sm:text-xl/7 dark:text-white">
            Sessions
          </h1>
          <p className="mt-1 max-w-[65ch] text-base/7 text-pretty text-zinc-600 sm:text-sm/6 dark:text-zinc-400">
            Closing a tab detaches. Whatever the shell is doing carries on.
          </p>
          {/*
            Always rendered, never mounted with its text. Several screen
            readers announce only changes to a live region that was already in
            the accessibility tree, so a region that appears alongside its
            first message is a message nobody hears. Which is also why this is
            not `hidden` when empty: display:none takes it back out of the tree
            and puts the same problem back.

            It sits inside this block rather than below the heading row because
            the column outside is gapped, and a gap is paid for an empty child.
            Empty, this contributes no line box at all, and `empty:mt-0` takes
            the margin with it.
          */}
          <p
            role="status"
            className="mt-3 max-w-[65ch] text-base/7 text-pretty text-zinc-600 empty:mt-0 sm:text-sm/6 dark:text-zinc-400"
          >
            {message}
          </p>
        </div>
        {/*
          The one filled button on this screen, and it takes its amber from
          --primary rather than naming a colour, so the accent stays a token.
          Every other control here is the bordered variant.

          Held shut while a spawn is unanswered. Without it, a second click
          starts a second shell whose `attached` arrives after this screen has
          navigated away on the first, and unmount abandons the reqId it never
          saw settled — this closes the common path before it ever needs to.
        */}
        <Button size="sm" className="shrink-0" disabled={starting} onClick={startSession}>
          New session
        </Button>
      </div>

      {sessions !== null && <SessionTable sessions={sessions} onOpen={open} />}
    </div>
  )
}
