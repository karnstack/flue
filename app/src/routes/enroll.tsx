// /enroll — where a person approves a machine, and the three endpoints the
// handshake runs on.
//
// The policy is in server/enroll.ts; this file is the wire, and its job is the
// part a wire can get wrong. Three things live here and nowhere else.
//
// **The guard, on exactly one of the three.** Confirming binds a daemon to *the
// account this page was loaded with*, so it is the one call in the enrolment
// flow that needs a session. Three layers say so: the loader sends a signed-out
// visitor to /login rather than rendering a form that cannot work, `requireUser`
// middleware stops the mutation underneath it, and `confirmDeviceAuth` resolves
// the session itself and throws without one. The middleware is what turns an
// expired session into a redirect instead of an error; the check inside the
// handler is what survives this file being rewired.
//
// **And deliberately not on the other two.** `startDeviceAuth` and
// `pollDeviceAuth` are the daemon's half, and the daemon has no credential yet
// — getting one is what it is here for. They are exposed without `requireUser`
// for that reason, and everything that would otherwise be an authorization
// check is somewhere else: a per-IP cap on opening grants, a 256-bit device
// code as the only key to a poll, and (server/enroll.ts) an upsert that will
// not move a device between accounts.
//
// **The validators.** `data` arrives over HTTP and is hostile until it has been
// read as a string of bounded length — the same treatment /login gives its
// fields, for the same reason, and it matters more here: two of these three are
// unauthenticated, so every unbounded field is free work for anyone.
//
// A note for the daemon (Task 11), because it is the one caller that is not a
// browser. These are Start server functions, so their URLs are
// `/_serverFn/<id>` where the id is `sha256("<file>--<name>_createServerFn_handler")`
// — deterministic, and pinned by `enroll-e2e.test.ts` so a rename cannot move
// one silently. And start.ts installs CSRF middleware over every server-fn RPC,
// which refuses a POST carrying no origin signal at all: the daemon must send
// `Origin: https://<the host it is talking to>`. That is not a hole — CSRF
// exists to stop *a browser* being made to speak for its user, and there is no
// ambient credential on these two endpoints for a forged request to borrow.
import { createFileRoute, redirect } from '@tanstack/react-router'
import { createServerFn, useServerFn } from '@tanstack/react-start'
import { EnrollForm } from '../components/enroll-form'
import { requireUser } from '../server/auth'
import type { StartDeviceAuthInput } from '../server/enroll'
import {
  DeviceAuthError,
  confirmDeviceAuth,
  pollDeviceAuth,
  startDeviceAuth,
} from '../server/enroll'
import { currentUser } from '../server/sessions'

/**
 * The longest each field is allowed to be.
 *
 * A user code is eight letters; the slack is for a paste that brought a dash,
 * spaces or a stray URL fragment. A public key is 44 base64 characters and a
 * device code 43 base64url ones — both bounded well above that and nowhere
 * near far enough to be worth hashing a megabyte of. The label is the one
 * genuinely free-form field, and 1024 is what `normalizeLabel` reads before it
 * trims to 64.
 *
 * Rejected outright rather than truncated — the first 64 bytes of a megabyte
 * are not what anyone typed, and silently turning one string into a different
 * one is how a value ends up matching something it was never meant to. `''` is
 * a value every handler below already refuses without a query.
 */
const MAX_USER_CODE = 64
const MAX_PUBLIC_KEY = 128
const MAX_DEVICE_CODE = 128
const MAX_LABEL = 1024

/**
 * Read one field out of whatever the request carried — the client RPC's JSON or
 * a FormData body, both of which Start accepts. Anything that is not a string
 * of a plausible length becomes `''`.
 */
function field(data: unknown, name: string, max: number): string {
  const raw =
    data instanceof FormData
      ? data.get(name)
      : (data as Record<string, unknown> | null | undefined)?.[name]
  if (typeof raw !== 'string' || raw.length > max) return ''
  return raw
}

const readUserCode = (data: unknown) => ({ userCode: field(data, 'userCode', MAX_USER_CODE) })

