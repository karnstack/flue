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
