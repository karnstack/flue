import { useEffect, useState, type ReactNode } from 'react'
import { ArrowPathIcon, GlobeAltIcon, QrCodeIcon } from '@heroicons/react/16/solid'
import { Link } from '@tanstack/react-router'

import type { ConnStatus } from '@/client/client'
import { useFlueClient } from '@/client/provider'
import type { RelayInfo } from '@/client/protocol'
import {
  CloudflareConfiguredCard,
  CloudflareConnectCard,
  useRelayUIInfo,
  type DirectoryCounts,
  type RelayUIInfo,
} from '@/components/cloudflare-connect'
import { Command, Copyable } from '@/components/copyable'
import { PageHeader } from '@/components/page-header'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { useRelayTransport } from '@/hooks/use-relay-transport'
import { cn } from '@/lib/utils'
import { DIRECTORY_WARN_AT, MAX_ENTRIES } from '@/relay/directory'

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

/** The quieter voice, for a fact under a paragraph rather than a paragraph of
 *  its own — the same size the Cloudflare card's own notes are set in. */
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
 *
 * `unusable` splits the last of those: the transport says `off` both for a
 * machine that never had a relay and for one whose relay.json the daemon
 * refuses to dial, and calling the second "Not configured" is how an upgrade
 * that ended remote access reads as a machine that never set it up.
 */
