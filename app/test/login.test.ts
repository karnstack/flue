// The login flow: the only way an account comes into existence, and the only
// way a session is minted. Two rules dominate everything below.
//
//   1. `requestCode` answers `{ok:true}` to everybody. Whether an address has
//      an account, whether it holds an invite, whether it has hit a rate limit
//      — none of that may reach the caller, in the response *or* in whether a
//      row appeared. The tests therefore assert on both halves: the value, and
//      what the Sender was handed.
//   2. A user is created only by a batch that also burns an invite. There is
//      no other INSERT into `users` in the app.
//
// Everything runs against a real (local) D1 through the same `db()` production
// uses, inside a real Start request (see test/request.ts) — cookies and the
// client IP are read off the request, so a fake context would test nothing.
//
// The plaintext code is never returned by anything: the only way to learn it
// is the Sender seam, which in this plan is `LogSender`. Capturing its log line
// is how these tests read the code, and doubles as the assertion that a send
// did or did not happen.
import { eq, sql } from 'drizzle-orm'
import { describe, expect, it, vi } from 'vitest'
import { db } from '../src/db/client'
import { invites, loginCodes, rateLimits, sessions, users } from '../src/db/schema'
import { sha256Hex } from '../src/lib/tokens'
import { LogSender } from '../src/server/email/sender'
import { requestCode, submitCode } from '../src/server/login'
import { SESSION_COOKIE, currentUser } from '../src/server/sessions'
import {
  CODE_SENDS_PER_EMAIL,
  CODE_SENDS_PER_IP,
  CODE_SEND_WINDOW_S,
} from '../src/server/ratelimit'
import { inRequest } from './request'

const now = () => Math.floor(Date.now() / 1000)

let seq = 0
function unique(prefix: string): string {
  return `${prefix}-${++seq}-${crypto.randomUUID()}`
}

function freshEmail(prefix = 'who'): string {
  return `${unique(prefix)}@example.com`
}

/** Every test gets its own client IP, so the per-IP cap only fires where a test asks for it. */
let ipSeq = 0
function freshIp(): string {
  ipSeq += 1
  return `10.${(ipSeq >> 16) & 255}.${(ipSeq >> 8) & 255}.${ipSeq & 255}`
}

async function makeUser(opts: { email?: string; disabled?: boolean } = {}) {
  const id = unique('u')
  const email = opts.email ?? freshEmail('user')
  await db()
    .insert(users)
    .values({ id, email, createdAt: now(), disabled: opts.disabled ?? false })
  return { id, email }
}

async function makeInvite(email?: string): Promise<string> {
  const code = unique('inv')
  await db()
    .insert(invites)
    .values({ code, email: email ?? null, createdAt: now() })
  return code
}

// The one log line that carries a plaintext code. Parsed strictly so a stray
// console.log cannot be mistaken for a send.
type Sent = { email: string; code: string }
function sends(calls: unknown[][]): Sent[] {
  const out: Sent[] = []
  for (const [first] of calls) {
    if (typeof first !== 'string') continue
    let parsed: unknown
    try {
      parsed = JSON.parse(first)
    } catch {
      continue
    }
    const e = parsed as Partial<{ evt: string; email: string; code: string }>
    if (e.evt === 'login_code' && typeof e.email === 'string' && typeof e.code === 'string') {
      out.push({ email: e.email, code: e.code })
    }
  }
  return out
}

/** Run `body` with the log captured, and report every login code it sent. */
async function watchingSends<T>(body: () => Promise<T>): Promise<{ value: T; sent: Sent[] }> {
  const lines: unknown[][] = []
  const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    lines.push(args)
  })
  let value: T
  try {
    value = await body()
  } finally {
    spy.mockRestore()
  }
  return { value, sent: sends(lines) }
}

/** Ask for a code, and report both the answer and whatever was actually sent. */
async function ask(
  input: { email: string; invite?: string },
  opts: { ip?: string } = {},
): Promise<{ value: { ok: true }; sent: Sent[] }> {
  const ip = opts.ip ?? freshIp()
  return watchingSends(async () => (await inRequest(() => requestCode(input), { ip })).value)
}

