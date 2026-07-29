/**
 * Placeholder. Task 12 replaces this with the xterm view.
 *
 * It renders bare and full-bleed on purpose: this route sits outside
 * AppShell, because a terminal session *is* the tab and sidebar chrome
 * around it would contradict the premise of the project. `h-full` is what
 * carries the height down from #root.
 */
export function TerminalRoute() {
  return <div className="h-full" />
}
