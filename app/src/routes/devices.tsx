// /devices — the screen this whole service exists to show, and the four server
// functions behind it.
//
// The policy is in server/devices.ts; this file is the wire, and it has three
// jobs a wire can get wrong.
//
// **The guard, on all four.** Every function here composes `requireUser`, which
// throws a redirect to /login when there is no session. That is what turns an
// expired session into a sign-in page instead of an error under a spinner — and
// it is worth knowing exactly what it looks like on the wire, because the two
// halves differ and `devices-e2e.test.ts` pins both. A *document* request to
// /devices gets a real 3xx with `Location: /login`, because the loader's call
// throws before anything renders. An *RPC* gets `200` with `Location: /login`
// and a seroval payload carrying `isSerializedRedirect`: Start serializes the
// navigation for its client rather than answering a status the fetch would
// follow, since following it would hand the RPC client an HTML document. On
// that path the header and the body say the guard fired; the status does not.
//
// **The refusal shape, on all four.** Each handler answers
// `{ok:true, …} | {ok:false, error}` and never throws. An uncaught throw is not
// a 500 with a tidy message — Start serializes the `Error` into its RPC
// envelope, message included, and drizzle raises a failed statement as
// `Failed query: <the whole SQL>\nparams: <every bound value>`. On these paths
// those parameters are the account id and the device id, so a database with a
// bad moment would hand the browser the schema and the session's user. Same
// treatment routes/enroll.tsx gives the daemon endpoints, for the same reason,
// in the shape a browser speaks rather than raw JSON.
//
// **The validators.** `data` arrives over HTTP and is a string of bounded
// length or it is nothing — the same treatment /login and /enroll give their
// fields. These four are authenticated, so the exposure is smaller, but a
// bound is also what keeps an oversized field from becoming a megabyte-long
// bound parameter in D1.
//
// One deliberate choice worth stating: every function here is POST, including
// the read. They are RPCs, not resources, and one method means one CSRF story
// (start.ts validates every server-fn POST) and one shape for the tests to
// drive. Nothing here is cacheable or linkable anyway — the list is per-session
// and the other three are mutations.
import { createFileRoute, useRouter } from '@tanstack/react-router'
import { createServerFn, useServerFn } from '@tanstack/react-start'
import { CloudOffIcon, RotateCwIcon } from 'lucide-react'
import { DeviceDirectory, type DeviceSummary } from '../components/device-directory'
import { Button } from '../components/ui/button'
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '../components/ui/empty'
import { Skeleton } from '../components/ui/skeleton'
import { requireUser } from '../server/auth'
import {
  DeviceError,
  listDevices,
  openSession,
  renameDevice,
  revokeDevice,
} from '../server/devices'
import { MAX_LABEL_INPUT } from '../lib/label'

/**
 * The longest each field is allowed to be.
 *
 * A device id is 12 hex characters; the slack is for nothing in particular,
 * which is the point — it is a bound, not a format check, and the format is
 * checked where the id is used. The label's bound is the one lib/label.ts
 * reads before it trims to 64.
 */
const MAX_DEVICE_ID = 64

/**
 * Read one field out of whatever the request carried — a `FormData` (what
 * Start hands over for a form-encoded or multipart body) or the object the
 * browser's RPC client sends. Anything that is not a string of a plausible
 * length becomes `''`, which every handler below already refuses.
 */
function field(data: unknown, name: string, max: number): string {
  const raw =
    data instanceof FormData
      ? data.get(name)
      : (data as Record<string, unknown> | null | undefined)?.[name]
  if (typeof raw !== 'string' || raw.length > max) return ''
  return raw
}

const readDeviceId = (data: unknown) => ({ deviceId: field(data, 'deviceId', MAX_DEVICE_ID) })

const readRename = (data: unknown) => ({
  deviceId: field(data, 'deviceId', MAX_DEVICE_ID),
  label: field(data, 'label', MAX_LABEL_INPUT),
})

/** A refusal, in the same shape the success path speaks. */
export type Refusal = { ok: false; error: string }

