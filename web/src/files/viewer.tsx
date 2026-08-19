import { ExternalLink, X } from 'lucide-react'
import { Dialog } from 'radix-ui'
import { useRouter, type RegisteredRouter } from '@tanstack/react-router'

import { Button } from '@/components/ui/button'
import { LOCAL_MACHINE_ID } from '@/fleet/types'
import { FileContents, FileHeader, type FileTarget } from './contents'

export type { FileTarget }

export interface FileViewerProps {
  sessionId: string
  target: FileTarget
  onClose: () => void
}

/**
 * The modal file peek: FileContents inside a dialog. The streaming, the
 * cache and the body all live in ./contents; what belongs here is the
 * overlay, the dialog's focus handling, the way out to a tab of the file's
 * own, and the close affordance.
 */
export function FileViewer({ sessionId, target, onClose }: FileViewerProps) {
  return (
    <Dialog.Root
      open
      onOpenChange={(stillOpen) => {
        if (!stillOpen) onClose()
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/25" />
        <Dialog.Content
          aria-describedby={undefined}
          onOpenAutoFocus={(e) => {
            e.preventDefault()
            document.querySelector<HTMLElement>('[data-file-body]')?.focus()
          }}
          className={
            'fixed inset-0 z-50 flex flex-col overflow-hidden bg-popover text-popover-foreground outline-none ' +
            'sm:inset-auto sm:top-[8vh] sm:left-1/2 sm:h-[78vh] sm:w-[64rem] sm:max-w-[calc(100vw-2rem)] sm:-translate-x-1/2 ' +
            'sm:rounded-lg sm:shadow-high sm:ring-1 sm:ring-hairline'
          }
        >
          <FileContents
            sessionId={sessionId}
            target={target}
            header={(view) => (
              <FileHeader
                view={view}
                title={
                  <Dialog.Title className="shrink-0 font-heading text-sm font-medium">
                    {view.base}
                  </Dialog.Title>
                }
              >
                <OpenInTab sessionId={sessionId} path={view.shownPath} />
                <Dialog.Close asChild>
                  <Button aria-label="Close file" size="icon-sm" variant="ghost">
                    <X />
                  </Button>
                </Dialog.Close>
              </FileHeader>
            )}
          />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

/**
 * The same file in a tab of its own, with the dialog left standing.
 *
 * The address is built by the router rather than by hand, for the reason
 * useOpenNewSession gives: the file page narrows what arrives with its own
 * schema, the router's serialiser writes the query, and buildLocation is what
 * makes the two agree by construction. Which machine's page comes off the
 * tab's own address — the deepest match's deviceId, exactly the segment the
 * scratch terminal reads — because the viewer's client context rides that
 * same param. Read at the click, not subscribed: it is only ever used here.
 *
 * The hook tolerates the router's absence — some tests mount the viewer
 * bare — by offering nothing, since without an address there is no machine
 * to name.
 */
function OpenInTab({ sessionId, path }: { sessionId: string; path: string }) {
  const router: RegisteredRouter | undefined = useRouter({ warn: false })
  if (router === undefined) return null
  return (
    <Button
      aria-label="Open in new tab"
      size="icon-sm"
      variant="ghost"
      onClick={() => {
        const at = router.state.matches
        const params = (at[at.length - 1]?.params ?? {}) as { deviceId?: string }
        const href = router.buildLocation({
          to: '/d/$deviceId/s/$sessionId/file',
          params: { deviceId: params.deviceId ?? LOCAL_MACHINE_ID, sessionId },
          search: { path },
        }).href
        window.open(href, '_blank', 'noopener')
      }}
    >
      <ExternalLink />
    </Button>
  )
}
