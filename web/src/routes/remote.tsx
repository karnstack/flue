import { useEffect, useState } from 'react'
import { ArrowPathIcon, GlobeAltIcon, QrCodeIcon } from '@heroicons/react/16/solid'
import { Link } from '@tanstack/react-router'

import type { ConnStatus } from '@/client/client'
import { useFlueClient } from '@/client/provider'
import type { RelayInfo } from '@/client/protocol'
import {
  CloudflareConfiguredCard,
  CloudflareConnectCard,
  useRelayUIInfo,
  type RelayUIInfo,
} from '@/components/cloudflare-connect'
import { Command, Copyable } from '@/components/copyable'
import { PageHeader } from '@/components/page-header'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { Skeleton } from '@/components/ui/skeleton'
import { useRelayTransport } from '@/hooks/use-relay-transport'
import { cn } from '@/lib/utils'

/**
 * The commands this screen hands over, spelled exactly as the CLI spells them
 * (`usageText` in cmd/flue/main.go).
 *
 * They are the CLI door into the states this screen can now also act on
 * itself, so a paraphrase here is a command that does not exist, pasted into
 * somebody's terminal. Pinned by remote.test.tsx for that reason.
 */
const SETUP_COMMAND = 'flue relay setup'
const STATUS_COMMAND = 'flue relay status'

/*
 * The screen's shared class strings, spelled out rather than assembled.
 *
 * Every token here has to stay hyphenated: styles.build.test.ts explains a
 * compiled utility by finding it inside a `className` or a `cn(...)` call, and
 * a single-word name pasted together in a constant is beyond its reach.
 */
const PROSE = 'text-base/7 text-pretty text-zinc-600 sm:text-sm/6 dark:text-zinc-400'
const NOTE = 'text-sm/6 text-pretty text-zinc-600 sm:text-xs/5 dark:text-zinc-400'

/**
 * What to say about a connection that is not currently carrying anything.
 *
 * Everything else on this screen is a claim about the daemon taken from the
 * last welcome it sent, and a claim about a relay outlives the connection that
 * reported it. "Connected — reachable from anywhere" read off a tab that lost
 * the daemon ten minutes ago is the one way this screen could mislead, so the
 * age of what it is showing is stated rather than left to be inferred from a
 * sidebar somewhere.
 */
function connectionNotice(status: ConnStatus): string | null {
  if (status === 'connecting') return 'Connecting to the flue daemon…'
  if (status === 'reconnecting') {
    return 'Lost the flue daemon. Reconnecting… — what is below is from the last connection it had.'
  }
  return null
}

/**
 * The relay leg's state, in one word, in the colour that word deserves.
 *
 * `null` is not one of the daemon's answers — it is the absence of one. The
 * relay rides a welcome, so a tab that has not been greeted yet knows nothing,
 * and `client.relay` folds that into the same `{status:'off'}` a daemon with no
 * relay sends. Rendering "Not configured" from it would put the loudest claim
 * on this screen on the page before anything had said it.
 */
function StatusBadge({ status }: { status: RelayInfo['status'] | null }) {
  if (status === null) {
    return (
      <Badge variant="outline" className="shrink-0">
        <ArrowPathIcon aria-hidden="true" className="motion-safe:animate-spin" />
        Checking
      </Badge>
    )
  }
  if (status === 'connected') {
    // The screen's one teal element, taking it from --primary rather than
    // naming a colour — the same treatment the single primary button gets.
    return <Badge className="shrink-0">Connected</Badge>
  }
  if (status === 'connecting') {
    return (
      <Badge variant="secondary" className="shrink-0">
        {/*
          `motion-safe:` because a reduced-motion setting means it, and the word
          beside it carries the state on its own. Marked away from assistive
          technology for the same reason: it says nothing the badge does not.
        */}
        <ArrowPathIcon aria-hidden="true" className="motion-safe:animate-spin" />
        Connecting
      </Badge>
    )
  }
  return (
    <Badge variant="outline" className="shrink-0">
      Not configured
    </Badge>
  )
}

/**
 * A daemon with no relay: the state every fresh install is in.
 *
 * One route out of it: a Worker deployed into the reader's own Cloudflare
 * account. There is no hosted alternative, on purpose — and there are two
 * doors to the one deploy: the integration card below, and the CLI command
 * inside it. Both run the same code (internal/relaydeploy).
 */
function NotConfigured({ info }: { info: RelayUIInfo | null }) {
  return (
    <>
      <Empty className="border border-dashed border-zinc-950/10 py-8 dark:border-white/10">
        <EmptyHeader className="max-w-[48ch]">
          <EmptyMedia variant="icon">
            <GlobeAltIcon aria-hidden="true" />
          </EmptyMedia>
          <EmptyTitle className="text-base/6 sm:text-sm/6">
            Nothing outside this computer can reach these sessions
          </EmptyTitle>
          <EmptyDescription className={PROSE}>
            Pairing a device is held shut until something can: a device paired against 127.0.0.1
            would be one that never connects. Deploying a relay below is what opens it — from this
            page, or from a terminal on this machine.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>

      <CloudflareConnectCard info={info} setupCommand={SETUP_COMMAND} />
    </>
  )
}

