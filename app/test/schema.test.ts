// What this file is actually asserting: the committed migration SQL applies
// cleanly to a real (local) D1, and the tables it creates match what
// src/db/schema.ts says they are — same names, same nullability, same
// defaults. Drizzle's camelCase properties are only ever as true as the
// generated SQL, so both halves are checked: raw SQL against the migration,
// and the drizzle client against the same rows.
//
// The client under test is the real `db()` from src/db/client.ts rather than a
// local drizzle instance: a test body in the pool runs inside a request
// context, so its `env` from 'cloudflare:workers' resolves exactly as it will
// in a route loader.
//
// The pool isolates storage per test *file*, not per test: everything below
// shares one database, so ids and emails have to be unique across the file and
// no test may assume it is looking at an empty table.
import { applyD1Migrations, env } from 'cloudflare:test'
import type { D1Migration } from 'cloudflare:test'
import { eq, getTableName, is, sql } from 'drizzle-orm'
import { SQLiteTable } from 'drizzle-orm/sqlite-core'
import { describe, expect, it } from 'vitest'
import { db } from '../src/db/client'
import * as schema from '../src/db/schema'

function hex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

async function sha256Hex(input: string | Uint8Array<ArrayBuffer>): Promise<string> {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input
  return hex(await crypto.subtle.digest('SHA-256', bytes))
}

// login_codes.code_hash is an HMAC, not a bare digest: a 6-digit code has a
// 10^6 keyspace, so an unkeyed hash is reversible from a dump in seconds.
async function hmacHex(key: string, message: string): Promise<string> {
  const enc = new TextEncoder()
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    enc.encode(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  return hex(await crypto.subtle.sign('HMAC', cryptoKey, enc.encode(message)))
}

// Drizzle rethrows a D1 failure as `Failed query: <sql>` and hangs the real
// SQLite message off `cause`, so `rejects.toThrow(/UNIQUE/)` would only ever
// see the wrapper. Flatten the chain and match against the whole of it.
const RESOLVED = Symbol('resolved')
async function rejectionChain(promise: Promise<unknown>): Promise<string> {
  const thrown: unknown = await promise.then(
    () => RESOLVED,
    (err: unknown) => err,
  )
  if (thrown === RESOLVED) throw new Error('expected the query to be rejected, but it resolved')
  const messages: string[] = []
  for (let err: unknown = thrown; err instanceof Error; err = err.cause) messages.push(err.message)
  return messages.join(' | ')
}

describe('migrations', () => {
  it('creates every table the schema declares', async () => {
    // Derived from schema.ts, not a hand-written list: adding a table without
    // running `pnpm db:generate` has to fail here, which is the whole point of
    // testing against the migration rather than against the schema.
    const declared = (Object.values(schema) as unknown[])
      .filter((t): t is SQLiteTable => is(t, SQLiteTable))
      .map(getTableName)
    // Sanity on the derivation itself, so the assertion below cannot pass by
    // finding nothing to check.
    expect(declared).toContain('users')

    const { results } = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type='table'",
    ).all<{ name: string }>()
    expect(results.map((r) => r.name)).toEqual(expect.arrayContaining(declared))
  })

  it('records what it applied, so re-running it is a no-op', async () => {
    // Migrations are applied to a database that already has these tables —
    // here on every test file, and by `wrangler d1 migrations apply` on every
    // deploy. Both appliers skip what the d1_migrations table already lists;
    // this covers the one the tests run, and the format it agrees on.
    const before = await env.DB.prepare('SELECT name FROM d1_migrations').all<{ name: string }>()
    expect(before.results.map((r) => r.name).join(',')).toMatch(/0000_init/)

    const { TEST_MIGRATIONS } = env as unknown as { TEST_MIGRATIONS: D1Migration[] }
    await applyD1Migrations(env.DB, TEST_MIGRATIONS)

    const after = await env.DB.prepare('SELECT name FROM d1_migrations').all<{ name: string }>()
    expect(after.results).toEqual(before.results)
  })
})

describe('users', () => {
  it('round-trips through raw SQL under the migrated column names', async () => {
    await env.DB.prepare('INSERT INTO users (id, email, created_at, disabled) VALUES (?, ?, ?, 0)')
      .bind('u1', 'a@b.com', 1)
      .run()
    const row = await env.DB.prepare('SELECT email FROM users WHERE id = ?').bind('u1').first()
    expect(row?.email).toBe('a@b.com')
  })

  it('round-trips through drizzle, mapping camelCase to snake_case', async () => {
    await db().insert(schema.users).values({ id: 'u2', email: 'c@d.com', createdAt: 1_700_000_000 })
    const [row] = await db().select().from(schema.users).where(eq(schema.users.id, 'u2'))
    expect(row).toMatchObject({ id: 'u2', email: 'c@d.com', createdAt: 1_700_000_000 })
    // `disabled` defaults in SQL, not in JS, and comes back as a boolean.
    expect(row?.disabled).toBe(false)
  })

  it('rejects a duplicate email', async () => {
    await db().insert(schema.users).values({ id: 'u3', email: 'dupe@b.com', createdAt: 1 })
    const err = await rejectionChain(
      db().insert(schema.users).values({ id: 'u4', email: 'dupe@b.com', createdAt: 1 }),
    )
    expect(err).toMatch(/UNIQUE constraint failed: users\.email/i)
  })

  it('requires an email', async () => {
    const err = await rejectionChain(
      env.DB.prepare('INSERT INTO users (id, created_at, disabled) VALUES (?, ?, 0)')
        .bind('u5', 1)
        .run(),
    )
    expect(err).toMatch(/NOT NULL constraint failed: users\.email/i)
  })
})

