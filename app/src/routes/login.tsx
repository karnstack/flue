// /login — the route, and the two server functions behind it.
//
// The policy lives in server/login.ts; this file is the wire. Its own job is
// the part a wire can get wrong: turning whatever arrives over HTTP into the
// two strings the handler expects, and never letting anything else through.
// The validators below are not ceremony — these are the only unauthenticated
// POST endpoints in the app, so `data` is hostile until it has been read as
// strings.
import { createFileRoute, redirect, useNavigate } from '@tanstack/react-router'
import { createServerFn, useServerFn } from '@tanstack/react-start'
import { LoginForm } from '../components/login-form'
import type { RequestCodeInput, SubmitCodeInput } from '../server/login'
import { requestCode, submitCode } from '../server/login'
import { currentUser } from '../server/sessions'

/**
 * The longest thing each field is allowed to be.
 *
 * 320 is the RFC 3696 maximum for an address (64 local + @ + 255 domain), so
 * nothing rejected here was ever deliverable. The other two are generous
 * bounds on strings this app mints itself: eight digits and an invite code.
 *
 * Length is checked because these handlers are unauthenticated and every field
 * becomes work — an HMAC over the value, then a bound parameter in a D1 query.
 * A megabyte "address" is not an address; it is a way to make the server spend
 * a megabyte's worth of hashing per request, for free, before any cap has been
 * consulted.
 */
const MAX_EMAIL = 320
const MAX_INVITE = 128
const MAX_CODE = 32

/**
 * Read one field out of whatever the request carried.
 *
 * Two shapes reach here: the JSON payload the client RPC sends, and a FormData
 * body (Start accepts `multipart/form-data` and `application/x-www-form-
 * urlencoded` for server functions). Anything that is not a string — a number,
 * an object, an array of two values from a repeated form field — becomes the
 * empty string rather than travelling on as a query parameter of unknown type.
 *
 * So does anything longer than `max`. Rejected outright rather than truncated:
 * the first 320 bytes of a megabyte are not what anyone typed, and silently
 * turning one string into a different one is how a value ends up matching
 * something it was never meant to. Empty is a value every path below already
 * handles — it belongs to no account and holds no invite.
 */
function field(data: unknown, name: string, max: number): string {
  const raw =
    data instanceof FormData
      ? data.get(name)
      : (data as Record<string, unknown> | null | undefined)?.[name]
  if (typeof raw !== 'string' || raw.length > max) return ''
  return raw
}

const readRequestCode = (data: unknown): RequestCodeInput => ({
  email: field(data, 'email', MAX_EMAIL),
  invite: field(data, 'invite', MAX_INVITE),
})

const readSubmitCode = (data: unknown): SubmitCodeInput => ({
  email: field(data, 'email', MAX_EMAIL),
  code: field(data, 'code', MAX_CODE),
  invite: field(data, 'invite', MAX_INVITE),
})

/** POST: send a login code, if the address is allowed one. Always `{ok:true}`. */
export const requestCodeFn = createServerFn({ method: 'POST' })
  .validator(readRequestCode)
  .handler(({ data }) => requestCode(data))

/** POST: redeem a login code. `{ok:true}` sets the session cookie; `{ok:false}` says no more. */
export const submitCodeFn = createServerFn({ method: 'POST' })
  .validator(readSubmitCode)
  .handler(({ data }) => submitCode(data))

/**
 * Whether this request already has a session. A server function rather than a
 * direct `currentUser()` call because a route loader also runs in the browser
 * on a client-side navigation, where there is no request to read a cookie off.
 */
const isSignedIn = createServerFn({ method: 'GET' }).handler(async () => (await currentUser()) !== null)

export const Route = createFileRoute('/login')({
  component: LoginPage,
  loader: async () => {
    // Signing in again when you already are is a dead end — and this is also
    // what makes the new cookie observable end to end: the response that sets
    // it is followed by a request that is recognized.
    //
    // `href` rather than the type-checked `to`: /devices arrives in Task 8, and
    // `to` is checked against the generated route tree. Swap it then.
    if (await isSignedIn()) throw redirect({ href: '/devices' })
  },
})

function LoginPage() {
  const askForCode = useServerFn(requestCodeFn)
  const signIn = useServerFn(submitCodeFn)
  const navigate = useNavigate()

  return (
    <LoginForm
      requestCode={(data) => askForCode({ data })}
      submitCode={(data) => signIn({ data })}
      onSignedIn={() => {
        // A full document load, not a client-side transition: the session
        // cookie only just came into existence, and everything the server
        // rendered before it did was rendered for a signed-out visitor.
        void navigate({ href: '/devices', reloadDocument: true })
      }}
    />
  )
}
