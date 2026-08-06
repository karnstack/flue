// Fixed-window counters, in D1.
//
// Cloudflare's rate-limit binding is per-colo and approximate, which is fine
// for shedding load and useless for a cap that has to *hold* — so the real
// counters live in the database every other invariant already lives in.
//
// Today there is one caller: issuing a login code (server/login.ts). That path
// needs a cap because the one in `login_codes` is not one. It counts guesses
// against a single code, and issuing a new code deletes the old row — so five
// guesses per code, times as many codes as you can ask for, is not a limit.
// Capping the *issuing* is what turns it back into one.
//
// A fixed window, not a sliding one: the burst at a window boundary (up to 2x
// the limit across two adjacent windows) is not worth a second table and a
// scan. What matters is that the long-run rate is bounded.
import { getRequestHeaders, getRequestIP } from '@tanstack/react-start/server'
import { sql } from 'drizzle-orm'
import { db } from '../db/client'
import { rateLimits } from '../db/schema'
import { sha256Hex } from '../lib/tokens'

/** The window every login-code cap below is measured over. */
export const CODE_SEND_WINDOW_S = 15 * 60

/**
 * Login-code sends allowed per address per window. Five is a person who keeps
 * losing the email; the sixth is a script.
 */
export const CODE_SENDS_PER_EMAIL = 5

/**
 * Login-code sends allowed per client IP per window. Higher than the per-email
 * cap because one address can be a household, an office or a coffee shop
 * behind one NAT — and low enough that walking a list of addresses from a
 * single host stops after twenty.
 */
export const CODE_SENDS_PER_IP = 20

const nowSeconds = () => Math.floor(Date.now() / 1000)

/**
 * The IP this request came from, as far as anything can be trusted.
 *
 * `CF-Connecting-IP` first: Cloudflare sets it at the edge and overwrites
 * whatever the client sent, so it is the one header here that a caller cannot
 * choose for itself. `X-Forwarded-For` is deliberately NOT consulted — it is
 * client-supplied, and honouring it would let one host defeat the per-IP cap
 * by inventing a new address per request, which is worse than having no cap
 * (it would look like one).
 *
 * `getRequestIP()` is the fallback for a non-Cloudflare runtime (`vite dev`,
 * a node adapter); on Workers there is no socket behind it, so it returns
 * undefined and everything without an edge header shares the `unknown` bucket.
 * Sharing is the safe direction: it can only make the cap tighter.
 */
export function clientIp(): string {
  const edge = getRequestHeaders().get('cf-connecting-ip')
  if (edge) return edge
  return getRequestIP() ?? 'unknown'
}

/**
 * Count one event against `bucket`/`subject`, and say whether it is still
 * within `limit` for the current window.
 *
 * Every call counts, including the ones that come back false — a caller that
 * keeps hammering keeps itself over the line, and, more importantly, the
 * counting is identical for every subject. A limiter that only counted the
 * *interesting* events would tell an enumerator which addresses were
 * interesting.
 *
 * One statement, because two (read the row, then write it) lets concurrent
 * requests all read the same count and all decide they are under the limit.
 * The upsert rolls the window over and increments in the same breath, and
 * SQLite serializes it.
 */
export async function withinLimit(
  bucket: string,
  subject: string,
  limit: number,
  windowS: number,
): Promise<boolean> {
  const at = nowSeconds()
  const expired = at - windowS
  // The subject is an email address or an IP — personal data with no reason to
  // sit in a table in the clear, least of all for the addresses that turned out
  // to have no account. The digest is all a counter needs.
  const key = await sha256Hex(`${bucket}:${subject}`)

  const rolled = sql`${rateLimits.windowStart} <= ${expired}`
  const rows = await db()
    .insert(rateLimits)
    .values({ key, windowStart: at, count: 1 })
    .onConflictDoUpdate({
      target: rateLimits.key,
      set: {
        windowStart: sql`case when ${rolled} then ${at} else ${rateLimits.windowStart} end`,
        count: sql`case when ${rolled} then 1 else ${rateLimits.count} + 1 end`,
      },
    })
    .returning({ count: rateLimits.count })

  // No row back should be impossible (RETURNING fires for both halves of an
  // upsert). Treat it as "over the limit" anyway: failing closed here costs a
  // login code, failing open costs the cap.
  const count = rows[0]?.count
  return count !== undefined && count <= limit
}
