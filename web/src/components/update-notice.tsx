import { useState } from 'react'
import { ArrowUpCircleIcon } from '@heroicons/react/16/solid'

import {
  RelayUpdateDialog,
  updateAvailable,
  useRelayUIInfo,
  type RelayUIInfo,
} from '@/components/cloudflare-connect'
import { Command } from '@/components/copyable'
import { TextLink } from '@/components/text-link'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useDaemonVersion } from '@/hooks/use-daemon-version'
import { useRelease, type ReleaseStatus } from '@/hooks/use-release'
import { RELEASES_URL } from '@/lib/links'

/**
 * The two commands that replace the binary, spelled as the site spells them.
 *
 * Both, rather than a guess at which one was used: nothing on this machine
 * records how flue was installed, and a reader shown the wrong one has to go
 * and find the right one anyway.
 */
const BREW_UPGRADE = 'brew upgrade karnstack/tap/flue'
const SCRIPT_UPGRADE = 'curl -fsSL https://flue.sh/install.sh | sh'

/**
 * Which of the two things is behind, when either is.
 *
 * flue first when both are, and the order is not a preference. The relay is
 * deployed *from* the binary — `internal/relaydeploy` ships the Worker and the
 * web bundle this flue carries — so there is no such thing as a relay newer
 * than the daemon that deployed it. Redeploying the relay before upgrading
 * flue buys a relay that is behind again the moment the upgrade lands.
 */
type Behind = 'flue' | 'relay'

/** Everything behind, in the order it has to be done. */
function whatIsBehind(release: ReleaseStatus | null, info: RelayUIInfo | null): Behind[] {
  const behind: Behind[] = []
  if (release?.update === true) behind.push('flue')
  if (updateAvailable(info)) behind.push('relay')
  return behind
}

/**
 * The sidebar's update notice, and the version line it sits above.
 *
 * One card for two states, because to a reader they are one story told in
 * order: a release comes out, you upgrade the binary, and the relay you
 * deployed from the old one is now the thing that is behind. Two separate
 * notices would put both halves on screen at once and leave the reader to
 * work out which to do first.
 *
 * It replaces a toast in the corner of the screen. A toast was the wrong
 * shape for this: it arrived over whatever was being read, it belonged to no
 * part of the app, and it had to be dismissed before it could be ignored.
 * This is furniture. It sits with the version it is talking about, it moves
 * nothing when it appears, and a reader who does not care can simply not look
 * at the bottom of the sidebar.
 *
 * Neither state exists on a relay origin: `useRelease` refuses to ask there
 * and `useRelayUIInfo` refuses too, so a remote tab renders the plain version
 * line. That is right rather than merely safe — both actions happen on the
 * machine the daemon runs on, and a phone cannot do either.
 */
export function UpdateNotice() {
  const version = useDaemonVersion()
  const release = useRelease()
  const info = useRelayUIInfo()

  const [dismissed, setDismissed] = useState<readonly Behind[]>([])
  const [upgrading, setUpgrading] = useState(false)
  const [redeploying, setRedeploying] = useState(false)

  // One notice at a time, and it is the first thing still outstanding rather
  // than simply the first thing behind. Dismissal is remembered per subject
  // for that reason: sending away "a new flue is out" should uncover the
  // relay notice underneath it — the one the reader can act on from here —
  // not silence both with one click.
  const showing = whatIsBehind(release, info).find((what) => !dismissed.includes(what)) ?? null
  const dismiss = (what: Behind) => setDismissed((held) => [...held, what])

  return (
    <>
      {showing === 'flue' && release?.latest !== undefined && (
        <Notice
          title="Update available"
          detail={
            <>
              <span className="font-mono">{release.latest}</span> is out. This daemon is{' '}
              <span className="font-mono">{release.current}</span>.
            </>
          }
          action="How to update"
          onAction={() => setUpgrading(true)}
          onDismiss={() => dismiss('flue')}
        />
      )}

      {showing === 'relay' && info !== null && (
        <Notice
          title="Relay is behind"
          detail={
            <>
              It is running <span className="font-mono">{info.deployed_version}</span>; this daemon
              is <span className="font-mono">{info.version}</span>.
            </>
          }
          action="Update relay"
          onAction={() => setRedeploying(true)}
          onDismiss={() => dismiss('relay')}
        />
      )}

      {version !== null && <VersionLine version={version} url={release?.url} />}

      <UpgradeDialog
        latest={release?.latest}
        url={release?.url}
        open={upgrading}
        onOpenChange={setUpgrading}
      />
      {info !== null && (
        <RelayUpdateDialog info={info} open={redeploying} onOpenChange={setRedeploying} />
      )}
    </>
  )
}

/**
 * The card itself: a mark, a title, a sentence, one control, and a way out.
 *
 * A surface rather than another row, and this is the one place in the footer
 * that earns one — everything else there is a link to somewhere, while this
 * is a thing that happened. It is the app's quietest card: no teal fill (the
 * screen's one filled control is elsewhere, and only one belongs to a page),
 * and a hairline rather than any elevation at all.
 */
