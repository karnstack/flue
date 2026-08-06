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
// browser. Three things it has to get right, none of which it can guess:
//
//   1. **The URL.** These are Start server functions, so their URLs are
//      `/_serverFn/<id>` where the id is
//      `sha256("<file>--<name>_createServerFn_handler")` — deterministic, and
//      pinned by `enroll-e2e.test.ts` so a rename cannot move one silently.
//
//   2. **`Origin: https://<the host it is talking to>`.** start.ts installs
//      CSRF middleware over every server-fn RPC, which refuses a POST carrying
//      no origin signal at all. That is not a hole — CSRF exists to stop *a
//      browser* being made to speak for its user, and there is no ambient
//      credential on these two endpoints for a forged request to borrow.
//
//   3. **The body must be `application/x-www-form-urlencoded`, NOT JSON.**
//      Start reads a form-encoded (or multipart) body as `FormData` and hands
//      it to the validator as-is; *any* other body it runs through seroval's
//      `fromJSON`, which expects seroval's own cross-JSON node shape —
//      `{"t":10,"i":0,"p":{...}}` — and throws on a plain object. So a Go
//      client that does the obvious thing, `json.Marshal(struct{Label,
//      PublicKey})` with `Content-Type: application/json`, never reaches
//      `readStartDeviceAuth` as `{label, publicKey}`: it fails in Start's body
//      parse, above this file entirely, and gets back the seroval error
//      envelope that everything below goes to lengths to avoid — so not even
//      the JSON refusal it could have read. Send `label=...&publicKey=...`
//      (and `deviceCode=...` to poll) as form params. Every daemon-shaped call
//      in `enroll-e2e.test.ts` does, and one test posts JSON on purpose to pin
//      that it does not work.
import { createFileRoute, redirect } from '@tanstack/react-router'
import { createServerFn, useServerFn } from '@tanstack/react-start'
import { EnrollForm } from '../components/enroll-form'
import { MAX_LABEL_INPUT } from '../lib/label'
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
 * genuinely free-form field, and its bound is `MAX_LABEL_INPUT` — imported
 * from lib/label.ts rather than written down again, because the number only
 * means anything in relation to the `MAX_LABEL` the same module trims to, and
 * a local copy of one half of a pair is how the pair stops matching.
 *
 * Rejected outright rather than truncated — the first 64 bytes of a megabyte
 * are not what anyone typed, and silently turning one string into a different
 * one is how a value ends up matching something it was never meant to. `''` is
 * a value every handler below already refuses without a query.
 */
const MAX_USER_CODE = 64
const MAX_PUBLIC_KEY = 128
const MAX_DEVICE_CODE = 128

/**
 * Read one field out of whatever the request carried — a `FormData`, which is
 * what Start hands over for a form-encoded or multipart body, or the object the
 * browser's RPC client sends (seroval-encoded, and decoded before it gets
 * here). Anything that is not a string of a plausible length becomes `''`.
 *
 * A body that is neither — a hand-rolled `application/json` POST, say — decodes
 * to nothing usable, and every field then reads `''`. See the daemon note at
 * the top of the file: that is a wire mistake, not a validation one.
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
  label: field(data, 'label', MAX_LABEL_INPUT),
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

/**
 * The refusal, in the same JSON the success path speaks.
 *
 * Answered rather than thrown, and that is the whole point of this function: an
 * uncaught throw is not a 500 with a plain body, it is Start's *seroval* error
 * envelope with `x-tss-serialized: true` — the one shape on this endpoint the
 * Go daemon cannot read, and the reason both handlers return raw `Response`s in
 * the first place. A failure that answers in a shape the caller cannot parse is
 * indistinguishable, to that caller, from the service being down.
 *
 * Two kinds of failure, and only one of them is the caller's to see.
 * `DeviceAuthError` is the client error this module raises on purpose — 400 for
 * a key that is not 32 bytes, 429 for a caller over its cap — and its message is
 * written to be read by whoever runs the daemon, so it goes out verbatim with
 * the status it carries. Everything else is *ours*, and `err.message` is not a
 * sentence someone wrote for a stranger: drizzle raises a failed statement as
 * `Failed query: <the whole SQL>\nparams: <every bound value>`, so echoing it
 * hands an unauthenticated caller the schema *and* the parameters — on the
 * insert, a live user code and the daemon's key; on the poll, the stored
 * `sha256(deviceCode)` digest. (Measured, not guessed: that is what came back
 * when this path was tested against a real broken table.) So: logged where it
 * is useful, answered with a fixed string.
 */
function refusal(err: unknown, fallback: string): Response {
  if (err instanceof DeviceAuthError) return json({ error: err.message }, err.status)
  console.error('enroll: unexpected failure', err)
  return json({ error: fallback }, 500)
}

/** POST: open a grant, as the daemon. Unauthenticated: it has no credential yet. */
export const startDeviceAuthFn = createServerFn({ method: 'POST' })
  .validator(readStartDeviceAuth)
  .handler(async ({ data }) => {
    try {
      return json(await startDeviceAuth(data))
    } catch (err) {
      return refusal(err, 'enroll: could not open a grant')
    }
  })

/**
 * POST: ask what happened to a grant, as the daemon. The device code is the
 * credential.
 *
 * Wrapped like `startDeviceAuthFn` even though `pollDeviceAuth` raises no
 * `DeviceAuthError` of its own — every dead end is an ordinary `expired`. What
 * the wrapper is for is the failure nobody writes: this is the call the daemon
 * makes every five seconds for ten minutes, so it is the likeliest of the three
 * to be in flight when the database has a bad moment, and it must answer that
 * in JSON like everything else it says.
 */
export const pollDeviceAuthFn = createServerFn({ method: 'POST' })
  .validator(readDeviceCode)
  .handler(async ({ data }) => {
    try {
      return json(await pollDeviceAuth(data))
    } catch (err) {
      return refusal(err, 'enroll: could not read the grant')
    }
  })

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
