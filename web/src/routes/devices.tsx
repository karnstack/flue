import { useCallback, useEffect, useRef, useState } from 'react'
import { QrCodeIcon } from '@heroicons/react/16/solid'
import { Link } from '@tanstack/react-router'
import { generate } from 'lean-qr'

import type { ConnStatus } from '@/client/client'
import { useRefetchOnFocus } from '@/hooks/use-refetch-on-focus'
import { useRelayTransport } from '@/hooks/use-relay-transport'
import { useFlueClient } from '@/client/provider'
import type { DeviceInfo, Pairing, RelayInfo } from '@/client/protocol'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { MACHINE_ID } from '@/relay/machines'
import { isRelayOrigin } from '@/relay/mode'

/** How often the pairing window's remaining time is redrawn. */
const TICK_MS = 1_000

const MINUTE = 60
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** What to say about a connection that is not currently carrying anything. */
function connectionNotice(status: ConnStatus): string | null {
  if (status === 'connecting') return 'Connecting to the flue daemon…'
  if (status === 'reconnecting') return 'Lost the flue daemon. Reconnecting…'
  return null
}

/**
 * The errors the daemon answers this screen's three operations with, in this
 * screen's own words.
 *
 * None of them carries a reqId — `revoke`, `pairStart` and `pairCancel` are
 * sent without one — so the code is all there is to go on, and an error naming
 * a request belongs to whichever screen sent it rather than to this one.
 *
 * `unknown_device` is the one that arrives in ordinary use: a row revoked from
 * another tab a moment ago is answered with this and not with a new list, so
 * without a word here the click looks like it did nothing at all.
 *
 * `internal/daemon/conn.go`: revokeDevice sends the first three, `wire.PairStart`
 * the last.
 */
const REFUSALS: Record<string, string> = {
  unknown_device: 'That device was already unpaired.',
  devices_unavailable: 'This daemon keeps no device registry, so nothing can be paired with it.',
  revoke_failed: 'The daemon could not write the change, so that device is still paired.',
  pairing_unavailable: 'This daemon has no pairing identity, so it cannot pair anything.',
}

/**
 * Why the Pair button is shut when nothing but loopback would be on the QR.
 *
 * Pinned word for word by devices.test.tsx, because the command it names is
 * the whole of the way out: the daemon binds loopback and only loopback, so a
 * pairing URL made from this page would say 127.0.0.1 — an address every
 * other device resolves to itself — and a QR nobody can follow, offered
 * anyway, was the bug that motivated the relay.
 */
const UNREACHABLE =
  "Remote devices can't reach 127.0.0.1. Run flue relay setup to give this daemon an address, then pair."

/**
 * The id tying the sentence above to the button it explains.
 *
 * `aria-describedby` rather than trusting proximity: the Pair button and its
 * explanation are on opposite sides of a flex row, so a reader who lands on the
 * shut button by keyboard hears "Pair device, dimmed" and nothing else unless
 * the two are linked. One id, because only one of these headers is ever on
 * screen.
 */
const UNREACHABLE_ID = 'pair-unreachable'

/**
 * How long ago, in the coarsest unit that still says something.
 *
 * `seen` is unix seconds, as `wire.DeviceInfo` reports both of its stamps —
 * multiplying rather than dividing here would put every device three thousand
 * years in the future and read "just now" forever.
 */
function ago(seen: number, now: number = Date.now()): string {
  const secs = Math.max(0, Math.round(now / 1000 - seen))
  if (secs < MINUTE) return 'just now'
  if (secs < HOUR) return `${Math.floor(secs / MINUTE)}m ago`
  if (secs < DAY) return `${Math.floor(secs / HOUR)}h ago`
  return `${Math.floor(secs / DAY)}d ago`
}

/** Whole seconds as m:ss, for the pairing window's deadline. */
function remaining(secs: number): string {
  return `${Math.floor(secs / MINUTE)}:${String(secs % MINUTE).padStart(2, '0')}`
}

/** Whole seconds until a pairing window closes; zero or less once it has. */
function secondsLeft(p: Pairing): number {
  return Math.round(p.expiresAt - Date.now() / 1000)
}

