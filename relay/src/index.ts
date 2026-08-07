export interface Env {
  HUB: DurableObjectNamespace
  ASSETS: Fetcher
  DAEMON_SECRET: string
  /** Handshake deadline in ms — a test seam (vitest binds 50). Unset in
   * production, where the hub defaults to 30 000. */
  HANDSHAKE_TIMEOUT_MS?: string | number
  /** How long `POST /api/pair` waits for the daemon, in ms — the same test
   * seam (vitest binds 250). Unset in production, where it is 10 000. */
  PAIR_TIMEOUT_MS?: string | number
}

/**
 * May this request open the daemon leg?
 *
 * A bearer secret, shared with the one daemon the relay serves — set on the
 * Worker by `flue relay setup`, presented by the daemon on every dial.
 */
export function authorizeDaemon(req: Request, env: Env): boolean {
  // Fail closed: if the secret was never bound (`wrangler secret put
  // DAEMON_SECRET` not run), the template compare below would accept the
  // literal "Bearer undefined". No secret means no daemon leg.
  if (!env.DAEMON_SECRET) return false
  const h = req.headers.get('Authorization') ?? ''
  const want = `Bearer ${env.DAEMON_SECRET}`
  if (h.length !== want.length) return false
  // constant-time compare
  let diff = 0
  for (let i = 0; i < h.length; i++) diff |= h.charCodeAt(i) ^ want.charCodeAt(i)
  return diff === 0
}

// The client and pairing legs are credential-less on purpose: Noise is the
// confidentiality boundary, the pairing token in the POST body is the pairing
// credential, and the DO's channel cap and handshake deadline bound the abuse
// an anonymous socket can be (spec/relay-protocol.md, Auth).

const unauthorized = () => new Response('unauthorized', { status: 401 })

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url)
    const hub = () => env.HUB.get(env.HUB.idFromName('hub'))
    if (url.pathname === '/daemon') {
      if (!authorizeDaemon(req, env)) return unauthorized()
      return hub().fetch(req)
    }
    if (url.pathname === '/client') {
      return hub().fetch(req)
    }
    if (url.pathname === '/api/pair' && req.method === 'POST') {
      return hub().fetch(req)
    }
    return env.ASSETS.fetch(req)
  },
}
export { DaemonHub } from './hub'