/**
 * Two kinds of failure, and only one of them is the caller's to see.
 *
 * `DeviceError` is what server/devices.ts raises on purpose — "no such
 * machine", "a machine needs a name" — and every message on it is written to be
 * read by whoever is looking at the screen, so it goes out verbatim.
 * Everything else is ours, and `err.message` is not a sentence anyone wrote for
 * a stranger: a drizzle failure arrives as `Failed query: <SQL>\nparams: <every
 * bound value>`, which here means the account id and the device id. (Measured,
 * not guessed — `devices-e2e.test.ts` renames the table out from under the
 * running Worker and reads what comes back.) Logged where it is useful,
 * answered with a fixed string.
 */
function refusal(err: unknown, fallback: string): Refusal {
  if (err instanceof DeviceError) return { ok: false, error: err.message }
  console.error('devices: unexpected failure', err)
  return { ok: false, error: fallback }
}

/**
 * POST: every machine on the caller's account.
 *
 * `now` rides along, and it is not decoration. The screen renders "seen 3h ago"
 * from `last_seen`, so it needs a clock — and if the server rendered that
 * sentence against its own clock and the browser then hydrated against the
 * visitor's, the two would disagree whenever a minute ticked over between the
 * response and the paint, or whenever a machine's clock is simply wrong. React
 * calls that a hydration mismatch and re-renders the subtree; a reader with a
 * skewed clock would see "seen 4h ago" for something the server knows was 3.
 * One clock, chosen where the data comes from, and both renders agree.
 */
export const listDevicesFn = createServerFn({ method: 'POST' })
  .middleware([requireUser])
  .handler(
    async ({
      context,
    }): Promise<
      { ok: true; devices: Array<DeviceSummary>; email: string; now: number } | Refusal
    > => {
      try {
        return {
          ok: true,
          devices: await listDevices(),
          email: context.user.email,
          now: Math.floor(Date.now() / 1000),
        }
      } catch (err) {
        return refusal(err, 'Your machines could not be loaded. Try again in a moment.')
      }
    },
  )

/** POST: take a machine off the account. Deletes the row; see server/devices.ts. */
export const revokeDeviceFn = createServerFn({ method: 'POST' })
  .middleware([requireUser])
  .validator(readDeviceId)
  .handler(async ({ data }): Promise<{ ok: true } | Refusal> => {
    try {
      await revokeDevice(data.deviceId)
      return { ok: true }
    } catch (err) {
      return refusal(err, 'That machine could not be revoked. Try again in a moment.')
    }
  })

/** POST: rename a machine. Answers the name that was *stored*. */
export const renameDeviceFn = createServerFn({ method: 'POST' })
  .middleware([requireUser])
  .validator(readRename)
  .handler(async ({ data }): Promise<{ ok: true; label: string } | Refusal> => {
    try {
      return { ok: true, label: await renameDevice(data.deviceId, data.label) }
    } catch (err) {
      return refusal(err, 'That machine could not be renamed. Try again in a moment.')
    }
  })

/**
 * POST: mint a client channel token and say where to present it.
 *
 * The handoff from the control plane to the relay, and the one response here
 * that contains a bearer credential — so it is also the one whose failure path
 * matters most. `mintClientToken` states the whole authorization decision in a
 * single SQL predicate (a session, a device that belongs to it, neither killed)
 * and nothing downstream asks a second question; what the wrapper adds is that
 * a *database* failure under it answers a fixed string rather than the
 * statement and its bound parameters.
 */
export const openSessionFn = createServerFn({ method: 'POST' })
  .middleware([requireUser])
  .validator(readDeviceId)
  .handler(async ({ data }): Promise<{ ok: true; url: string } | Refusal> => {
    try {
      return { ok: true, url: (await openSession(data.deviceId)).url }
    } catch (err) {
      return refusal(err, 'That session could not be opened. Try again in a moment.')
    }
  })

export const Route = createFileRoute('/devices')({
  component: DevicesPage,
  pendingComponent: LoadingDevices,
  errorComponent: DevicesUnavailable,
  /**
   * The list is loaded before the screen renders, so a signed-in visitor sees
   * their machines in the server-rendered HTML rather than a spinner that
   * resolves after hydration.
   *
   * There is no `isSignedIn` pre-check here (as /enroll has): `listDevicesFn`
   * composes `requireUser`, so a signed-out visitor's redirect is thrown by
   * the call itself, one round trip earlier than a check would manage and in
   * the one place that cannot be forgotten.
   */
  loader: () => listDevicesFn(),
})

