// vitest-pool-workers 0.20 (the vitest 4 line) replaced `defineWorkersConfig`
// from ".../config" with the `cloudflareTest` vite plugin — the same workers
// pool options object, handed to the plugin instead of test.poolOptions.workers.
import { cloudflareTest } from '@cloudflare/vitest-pool-workers'
import { defineConfig } from 'vitest/config'

/**
 * HANDSHAKE_TIMEOUT_MS and PAIR_TIMEOUT_MS are the hub's test seams; both are
 * unset in production, where code defaults to 30 s and 10 s.
 *
 * The handshake deadline is bound *long* — ten minutes, far past any deadline
 * vitest itself will allow a test to reach. It used to be bound at 50 ms so the
 * reap tests could run in real time, and that made the reaper ambient: every
 * test dials clients, most of them have no reason to send immediately, and a
 * loaded runner stretches the gap between dial and first byte past 50 ms. The
 * reaper then fired mid-test and closed a healthy client 4001, or slipped a
 * `closed{channel}` control onto the daemon leg ahead of the frame the test was
 * waiting for. Two different CI failures in `test/hub.test.ts` came from that,
 * and neither reproduced locally.
 *
 * So the default is now "no test can outlive the deadline", and the three tests
 * that are *about* reaping bind their own short one with `handshakeDeadline()`
 * before they dial. A test that says nothing about the deadline is no longer
 * making a silent bet on how fast the runner is.
 *
 * The pairing deadline stays short and stays the looser of the two, because the
 * tests that must *not* hit it run a whole HTTP request through a WebSocket
 * round trip first.
 */
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        bindings: {
          HANDSHAKE_TIMEOUT_MS: 600_000,
          PAIR_TIMEOUT_MS: 250,
          DAEMON_SECRET: 'test-secret',
          // The deploy stamps this (internal/relaydeploy, VersionVar); binding
          // it here is what lets the health test pin the passthrough.
          FLUE_VERSION: 'test-version',
        },
      },
    }),
  ],
  test: {
    include: ['test/**/*.test.ts'],
    // Drops the hub's per-channel Workers Logs line from test output — the
    // line itself is deliberate production logging. See test/setup.ts.
    setupFiles: ['test/setup.ts'],
  },
})
