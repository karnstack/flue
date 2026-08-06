import { env } from 'cloudflare:workers'
import { drizzle } from 'drizzle-orm/d1'
import * as schema from './schema'

/**
 * The D1 handle for one request.
 *
 * Call this *inside* a request handler (route loader, server function, API
 * route). Reading `env` at module scope is legal on Workers; *doing I/O* with
 * it there is not — a query issued while the module is still evaluating throws
 * "Disallowed operation called within global scope". Building the client per
 * call keeps every query on the stack of the request that asked for it, and
 * costs nothing: drizzle() only wraps the binding.
 *
 * D1 has no interactive transactions — `drizzle.transaction()` is not usable
 * against it. When several writes must land together, use the batch on the
 * returned client (`db().batch([a, b, c])`), which D1 runs as one implicit
 * transaction and rolls back as a unit.
 */
export function db() {
  return drizzle(env.DB, { schema })
}

export type Db = ReturnType<typeof db>
