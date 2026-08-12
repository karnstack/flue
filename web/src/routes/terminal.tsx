import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { useNavigate, useParams } from '@tanstack/react-router'

import { FlueClientContext } from '@/client/provider'
import { NewSessionDialog } from '@/components/new-session-dialog'
import { Terminal } from '@/components/terminal'
import { useFleet } from '@/fleet/provider'
import type { MachineState } from '@/fleet/types'
import { useOpenNewSession, type NewSessionOrigin } from '@/sessions/open-new-session'

/**
 * The terminal route.
 *
 * It renders bare and full-bleed on purpose: this route sits outside AppShell,
 * because a terminal session *is* the tab and sidebar chrome around it would
 * contradict the premise of the project. `h-full` on the Terminal's own pane
 * is what carries the height down from #root.
 *
 * The route id is written out rather than imported from src/router.tsx, which
 * exports it as TERMINAL_ROUTE_ID. Importing it would close a cycle — the
 * router imports this component — and the literal is not unchecked: `from`
 * is typed against the registered route tree, so a path that drifts is a
 * compile error rather than an empty params object at runtime.
 *
 * The deviceId param is real now. The fleet holds one client per machine this
 * browser can reach, and the segment names which of them the session lives on:
 * `local` is the machine this tab rides — its client is the very one every
 * other screen shares, so that address behaves exactly as it always has — and
 * any other id is a paired machine reached the long way round. The resolved
 * client is handed down through the client context rather than a prop, so the
 * Terminal component keeps not knowing the fleet exists; providing it here
 * comes with no lifecycle attached, because the fleet owns every one of these
 * clients and an unmounting route must not hang one up.
 */
export function TerminalRoute() {
  const { deviceId, sessionId } = useParams({ from: '/d/$deviceId/s/$sessionId' })
  const navigate = useNavigate()
  const fleet = useFleet()
  const openNewSession = useOpenNewSession()
  /**
   * What the `+` in the terminal's control strip is asking for, or null for
   * closed. The dialog is hosted here rather than inside `<Terminal>` because
   * it needs the fleet's machines and the fleet's tags, and that component is
   * deliberately built to work without knowing a fleet exists.
   */
  const [creating, setCreating] = useState<NewSessionOrigin | null>(null)
  // Resolved through a subscription, not read once, because the answer moves:
  // a direct load of a remote machine's session renders before the fleet has
  // adopted its remote sources — those are built only after the local
  // daemon's welcome names the relay — so the first look legitimately finds
  // nothing, and the moment of adoption has to reach this route as a
  // re-render, or a reload of a remote terminal would sit on the not-paired
  // pill for ever. onFleet fires on any reshaping of the fleet, and the
  // snapshot is the slot's own client, whose identity only changes when the
  // answer genuinely has.
  const client = useSyncExternalStore(
    useCallback((onChange: () => void) => fleet.onFleet(onChange), [fleet]),
    () => fleet.clientFor(deviceId),
  )
  // What the dialog needs to fill its machine picker and its tag suggestions.
  const fleetForForm = useFormFleet(fleet)

  // A machine the fleet does not hold: never paired on this browser, or its
  // pinned key gone. Said in a pill, the way the terminal answers a session
  // the daemon has never heard of — though unlike that answer this one is
  // provisional for a breath at boot, which is what the subscription above
  // exists to notice.
  if (client === null) return <MachineNotPaired />
  // Keyed by machine and session, so navigating between two sessions builds a
  // new terminal rather than feeding one emulator two sessions' scrollback.
  // The effect's dependency array would do this too; the key makes the state
  // React holds — the phase pill, the keyboard mode — reset with it.
  return (
    <FlueClientContext.Provider value={client}>
      <Terminal
        key={`${deviceId}:${sessionId}`}
        sessionId={sessionId}
        // replace, both ways: the dead session's URL is not worth a Back stop.
        // The restarted session lives on the same machine, so the address
        // keeps naming it.
        onRestarted={(id) =>
          void navigate({
            to: '/d/$deviceId/s/$sessionId',
            params: { deviceId, sessionId: id },
            replace: true,
          })
        }
        onClosed={() => void navigate({ to: '/', replace: true })}
        // This machine and this directory, because that is what a `+` inside a
        // session means. Both are only a prefill — the dialog offers the rest
        // of the fleet, and a session started from here need not be a sibling.
        onNewSession={(cwd) => setCreating({ machineId: deviceId, cwd: cwd ?? '' })}
      />
      <NewSessionDialog
        open={creating !== null}
        initial={creating ?? {}}
        machines={fleetForForm.machines}
        known={fleetForForm.tags}
        onSubmit={openNewSession}
        onClose={() => setCreating(null)}
      />
    </FlueClientContext.Provider>
  )
}