function DevicesPage() {
  const loaded = Route.useLoaderData()
  const router = useRouter()
  const open = useServerFn(openSessionFn)
  const revoke = useServerFn(revokeDeviceFn)
  const rename = useServerFn(renameDeviceFn)

  /**
   * Reload the list from the server after a mutation lands, rather than
   * editing the array on screen.
   *
   * A local edit is a second source of truth for the same rows, and this
   * screen is one where the two can genuinely disagree: a machine can be
   * revoked from another tab, and `last_seen` moves on its own. Refetching
   * costs one round trip on an action a person takes by hand.
   */
  const reload = () => router.invalidate()

  // The `<Toaster/>` is mounted once, in __root.tsx. Sonner keeps a single
  // global queue, so a second one here would render every toast twice.
  return (
    <DeviceDirectory
      devices={loaded.ok ? loaded.devices : []}
      email={loaded.ok ? loaded.email : undefined}
      error={loaded.ok ? null : loaded.error}
      now={loaded.ok ? loaded.now : undefined}
      openSession={(deviceId) => open({ data: { deviceId } })}
      revoke={async (deviceId) => {
        const result = await revoke({ data: { deviceId } })
        if (result.ok) await reload()
        return result
      }}
      rename={async (deviceId, label) => {
        const result = await rename({ data: { deviceId, label } })
        if (result.ok) await reload()
        return result
      }}
    />
  )
}

/**
 * The client-side navigation case: the loader is in flight.
 *
 * A skeleton of the screen that is coming rather than a spinner in the middle
 * of an empty page. Two reasons, and neither is decoration. The layout is
 * already known — a heading, a button, then rows — so drawing it costs nothing
 * and the content lands into the shape it was already occupying instead of
 * shoving a centred spinner off the page. And a spinner alone says "something
 * is happening"; this says *what*, which on the one screen where "your machines
 * are gone" is a plausible reading of a blank page is worth saying.
 *
 * `aria-hidden` on the bones with one live region above them: a screen reader
 * gets the sentence, not a description of grey rectangles.
 */
function LoadingDevices() {
  return (
    <main className="mx-auto w-full max-w-4xl px-4 py-8 sm:px-6 sm:py-12 lg:px-8">
      <p role="status" className="sr-only">
        Loading your machines…
      </p>
      <div aria-hidden="true" className="flex flex-col gap-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div className="flex flex-col gap-2">
            <Skeleton className="h-7 w-44" />
            <Skeleton className="h-4 w-64" />
          </div>
          <Skeleton className="h-8 w-40" />
        </div>
        <div className="flex flex-col divide-y divide-foreground/10 border-y border-foreground/10">
          {[0, 1, 2].map((row) => (
            <div
              key={row}
              className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="flex flex-col gap-2">
                <Skeleton className="h-5 w-40" />
                <Skeleton className="h-4 w-52" />
              </div>
              <Skeleton className="h-8 w-36" />
            </div>
          ))}
        </div>
      </div>
    </main>
  )
}

/**
 * The loader threw — which, given the handler catches everything, means the
 * transport itself failed. Not the same as `{ok:false}`, which the screen
 * renders in place.
 *
 * Offers the reload rather than describing it: this is the one failure on the
 * screen that a second attempt genuinely might fix, and the page it would
 * replace has nothing else on it.
 */
function DevicesUnavailable() {
  return (
    <main className="mx-auto flex w-full max-w-4xl flex-1 items-center px-4 py-8 sm:px-6 sm:py-12 lg:px-8">
      <Empty className="w-full border border-dashed">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <CloudOffIcon />
          </EmptyMedia>
          {/* A real heading inside EmptyTitle, which is a styled div: this
              screen renders instead of the whole page, so it owns the h1. */}
          <EmptyTitle>
            <h1>Your machines could not be loaded</h1>
          </EmptyTitle>
          <EmptyDescription>
            Something went wrong at our end, and this page never heard back. Nothing has changed on
            your account — try again in a moment.
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button variant="outline" onClick={() => window.location.reload()}>
            <RotateCwIcon data-icon="inline-start" />
            Try again
          </Button>
        </EmptyContent>
      </Empty>
    </main>
  )
}
