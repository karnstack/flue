// What the cron runs: every table that collects rows nobody will read again.
//
// Four tables, four one-line deletes, and one reason they are gathered here
// rather than left where they were. Each sweep used to ride on a 1-in-100 coin
// flip on the traffic that filled its table (`maybeSweepRateLimits`,
// `maybeSweepDeviceAuth`), which has two failure modes worth naming: a service
// nobody is using never collects, and a service somebody is *flooding* collects
// on their schedule rather than ours. A scheduled trigger has neither — it runs
// on the clock, at a rate the operator chose, whatever the traffic is doing.
//
// The coin flips are deliberately still there, behind this. They cost one
// ranged DELETE per hundred logins and they are the whole collection story for
// a deployment with no cron running: `vite dev`, a `wrangler dev` session, or a
// self-hosted control plane whose operator never set the trigger. Belt and
// braces, where the braces are free.
//
// Every function called from here is safe to run at any time, from anywhere,
// concurrently with itself: each one deletes rows that are already expired by
// the same clock every reader checks, so a sweep racing a request cannot remove
// anything the request was entitled to see. That is what makes an unsynchronized
// cron (which may fire on more than one instance, and may overlap a previous
// run) the right shape for this.
import { sweepExpiredLoginCodes } from './codes'
import { sweepDeviceAuth } from './enroll'
import { sweepRateLimits } from './ratelimit'
import { sweepExpiredSessions } from './sessions'

/**
 * Collect every expired row in the database.
 *
 * Sequential rather than `Promise.all`: D1 is one SQLite database behind one
 * binding, so four concurrent deletes buy nothing but a wider window in which
 * one of them is holding a write lock. This runs on a cron with nobody waiting
 * for it.
 *
 * Nothing here throws for "there was nothing to delete", and nothing here is
 * caught: a failing sweep should show up as a failed scheduled invocation in
 * the Worker's logs, not as a silent no-op that leaves the tables growing.
 */
export async function runScheduledSweeps(now: number = Math.floor(Date.now() / 1000)): Promise<void> {
  await sweepRateLimits(now)
  await sweepDeviceAuth(now)
  await sweepExpiredSessions(now)
  await sweepExpiredLoginCodes(now)
}