/** Ask for a code and return the plaintext the Sender was handed. Fails if nothing was sent. */
async function codeFor(email: string, invite?: string): Promise<string> {
  const { sent } = await ask({ email, ...(invite === undefined ? {} : { invite }) })
  expect(sent).toHaveLength(1)
  return sent[0]?.code as string
}

/** Submit a code inside a request, and report the answer plus any Set-Cookie. */
async function submit(
  input: { email: string; code: string; invite?: string },
  opts: { cookie?: string } = {},
) {
  return inRequest(() => submitCode(input), opts)
}

function sessionToken(setCookie: Array<string>): string | null {
  const ours = setCookie.filter((c) => c.startsWith(`${SESSION_COOKIE}=`))
  const header = ours[0]
  if (!header) return null
  const value = header.slice(`${SESSION_COOKIE}=`.length).split(';')[0]
  return value ? decodeURIComponent(value) : null
}

function rowsForEmail(email: string) {
  return db().select().from(users).where(eq(users.email, email))
}

function codeRows(email: string) {
  return db().select().from(loginCodes).where(eq(loginCodes.email, email))
}

describe('requestCode: who gets a code', () => {
  it('says yes to a stranger and sends them nothing', async () => {
    const email = freshEmail('stranger')
    const { value, sent } = await ask({ email })

    expect(value).toEqual({ ok: true })
    expect(sent).toEqual([])
    // Not merely "no email went out": no code was minted either, so there is
    // nothing for a later submission to find and nothing in the table to
    // count as an oracle.
    expect(await codeRows(email)).toEqual([])
  })

  it('sends to an address holding an unredeemed invite', async () => {
    const email = freshEmail('invited')
    await makeInvite(email)

    const { value, sent } = await ask({ email })
    expect(value).toEqual({ ok: true })
    expect(sent).toHaveLength(1)
    expect(sent[0]?.email).toBe(email)
    expect(sent[0]?.code).toMatch(/^\d{8}$/)
  })

  it('sends to an existing user, invite or no invite', async () => {
    const user = await makeUser()
    const { sent } = await ask({ email: user.email })
    expect(sent).toHaveLength(1)
  })

  it('sends to someone presenting an unbound invite code', async () => {
    // An unbound invite is a bearer code — the holder types it in. Without
    // this the code could never be redeemed: nothing binds it to an address,
    // so nothing would let its holder past the gate.
    const code = await makeInvite()
    const email = freshEmail('bearer')

    const { sent } = await ask({ email, invite: code })
    expect(sent).toHaveLength(1)
    // Asking does not spend it: the invite is burned at submit, not here.
    const [row] = await db().select().from(invites).where(eq(invites.code, code))
    expect(row?.redeemedBy).toBeNull()
  })

  it('sends nothing for an invite bound to somebody else', async () => {
    const code = await makeInvite('rightful@example.com')
    const { value, sent } = await ask({ email: freshEmail('thief'), invite: code })
    expect(value).toEqual({ ok: true })
    expect(sent).toEqual([])
  })

  it('sends nothing for an invite that has already been redeemed', async () => {
    const code = await makeInvite()
    const email = freshEmail('late')
    await db()
      .update(invites)
      .set({ redeemedBy: 'someone', redeemedAt: now() })
      .where(eq(invites.code, code))

    expect((await ask({ email, invite: code })).sent).toEqual([])
  })

  it('sends nothing to a disabled account', async () => {
    // The kill switch has to reach the front door, not just the session: a
    // disabled account that still receives codes is a disabled account that
    // still gets login emails.
    const user = await makeUser({ disabled: true })
    const { value, sent } = await ask({ email: user.email })
    expect(value).toEqual({ ok: true })
    expect(sent).toEqual([])
  })

  it('normalizes the address before it decides anything', async () => {
    const email = freshEmail('mixedcase')
    await makeInvite(email)

    const { sent } = await ask({ email: `  ${email.toUpperCase()}  ` })
    expect(sent).toHaveLength(1)
    // And the code is stored under the one spelling the database uses, so the
    // submission that follows can find it.
    expect(sent[0]?.email).toBe(email)
    expect(await codeRows(email)).toHaveLength(1)
  })

  it('answers a stranger and an invited address identically', async () => {
    // The enumeration test. Same call, same shape, same value — the only
    // difference is in a mailbox neither the caller nor the timer can see.
    const invited = freshEmail('enum-invited')
    await makeInvite(invited)

    const strangerAnswer = await ask({ email: freshEmail('enum-stranger') })
    const invitedAnswer = await ask({ email: invited })

    expect(strangerAnswer.value).toEqual(invitedAnswer.value)
    expect(Object.keys(strangerAnswer.value)).toEqual(Object.keys(invitedAnswer.value))
    // The branches differ only in the send.
    expect(strangerAnswer.sent).toEqual([])
    expect(invitedAnswer.sent).toHaveLength(1)
  })
})

