// The login flow: the only place an account is created, and the only place a
// session is minted.
//
// Two rules shape every line here.
//
// **Say nothing.** `requestCode` answers `{ok:true}` to everyone — no account,
// a disabled account, a spent invite, a rate limit, a mail provider having a
// bad afternoon. All of it looks identical from outside. The reason is not
// politeness: an endpoint that answers differently for an address that has an
// account is a membership oracle for the whole user list, and this one is
// unauthenticated and public. Anything a caller can measure — the value, its
// shape, the status code, roughly the time — has to be the same on both
// branches. (`submitCode` is the same rule with a smaller alphabet: `{ok:true}`
// or `{ok:false}`, never a reason.)
//
// **A user costs an invite.** There is exactly one INSERT into `users` in this
// application and it is inside `createUserWithInvite`'s batch, next to the
// UPDATE that burns the invite. Nothing here can create an account any other
// way, and a wrong code never gets far enough to try.
//
// What is deliberately *not* claimed: constant time. The allowed branch writes
// two rows and calls the Sender; the refused branch hashes and stops. The dummy
// HMAC closes the crypto gap, and the rate-limit counters (which are written on
// every call from an IP that is under its cap, allowed or not) put a database
// round trip on both sides, but a determined attacker with a quiet network
// could still distinguish them statistically. Closing that properly means
// sending on a queue so the response leaves before the work does — a change for
// the day this has a real Sender.
import { eq, sql } from 'drizzle-orm'
import { db } from '../db/client'
import { invites, users } from '../db/schema'
import { dummyIssueWork, issueLoginCode, normalizeEmail, verifyLoginCode } from './codes'
import { createUserWithInvite, inviteFor } from './invites'
import {
  CODE_SENDS_PER_EMAIL,
  CODE_SENDS_PER_IP,
  CODE_SEND_WINDOW_S,
  CODE_SUBMITS_PER_IP,
  clientIp,
  maybeSweepRateLimits,
  withinLimit,
} from './ratelimit'
import { createSession, destroySession } from './sessions'

export interface RequestCodeInput {
  email: string
  /** An invite code the visitor is holding. Optional: a bound invite needs none. */
  invite?: string
}

export interface SubmitCodeInput {
  email: string
  code: string
  invite?: string
}

/**
 * Send a login code to `email`, if `email` is allowed to have one.
 *
 * Always `{ok:true}`. The caller cannot tell whether anything was sent, and
 * that is the entire contract — see the note at the top of this file.
 */
export async function requestCode(input: RequestCodeInput): Promise<{ ok: true }> {
  const address = normalizeEmail(input.email)
  const invite = input.invite?.trim() ?? ''

  // The caller's own cap comes first, and alone. Everything below it writes a
  // row keyed by whatever string arrived in `email`, so an unauthenticated
  // caller sending a fresh random address each time would otherwise mint one
  // permanent `rate_limits` row per request, at whatever rate it liked — a cap
  // that only suppressed the *send* would leave the table itself as the
  // unbounded resource. Over its cap, this request writes nothing and reads
  // nothing: it is not counted against the address, and it does not ask the
  // database about it.
  //
  // This costs nothing in enumeration terms, which is the only reason it is
  // allowed to be an early return. The branch is decided by `clientIp()` —
  // CF-Connecting-IP, which the edge writes and the caller cannot choose — and
  // by nothing else. Two addresses from the same caller, one gated and one not,
  // take exactly the same path here.
  const withinIpCap = await withinLimit(
    'login-code:ip',
    clientIp(),
    CODE_SENDS_PER_IP,
    CODE_SEND_WINDOW_S,
  )
  if (!withinIpCap) {
    await maybeSweepRateLimits()
    return { ok: true }
  }

  // Under the IP cap, the per-email counter is written before any decision and
  // whatever the decision turns out to be — an address that is over its cap is
  // counted exactly like one that is not, and a stranger is counted exactly
  // like a member. A limiter that only counted real sends would say out loud
  // which addresses were real.
  const withinEmailCap = await withinLimit(
    'login-code:email',
    address,
    CODE_SENDS_PER_EMAIL,
    CODE_SEND_WINDOW_S,
  )
  const mayReceive = await addressMayReceiveCode(address, invite)

  if (withinEmailCap && mayReceive) {
    try {
      await issueLoginCode(address)
    } catch (err) {
      // The send happens after the code row is committed, so a throw from here
      // would escape as a 500 for exactly the addresses that have accounts —
      // the oracle, handed over by an error page — and would lock out a real
      // user whose provider hiccuped. Swallow it, answer the same as always,
      // and do not retry: the code is issued as far as the database is
      // concerned, and re-issuing would mint a second one and reset its
      // attempt counter.
      //
      // Logged without the address, the code, or the error's message: this
      // line is for noticing that delivery is broken, not for reading mail.
      console.error(
        JSON.stringify({
          evt: 'login_code_send_failed',
          kind: err instanceof Error ? err.name : typeof err,
        }),
      )
    }
  } else {
    await dummyIssueWork()
  }

  // Both branches, and the capped one above: the rows this endpoint writes are
  // the ones that need collecting, so the collection rides on the same traffic.
  // The coin flip is independent of the address, so it is noise on the timing,
  // not signal.
  await maybeSweepRateLimits()
  return { ok: true }
}

