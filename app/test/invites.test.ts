// The invite gate, tested against a real (local) D1 — because every property
// worth having here is a *database* property. "Redeemed exactly once" is a
// claim about what two concurrent statements can do to one row, and "a crash
// cannot create a user without burning the invite" is a claim about what D1's
// batch commits together. A fake would only prove the fake works.
//
// The pool isolates storage per test *file*, not per test, so every test below
// mints its own invite code and its own address, and nothing may assume an
// empty table.
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { db } from '../src/db/client'
import { invites, users } from '../src/db/schema'
import {
  consumeInvite,
  createUserWithInvite,
  hasUnredeemedInvite,
  inviteFor,
} from '../src/server/invites'

const now = () => Math.floor(Date.now() / 1000)

let seq = 0
function unique(prefix: string): string {
  return `${prefix}-${++seq}-${crypto.randomUUID()}`
}

/** An invite, optionally bound to an address. Returns its code. */
async function makeInvite(email?: string): Promise<string> {
  const code = unique('inv')
  await db()
    .insert(invites)
    .values({ code, email: email ?? null, createdAt: now() })
  return code
}

async function makeUser(): Promise<{ id: string; email: string }> {
  const id = unique('u')
  const email = `${id}@example.com`
  await db().insert(users).values({ id, email, createdAt: now() })
  return { id, email }
}

function inviteRow(code: string) {
  return db().select().from(invites).where(eq(invites.code, code))
}

function userRow(email: string) {
  return db().select().from(users).where(eq(users.email, email))
}

describe('consumeInvite', () => {
  it('marks the invite redeemed by the user who took it', async () => {
    const code = await makeInvite()
    const user = await makeUser()
    const before = now()

    expect(await consumeInvite(code, user.id, user.email)).toBe(true)

    const [row] = await inviteRow(code)
    expect(row?.redeemedBy).toBe(user.id)
    expect(row?.redeemedAt ?? 0).toBeGreaterThanOrEqual(before)
  })

  it('refuses a second redemption of the same invite', async () => {
    const code = await makeInvite()
    const first = await makeUser()
    const second = await makeUser()

    expect(await consumeInvite(code, first.id, first.email)).toBe(true)
    expect(await consumeInvite(code, second.id, second.email)).toBe(false)

    // ...and the loser did not overwrite the winner.
    const [row] = await inviteRow(code)
    expect(row?.redeemedBy).toBe(first.id)
  })

  it('refuses a code that does not exist', async () => {
    const user = await makeUser()
    expect(await consumeInvite('no-such-invite', user.id, user.email)).toBe(false)
  })

  it('refuses an invite bound to a different address', async () => {
    // A bound invite is a bearer token addressed to one person. Letting anyone
    // who learns the code redeem it would make the binding decoration.
    const code = await makeInvite('invited@example.com')
    const other = await makeUser()

    expect(await consumeInvite(code, other.id, other.email)).toBe(false)
    expect((await inviteRow(code))[0]?.redeemedBy).toBeNull()

    // The address it was issued to still works.
    const owner = await makeUser()
    expect(await consumeInvite(code, owner.id, 'invited@example.com')).toBe(true)
  })

  it('lets an unbound invite be redeemed by any address', async () => {
    const code = await makeInvite()
    const user = await makeUser()
    expect(await consumeInvite(code, user.id, user.email)).toBe(true)
  })

  it('is decided in one statement, so two racing redemptions produce one winner', async () => {
    // The whole value of an invite is that it converts to exactly one account.
    // Read-then-write would let both of these see `redeemed_by IS NULL`.
    const code = await makeInvite()
    const a = await makeUser()
    const b = await makeUser()

    const results = await Promise.all([
      consumeInvite(code, a.id, a.email),
      consumeInvite(code, b.id, b.email),
    ])
    expect(results.filter(Boolean)).toHaveLength(1)
  })
})

