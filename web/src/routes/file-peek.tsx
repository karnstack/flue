import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { useParams, useSearch } from '@tanstack/react-router'

import { FlueClientContext } from '@/client/provider'
import type { FlueClient } from '@/client/client'
import { FileContents, FileHeader } from '@/files/contents'
import { useFleet } from '@/fleet/provider'
import { MachineNotPaired } from '@/routes/terminal'

/**
 * This page's path, written out rather than imported from src/router.tsx for
 * the terminal route's reason: the router imports this component, so the
 * import would close a cycle. The literal is typed against the registered
 * route tree, so a path that drifts is a compile error.
 */
const FILE_PATH = '/d/$deviceId/s/$sessionId/file' as const

/**
 * What the address may carry: the one file it names. Narrowed to a string or
 * emptied, so a mangled link — `path` repeated parses to an array — lands on
 * the page's refusal rather than going out on the wire. The router's own
 * search serialisation is what carries the percent-encoding both ways.
 */
export function validateFilePeekSearch(search: Record<string, unknown>): { path: string } {
  return { path: typeof search.path === 'string' ? search.path : '' }
}

/**
 * A file over a session as a page of its own: where the viewer's
 * open-in-new-tab lands. Full-bleed beside the terminal rather than under
 * the shell, because the tab is the file and app chrome around it would
 * answer a question nobody asked.
 *
 * The client is resolved the way the terminal route resolves its own —
 * through a fleet subscription, because a window.open tab renders before the
 * fleet has adopted a remote machine's sources, and the moment of adoption
 * has to reach this page as a re-render.
 */
export function FilePeekRoute() {
  const { deviceId, sessionId } = useParams({ from: FILE_PATH })
  const { path } = useSearch({ from: FILE_PATH })
  const fleet = useFleet()
  const client = useSyncExternalStore(
    useCallback((onChange: () => void) => fleet.onFleet(onChange), [fleet]),
    () => fleet.clientFor(deviceId),
  )
  const ready = useSocketOpen(client)

  // The browser tab is named for the file, and gives the name back on the
  // way out — this page can be navigated away from within a running app.
  const base = path.slice(path.lastIndexOf('/') + 1)
  useEffect(() => {
    if (base === '') return
    const prior = document.title
    document.title = base
    return () => {
      document.title = prior
    }
  }, [base])

  if (path === '') {
    return (
      <p role="alert" className="px-4 py-3 text-control text-destructive">
        Not a usable path.
      </p>
    )
  }
  if (client === null) return <MachineNotPaired />
  return (
    <FlueClientContext.Provider value={client}>
      <div className="flex h-full w-full flex-col overflow-hidden bg-popover text-popover-foreground">
        {ready ? (
          <FileContents
            sessionId={sessionId}
            target={{ path }}
            header={(view) => <FileHeader view={view} />}
          />
        ) : (
          <p role="status" className="flex-1 px-4 py-3 text-control text-muted-foreground">
            Opening…
          </p>
        )}
      </div>
    </FlueClientContext.Provider>
  )
}

/**
 * Whether the client has carried its socket up, latched once per client.
 *
 * A cold tab is what window.open makes, and `read` refuses on a socket that
 * is not open yet — so the body waits for the first open rather than asking
 * into the void. Latched rather than tracked, because a blip mid-stream is
 * the read's own story to tell: the body answers it the way the modal
 * viewer always has.
 */
function useSocketOpen(client: FlueClient | null): boolean {
  const [ready, setReady] = useState(() => client !== null && client.status === 'open')
  useEffect(() => {
    if (client === null) {
      setReady(false)
      return
    }
    setReady(client.status === 'open')
    return client.onStatus((s) => {
      if (s === 'open') setReady(true)
    })
  }, [client])
  return ready
}
