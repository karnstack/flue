// The control plane's whole database. Six tables, one D1 binding (`DB`).
//
// Conventions that hold everywhere below:
//   - timestamps are unix *seconds* in an INTEGER column, never ISO strings and
//     never milliseconds — `Math.floor(Date.now() / 1000)`;
//   - nothing a caller can present as proof is stored in the clear. Session
//     cookies, login codes, device tokens and device-flow codes all live here
//     as digests, so a dump of this database cannot be replayed against the
//     service;
//   - there are no foreign keys, on purpose. D1 enforces them inside a
//     `batch()`, where statement order is fixed at build time, which turns
//     ordinary two-table writes into ordering puzzles; deletes fan out through
//     explicit batches instead (delete a user's sessions and devices in the
//     same batch as the user);
//   - `disabled` is a hard kill switch checked on every authenticated path.
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

export const users = sqliteTable('users', {
  id: text('id').primaryKey(), // ULID/uuid
  // Normalized lowercase — by the caller. SQLite compares TEXT byte-for-byte,
  // so the unique index below would happily accept A@b.com next to a@b.com:
  // every write and every lookup must lowercase first.
  email: text('email').notNull().unique(),
  createdAt: integer('created_at').notNull(), // unix seconds
  disabled: integer('disabled', { mode: 'boolean' }).notNull().default(false), // kill switch
})

// flue.sh is invite-only while it is small: an invite is a bearer code, and
// redeeming one is what mints a user.
export const invites = sqliteTable('invites', {
  code: text('code').primaryKey(), // the invite token
  email: text('email'), // optional: bind an invite to an email
  createdAt: integer('created_at').notNull(),
  redeemedBy: text('redeemed_by'), // users.id once used
  redeemedAt: integer('redeemed_at'),
})

// Email login codes. Only the HMAC is stored, and `attempts` is what makes a
// 6-digit code safe: the row is burned long before a guesser gets through the
// keyspace.
export const loginCodes = sqliteTable(
  'login_codes',
  {
    id: text('id').primaryKey(),
    email: text('email').notNull(),
    codeHash: text('code_hash').notNull(), // HMAC-SHA-256(code), hex
    expiresAt: integer('expires_at').notNull(),
    attempts: integer('attempts').notNull().default(0),
    createdAt: integer('created_at').notNull(),
  },
  // Verification arrives with an email and a code, not with the row id.
  (t) => [index('login_codes_email_idx').on(t.email)],
)

// Fixed-window counters for the paths that must not be free to hammer. Today
// that is one path — sending a login code, capped per address and per client
// IP (server/ratelimit.ts) — because the per-code attempt cap in `login_codes`
// counts *guesses at one code* and issuing a new code starts a fresh five, so
// without a cap on issuing there is no cap at all.
//
// `key` is a digest, not the address or the IP. Every address anyone types into
// the login form would otherwise land here in the clear, including the ones
// with no account and no invite — a list of people who tried, which the service
// has no reason to keep. Hashing makes the row a counter and nothing else.
export const rateLimits = sqliteTable(
  'rate_limits',
  {
    key: text('key').primaryKey(), // SHA-256("<bucket>:<subject>"), hex
    windowStart: integer('window_start').notNull(), // unix seconds
    count: integer('count').notNull().default(0),
  },
  // Counting is a primary-key upsert; this index is for the other statement,
  // `delete from rate_limits where window_start < ?` (server/ratelimit.ts's
  // sweep). Without it that delete scans every counter in the service — and it
  // gets slower exactly as the table grows, which is to say exactly when an
  // unauthenticated caller is filling it.
  (t) => [index('rate_limits_window_start_idx').on(t.windowStart)],
)

export const sessions = sqliteTable(
  'sessions',
  {
    id: text('id').primaryKey(), // SHA-256(token), hex — the token is never stored
    userId: text('user_id').notNull(),
    createdAt: integer('created_at').notNull(),
    expiresAt: integer('expires_at').notNull(),
  },
  // Lookup is by primary key; the index is for revoking a user's sessions in
  // one statement (sign out everywhere, account disabled).
  (t) => [index('sessions_user_id_idx').on(t.userId)],
)

export const devices = sqliteTable(
  'devices',
  {
    id: text('id').primaryKey(), // device id (matches the daemon's crypto.DeviceID shape: 12 lowercase hex chars)
    userId: text('user_id').notNull(),
    label: text('label').notNull(),
    publicKey: text('public_key').notNull(), // daemon Noise static pubkey, base64
    tokenHash: text('token_hash').notNull(), // SHA-256(device enrollment token), hex
    createdAt: integer('created_at').notNull(),
    lastSeen: integer('last_seen'),
    disabled: integer('disabled', { mode: 'boolean' }).notNull().default(false),
  },
  (t) => [
    // The dashboard lists a user's devices on every page load.
    index('devices_user_id_idx').on(t.userId),
    // Every authenticated call from a daemon is a lookup by token hash, so it
    // wants an index — and it must identify exactly one device, so unique.
    uniqueIndex('devices_token_hash_idx').on(t.tokenHash),
  ],
)

// The OAuth-device-flow-shaped handshake behind `flue enable`: the CLI shows a
// short user code, the daemon polls with the opaque device code, and the
// logged-in browser approves.
//
// A row here is single-use: the write that mints the device must delete the
// grant in the same batch, or an approved code keeps minting devices until it
// expires.
export const deviceAuth = sqliteTable(
  'device_auth',
  {
    userCode: text('user_code').primaryKey(), // short code shown by `flue enable`
    // SHA-256(device code), hex — same convention as sessions.id. The daemon
    // holds the code and presents it on every poll; that makes it a bearer
    // secret, and bearer secrets are not stored here in the clear.
    deviceCode: text('device_code').notNull(),
    // The name the daemon gave itself, carried from `flue enable` to the
    // browser and on to `devices.label`. It has to live here because the two
    // ends of the handshake are two requests: the daemon submits it at start
    // and is not asked for it again, `devices.label` is NOT NULL, and the
    // device row is not written until the approving poll. It is also what the
    // person approving actually reads — a code alone says nothing about which
    // machine is asking.
    label: text('label').notNull(),
    createdAt: integer('created_at').notNull(),
    expiresAt: integer('expires_at').notNull(),
    approvedUserId: text('approved_user_id'), // set when the logged-in user confirms
    deviceId: text('device_id'), // set on approval
    publicKey: text('public_key'), // the daemon's pubkey, submitted at start
  },
  // Every poll is a lookup by that digest, and two live rows sharing one would
  // make the lookup ambiguous — so it is unique, not merely indexed.
  (t) => [uniqueIndex('device_auth_device_code_idx').on(t.deviceCode)],
)