/**
 * The link the QR encodes, with the machine the relay carries this daemon as.
 *
 * The daemon writes `?t=` and `?k=` into the URL (internal/daemon/conn.go);
 * *which machine* the link pairs against is appended here, from the welcome's
 * relay snapshot, because the machine id is a fact about the relay leg and
 * this tab holds the freshest copy of it. `d` is the id, spliced raw only
 * once it matches the relay's own grammar — an id the Worker would 404 has no
 * business in a link — and `n` is the display name, which travels encoded and
 * only ever as a query parameter, never as a path. A daemon with no machine
 * id (no relay configured, or one from before machines had names) hands out
 * its URL untouched, which is the single-machine link /pair has always read.
 */
function pairLink(pairing: Pairing, relay: RelayInfo): string {
  const id = relay.machineId
  if (id === undefined || !MACHINE_ID.test(id)) return pairing.url
  const name = relay.machineName ? `&n=${encodeURIComponent(relay.machineName)}` : ''
  return `${pairing.url}&d=${id}${name}`
}

/**
 * By label, ties broken by id.
 *
 * The daemon sorts its own answer, but ordering a set of rows is the sort of
 * thing that is true until it is not, and a set that reshuffles between two
 * pushes moves the row under the reader's pointer. `label` is what the rows
 * lead with, and `id` breaks the tie because two phones called "iPhone" is the
 * ordinary case rather than the exotic one.
 */
function ordered(devices: DeviceInfo[]): DeviceInfo[] {
  return [...devices].sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id))
}

/*
 * The shared halves of the cell classes, spelled out rather than assembled.
 *
 * Every token here has to stay hyphenated: styles.build.test.ts explains a
 * compiled utility by finding it inside a `className` or a `cn(...)` call, and
 * a name pasted together in a constant is beyond its reach.
 */
const HEAD_CELL =
  'py-2 font-mono text-xs/6 font-medium tracking-wide whitespace-nowrap text-zinc-500 dark:text-zinc-400'
const BODY_CELL = 'py-2.5 text-base/6 sm:text-sm/6'

/** The quiet per-row control, at rest and while it is armed. */
const ROW_BUTTON = 'text-zinc-500 dark:text-zinc-400'

/**
 * The paired devices, one row each, with the revoke each row carries.
 *
 * A revoke cannot be taken back — the device's live connections are cut and
 * its key is gone from the registry — so it asks first. The question is put in
 * the row itself, as a Confirm/Cancel pair where the button was: an overlay
 * for a two-word question would put the answer somewhere other than the thing
 * it is about, and only one row is ever armed, because two rows offering
 * Confirm is a second one armed by a click the reader has forgotten making.
 */