function Notice({
  title,
  detail,
  action,
  onAction,
  onDismiss,
}: {
  title: string
  detail: React.ReactNode
  action: string
  onAction(): void
  onDismiss(): void
}) {
  return (
    <div className="relative flex flex-col gap-y-2 rounded-lg bg-zinc-950/4 p-2.5 ring-1 ring-hairline dark:bg-white/5 dark:ring-white/10">
      <div className="flex items-start gap-x-2 pr-5">
        {/*
          The one teal thing in the footer, and it is a mark rather than a
          fill: the accent says "this is what the card is about" without
          competing with the screen's own primary control.
        */}
        <ArrowUpCircleIcon aria-hidden="true" className="mt-px size-4 shrink-0 fill-(--primary)" />
        <div className="flex min-w-0 flex-col gap-y-0.5">
          <span className="text-control font-medium text-zinc-950 dark:text-white">{title}</span>
          <span className="text-xs/5 text-pretty text-zinc-500 dark:text-zinc-400">{detail}</span>
        </div>
      </div>
      <div>
        <Button variant="outline" size="sm" onClick={onAction}>
          {action}
        </Button>
      </div>
      <button
        type="button"
        onClick={onDismiss}
        aria-label={`Dismiss: ${title}`}
        className="absolute top-1.5 right-1.5 flex size-5 shrink-0 items-center justify-center rounded-sm text-zinc-400 outline-none hover:bg-zinc-950/5 hover:text-zinc-950 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring dark:text-zinc-500 dark:hover:bg-white/10 dark:hover:text-white"
      >
        <svg viewBox="0 0 16 16" aria-hidden="true" className="size-3 fill-current">
          <path d="M4.28 3.22a.75.75 0 0 0-1.06 1.06L6.94 8l-3.72 3.72a.75.75 0 1 0 1.06 1.06L8 9.06l3.72 3.72a.75.75 0 1 0 1.06-1.06L9.06 8l3.72-3.72a.75.75 0 0 0-1.06-1.06L8 6.94Z" />
        </svg>
      </button>
    </div>
  )
}

/**
 * Which flue this tab is talking to.
 *
 * The version of the *daemon*, not of the bundle — they are the same build in
 * a release, but on a relay origin the bundle is whatever was last deployed
 * there while the daemon on the other end of the socket may be newer. The one
 * worth printing is the one running the sessions.
 *
 * Mono, because it is an identifier rather than a word. It points at the
 * release the daemon named when it has one, and at the list otherwise: a tag
 * URL assembled from the version string is a guess about how the project
 * spells its tags, and a wrong guess is a 404 on a link promising notes.
 */
function VersionLine({ version, url }: { version: string; url?: string }) {
  return (
    <a
      href={url ?? RELEASES_URL}
      target="_blank"
      rel="noopener noreferrer"
      title="Release notes"
      className="rounded-sm px-2 py-0.5 font-mono text-xs text-zinc-400 outline-none hover:text-zinc-950 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring dark:text-zinc-500 dark:hover:text-white"
    >
      flue {version}
    </a>
  )
}

/**
 * How to upgrade flue, which is the honest answer rather than a button that
 * does it.
 *
 * Nothing in a browser can replace a running binary on the machine it is
 * talking to, and a control labelled "Update" that opened a window of
 * commands would have promised otherwise. The window is what the button
 * leads to, and it says so on the button.
 *
 * Both install routes, because nothing on this machine records which one was
 * used, and a reader shown the wrong one has to go looking for the right one
 * anyway. The relay is deliberately mentioned: it is deployed from the binary,
 * so it will be the next thing out of date, and being told that here is
 * cheaper than being surprised by a second notice afterwards.
 */
function UpgradeDialog({
  latest,
  url,
  open,
  onOpenChange,
}: {
  latest?: string
  url?: string
  open: boolean
  onOpenChange(open: boolean): void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{latest ? `Update to flue ${latest}` : 'Update flue'}</DialogTitle>
          <DialogDescription className="text-sm/6 text-pretty text-zinc-600 sm:text-xs/5 dark:text-zinc-400">
            Replacing the binary is something only this machine can do, so it happens in a terminal
            rather than here. Whichever way flue was installed, run its line and restart the
            daemon. Your sessions keep running through the restart.{' '}
            {url !== undefined && (
              <>
                <TextLink href={url} target="_blank">
                  What changed
                </TextLink>
                .
              </>
            )}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-y-3">
          <div className="flex flex-col gap-y-1.5">
            <p className="text-sm/6 text-zinc-600 sm:text-xs/5 dark:text-zinc-400">
              Installed with Homebrew:
            </p>
            <Command command={BREW_UPGRADE} />
          </div>
          <div className="flex flex-col gap-y-1.5">
            <p className="text-sm/6 text-zinc-600 sm:text-xs/5 dark:text-zinc-400">
              Installed with the script:
            </p>
            <Command command={SCRIPT_UPGRADE} />
          </div>
          {/*
            Said now rather than discovered later. The relay carries the Worker
            and the web app this binary ships, so upgrading flue is exactly
            what leaves a deployed relay behind — and the sidebar will say so
            the moment the new daemon greets this tab.
          */}
          <p className="text-sm/6 text-pretty text-zinc-600 sm:text-xs/5 dark:text-zinc-400">
            A deployed relay ships with the binary, so it will be out of date once this lands.
            Updating it afterwards is one click from here.
          </p>
        </div>
      </DialogContent>
    </Dialog>
  )
}
