import { useNavigate, useParams } from '@tanstack/react-router'

import { FlueClientContext } from '@/client/provider'
import { Terminal } from '@/components/terminal'
import { useFleet } from '@/fleet/provider'

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
  const client = useFleet().clientFor(deviceId)
  // A machine the fleet does not hold: never paired on this browser, or its
  // pinned key gone. There is no connection to attach with and no amount of
  // waiting will produce one, so this reads like the terminal's own answer to
  // a session the daemon has never heard of — final, and said in a pill.
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
      />
    </FlueClientContext.Provider>
  )
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