function DeviceRows({
  devices,
  connected,
  armed,
  onArm,
  onRevoke,
}: {
  devices: DeviceInfo[]
  connected: boolean
  armed: string | null
  onArm: (id: string | null) => void
  onRevoke: (id: string) => void
}) {
  /**
   * The armed row's Confirm, focused as it appears.
   *
   * The swap replaces the very control the reader just activated, so without
   * this the focus falls to the document body: a keyboard user gets no
   * announcement, no indicator, and no way back to a question they cannot tell
   * was asked short of tabbing from the top of the page. One ref serves every
   * row because only one row is ever armed.
   */
  const confirm = useRef<HTMLButtonElement | null>(null)
  useEffect(() => {
    if (armed !== null) confirm.current?.focus()
  }, [armed])

  if (devices.length === 0) {
    return (
      <div className="flex flex-col items-center py-12 text-center sm:py-16">
        <div className="flex size-12 items-center justify-center rounded-xl bg-zinc-950/5 dark:bg-white/5">
          <QrCodeIcon
            aria-hidden="true"
            className="size-4 shrink-0 text-zinc-500 dark:text-zinc-400"
          />
        </div>
        <p className="mt-6 text-base/6 font-medium text-zinc-950 dark:text-white">
          No paired devices yet
        </p>
        <p className="mt-1 max-w-[40ch] text-base/7 text-pretty text-zinc-600 sm:text-sm/6 dark:text-zinc-400">
          Pair a phone or a second laptop and it reaches these sessions from wherever it is.
        </p>
      </div>
    )
  }

  return (
    // The negative margins let the scroll area reach the edges of the screen's
    // padding, so a narrow phone scrolls one row sideways rather than squeezing
    // every column on the page; the inner padding puts the cells back where
    // they were. `-my-2` with the matching `py-2` leaves the focus indicator
    // somewhere to be drawn, since scrolling one axis clips the other.
    <div className="-mx-4 -my-2 overflow-x-auto whitespace-nowrap sm:-mx-6 lg:-mx-8">
      <div className="inline-block min-w-full px-4 py-2 align-middle sm:px-6 lg:px-8">
        <table className="w-full text-left">
          <thead>
            <tr className="border-b border-zinc-950/10 dark:border-white/10">
              <th scope="col" className={cn(HEAD_CELL, 'pr-3')}>
                Device
              </th>
              <th scope="col" className={cn(HEAD_CELL, 'px-3')}>
                Paired
              </th>
              <th scope="col" className={cn(HEAD_CELL, 'px-3')}>
                Last seen
              </th>
              <th scope="col" className="py-2 pl-3">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {ordered(devices).map((d) => (
              <tr
                key={d.id}
                className="group border-b border-zinc-950/5 transition-colors hover:bg-zinc-950/5 dark:border-white/5 dark:hover:bg-white/5"
              >
                <td className={cn(BODY_CELL, 'pr-3 text-zinc-950 dark:text-white')}>{d.label}</td>
                <td className={cn(BODY_CELL, 'px-3 tabular-nums text-zinc-600 dark:text-zinc-400')}>
                  {ago(d.pairedAt)}
                </td>
                <td className={cn(BODY_CELL, 'px-3 tabular-nums text-zinc-600 dark:text-zinc-400')}>
                  {ago(d.lastSeen)}
                </td>
                <td className="py-2.5 pl-3 text-right">
                  {armed === d.id ? (
                    <span className="flex items-center justify-end gap-x-1">
                      {/*
                        Named after its own row, as every control in this column
                        is: without that a screen reader announces "Confirm" as
                        many times as there are devices, with nothing to tell
                        them apart. Red at full strength here and only here —
                        this is the click that actually cuts the device off.
                      */}
                      <Button
                        ref={confirm}
                        variant="ghost"
                        size="sm"
                        disabled={!connected}
                        aria-label={`Confirm revoking ${d.label}`}
                        className="text-destructive hover:text-destructive"
                        onClick={() => onRevoke(d.id)}
                      >
                        Confirm
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label={`Cancel revoking ${d.label}`}
                        className={ROW_BUTTON}
                        onClick={() => onArm(null)}
                      >
                        Cancel
                      </Button>
                    </span>
                  ) : (
                    /*
                      Quiet until the row is under the pointer, then red: a
                      column of destructive-red buttons would be the loudest
                      thing on a screen whose ordinary use is reading it, and
                      the warning only has to be certain for the row the reader
                      is actually on. Keyboard focus keeps its own indicator.

                      Both hover states are named, and the plain one is not
                      redundant: the ghost variant carries `hover:text-foreground`,
                      which twMerge keeps against a `group-hover:` utility because
                      the modifiers differ and which the sheet emits later at
                      equal specificity. Without the pair, the pointer landing on
                      this button would take the red *off* it — the opposite of
                      what the row is saying.

                      Held shut while the socket is down, because `revoke` is
                      dropped rather than held there — a click that quietly did
                      nothing would leave the reader believing a device had been
                      cut off when it is still connected.
                    */
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={!connected}
                      aria-label={`Revoke ${d.label}`}
                      className={cn(
                        ROW_BUTTON,
                        'group-hover:text-destructive hover:text-destructive',
                      )}
                      onClick={() => onArm(d.id)}
                    >
                      Revoke
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

/**
 * The open pairing window: the code to scan, the link behind it, and how long
 * either of them has left.
 *
 * The QR is drawn rather than fetched — the token is a credential, and a code
 * generated on the daemon's own page never leaves it. It is marked away from
 * assistive technology on purpose: it encodes the URL printed beside it, so
 * announcing it would be the same string twice, and nobody scans a QR code
 * with a screen reader.
 */
function PairingWindow({
  url,
  left,
  connected,
  onCancel,
}: {
  /** What the QR encodes and the line beneath it prints: the daemon's pairing
   *  URL with the machine appended — see pairLink. */
  url: string
  left: number
  connected: boolean
  onCancel: () => void
}) {
  const code = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    const canvas = code.current
    if (!canvas) return
    // A 2D context can be missing for real — a hardened browser, or jsdom —
    // and the link below is the whole of what the QR encodes, so a screen
    // without one is degraded rather than broken. Reading the context here
    // rather than letting lean-qr find it missing is what keeps that a branch
    // instead of an exception through a render.
    if (!canvas.getContext('2d')) return
    // Explicit black on white, because lean-qr defaults the "off" modules to
    // transparent: on this app's dark theme that would leave a black code on a
    // near-black card, which no camera can read.
    generate(url).toCanvas(canvas, { on: [0, 0, 0], off: [255, 255, 255] })
  }, [url])

  return (
    <div className="flex flex-col items-start gap-4 rounded-xl border border-zinc-950/10 p-4 sm:flex-row sm:gap-6 sm:p-6 dark:border-white/10">
      {/*
        White in both themes, as a QR code has to be: the quiet zone lean-qr
        draws around the code is part of what a camera looks for. `pixelated`
        is what keeps the upscaled modules square-edged rather than smeared.
      */}
      <canvas
        ref={code}
        aria-hidden="true"
        className="size-36 shrink-0 rounded-md bg-white [image-rendering:pixelated] sm:size-40"
      />
      <div className="flex min-w-0 flex-col items-start gap-y-3">
        <p className="text-base/6 font-medium text-zinc-950 sm:text-sm/6 dark:text-white">
          Scan this on the device you are pairing, or open the link there.
        </p>
        <p className="w-full font-mono text-xs/5 break-all text-zinc-600 select-all dark:text-zinc-400">
          {url}
        </p>
        {/*
          The deadline is stated rather than merely counted: two minutes is
          short enough that a reader who looks away needs to know why the card
          went. `tabular-nums` is what stops the sentence twitching sideways
          once a second as the digits change width.
        */}
        <p className="text-base/6 text-zinc-600 sm:text-sm/6 dark:text-zinc-400">
          It works once, and lasts two minutes —{' '}
          <span className="tabular-nums">{remaining(left)}</span> left.
        </p>
        {/*
          Shut while the connection is down, like every other control here that
          sends. `pairCancel` is dropped rather than held, and this is the one
          place where accepting the click and losing it would be worse than
          refusing it: the card would come down while the daemon's window ran on
          for the rest of its two minutes, retiring a QR code from the screen
          without retiring the token behind it. It is still cancellable the
          moment the connection is back, and the deadline closes it either way.
        */}
        <Button variant="outline" size="sm" disabled={!connected} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  )
}

/**
 * The paired devices, and the one place a new one is admitted.
 *
 * Three things are asked of the daemon here and none of them is held while the
 * socket is down: a `revoke` replayed after an outage could unpair a device
 * that had been paired again in the meantime, and a `pairStart` surfacing from
 * behind a ten-second backoff would show a token most of the way through its
 * two-minute life. So every control that sends one is shut while the
 * connection is not up, rather than accepting a click and dropping it.
 *
 * The list itself is the exception, and asked for exactly once. `deviceList`
 * is pushed on every pairing and every revoke, and `listDevices` is replayed by
 * the client on each new connection, so there is nothing for a poll to
 * discover — see FlueClient.listDevices, which owns that decision.
 */
export function DevicesRoute() {
  const client = useFlueClient()
  /**
   * null until the daemon has answered once, which is not the same as an empty
   * registry. "No paired devices yet" is a claim about the daemon; making it
   * before the first answer invents it, and every cold load passes through
   * that state on its way to a screen full of rows.
   */
  const [devices, setDevices] = useState<DeviceInfo[] | null>(null)
  // Seeded from the client, because onStatus reports only changes: a screen
  // reached by navigating mounts into a connection that is already up.
  const [status, setStatus] = useState<ConnStatus>(() => client.status)
  // Seeded for the same reason: the welcome that said what the relay is doing
  // usually landed before this screen was navigated to.
  const [relay, setRelay] = useState<RelayInfo>(() => client.relay)

  // The welcome's relay snapshot never updates on a stable socket, so a tab
  // greeted while the daemon was still dialling would hold the Pair gate
  // shut forever. While the snapshot claims less than connected, the daemon's
  // live answer is polled and adopted — machine identity kept from the
  // welcome, which the poll does not carry.
  useRelayTransport(relay.status !== 'connected', (liveOrigin) =>
    setRelay((r) => ({ ...r, status: 'connected', origin: liveOrigin })),
  )
  const [pairing, setPairing] = useState<Pairing | null>(null)
  const [left, setLeft] = useState(0)
  const [notice, setNotice] = useState<string | null>(null)
  /** The one row currently asking to be confirmed, if any. */
  const [armed, setArmed] = useState<string | null>(null)

  /**
   * Which devices the daemon last reported, and whether a window is open —
   * refs, because the listeners below are registered once and would otherwise
   * read whatever was true when they were.
   *
   * Together they are how a pairing is noticed: nothing in the protocol says
   * "this device just paired", only that the set has changed, so a device in a
   * list that was not in the one before it is the whole of the evidence. The
   * baseline is refreshed on every list that lands while no window is open, so
   * it is never older than the last thing the screen was told.
   *
   * It starts as null rather than as an empty set, which is not the same
   * claim: with no answer from the daemon yet, *every* device in the first
   * list is one this screen had not seen, and a window opened in that gap
   * would announce a pairing for whichever of them sorted first.
   */
  const known = useRef<Set<string> | null>(null)
  const windowOpen = useRef(false)

  const showWindow = useCallback((p: Pairing | null) => {
    windowOpen.current = p !== null
    setPairing(p)
    // Seeded here as well as on the tick, so the first paint of a window shows
    // the time it really has rather than a zero it corrects a frame later.
    if (p !== null) setLeft(secondsLeft(p))
  }, [])

  useEffect(() => {
    const offs = [
      client.onDeviceList((list) => {
        setDevices(list)
        // Whatever row was waiting to be confirmed is only still waiting if it
        // is still there. A device id is derived from its key, so a row that
        // left and came back is the same id — and would come back armed.
        setArmed((id) => (id !== null && list.some((d) => d.id === id) ? id : null))

        const before = known.current
        known.current = new Set(list.map((d) => d.id))
        if (!windowOpen.current || before === null) return
        const fresh = list.find((d) => !before.has(d.id))
        // A list arriving mid-window with nothing new in it is a revoke
        // somewhere else, not a failed pairing: the window stays up, because
        // the reader is holding a phone at it.
        if (!fresh) return
        showWindow(null)
        setNotice(`Paired ✓ — ${fresh.label}`)
      }),

      client.onPairing((p) => {
        setNotice(null)
        showWindow(p)
      }),

      // The relay state is a snapshot each connection's welcome carries, not
      // a stream — nothing announces a relay that fell over or came back
      // mid-connection — so every welcome re-answers whether pairing is worth
      // offering, and a reconnect is exactly when the answer changes.
      client.onWelcome(() => setRelay(client.relay)),

      client.onStatus((s) => {
        setStatus(s)
        setNotice(null)
        // The window is deliberately left up across an outage. Pairing mode
        // lives on the daemon and ends on its own deadline, and the second
        // device redeems the token over its own request — so a blink here
        // costs nothing, while tearing the card down would throw away a code
        // that still works. If the daemon is what went away, the countdown
        // clears the card within two minutes anyway.
      }),

      client.onError((e) => {
        // One client serves the whole tab, so this sees every error. An error
        // echoing a reqId answers a request some other screen sent — nothing
        // this screen asks for carries one.
        if (e.reqId !== undefined) return
        const said = REFUSALS[e.code]
        if (said === undefined) return
        setNotice(said)
        setArmed(null)
        // The one refusal that answers `pairStart`: no `pairing` is coming, so
        // whatever is on screen is from a window that is already over.
        if (e.code === 'pairing_unavailable') showWindow(null)
      }),
    ]

    client.listDevices()

    return () => {
      for (const off of offs) off()
    }
  }, [client, showWindow])

  // The daemon broadcasts device changes to live connections, but a tab that
  // was backgrounded through a reconnect can still be behind; asking again on
  // focus is idempotent and closes that gap.
  useRefetchOnFocus(() => client.listDevices())

  useEffect(() => {
    if (pairing === null) return
    const tick = () => {
      const secs = secondsLeft(pairing)
      if (secs > 0) {
        setLeft(secs)
        return
      }
      // The daemon leaves pairing mode on the same deadline, so the card is
      // cleared rather than left showing a code that no longer opens anything.
      showWindow(null)
      setNotice('That pairing link has expired. Open another whenever you like.')
    }
    tick()
    const timer = setInterval(tick, TICK_MS)
    return () => clearInterval(timer)
  }, [pairing, showWindow])

  const connected = status === 'open'

  /**
   * Whether a second device could actually reach the address a pairing URL
   * made now would carry. Two ways it can: the daemon's relay leg is up, so
   * the URL names the relay's public origin — or this page itself was served
   * from one, in which case the daemon plainly has a reachable address
   * whatever its snapshot said. Otherwise the URL names 127.0.0.1, and a QR
   * promising that is the original bug this gate exists to close.
   */
  const reachable = relay.status === 'connected' || isRelayOrigin()

  function pair() {
    setNotice(null)
    client.startPairing()
  }

  function cancel() {
    showWindow(null)
    client.cancelPairing()
  }

  function revoke(id: string) {
    setArmed(null)
    setNotice(null)
    client.revokeDevice(id)
  }

  const message = notice ?? connectionNotice(status)

  return (
    <div className="flex flex-col gap-y-6 p-4 sm:p-6 lg:p-8">
      <div className="flex items-start justify-between gap-x-4">
        <div className="min-w-0">
          <h1 className="text-2xl/8 font-semibold tracking-tight text-zinc-950 sm:text-xl/7 dark:text-white">
            Devices
          </h1>
          <p className="mt-1 max-w-[65ch] text-base/7 text-pretty text-zinc-600 sm:text-sm/6 dark:text-zinc-400">
            Anything paired here can open a session on this machine. Revoking one cuts it off while
            you watch.
          </p>
          {/*
            Always on the page, never mounted with its text. Several screen
            readers announce only changes to a live region that was already in
            the accessibility tree, so a region that appears alongside its first
            message is a message nobody hears — which is also why this is not
            dropped when empty. Empty, it contributes no line box at all, and
            `empty:mt-0` takes the margin with it.
          */}
          <p
            role="status"
            className="mt-3 max-w-[65ch] text-base/7 text-pretty text-zinc-600 empty:mt-0 sm:text-sm/6 dark:text-zinc-400"
          >
            {message}
          </p>
          {/*
            The gate's explainer, and not part of the live region above it: it
            states a standing fact about this daemon rather than announcing an
            event, and stuffing it into `role="status"` would have a screen
            reader interrupt with it on every welcome that reaffirms it.
          */}
          {!reachable && (
            <p
              id={UNREACHABLE_ID}
              className="mt-3 max-w-[65ch] text-base/7 text-pretty text-zinc-600 sm:text-sm/6 dark:text-zinc-400"
            >
              {UNREACHABLE}{' '}
              {/*
                Where the command is explained, and the only screen that can do
                anything about this one. A router Link, never a plain anchor: a
                page load would tear down the tab's one socket, and this daemon
                is what that socket is to.
              */}
              <Link
                to="/remote"
                className="font-medium text-zinc-950 underline underline-offset-4 dark:text-white"
              >
                Set up remote access
              </Link>
            </p>
          )}
        </div>
        {/*
          The one filled button on this screen, taking its teal from --primary
          rather than naming a colour. Every other control here is bordered or
          quiet.

          Held shut while the connection is not up: `pairStart` is dropped when
          it cannot be sent, and a token that never arrives looks exactly like
          a button that does nothing. Held shut just the same while no device
          could reach the address the QR would carry — see `reachable` — since
          a pairing that succeeds against 127.0.0.1 is worse than one refused:
          it mints a device that can never connect.
        */}
        <Button
          size="sm"
          className="shrink-0"
          disabled={!connected || !reachable}
          // Only when that is the reason it is shut. A button held shut by a
          // socket that is down is already explained by the live region above,
          // and pointing at a paragraph that is not on the page names nothing.
          aria-describedby={!reachable ? UNREACHABLE_ID : undefined}
          onClick={pair}
        >
          <QrCodeIcon data-icon="inline-start" aria-hidden="true" />
          Pair device
        </Button>
      </div>

      {pairing !== null && (
        <PairingWindow
          url={pairLink(pairing, relay)}
          left={left}
          connected={connected}
          onCancel={cancel}
        />
      )}

      {devices !== null && (
        <DeviceRows
          devices={devices}
          connected={connected}
          armed={armed}
          onArm={setArmed}
          onRevoke={revoke}
        />
      )}
    </div>
  )
}
