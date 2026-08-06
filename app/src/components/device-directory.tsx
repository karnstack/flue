// The device directory — one login, all your machines.
//
// Free of every Start import, like `LoginForm` and `EnrollForm`: it takes the
// three calls it makes as props and the navigation as a fourth. That keeps the
// component testable in a plain DOM, keeps the route the only place that knows
// about RPC, and — the reason it matters here — makes "where the browser goes
// when you open a session" a value a test can read rather than a side effect it
// has to intercept.
//
// Three things this screen is careful about.
//
// **It never claims more than the server said.** A revoke that was refused
// leaves the machine on the list; a rename that was refused leaves the old name
// on it. The list is not edited locally at all — the route reloads it — because
// the alternative is a screen that quietly disagrees with the database.
//
// **A session opens only at a URL the server minted.** The URL carries a
// 60-second bearer token in its *fragment* (`#t=…`, see `openSession`);
// constructing one here, or navigating on a refusal, would send somebody to a
// relay that will turn them away with no explanation. Nothing in this file
// reads, splits or logs that URL — it is handed to `go` whole, which is also
// what keeps the credential out of a React tree and a console.
//
// **"Online" is an inference, and is presented as one.** Nothing here talks to
// the relay: `last_seen` is a stamp the daemon's connection leaves behind, so a
// recent one means "was connected a moment ago". The window is `ONLINE_WINDOW_S`
// and the exact time is shown beside the badge, so the reader can judge for
// themselves rather than trusting a green dot.
//
// Links are plain anchors rather than router `Link`s, for the same reason there
// are no Start imports: this file must render in a bare jsdom. A full document
// load to /enroll costs one navigation on a page nobody visits twice.
import { useState, type FormEvent } from 'react'
import {
  EllipsisIcon,
  MonitorSmartphoneIcon,
  PencilIcon,
  PlugZapIcon,
  SquareTerminalIcon,
  Trash2Icon,
} from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty'
import { Field, FieldError, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
// The one bound on a machine's name, imported rather than restated: a literal
// here is a second answer to a question `lib/label.ts` already answers, and the
// two drift the first time either moves. That module is dependency-free (a
// regex and two numbers), so it costs this component nothing to stay start-free
// and jsdom-renderable.
import { MAX_LABEL } from '@/lib/label'

/** One machine, as the directory shows it. Mirrors `server/devices.ts`. */
export interface DeviceSummary {
  id: string
  label: string
  lastSeen: number | null
  disabled: boolean
}

/** Every call this screen makes answers in this shape; see routes/devices.tsx. */
export type Refusal = { ok: false; error: string }
export type OpenOutcome = { ok: true; url: string } | Refusal
export type RevokeOutcome = { ok: true } | Refusal
export type RenameOutcome = { ok: true; label: string } | Refusal

export interface DeviceDirectoryProps {
  devices: Array<DeviceSummary>
  /** The account these machines belong to, shown as context. */
  email?: string
  /** Set when the *list itself* could not be read. Not the same as "none". */
  error?: string | null
  openSession: (deviceId: string) => Promise<OpenOutcome>
  revoke: (deviceId: string) => Promise<RevokeOutcome>
  rename: (deviceId: string, label: string) => Promise<RenameOutcome>
  /** Where a session opens. Injected so a test can read the URL. */
  go?: (url: string) => void
  /**
   * "Now" in unix seconds, from whoever loaded the list.
   *
   * Supplied by the route from the *server's* clock rather than defaulted, so
   * the server-rendered "seen 3h ago" and the browser's hydration of it agree —
   * see the note on `listDevicesFn`. The fallback is for a caller that has no
   * clock to offer, and for tests, which pin it.
   */
  now?: number
}

/**
 * How recently a machine must have been seen to count as reachable.
 *
 * Two minutes: a connected daemon stamps `last_seen` while its relay
 * connection is up, and this has to be longer than whatever interval does the
 * stamping (nothing does yet — see the note in the file header) or every
 * machine would flicker between states between page loads. Erring long is the
 * safe direction: the exact time is rendered beside the badge, so a stale
 * "Online" is one glance from being caught, while a jittery badge is just
 * noise.
 */
export const ONLINE_WINDOW_S = 120

/** What a failed call says when the failure was not the server's answer. */
const UNAVAILABLE_MESSAGE = 'Something went wrong at our end. Try again in a moment.'

/**
 * What a machine flue has switched off is told about itself.
 *
 * The same fact `server/devices.ts` refuses the delete with, said *before* the
 * click rather than after it: the delete is scoped `disabled = false`, so a
 * Revoke offered on one of these rows can only end in a refusal toast. Here it
 * describes the menu item that is shut, via `aria-describedby`, so the reason
 * is announced with the item rather than sitting somewhere a screen reader
 * would reach separately.
 */
const SWITCHED_OFF_NOTE = 'Switched off by flue and cannot be removed. Contact support.'

/**
 * "seen 2d ago", or nothing at all for a machine that never connected.
 *
 * Coarse on purpose — a device list is not a log. Minutes for the first hour,
 * hours for the first day, days after that; anything finer would rewrite itself
 * on the page while being read, and anything more precise would be a claim
 * about a stamp that is only as fresh as the last connection.
 */
export function lastSeenLabel(lastSeen: number | null, now: number): string | null {
  if (lastSeen === null) return null
  const ago = Math.max(0, now - lastSeen)
  if (ago < 60) return 'seen just now'
  if (ago < 3600) return `seen ${Math.floor(ago / 60)}m ago`
  if (ago < 86_400) return `seen ${Math.floor(ago / 3600)}h ago`
  return `seen ${Math.floor(ago / 86_400)}d ago`
}

type Status = 'online' | 'offline' | 'never' | 'disabled'

/**
 * Which of four things this machine is.
 *
 * `disabled` outranks everything: a machine whose kill switch is flipped cannot
 * be minted a token whatever its last stamp says, so showing it as "Online"
 * would offer a button that can only fail.
 */
function statusOf(device: DeviceSummary, now: number): Status {
  if (device.disabled) return 'disabled'
  if (device.lastSeen === null) return 'never'
  return now - device.lastSeen <= ONLINE_WINDOW_S ? 'online' : 'offline'
}

const STATUS_TEXT: Record<Status, string> = {
  online: 'Online',
  offline: 'Offline',
  never: 'Never connected',
  disabled: 'Disabled',
}

/**
 * The status badge: a dot and a word, or — for the kill switch — the one
 * destructive badge on the page.
 *
 * The dot is neutral rather than green, deliberately, and it is the same
 * decision the daemon's own dashboard made for its session list: amber is this
 * product's single accent and it is spent on the one primary button per row.
 * Ten coloured dots beside ten amber buttons leaves the eye nowhere to land.
 * Contrast carries the distinction instead — full strength for a machine that
 * is reachable, faded for one that is not.
 */
function StatusBadge({ status }: { status: Status }) {
  if (status === 'disabled') {
    return <Badge variant="destructive">{STATUS_TEXT.disabled}</Badge>
  }
  return (
    <Badge variant="outline">
      <span
        aria-hidden="true"
        className={`size-1.5 shrink-0 rounded-full ${
          status === 'online' ? 'bg-foreground' : 'bg-foreground/30'
        }`}
      />
      {STATUS_TEXT[status]}
    </Badge>
  )
}

export function DeviceDirectory({
  devices,
  email,
  error,
  openSession,
  revoke,
  rename,
  go = (url) => window.location.assign(url),
  now = Math.floor(Date.now() / 1000),
}: DeviceDirectoryProps) {
  // The empty state carries its own call to action, so the header's would be
  // the same button twice on the emptiest page in the app.
  const empty = !error && devices.length === 0

  return (
    <main className="mx-auto w-full max-w-4xl px-4 py-8 sm:px-6 sm:py-12 lg:px-8">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between sm:gap-6">
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="font-heading text-xl font-medium tracking-tight sm:text-2xl">
              Your machines
            </h1>
            {/* The count, where the eye already is. Suppressed while the list
                could not be read: "0" would be a number this screen does not
                have. */}
            {error ? null : (
              <Badge variant="secondary" className="tabular-nums">
                {devices.length}
              </Badge>
            )}
          </div>
          {/* Wraps rather than truncates. `min-w-0` on the column above is what
              keeps a long address from pushing the header's button off a
              phone, and `break-words` covers an address with no space in it —
              truncating instead hid two thirds of this sentence at 390px,
              which is where it is most worth reading. (Measured.) */}
          <p className="text-base/7 break-words text-pretty text-muted-foreground sm:text-sm/6">
            {email
              ? `Every machine connected to ${email}. Open a session from anywhere.`
              : 'Every machine connected to your account. Open a session from anywhere.'}
          </p>
        </div>
        {/* The one primary action on the page, and it stays reachable when the
            list is long: a machine you have not connected yet is the only
            thing this screen cannot do for you. */}
        {empty ? null : (
          <Button asChild className="self-start sm:self-auto">
            <a href="/enroll">
              <PlugZapIcon data-icon="inline-start" />
              Connect a machine
            </a>
          </Button>
        )}
      </div>

      <div className="mt-6 sm:mt-8">
        {error ? (
          <ListError message={error} />
        ) : empty ? (
          <NoDevices />
        ) : (
          /*
           * A list, not a table, and the reason is the phone.
           *
           * These are three or four machines with two facts each — a table's
           * columns buy nothing, and they cost the one thing this screen
           * cannot afford: a table cannot reflow, so on a 390px viewport the
           * actions column ends up behind a horizontal scrollbar. "Open a
           * session from your phone" is the entire product pitch, and the
           * button that does it was off the right-hand edge. (Measured in a
           * real browser at 390px, not assumed.)
           *
           * Rows sit directly on the page background with hairlines between
           * them and nothing else: no wrapper panel, no cards. Sibling rows in
           * one shared context want the lightest separation that works, and a
           * card around each would claim every machine is an independent
           * object when what is on screen is a single set. The rules are
           * opacity-based rather than a fixed grey, so they hold in both
           * themes.
           */
          <ul
            role="list"
            className="divide-y divide-foreground/10 border-y border-foreground/10"
          >
            {devices.map((device) => (
              <DeviceRow
                key={device.id}
                device={device}
                now={now}
                openSession={openSession}
                revoke={revoke}
                rename={rename}
                go={go}
              />
            ))}
          </ul>
        )}
      </div>
    </main>
  )
}

/**
 * The list could not be read.
 *
 * Kept apart from the empty state, and that separation is the point: rendering
 * "no machines yet" for a database outage tells somebody their machines are
 * gone, which is the single most alarming thing this screen could say and also
 * the one thing it does not know.
 */
function ListError({ message }: { message: string }) {
  return (
    <Empty className="border border-dashed">
      <EmptyHeader>
        <EmptyTitle>Your machines could not be loaded</EmptyTitle>
        <EmptyDescription role="alert">{message}</EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button variant="outline" onClick={() => window.location.reload()}>
          Try again
        </Button>
      </EmptyContent>
    </Empty>
  )
}

/** No machines yet — so the screen says what to run, and where to go next. */
function NoDevices() {
  return (
    <Empty className="border border-dashed">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <MonitorSmartphoneIcon />
        </EmptyMedia>
        <EmptyTitle>No machines yet</EmptyTitle>
        <EmptyDescription>
          Run <code className="font-mono">flue enable</code> on a machine you want to reach from
          here. It prints a code; enter it on the next screen and the machine joins this list.
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button asChild>
          <a href="/enroll">
            <PlugZapIcon data-icon="inline-start" />
            Connect a machine
          </a>
        </Button>
      </EmptyContent>
    </Empty>
  )
}

function DeviceRow({
  device,
  now,
  openSession,
  revoke,
  rename,
  go,
}: {
  device: DeviceSummary
  now: number
  openSession: (deviceId: string) => Promise<OpenOutcome>
  revoke: (deviceId: string) => Promise<RevokeOutcome>
  rename: (deviceId: string, label: string) => Promise<RenameOutcome>
  go: (url: string) => void
}) {
  const [opening, setOpening] = useState(false)
  const status = statusOf(device, now)
  const seen = lastSeenLabel(device.lastSeen, now)

  async function onOpen() {
    // One press is one token. A client token is a 60-second bearer credential,
    // so a double-click mints a second one that nobody will use and races two
    // navigations against each other.
    if (opening) return
    setOpening(true)
    const toastId = toast.message(`Opening a session on ${device.label}…`)
    try {
      const result = await openSession(device.id)
      if (!result.ok) {
        toast.error(result.error, { id: toastId })
        return
      }
      toast.success(`Opening ${device.label}`, { id: toastId })
      // A whole-document navigation, fragment and all — `location.assign`
      // carries `#t=…` across the origin boundary and, being a fragment, the
      // browser sends it to no server on the way. The relay's page reads it out
      // of `location.hash` and scrubs it. Nothing here parses the URL: the less
      // this file knows about the shape of a credential, the fewer places there
      // are to leave half of one behind.
      //
      // The navigation leaves this page, so nothing after it runs in practice
      // — but `opening` is cleared in the `finally` regardless, because a
      // browser that refuses the navigation must not leave a dead button.
      go(result.url)
    } catch {
      toast.error(UNAVAILABLE_MESSAGE, { id: toastId })
    } finally {
      setOpening(false)
    }
  }

  return (
    // Stacked on a phone, one line on anything wider. `min-w-0` on the text
    // half is what lets a long machine name truncate instead of pushing the
    // buttons off the row — a flex child's default `min-width:auto` refuses to
    // shrink below its content.
    <li className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
      <div className="flex min-w-0 flex-col gap-1">
        {/* `flex-wrap`, so a long name pushes the badge onto its own line
            instead of squeezing it: without it a narrow viewport truncates the
            machine's name to make room for the word "Offline", which is the
            wrong thing to give up. */}
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate font-medium">{device.label}</span>
          <StatusBadge status={status} />
        </div>
        {/* The id the daemon derived from its own key — the name every other
            surface uses (`flue devices`, the relay's hub key, a support
            conversation) — and how long ago the machine was last heard from.
            One paragraph rather than a flex row, so it wraps as *text* does; a
            row of flex children wraps by squeezing each one, which turned
            "switched off by flue" into a column of two words at 440px. The
            text size lives on the block, where a size belongs. */}
        <p className="text-base/6 text-muted-foreground sm:text-sm/6">
          <span className="font-mono">{device.id}</span>
          {seen ? (
            <>
              {' · '}
              <span className="tabular-nums">{seen}</span>
            </>
          ) : null}
          {status === 'disabled' ? ' · switched off by flue' : null}
        </p>
      </div>

      <div className="flex shrink-0 items-center gap-2">
        {status === 'disabled' ? null : (
          // `outline`, not the default: amber is this product's single accent
          // and it is spent on the one primary button per screen — the header
          // CTA. One amber button per row would put five of them down the page
          // and leave the eye nowhere to land. (Same argument the daemon's own
          // dashboard makes about coloured status dots, and the reason
          // `StatusBadge` above uses contrast rather than colour.)
          <Button variant="outline" size="sm" onClick={onOpen} disabled={opening}>
            {opening ? (
              <Spinner data-icon="inline-start" />
            ) : (
              <SquareTerminalIcon data-icon="inline-start" />
            )}
            Open a session
            {/* Five identical buttons need five different names. */}
            <span className="sr-only">on {device.label}</span>
          </Button>
        )}
        <DeviceMenu device={device} switchedOff={status === 'disabled'} revoke={revoke} rename={rename} />
      </div>
    </li>
  )
}

/**
 * Open a dialog on the tick *after* the menu that asked for it has closed.
 *
 * Both overlays manage focus, and a dialog mounted inside the menu item's own
 * event runs its focus trap while the menu is still restoring focus to its
 * trigger — the menu wins, because its restore happens on unmount, and the
 * dialog opens with focus on the button behind it. One tick of daylight puts
 * the two in the order a reader expects: menu closes, trigger regains focus,
 * dialog opens and takes it, dialog closes and hands it back to the trigger.
 */
function later(open: (next: boolean) => void): void {
  setTimeout(() => open(true), 0)
}

/**
 * Everything a row can do that is not "open a session", behind one control.
 *
 * Two icon buttons per row is two unlabelled glyphs multiplied by however many
 * machines somebody owns; one overflow trigger is one, and it has room for a
 * sentence next to a shut item — which is what the switched-off case needs.
 *
 * The two dialogs are siblings of the menu rather than nested in its items, and
 * both are controlled from here. A `DialogTrigger` inside a `DropdownMenuItem`
 * is a dialog that unmounts with the menu it lives in the moment the item is
 * chosen.
 */
function DeviceMenu({
  device,
  switchedOff,
  revoke,
  rename,
}: {
  device: DeviceSummary
  switchedOff: boolean
  revoke: (deviceId: string) => Promise<RevokeOutcome>
  rename: (deviceId: string, label: string) => Promise<RenameOutcome>
}) {
  const [renaming, setRenaming] = useState(false)
  const [revoking, setRevoking] = useState(false)
  const noteId = `switched-off-${device.id}`

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-sm">
            <EllipsisIcon />
            {/* Named after its row: one "More" per machine tells a screen
                reader nothing about which machine. */}
            <span className="sr-only">More actions for {device.label}</span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-64">
          <DropdownMenuGroup>
            {/* Named after its machine with an explicit label rather than a
                trailing sr-only span: the accessible name is what a screen
                reader reads out of a menu that has one item per row, and an
                `aria-label` states it in one string instead of leaving it to
                however the platform happens to join two text nodes. */}
            <DropdownMenuItem
              aria-label={`Rename ${device.label}`}
              onSelect={() => later(setRenaming)}
            >
              <PencilIcon />
              Rename
            </DropdownMenuItem>
            <DropdownMenuItem
              aria-label={`Revoke ${device.label}`}
              variant="destructive"
              // Shut rather than hidden, and shut rather than left to fail:
              // `revokeDevice` scopes its delete `disabled = false`, so this
              // click on this row could only ever end in a refusal toast. The
              // reason is one element away, named below.
              disabled={switchedOff}
              aria-describedby={switchedOff ? noteId : undefined}
              onSelect={() => later(setRevoking)}
            >
              <Trash2Icon />
              Revoke
            </DropdownMenuItem>
          </DropdownMenuGroup>
          {switchedOff ? (
            <>
              <DropdownMenuSeparator />
              {/* `text-wrap`, because DropdownMenuLabel is built for a word and
                  this is a sentence. */}
              <DropdownMenuLabel
                id={noteId}
                className="max-w-64 font-normal text-wrap text-muted-foreground"
              >
                {SWITCHED_OFF_NOTE}
              </DropdownMenuLabel>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>

      <RenameDialog device={device} rename={rename} open={renaming} onOpenChange={setRenaming} />
      <RevokeDialog device={device} revoke={revoke} open={revoking} onOpenChange={setRevoking} />
    </>
  )
}

function RenameDialog({
  device,
  rename,
  open,
  onOpenChange,
}: {
  device: DeviceSummary
  rename: (deviceId: string, label: string) => Promise<RenameOutcome>
  open: boolean
  onOpenChange: (next: boolean) => void
}) {
  const [label, setLabel] = useState(device.label)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const fieldId = `rename-${device.id}`

  async function onSubmit(event: FormEvent) {
    event.preventDefault()
    if (busy) return
    setBusy(true)
    setFailure(null)
    try {
      const result = await rename(device.id, label)
      if (!result.ok) {
        // Shown in the dialog rather than as a toast: this refusal is about
        // the field that is on screen, and closing the dialog to say so would
        // throw away what the person typed.
        setFailure(result.error)
        return
      }
      // The stored name, not the typed one — the normalizer may have collapsed
      // whitespace or trimmed a long name, and echoing the input would show a
      // name the database does not have.
      toast.success(`Renamed to ${result.label}`)
      setLabel(result.label)
      onOpenChange(false)
    } catch {
      setFailure(UNAVAILABLE_MESSAGE)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next)
        if (!next) {
          // Reopening starts from what the machine is actually called, not
          // from an abandoned edit.
          setLabel(device.label)
          setFailure(null)
        }
      }}
    >
      <DialogContent>
        <form onSubmit={onSubmit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>Rename this machine</DialogTitle>
            <DialogDescription>
              Only the name changes. The machine keeps its id, its enrolment and any session you
              have open on it.
            </DialogDescription>
          </DialogHeader>

          <Field data-invalid={failure ? true : undefined}>
            <FieldLabel htmlFor={fieldId}>Machine name</FieldLabel>
            <Input
              id={fieldId}
              name="label"
              autoComplete="off"
              autoFocus
              // Typing stops where storage stops. `renameDevice` refuses only
              // above MAX_LABEL_INPUT (1024) and *trims* to MAX_LABEL (64), so
              // capping the field at 64 is what keeps a person from typing a
              // name and being shown a shorter one back.
              maxLength={MAX_LABEL}
              aria-invalid={failure ? true : undefined}
              value={label}
              onChange={(e) => setLabel(e.target.value)}
            />
            {failure ? <FieldError>{failure}</FieldError> : null}
          </Field>

          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" disabled={busy}>
              {busy ? <Spinner data-icon="inline-start" /> : null}
              Save name
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function RevokeDialog({
  device,
  revoke,
  open,
  onOpenChange,
}: {
  device: DeviceSummary
  revoke: (deviceId: string) => Promise<RevokeOutcome>
  open: boolean
  onOpenChange: (next: boolean) => void
}) {
  const [busy, setBusy] = useState(false)

  async function onConfirm() {
    if (busy) return
    setBusy(true)
    try {
      const result = await revoke(device.id)
      if (!result.ok) {
        // The machine is still there, so the dialog stays too — closing it
        // would look exactly like success.
        toast.error(result.error)
        return
      }
      toast.success(`${device.label} was revoked`)
      onOpenChange(false)
    } catch {
      toast.error(UNAVAILABLE_MESSAGE)
    } finally {
      setBusy(false)
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          {/* Named, because "are you sure?" over a list of machines is a
              question about which one. */}
          <AlertDialogTitle>Revoke {device.label}?</AlertDialogTitle>
          <AlertDialogDescription>
            This machine stops being able to reach your account. Sessions already open close within
            a minute or two, and the daemon drops the next time it reconnects. Run{' '}
            <code className="font-mono">flue enable</code> on it again to bring it back.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={busy}
            // Radix closes on click; the close has to wait for the answer, or
            // a refusal would land on a dialog that is already gone.
            onClick={(event) => {
              event.preventDefault()
              void onConfirm()
            }}
          >
            {busy ? <Spinner data-icon="inline-start" /> : null}
            Revoke machine
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
