import { X } from 'lucide-react'
import { Dialog } from 'radix-ui'

import { Button } from '@/components/ui/button'
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
 * overlay, the dialog's focus handling, and the close affordance.
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