describe('inviteFor / hasUnredeemedInvite', () => {
  it('finds an unredeemed invite bound to the address', async () => {
    const email = `${unique('bound')}@example.com`
    const code = await makeInvite(email)
    expect(await inviteFor(email)).toBe(code)
    expect(await hasUnredeemedInvite(email)).toBe(true)
  })

  it('does not find an invite that has been redeemed', async () => {
    const email = `${unique('spent')}@example.com`
    const code = await makeInvite(email)
    const user = await makeUser()
    await consumeInvite(code, user.id, email)

    expect(await inviteFor(email)).toBeNull()
    expect(await hasUnredeemedInvite(email)).toBe(false)
  })

  it('does not hand an unbound invite to an address that never got one', async () => {
    // An unbound invite is a bearer code: it opens the door for whoever holds
    // it, not for everyone who can type an email address into the form. If
    // this leaked, one open invite would make every address on earth "invited"
    // and the gate would be gone.
    await makeInvite()
    expect(await inviteFor(`${unique('stranger')}@example.com`)).toBeNull()
    expect(await hasUnredeemedInvite(`${unique('stranger')}@example.com`)).toBe(false)
  })

  it('matches the address exactly as it is normalized', async () => {
    const email = `${unique('case')}@example.com`
    await makeInvite(email)
    expect(await inviteFor(email.toUpperCase())).toBeNull()
    expect(await inviteFor(email)).not.toBeNull()
  })
})

describe('createUserWithInvite', () => {
  it('creates the user and burns the invite together', async () => {
    const code = await makeInvite()
    const email = `${unique('new')}@example.com`

    const userId = await createUserWithInvite(email, code)
    expect(userId).not.toBeNull()

    const [user] = await userRow(email)
    expect(user?.id).toBe(userId)
    expect(user?.disabled).toBe(false)

    const [invite] = await inviteRow(code)
    expect(invite?.redeemedBy).toBe(userId)
  })

  it('creates nothing at all for an invite that is already spent', async () => {
    const code = await makeInvite()
    const first = `${unique('first')}@example.com`
    const second = `${unique('second')}@example.com`

    expect(await createUserWithInvite(first, code)).not.toBeNull()
    // The second signup on the same invite is the attack this gate exists for.
    expect(await createUserWithInvite(second, code)).toBeNull()
    expect(await userRow(second)).toEqual([])

    // ...and the first redemption is untouched.
    const [invite] = await inviteRow(code)
    expect(invite?.redeemedBy).toBe((await userRow(first))[0]?.id)
  })

  it('creates nothing for an invite that does not exist', async () => {
    const email = `${unique('uninvited')}@example.com`
    expect(await createUserWithInvite(email, 'no-such-invite')).toBeNull()
    expect(await userRow(email)).toEqual([])
  })

  it('creates nothing for an invite bound to someone else', async () => {
    const code = await makeInvite('someone@example.com')
    const email = `${unique('thief')}@example.com`

    expect(await createUserWithInvite(email, code)).toBeNull()
    expect(await userRow(email)).toEqual([])
    expect((await inviteRow(code))[0]?.redeemedBy).toBeNull()
  })

  it('leaves the invite unredeemed when the user cannot be inserted', async () => {
    // The other half of "one batch": if the insert fails — here on the unique
    // email index, which is what a concurrent signup for the same address
    // looks like — the invite must not have been spent on nothing.
    const existing = await makeUser()
    const code = await makeInvite()

    expect(await createUserWithInvite(existing.email, code)).toBeNull()
    expect((await inviteRow(code))[0]?.redeemedBy).toBeNull()
  })

  it('gives one invite to exactly one account under a race', async () => {
    const code = await makeInvite()
    const a = `${unique('racer-a')}@example.com`
    const b = `${unique('racer-b')}@example.com`

    const created = await Promise.all([
      createUserWithInvite(a, code),
      createUserWithInvite(b, code),
    ])
    expect(created.filter((id) => id !== null)).toHaveLength(1)
    expect((await userRow(a)).length + (await userRow(b)).length).toBe(1)
  })
})