describe('invites', () => {
  it('starts unredeemed and records who redeemed it', async () => {
    await db().insert(schema.invites).values({ code: 'inv-1', createdAt: 1 })
    const [fresh] = await db()
      .select()
      .from(schema.invites)
      .where(eq(schema.invites.code, 'inv-1'))
    expect(fresh).toMatchObject({ email: null, redeemedBy: null, redeemedAt: null })

    await db()
      .update(schema.invites)
      .set({ redeemedBy: 'u1', redeemedAt: 42 })
      .where(eq(schema.invites.code, 'inv-1'))
    const [used] = await db().select().from(schema.invites).where(eq(schema.invites.code, 'inv-1'))
    expect(used).toMatchObject({ redeemedBy: 'u1', redeemedAt: 42 })
  })
})

describe('login_codes', () => {
  it('defaults attempts to zero and counts wrong guesses up', async () => {
    await db().insert(schema.loginCodes).values({
      id: 'lc1',
      email: 'a@b.com',
      codeHash: await hmacHex('server-secret', '123456'),
      expiresAt: 99,
      createdAt: 1,
    })
    const [fresh] = await db()
      .select()
      .from(schema.loginCodes)
      .where(eq(schema.loginCodes.id, 'lc1'))
    expect(fresh?.attempts).toBe(0)

    // A wrong guess bumps the counter, and that counter is the only thing
    // standing between a 6-digit code and a brute force — so the increment
    // happens *in* SQL. D1 has no interactive transactions, so a read here and
    // a write there would let two concurrent guesses both write 1.
    await db()
      .update(schema.loginCodes)
      .set({ attempts: sql`${schema.loginCodes.attempts} + 1` })
      .where(eq(schema.loginCodes.id, 'lc1'))
    const [tried] = await db()
      .select()
      .from(schema.loginCodes)
      .where(eq(schema.loginCodes.id, 'lc1'))
    expect(tried?.attempts).toBe(1)
  })
})

describe('sessions', () => {
  it('keys a session by the hash of its token', async () => {
    const token = 'the-cookie-value'
    const id = await sha256Hex(token)
    await db().insert(schema.sessions).values({ id, userId: 'u1', createdAt: 1, expiresAt: 2 })

    // The cookie value never appears in a column; the row is found by looking
    // up its digest, which is what makes a stolen dump unusable as a cookie.
    const [row] = await db().select().from(schema.sessions).where(eq(schema.sessions.id, id))
    expect(row?.userId).toBe('u1')
    expect(row?.id).toHaveLength(64)

    const byToken = await db()
      .select()
      .from(schema.sessions)
      .where(eq(schema.sessions.id, token))
    expect(byToken).toEqual([])
  })
})

describe('devices', () => {
  it('round-trips a device id derived the way the daemon derives it', async () => {
    // internal/crypto.DeviceID: the first 12 hex chars of SHA-256(static
    // public key). Derived here rather than hardcoded, so the column is shown
    // holding the real shape both ends agree on.
    const staticKey = new Uint8Array([0xde, 0xad, 0xbe, 0xef])
    const id = (await sha256Hex(staticKey)).slice(0, 12)

    await db().insert(schema.devices).values({
      id,
      userId: 'u1',
      label: 'laptop',
      publicKey: btoa(String.fromCharCode(...staticKey)),
      tokenHash: await sha256Hex('enrollment-token'),
      createdAt: 1,
    })
    const [row] = await db().select().from(schema.devices).where(eq(schema.devices.id, id))
    expect(row).toMatchObject({ id, label: 'laptop', lastSeen: null, disabled: false })

    // A heartbeat writes last_seen; the kill switch flips disabled.
    await db()
      .update(schema.devices)
      .set({ lastSeen: 123, disabled: true })
      .where(eq(schema.devices.id, id))
    const [seen] = await db().select().from(schema.devices).where(eq(schema.devices.id, id))
    expect(seen).toMatchObject({ lastSeen: 123, disabled: true })
  })

  it('refuses two devices sharing a token hash', async () => {
    // The token hash is what every daemon request is resolved by, so it has to
    // resolve to exactly one device.
    const tokenHash = await sha256Hex('shared-token')
    const base = { userId: 'u1', label: 'l', publicKey: 'k', tokenHash, createdAt: 1 }
    await db().insert(schema.devices).values({ ...base, id: '111111111111' })
    const err = await rejectionChain(
      db()
        .insert(schema.devices)
        .values({ ...base, id: '222222222222' }),
    )
    expect(err).toMatch(/UNIQUE constraint failed: devices\.token_hash/i)
  })
})

