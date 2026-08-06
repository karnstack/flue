// Same shape as relay/vitest.config.ts: vitest-pool-workers 0.20 (the vitest 4
// line) configures the workers pool through the `cloudflareTest` vite plugin.
// Later tasks' D1 tests extend this config.
//
// The configPath points at the BUILT worker (`pnpm build` writes
// dist/server/wrangler.json, main: index.js, plus the client assets), not at
// ./wrangler.jsonc: the pool cannot resolve that file's
// `main: "@tanstack/react-start/server-entry"`, a bare specifier only the
// tanstackStart vite plugin's build graph can materialize. Running the built
// worker keeps SELF.fetch exercising the real SSR entry. `pnpm build` must
// run before `pnpm test`; the Makefile's test-app target encodes that.
import { cloudflareTest } from '@cloudflare/vitest-pool-workers'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: './dist/server/wrangler.json' } })],
})
