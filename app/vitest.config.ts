// Same shape as relay/vitest.config.ts: vitest-pool-workers 0.20 (the vitest 4
// line) configures the workers pool through the `cloudflareTest` vite plugin.
//
// The configPath points at the BUILT worker (`pnpm build` writes
// dist/server/wrangler.json, main: index.js, plus the client assets), not at
// ./wrangler.jsonc: the pool cannot resolve that file's
// `main: "@tanstack/react-start/server-entry"`, a bare specifier only the
// tanstackStart vite plugin's build graph can materialize. Running the built
// worker keeps SELF.fetch exercising the real SSR entry. `pnpm build` must
// run before `pnpm test`; the Makefile's test-app target encodes that.
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers'
import { defineConfig } from 'vitest/config'

// Resolved from this file rather than from cwd, and via import.meta.url rather
// than import.meta.dirname so that no @types/node is needed here — keeping
// Node's globals out of a tsconfig the React code shares.
const migrationsDir = decodeURIComponent(new URL('./migrations', import.meta.url).pathname)
const distDir = decodeURIComponent(new URL('./dist', import.meta.url).pathname)

/**
 * Declare `dist/` as ESM, so that CommonJS dependencies stay loadable.
 *
 * The pool serves every node_modules import to workerd itself, and decides
 * "is this file ESM?" by walking up from the file to the nearest package.json
 * with `"type": "module"` — memoizing the answer *per directory it passes
 * through*, and checking that memo from the nearest ancestor outwards before
 * it reads any package.json. So the first lookup that walks past `app/`
 * without finding a nearer package.json — `dist/server/index.js`, the built
 * worker the pool boots — caches `app` = "type: module" from our own
 * package.json. Every CommonJS dependency underneath (react and
 * react/jsx-runtime are CJS, and `@tanstack/react-start` re-exports React
 * components from both of its entrypoints) then inherits that answer, is
 * served to workerd as ESM, and fails to link: "The requested module
 * 'react/jsx-runtime' does not provide an export named 'jsx'".
 *
 * This file stops the walk one directory early — `dist` is memoized instead of
 * `app` — which is both true (the build output *is* ESM) and enough: react's
 * own package.json is then reached and believed. `vite build` empties
 * dist/client and dist/server rather than dist itself, so writing it here,
 * before the pool starts, survives a rebuild and needs no build step of its
 * own.
 */
async function markBuiltOutputAsEsm(): Promise<void> {
  // @ts-expect-error - 'node:fs' is deliberately untyped here: see the comment
  // on migrationsDir. This is the only Node API this file needs beyond it.
  const { mkdirSync, writeFileSync } = await import('node:fs')
  mkdirSync(distDir, { recursive: true })
  writeFileSync(`${distDir}/package.json`, `${JSON.stringify({ type: 'module' })}\n`)
}

export default defineConfig({
  test: {
    // Runs in the pool worker after the D1 binding exists; see the file.
    setupFiles: ['./test/apply-migrations.ts'],
  },
  plugins: [
    cloudflareTest(async () => {
      await markBuiltOutputAsEsm()
      return {
        wrangler: { configPath: './dist/server/wrangler.json' },
        miniflare: {
          // Reading migrations/ is Node's job, and this callback is the last
          // place that is still Node. The built wrangler.json already supplies
          // the DB binding itself (its migrations_dir is rewritten to point
          // back here, at app/migrations — the same directory this reads).
          bindings: {
            TEST_MIGRATIONS: await readD1Migrations(migrationsDir),
            // A Worker *secret* in production (`wrangler secret put`), so it is
            // deliberately absent from wrangler.jsonc and from the built
            // wrangler.json the pool loads above — the tests have to supply
            // their own. Its only job here is to be present and stable: login
            // codes are stored as HMAC(this, code), so a test can recompute a
            // hash and prove the plaintext never reached the database.
            CODE_HMAC_SECRET: 'test-code-hmac-secret',
          },
        },
      }
    }),
  ],
})
