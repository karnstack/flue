// drizzle-kit only ever *generates* SQL here: `pnpm db:generate` diffs
// src/db/schema.ts against migrations/ and writes the next numbered file.
// Applying is wrangler's job (`pnpm db:migrate:local`, `wrangler d1 migrations
// apply` at deploy) and the vitest pool's job in tests — so this config carries
// no D1 credentials, and the commands that would need them (`drizzle-kit
// push`/`studio`, which would talk to the live database) are not wired up.
import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  dialect: 'sqlite',
  driver: 'd1-http',
  schema: './src/db/schema.ts',
  out: './migrations',
})
