/** The query parameter `flue open` and `flue serve` put the handoff token in. */
export const HANDOFF_PARAM = 'h'

/**
 * The **fragment** parameters the control plane hands a browser a session in.
 *
 * A fragment and not a query, and the difference is the whole point: a query
 * string is sent to the server, so it lands in the relay Worker's logs, in any
 * proxy's access log and in the `Referer` of whatever the page loads next. A
 * fragment is never put on the wire at all — it reaches this page and nothing
 * else (app/src/server/devices.ts, `openSession`).
 *
 * Four parameters, one of them a secret:
 *
 *   - `t` the channel token, good for sixty seconds and one WebSocket upgrade;
 *   - `k` the target machine's Noise static public key, base64url. The
 *     handshake this tab is about to run names it as the responder's static, so
 *     without it a hosted relay — one origin in front of every machine on every
 *     account — has no way to tell one daemon from another;
 *   - `d` the device id that key belongs to. The record the key is pinned
 *     under, and the machine this tab names when it comes back for a token;
 *   - `a` the control plane's own origin, which is where it comes back *to*.
 *
 * Only `t` is a credential. The other three are public facts about a machine
 * the person opening this session owns, and they ride in the fragment for the
 * same reason `t` does: they are addressed to this tab and to nothing on the
 * wire.
 */
export const CHANNEL_TOKEN_PARAM = 't'
export const DAEMON_KEY_PARAM = 'k'
export const DEVICE_ID_PARAM = 'd'
export const CONTROL_PLANE_PARAM = 'a'

/** Everything the control plane put in the fragment, once it has been read. */
export interface RelayHandoff {
  /** The channel token for the first dial. A bearer credential. */
  token: string
  /** The daemon's Noise static public key, still base64url. */
  daemonKey: string
  /** The machine the key belongs to: 12 hex characters. */
  deviceId: string
  /** Where to ask for the *next* token — an origin, e.g. `https://app.flue.sh`. */
  controlPlane: string
}

/**
 * Remove the one-time handoff token from a URL.
 *
 * `flue open` and `flue serve` hand the browser a URL carrying
 * `?h=<one-time handoff token>`. The daemon redeems it on that first request,
 * sets the HttpOnly `flue_token` cookie, and invalidates the token — so by the
 * time any of this code runs the secret is already spent. It must still not be
 * left in `location.href`, where it would reach the history entry, a referrer
 * header, and anything the user copies out of the address bar.
 *
 * The session token is never in a URL at all and never comes back: this strips
 * `h`, and there is no parameter under which the daemon would accept the real
 * token.
 *
 * The fragment is preserved. Nothing uses one today, but dropping it would be
 * a silent second edit hiding inside a function named for one job.
 */
export function stripHandoff(url: string): string {
  const u = new URL(url)
  if (!u.searchParams.has(HANDOFF_PARAM)) return url
  // delete() removes every entry with the name; get()/set() would leave a
  // second copy of a repeated parameter behind.
  u.searchParams.delete(HANDOFF_PARAM)
  const query = u.searchParams.toString()
  return `${u.origin}${u.pathname}${query ? `?${query}` : ''}${u.hash}`
}

/**
 * Take the one-shot `cwd` that `flue open <path>` put in the URL.
 *
 * Read once and stripped immediately with replaceState. Unlike an in-memory
 * ref, a URL parameter survives whatever comes after the first paint — a
 * reload, a bookmark, a link pasted somewhere else — and each of those would
 * hand the same directory back out to whoever reads it next. Consuming the
 * parameter here, rather than merely reading it, is what keeps a second look
 * at the same URL from asking for a second session.
 */
export function takeCwd(): string | null {
  const u = new URL(location.href)
  const cwd = u.searchParams.get('cwd')
  if (cwd === null) return null
  u.searchParams.delete('cwd')
  const query = u.searchParams.toString()
  history.replaceState(null, '', `${u.origin}${u.pathname}${query ? `?${query}` : ''}${u.hash}`)
  return cwd
}

/**
 * Take the session handoff the control plane put in the fragment.
 *
 * `takeCwd`'s shape, for a secret rather than a convenience: read once, and
 * `replaceState` it away in the same breath. The token is a bearer credential
 * good for one WebSocket upgrade — 60 seconds, one account, one device
 * (app/src/server/channel-token.ts) — and every place a copy of it comes to
 * rest is a place it can be replayed from. The fragment already kept it off
 * the wire; this keeps it out of the history entry, the bookmark, the back
 * button and the screenshot of the address bar.
 *
 * All four parameters are removed, not merely the secret one. Two reasons, and
 * the second is the one that would bite: a leftover `#d=…&k=…` is the whole
 * address of somebody's machine sitting in the address bar of a screenshot,
 * and a URL that still carried them would look re-openable when the credential
 * it needs is long gone.
 *
 * Null unless *all four* arrived, because three of them is not a session and a
 * partial handoff can only fail later and more confusingly. Anything present is
 * still scrubbed on the way to that null — a `t=` with nothing beside it is a
 * spent credential, and leaving it in the URL leaves the shape of one.
 *
 * Only the fragment is read. There is deliberately no `?t=` fallback: a query
 * parameter is exactly what the fragment exists to avoid, and a "just in case"
 * second spelling would re-open it for every URL anyone ever pastes.
 *
 * Other fragment parameters survive, and a fragment that is not a parameter
 * list (`#top`) is left untouched — this must not fight `stripHandoff`, which
 * preserves the fragment on purpose, or the router, which reads the location
 * immediately after.
 */
export function takeRelayHandoff(): RelayHandoff | null {
  const params = new URLSearchParams(location.hash.replace(/^#/, ''))
  const fields = [
    CHANNEL_TOKEN_PARAM,
    DAEMON_KEY_PARAM,
    DEVICE_ID_PARAM,
    CONTROL_PLANE_PARAM,
  ] as const
  if (!fields.some((f) => params.has(f))) return null

  const values = fields.map((f) => params.get(f) ?? '')
  for (const field of fields) params.delete(field)
  const rest = params.toString()
  history.replaceState(null, '', `${location.pathname}${location.search}${rest ? `#${rest}` : ''}`)

  const [token, daemonKey, deviceId, controlPlane] = values as [string, string, string, string]
  if (!token || !daemonKey || !deviceId || !controlPlane) return null
  return { token, daemonKey, deviceId, controlPlane }
}
