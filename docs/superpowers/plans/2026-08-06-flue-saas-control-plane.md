# flue.sh SaaS control plane (Plan 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Invite-only flue.sh: sign in with an emailed code, enroll your machines, and reach any of them from a browser tab — the hosted, multi-tenant layer on top of Plan 1's relay, with self-host untouched.

**Architecture:** A new **TanStack Start app** (`app/`) deployed to Cloudflare Workers with **D1** (local = real workerd SQLite) is the control plane: it owns accounts, email-code auth, invites, the device directory, and device enrollment. It never touches terminal traffic. It mints **short-lived HMAC-signed channel tokens**; the existing relay Worker (`relay/`) gains a **SaaS auth mode** that verifies those tokens with a shared signing secret — so the relay never calls the control plane on the hot path — and routes each daemon/browser pair to an **account-and-device-scoped Durable Object hub**. The Go daemon gains `flue enable` (a device-authorization flow) that links a machine to an account and dials the hosted relay. Self-host (Plan 1's `flue relay setup` + bearer secret) stays exactly as it is; the mode is selected by which credentials the relay Worker holds.

**Tech Stack:** TanStack Start (`@tanstack/react-start` 1.168+, file-based routing), Cloudflare Workers + D1, Drizzle ORM (`drizzle-orm/d1` 0.45.2 stable), wrangler v4 (`wrangler.jsonc`), `@cloudflare/vitest-pool-workers` ^0.20.2 + Vitest 4.1, Web Crypto (HMAC-SHA-256, CSPRNG), Go 1.26 daemon (existing), the existing `relay/` Worker.

## Global Constraints

- **pnpm only** (`pnpm@11.9.0`, copy the value from `web/package.json`), never npm/npx; one-off tools via `pnpm dlx`.
- **The `app/` package** pins: `@tanstack/react-start` `^1.168.0`, `@tanstack/react-router` `^1.170.0`, `@cloudflare/vite-plugin` `^1.51.0`, `vite` `^8.2.0`, `wrangler` `^4.119.0`, `drizzle-orm` `^0.45.2`, `drizzle-kit` `^0.31.10`, `@cloudflare/vitest-pool-workers` `^0.20.2`, `vitest` `^4.1.0`, `typescript` `^5.9`, react `^19.2.0`. Config is `wrangler.jsonc` with `compatibility_flags: ["nodejs_compat"]` and a recent `compatibility_date` ("2026-08-01"). Vite plugin order is **mandatory**: `cloudflare({ viteEnvironment: { name: 'ssr' } })` before `tanstackStart()` before `viteReact()`.
- **No passwords, ever.** Email login codes only. **No billing, no OAuth, no open signup** — invite-gated.
- **Email delivery is a placeholder** the user finishes later: a `Sender` interface with a `LogSender` impl that logs the code (dev) and a `NoopSender` is out of scope. Build the *seam*, not a provider. Nothing in this plan sends a real email.
- **Read `env` per request, never at module scope** (Workers injects bindings at request time; module reads are `undefined` and can leak into the client bundle). D1 I/O only inside a request/handler context.
- **The relay's self-host mode must keep passing every Plan 1 test unchanged.** SaaS mode is additive, selected by env.
- **The relay must never call the control plane on the channel hot path.** Channel authorization is offline signature verification against a shared secret (`RELAY_SIGNING_SECRET`), set on both Workers.
- **flue.sh runs on custom domains, not workers.dev** (`workers.dev` is on the Public Suffix List — no shared/`__Host-` cookies, every subdomain cross-site). Two custom domains: `app.flue.sh` (control plane), `relay.flue.sh` (relay).
- **Secrets** (`RELAY_SIGNING_SECRET`, `CODE_HMAC_SECRET`) are Worker secrets, never in `wrangler.jsonc`, never logged, never in the client bundle.
- **Auth parameters** (from research, defensible against NIST 800-63B-4 / OWASP / Copenhagen): login code = 8 decimal digits from `crypto.getRandomValues`, 10-minute TTL, single-use, HMAC-SHA-256 at rest (never plaintext, never logged), attempt cap 5 per code, new code invalidates prior; anti-enumeration (identical response + timing whether or not the account exists). Session token = 32 random bytes base64url, store `SHA-256(token)` in D1, cookie `__Host-session=<token>; HttpOnly; Secure; SameSite=Lax; Path=/`, rotate on login, 8-hour absolute expiry.
- **UI uses shadcn/ui, and is meant to be pretty.** Every `app/` screen (and the new daemon `web/` relay screen in Task 13) is built from shadcn components — `Card`/`CardHeader`/`CardContent`, `Button`, `Input` + `Field`/`FieldGroup`/`FieldLabel`, `Badge`, `Table`, `Empty`, `Alert`, `Separator`, `Sonner` toasts — never bare styled `div`s, following the shadcn skill's composition rules (layout via `className`, semantic color tokens, `gap-*` not `space-*`, `size-*` for equal dims, icons via `lucide-react` with `data-icon`). The `app/` package is scaffolded without shadcn, so **Task 6 (the first UI task) initializes shadcn in `app/`** (`pnpm dlx shadcn@latest init`) and ports `web/`'s theme tokens so the two apps look like one product. A dedicated `/design` polish pass over all control-plane screens runs at the end (controller-driven, after the functional flows are built and reviewed) — implementers build with shadcn primitives; the polish pass refines layout, spacing, empty/loading/error states, and responsive behavior.
- **Commits:** Conventional Commits; terse subject.
- **Test gate at every task boundary:** `cd app && pnpm test` green; `go test ./...` green when Go changes; `cd relay && pnpm test` green when the relay changes (the Plan 1 suite must stay green). `web/`'s 55 pre-existing failures are not in scope.

## File Structure (new/modified)

```
app/                                         the control-plane package (Tasks 1–11)
  package.json, wrangler.jsonc, tsconfig.json, vite.config.ts, vitest.config.ts, drizzle.config.ts
  migrations/                                drizzle-kit output, applied via wrangler d1 migrations
  src/
    router.tsx, routeTree.gen.ts, start.ts   Start wiring + global CSRF/auth middleware
    routes/__root.tsx, index.tsx, login.tsx, devices.tsx, enroll.tsx, terms.tsx
    db/schema.ts                             Drizzle schema (users, invites, login_codes, sessions, devices, device_auth)
    db/client.ts                             drizzle(env.DB) helper (per-request)
    server/codes.ts                          issue/verify login codes (Task 3)
    server/sessions.ts                       session create/validate/rotate/destroy (Task 4)
    server/auth.ts                           the auth-guard middleware + current-user (Task 4)
    server/invites.ts                        invite gate (Task 5)
    server/enroll.ts                         device-authorization flow, control-plane half (Task 6)
    server/channel-token.ts                  mint HMAC channel tokens for relay (Task 7)
    server/devices.ts                        device directory queries + revoke (Task 8)
    server/email/sender.ts                   Sender interface + LogSender placeholder (Task 3)
    server/ratelimit.ts                      per-account/per-IP caps + kill switch (Task 10)
    lib/tokens.ts                            shared HMAC sign/verify + base64url + timing-safe eq (Task 7)
  test/                                      pool-workers tests (D1) + jsdom component tests
relay/src/index.ts                           SaaS auth mode: verify channel tokens, account-scoped hubs (Task 9)
relay/src/channel-auth.ts                    token verification (mirrors app/src/lib/tokens.ts) (Task 9)
cmd/flue/enable.go (or new cmd/flue/saas.go) flue enable device-authorization flow (Task 11)
internal/config/relay.go                     store account/device token + hosted relay URL (Task 11)
docs/SAAS.md, docs/faq.md                    operator + honesty docs (Task 12)
```

**Decision — Drizzle over raw D1:** the control plane has ~6 tables with evolving columns; `drizzle-kit generate` diffing and typed queries pay off. D1 has **no interactive transactions** on either path — `db.batch([...])` is the only atomicity primitive; every multi-write invariant in this plan uses `batch`.

---

### Task 1: Scaffold the `app/` control-plane package

**Files:**
- Create: `app/package.json`, `app/wrangler.jsonc`, `app/tsconfig.json`, `app/vite.config.ts`, `app/vitest.config.ts`, `app/.gitignore`
- Create: `app/src/router.tsx`, `app/src/routes/__root.tsx`, `app/src/routes/index.tsx`, `app/src/start.ts`
- Create: `app/test/smoke.test.ts`
- Modify: `Makefile` (add `app` install + `test-app` + app lint into aggregate targets, mirroring how `relay` was wired), `.github/workflows/ci.yml` (hash `app/pnpm-lock.yaml` in the cache key)

**Interfaces (Produces):**
- A running Start app: `pnpm --dir app dev` serves `app.flue.sh` locally; `GET /` renders.
- `app/vitest.config.ts` exporting a `cloudflareTest()`-based config other tasks' D1 tests extend.

**Key content:**

`app/wrangler.jsonc`:
```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "flue-app",
  "compatibility_date": "2026-08-01",
  "compatibility_flags": ["nodejs_compat"],
  "main": "@tanstack/react-start/server-entry",
  "observability": { "enabled": true },
  "d1_databases": [
    { "binding": "DB", "database_name": "flue", "database_id": "local", "migrations_dir": "migrations" }
  ]
}
```
(`database_id: "local"` is a placeholder for dev; the real id is filled at deploy time — Task 12 documents `wrangler d1 create`.)

`app/vite.config.ts` — the mandatory plugin order:
```ts
import { defineConfig } from 'vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import { cloudflare } from '@cloudflare/vite-plugin'
import viteReact from '@vitejs/plugin-react'

export default defineConfig({
  resolve: { tsconfigPaths: true },
  plugins: [
    cloudflare({ viteEnvironment: { name: 'ssr' } }),
    tanstackStart(),
    viteReact(),
  ],
})
```

`app/vitest.config.ts`:
```ts
import { cloudflareTest } from '@cloudflare/vitest-pool-workers'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: './wrangler.jsonc' } })],
})
```

`app/src/start.ts` — global middleware seam (empty CSRF-only for now; Task 4 adds the auth middleware):
```ts
import { createStart, createCsrfMiddleware } from '@tanstack/react-start'

const csrf = createCsrfMiddleware()

export const startInstance = createStart(() => ({
  requestMiddleware: [csrf],
}))
```

`app/package.json` scripts: `"dev": "vite dev --port 3001"`, `"build": "vite build"`, `"test": "vitest run"`, `"lint": "tsc --noEmit"`, `"db:generate": "drizzle-kit generate"`, `"db:migrate:local": "wrangler d1 migrations apply flue --local"`. `packageManager: "pnpm@11.9.0"`. `pnpm.onlyBuiltDependencies: ["workerd"]`.

- [ ] **Step 1: Scaffold** the files above; `cd app && pnpm install`.
- [ ] **Step 2: Write the smoke test.**
```ts
// app/test/smoke.test.ts
import { SELF } from 'cloudflare:test'
import { expect, it } from 'vitest'

it('serves the index route', async () => {
  const res = await SELF.fetch('https://app.flue.sh/')
  expect(res.status).toBe(200)
  expect(await res.text()).toContain('flue')
})
```
(If the pool cannot run a full Start SSR app under `SELF` — a documented rough edge — fall back to asserting the router builds and the index route matches, the way `web/src/router.test.tsx` does, and note it in the report. The point of this task is a package that builds, type-checks, and has a green test harness, not SSR-under-pool.)
- [ ] **Step 3: Run to verify it fails** (`cd app && pnpm test`), implement the index route, re-run: green.
- [ ] **Step 4: Wire the Makefile + CI** (mirror the `relay` targets exactly: `app` install target, `test-app`, `lint` extended). `make lint` and `make test` must reach the app.
- [ ] **Step 5: Commit.** `git commit -m "feat(app): scaffold the flue.sh control plane — tanstack start on workers"`

### Task 2: The database schema and migrations

**Files:**
- Create: `app/src/db/schema.ts`, `app/src/db/client.ts`, `app/drizzle.config.ts`
- Create: `app/migrations/` (generated), `app/test/schema.test.ts`, `app/test/apply-migrations.ts` (setup helper)

**Interfaces (Produces):**
```ts
// app/src/db/schema.ts — Drizzle sqlite tables
export const users = sqliteTable('users', {
  id: text('id').primaryKey(),                 // ULID/uuid
  email: text('email').notNull().unique(),     // normalized lowercase
  createdAt: integer('created_at').notNull(),   // unix seconds
  disabled: integer('disabled', { mode: 'boolean' }).notNull().default(false), // kill switch
})
export const invites = sqliteTable('invites', {
  code: text('code').primaryKey(),              // the invite token
  email: text('email'),                          // optional: bind an invite to an email
  createdAt: integer('created_at').notNull(),
  redeemedBy: text('redeemed_by'),               // users.id once used
  redeemedAt: integer('redeemed_at'),
})
export const loginCodes = sqliteTable('login_codes', {
  id: text('id').primaryKey(),
  email: text('email').notNull(),
  codeHash: text('code_hash').notNull(),         // HMAC-SHA-256(code), hex
  expiresAt: integer('expires_at').notNull(),
  attempts: integer('attempts').notNull().default(0),
  createdAt: integer('created_at').notNull(),
})
export const sessions = sqliteTable('sessions', {
  id: text('id').primaryKey(),                   // SHA-256(token), hex — the token is never stored
  userId: text('user_id').notNull(),
  createdAt: integer('created_at').notNull(),
  expiresAt: integer('expires_at').notNull(),
})
export const devices = sqliteTable('devices', {
  id: text('id').primaryKey(),                   // device id (matches the daemon's crypto.DeviceID shape)
  userId: text('user_id').notNull(),
  label: text('label').notNull(),
  publicKey: text('public_key').notNull(),       // daemon Noise static pubkey, base64
  tokenHash: text('token_hash').notNull(),       // SHA-256(device enrollment token), hex
  createdAt: integer('created_at').notNull(),
  lastSeen: integer('last_seen'),
  disabled: integer('disabled', { mode: 'boolean' }).notNull().default(false),
})
export const deviceAuth = sqliteTable('device_auth', {
  userCode: text('user_code').primaryKey(),      // short code shown by `flue enable`; normalize case/format before lookup (human-typed)
  deviceCode: text('device_code').notNull(),     // SHA-256(device_code) — the daemon polls with the raw code; hash on write AND on lookup (a D1 dump inside the ~15-min window otherwise lets a reader poll a pending grant and steal the approved token)
  createdAt: integer('created_at').notNull(),
  expiresAt: integer('expires_at').notNull(),
  approvedUserId: text('approved_user_id'),       // set when the logged-in user confirms
  deviceId: text('device_id'),                    // set on approval
  publicKey: text('public_key'),                  // the daemon's pubkey, submitted at start
})
```
```ts
// app/src/db/client.ts
import { drizzle } from 'drizzle-orm/d1'
import { env } from 'cloudflare:workers'
import * as schema from './schema'
export function db() { return drizzle(env.DB, { schema }) } // call inside a request handler only
```

- [ ] **Step 1: Write `schema.ts` + `client.ts` + `drizzle.config.ts`** (d1 dialect, `driver: 'd1-http'`, schema/out paths).
- [ ] **Step 2: Generate the migration.** Run `cd app && pnpm db:generate` → produces `migrations/0000_*.sql`. Commit the generated SQL.
- [ ] **Step 3: Write the migration-apply test helper + a schema test.**
```ts
// app/test/apply-migrations.ts
import { applyD1Migrations, env } from 'cloudflare:test'
import { readD1Migrations } from '@cloudflare/vitest-pool-workers/config'
// In a setup file per the pool docs: read ./migrations and applyD1Migrations(env.DB, ...)
```
```ts
// app/test/schema.test.ts
import { env } from 'cloudflare:test'
import { expect, it } from 'vitest'
it('has the users table after migrations', async () => {
  await env.DB.prepare("INSERT INTO users (id,email,created_at,disabled) VALUES (?,?,?,0)")
    .bind('u1', 'a@b.com', 1).run()
  const row = await env.DB.prepare('SELECT email FROM users WHERE id=?').bind('u1').first()
  expect(row?.email).toBe('a@b.com')
})
```
Wire `applyD1Migrations` in a setup file referenced from `vitest.config.ts` (`miniflare.d1Databases` + a `setupFiles` entry per the pool docs).
- [ ] **Step 4: Run** `cd app && pnpm test` — green (migrations apply, insert/select works).
- [ ] **Step 5: Commit.** `git commit -m "feat(app): d1 schema and migrations for accounts, sessions, devices"`

### Task 3: Email-code issue/verify + the sender seam

**Files:**
- Create: `app/src/server/email/sender.ts`, `app/src/server/codes.ts`, `app/src/lib/tokens.ts` (the parts codes needs), `app/test/codes.test.ts`

**Interfaces (Produces):**
```ts
// app/src/server/email/sender.ts
export interface Sender { sendLoginCode(email: string, code: string): Promise<void> }
// Placeholder: logs the code. THE ONLY implementation this plan ships.
export class LogSender implements Sender {
  async sendLoginCode(email: string, code: string) {
    console.log(JSON.stringify({ evt: 'login_code', email, code })) // dev-only; a real Sender lands later
  }
}
export function sender(): Sender { return new LogSender() } // swap here when email is built
```
```ts
// app/src/server/codes.ts
// issueLoginCode: generate an 8-digit CSPRNG code, HMAC-hash it, store with 10-min TTL,
// invalidate any prior code for that email, hand the plaintext to the Sender. Returns nothing
// the caller can use to learn whether the email exists (anti-enumeration is the caller's job too).
export async function issueLoginCode(email: string): Promise<void>
// verifyLoginCode: constant-time compare against the stored HMAC, enforce TTL + attempt cap (5),
// single-use (delete on success). Returns the normalized email on success, null on any failure.
// Increments attempts on a wrong code; deletes the row on cap or success.
export async function verifyLoginCode(email: string, code: string): Promise<{ ok: true; email: string } | { ok: false }>
```
```ts
// app/src/lib/tokens.ts (partial — completed in Task 7)
export function randomCode8(): string      // 8 decimal digits, crypto.getRandomValues, no modulo bias
export async function hmacHex(secret: string, msg: string): Promise<string>  // HMAC-SHA-256 → hex
export function timingSafeEqual(a: string, b: string): boolean               // length-independent
export function base64url(bytes: Uint8Array): string
```

**Behavior:**
- `randomCode8`: draw a `Uint32Array(1)`, reject-sample to avoid modulo bias over `10^8`, left-pad to 8 digits. (Rejection: redraw while value ≥ `Math.floor(2**32 / 1e8) * 1e8`.)
- `issueLoginCode(email)`: normalize email (trim, lowercase). `db().batch([deletePriorCodesForEmail, insertNewCode])`. Hash with `hmacHex(env.CODE_HMAC_SECRET, code)`. Never log the code except through `LogSender`. TTL = now + 600s.
- `verifyLoginCode`: load the row; if none / expired / attempts ≥ 5 → return `{ok:false}` (and delete an over-cap row). Compare `hmacHex(secret, submitted)` to `codeHash` via `timingSafeEqual`. On match → delete the row, return `{ok:true, email}`. On miss → increment attempts, `{ok:false}`.

- [ ] **Step 1: Failing tests.** `randomCode8` is 8 digits and uses the crypto path (stub `crypto.getRandomValues` to prove rejection-sampling drops a biased draw); `issueLoginCode` writes exactly one row and invalidates a prior; `verifyLoginCode` accepts the right code once, rejects a reuse, rejects after 5 wrong attempts, rejects past TTL; a wrong code increments attempts; the stored hash is never the plaintext. Use the real local D1 (pool) + `CODE_HMAC_SECRET` bound in `vitest.config.ts`.
- [ ] **Step 2: Run to verify failure, implement, re-run** — green.
- [ ] **Step 3: Commit.** `git commit -m "feat(app): email login codes with a placeholder sender seam"`

### Task 4: Sessions + the auth-guard middleware

**Files:**
- Create: `app/src/server/sessions.ts`, `app/src/server/auth.ts`, `app/test/sessions.test.ts`
- Modify: `app/src/start.ts` (register the auth request-middleware globally, after CSRF)

**Interfaces (Produces):**
```ts
// app/src/server/sessions.ts
export const SESSION_COOKIE = '__Host-session'
export const SESSION_TTL_S = 8 * 60 * 60
// createSession: mint a 32-byte token, store SHA-256(token) in D1, set the __Host cookie, return the token.
export async function createSession(userId: string): Promise<void>  // sets the cookie via setCookie
// currentUser: read the cookie, hash it, look up an unexpired session, return the user or null.
export async function currentUser(): Promise<{ id: string; email: string } | null>
// destroySession: delete the row for the current cookie and clear the cookie.
export async function destroySession(): Promise<void>
```
```ts
// app/src/server/auth.ts
import { createMiddleware } from '@tanstack/react-start'
// requireUser: a function-middleware that loads currentUser(), throws redirect({to:'/login'}) when
// absent, and passes { user } in context. Protected server fns compose it via .middleware([requireUser]).
export const requireUser = createMiddleware({ type: 'function' }).server(async ({ next }) => {
  const user = await currentUser()
  if (!user) throw redirect({ to: '/login' })
  return next({ context: { user } })
})
```

**Behavior:**
- `createSession`: `token = base64url(random 32 bytes)`; `id = SHA-256(token) hex`; insert `{id, userId, createdAt, expiresAt: now+TTL}`; `setCookie(SESSION_COOKIE, token, { httpOnly: true, secure: true, sameSite: 'Lax', path: '/', maxAge: SESSION_TTL_S })`. Called only after a verified login (Task 5 wires it).
- `currentUser`: `getCookie(SESSION_COOKIE)`; if absent → null; hash, look up a row with `expiresAt > now`; join `users`; if the user is `disabled` → null (kill switch reaches live sessions). Return `{id,email}`.
- `destroySession`: delete the row, `deleteCookie(SESSION_COOKIE, {path:'/'})`.
- Rotate on login: Task 5's login handler calls `destroySession()` (if any) then `createSession()` — never reuse a pre-login session id.

- [ ] **Step 1: Failing tests.** create→currentUser round-trip (cookie set with the exact `__Host-session` name + flags — assert the `Set-Cookie` string contains `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`); an expired session returns null; a `disabled` user returns null; destroy clears it; the raw token is never stored (only its hash). Drive via a server-fn or a direct call inside a request context the pool provides (use `SELF.fetch` against a tiny test route that calls these, or the request-context helper the pool exposes).
- [ ] **Step 2: Run to verify failure, implement, re-run** — green.
- [ ] **Step 3: Register `requireUser`** conceptually (a protected test route rejects when no cookie, accepts with one).
- [ ] **Step 4: Commit.** `git commit -m "feat(app): db-backed sessions and the auth-guard middleware"`

### Task 5: The login flow + invite gate

**Files:**
- Create: `app/src/server/invites.ts`, `app/src/routes/login.tsx`, `app/test/login.test.ts`, `app/test/invites.test.ts`
- Server fns: `requestCode`, `submitCode` (in `login.tsx` or a `server/login.ts` module)

**Interfaces (Produces):**
```ts
// app/src/server/invites.ts
// consumeInvite: mark an invite redeemed by a user, atomically (fails if already redeemed or unknown).
export async function consumeInvite(code: string, userId: string): Promise<boolean>
// hasUnredeemedInvite / inviteFor(email): gate helpers.
```
Server fns (POST):
- `requestCode({ email })` → always returns `{ ok: true }` (anti-enumeration): normalize email; issue a code via `issueLoginCode`; **but** only actually issue for an email that either already has a user OR has an unredeemed invite — otherwise do the same work (dummy HMAC to equalize timing) and send nothing. Never reveal which branch ran.
- `submitCode({ email, code, invite? })` → verify the code; on success: find-or-create the user (creating requires a valid unredeemed invite — `consumeInvite` in the same `batch` as the user insert; if the user exists, ignore invite); rotate + create the session; return `{ ok: true }`. On failure `{ ok: false }` with no detail.

**Behavior:**
- Invite gate: a brand-new email cannot get a session without an invite. An existing user needs no invite. Account creation + invite consumption are one `db.batch` (D1 has no interactive transactions) so a crash can't create a user without burning the invite or vice-versa.
- The login route: an email field → "we sent you a code if you have access" (same copy regardless) → a code field → on success redirect to `/devices`.

- [ ] **Step 1: Failing tests.** `requestCode` for an unknown, un-invited email returns `{ok:true}` and sends nothing (assert the LogSender was not called) while an invited email does send; `submitCode` with a valid code + valid invite creates the user, consumes the invite (a second signup on the same invite fails), and sets a session; an existing user logs in with no invite; a wrong code never creates a user; timing is equalized enough that the enumeration test asserts the same response shape both ways. Use pool + D1; inject a spy Sender.
- [ ] **Step 2: Run to verify failure, implement, re-run** — green.
- [ ] **Step 3: The login UI** (`login.tsx`) — two-step form, `useServerFn`, plain-voice copy; a component test that the form renders and calls the server fn.
- [ ] **Step 4: Commit.** `git commit -m "feat(app): invite-gated email-code login"`

### Task 6: Device-authorization enrollment (control-plane half)

**Files:**
- Create: `app/src/server/enroll.ts`, `app/src/routes/enroll.tsx`, `app/test/enroll.test.ts`
- Server fns: `startDeviceAuth` (unauthenticated, called by the daemon), `pollDeviceAuth` (unauthenticated, daemon polls), `confirmDeviceAuth` (authenticated, the logged-in user confirms)

**Interfaces (Produces):**
```ts
// app/src/server/enroll.ts
// startDeviceAuth: the daemon submits its label + Noise public key; we mint a user_code (short,
// human-typable, e.g. 6 chars from an unambiguous alphabet) and a device_code (opaque 32B); store a
// row with a 10-min TTL; return { userCode, deviceCode, verificationUrl, expiresIn }.
export async function startDeviceAuth(input: { label: string; publicKey: string }): Promise<{...}>
// pollDeviceAuth: the daemon polls with its device_code; returns 'pending' | 'expired' |
// { status:'approved', deviceId, deviceToken } exactly once (the token is minted at approval,
// its hash stored on the device row, and returned to the daemon on the first approved poll only).
export async function pollDeviceAuth(input: { deviceCode: string }): Promise<...>
// confirmDeviceAuth: the logged-in user confirms a user_code they typed/saw; creates the device row
// (id derived from the public key the same way crypto.DeviceID does — 12 lowercase hex), mints the
// device enrollment token, marks the device_auth row approved. Requires requireUser.
export async function confirmDeviceAuth(input: { userCode: string }): Promise<{ deviceId: string; label: string }>
```

**Behavior:**
- The device id **must match the daemon's `crypto.DeviceID`** — `hex.EncodeToString(sha256(pubkey))[:12]` (12 lowercase-hex chars; read `internal/crypto/devices.go` `DeviceID` and reproduce it exactly in TS, pinned by a shared test vector). Otherwise the relay's account-scoping and the daemon's own device identity disagree.
- **`device_code` is stored hashed** (`SHA-256`, per the schema): `startDeviceAuth` stores `sha256(deviceCode)`, and `pollDeviceAuth` looks up by `sha256(submitted)`. The daemon holds the raw code; the DB never does.
- **The enrollment-token lifecycle is dictated by the schema** (`devices.tokenHash` is NOT NULL and `device_auth` has no column to carry a raw token between requests — by design): so the token is minted on the **approving poll**, not at confirm. Concretely: `confirmDeviceAuth` only sets `approvedUserId` + `deviceId` on the `device_auth` row (it does NOT create the device yet); the first `pollDeviceAuth` that sees an approved row mints the 32-byte base64url token, and in **one `db.batch([...])`** inserts the `devices` row (with `tokenHash = sha256(token)`) and deletes the `device_auth` grant, then returns the raw token to the daemon exactly once. A subsequent poll finds neither a pending nor an approved grant (it was burned) — treat "grant gone but device exists for this deviceCode's derived id" as already-approved-without-token, or simpler: the daemon stops polling once it has the token, so a second approved poll is not expected; return `expired`/`{status:'approved'}` without a token defensively.
- **`devices.id` is a content-derived primary key** (`sha256(pubkey)[:12]`), so a daemon **re-enrolling** after a revoke, or the same key enrolled twice, collides on the PK. The mint-on-poll batch must therefore **delete-then-insert** (or upsert) the `devices` row for that id rather than a bare insert — a re-enroll replaces the prior row (new token, new `userId`). State this in the implementation.
- `confirmDeviceAuth` binds the device to `context.user.id`. Approval is idempotent-safe (a second confirm of the same still-pending code is a no-op).

- [ ] **Step 1: Failing tests.** start→poll(pending)→confirm→poll(approved with token)→poll(approved without token); an expired row polls `expired`; confirm requires a session (unauth throws); the derived `deviceId` matches a known vector from the Go side; the token hash is stored, never the token. Add a cross-language vector: a fixed pubkey → the exact 12-hex id the Go `DeviceID` yields (compute it once from Go, pin it in `app/test/`).
- [ ] **Step 2: Run to verify failure, implement, re-run** — green.
- [ ] **Step 3: The confirm UI** (`enroll.tsx`, behind `requireUser`) — the user types/reviews the code shown by `flue enable`, confirms, sees the device appear; component test.
- [ ] **Step 4: Commit.** `git commit -m "feat(app): device-authorization enrollment flow"`

### Task 7: Signed channel tokens (control-plane mint)

**Files:**
- Modify: `app/src/lib/tokens.ts` (complete it)
- Create: `app/src/server/channel-token.ts`, `app/test/channel-token.test.ts`

**Interfaces (Produces):**
```ts
// app/src/lib/tokens.ts (completed)
// A channel token is a compact signed statement the relay verifies offline. Format:
//   base64url(JSON payload) + "." + base64url(HMAC-SHA-256(RELAY_SIGNING_SECRET, payloadPart))
// payload = { acc: string, dev: string, role: 'daemon'|'client', exp: number /* unix s */ }
export async function signChannelToken(secret: string, p: ChannelClaims): Promise<string>
export async function verifyChannelToken(secret: string, token: string): Promise<ChannelClaims | null> // null on bad sig / expired / malformed
export interface ChannelClaims { acc: string; dev: string; role: 'daemon' | 'client'; exp: number }
```
```ts
// app/src/server/channel-token.ts
// mintClientToken: for the logged-in user + a device they own, a short-lived (60s) client channel token.
export async function mintClientToken(deviceId: string): Promise<{ token: string; relayUrl: string }>  // requires requireUser
// mintDaemonToken: for a daemon presenting a valid enrollment token, a short-lived daemon channel token.
export async function mintDaemonToken(deviceId: string, enrollmentToken: string): Promise<{ token: string; relayUrl: string } | null>
```

**Behavior:**
- The token is deliberately **not** a full JWT — one HMAC line, minimal claims, verified with `RELAY_SIGNING_SECRET` shared with the relay. Short TTL (client 60s, daemon 300s) bounds replay; the relay checks `exp` and nothing else stateful.
- `mintClientToken`: `requireUser`; confirm `deviceId` belongs to `user.id` and neither the user nor the device is `disabled` (kill switch); sign `{acc:user.id, dev:deviceId, role:'client', exp:now+60}`. Returns the relay URL (`wss://relay.flue.sh`) too.
- `mintDaemonToken`: verify the enrollment token's hash matches the device row and the device is enabled; sign `{acc, dev, role:'daemon', exp:now+300}`.
- `verifyChannelToken`: split on `.`, recompute the HMAC over the payload part, `timingSafeEqual`, parse JSON, check `exp > now`. Any failure → null. **This exact function is reproduced in the relay (Task 9) and pinned by a shared vector** so the two agree byte-for-byte.

- [ ] **Step 1: Failing tests.** sign→verify round-trip for both roles; a tampered payload fails; an expired token fails; a wrong secret fails; `mintClientToken` refuses a device the user doesn't own and a disabled device/user; `mintDaemonToken` refuses a bad enrollment token. Pin a fixed `{secret, claims}` → exact token string vector (the relay's test will assert the same bytes).
- [ ] **Step 2: Run to verify failure, implement, re-run** — green.
- [ ] **Step 3: Commit.** `git commit -m "feat(app): hmac-signed relay channel tokens"`

