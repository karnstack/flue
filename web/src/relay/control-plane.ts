/*
 * The one call this app makes to a *different* origin.
 *
 * Everything else a tab does goes to the origin that served it: the daemon on
 * loopback, or the relay Worker on a hosted one. This is the exception, and it
 * exists because of an arithmetic problem. A relay channel token lives sixty
 * seconds (`CLIENT_TOKEN_TTL_S`, app/src/server/channel-token.ts) and the relay
 * socket presents one per dial. The token in the fragment covers the first dial
 * and nothing after it — so a laptop lid, a tunnel, an edge dropping an idle
 * socket, anything at all that costs the tab a reconnect past that minute, is
 * refused at the upgrade and reconnects into the identical refusal for as long
 * as the tab is open. Nothing on screen says why.
 *
 * So before each re-dial the tab asks the control plane for a new one. The
 * session cookie it already holds is the credential; this request carries
 * nothing of its own.
 *
 * Three things about this request are load-bearing:
 *
 *   - **`credentials: 'include'`.** Without it a cross-origin fetch sends no
 *     cookie and every refresh is a 401. The cookie is `SameSite=Lax`, which
 *     rides a cross-*origin* request only while the two hosts are
 *     same-*site* — `relay.flue.sh` and `app.flue.sh` share `flue.sh`, so it
 *     does. A relay on a different registrable domain would not get one, and
 *     docs/SAAS.md says so.
 *   - **form-encoded, no custom headers.** That makes this a "simple" request
 *     in CORS terms, so it costs no preflight round trip on every reconnect.
 *     JSON would cost one. The endpoint answers a preflight anyway
 *     (app/src/routes/api.relay-token.ts) — this just never needs it.
 *   - **the origin is not a constant here.** It arrives in the handoff
 *     fragment, from the control plane that wrote it, because the same bundle
 *     is served by the daemon over loopback, by a self-hosted relay, and by
 *     flue.sh — and a hardcoded `app.flue.sh` would be a fourth deployment
 *     fact for a build that has deliberately none (see ./mode).
 */

/**
 * The endpoint, spelled the same on both sides of a package boundary.
 *
 * `RELAY_TOKEN_PATH` in app/src/server/refresh-token.ts is the other copy, and
 * app/test/relay-token-endpoint.test.ts drives the built Worker at exactly this
 * string. A path is a contract the moment two codebases share it.
 */
export const RELAY_TOKEN_PATH = '/api/relay-token'

/** The `fetch` this module needs, so a test can substitute one. */
export type Fetch = (url: string, init: RequestInit) => Promise<Response>

/**
 * How long to wait for a token before giving up on this dial.
 *
 * A `fetch` has no timeout of its own in any browser, and the failure it does
 * not have is the one that matters here: a captive portal or a blackholed TCP
 * connection leaves the promise pending forever, so the socket never dials
 * *and never closes*. FlueClient arms its retry from `onclose`, so a promise
 * that never settles parks the tab at `reconnecting` with no socket and no
 * timer, for as long as it is open — precisely the silent dead end this whole
 * path exists to remove.
 *
 * Ten seconds is the same order as FlueClient's own backoff ceiling, so a
 * timed-out attempt costs about one extra retry interval.
 */
const TOKEN_TIMEOUT_MS = 10_000

/**
 * What a channel token is allowed to look like: two base64url parts and a dot
 * (app/src/lib/tokens.ts, `signChannelToken`).
 *
 * Checked because of where the value goes next. The token rides in
 * `Sec-WebSocket-Protocol` as `flue.token.<token>`, and `new WebSocket` throws
 * a *synchronous* SyntaxError for a subprotocol that is not an HTTP token — so
 * a space, a comma or a control character in an answer from a control plane
 * that is having a strange day would become a throw at the dial rather than a
 * refusal here. The bound is the same one the relay applies before it verifies
 * anything (`MAX_CHANNEL_TOKEN_LENGTH`).
 */
const TOKEN_SHAPE = /^[A-Za-z0-9._-]{1,4096}$/

/**
 * A fresh channel token for `deviceId`, from the control plane at
 * `controlPlane`.
 *
 * Throws for every failure, undistinguished. The caller is the relay socket,
 * and there is exactly one thing it does about any of them — report an ordinary
 * close, which is what FlueClient already knows how to back off and retry from.
 * A 401 (the session has expired), a 403 (the machine was revoked or switched
 * off), a 429, a network that is simply down: telling them apart here would
 * only move the decision, and the retry is right for all of them. What ends the
 * loop is the person, and FlueClient's ten-second ceiling is what keeps it
 * cheap while they think about it.
 */
export async function refreshClientToken(
  controlPlane: string,
  deviceId: string,
  doFetch: Fetch = (url, init) => fetch(url, init),
): Promise<string> {
  const res = await doFetch(new URL(RELAY_TOKEN_PATH, controlPlane).toString(), {
    method: 'POST',
    // The session cookie is the whole credential. Nothing in this body or
    // these headers authenticates anything.
    credentials: 'include',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ deviceId }).toString(),
    // A redirect to /login is what a signed-out *document* gets; this is not
    // one, and following it would parse an HTML page as a token.
    redirect: 'error',
    // See TOKEN_TIMEOUT_MS: a request that never settles is worse than one
    // that fails, because only a failure reaches FlueClient's retry.
    signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
  })

  if (!res.ok) throw new Error(`relay token: the control plane answered ${res.status}`)

  const body = (await res.json()) as { token?: unknown }
  if (typeof body.token !== 'string' || !TOKEN_SHAPE.test(body.token)) {
    throw new Error('relay token: the control plane answered without a usable one')
  }
  return body.token
}
