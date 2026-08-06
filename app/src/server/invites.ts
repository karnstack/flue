// The invite gate: flue.sh is invite-only while it is small, and this file is
// the whole of that policy.
//
// An invite is a bearer code with an optional address bound to it. Bound, it
// is a letter addressed to one person and nobody else can open it; unbound, it
// is a ticket — whoever holds the string gets in. Either way it converts to
// exactly one account, and "exactly one" is a claim about SQL, not about
// JavaScript: every decision below is made inside a single statement whose
// WHERE clause carries the precondition, so two requests racing for the same
// invite cannot both find it unredeemed.
//
// The other half is `createUserWithInvite`. D1 has no interactive transactions,
// so `batch` is the only way to make "burn the invite" and "create the user"
// land together — and they must, in both directions: an invite burned without
// an account is a person locked out, an account created without burning one is
// the gate gone.
import { and, eq, isNull, or, sql } from 'drizzle-orm'
import type { Db } from '../db/client'
import { db } from '../db/client'
import { invites, users } from '../db/schema'

const nowSeconds = () => Math.floor(Date.now() / 1000)

/**
 * The one statement that redeems an invite, as a statement — so it can be run
 * on its own (`consumeInvite`) or dropped into a batch alongside the insert it
 * has to be atomic with (`createUserWithInvite`). There is no second spelling
 * of this rule anywhere.
 *
 * Everything that makes redemption safe is in the WHERE clause:
 *   - `code = ?` — the invite exists;
 *   - `redeemed_by IS NULL` — and has not been spent. Checked here rather than
 *     read first and checked in JS, so two concurrent redemptions update the
 *     same row and only one of them matches;
 *   - `email IS NULL OR email = ?` — an invite bound to an address is only
 *     redeemable by that address, or the binding would be decoration.
 *
 * RETURNING is how the caller learns whether it won: an UPDATE that matches
 * nothing is not an error in SQL, so "did it match" has to come back as rows.
 */
function claimInvite(d: Db, code: string, userId: string, email: string) {
  return d
    .update(invites)
    .set({ redeemedBy: userId, redeemedAt: nowSeconds() })
    .where(
      and(
        eq(invites.code, code),
        isNull(invites.redeemedBy),
        or(isNull(invites.email), eq(invites.email, email)),
      ),
    )
    .returning({ code: invites.code })
}

/**
 * Mark an invite redeemed by `userId`, atomically. False — with nothing
 * written — if the code is unknown, already redeemed, or bound to a different
 * address.
 *
 * `email` is the address the account belongs to, and is not optional: the
 * binding cannot be enforced without it, and it cannot be looked up from
 * `userId` on the path that matters, where the user does not exist yet. Signup
 * uses `createUserWithInvite` (same statement, inside a batch); this is the
 * standalone form.
 */
export async function consumeInvite(code: string, userId: string, email: string): Promise<boolean> {
  return (await claimInvite(db(), code, userId, email)).length === 1
}

/**
 * The unredeemed invite issued *to* this address, if there is one.
 *
 * Bound invites only. An unbound invite belongs to whoever holds the code, so
 * answering with one here would make every address on earth "invited" the
 * moment a single open invite existed — the gate would be gone and nothing
 * would look wrong.
 */
export async function inviteFor(email: string): Promise<string | null> {
  const rows = await db()
    .select({ code: invites.code })
    .from(invites)
    .where(and(eq(invites.email, email), isNull(invites.redeemedBy)))
    .limit(1)
  return rows[0]?.code ?? null
}

/** Whether `inviteFor` would find one. The gate reads this; the redeemer reads the code. */
export async function hasUnredeemedInvite(email: string): Promise<boolean> {
  return (await inviteFor(email)) !== null
}

/**
 * Create the account for `email` by spending `inviteCode`. Returns the new
 * user's id, or null if the invite could not be spent — in which case nothing
 * at all was written.
 *
 * This is the only INSERT into `users` in the application. Both statements ride
 * in one `batch`, which D1 runs as a single implicit transaction, and the
 * second is written so that neither half can happen without the other:
 *
 *   UPDATE invites SET redeemed_by = <new id> WHERE <the claim above>
 *   INSERT INTO users (...) SELECT <new id>, ... FROM invites
 *     WHERE code = ? AND redeemed_by = <new id>
 *
 * The insert is a SELECT, not a VALUES, precisely so it can carry a condition:
 * a batch is atomic on *error*, and an UPDATE that matches no rows is not an
 * error, so an unconditional insert would happily create an account whose
 * invite was never claimed. Here the insert asks the database whether the
 * update it just ran actually took the invite — and the id it compares against
 * is the one minted for this call, so it cannot match somebody else's
 * redemption. No claim, no user.
 *
 * The other direction is the transaction's job: if the insert fails (a
 * concurrent signup took the address — `users.email` is unique) the batch rolls
 * back and the invite is unspent, ready for the retry.
 */
export async function createUserWithInvite(
  email: string,
  inviteCode: string,
): Promise<string | null> {
  const userId = crypto.randomUUID()
  const createdAt = nowSeconds()
  const d = db()

  try {
    const [, created] = await d.batch([
      claimInvite(d, inviteCode, userId, email),
      d
        .insert(users)
        // Column order follows the table's declaration order — id, email,
        // created_at, disabled — which is the order drizzle names them in.
        .select(
          sql`select ${userId}, ${email}, ${createdAt}, 0 from ${invites}
              where ${invites.code} = ${inviteCode} and ${invites.redeemedBy} = ${userId}`,
        )
        .returning({ id: users.id }),
    ])
    return created.length === 1 ? userId : null
  } catch {
    // A rolled-back batch is a failed signup and nothing else — no invite
    // spent, no user created. The caller gets the same "no" it gets for a
    // spent invite, because that is all it is allowed to know.
    return null
  }
}