describe('requestCode: rate limits', () => {
  it('stops sending to one address after the cap, and still says yes', async () => {
    // The attempt cap in login_codes counts guesses *at one code*, and issuing
    // a new code starts a fresh five. Without a cap on issuing, "5 guesses"
    // means "5 guesses per request", i.e. no cap at all.
    const user = await makeUser()

    for (let i = 0; i < CODE_SENDS_PER_EMAIL; i++) {
      expect((await ask({ email: user.email })).sent).toHaveLength(1)
    }
    const over = await ask({ email: user.email })
    expect(over.value).toEqual({ ok: true })
    expect(over.sent).toEqual([])

    // Another address is unaffected: the bucket is per address.
    const other = await makeUser()
    expect((await ask({ email: other.email })).sent).toHaveLength(1)
  })

  it('stops sending from one IP after the cap, whatever address it asks about', async () => {
    // Without this, the per-address cap is a per-address budget an enumerator
    // spends across as many addresses as it likes.
    const ip = freshIp()
    for (let i = 0; i < CODE_SENDS_PER_IP; i++) {
      const user = await makeUser()
      expect((await ask({ email: user.email }, { ip })).sent).toHaveLength(1)
    }

    const fresh = await makeUser()
    const over = await ask({ email: fresh.email }, { ip })
    expect(over.value).toEqual({ ok: true })
    expect(over.sent).toEqual([])

    // The same address from a different IP still works, so the cap is on the
    // caller and not on the account.
    expect((await ask({ email: fresh.email }, { ip: freshIp() })).sent).toHaveLength(1)
  })

  it('counts a stranger’s attempts too, so the limiter is not an oracle', async () => {
    // If only real sends were counted, an attacker could tell "invited" from
    // "unknown" by which address stopped answering first.
    const ip = freshIp()
    const stranger = freshEmail('flood')
    for (let i = 0; i < CODE_SENDS_PER_EMAIL + 1; i++) {
      expect((await ask({ email: stranger }, { ip })).value).toEqual({ ok: true })
    }

    // The stranger's address is now over its cap: give it an invite and it
    // still gets nothing until the window rolls.
    await makeInvite(stranger)
    expect((await ask({ email: stranger }, { ip: freshIp() })).sent).toEqual([])
  })

  it('starts again once the window has passed', async () => {
    // The other half of a cap: it has to let go. A counter that only ever goes
    // up is a permanent lockout for anyone who mistypes their address six
    // times, and nothing in the response would say so.
    const user = await makeUser()
    for (let i = 0; i < CODE_SENDS_PER_EMAIL; i++) await ask({ email: user.email })
    expect((await ask({ email: user.email })).sent).toEqual([])

    // Age every window past its end — the same thing the clock does.
    await db()
      .update(rateLimits)
      .set({ windowStart: sql`${rateLimits.windowStart} - ${CODE_SEND_WINDOW_S + 1}` })

    expect((await ask({ email: user.email })).sent).toHaveLength(1)
  })
})

