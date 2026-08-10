/*
 * The end-to-end suite's own Vitest config, deliberately separate from
 * web/vite.config.ts.
 *
 * `pnpm test` — the suite CI runs on every push — must stay a few seconds of
 * pure unit tests with no processes, no ports and no network. This one spawns
 * workerd, two daemons and a certificate authority, so it is reached only by
 * name: `make e2e`, or `pnpm exec vitest run -c e2e/vitest.config.ts` from
 * web/. Two things keep the separation honest: the files here are named
 * `*.e2e.ts`, which the default include pattern (`*.test.*`, `*.spec.*`) does
 * not match, and `include` below names them explicitly rather than inheriting
 * anything.
 *
 * Everything else here exists because the subject is real processes:
 * one file, one fork, no parallelism — two runs of this would fight over the
 * same three ports — and timeouts measured in minutes, because a cold
 * `wrangler dev` has a Worker to bundle before it answers anything.
 */
import { defineConfig } from 'vitest/config'
import { fileURLToPath, URL } from 'node:url'

export default defineConfig({
  resolve: {
    // The same alias the app builds under, so every module imported from
    // web/src here is the module the browser ships.
    alias: { '@': fileURLToPath(new URL('../src', import.meta.url)) },
  },
  test: {
    environment: 'node',
    globals: true,
    include: ['e2e/**/*.e2e.ts'],
    fileParallelism: false,
    pool: 'forks',
    maxWorkers: 1,
    testTimeout: 120_000,
    hookTimeout: 180_000,
    teardownTimeout: 30_000,
  },
})