/**
 * A relay this daemon is configured for and cannot reach yet.
 *
 * No address is shown, because there is none to show: `SetRelayStatus` blanks
 * the origin for every status but `connected`, on the grounds that a socket
 * which is not up carries nothing. Printing the last one this screen saw would
 * be telling the reader something is reachable while it is not — so the screen
 * says what it knows and names the command that knows the rest.
 */
function Dialling() {
  return (
    // Capped at a readable measure rather than run out to the panel's width,
    // as the two cards in the not-configured state are by being a pair.
    <Card className="max-w-3xl">
      <CardHeader>
        <CardTitle>Dialling the relay</CardTitle>
        <CardDescription className={PROSE}>
          This daemon has a relay configured and is trying to reach it. A daemon that has just
          started, a network that went away, and a relay being redeployed all look like this, and it
          keeps trying on its own — but nothing outside this computer can connect until the socket
          is up.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-y-3">
        <p className={PROSE}>
          The daemon names no address until then, so there is none to show here. This prints the one
          it is dialling:
        </p>
        <Command command={STATUS_COMMAND} />
      </CardContent>
    </Card>
  )
}

/**
 * A relay that is up, and the address it carries this machine at.
 *
 * The pairing gate on the Devices screen turns on exactly this — see
 * `reachable` in routes/devices.tsx — so this is where the reader is told the
 * gate has opened, with the way through it beside the sentence.
 */
