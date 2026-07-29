import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'

import type { ConnStatus, FlueClient } from '@/client/client'
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

/**
 * The error a spawn is answered with when it is not answered with a session.
 *
 * **A spawn is settled by exactly one of three things: an `attached`, this, or
 * the connection going away.** Both of the counters in this file — the mounted
 * screen's `owed` and the cleanup's `refuseNext` — have to handle all three,
 * and that is why the list is written down once here rather than left implicit
 * at each site. Missing one is not a count that drifts by one. It is a
 * listener that stays armed for the life of the connection and then acts on
 * somebody else's reply, which is how the first version of `refuseNext`
 * shipped a bug strictly worse than the one it fixed.
 *
 * `internal/daemon/conn.go`, `case wire.Spawn`: the error path returns before
 * `attachTo`, so a failed spawn produces this and nothing else, ever.
 */
const SPAWN_FAILED = 'spawn_failed'

/**
 * Hand back the next `count` attachments this tab is given, then stop.
 *
 * The screen that asked for them is gone. Navigating away inside a spawn's
 * round trip is not exotic — Open sits on every row, the nav links are always
 * there, and this screen's own navigation begins one line before it unmounts —
 * and once the listeners are released nothing is left to refuse the reply.
 * `FlueClient` then adopts it into both its attachment map and its reattach
 * plan, so the daemon streams a session to a tab with nothing behind it and
 * the plan re-establishes that on every reconnect for the life of the tab.
 *
 * Disabling the button only closes the one path a second click takes. This
 * closes all of them, because it is armed by the unmount itself.
 *
 * `attached` names no request, so this is the same shape of heuristic as the
 * counter it drains, and sound for the same reason: one connection answers in
 * order, and nothing else in this tab has a spawn outstanding.
 *
 * Every one of the three settlements above retires this, and none of the three
 * is optional. What each is holding the line against:
 *
 * - **`attached`.** The ordinary case. A reply an *earlier* refusal already
 *   handed back is skipped rather than counted, which `lastSeqFor` can tell
 *   because `detach` drops the ref from the client's attachments. Without that,
 *   two refusals armed in turn would both spend themselves on the first reply
 *   and leave the second unclaimed.
 * - **`spawn_failed`.** No `attached` is ever coming for that spawn, so
 *   without this the refusal never reaches zero. It stays armed and hands back
 *   the next attachment the tab is given — which is a terminal's own. That view
 *   sets its ref and shows itself live on an attachment the client has already
 *   discarded: `sendInput` is gated on `attachments.has(ref)` and the rest on
 *   `sendForRef`, so every keystroke is dropped in silence, no output arrives,
 *   and the session is no longer in `wanted` for a reconnect to repair. A
 *   terminal that is dead and does not say so.
 * - **The connection.** A reply owed on a socket that dropped is never coming,
 *   and a refusal left armed past the outage reaches the next connection's
 *   first `attached` the same way.
 */
function refuseNext(client: FlueClient, count: number) {
  let left = count
  const stop = () => {
    offAttached()
    offFailed()
    offStatus()
  }
  /** One of the `count` spawns has been answered, whichever way. */
  const settle = () => {
    if (--left <= 0) stop()
  }

  const offAttached = client.onAttached((a) => {
    if (client.lastSeqFor(a.ref) === undefined) return
    client.detach(a.ref)
    settle()
  })
  const offFailed = client.onError((e) => {
    if (e.code === SPAWN_FAILED) settle()
  })
  const offStatus = client.onStatus((s) => {
    if (s !== 'open') stop()
  })
}

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
   * A ref rather than state, because it is read inside listeners that must not
   * be torn down and re-registered every time the count moves. `starting`
   * shadows it for the one thing that does render from it, and `owe` is what
   * keeps the two in step.
   */
  const owed = useRef(0)
  const [starting, setStarting] = useState(false)

  // Stable, so the effect below can hold it without re-subscribing: it closes
  // over a ref and a setter, and every instance would behave identically.
  const owe = useCallback((next: number) => {
    owed.current = Math.max(0, next)
    setStarting(owed.current > 0)
  }, [])

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
        if (s !== 'open') owe(0)
      }),

      client.onError((e) => {
        // The second of the three settlements. A spawn that failed is answered
        // with this and never with an `attached`, so the debt has to be written
        // off here or the next unrelated reply would be mistaken for it.
        if (e.code !== SPAWN_FAILED) return
        owe(owed.current - 1)
        setNotice(`Could not start a session: ${e.msg}`)
      }),

      client.onAttached((a) => {
        if (owed.current === 0) return
        // A reply a refusal armed by an earlier mount has already handed back
        // is not this screen's to claim, and `detach` is what makes that
        // legible: it drops the ref from the client's attachments, so
        // `lastSeqFor` no longer knows it. The debt stays owed, because the
        // reply that settles it is still on the wire behind this one.
        if (client.lastSeqFor(a.ref) === undefined) return
        owe(owed.current - 1)
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
      // Whatever this screen asked for and did not live to see answered.
      if (owed.current > 0) refuseNext(client, owed.current)
    }
    // `navigate` is the dep to watch. TanStack memoises it on the router, so it
    // cannot change while this screen is mounted and this effect only ever
    // tears down at a real unmount. If that identity ever became unstable, a
    // re-run mid-spawn would arm a refusal *and* keep `owed` on the same mount,
    // and the two would then race for one reply.
  }, [client, navigate, owe])

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
      owe(owed.current + 1)
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

          Held shut while a spawn is unanswered. That is the cheap half of the
          same problem `refuseNext` exists for: a second click starts a second
          shell whose `attached` arrives after this screen has navigated away
          on the first. Closing the click path here keeps the common case from
          ever reaching the cleanup path at all.
        */}
        <Button size="sm" className="shrink-0" disabled={starting} onClick={startSession}>
          New session
        </Button>
      </div>

      {sessions !== null && <SessionTable sessions={sessions} onOpen={open} />}
    </div>
  )
}
