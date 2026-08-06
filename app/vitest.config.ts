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

export default defineConfig({
  test: {
    // Runs in the pool worker after the D1 binding exists; see the file.
    setupFiles: ['./test/apply-migrations.ts'],
  },
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: './dist/server/wrangler.json' },
      miniflare: {
        // Reading migrations/ is Node's job, and this callback is the last
        // place that is still Node. The built wrangler.json already supplies
        // the DB binding itself (its migrations_dir is rewritten to point back
        // here, at app/migrations — the same directory this reads).
        bindings: { TEST_MIGRATIONS: await readD1Migrations(migrationsDir) },
      },
    })),
  ],
})