function Reachable({ origin }: { origin: string }) {
  return (
    <Card className="max-w-3xl">
      <CardHeader>
        <CardTitle>Reachable from anywhere</CardTitle>
        <CardDescription className={PROSE}>
          The relay carries this machine at the address below, and you can pair a device against
          this address now — the code Devices offers names it rather than 127.0.0.1.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-y-4">
        {/*
          Copyable, and breakable, as the pairing URL on Devices is: this is a
          string somebody may want to send to themselves, and a relay origin on
          a workers.dev subdomain is longer than a phone is wide. It gets the
          same strip the commands above it get, because it is the same kind of
          thing — a quotation the page hands over rather than something it
          says.
        */}
        <Copyable text={origin} breakable />
        <div className="flex flex-wrap items-center gap-3">
          {/*
            The one filled control on the screen, taking its teal from
            --primary rather than naming a colour. A router Link, never a plain
            anchor: a page reload would tear down the tab's one socket.
          */}
          <Button size="sm" asChild>
            <Link to="/devices">
              <QrCodeIcon data-icon="inline-start" aria-hidden="true" />
              Pair a device
            </Link>
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

/**
 * Remote access: whether anything outside this computer can reach these
 * sessions, and what to do about it either way.
 *
 * The daemon binds loopback and only loopback, so a relay is the whole of the
 * answer — and until this screen, both ways of getting one existed only as
 * commands nobody in the UI mentioned. What the screen can do about that is
 * bounded and stated plainly: a browser cannot drive the daemon's CLI, so this
 * explains, hands over the exact command, and copies it.
 *
 * The relay state is read from the client rather than asked for. It rides each
 * connection's welcome as a snapshot — nothing announces a relay that fell over
 * or came back mid-connection — so the screen seeds from `client.relay` for the
 * connection it mounted into and re-reads on every welcome after it. Which
 * means a reconnect is what refreshes this screen, exactly as it is what
 * re-evaluates the Pair gate on Devices.
 */
export function RemoteRoute() {
  const client = useFlueClient()
  // The daemon's answer to "can this page deploy?" — null while unanswered,
  // and never asked on a relay origin (useRelayUIInfo refuses there, which is
  // what keeps a Cloudflare token off any remote tab).
  const relayUI = useRelayUIInfo()
  // Seeded from the client, because onWelcome reports only new welcomes: a
  // screen reached by navigating mounts into a connection whose greeting landed
  // long before it.
  const [relay, setRelay] = useState<RelayInfo>(() => client.relay)
  // Seeded for the same reason: onStatus reports only changes, and a screen
  // reached by navigating mounts into a connection that is already up.
  const [conn, setConn] = useState<ConnStatus>(() => client.status)
  /**
   * Whether anything has actually said what the relay is doing.
   *
   * `client.relay` cannot answer this — a daemon with no relay and a tab that
   * has not been greeted yet both read `{status:'off'}`, deliberately, so that
   * consumers do not fold three spellings of "no relay" into one. The
   * distinction only matters here, on the one screen whose whole subject is
   * that field, so it is kept here rather than added to the client.
   *
   * Seeded from the connection state: a socket that is already up was greeted
   * on the way, since the daemon sends its welcome as the first frame of every
   * connection it accepts. A cold load starts at `connecting`, which is exactly
   * the window this exists to cover.
   */
  const [greeted, setGreeted] = useState(() => client.status === 'open')

  useEffect(() => {
    const offs = [
      // Every welcome, not only the first: the relay state is a snapshot each
      // connection carries, so a reconnect is the only thing that ever
      // refreshes it — the same reason the Pair gate on Devices listens here.
      client.onWelcome(() => {
        setRelay(client.relay)
        setGreeted(true)
      }),
      client.onStatus(setConn),
    ]
    return () => {
      for (const off of offs) off()
    }
  }, [client])

  // The welcome's snapshot goes stale in exactly one direction that matters:
  // a tab greeted mid-dial says "connecting" forever, because nothing on a
  // stable socket ever re-says the relay state. While the snapshot claims
  // less than connected, poll the daemon's live answer and adopt it —
  // keeping the machine identity the welcome carried, which the poll does
  // not know.
  useRelayTransport(greeted && relay.status !== 'connected', (liveOrigin) =>
    setRelay((r) => ({ ...r, status: 'connected', origin: liveOrigin })),
  )

  /*
   * A connected relay that named no origin is treated as still dialling, which
   * is the same judgement the daemon makes: SetRelayStatus refuses to record
   * `connected` without an origin, because the origin is the entire use of a
   * connected relay. Nothing on the wire should produce this — the field is
   * optional in the type and blanked in Go — so it exists here to keep the
   * rendered claim true rather than to handle a state that happens.
   */
  const origin = relay.status === 'connected' ? (relay.origin ?? '') : ''
  const status: RelayInfo['status'] =
    relay.status === 'connected' && origin === '' ? 'connecting' : relay.status

  return (
    <div className="flex flex-col gap-y-6 p-4 sm:p-6 lg:p-8">
      {/*
        PageHeader rather than a hand-rolled heading row, so this screen
        carries the same trail markup — and the same sidebar trigger on the
        heading's line — as every other management screen.
      */}
      <PageHeader
        crumbs={[{ label: 'Remote access' }]}
        actions={<StatusBadge status={greeted ? status : null} />}
      >
        <p className={cn(PROSE, 'max-w-[65ch]')}>
          The daemon listens on this computer and nowhere else. A relay gives it an address the
          rest of the world can dial, which is what lets a phone — or a second laptop — open a
          session on this machine.
        </p>
        {/*
          Always on the page, never mounted with its text: several screen
          readers announce only changes to a live region that was already in
          the accessibility tree, so a region that appears alongside its first
          message is a message nobody hears. Empty, it contributes no line box
          at all, and `empty:mt-0` takes the margin with it.
        */}
        <p role="status" className={cn(PROSE, 'mt-3 max-w-[65ch] empty:mt-0')}>
          {connectionNotice(conn)}
        </p>
      </PageHeader>

      {!greeted && <AwaitingWelcome connecting={conn === 'connecting'} />}
      {greeted && status === 'off' && <NotConfigured info={relayUI} />}
      {greeted && status === 'connecting' && <Dialling />}
      {greeted && status === 'connected' && (
        <>
          <Reachable origin={origin} />
          {relayUI?.configured && <CloudflareConfiguredCard info={relayUI} />}
        </>
      )}
    </div>
  )
}

/**
 * The first moment of a cold load: the socket is being opened and the daemon
 * has not said anything yet.
 *
 * A skeleton of the card that is about to arrive rather than a spinner or, as
 * this screen used to do, the not-configured state — which is the loudest claim
 * it can make ("nothing outside this computer can reach these sessions") and
 * was being made before anything had said so. On a machine with a working relay
 * that flashed a paragraph of setup instructions at the reader every time they
 * opened the page.
 *
 * `aria-hidden`, because the header's live region already says "Connecting to
 * the flue daemon…" and grey rectangles add nothing to it.
 */
function AwaitingWelcome({ connecting }: { connecting: boolean }) {
  if (!connecting) {
    // The first attempt has already failed, so this is no longer a moment — it
    // is a state, and a skeleton that shimmers through it would read as a page
    // still loading rather than a daemon that has not answered. What the reader
    // can do about it is nothing, and saying so is better than a placeholder
    // that implies otherwise.
    return (
      <Empty className="border border-dashed border-zinc-950/10 py-8 dark:border-white/10">
        <EmptyHeader className="max-w-[48ch]">
          <EmptyMedia variant="icon">
            <GlobeAltIcon aria-hidden="true" />
          </EmptyMedia>
          <EmptyTitle className="text-base/6 sm:text-sm/6">
            Waiting for the flue daemon
          </EmptyTitle>
          <EmptyDescription className={PROSE}>
            Whether anything outside this computer can reach these sessions is something only the
            daemon can say, and it has not said it yet. This page keeps trying; nothing here needs
            doing.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }
  return (
    <Card aria-hidden="true" className="max-w-3xl">
      <CardHeader>
        <Skeleton className="h-5 w-48" />
      </CardHeader>
      <CardContent className="flex flex-col gap-y-3">
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-4/5" />
        <Skeleton className="h-8 w-full" />
      </CardContent>
    </Card>
  )
}
