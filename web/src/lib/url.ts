/** The query parameter `flue open` and `flue serve` put the handoff token in. */
export const HANDOFF_PARAM = 'h'

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

/** The query parameters a pairing link carries its credentials in: the
 *  single-use token, the daemon's static public key, and the fleet public key.
 *  `internal/daemon/conn.go` writes all three, and routes/pair.tsx is the one
 *  reader. */
export const PAIRING_TOKEN_PARAM = 't'
export const PAIRING_KEY_PARAM = 'k'
export const PAIRING_FLEET_PARAM = 'f'

/** The three the scrub takes, in one place so a fourth cannot be added to the
 *  link and forgotten here. */
const PAIRING_PARAMS = [PAIRING_TOKEN_PARAM, PAIRING_KEY_PARAM, PAIRING_FLEET_PARAM]

/**
 * Remove the pairing credentials from the address bar.
 *
 * The pairing link carries `?t=<single-use token>&k=<daemon static key>` and,
 * from a daemon that holds a fleet key, `&f=<fleet public key>`. Unlike `h`
 * they cannot be stripped at the entry point: main.tsx runs before the router
 * reads the location, so a scrub there would be a ceremony that never starts.
 * The pairing page calls this instead, after it has captured all three into
 * memory — the token is a live bearer credential until the daemon's two-minute
 * window closes, and the address bar is where it would otherwise outlive the
 * ceremony: in the history entry, in anything that syncs history, and in
 * whatever the user copies out of it.
 *
 * The two keys are public, and they go with the token anyway. They are read
 * once, on the first render, and never from the address bar again — so what a
 * link still carrying them is, after that, is a live-looking pairing link with
 * a spent token in it, sitting in a history entry to be reopened or forwarded.
 * The keys are also the whole of what the ceremony pins, and `f` is the pin
 * for every machine this browser will ever dial; the fewer places it can be
 * copied out of and pasted into a link somebody else opens, the better.
 *
 * `d` and `n` are left where they are. A machine id and its display name are
 * not credentials of any kind, and stripping them would be a second job hiding
 * inside a function named for one.
 *
 * replaceState rather than pushState, because the entry holding the token is
 * the thing being rewritten, not something to keep behind the back button.
 * The href handed to it is relative: a same-document rewrite needs no origin,
 * and not restating one is one fewer thing to have wrong.
 */
export function scrubPairingParams(): void {
  const u = new URL(location.href)
  if (!PAIRING_PARAMS.some((p) => u.searchParams.has(p))) return
  // delete() removes every entry with the name; get()/set() would leave a
  // second copy of a repeated parameter behind.
  for (const p of PAIRING_PARAMS) u.searchParams.delete(p)
  const query = u.searchParams.toString()
  history.replaceState(null, '', `${u.pathname}${query ? `?${query}` : ''}${u.hash}`)
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