/** What the new-session form needs off the fleet, and nothing else. */
interface FormFleet {
  machines: Array<{ id: string; name: string }>
  tags: string[]
}

const NO_FLEET: FormFleet = { machines: [], tags: [] }

/** Whether two of those say the same thing, machine for machine and tag for tag. */
function sameFleet(a: FormFleet, b: FormFleet): boolean {
  return (
    a.machines.length === b.machines.length &&
    a.tags.length === b.tags.length &&
    a.machines.every((m, at) => m.id === b.machines[at]?.id && m.name === b.machines[at]?.name) &&
    a.tags.every((t, at) => t === b.tags[at])
  )
}

/**
 * The fleet's online machines and every tag in use across it.
 *
 * Subscribed from mount rather than while the dialog is open, and the
 * comparison above is what makes that affordable: the fleet emits every poll
 * tick, three seconds apart, and almost none of those change either list — so
 * holding the previous object turns a steady drip of re-renders into one per
 * genuine change. The terminal is under this route, and it is the one screen
 * in the app that has to stay smooth.
 *
 * Subscribing early is not merely cheaper than the alternative, it is the only
 * thing that makes the picker correct: a listener wired when the dialog opens
 * would have nothing to show until the next tick, because the fleet replays
 * nothing at subscribe time — and an empty picker reads as "no machine is
 * reachable", which would be a lie told at exactly the wrong moment.
 *
 * The machines are narrowed to the online ones for the same reason the
 * dashboard narrows them: offering a machine that cannot answer is a choice
 * that fails after the form has closed.
 */
function useFormFleet(fleet: ReturnType<typeof useFleet>): FormFleet {
  const [state, setState] = useState<FormFleet>(NO_FLEET)

  useEffect(
    () =>
      fleet.onFleet((sessions, machines: MachineState[]) => {
        const next: FormFleet = {
          machines: machines
            .filter((m) => m.status === 'online')
            .map((m) => ({ id: m.id, name: m.name })),
          tags: [...new Set(sessions.flatMap((s) => s.tags))].sort(),
        }
        setState((prev) => (sameFleet(prev, next) ? prev : next))
      }),
    [fleet],
  )

  return state
}

/**
 * The missing-machine treatment, matched to the missing-session one: the same
 * full-bleed pane the terminal renders, the same pill in the same corner, a
 * dot that holds still because the state is final. Dark in both themes, as
 * the pill is when it floats over a terminal.
 */
function MachineNotPaired() {
  return (
    <div className="relative h-full w-full overflow-hidden bg-white dark:bg-zinc-950">
      <div className="absolute top-3 right-3 z-10">
        <div
          role="status"
          className="rounded-lg bg-zinc-900/90 px-3 py-1.5 text-base/4 font-medium text-zinc-100 shadow-lg ring-1 ring-white/10 backdrop-blur-sm sm:text-sm/4"
        >
          <span className="flex items-center gap-x-2">
            <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-zinc-500" />
            Machine not paired on this browser
          </span>
        </div>
      </div>
    </div>
  )
}
