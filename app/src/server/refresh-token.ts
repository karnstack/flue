// Re-minting a browser's channel token, and the one place this service lets a
// cross-origin browser in.
//
// **Why it exists.** A client token lives sixty seconds (`CLIENT_TOKEN_TTL_S`)
// and the browser presents one per WebSocket dial. `openSession` puts the first
// one in the fragment; that covers the first dial and nothing after it. Every
// reconnect past that minute — a laptop lid, a tunnel, an edge dropping an idle
// socket — is refused at the upgrade, and the tab reconnects into the identical
// refusal for as long as it is open, with nothing on screen to say why. So the
// tab asks for a fresh token before each re-dial, and this is what answers.
//
// **Why it is cross-origin, and why that is narrow.** The tab lives on the
// relay's origin (`relay.flue.sh`); the session cookie that authorizes it
// belongs to this one (`app.flue.sh`). Those are different origins, so the
// browser needs a CORS allowance to *read* the answer — and it is scoped to
// exactly one origin, derived from `RELAY_URL` so there is no second variable
// to drift. Never `*`: a wildcard is not legal beside
// `Access-Control-Allow-Credentials: true` anyway, so a wildcard here would not
// be lax, it would be broken.
//
// **Why the origin check is a guard and not just a header.** CORS decides who
// may read a response; it decides nothing about who gets one. A browser sends a
// same-site POST *before* it learns the answer is unreadable, and
// `SameSite=Lax` only withholds the session cookie from cross-*site* requests —
// `evil.flue.sh` is same-site with `app.flue.sh`, so its POST would arrive
// carrying a live session. The global CSRF middleware (src/start.ts) does not
// cover this path: its filter is `handlerType === 'serverFn'`, and this is a
// server *route*. `allowedOrigin` (routes/api.relay-token.ts) is what stands in
// for it, and it is stricter — an allowlist of exactly two origins, with a
// request that names none of them refused outright.
//
// **Why a server route rather than a server function.** Three reasons, all of
// them about the caller being a browser on another origin. A server function is
// addressed at `/_serverFn/<content hash>`, which the web client would have to
// hardcode and both codebases would have to keep in step (see
// test/server-fn-ids.json for what that costs). A CORS preflight is an
// `OPTIONS`, and a route is where a method other than the handler's own can be
// answered at all. And `requireUser` — the middleware every dashboard call
// composes — throws a *redirect to /login*, which is the right answer for a
// document and the wrong one for a fetch that cannot follow it; this path
// answers 401 instead. What `requireUser` guarantees is still guaranteed twice
// over: the session is resolved here, and `mintClientToken` resolves it again
// and refuses without one.
//
// **One deployment constraint, and it is not obvious.** The session cookie is
// `SameSite=Lax` (server/sessions.ts), so it rides a cross-*origin* request
// only while the two hosts are same-*site*. `relay.flue.sh` and `app.flue.sh`
// share the registrable domain `flue.sh`, so they are — but a relay parked on
// `flue-relay.workers.dev` in front of `app.flue.sh` is not, and every refresh
// from it arrives with no cookie and is answered 401. docs/SAAS.md says so.
import { env } from 'cloudflare:workers'
import { mintClientToken } from './channel-token'
import { LONGEST_WINDOW_S, withinLimit } from './ratelimit'
import { currentUser } from './sessions'

/**
 * Where the endpoint lives.
 *
 * Spelled here rather than only in the route file, because the web client
 * (another package, another runtime) spells the same string — see
 * `web/src/relay/control-plane.ts`. A path is a contract the moment two
 * codebases share it, and test/relay-token-endpoint.test.ts drives the built
 * Worker at exactly this string.
 */
export const RELAY_TOKEN_PATH = '/api/relay-token'

/**
 * Channel tokens one account may re-mint per window.
 *
 * A separate bucket from `open-session:user`, and the separation is the point.
 * That one is sized for a person clicking "open a session": thirty in fifteen
 * minutes. A reconnect is not a person, and sharing the bucket would mean a
 * flaky network locks the account out of opening new sessions while thirty
 * clicks strand every open tab at its next reconnect. (Task 10's rule: a new
 * cap gets a new bucket, never a borrowed one.)
 *
 * **The number is arithmetic, not a guess, and the arithmetic has to have
 * slack in it.** FlueClient's backoff is capped at 10s with equal jitter, so a
 * tab reconnecting flat out asks every 5–10s: 90–180 per fifteen minutes, worst
 * case 180. And `withinLimit` counts refused calls too (deliberately — see
 * ratelimit.ts), so a cap a legitimate loop can *reach* is a cap it then holds
 * itself over for the rest of the fixed window: not a slowdown, a total outage
 * for that account until the window rolls. So this has to sit above the
 * worst case for as many tabs as a person plausibly has open. 600 is three of
 * them at full tilt.
 *
 * What it still bounds is what a stolen session cookie is worth: each token is
 * one device and sixty seconds, and this is the ceiling on how many of them an
 * eight-hour cookie can buy — 600 a window rather than unbounded.
 */
