// Email login codes: the whole of flue.sh's authentication. There are no
// passwords, so this file is the front door.
//
// The parameters are the ones the plan settled on, defensible against NIST
// 800-63B-4 and OWASP: 8 decimal digits, 10-minute TTL, single use, at most 5
// guesses, a new code invalidates the previous one, and only an HMAC is stored.
// They are load-bearing *together* — 10^8 is only a safe keyspace because the
// attempt cap makes a guessing run 5 shots long, and the cap is only meaningful
// because the counter lives in SQL where two concurrent guesses cannot both
// write "1".
//
// Neither function tells its caller anything about whether the address belongs
// to an account: `issueLoginCode` never looks. Deciding who is allowed to
// receive a code (invite gate) and keeping the HTTP responses identical either
// way is the login route's job.
import { env } from 'cloudflare:workers'
import { and, desc, eq, gte, sql } from 'drizzle-orm'
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
 */
export async function verifyLoginCode(
  email: string,
  code: string,
): Promise<{ ok: true; email: string } | { ok: false }> {
  const address = normalizeEmail(email)
  // Hashed before the lookup, unconditionally: the HMAC is the expensive part
  // of this function, so doing it first keeps a submission for an address with
  // no outstanding code from returning visibly sooner than a real guess.
  const submitted = await hmacHex(codeSecret(), code)

  const d = db()
  // Issuing deletes the previous row, so there is normally exactly one; newest
  // wins if a stale one ever survives.
  const [row] = await d
    .select()
    .from(loginCodes)
    .where(eq(loginCodes.email, address))
    .orderBy(desc(loginCodes.createdAt))
    .limit(1)
  if (!row) return { ok: false }

  if (row.expiresAt <= nowSeconds() || row.attempts >= MAX_ATTEMPTS) {
    // Dead either way — sweep it rather than leave a row that has to be
    // re-judged on every future submission.
    await d.delete(loginCodes).where(eq(loginCodes.id, row.id))
    return { ok: false }
  }

  if (!timingSafeEqual(submitted, row.codeHash)) {
    await d.batch([
      // Incremented in SQL, not read-modify-write: two guesses racing through
      // JavaScript would both write 1, and the cap that makes an 8-digit code
      // safe would be worth nothing under exactly the concurrency an attacker
      // brings.
      d
        .update(loginCodes)
        .set({ attempts: sql`${loginCodes.attempts} + 1` })
        .where(eq(loginCodes.id, row.id)),
      // Same batch, so the delete sees the incremented counter: the guess that
      // reaches the cap is the one that burns the code.
      d
        .delete(loginCodes)
        .where(and(eq(loginCodes.id, row.id), gte(loginCodes.attempts, MAX_ATTEMPTS))),
    ])
    return { ok: false }
  }

  // The delete is what grants the login, not the comparison above: two tabs
  // submitting the same correct code both reach this line, and only the one
  // whose DELETE actually removed a row is told yes. Anything softer makes
  // "single use" a race.
  const burned = await d
    .delete(loginCodes)
    .where(eq(loginCodes.id, row.id))
    .returning({ id: loginCodes.id })
  if (burned.length !== 1) return { ok: false }

  return { ok: true, email: address }
}
