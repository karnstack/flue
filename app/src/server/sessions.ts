// What "being logged in" means: one opaque cookie, one row in D1, and an
// expiry that both agree on.
//
// The shape is deliberately boring — no JWTs, no signed blobs, nothing the
// browser holds that the server cannot revoke. The cookie carries 32 random
// bytes and nothing else; the database holds SHA-256 of those bytes and the
// user they belong to. That gives two properties worth the trouble:
//
//   - a database dump is not a set of live cookies (the token is one-way
//     hashed, and 32 CSPRNG bytes have no dictionary to invert), and
//   - sign-out, "disable this account" and expiry are all *server* facts.
//     `currentUser` re-reads them on every call, so revoking access does not
//     wait for a cookie to expire.
//
// Rotation on login is the caller's job, and it is one line: `destroySession()`
// then `createSession(userId)`. Anything that adopts a session id the visitor
// arrived with is a session-fixation bug.
import { deleteCookie, getCookie, setCookie } from '@tanstack/react-start/server'
import { and, eq, gt } from 'drizzle-orm'
import { db } from '../db/client'
import { sessions, users } from '../db/schema'
import { randomToken, sha256Hex } from '../lib/tokens'

/**
 * The cookie name, prefix included.
 *
 * `__Host-` is not decoration: it is a rule the *browser* enforces. A cookie
 * with this prefix is only accepted when it is `Secure`, has `Path=/` and
 * carries no `Domain` — which means nothing served over http, and nothing on
 * any other flue.sh host, can set or overwrite it. Without the prefix, anything
 * that gets a foothold on a sibling subdomain can plant a session cookie on the
 * control plane and pick the visitor's session for them.
 */
export const SESSION_COOKIE = '__Host-session'

/**
 * How long a session lives, absolutely: eight hours from login, not from last
 * use. Idle timeouts and refresh are deliberately absent — a fixed ceiling is
 * the thing an attacker with a stolen cookie cannot extend.
 */
export const SESSION_TTL_S = 8 * 60 * 60

/**
 * The cookie attributes, written once so that setting and clearing cannot
 * drift apart. The clearing cookie needs the same `Secure`/`Path=/` as the one
 * it replaces: a `__Host-` cookie that arrives without them is rejected whole,
 * which would leave the browser still holding the session cookie after
 * sign-out.
 *
 * `sameSite: 'lax'` (serialized as `SameSite=Lax`) rather than `strict`: the
 * session has to survive the top-level navigation back from an email client,
 * which is exactly how a login-code flow ends. Lax withholds the cookie from
 * cross-site POSTs, and the CSRF middleware in start.ts covers the rest.
 *
 * `secure` is not conditional on the environment, and does not need to be:
 * browsers count http://localhost as a trustworthy origin, so `vite dev` keeps
 * working. Making it conditional is how a deployment ends up shipping a
 * cookie that a downgrade attack can read.
 */
const COOKIE_OPTIONS = {
  httpOnly: true, // never readable from document.cookie, so XSS cannot lift it
  secure: true,
  sameSite: 'lax',
  path: '/',
} as const

const nowSeconds = () => Math.floor(Date.now() / 1000)

/**
 * Log `userId` in: mint a token, record its digest, and hand the token to the
 * browser as the session cookie.
 *
 * Depends on nothing about the current request — there may be a session cookie
 * on it, there may not — so a login handler can call `destroySession()` first
 * and know that what it gets back is a brand new session id.
 *
 * The caller is responsible for having verified who this is. This function
 * asks no questions.
 */
export async function createSession(userId: string): Promise<void> {
  // 256 bits: unguessable, and not worth keying a hash over. The same shape a
  // device enrollment token has, from the same helper — see lib/tokens.
  const token = randomToken()
  const createdAt = nowSeconds()

  // The token itself never reaches the database, and is never logged: the row
  // holds its digest, which is enough to recognize the cookie and useless to
  // anyone who only has the row.
  await db()
    .insert(sessions)
    .values({
      id: await sha256Hex(token),
      userId,
      createdAt,
      expiresAt: createdAt + SESSION_TTL_S,
    })

  setCookie(SESSION_COOKIE, token, { ...COOKIE_OPTIONS, maxAge: SESSION_TTL_S })
}

/**
 * Who is making this request, or null.
 *
 * Null covers every failure identically — no cookie, a forged one, an expired
 * session, a user that has been deleted, a user that has been disabled. The
 * caller gets no way to tell those apart, and needs none.
 *
 * Three of those are checked here rather than at login because they can all
 * become true *during* a session: the expiry passes, an admin flips
 * `users.disabled`, an account is deleted. Reading them on every authenticated
 * call is what makes the kill switch immediate.
 */
export async function currentUser(): Promise<{ id: string; email: string } | null> {
  const token = getCookie(SESSION_COOKIE)
  if (!token) return null

  // One statement, three questions: is this session real, is it still alive,
  // and is the user it names still allowed in. The join is what answers the
  // last one — there are no foreign keys (see schema.ts), so a session whose
  // user has been deleted is a real possibility and has to miss here.
  //
  // A primary-key lookup, not a constant-time compare (unlike login codes):
  // what SQLite compares is a digest of 256 unguessable bits, so there is no
  // keyspace to walk one byte at a time even if the index leaked timing.
  const rows = await db()
    .select({ id: users.id, email: users.email, disabled: users.disabled })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.id, await sha256Hex(token)), gt(sessions.expiresAt, nowSeconds())))
    .limit(1)

  const row = rows[0]
  if (!row || row.disabled) return null
  return { id: row.id, email: row.email }
}

/**
 * Sign out: delete this session's row and clear the cookie.
 *
 * The delete is the part that matters — a cookie copied out of a browser is
 * worthless the moment its row is gone, whatever the client does with the
 * clearing header. Clearing the cookie unconditionally (even when the request
 * carried none) costs one header and sweeps up a stale cookie whose session is
 * already gone.
 */
export async function destroySession(): Promise<void> {
  const token = getCookie(SESSION_COOKIE)
  if (token) {
    await db()
      .delete(sessions)
      .where(eq(sessions.id, await sha256Hex(token)))
  }
  deleteCookie(SESSION_COOKIE, COOKIE_OPTIONS)
}