describe('device_auth', () => {
  it('finds a pending grant by the digest of the polled code, not the code', async () => {
    // The daemon holds `code` and sends it on every poll; the table holds only
    // its digest, so the lookup is by digest — same shape as sessions.
    const code = 'opaque-device-code-1'
    await db().insert(schema.deviceAuth).values({
      userCode: 'WXYZ-1234',
      deviceCode: await sha256Hex(code),
      createdAt: 1,
      expiresAt: 900,
      publicKey: 'BASE64PUBKEY',
    })

    const pollFor = async (presented: string) =>
      db()
        .select()
        .from(schema.deviceAuth)
        .where(eq(schema.deviceAuth.deviceCode, await sha256Hex(presented)))

    const [pending] = await pollFor(code)
    expect(pending).toMatchObject({ userCode: 'WXYZ-1234', approvedUserId: null, deviceId: null })
    expect(await pollFor('a-guess')).toEqual([])

    // Approval fills in who confirmed it and which device it minted.
    await db()
      .update(schema.deviceAuth)
      .set({ approvedUserId: 'u1', deviceId: 'a1b2c3d4e5f6' })
      .where(eq(schema.deviceAuth.userCode, 'WXYZ-1234'))
    const [approved] = await pollFor(code)
    expect(approved).toMatchObject({ approvedUserId: 'u1', deviceId: 'a1b2c3d4e5f6' })
  })

  it('is burned by the batch that mints the device, so it mints only once', async () => {
    const code = 'opaque-device-code-3'
    const deviceCode = await sha256Hex(code)
    await db()
      .insert(schema.deviceAuth)
      .values({ userCode: 'CCCC-3333', deviceCode, createdAt: 1, expiresAt: 900 })

    // The redeem path: insert the device and delete the grant together. Split
    // across two round trips a crashed request would leave a live grant that
    // mints a second device on the next poll.
    const d = db()
    await d.batch([
      d.insert(schema.devices).values({
        id: '333333333333',
        userId: 'u1',
        label: 'burned',
        publicKey: 'k3',
        tokenHash: await sha256Hex('token-3'),
        createdAt: 1,
      }),
      d.delete(schema.deviceAuth).where(eq(schema.deviceAuth.deviceCode, deviceCode)),
    ])

    const left = await d
      .select()
      .from(schema.deviceAuth)
      .where(eq(schema.deviceAuth.deviceCode, deviceCode))
    expect(left).toEqual([])
  })

  it('refuses two grants sharing a device code', async () => {
    const deviceCode = await sha256Hex('opaque-device-code-2')
    await db()
      .insert(schema.deviceAuth)
      .values({ userCode: 'AAAA-1111', deviceCode, createdAt: 1, expiresAt: 900 })
    const err = await rejectionChain(
      db()
        .insert(schema.deviceAuth)
        .values({ userCode: 'BBBB-2222', deviceCode, createdAt: 1, expiresAt: 900 }),
    )
    expect(err).toMatch(/UNIQUE constraint failed: device_auth\.device_code/i)
  })
})

describe('batch', () => {
  // D1 has no interactive transactions, so batch() is the only way to make
  // several writes land or fail together — every later multi-write path
  // (redeem an invite and create the user, approve a device and burn the
  // grant) depends on this working through the drizzle client.
  it('commits a multi-table write as one unit', async () => {
    const d = db()
    await d.batch([
      d.insert(schema.users).values({ id: 'b1', email: 'batch@b.com', createdAt: 1 }),
      d
        .insert(schema.sessions)
        .values({ id: 'sess-b1', userId: 'b1', createdAt: 1, expiresAt: 2 }),
    ])
    const [user] = await d.select().from(schema.users).where(eq(schema.users.id, 'b1'))
    const [session] = await d.select().from(schema.sessions).where(eq(schema.sessions.userId, 'b1'))
    expect(user?.email).toBe('batch@b.com')
    expect(session?.id).toBe('sess-b1')
  })

  it('rolls the whole batch back when one statement fails', async () => {
    const d = db()
    await d.insert(schema.users).values({ id: 'b2', email: 'taken@b.com', createdAt: 1 })
    const err = await rejectionChain(
      d.batch([
        d.insert(schema.users).values({ id: 'b3', email: 'fresh@b.com', createdAt: 1 }),
        d.insert(schema.users).values({ id: 'b4', email: 'taken@b.com', createdAt: 1 }),
      ]),
    )
    expect(err).toMatch(/UNIQUE constraint failed: users\.email/i)
    const [orphan] = await d.select().from(schema.users).where(eq(schema.users.id, 'b3'))
    expect(orphan).toBeUndefined()
  })
})
