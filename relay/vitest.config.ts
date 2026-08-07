// vitest-pool-workers 0.20 (the vitest 4 line) replaced `defineWorkersConfig`
// from ".../config" with the `cloudflareTest` vite plugin — the same workers
// pool options object, handed to the plugin instead of test.poolOptions.workers.
import { cloudflareTest } from '@cloudflare/vitest-pool-workers'
import { defineConfig } from 'vitest/config'

/**
 * HANDSHAKE_TIMEOUT_MS and PAIR_TIMEOUT_MS are the hub's test seams: short here
 * so the deadline tests run in real time; unset in production, where code
 * defaults to 30 s and 10 s. The pairing deadline is the looser of the two
 * because the tests that must *not* hit it run a whole HTTP request through a
 * WebSocket round trip first.
 */
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        bindings: {
          HANDSHAKE_TIMEOUT_MS: 50,
          PAIR_TIMEOUT_MS: 250,
          DAEMON_SECRET: 'test-secret',
          // The deploy stamps this (internal/relaydeploy, VersionVar); binding
          // it here is what lets the health test pin the passthrough.
          FLUE_VERSION: 'test-version',
        },
      },
    }),
  ],
  test: { include: ['test/**/*.test.ts'] },
})
