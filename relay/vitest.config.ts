// vitest-pool-workers 0.20 (the vitest 4 line) replaced `defineWorkersConfig`
// from ".../config" with the `cloudflareTest` vite plugin — the same workers
// pool options object, handed to the plugin instead of test.poolOptions.workers.
import { cloudflareTest } from '@cloudflare/vitest-pool-workers'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      // HANDSHAKE_TIMEOUT_MS is the hub's test seam: 50 ms here so the alarm
      // tests run in real time; unset in production, where code defaults to 30 s.
      miniflare: { bindings: { DAEMON_SECRET: 'test-secret', HANDSHAKE_TIMEOUT_MS: 50 } },
    }),
  ],
})
