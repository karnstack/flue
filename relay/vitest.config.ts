// vitest-pool-workers 0.20 (the vitest 4 line) replaced `defineWorkersConfig`
// from ".../config" with the `cloudflareTest` vite plugin — the same workers
// pool options object, handed to the plugin instead of test.poolOptions.workers.
import { cloudflareTest } from '@cloudflare/vitest-pool-workers'
import { defineConfig } from 'vitest/config'

/**
 * One Worker under test, with the bindings its mode is selected by.
 *
 * HANDSHAKE_TIMEOUT_MS and PAIR_TIMEOUT_MS are the hub's test seams: short here
 * so the deadline tests run in real time; unset in production, where code
 * defaults to 30 s and 10 s. The pairing deadline is the looser of the two
 * because the tests that must *not* hit it run a whole HTTP request through a
 * WebSocket round trip first.
 */
const worker = (bindings: Record<string, string | number>) =>
  cloudflareTest({
    wrangler: { configPath: './wrangler.jsonc' },
    miniflare: { bindings: { HANDSHAKE_TIMEOUT_MS: 50, PAIR_TIMEOUT_MS: 250, ...bindings } },
  })

/**
 * The relay's two auth modes are chosen by the environment, so they are two
 * *deployments* of one Worker and cannot share an isolate: a binding is bound
 * for the whole worker, and `RELAY_SIGNING_SECRET` is precisely what
 * `src/channel-auth.ts` selects the mode by. Hence two vitest projects over the
 * same sources:
 *
 *   self-host  no RELAY_SIGNING_SECRET — Plan 1's relay, unchanged
 *   saas       RELAY_SIGNING_SECRET bound — control-plane-signed channel tokens
 *
 * The saas project binds `DAEMON_SECRET` as well, and that is deliberate rather
 * than sloppy: a SaaS relay that inherited a self-hosted one's configuration
 * must not still accept the old shared bearer secret, and `saas-auth.test.ts`
 * asserts it does not.
 */
export default defineConfig({
  test: {
    projects: [
      {
        plugins: [worker({ DAEMON_SECRET: 'test-secret' })],
        test: {
          name: 'self-host',
          include: ['test/**/*.test.ts'],
          exclude: ['test/saas-*.test.ts'],
        },
      },
      {
        plugins: [
          worker({ DAEMON_SECRET: 'test-secret', RELAY_SIGNING_SECRET: 'test-signing-secret' }),
        ],
        test: { name: 'saas', include: ['test/saas-*.test.ts'] },
      },
    ],
  },
})