const readStartDeviceAuth = (data: unknown): StartDeviceAuthInput => ({
  label: field(data, 'label', MAX_LABEL),
  publicKey: field(data, 'publicKey', MAX_PUBLIC_KEY),
})

const readDeviceCode = (data: unknown) => ({
  deviceCode: field(data, 'deviceCode', MAX_DEVICE_CODE),
})

/**
 * Plain JSON, and a status the caller can branch on.
 *
 * A server function that returns a value has it serialized by Start into its
 * own RPC envelope — a seroval graph, `{"t":10,"p":{"k":[...],"v":[...]}}` —
 * which the browser's client decodes for free and a Go program does not decode
 * at all. Returning a `Response` opts out: Start passes a raw one through
 * untouched. These two endpoints have exactly one caller and it is not a
 * browser, so they answer the thing that caller can read.
 */
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/** POST: open a grant, as the daemon. Unauthenticated: it has no credential yet. */
export const startDeviceAuthFn = createServerFn({ method: 'POST' })
  .validator(readStartDeviceAuth)
  .handler(async ({ data }) => {
    try {
      return json(await startDeviceAuth(data))
    } catch (err) {
      // Answered rather than thrown: an uncaught throw is a 500 carrying a
      // serialized stack, and "your key is not 32 bytes" is not a server
      // error. `DeviceAuthError` brings the status with it — 400 for a bad
      // key, 429 for a caller over its cap — because a daemon that cannot
      // tell those apart either hammers the limit or gives up on a typo.
      const status = err instanceof DeviceAuthError ? err.status : 500
      const error = err instanceof Error ? err.message : 'enroll: could not open a grant'
      return json({ error }, status)
    }
  })

/** POST: ask what happened to a grant, as the daemon. The device code is the credential. */
export const pollDeviceAuthFn = createServerFn({ method: 'POST' })
  .validator(readDeviceCode)
  .handler(async ({ data }) => json(await pollDeviceAuth(data)))

/** POST: approve a grant, as the signed-in user. `{ok:false}` is every refusal. */
export const confirmDeviceAuthFn = createServerFn({ method: 'POST' })
  .middleware([requireUser])
  .validator(readUserCode)
  .handler(({ data }) => confirmDeviceAuth(data))

/**
 * Whether this request has a session. A server function rather than a direct
 * `currentUser()` call because a route loader also runs in the browser on a
 * client-side navigation, where there is no request to read a cookie off.
 */
const isSignedIn = createServerFn({ method: 'GET' }).handler(
  async () => (await currentUser()) !== null,
)

export const Route = createFileRoute('/enroll')({
  component: EnrollPage,
  /**
   * `?code=` — what `startDeviceAuth` puts in `verificationUrlComplete` so the
   * daemon can print a link that lands with the field already filled.
   *
   * Bounded and coerced to a string, then rendered as the input's value and
   * nothing else: it is not submitted on arrival. Following a link is not
   * approving a machine, and a URL that enrolled a daemon by being visited
   * would be a one-click grant of somebody else's device to whoever clicked.
   *
   * The key is *omitted* rather than set to `''` when there is no code.
   * Whatever this returns is the route's canonical search, and the router
   * rewrites the URL to match it: returning `{ code: '' }` turns a plain
   * /enroll into a redirect to `/enroll?code=`, which costs every visitor
   * without a code an extra round trip before the loader below can even run —
   * including the signed-out one who is on their way to /login.
   */
  validateSearch: (search: Record<string, unknown>): { code?: string } => {
    const code = search.code
    if (typeof code !== 'string' || code.length === 0 || code.length > MAX_USER_CODE) return {}
    return { code }
  },
  loader: async () => {
    // A signed-out visitor cannot approve anything, so they get the sign-in
    // page rather than a form that would fail on submit. `to`, not `href`: it
    // is checked against the generated route tree.
    if (!(await isSignedIn())) throw redirect({ to: '/login' })
  },
})

function EnrollPage() {
  const { code } = Route.useSearch()
  const confirmCode = useServerFn(confirmDeviceAuthFn)

  return <EnrollForm initialCode={code} confirm={(data) => confirmCode({ data })} />
}
