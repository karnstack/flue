import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { useNavigate, useRouterState } from '@tanstack/react-router'

import { SessionSwitcher } from '@/components/session-switcher'
import { useFleet } from '@/fleet/provider'
import { keyOf, LOCAL_MACHINE_ID, type FleetSession, type MachineState } from '@/fleet/types'
import { displayName } from '@/sessions/view'
import { matchChord, isApplePlatform } from './keys'
import { cycleOrder, stepCycle } from './order'
import { forgetVisit, listRecents, recordVisit, visitKey, type RecentVisit } from './recents'

/**
 * The terminal's address, written out rather than imported from src/router.tsx.
 *
 * Importing it would close a cycle — the router mounts this provider — and the
 * literal is not unchecked: `to` is typed against the registered route tree, so
 * a path that drifts is a compile error. src/routes/terminal.tsx carries the
 * same literal for the same reason.
 */
const TERMINAL_PATH = '/d/$deviceId/s/$sessionId'

/** 80x24 is a starting point, not a decision; the terminal corrects it. */
const SPAWN_COLS = 80
const SPAWN_ROWS = 24

interface Switcher {
  open(): void
}

const SwitcherContext = createContext<Switcher | null>(null)

/**
 * The one session switcher, and the chords that reach it.
 *
 * Mounted above every screen that can see a daemon, because a chord that works
 * on some routes and not others is a chord nobody trusts. It sits inside the
 * fleet rather than beside it: the palette's whole subject is every machine's
 * sessions at once, and the fleet is the only thing that holds them.
 *
 * Closed, this costs one keydown listener and one fleet subscription that
 * writes to a ref and renders nothing. That subscription is not idle bookkeeping
 * — ⌃⇧1..9 and ⌃⇧[ ] have to answer without opening anything, so the rows have
 * to be to hand — but it must not re-render the app three times a minute for
 * the sake of a palette nobody has opened, which is why it lands in a ref and
 * the open palette subscribes for itself.
 */
