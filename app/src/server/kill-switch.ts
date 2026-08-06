// The kill switch: turning an account or a machine off, and what "off" means.
//
// flue.sh relays a shell. That is dual-use in the plainest sense — the same
// bytes that let somebody fix their build from a phone let somebody else run a
// stranger's laptop — so the service needs a switch that works *now*, not at
// the next cookie expiry, and an operator who can reach it at three in the
// morning with nothing but a terminal.
//
// **What the flag already does**, without anything in this file. `disabled` is
// read on every authenticated path, in the same SQL predicate as the thing it
// guards:
//
//   - `currentUser` (server/sessions.ts) joins `users` and refuses a disabled
//     one, so every signed-in page and every protected server function stops on
//     the next request;
//   - `mintClientToken` and `mintDaemonToken` (server/channel-token.ts) state
//     `users.disabled = 0 and devices.disabled = 0` in the same `where` as
//     ownership, so no new relay credential is issued for either;
//   - `requestCode` (server/login.ts) refuses a disabled address a login code
//     at all, invite or no invite.
//
// **What it cannot do is cut a channel that is already open.** The relay
// verifies a channel token *at the upgrade* and then bridges the two sockets;
// nothing re-reads the claims, or this table, for the life of that connection.
// So switching an account off stops the next dial (immediately) and the next
// refresh (within one token TTL — 60 seconds for a browser, 300 for a daemon),
// while a terminal somebody already has open stays open until it is closed or
// the daemon reconnects. The certain way to end one *now* is to stop the daemon
// on the machine. Closing that gap means revocation the relay can hear about —
// a hub-side check, or a channel that expires with its token — and it is
// recorded as a follow-up rather than half-built here.
//
// **What this file adds** is the half a flag cannot do: deleting the sessions.
// Without that, disabling gates the *read* while the rows stay, so re-enabling
// an account hands back every cookie that was live when it was switched off —
// for up to eight hours. An operator disabling an account because a laptop was
// stolen means both things, so `disableUser` does both, in one batch.
//
// **There is no admin UI, and this is not wired to a route.** Deliberately: an
// endpoint that can disable any account is an endpoint worth attacking, and the
// service is small enough that the operator has `wrangler`. These functions are
// the tested definition of what the switch does; the recipe below is how it is
// actually thrown. `docs/SAAS.md` points at both.
//
// ---
//
// **Recipe — disable an account** (D1 has no interactive transactions from the
// CLI either; run the statements in this order, flag first, so no new token can
// be minted while the sessions are being deleted):
//
// ```sh
// wrangler d1 execute flue --remote --command \
//   "update users set disabled = 1 where email = 'someone@example.com'"
// wrangler d1 execute flue --remote --command \
//   "delete from sessions where user_id in \
//      (select id from users where email = 'someone@example.com')"
// ```
//
// **Re-enable one** (the sessions stay deleted — that is the point):
//
// ```sh
// wrangler d1 execute flue --remote --command \
//   "update users set disabled = 0 where email = 'someone@example.com'"
// ```
//
// **Disable a single machine**, leaving its owner signed in:
//
// ```sh
// wrangler d1 execute flue --remote --command \
//   "update devices set disabled = 1 where id = '<device id>'"
// ```
//
// **A disabled machine stays disabled across re-enrolment**, which is the point
// of leaving its owner signed in: `devices.id` is sha256(publicKey)[:12], so a
// daemon that runs `flue enable` again lands on the same row, and the mint
// upsert in server/enroll.ts deliberately carries the existing `disabled` value
// over rather than resetting it. The re-enrolment succeeds — new token, new
// label, no last-seen — and both mints still refuse it. Turning it back on is an
// operator action and nothing else:
//
// ```sh
// wrangler d1 execute flue --remote --command \
//   "update devices set disabled = 0 where id = '<device id>'"
// ```
//
// The address is normalized (lowercased, trimmed) everywhere this application
// writes it, so type it that way; `select id, email, disabled from users where
// email like '%example.com'` first if you are not sure. To take a machine off
// an account for good rather than switch it off, delete the row — that is what
// the dashboard's "revoke" does (server/devices.ts).
import { eq } from 'drizzle-orm'
import { db } from '../db/client'
import { devices, sessions, users } from '../db/schema'

/**
 * Switch an account off, and drop every session it is holding.
 *
 * One batch, because the two statements are a single fact ("this account is
 * off"): D1 has no interactive transactions, and a crash between them would
 * leave either a disabled account with live cookies waiting for a re-enable, or
 * a signed-out user who is not actually disabled. Flag first, so that the
 * moment anything is true, no new token can be minted.
 *
 * Returns how many sessions were dropped, which is the only part an operator
 * cannot see from the flag afterwards. Unknown user id: nothing is written and
 * nothing is thrown — the switch is idempotent by construction, and an operator
 * pasting an id twice should not get an error the second time.
 */
export async function disableUser(userId: string): Promise<{ sessionsDropped: number }> {
  const d = db()
  const [, dropped] = await d.batch([
    d.update(users).set({ disabled: true }).where(eq(users.id, userId)),
    d.delete(sessions).where(eq(sessions.userId, userId)).returning({ id: sessions.id }),
  ])

  const sessionsDropped = dropped.length
  // The account id and a count. Not the email (this line would become a list of
  // who has been switched off, in a log store), and certainly not a session id:
  // those are digests of live cookies.
  console.log(JSON.stringify({ evt: 'user_disabled', userId, sessionsDropped }))
  return { sessionsDropped }
}

/**
 * Switch an account back on.
 *
 * Sessions are *not* restored — they were deleted, and a deleted session is
 * gone in the only sense that matters: the person signs in again, from a cookie
 * nobody else has a copy of. Anything else would make "disable" a pause button.
 */
export async function enableUser(userId: string): Promise<void> {
  await db().update(users).set({ disabled: false }).where(eq(users.id, userId))
  console.log(JSON.stringify({ evt: 'user_enabled', userId }))
}

/**
 * Switch one machine off, leaving its owner and their other machines alone.
 *
 * No sessions are touched: the browser session is the *person's*, and it is not
 * what reaches this machine — the channel token is, and both mints re-read this
 * flag. The daemon on the other end keeps its enrollment token and stops being
 * able to trade it for a channel token, so it drops on its next refresh.
 *
 * **Sticky.** Re-enrolling the same machine does not undo this: the upsert in
 * server/enroll.ts carries the flag over (a device id is derived from the public
 * key, so `flue enable` returns to this row), and `enroll.test.ts` pins it. That
 * is what makes leaving the owner signed in safe — otherwise the revocation
 * would last exactly as long as it took them to reinstall.
 */
export async function disableDevice(deviceId: string): Promise<void> {
  await db().update(devices).set({ disabled: true }).where(eq(devices.id, deviceId))
  console.log(JSON.stringify({ evt: 'device_disabled', deviceId }))
}

/**
 * Switch a machine back on. Its enrollment token never stopped being valid.
 *
 * This is the *only* thing that clears a device revocation — re-enrolling does
 * not (see `disableDevice`), so a machine that was switched off comes back
 * because an operator decided it should.
 */
export async function enableDevice(deviceId: string): Promise<void> {
  await db().update(devices).set({ disabled: false }).where(eq(devices.id, deviceId))
  console.log(JSON.stringify({ evt: 'device_enabled', deviceId }))
}
