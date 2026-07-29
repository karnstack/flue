import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'

import type { ConnStatus } from '@/client/client'
import { useFlueClient } from '@/client/provider'
import type { SessionInfo } from '@/client/protocol'
import { SessionTable } from '@/components/session-table'
import { Button } from '@/components/ui/button'

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
 * key the daemon could deduplicate on. A view that spawned from a mount effect
 * would start two shells on every mount in development, where React runs mount
 * effects twice, and could only ever detach one of them. So a session is only
 * ever started by a click, and the terminal is reached by navigating to a
 * session that already exists.
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
   * Spawns this screen has asked for and not yet seen answered.
   *
   * The daemon attaches whoever spawns, so a spawn is answered with an
   * `attached` and nothing else — and `attached` names the session it created,
   * never the request it answers. One client serves the whole tab, so this
   * listener also sees replies that belong to nobody here, such as a reattach
   * replayed after a reconnect. Counting what was asked for is what keeps one
   * of those from navigating the user somewhere they never chose.
   *
   * A ref rather than state: it is read inside an effect that must not be torn
   * down and rebuilt every time the count moves, and nothing renders from it.
   */
  const owed = useRef(0)

  useEffect(() => {
    const offs = [
      client.onSessions(setSessions),

      client.onStatus((s) => {
        setStatus(s)
        // A notice is about a moment, and the connection changing state ends
        // that moment: "Not connected" is wrong the instant the socket is back.
        setNotice(null)
        // A spawn whose reply the outage carried away is never answered.
        // Leaving that debt on the books would hand the next reattach to land
        // — on a connection this screen knows nothing about — to a navigation
        // nobody asked for. Counts do not survive their socket, for the same
        // reason FlueClient clears its own on teardown.
        if (s !== 'open') owed.current = 0
      }),

      client.onError((e) => {
        // A spawn that failed is answered with an error and never with an
        // `attached`, so the debt above has to be written off here or the next
        // unrelated reply would be mistaken for it.
        if (e.code !== 'spawn_failed') return
        if (owed.current > 0) owed.current--
        setNotice(`Could not start a session: ${e.msg}`)
      }),

      client.onAttached((a) => {
        if (owed.current === 0) return
        owed.current--
        // Hand the ref straight back. This screen renders no terminal, and the
        // route it is about to navigate to attaches on its own — so keeping
        // this one would leave a single tab holding two attachments to one
        // session, which is the exact shape FlueClient's reattach plan cannot
        // carry: it holds one entry per session, so the next reconnect would
        // ask once and leave one of the two sitting on a dead ref. Nothing is
        // lost by letting go, because the daemon keeps the scrollback and the
        // terminal asks for it from offset zero.
        client.detach(a.ref)
        void navigate({
          to: TERMINAL_PATH,
          params: { deviceId: LOCAL_DEVICE, sessionId: a.id },
        })
      }),
    ]

    client.list()
    const poll = setInterval(() => client.list(), REFRESH_MS)

    return () => {
      clearInterval(poll)
      for (const off of offs) off()
    }
  }, [client, navigate])

  const open = useCallback(
    (id: string) => {
      void navigate({ to: TERMINAL_PATH, params: { deviceId: LOCAL_DEVICE, sessionId: id } })
    },
    [navigate],
  )

  function startSession() {
    setNotice(null)
    // 80x24 is a starting point, not a decision. The daemon has to open a pty
    // with some dimensions, and the terminal corrects them the moment it can
    // measure a pane: it attaches as primary and asks for the cells that fit.
    if (client.spawn({ cols: 80, rows: 24 })) {
      owed.current++
      return
    }
    // `spawn` is deliberately dropped rather than held while the socket is
    // down, because a shell that appeared minutes later at a screen nobody was
    // looking at is worse than none. Saying so is this screen's job.
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
        </div>
        {/*
          The one filled button on this screen, and it takes its amber from
          --primary rather than naming a colour, so the accent stays a token.
          Every other control here is the bordered variant.
        */}
        <Button size="sm" className="shrink-0" onClick={startSession}>
          New session
        </Button>
      </div>

      {message && (
        <p
          role="status"
          className="max-w-[65ch] text-base/7 text-pretty text-zinc-600 sm:text-sm/6 dark:text-zinc-400"
        >
          {message}
        </p>
      )}

      {sessions !== null && <SessionTable sessions={sessions} onOpen={open} />}
    </div>
  )
}