describe('requestCode: a sender that fails', () => {
  it('answers exactly the same, and does not re-issue', async () => {
    // The send happens after the code row is committed, so a throw here would
    // otherwise escape as a 500: a different response for an address that has
    // an account, which is the enumeration oracle this whole file exists to
    // prevent — and a user locked out by a mail provider's bad afternoon.
    const user = await makeUser()
    const spy = vi
      .spyOn(LogSender.prototype, 'sendLoginCode')
      .mockRejectedValue(new Error('smtp is on fire'))
    try {
      const { value } = await ask({ email: user.email })
      expect(value).toEqual({ ok: true })
      // One attempt, not a retry loop: the code is already spent as far as the
      // database is concerned, and re-issuing would mint a second one.
      expect(spy).toHaveBeenCalledTimes(1)
    } finally {
      spy.mockRestore()
    }

    // Identical to the answer a stranger gets.
    expect((await ask({ email: freshEmail('control') })).value).toEqual({ ok: true })
  })
})

describe('submitCode: signing up', () => {
  it('creates the user, burns the invite, and starts a session', async () => {
    const invite = await makeInvite()
    const email = freshEmail('signup')
    const code = await codeFor(email, invite)

    const { value, setCookie } = await submit({ email, code, invite })
    expect(value).toEqual({ ok: true })

    const [user] = await rowsForEmail(email)
    expect(user).toBeDefined()

    const [row] = await db().select().from(invites).where(eq(invites.code, invite))
    expect(row?.redeemedBy).toBe(user?.id)

    // The cookie is real: it resolves back to the user who just signed up.
    const token = sessionToken(setCookie)
    expect(token).not.toBeNull()
    const seen = await inRequest(currentUser, { cookie: `${SESSION_COOKIE}=${token}` })
    expect(seen.value).toEqual({ id: user?.id, email })
  })

  it('refuses a second signup on the same invite', async () => {
    const invite = await makeInvite()
    const first = freshEmail('first')
    const second = freshEmail('second')

    // Both hold the same code and both got a login code while the invite was
    // still live — the race a shared invite link actually produces.
    const firstCode = await codeFor(first, invite)
    const secondCode = await codeFor(second, invite)

    expect((await submit({ email: first, code: firstCode, invite })).value).toEqual({ ok: true })

    // The second person has a perfectly good login code and the same invite —
    // and gets nothing, because the invite is spent.
    const { value, setCookie } = await submit({ email: second, code: secondCode, invite })
    expect(value).toEqual({ ok: false })
    expect(await rowsForEmail(second)).toEqual([])
    expect(sessionToken(setCookie)).toBeNull()
  })

  it('redeems an invite bound to the address without being handed the code', async () => {
    // A bound invite arrives as an email, not as something the visitor has to
    // paste back: the address is the credential.
    const email = freshEmail('bound')
    const invite = await makeInvite(email)
    const code = await codeFor(email)

    expect((await submit({ email, code })).value).toEqual({ ok: true })
    const [user] = await rowsForEmail(email)
    const [row] = await db().select().from(invites).where(eq(invites.code, invite))
    expect(row?.redeemedBy).toBe(user?.id)
  })

  it('refuses to create a user with no invite at all', async () => {
    // Reached only by someone who already holds a valid code for an address
    // with no account — an operator testing, or a code issued and then
    // orphaned. The gate still has to hold at submit time.
    const email = freshEmail('gatecrash')
    const invite = await makeInvite()
    const code = await codeFor(email, invite)

    const { value, setCookie } = await submit({ email, code })
    expect(value).toEqual({ ok: false })
    expect(await rowsForEmail(email)).toEqual([])
    expect(sessionToken(setCookie)).toBeNull()
  })

  it('refuses an invite bound to somebody else', async () => {
    // The invite the visitor *submits* is the one that has to hold up — not
    // the one they used to get a code. Here they hold a live unbound invite,
    // ask for a code with it, then submit somebody else's bound invite.
    const held = await makeInvite()
    const foreign = await makeInvite('rightful@example.com')
    const email = freshEmail('thief')
    const code = await codeFor(email, held)

    expect((await submit({ email, code, invite: foreign })).value).toEqual({ ok: false })
    expect(await rowsForEmail(email)).toEqual([])
    // Neither invite was spent on the attempt.
    const rows = await db().select().from(invites).where(eq(invites.code, held))
    expect(rows[0]?.redeemedBy).toBeNull()
    expect((await db().select().from(invites).where(eq(invites.code, foreign)))[0]?.redeemedBy).toBeNull()
  })
})