function StatusBadge({
  status,
  unusable,
}: {
  status: RelayInfo['status'] | null
  unusable?: boolean
}) {
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
  if (unusable) {
    return (
      <Badge variant="outline" className="shrink-0">
        Not usable
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
 * The screen's state panel: one icon, one sentence about where this daemon
 * stands, and whatever that state has to hand over.
 *
 * Every one of the four states used to render a surface of its own — two dashed
 * `Empty` blocks and two `Card`s — which is why the screen read as four
 * unrelated screens that happened to share a heading. They are one thing said
 * four ways, so they get one shape, and the state is what changes inside it.
 *
 * The dashes are gone with them. A dashed border says "something is missing
 * here that you could add", which is right for an empty list and wrong for
 * this: "no relay configured" is a fact about the daemon, not a placeholder,
 * and the panel that states it should look as solid as the one that says the
 * relay is up.
 */
function StatePanel({
  icon: Icon,
  title,
  children,
}: {
  icon: typeof GlobeAltIcon
  title: string
  children: ReactNode
}) {
  return (
    <section className="flex flex-col gap-y-4 rounded-lg bg-card p-4 shadow-low ring-1 ring-hairline sm:p-5">
      <div className="flex items-start gap-x-3">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-zinc-950/5 dark:bg-white/5">
          <Icon aria-hidden="true" className="size-4 text-zinc-500 dark:text-zinc-400" />
        </span>
        <div className="flex min-w-0 flex-col gap-y-1.5">
          <h2 className="text-control font-medium text-zinc-950 dark:text-white">{title}</h2>
          {children}
        </div>
      </div>
    </section>
  )
}

/**
 * The heading over the integration cards.
 *
 * A named section, because there is one integration today and the shape has to
 * survive the second: a card floating under the state panel with nothing over
 * it reads as part of that panel's argument rather than as a thing this app
 * connects to.
 */
function Integrations({ children }: { children: ReactNode }) {
  return (
    <section className="flex flex-col gap-y-3">
      <div className="flex flex-col gap-y-1">
        <h2 className="text-control font-medium text-zinc-950 dark:text-white">Integrations</h2>
        <p className={cn(PROSE, 'max-w-[65ch]')}>
          Where flue borrows somebody else's infrastructure. Everything here is deployed into an
          account you own, and nothing is hosted by flue.
        </p>
      </div>
      {children}
    </section>
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
      <StatePanel icon={GlobeAltIcon} title="Nothing outside this computer can reach these sessions">
        <p className={cn(PROSE, 'max-w-[65ch]')}>
          Pairing a device is held shut until something can: a device paired against 127.0.0.1
          would be one that never connects. Deploying a relay below is what opens it — from this
          page, or from a terminal on this machine.
        </p>
      </StatePanel>

      <Integrations>
        <CloudflareConnectCard info={info} setupCommand={SETUP_COMMAND} />
      </Integrations>
    </>
  )
}

/**
 * A relay this machine has a configuration file for and will not dial.
 *
 * The state the screen used to swallow. relay.json exists and parses, so the
 * daemon calls itself configured; the transport refuses the file, so no socket
 * is ever opened and the welcome reports `off` — the same word a machine that
 * never had a relay gets. The commonest way in is an upgrade: a relay.json
 * written before the fleet key existed carries no fleet seed, and the fleet
 * key is not optional (spec/fleet-trust.md).
 *
 * The faults are repeated in the daemon's own words rather than paraphrased.
 * They are the strings `flue status` prints (relayProblems in
 * cmd/flue/main.go), and a second wording for the same fact is one more thing
 * that can drift away from it.
 */
function Unusable({ info }: { info: RelayUIInfo }) {
  return (
    <>
      <StatePanel
        icon={GlobeAltIcon}
        title="This machine will not dial the relay it is configured for"
      >
        <p className={cn(PROSE, 'max-w-[65ch]')}>
          The daemon found a relay configured here and refuses it — {(info.problems ?? []).join(', ')}{' '}
          — so nothing outside this computer can reach these sessions, and pairing a device stays
          shut.
        </p>
        <p className={cn(PROSE, 'max-w-[65ch]')}>
          Running the join line on this machine, from a machine already on the relay, writes a
          complete configuration and costs nothing else. Deploying below replaces the relay
          entirely — a fresh secret and a fresh fleet key — which every other machine then has to
          re-join and every paired browser has to pair again.
        </p>
        <Command command={STATUS_COMMAND} />
      </StatePanel>

      <Integrations>
        <CloudflareConnectCard info={info} setupCommand={SETUP_COMMAND} />
      </Integrations>
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
    <StatePanel icon={ArrowPathIcon} title="Dialling the relay">
      <p className={cn(PROSE, 'max-w-[65ch]')}>
        This daemon has a relay configured and is trying to reach it. A daemon that has just
        started, a network that went away, and a relay being redeployed all look like this, and it
        keeps trying on its own — but nothing outside this computer can connect until the socket is
        up.
      </p>
      <p className={cn(PROSE, 'max-w-[65ch]')}>
        The daemon names no address until then, so there is none to show here. This prints the one
        it is dialling:
      </p>
      <Command command={STATUS_COMMAND} />
    </StatePanel>
  )
}

/**
 * A relay that is up, and the address it carries this machine at.
 *
 * The pairing gate on the Devices screen turns on exactly this — see
 * `reachable` in routes/devices.tsx — so this is where the reader is told the
 * gate has opened, with the way through it beside the sentence.
 */
function Reachable({ origin, directory }: { origin: string; directory?: DirectoryCounts }) {
  return (
    <StatePanel icon={GlobeAltIcon} title="Reachable from anywhere">
      <p className={cn(PROSE, 'max-w-[65ch]')}>
        The relay carries this machine at the address below, and you can pair a device against this
        address now — the code Devices offers names it rather than 127.0.0.1.
      </p>
      <FleetLine directory={directory} />
      {/*
        Copyable, and breakable, as the pairing URL on Devices is: this is a
        string somebody may want to send to themselves, and a relay origin on
        a workers.dev subdomain is longer than a phone is wide. It gets the
        same strip the commands elsewhere get, because it is the same kind of
        thing — a quotation the page hands over rather than something it says.
      */}
      <Copyable text={origin} breakable />
      <div className="flex flex-wrap items-center gap-3">
        {/*
          The one filled control on the screen, taking its teal from --primary
          rather than naming a colour. A router Link, never a plain anchor: a
          page reload would tear down the tab's one socket.

          The label reads at 13px now for a reason that has nothing to do with
          this call site: `cn` was deleting the size off every filled button in
          the app, so this one was set in the page's 16px. See lib/utils.ts.

          What is here is the height alone, and only to buy a finger something
          to hit — the default 32px control is right on a pointer and small on
          a phone. No padding override: the default already trims its leading
          edge when an icon leads (`has-data-[icon=inline-start]`), and naming
          px here would fight that rule rather than replace it.
        */}
        <Button asChild className="h-9 sm:h-8">
          <Link to="/devices">
            <QrCodeIcon data-icon="inline-start" aria-hidden="true" />
            Pair a device
          </Link>
        </Button>
      </div>
    </StatePanel>
  )
}

/**
 * What this machine can hear of its fleet, under the address it answers on.
 *
 * Two legs go to one relay and they fail apart: the hub leg above is whether
 * this machine can be *reached*, and this is whether it hears what the other
 * machines have signed — which is what a device certificate and, far more
 * urgently, a revocation travel on. A machine reachable but deaf still serves
 * every device paired to it and will not learn that one of them was cut off
 * elsewhere, and nothing on this screen said so before.
 *
 * Nothing is rendered when the daemon is not reading a directory at all: the
 * counts would be a claim about a leg that does not exist. `flue relay status`
 * is named rather than paraphrased for the "why" — it asks the relay itself,
 * from a terminal, and its answer is longer than a line of this panel.
 */
function FleetLine({ directory }: { directory?: DirectoryCounts }) {
  if (directory === undefined) return null
  if (!directory.connected) {
    return (
      <p className={cn(NOTE, 'max-w-[65ch]')}>
        This machine is not reading the fleet directory, so a device paired on another machine will
        not reach it, and a device revoked on another machine may still be admitted here. A relay
        deployed before the directory existed answers nothing on it until{' '}
        <code className="font-mono">flue relay update</code> is run once.
      </p>
    )
  }
  const unsigned = directory.entries - directory.verified
  return (
    <>
      {/*
        Machines and revocations, which is what the directory carries. Device
        certificates go to the device that owns them and are not published
        here, so a count of them would read as "this fleet has no devices"
        when it means "the directory does not list them" — two different
        claims, and only the second is true. A non-zero one is still worth
        naming: it means a machine in this fleet is running an older flue.
      */}
      <p className={cn(NOTE, 'max-w-[65ch]')}>
        Fleet: {count(directory.machines, 'machine')},{' '}
        {count(directory.revocations, 'revocation')} — everything this machine's fleet key could
        check.
        {directory.devices > 0 &&
          ` ${count(directory.devices, 'device certificate')} in the directory: a machine in this fleet is running a flue that still publishes them.`}
        {unsigned > 0 &&
          ` ${count(unsigned, 'entry', 'entries')} in the directory ${
            unsigned === 1 ? 'was' : 'were'
          } signed by something else; this relay may belong to another fleet.`}
      </p>
      <FleetCapacity entries={directory.entries} />
    </>
  )
}

/**
 * How close the directory is to the one limit it has no gentle failure for.
 *
 * Nothing above 10% of headroom, because a screen that reports health three
 * ways is one nobody reads. Past that it is worth the room: at the cap the
 * relay refuses every new blob *before* storing it and therefore before
 * pushing it, so a device paired after that point reaches only the machine
 * that paired it, and a revocation made after it reaches nobody at all. No
 * deploy or update frees an entry — `flue relay reset` is the only thing that
 * does, and the fleet republishes into the empty directory by itself.
 */
function FleetCapacity({ entries }: { entries: number }) {
  if (entries < DIRECTORY_WARN_AT) return null
  const full = entries >= MAX_ENTRIES
  return (
    <p className={cn(NOTE, 'max-w-[65ch]')}>
      {full
        ? `The fleet directory is full (${entries} of ${MAX_ENTRIES} entries). `
        : `The fleet directory is ${entries} of ${MAX_ENTRIES} entries full. `}
      {full ? 'Nothing new is being distributed' : `At ${MAX_ENTRIES} nothing new is distributed`} —
      a device paired from here reaches only this machine, and a revoke reaches nobody. Run{' '}
      <code className="font-mono">flue relay reset</code> to empty it; every machine republishes
      what it holds.
    </p>
  )
}

/** One or many, spelled out: "1 machines" makes a screen look like it is
 *  guessing. */
function count(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`
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

  /*
   * Whether the daemon is refusing a relay.json it has, rather than having
   * none. The transport cannot tell the two apart — both are `off` on the
   * welcome — so the fact comes from the daemon's own answer about its config
   * file, which names each fault (`problems` on /api/relay/info). Null while
   * that answer is on its way, and on a relay origin where it is never asked
   * for; both read as false, which keeps this to the loopback screen it is
   * about.
   */
  const unusable = Boolean(relayUI?.configured && relayUI.problems?.length)

  return (
    /*
      The cap moves up here from the panels inside it, which each carried
      their own 3xl: once the page itself is capped and centred they were the
      same width as it and so did nothing, while the header above them stayed
      left-ranged against a whole display. Same number as Devices and
      Settings, so the heading does not jump sideways when the reader moves
      between them.
    */
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-y-6 p-4 sm:p-6 lg:p-8">
      {/*
        PageHeader rather than a hand-rolled heading row, so this screen
        carries the same trail markup as every other management screen.
      */}
      <PageHeader
        crumbs={[{ label: 'Remote access' }]}
        actions={<StatusBadge status={greeted ? status : null} unusable={unusable} />}
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
      {greeted && status === 'off' && unusable && relayUI && <Unusable info={relayUI} />}
      {greeted && status === 'off' && !unusable && <NotConfigured info={relayUI} />}
      {greeted && status === 'connecting' && <Dialling />}
      {greeted && status === 'connected' && (
        <>
          <Reachable origin={origin} {...(relayUI?.directory && { directory: relayUI.directory })} />
          {relayUI?.configured && (
            <Integrations>
              <CloudflareConfiguredCard info={relayUI} />
            </Integrations>
          )}
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
      <StatePanel icon={GlobeAltIcon} title="Waiting for the flue daemon">
        <p className={cn(PROSE, 'max-w-[65ch]')}>
          Whether anything outside this computer can reach these sessions is something only the
          daemon can say, and it has not said it yet. This page keeps trying; nothing here needs
          doing.
        </p>
      </StatePanel>
    )
  }
  return (
    <section
      aria-hidden="true"
      className="flex flex-col gap-y-3 rounded-lg bg-card p-4 shadow-low ring-1 ring-hairline sm:p-5"
    >
      <Skeleton className="h-5 w-48" />
      <Skeleton className="h-4 w-full" />
      <Skeleton className="h-4 w-4/5" />
      <Skeleton className="h-8 w-full" />
    </section>
  )
}