export const TOKENS_REFRESHED_PER_USER = 600

/**
 * The window that cap is measured over.
 *
 * Bound to ratelimit.ts's constant rather than chosen here, exactly as
 * `OPEN_SESSION_WINDOW_S` is: the sweep deletes counters older than
 * `LONGEST_WINDOW_S`, so a longer window would be swept mid-window and silently
 * reset (`withinLimit` refuses one outright).
 */
const REFRESH_WINDOW_S = LONGEST_WINDOW_S

/**
 * A refusal with the status a browser should be told, and a message written to
 * be read by whoever is looking at the screen.
 *
 * Three statuses and no more. 401 for "no session", which is the tab's cue to
 * send the user back to the dashboard; 403 for a machine that is not theirs, is
 * gone, or has been switched off — one sentence for all three, or this becomes
 * an existence oracle for other people's device ids; 429 for the cap.
 * Everything else that escapes this module is ours, and the route answers a
 * fixed string rather than drizzle's `Failed query: <SQL>\nparams: …`.
 */
export class RefreshRefused extends Error {
  constructor(
    readonly status: 401 | 403 | 429,
    message: string,
  ) {
    super(message)
    this.name = 'RefreshRefused'
  }
}

/**
 * The one browser origin allowed to call this endpoint, read per request.
 *
 * Derived from `RELAY_URL` — the address a WebSocket dials, `wss://relay…` —
 * because a browser's `Origin` header never says `wss`, and a second variable
 * spelling the same host in the http form is a second thing to get wrong. One
 * value, two readings.
 *
 * Fail-closed for the same reason `relayUrl()` is (server/channel-token.ts): a
 * deployment that forgot the variable must refuse the call rather than fall
 * through to a default origin nobody chose.
 */
export function relayBrowserOrigin(): string {
  const url = env.RELAY_URL
  if (!url) throw new Error('RELAY_URL is not set: refusing to allow a cross-origin token refresh')
  const parsed = new URL(url)
  // `wss:`→`https:`, `ws:`→`http:`. The same swap `openSession` makes, for the
  // same reason: one variable names the relay, and the two schemes are two
  // views of it.
  parsed.protocol = parsed.protocol === 'ws:' ? 'http:' : 'https:'
  return parsed.origin
}

/**
 * A fresh client channel token for a machine the signed-in caller owns.
 *
 * The authorization decision is `mintClientToken`'s, unchanged and unwidened: a
 * session, a device that belongs to that session's user, and neither the user
 * nor the device disabled — all four in one SQL predicate. That is what makes
 * this the revocation path as well as the reconnect path: disabling a device or
 * an account stops the next refresh, so a tab that is already open loses its
 * terminal at its next reconnect rather than at the end of the session. (What
 * it cannot do is cut a channel already open; docs/FOLLOW-UPS.md item 15.)
 *
 * Only the token comes back. The caller already knows which relay it is talking
 * to — it is the origin serving its page — and the key it pinned came with the
 * first grant. Returning `relayUrl` again would be a second copy of a fact that
 * cannot change mid-session, and returning the public key again would invite a
 * client to re-pin from a response rather than from the handoff.
 */
export async function refreshClientToken(deviceId: string): Promise<{ token: string }> {
  // Resolved here as well as inside the mint, for the reason every other module
  // in server/ states: a guard that lives only in the wiring is a guard the next
  // caller can forget to wire. It is also what makes the cap below chargeable to
  // an account rather than to an anonymous request.
  const user = await currentUser()
  if (!user) throw new RefreshRefused(401, 'Sign in again to reconnect.')

  // Before the mint, exactly as `openSession` counts before its own: what is
  // handed out below is a bearer credential the relay accepts *offline*, so
  // this function is the only thing standing between a session cookie and an
  // unbounded supply of them. Keyed by `user.id` — resolved from the session,
  // never taken from the caller — so naming a different machine buys no second
  // allowance and one account cannot spend another's.
  const withinCap = await withinLimit(
    'refresh-token:user',
    user.id,
    TOKENS_REFRESHED_PER_USER,
    REFRESH_WINDOW_S,
  )
  if (!withinCap) {
    throw new RefreshRefused(429, 'Too many reconnections just now. Wait a few minutes and try again.')
  }

  try {
    const { token } = await mintClientToken(deviceId)
    return { token }
  } catch (err) {
    // A refusal from the mint is about this device and is safe to pass on as
    // one sentence; a configuration failure (`RELAY_URL is not set`) is not the
    // caller's to read, and travels on to the route's fixed-string handler.
    if (err instanceof Error && err.message === 'mintClientToken: no such device') {
      throw new RefreshRefused(403, 'That machine is no longer reachable from this account.')
    }
    throw err
  }
}