/**
 * Whether this address is allowed a login code: it has an enabled account, or
 * — having no account at all — it holds an invite.
 *
 * One statement for all four questions, so the work is the same whichever one
 * answers yes, and an address with no account costs exactly what an address
 * with one costs.
 *
 * A disabled account does not fall through to the invite branch: it is refused
 * outright, even if some unredeemed invite still names the address. Its owner
 * could not complete a login anyway (`submitCode` refuses, and `currentUser`
 * would refuse the session), so a code would be a login email nobody can use —
 * and a kill switch that leaves the front door answering is half a switch.
 */
async function addressMayReceiveCode(address: string, invite: string): Promise<boolean> {
  const rows = await db().all<{
    has_account: number
    is_enabled: number
    has_bound_invite: number
    has_presented_invite: number
  }>(sql`
    select
      exists(select 1 from ${users} where ${users.email} = ${address}) as has_account,
      exists(
        select 1 from ${users}
        where ${users.email} = ${address} and ${users.disabled} = 0
      ) as is_enabled,
      exists(
        select 1 from ${invites}
        where ${invites.email} = ${address} and ${invites.redeemedBy} is null
      ) as has_bound_invite,
      exists(
        select 1 from ${invites}
        where ${invite} <> '' and ${invites.code} = ${invite}
          and ${invites.redeemedBy} is null
          and (${invites.email} is null or ${invites.email} = ${address})
      ) as has_presented_invite
  `)

  const row = rows[0]
  if (!row) return false
  if (row.has_account === 1) return row.is_enabled === 1
  return row.has_bound_invite === 1 || row.has_presented_invite === 1
}

/**
 * Redeem a login code: sign the visitor in, creating their account if the
 * invite gate lets them.
 *
 * `{ok:false}` covers every refusal without distinguishing them — wrong code,
 * expired code, no code, no invite, someone else's invite, a disabled account,
 * and a caller over its own cap.
 */
export async function submitCode(input: SubmitCodeInput): Promise<{ ok: boolean }> {
  const address = normalizeEmail(input.email)

  // The caller's cap first, and alone, exactly as in `requestCode` — and for
  // the second of the two reasons that one has. It is not about the odds of a
  // guess: those are bounded by the five attempts claimed per code below. It is
  // that a submission is an unauthenticated HMAC plus a D1 write, a wrong guess
  // costs the same as a right one, and nothing else here is keyed by anything
  // an attacker cannot invent.
  //
  // Over the cap, this returns before the verifier runs — so the submission
  // spends none of the code's five attempts. That matters: a cap that consumed
  // attempts would let a flood from one address burn a real user's code out
  // from under them. The refusal is `{ok:false}`, the same value and the same
  // shape every other refusal here answers with, and the branch is decided by
  // `clientIp()` alone, so it says nothing about the address.
  const withinIpCap = await withinLimit(
    'login-submit:ip',
    clientIp(),
    CODE_SUBMITS_PER_IP,
    CODE_SEND_WINDOW_S,
  )
  // On both branches and before either, like the one in `requestCode`: this
  // endpoint writes a counter row per calling address, so the collection rides
  // on the same traffic (behind the cron, which is what actually collects — see
  // ratelimit.ts). The coin flip is independent of the address and of the code,
  // so it is noise on the timing rather than signal.
  await maybeSweepRateLimits()
  if (!withinIpCap) return { ok: false }

  // Then, and unconditionally: a wrong code never reaches the account logic,
  // so no submission can create a user, spend an invite or touch a session
  // without a code that was actually sent to that address. This also spends
  // one of the code's five attempts, which is what makes guessing bounded.
  const verified = await verifyLoginCode(address, input.code)
  if (!verified.ok) return { ok: false }

  const userId = await findOrCreateUser(address, input.invite?.trim() ?? '')
  if (!userId) return { ok: false }

  // Rotate, never adopt: whatever session id the visitor arrived holding is
  // destroyed before a new one is minted. Reusing it would mean an attacker
  // who can plant a cookie before login owns the session after it.
  await destroySession()
  await createSession(userId)
  return { ok: true }
}

/**
 * The account for `address`, creating it if an invite can be spent.
 *
 * An existing account needs no invite and never spends one — a returning user
 * who still has their signup code in a browser field must not burn it. A new
 * address needs one, and gets two chances to name it: the code they typed in,
 * then the invite bound to their address (which is why they were sent a code at
 * all, and which they were never asked to know).
 *
 * Null means no account, and nothing written.
 */
async function findOrCreateUser(address: string, invite: string): Promise<string | null> {
  const [existing] = await db()
    .select({ id: users.id, disabled: users.disabled })
    .from(users)
    .where(eq(users.email, address))
    .limit(1)

  if (existing) return existing.disabled ? null : existing.id

  const bound = await inviteFor(address)
  const candidates = [invite, bound].filter((code): code is string => !!code)
  for (const code of candidates) {
    const userId = await createUserWithInvite(address, code)
    if (userId) return userId
  }
  return null
}
