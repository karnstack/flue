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
  /** The version of the flue that deployed this Worker, stamped by the
   * deploy as a plain-text binding (internal/relaydeploy, VersionVar) and
   * reported on /api/health. It is how a daemon sees that this relay is
   * older than the binary looking at it. Unset under `pnpm dev`, which
   * deploys nothing. */
  FLUE_VERSION?: string
}

/**
 * May this request open the daemon leg?
 *
 * A bearer secret, shared with every daemon this relay serves — set on the
 * Worker by `flue relay setup`, presented by each daemon on every dial. One
 * secret for the fleet: the machine id in the path is routing, not identity.
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

/** The machine-id grammar: a lowercase hostname-shaped slug, 1–63 characters. */
const MACHINE_ID = /^[a-z0-9][a-z0-9-]{0,62}$/

/**
 * The machine id in `<prefix>/<id>`, or null when the path is not exactly
 * that shape. Null covers the bare prefix, an empty id, a trailing slash, an
 * embedded segment and anything outside the grammar — the router answers
 * every one of them with the same 404, and never with an asset.
 */
export function machineIdFrom(pathname: string, prefix: string): string | null {
  if (!pathname.startsWith(`${prefix}/`)) return null
  const id = pathname.slice(prefix.length + 1)
  return MACHINE_ID.test(id) ? id : null
}

/** Does this path claim the prefix — the prefix itself or anything under it? */
function claims(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`)
}

// The client and pairing legs are credential-less on purpose: Noise is the
// confidentiality boundary, the pairing token in the POST body is the pairing
// credential, and the DO's channel cap and handshake deadline bound the abuse
// an anonymous socket can be (spec/relay-protocol.md, Auth).

const unauthorized = () => new Response('unauthorized', { status: 401 })

const noSuchMachine = () =>
  new Response('{"error":"no such machine"}', {
    status: 404,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  })

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url)
    // One hub per machine: the id in the path picks the Durable Object, and
    // the hub receives the bare prefix — its internals are unchanged from the
    // single-machine relay and never see an id (src/hub.ts matches '/daemon'
    // exactly). idFromName means a daemon and its clients meet on the same
    // object by agreeing on a string, with no registry in between.
    const toHub = (id: string, prefix: string): Promise<Response> => {
      url.pathname = prefix
      return env.HUB.get(env.HUB.idFromName(id)).fetch(new Request(url, req))
    }
    if (claims(url.pathname, '/daemon')) {
      const id = machineIdFrom(url.pathname, '/daemon')
      if (id === null) return noSuchMachine()
      if (!authorizeDaemon(req, env)) return unauthorized()
      return toHub(id, '/daemon')
    }
    if (claims(url.pathname, '/client')) {
      const id = machineIdFrom(url.pathname, '/client')
      if (id === null) return noSuchMachine()
      return toHub(id, '/client')
    }
    if (claims(url.pathname, '/api/pair')) {
      const id = machineIdFrom(url.pathname, '/api/pair')
      if (id === null) return noSuchMachine()
      if (req.method === 'POST') return toHub(id, '/api/pair')
      // A GET of a well-formed pair URL is a browser following a link; the
      // SPA below answers it, the API does not.
    }
    if (url.pathname === '/api/health' && req.method === 'GET') {
      // Liveness of the Worker and nothing else — no id, no Durable Object
      // woken, nothing about any daemon. An uptime monitor pointed here costs
      // hibernation nothing. Per-machine liveness stays off this endpoint on
      // purpose: a valid /client/<id> dial already observes it (RELAY.md,
      // "what a probe can learn"), and an *advertised* per-machine health API
      // would turn that accepted observation into a product surface.
      // The version is public by choice: this origin already serves the web
      // bundle to anyone who asks, so which flue deployed it is not a secret
      // the endpoint could keep — and reporting it is what lets a daemon
      // (and the Remote screen) say "this relay is older than you".
      const body: { ok: true; version?: string } = { ok: true }
      if (env.FLUE_VERSION) body.version = env.FLUE_VERSION
      return new Response(JSON.stringify(body), {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      })
    }
    return env.ASSETS.fetch(req)
  },
}
export { DaemonHub } from './hub'