describe('submitCode: signing in', () => {
  it('logs an existing user in with no invite', async () => {
    const user = await makeUser()
    const code = await codeFor(user.email)

    const { value, setCookie } = await submit({ email: user.email, code })
    expect(value).toEqual({ ok: true })
    const token = sessionToken(setCookie)
    expect((await inRequest(currentUser, { cookie: `${SESSION_COOKIE}=${token}` })).value).toEqual({
      id: user.id,
      email: user.email,
    })
  })

  it('ignores an invite when the account already exists', async () => {
    const user = await makeUser()
    const invite = await makeInvite()
    const code = await codeFor(user.email)

    expect((await submit({ email: user.email, code, invite })).value).toEqual({ ok: true })
    // The invite is not spent on a login it was not needed for.
    const [row] = await db().select().from(invites).where(eq(invites.code, invite))
    expect(row?.redeemedBy).toBeNull()
  })

  it('rotates the session, so a pre-login cookie cannot survive the login', async () => {
    // Session fixation: whatever id the visitor arrived holding must be gone.
    const user = await makeUser()
    const first = await submit({ email: user.email, code: await codeFor(user.email) })
    const firstToken = sessionToken(first.setCookie) as string

    const second = await submit(
      { email: user.email, code: await codeFor(user.email) },
      { cookie: `${SESSION_COOKIE}=${firstToken}` },
    )
    const secondToken = sessionToken(second.setCookie)
    expect(secondToken).not.toBe(firstToken)

    // Exactly one Set-Cookie for our name, and the old row is gone from D1 —
    // not merely shadowed in the browser.
    expect(second.setCookie.filter((c) => c.startsWith(`${SESSION_COOKIE}=`))).toHaveLength(1)
    expect(
      await db()
        .select()
        .from(sessions)
        .where(eq(sessions.id, await sha256Hex(firstToken))),
    ).toEqual([])
  })

  it('refuses a disabled account holding a correct code', async () => {
    // The account was disabled between the code being issued and being used.
    const user = await makeUser()
    const code = await codeFor(user.email)
    await db().update(users).set({ disabled: true }).where(eq(users.id, user.id))

    const { value, setCookie } = await submit({ email: user.email, code })
    expect(value).toEqual({ ok: false })
    expect(sessionToken(setCookie)).toBeNull()
  })
})

describe('submitCode: refusals', () => {
  it('never creates a user from a wrong code', async () => {
    const invite = await makeInvite()
    const email = freshEmail('wrongcode')
    await codeFor(email, invite) // a real code exists; the submission does not use it

    const { value, setCookie } = await submit({ email, code: '00000000', invite })
    expect(value).toEqual({ ok: false })
    expect(await rowsForEmail(email)).toEqual([])
    expect(sessionToken(setCookie)).toBeNull()
    // The invite survives a failed attempt — a wrong guess must not cost the
    // holder their one shot at an account.
    const [row] = await db().select().from(invites).where(eq(invites.code, invite))
    expect(row?.redeemedBy).toBeNull()
  })

  it('never creates a user for an address that was never sent anything', async () => {
    const invite = await makeInvite()
    const email = freshEmail('nocode')
    const { value } = await submit({ email, code: '12345678', invite })
    expect(value).toEqual({ ok: false })
    expect(await rowsForEmail(email)).toEqual([])
  })

  it('says nothing but no', async () => {
    // The failure value carries one key. Anything else — a reason, a code, a
    // "no such account" — is the oracle again.
    const { value } = await submit({ email: freshEmail('quiet'), code: '00000000' })
    expect(value).toEqual({ ok: false })
    expect(Object.keys(value)).toEqual(['ok'])
  })

  it('burns the code, so a correct one works exactly once', async () => {
    const user = await makeUser()
    const code = await codeFor(user.email)

    expect((await submit({ email: user.email, code })).value).toEqual({ ok: true })
    const replay = await submit({ email: user.email, code })
    expect(replay.value).toEqual({ ok: false })
    expect(sessionToken(replay.setCookie)).toBeNull()
  })
})