export function SwitcherProvider({ children }: { children: ReactNode }) {
  const fleet = useFleet()
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const [sessions, setSessions] = useState<FleetSession[]>([])
  const [recents, setRecents] = useState<RecentVisit[]>(() => listRecents())

  /*
   * Which session this tab is in, read off the deepest match rather than with
   * useParams.
   *
   * This component is rendered by the *root* route, and a param hook resolves
   * against the match it is called from — so useParams here answers for the
   * root, which has no params at all, on every route including the terminal.
   * The leaf match is the one that matched `/d/$deviceId/s/$sessionId`, and on
   * every other screen its params are simply empty, which is the honest
   * description of a tab that is not in a session.
   */
  const params = useRouterState({
    select: (s) =>
      (s.matches[s.matches.length - 1]?.params ?? {}) as {
        deviceId?: string
        sessionId?: string
      },
  })
  const currentKey =
    params.deviceId !== undefined && params.sessionId !== undefined
      ? `${params.deviceId}/${params.sessionId}`
      : null

  /** What the chords read when the palette is shut and nothing has rendered. */
  const snapshot = useRef<{ sessions: FleetSession[]; machines: MachineState[] }>({
    sessions: [],
    machines: [],
  })
  const openRef = useRef(open)
  openRef.current = open
  const currentRef = useRef(currentKey)
  currentRef.current = currentKey

  const go = useCallback(
    (target: { machineId: string; sessionId: string }) => {
      void navigate({
        to: TERMINAL_PATH,
        params: { deviceId: target.machineId, sessionId: target.sessionId },
      })
    },
    [navigate],
  )

  useEffect(() => {
    return fleet.onFleet((rows, machines) => {
      snapshot.current = { sessions: rows, machines }
      // Only the open palette pays for a poll. Closed, this listener has done
      // its whole job by writing the ref above.
      if (openRef.current) setSessions(rows)
    })
  }, [fleet])

  /*
   * Opening, which is three state updates and has to be exactly one render.
   *
   * The rows cannot be handed over in an effect after the opening render. The
   * palette settles its arrangement the moment it is told it is open — that is
   * what stops the list re-sorting under the reader — so a first render with
   * `sessions` still empty settles an empty arrangement, and the rows arriving
   * a tick later change nothing the reader can see. React batches these three
   * into one render, so the palette's first sight of itself is a full one.
   */
  const openPalette = useCallback(() => {
    setSessions(snapshot.current.sessions)
    setRecents(listRecents())
    setOpen(true)
  }, [])

  /*
   * Writing down where this tab is.
   *
   * Only once the fleet is actually reporting the session, because the visit
   * record doubles as the description a ghost row is drawn from and a record
   * written from the URL alone would have no name, no directory and no machine
   * to show. Re-written when any of those three change, so a session renamed
   * while it is open is remembered under its new name — and not otherwise, or
   * this would rewrite storage every three seconds for as long as a terminal
   * is open.
   */
  const written = useRef<string | null>(null)
  useEffect(() => {
    const off = fleet.onFleet((rows, machines) => {
      const key = currentRef.current
      if (key === null) return
      const row = rows.find((s) => keyOf(s) === key)
      if (row === undefined) {
        // A session the fleet cannot see, on a machine that is answering
        // perfectly well, is not asleep — it is gone. Forgetting it is what
        // keeps the palette's ghosts to sessions that can still be woken.
        const machine = machines.find((m) => m.id === key.split('/')[0])
        if (machine?.status === 'online') {
          const [machineId, sessionId] = key.split('/') as [string, string]
          forgetVisit({ machineId, sessionId })
        }
        return
      }
      const visit = {
        machineId: row.machineId,
        machineName: row.machineName,
        sessionId: row.id,
        label: displayName(row),
        cwd: row.cwd,
      }
      const signature = `${key}|${visit.label}|${visit.cwd}|${visit.machineName}`
      if (written.current === signature) return
      written.current = signature
      recordVisit(visit)
    })
    return () => {
      off()
      written.current = null
    }
  }, [fleet, currentKey])

  /*
   * The chords.
   *
   * Capture, and stopped here, for the reason terminal.tsx gives about its own:
   * left to bubble, xterm's handler on the helper textarea would have turned
   * the keystroke into bytes and sent it to a shell before this ran.
   */
  useEffect(() => {
    const apple = isApplePlatform()
    const onKey = (e: KeyboardEvent) => {
      const chord = matchChord(e, apple)
      if (chord === null) return
      // An open palette owns its own keyboard. Only the chord that opened it
      // still means anything out here, and what it means is "shut".
      if (openRef.current) {
        if (chord.kind !== 'open') return
        e.preventDefault()
        e.stopPropagation()
        setOpen(false)
        return
      }
      e.preventDefault()
      e.stopPropagation()
      if (chord.kind === 'open') {
        openPalette()
        return
      }
      const rows = snapshot.current.sessions
      if (chord.kind === 'pinned') {
        const pinned = cycleOrder(rows.filter((s) => s.pinned))
        const target = pinned[chord.index - 1]
        if (target) go({ machineId: target.machineId, sessionId: target.id })
        return
      }
      const target = stepCycle(cycleOrder(rows), currentRef.current, chord.kind === 'next' ? 1 : -1)
      if (target) go({ machineId: target.machineId, sessionId: target.id })
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [go, openPalette])

  const peek = useCallback(
    (target: { machineId: string; sessionId: string }) =>
      fleet.peekOn(target.machineId, target.sessionId, 24 << 10),
    [fleet],
  )

  /*
   * The dead end turned into an action: start a session where this tab already
   * is, and go to it.
   *
   * Click-driven only, which is what makes it safe — a spawn fired from a mount
   * effect runs twice under StrictMode and can only ever detach one of its
   * shells. The listeners are per spawn and on the client that carries it,
   * because `spawn` is answered by an `attached` that names its reqId and
   * nothing else correlates the two.
   */
  const spawnHere = useCallback(() => {
    const machineId = params.deviceId ?? LOCAL_MACHINE_ID
    const client = fleet.clientFor(machineId)
    if (client === null) return
    const cwd = snapshot.current.sessions.find((s) => keyOf(s) === currentRef.current)?.cwd
    const reqId = client.spawn({ cwd, cols: SPAWN_COLS, rows: SPAWN_ROWS })
    if (reqId === null) return
    const offs: Array<() => void> = []
    const settle = () => {
      for (const off of offs) off()
    }
    offs.push(
      client.onAttached((a) => {
        if (a.reqId !== reqId) return
        settle()
        // Hand the ref straight back: the route this navigates to attaches on
        // its own, exactly as the sessions screen does.
        client.detach(a.ref)
        go({ machineId, sessionId: a.id })
      }),
      client.onError((e) => {
        if (e.reqId === reqId) settle()
      }),
      // Replies do not survive their socket: an answer an outage carried away
      // is never coming.
      client.onStatus((s) => {
        if (s !== 'open') settle()
      }),
    )
  }, [fleet, go, params.deviceId])

  /*
   * What the dead-end row offers, or null when there is no machine to offer it
   * on — a relay tab whose machine is down should not put a button on screen
   * that cannot do anything.
   *
   * Read from the rendered rows rather than from the snapshot ref, so the label
   * is drawn from the same list the reader is looking at.
   */
  const here = sessions.find((s) => keyOf(s) === currentKey)
  const spawnMachine = params.deviceId ?? LOCAL_MACHINE_ID
  const spawnLabel =
    fleet.clientFor(spawnMachine) === null
      ? null
      : here
        ? `New session in ${here.cwd}`
        : 'New session'

  return (
    <SwitcherContext.Provider value={{ open: openPalette }}>
      {children}
      <SessionSwitcher
        open={open}
        onOpenChange={setOpen}
        sessions={sessions}
        recents={recents}
        currentKey={currentKey}
        peek={peek}
        onPick={go}
        onSpawn={spawnHere}
        spawnLabel={spawnLabel}
      />
    </SwitcherContext.Provider>
  )
}

/**
 * Open the switcher from a control rather than a chord.
 *
 * The reason it exists is the phone: a coarse pointer has no Ctrl and no Cmd,
 * so without a button the palette would be a feature only laptops have.
 */
export function useSwitcher(): Switcher {
  const switcher = useContext(SwitcherContext)
  // Not a throw, unlike useFleet: the terminal's control strip renders in tests
  // that mount the component on its own, and a chip that quietly does nothing
  // there is better than a test suite that has to know about this provider.
  return switcher ?? { open: () => {} }
}
