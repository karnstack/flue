// Email login codes: the whole of flue.sh's authentication. There are no
// passwords, so this file is the front door.
//
// The parameters are the ones the plan settled on, defensible against NIST
// 800-63B-4 and OWASP: 8 decimal digits, 10-minute TTL, single use, at most 5
// guesses, a new code invalidates the previous one, and only an HMAC is stored.
// They are load-bearing *together* — 10^8 is only a safe keyspace because the
// attempt cap makes a guessing run 5 shots long, and the cap is only meaningful
// because a guess is *claimed* in SQL before the code is looked at, so parallel
// submissions cannot all spend the same attempt (see `verifyLoginCode`).
//
// Neither function tells its caller anything about whether the address belongs
// to an account: `issueLoginCode` never looks. Deciding who is allowed to
// receive a code (invite gate) and keeping the HTTP responses identical either
// way is the login route's job.
import { env } from 'cloudflare:workers'
import { and, eq, gt, gte, inArray, lt, lte, or, sql } from 'drizzle-orm'
import { db } from '../db/client'
import { loginCodes } from '../db/schema'
import { hmacHex, randomCode8, timingSafeEqual } from '../lib/tokens'
import { sender } from './email/sender'

/** How long a code lives. Long enough for a slow inbox, short enough to matter. */
export const CODE_TTL_S = 600

/**
 * Wrong guesses allowed per code. With 5 of 10^8 the chance of guessing a live
 * code is 5e-8; raising this is how an 8-digit code stops being safe.
 */
export const MAX_ATTEMPTS = 5

/**
 * The one spelling of an address the database ever sees.
 *
 * SQLite compares TEXT byte for byte, so `A@b.com` and `a@b.com` would be two
 * rows, two accounts, and a code that cannot be redeemed by the person who
 * received it. Every read and every write goes through here.
 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

/**
 * The HMAC key, read per request (module scope would be `undefined` on
 * Workers).
 *
 * Missing means stop. Falling through to `hmacHex(undefined, ...)` would hash
 * every code under the literal string "undefined" — one well-known key shared
 * by every deployment that forgot `wrangler secret put`, which is the same as
 * storing the codes in the clear.
 */
function codeSecret(): string {
  const secret = env.CODE_HMAC_SECRET
  if (!secret) {
    throw new Error('CODE_HMAC_SECRET is not set: refusing to issue or verify login codes')
  }
  return secret
}

const nowSeconds = () => Math.floor(Date.now() / 1000)

/**
 * Mint a login code for `email` and hand the plaintext to the Sender.
 *
 * Returns nothing: there is no signal here for a caller (or a caller's caller)
 * to turn into an account-existence oracle. The work done is identical for
 * every address.
 */
export async function issueLoginCode(email: string): Promise<void> {
  const address = normalizeEmail(email)
  const code = randomCode8()
  const codeHash = await hmacHex(codeSecret(), code)
  const issuedAt = nowSeconds()

  const d = db()
  // One batch, because these two statements are a single fact: "the current
  // code for this address is this one". Split apart, a crash between them
  // leaves either two live codes (two chances at the attempt cap) or none.
  // D1 has no interactive transactions; batch is the only atomicity there is.
  await d.batch([
    d.delete(loginCodes).where(eq(loginCodes.email, address)),
    d.insert(loginCodes).values({
      id: crypto.randomUUID(),
      email: address,
      codeHash,
      expiresAt: issuedAt + CODE_TTL_S,
      createdAt: issuedAt,
    }),
  ])

  // The plaintext exists only in this function and in whatever the Sender does
  // with it. It is never returned, never stored, never logged from here.
  await sender().sendLoginCode(address, code)
}

/**
 * Check a submitted code. `{ ok: true, email }` exactly once per issued code;
 * `{ ok: false }` for every other reason, without saying which.
 *
 * "Without saying which" is about the return value, not the clock. A guess
 * against a live code costs a write; a submission for an address with nothing
 * outstanding costs a read and maybe a sweep, and those differ in wall time.
 * What that can leak is whether a code is *currently outstanding* for an
 * address — never whether the address has an account, which this module does
 * not look up. Keeping the responses themselves indistinguishable is the login
 * route's job.
 */
export async function verifyLoginCode(
  email: string,
  code: string,
): Promise<{ ok: true; email: string } | { ok: false }> {
  const address = normalizeEmail(email)
  const submitted = await hmacHex(codeSecret(), code)
  const now = nowSeconds()
  const d = db()

  // Spend the guess BEFORE looking at the code. One statement finds the live
  // row, increments its counter and hands back the hash, so SQLite serializes
  // the claim: N submissions consume N distinct attempts and only the first
  // MAX_ATTEMPTS of them ever see a hash to compare against.
  //
  // Reading the row first and incrementing afterwards — the obvious shape —
  // does not do this. Requests that arrive before the first increment commits
  // all read `attempts = 0`, all pass the cap check and all get a full compare,
  // which turns "5 guesses per code" into "as many as you can hold open at
  // once". That cap is the entire security argument for an 8-digit code.
  //
  // The TTL rides in the same predicate so an expired row cannot be claimed
  // either.
  const claimed = await d
    .update(loginCodes)
    .set({ attempts: sql`${loginCodes.attempts} + 1` })
    .where(
      and(
        eq(loginCodes.email, address),
        gt(loginCodes.expiresAt, now),
        lt(loginCodes.attempts, MAX_ATTEMPTS),
      ),
    )
    .returning({
      id: loginCodes.id,
      codeHash: loginCodes.codeHash,
      attempts: loginCodes.attempts,
    })

  if (claimed.length === 0) {
    // Nothing live to guess against: no code, an expired one, or one whose
    // guesses are spent. Sweep the dead row rather than re-judge it on every
    // future submission — and say nothing about which case it was.
    await d
      .delete(loginCodes)
      .where(
        and(
          eq(loginCodes.email, address),
          or(lte(loginCodes.expiresAt, now), gte(loginCodes.attempts, MAX_ATTEMPTS)),
        ),
      )
    return { ok: false }
  }

  // Normally exactly one row — issuing deletes the previous one. A stale
  // duplicate would have had a guess spent on it too, which is the safe
  // direction to be wrong in.
  const match = claimed.find((row) => timingSafeEqual(submitted, row.codeHash))

  if (!match) {
    // The guess that took the counter to the cap is the one that burns the
    // code; `attempts` here is the post-increment value the UPDATE returned.
    const spent = claimed.filter((row) => row.attempts >= MAX_ATTEMPTS).map((row) => row.id)
    if (spent.length > 0) await d.delete(loginCodes).where(inArray(loginCodes.id, spent))
    return { ok: false }
  }

  // The burn is what grants the login, not the comparison above: two tabs
  // submitting the same correct code both reach this line, and only the one
  // whose DELETE actually removed a row is told yes. Anything softer makes
  // "single use" a race.
  const burned = await d
    .delete(loginCodes)
    .where(eq(loginCodes.id, match.id))
    .returning({ id: loginCodes.id })
  if (burned.length !== 1) return { ok: false }

  return { ok: true, email: address }
}
