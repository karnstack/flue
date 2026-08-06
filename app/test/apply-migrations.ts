// Every test file gets its own empty D1 (the pool isolates storage per file),
// so every test file has to run the migrations itself. vitest.config.ts reads
// migrations/ in Node — the pool worker cannot touch the filesystem — and hands
// the parsed statements through as the TEST_MIGRATIONS binding; this setup file
// is the other half, replaying them into the per-file database.
//
// That means the tests exercise the *committed migration SQL*, not schema.ts:
// a schema change nobody ran `pnpm db:generate` for fails here.
import { applyD1Migrations, env } from 'cloudflare:test'
import type { D1Migration } from 'cloudflare:test'
import { beforeAll } from 'vitest'

// TEST_MIGRATIONS exists only under the test pool, so it is deliberately not
// declared on Cloudflare.Env: production code that reached for it would
// typecheck and then find `undefined` at runtime. The cast is the price of
// keeping that binding out of the app's environment type.
const testEnv = env as unknown as { TEST_MIGRATIONS: D1Migration[] }

beforeAll(async () => {
  await applyD1Migrations(env.DB, testEnv.TEST_MIGRATIONS)
})
