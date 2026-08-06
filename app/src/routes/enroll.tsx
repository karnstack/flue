// /enroll — where a person approves a machine.
//
// The policy is in server/enroll.ts; this file is the wire, and its job is the
// part a wire can get wrong. Two things live here and nowhere else.
//
// **The guard.** Confirming binds a daemon to *the account this page was loaded
// with*, so it is the one call in the enrolment flow that needs a session —
// `startDeviceAuth` and `pollDeviceAuth` are unauthenticated by design, because
// the daemon making them has no credential yet. Three layers say so: the loader
// sends a signed-out visitor to /login rather than rendering a form that cannot
// work, `requireUser` middleware stops the mutation underneath it, and
// `confirmDeviceAuth` resolves the session itself and throws without one. The
// middleware is what turns an expired session into a redirect instead of an
// error; the check inside the handler is what survives this file being rewired.
//
// **The validator.** `data` arrives over HTTP and is hostile until it has been
// read as a string of bounded length — the same treatment /login gives its
// fields, for the same reason.
import { createFileRoute, redirect } from '@tanstack/react-router'
import { createServerFn, useServerFn } from '@tanstack/react-start'
import { EnrollForm } from '../components/enroll-form'
import { requireUser } from '../server/auth'
import { confirmDeviceAuth } from '../server/enroll'
import { currentUser } from '../server/sessions'

/**
 * The longest user code read before giving up on it.
 *
 * A code is eight letters; the slack is for a paste that brought a dash,
 * spaces or a stray URL fragment. Rejected outright rather than truncated —
 * the first 64 bytes of a megabyte are not what anyone typed, and `''` is a
 * value `confirmDeviceAuth` already refuses without a query.
 */
const MAX_USER_CODE = 64

/**
 * Read the code out of whatever the request carried — the client RPC's JSON or
 * a FormData body, both of which Start accepts. Anything that is not a string
 * of a plausible length becomes `''`.
 */
function readUserCode(data: unknown): { userCode: string } {
  const raw =
    data instanceof FormData
      ? data.get('userCode')
      : (data as Record<string, unknown> | null | undefined)?.userCode
  if (typeof raw !== 'string' || raw.length > MAX_USER_CODE) return { userCode: '' }
  return { userCode: raw }
}

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
