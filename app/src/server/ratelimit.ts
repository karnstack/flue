// Fixed-window counters, in D1.
//
// Cloudflare's rate-limit binding is per-colo and approximate, which is fine
// for shedding load and useless for a cap that has to *hold* — so the real
// counters live in the database every other invariant already lives in.
//
// The first caller was issuing a login code (server/login.ts). That path needs
// a cap because the one in `login_codes` is not one. It counts guesses against a
// single code, and issuing a new code deletes the old row — so five guesses per
// code, times as many codes as you can ask for, is not a limit. Capping the
// *issuing* is what turns it back into one. The callers since are the same
// argument at other doors: submitting a code (an unauthenticated HMAC and a
// write per guess), opening a grant (`flue enable`), and opening a relay
// session (a bearer credential per call).
//
// A fixed window, not a sliding one: the burst at a window boundary (up to 2x
// the limit across two adjacent windows) is not worth a second table and a
// scan. What matters is that the long-run rate is bounded.
import { getRequestHeaders, getRequestIP } from '@tanstack/react-start/server'
import { lt, sql } from 'drizzle-orm'
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

/**
 * Login-code *submissions* allowed per client IP per window.
 *
 * Guessing is already bounded elsewhere — five attempts per code, claimed in
 * SQL (server/codes.ts) — so this is not about the odds. It is about the cost:
 * a submission is an unauthenticated HMAC and a D1 write, and a wrong guess
 * costs the same as a right one. 30 is comfortably above what the same caller
 * can legitimately need (its own issuing cap is 20 codes per window, and a
 * person who mistypes every one of them still has slack) and far below what
 * makes hammering this endpoint worth anyone's time.
 */
export const CODE_SUBMITS_PER_IP = 30

/**
 * Relay sessions one account may open per window.
 *
 * Every call mints a bearer credential the relay accepts offline
 * (server/channel-token.ts), so this is the one cap here whose subject is
 * authenticated. Authenticated is not unlimited: a stolen session cookie is
 * otherwise a token faucet for the eight hours it lives, and a token is exactly
 * what an attacker needs to reach a shell. 30 in fifteen minutes is more
 * machines than anyone opens by hand.
 */
export const SESSIONS_OPENED_PER_USER = 30

/**
 * The longest window any counter in this file measures over. The sweep below
 * deletes rows older than this, so it has to be the maximum of every window —
 * a new, longer bucket must raise it or its counters would be swept mid-window
 * and silently reset.
 *
 * `withinLimit` enforces that rather than trusting it: this used to be a
 * sentence in a comment, and a comment cannot fail a build.
 */
export const LONGEST_WINDOW_S = CODE_SEND_WINDOW_S

/**
 * Roughly one call to `maybeSweepRateLimits` in this many actually sweeps.
 *
 * The scheduled handler (src/server.ts, on the cron in wrangler.jsonc) is what
 * collects these tables now. This coin flip is kept behind it as the fallback
 * for a deployment that has no cron running — `vite dev`, a `wrangler dev`
 * session, a self-hosted control plane whose operator never set the trigger —
 * where the alternative is a table that only ever grows. It rides on the
 * traffic it is cleaning up after: the more the table is written, the more
 * often it is swept, and a table nobody is writing to needs no sweeping. 100 is
 * chosen so the extra DELETE is lost in the noise of a login while still firing
 * many times an hour under any load worth worrying about.
 */
export const SWEEP_ONE_IN = 100

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
 *
 * Throws for a `windowS` longer than `LONGEST_WINDOW_S` — see the guard.
 */
export async function withinLimit(
  bucket: string,
  subject: string,
  limit: number,
  windowS: number,
): Promise<boolean> {
  // Before anything is written, because a bucket this file cannot enforce must
  // not leave a row behind claiming that it did. The sweep deletes counters
  // older than LONGEST_WINDOW_S, so a longer window would have its counters
  // collected mid-window and silently restart at zero — a cap that reads like a
  // cap and is not one, which is the worst of the three options (the others
  // being no cap, and one that holds).
  //
  // Throwing rather than clamping: every caller passes a module constant, so
  // this is a programming error, it is the same on every request, and it is
  // caught by the first test that runs the path. Clamping would silently
  // enforce a window nobody asked for.
  if (windowS > LONGEST_WINDOW_S) {
    throw new Error(
      `withinLimit: a ${windowS}s window exceeds LONGEST_WINDOW_S (${LONGEST_WINDOW_S}s), ` +
        'so its counters would be swept mid-window — raise LONGEST_WINDOW_S with it',
    )
  }

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

/**
 * Delete every counter whose window ended before `now - LONGEST_WINDOW_S`.
 *
 * The table is keyed by subject, and a subject is any address anyone ever
 * typed into the login form — so without this it grows by one permanent row per
 * distinct string an unauthenticated caller can invent, forever, and the only
 * thing bounding it is how long a D1 database is allowed to be. Nothing reads a
 * stale row incorrectly (`withinLimit` rolls an expired window over), so a
 * deleted row and an expired one are the same row as far as the cap is
 * concerned: this is storage, and it can run at any time from anywhere.
 *
 * Ranged over `window_start`, which is indexed (migration 0003) — the sweep
 * visits the rows it deletes rather than the whole table, which matters most
 * on the day the table is largest.
 */
export async function sweepRateLimits(now: number = nowSeconds()): Promise<void> {
  await db()
    .delete(rateLimits)
    .where(lt(rateLimits.windowStart, now - LONGEST_WINDOW_S))
}

/**
 * Sweep on roughly one call in `SWEEP_ONE_IN`.
 *
 * Deliberately random rather than "every Nth request": there is no shared
 * counter to keep across isolates, and a coin flip needs none. Callers `await`
 * it — a floating promise on Workers is a promise the runtime is entitled to
 * cancel when the response is sent, which would make the sweep a coin flip on
 * top of a coin flip.
 */
export async function maybeSweepRateLimits(): Promise<void> {
  if (Math.random() * SWEEP_ONE_IN >= 1) return
  await sweepRateLimits()
}