### Task 8: The device directory

**Files:**
- Create: `app/src/server/devices.ts`, `app/src/routes/devices.tsx`, `app/test/devices.test.ts`

**Interfaces (Produces):**
```ts
// app/src/server/devices.ts
export async function listDevices(): Promise<Array<{ id: string; label: string; lastSeen: number | null; disabled: boolean }>> // requireUser, scoped to user
export async function revokeDevice(deviceId: string): Promise<void>  // requireUser; deletes the device row (relay stops minting/accepting its tokens)
export async function renameDevice(deviceId: string, label: string): Promise<void>
```

**Behavior:**
- `listDevices`: `requireUser`; `where userId = user.id`. This is the "one login, all your machines" surface.
- `revokeDevice`: confirm ownership, delete the device row (and any live channel token becomes unmintable; the relay rejects a token whose device no longer resolves — Task 9's account-scoped hub keys on device id, and a revoked device's daemon token stops being mintable, so it drops on its next reconnect). Log the revoke.
- The screen: each device row → label, last-seen (relative), an "Open a session" affordance (mints a client token via `mintClientToken` and navigates the browser to the relay origin with the token), and revoke/rename.
- **Opening a session** is where the control plane hands off to the relay: the browser gets a client channel token + the relay URL, then connects to `wss://relay.flue.sh/client?...` carrying the token — the web relay client (Plan 1's `RelaySocket`) already does the Noise handshake; the only new thing is presenting the token on the upgrade. (The token goes in a `Sec-WebSocket-Protocol` header or a query param the relay reads — Task 9 fixes which; the browser client passes it through.)

- [ ] **Step 1: Failing tests.** `listDevices` returns only the user's devices; `revokeDevice` refuses a device the user doesn't own and removes an owned one; rename works. Component test: the devices screen renders rows and the Open/Revoke controls.
- [ ] **Step 2: Run to verify failure, implement, re-run** — green.
- [ ] **Step 3: Commit.** `git commit -m "feat(app): device directory — one login, all your machines"`

### Task 9: The relay's SaaS auth mode

**Files:**
- Create: `relay/src/channel-auth.ts` (the `verifyChannelToken` port + the mode selector)
- Modify: `relay/src/index.ts` (`authorizeDaemon`/`authorizeClient`/`hubIdFor`), `relay/wrangler.jsonc` (add `RELAY_SIGNING_SECRET` as a secret — documented, not in the file), `relay/test/saas-auth.test.ts`

**Interfaces (Produces):**
- `relay/src/channel-auth.ts`: `verifyChannelToken(secret, token)` — a **byte-for-byte port** of `app/src/lib/tokens.ts`'s verifier, pinned by the shared vector from Task 7 (copy the vector into `relay/test/`).
- The mode selector: SaaS mode is active iff `env.RELAY_SIGNING_SECRET` is set; else self-host mode (Plan 1 behavior, `env.DAEMON_SECRET`). Both can be compiled in; the env decides.

**Behavior (SaaS mode only — self-host paths are untouched and must stay green):**
- `authorizeClient(req, env)`: in SaaS mode, read the channel token (from the query param `?t=` or the `Sec-Fetch`/subprotocol — pick the query param for simplicity and to match how the browser presents it; document it in `spec/relay-protocol.md`), `verifyChannelToken(env.RELAY_SIGNING_SECRET, t)`, require `role==='client'`. Stash the verified `{acc, dev}` for `hubIdFor`. Reject (401) on null.
- `authorizeDaemon(req, env)`: in SaaS mode, verify a `role==='daemon'` token from the `Authorization: Bearer` header; require it. (Self-host mode keeps the shared `DAEMON_SECRET` compare.)
- `hubIdFor(req, env)`: in SaaS mode, `env.HUB.idFromName(\`${acc}:${dev}\`)` — one hub per account+device, so a browser and a daemon only ever meet if their tokens carry the same `acc` and `dev`. Cross-account or cross-device tokens land on different hubs and never bridge. (Self-host: the single `'hub'` name.)
- Because `authorizeClient` and `authorizeDaemon` run per-request and `fetch` needs the verified claims for `hubIdFor`, refactor so the authorize step returns the claims (or null) and `fetch` threads them to `hubIdFor` — a small signature change local to `index.ts`, keeping the seam shape.
- **The relay never calls the control plane.** It holds only `RELAY_SIGNING_SECRET`. A revoked device stops getting fresh tokens from the control plane; its last token expires within 60/300s; the hub keying means it can never reach another account's daemon.

- [ ] **Step 1: Failing tests** (`relay/test/saas-auth.test.ts`, SaaS mode via `RELAY_SIGNING_SECRET` bound in a second vitest project/config): a valid client token opens `/client` and lands on the `acc:dev` hub; a daemon token opens `/daemon` on the same hub; a client token and a daemon token with the same `acc:dev` bridge; different `acc` → different hubs, never bridge; a forged/expired/wrong-role token → 401; the shared vector from Task 7 verifies identically here. **Also:** the Plan 1 self-host suite still passes unchanged (no `RELAY_SIGNING_SECRET` bound → self-host mode).
- [ ] **Step 2: Run to verify failure, implement, re-run** — `cd relay && pnpm test` green (both modes).
- [ ] **Step 3: Update `spec/relay-protocol.md`** with the SaaS auth mode (token in `?t=` on `/client`, bearer daemon token, `acc:dev` hub keying, offline verification, self-host vs SaaS selected by env).
- [ ] **Step 4: Commit.** `git commit -m "feat(relay): saas auth mode — verify signed channel tokens, account-scoped hubs"`

### Task 10: Rate limits, kill switch, ToS

**Files:**
- Create: `app/src/server/ratelimit.ts`, `app/src/routes/terms.tsx`, `app/test/ratelimit.test.ts`
- Modify: the send/verify server fns (Task 3/5) to enforce caps; `app/src/server/sessions.ts` + `channel-token.ts` (kill switch already threaded via `disabled` — verify)

**Behavior:**
- **Rate limits** in D1 (the Workers rate-limit binding is per-colo and inexact — use it only as a coarse optional shield; the real caps are D1 columns): per-email login-code sends capped (e.g. 5 / 15 min), per-IP send capped, verify attempts already capped per code (Task 3). A small `rate_events` table or a counter column; delete/expire old windows.
- **Kill switch:** setting `users.disabled` or `devices.disabled` must (a) block new logins/token mints (Task 5/7 check it — verify), (b) drop live sessions (`currentUser` returns null for a disabled user — Task 4 already does this, verify), and (c) stop channel-token minting for a disabled device (Task 7 checks it — verify). Add a tiny admin-only path or a documented `wrangler d1 execute` recipe to flip the flag (no admin UI in scope).
- **ToS:** a `/terms` route with placeholder terms text (a shell relay is dual-use — the terms state acceptable use, the kill switch, and the abuse-report contact). Link it from login.

- [ ] **Step 1: Failing tests.** exceeding the per-email send cap returns the same `{ok:true}` shell but sends nothing / errors internally without leaking; a disabled user's `currentUser` is null and `mintClientToken` refuses; a disabled device can't get a client token. ToS route renders.
- [ ] **Step 2: Run to verify failure, implement, re-run** — green.
- [ ] **Step 3: Commit.** `git commit -m "feat(app): rate limits, account/device kill switch, terms"`

### Task 11: The daemon's `flue enable` (device-authorization, Go side)

**Files:**
- Create: `cmd/flue/saas.go` (or extend `cmd/flue/enable.go` — read what exists first; Plan 1 has `flue enable` for the login service, so name this distinctly, e.g. `flue link` or a `--saas` flag; decide and keep the CLI coherent)
- Modify: `internal/config/relay.go` (store the account/device enrollment token + hosted relay URL alongside the self-host fields), `cmd/flue/main.go` (routing + usage), the relay dial path (`internal/transport/relay`) to present a SaaS daemon token instead of the shared secret when configured
- Test: `cmd/flue/saas_test.go`

**Behavior:**
- `flue link` (name TBD): POST `startDeviceAuth` to `https://app.flue.sh` with the daemon's label + Noise public key → print the `userCode` and the verification URL ("open app.flue.sh/enroll and enter ABC-123") → poll `pollDeviceAuth` every few seconds until `approved` → store the returned `deviceToken` + relay URL in `relay.json` (new SaaS fields) → tell the user to restart / the relay transport picks it up.
- The relay dial path: when SaaS fields are present, before dialing, the daemon mints a **daemon channel token** — but the control plane mints those (Task 7 `mintDaemonToken`), so the daemon calls a control-plane endpoint with its enrollment token to get a short-lived channel token, then dials the relay with it as the bearer. (Alternatively the daemon holds `RELAY_SIGNING_SECRET`? No — the daemon must NOT hold the shared secret; it holds the enrollment token and asks the control plane for channel tokens. This keeps the signing secret to the two Workers.) So the Go adapter gains: "refresh a daemon channel token from the control plane when the current one is near expiry."
- Reuse Plan 1's `internal/cloudflare`? No — this talks to flue.sh, not the CF API. A small HTTP client for the control-plane endpoints.
- Enrollment token + tokens never logged.

- [ ] **Step 1: Failing test** against a fake control-plane `httptest` server: `flue link` posts start, prints the user code, polls, stores the token + relay URL on approval; the token appears in no output/file-other-than-relay.json; the dial path mints/refreshes a channel token and presents it as the bearer.
- [ ] **Step 2: Run to verify failure, implement, re-run** — `go test ./...` green.
- [ ] **Step 3: Commit.** `git commit -m "feat(flue): link a machine to a flue.sh account (device authorization)"`

### Task 12: Deploy, wiring, and docs

**Files:**
- Create: `docs/SAAS.md`
- Modify: `docs/faq.md` (the SaaS answers are now real, not forward-looking — reconcile), `README.md` (flue.sh section), `app/wrangler.jsonc` (custom domain route), `relay/wrangler.jsonc` (custom domain route)

**Behavior:**
- `docs/SAAS.md`: the operator runbook — `wrangler d1 create flue`, apply migrations, set `CODE_HMAC_SECRET` + `RELAY_SIGNING_SECRET` (the same value on both Workers), deploy `app` to `app.flue.sh` and `relay` to `relay.flue.sh` (custom-domain routes), seed the first invite (`wrangler d1 execute`), the kill-switch recipe, and the still-placeholder email (the one thing left: wire a real `Sender`).
- The custom-domain routes in both wrangler configs (`"routes": [{ "pattern": "app.flue.sh", "custom_domain": true }]` / `relay.flue.sh`).
- FAQ reconciliation: "What does flue.sh store?" is now answerable precisely (the schema); keep the served-code MITM disclosure (Plan 1 §11) — the SaaS is exactly the case where the user trusts flue.sh to serve honest JS; state it plainly.
- README: the flue.sh path (request an invite → sign in → `flue link` → open a session) beside the self-host path.

- [ ] **Step 1: Write the docs + the route config.**
- [ ] **Step 2: Verify** the full gate: `cd app && pnpm test && pnpm build`, `cd relay && pnpm test`, `go test ./...`. Note the manual deploy E2E as a human release gate in SAAS.md (real `wrangler deploy` of both Workers + a real `flue link` against them — never run in CI).
- [ ] **Step 3: Update `docs/FOLLOW-UPS.md`** — mark the Plan-1 SaaS carry-forwards this plan resolves (§11 disclosure now in the SaaS FAQ; the relay CSP; the signed-token seam) and add anything new (per-session output rate cap still open; real email delivery is the user's remaining task; the per-channel-credit outbox fix (§10) becomes load-bearing now that the relay is multi-tenant — flag it for the next scale pass).
- [ ] **Step 4: Commit.** `git commit -m "docs: flue.sh operator runbook, custom domains, faq reconciliation"`

### Task 13: Surface relay setup + status in the daemon's `web/` dashboard

Today the daemon's own web UI (`web/`, served on loopback) has no visible relay story — `flue relay setup` is CLI-only and relay status lives only in the `Welcome.relay` field the client already receives (Plan 1, Task 9/12). Make remote access a first-class screen in the daemon dashboard: show whether a relay is configured/connecting/connected, its origin, and guide the user to set one up (or link an account). This is the daemon-side counterpart to the flue.sh device directory — a self-hoster or a soon-to-be-SaaS user manages remote access from the dashboard, not only the terminal.

**Files:**
- Create: `web/src/routes/remote.tsx` (a "Remote access" screen), and a nav entry for it (read `web/src/components/nav.tsx`)
- Modify: `web/src/client/client.ts` if the relay status it exposes (`onWelcome`/`relay` getter from Plan 1 Task 12) needs anything more for this screen (read it first — it likely already suffices)
- Test: `web/src/routes/remote.test.tsx`

**Behavior:**
- The screen reads `client.relay` (`{status:'off'|'connecting'|'connected', origin?}`) and renders, with shadcn:
  - **Not configured** (`off`): an `Empty`/`Card` explaining remote access, a `Button` to run setup. Since the browser can't run `flue relay setup` (it's a daemon CLI command), the primary affordance is instructions + a copy-able command (`flue relay setup`) and, forward-looking, a "Connect to flue.sh" path (link to the account flow — wired in the SaaS phase). Use the harness note in CLAUDE.md: the daemon can't be driven from the browser to run a CLI, so this screen *guides* rather than *executes*.
  - **Connecting:** a `Badge` + spinner, the configured relay URL.
  - **Connected:** a `Badge` (success) + the origin, a note that devices can now be paired against this address (this is where the Pair-gating from Plan 1 Task 12 becomes reachable), and — forward-looking — a link into the flue.sh device directory when the daemon is account-linked.
- Re-evaluate on every `onWelcome` (reconnects change status), the same pattern `devices.tsx` uses for Pair gating.
- Run `/design` conventions and shadcn; match the existing `web/` app-shell look (the sidebar redesign already shipped).

- [ ] **Step 1: Failing tests.** `remote.test.tsx`: with a welcome `status:'off'` → the setup-guidance card + the `flue relay setup` command are on screen; `status:'connected'` with an origin → the connected badge + origin render; the screen re-evaluates when a second welcome flips the status; a nav entry routes to `/remote` (extend `router.test.tsx`'s nav-matches-every-path check). Use the route tests' existing fake-client harness.
- [ ] **Step 2: Run to verify failure, implement with shadcn components, re-run.** `cd web && pnpm test` (only the pre-existing 55 fail) + `pnpm lint` + `pnpm build`.
- [ ] **Step 3: Commit.** `git commit -m "feat(web): a remote-access screen showing relay setup and status"`

### Task 14: `/design` polish pass over all control-plane + relay screens

A controller-driven pass (not a fresh-subagent task in the usual sense — the controller runs the `/design` skill over the built screens). Take every screen built in Tasks 5, 6, 8, 10 (`login`, `enroll`, `devices`, `terms`) plus the daemon `web/` `remote` screen (Task 13), and refine to a genuinely polished bar: consistent spacing and typography, proper empty/loading/error/skeleton states, responsive (mobile + desktop) layouts, shadcn `Sonner` toasts for actions (code sent, device revoked, session opened), accessible focus/aria, and a coherent visual identity shared between `app.flue.sh` and the daemon dashboard. Verify against desktop and mobile breakpoints. Keep all behavior and tests green; this pass changes presentation, not logic.

- [ ] **Step 1:** Run `/design` over each screen; apply shadcn refinements.
- [ ] **Step 2:** Verify `cd app && pnpm test && pnpm build` and `cd web && pnpm test && pnpm build` green; check desktop + mobile.
- [ ] **Step 3: Commit.** `git commit -m "design: polish the control-plane and remote-access screens"`

### Task 15: The SaaS browser-session path (per-device key pinning + token refresh)

Tasks 8–9 built the pieces of opening a session (mint a client token, navigate to the relay with it in the fragment, the relay verifies it and routes an account-scoped hub), but three gaps (tracked in `docs/FOLLOW-UPS.md` item 14) make a SaaS browser session not yet functional for a real multi-machine account. This task closes them so "click a device → get a terminal" actually works over the hosted relay.

**The core problem:** the daemon's Noise handshake pins the *daemon's static public key*, and the browser's crypto store (`web/src/crypto/keys.ts` `savePinnedDaemonKey`/`loadPinnedDaemonKey`) holds **one** pinned key per origin. A SaaS relay is one origin (`relay.flue.sh`) for every machine on every account, so opening device B's session builds the IK initiator against device A's pinned key and the handshake fails silently. The control plane already stores each device's public key (`devices.publicKey`), so the fix is to carry the *target device's* public key to the browser at open-a-session and pin per-device.

**Files:**
- Modify: `app/src/server/channel-token.ts` (`mintClientToken` also returns the device's `publicKey`), `app/src/server/devices.ts` (`openSession` puts the pubkey in the fragment alongside the token), `app/src/routes/devices.tsx`
- Create: `app/src/server/refresh-token.ts` (or extend channel-token) — a `refreshClientToken(deviceId)` server fn behind `requireUser` that re-mints a fresh 60s client token for a device the user owns (same ownership + kill-switch predicate as `mintClientToken`)
- Modify: `web/src/relay/mode.ts` + `web/src/crypto/keys.ts` (pin/load a daemon key **keyed by device id**, not per-origin), `web/src/relay/socket.ts` (use the per-device pinned key; refresh the channel token before each reconnect dial via the control-plane endpoint), `web/src/main.tsx` (read both token and pubkey from the fragment)
- Test: `app/test/refresh-token.test.ts`, `web/src/relay/*.test.ts`, `web/src/crypto/keys.test.ts`

**Behavior:**
- **Open a session** now carries both the client token and the target device's public key in the fragment: `https://<relay>/#t=<token>&k=<base64url(pubkey)>`. The browser reads both from `location.hash` (still scrubs immediately), pins the pubkey **under the device id** (derive the device id from the pubkey the same way — `sha256(pubkey)[:12]` — or carry `d=<deviceId>` too), and runs the Noise initiator against *that* key. A second machine's session pins and uses its own key.
- **Token refresh:** the web client, before each (re)dial of the SaaS relay, calls `refreshClientToken(deviceId)` on the control plane (`app.flue.sh`, a cross-origin `fetch` with credentials — the session cookie authenticates it) to get a fresh 60s token, rather than reusing the one captured at open time. So a reconnect after the first minute re-mints instead of dying. (The refresh endpoint is same-account, ownership-scoped, kill-switch-gated — a disabled device/user stops getting tokens, which is the revocation path.)
- **CORS:** `app.flue.sh` must allow the credentialed `refreshClientToken` call from the `relay.flue.sh` origin (a narrow CORS allowance on that one endpoint, `Access-Control-Allow-Origin: https://relay.flue.sh` + `Allow-Credentials: true`, or serve the refresh from the relay origin via a service binding — decide; the simplest correct option is the narrow CORS allowance).
- **SaaS pairing:** SaaS enrollment is `flue enable`/device-authorization (Task 6/11), not the QR `/pair` flow, so `pair.tsx` sending no bearer is moot for SaaS — confirm and document that the QR pair path is self-host-only; if the SaaS UI ever surfaces pairing, it must send the bearer.
- Keep self-host (single pinned key, no token, no refresh) working and its tests green.

- [ ] **Step 1: Failing tests.** `refreshClientToken` re-mints for an owned enabled device, refuses a non-owned or disabled one (same as `mintClientToken`); `openSession` fragment carries both `t` and `k`; the web client pins per-device (two device ids → two stored keys, no collision) and picks the right one; a reconnect re-mints a fresh token; self-host still uses the single key and no refresh.
- [ ] **Step 2: Run to verify failure, implement, re-run.** `cd app && pnpm test`; `cd web && pnpm test` (only the pre-existing 55 fail) + `pnpm lint`; `cd relay && pnpm test` (unchanged, green).
- [ ] **Step 3: Manual E2E note** in `docs/SAAS.md`: two real machines enrolled to one account, open each from the directory, both terminals live — the release gate this task exists to make possible.
- [ ] **Step 4: Commit.** `git commit -m "feat: per-device key pinning and token refresh for saas browser sessions"`

---

## Execution notes for the controller

- **Sequence:** 1→2 are the substrate (package + schema). 3→4→5 are auth (codes → sessions → login+invites). 6 (enrollment) needs 4 (sessions). 7 (channel tokens) needs 2 + the device rows from 6. 8 (directory) needs 4+7. 9 (relay SaaS auth) needs 7's token format + vector; it is the security-critical task — review it hardest. 10 (limits/kill switch) threads through 3/4/5/7 — verify rather than rebuild. 11 (daemon `flue link`) needs 6+7's endpoints. 12 last. Run one implementer at a time.
- **The two cross-language contracts to pin with shared vectors:** (a) the device id derivation (`crypto.DeviceID` Go ↔ TS in Task 6); (b) the channel token format (`app/src/lib/tokens.ts` ↔ `relay/src/channel-auth.ts` in Tasks 7/9). A drift in either silently breaks bridging or account-scoping — pin both with a fixed-input→fixed-output fixture asserted on both sides.
- **The relay's self-host mode is a regression surface every relay task must guard:** SaaS mode is additive and env-selected; Plan 1's `relay/test/*` must stay green throughout Task 9.
- **Email is the one deliberate stub.** Do not build a provider. The `Sender` seam + `LogSender` is the whole deliverable there; the user wires real delivery at the end.
- **Manual E2E is a release gate, not a task gate:** deploy both Workers to real custom domains, `flue link` a real machine, open a session from a phone. Documented in SAAS.md, run by a human.

## Self-review notes (author)

- Spec coverage: accounts (T2/T5), email-code auth (T3), sessions (T4), invites (T5), device directory (T8), enrollment/device-authorization (T6), signed-token relay auth (T7/T9), rate limits + kill switch + ToS (T10), daemon enrollment (T11), deploy/docs (T12). All spec §"The SaaS layer" bullets map to a task.
- Type consistency: `ChannelClaims{acc,dev,role,exp}` used identically in T7 (mint/verify) and T9 (relay verify); `deviceId` is the 12-hex `crypto.DeviceID` shape in T2/T6/T8/T9 and matches the Go daemon; `SESSION_COOKIE='__Host-session'` single-sourced in T4 and used in T4/T5/T10.
- No placeholders except the deliberate, spec-mandated email `Sender` (the user's explicit "keep a placeholder"). The `database_id: "local"` in wrangler.jsonc is a documented dev placeholder replaced at deploy (T12), not an unfinished step.
