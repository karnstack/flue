import { useParams } from '@tanstack/react-router'

import { Terminal } from '@/components/terminal'

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
 * The deviceId param is matched and ignored. Every session is local until
 * remote transports land, and a route that already carries the device is a
 * route that will not have to change when they do.
 */
export function TerminalRoute() {
  const { sessionId } = useParams({ from: '/d/$deviceId/s/$sessionId' })
  // Keyed by session, so navigating between two sessions builds a new
  // terminal rather than feeding one emulator two sessions' scrollback. The
  // effect's dependency array would do this too; the key makes the state
  // React holds — the phase pill, the keyboard mode — reset with it.
  return <Terminal key={sessionId} sessionId={sessionId} />
}
