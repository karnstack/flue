export interface Env {
  HUB: DurableObjectNamespace
  /** The fleet directory: one object per relay, because one relay is one fleet
   * (spec/fleet-trust.md, "The fleet directory"). Not per machine, which is
   * why it is a namespace of its own rather than a name in HUB's. */
  DIRECTORY: DurableObjectNamespace
  ASSETS: Fetcher
  DAEMON_SECRET: string
  /** The per-IP rate limiter over the credential-less routes (`/client/*`,
   * `POST /api/pair/*`, `GET /directory`) — a Cloudflare rate-limiting binding, declared in
   * wrangler.jsonc (`ratelimits`) and in the deploy `flue relay setup` builds
   * (internal/relaydeploy, RateLimitBinding); the two must agree. Optional
   * and fail-open: the rule bounds quota burn, it is not auth, and a Worker
   * mid-upgrade (or an old deploy) must keep serving the fleet rather than
   * refuse everyone until the binding lands. */
  CLIENT_RATE?: RateLimit
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

/**
 * The machine-id grammar: `<slug>-<tag>`, at most 63 characters in all — a
 * lowercase hostname-shaped slug, then a dash, then an 8-hex MAC tag
 * (spec/relay-protocol.md, Auth). The grammar is the cheap gate; whether the
 * tag actually *verifies* under DAEMON_SECRET is `verifyMachineId`, run only
 * on ids this expression admits, because `run_worker_first` puts this router
 * in front of every request and a regex reject must not cost an HMAC.
 */
const MACHINE_ID = /^([a-z0-9][a-z0-9-]{0,53})-([0-9a-f]{8})$/

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

/**
 * The MAC tag for a slug: the first 8 lowercase hex characters of
 * HMAC-SHA256(secret, "flue-machine-id/" + slug). The Go mint is the other
 * half of this contract (internal/config, MachineIDTag) and
 * testdata/relay/machine-ids.json pins the two to each other.
 */
export async function machineTag(secret: string, slug: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`flue-machine-id/${slug}`))
  return [...new Uint8Array(mac, 0, 4)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Does this grammar-valid id end in the tag the secret would mint for its
 * slug? This is what closes the open id namespace: a stateless router cannot
 * know which ids exist, but it holds the one credential ids are minted under
 * (spec/fleet-trust.md, "Self-certifying machine ids"). An id that fails is
 * answered with the same 404 a malformed id gets, and no Durable Object
 * wakes. False when the secret was never bound: no secret means no mint ever
 * happened, so no id can be routable — the same fail-closed rule
 * authorizeDaemon applies.
 */
export async function verifyMachineId(id: string, secret: string): Promise<boolean> {
  if (!secret) return false
  const m = MACHINE_ID.exec(id)
  if (!m) return false
  const want = await machineTag(secret, m[1] as string)
  const got = m[2] as string
  // Constant-time compare, same shape as authorizeDaemon: both strings are 8
  // hex characters by construction.
  let diff = 0
  for (let i = 0; i < want.length; i++) diff |= got.charCodeAt(i) ^ want.charCodeAt(i)
  return diff === 0
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

const rateLimited = () =>
  new Response('{"error":"rate limited"}', {
    status: 429,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  })

/** A path under a prefix the Worker owns but does not serve. Not the machine
 * 404: `/directory/anything` names no machine, and answering that it is not
 * one would be a lie about what was asked. */
const notFound = () =>
  new Response('{"error":"not found"}', {
    status: 404,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  })

const methodNotAllowed = (allow: string) =>
  new Response('{"error":"method not allowed"}', {
    status: 405,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      Allow: allow,
    },
  })

/** The name of the one directory object. One relay is one fleet, so this is a
 * constant rather than anything read off the request: there is no second
 * directory to route to, and a name in the path would only invent one. */
const DIRECTORY_NAME = 'directory'

/**
 * May this credential-less request proceed, under the per-IP rate rule?
 *
 * MAC ids close the *fake*-id surface (no Durable Object wakes for a forged
 * id), but the real id is semi-public — it rides pairing links — and
 * `run_worker_first` bills every request before any of this runs. This is the
 * bound on that quota burn: one Cloudflare rate-limiting rule, keyed by
 * connecting IP, generous enough that a fleet of tabs never sees it and tight
 * enough that burning the daily allowance needs a botnet
 * (spec/fleet-trust.md, "Rate rule"). It runs after the grammar check (a
 * regex reject should not spend a limiter token) and before the tag HMAC (an
 * over-limit caller gets no more crypto out of us, and the 2^32 tag-guessing
 * walk the spec prices in is throttled to this same rule).
 *
 * Absent binding means allow: the rule bounds cost, it is not auth, and a
 * deploy mid-upgrade must not refuse the whole fleet. The daemon leg is
 * deliberately not behind this — it is secret-gated and one socket per
 * machine.
 */
async function allowRate(req: Request, env: Env): Promise<boolean> {
  if (!env.CLIENT_RATE) return true
  // Absent header (local dev, the vitest pool) means one shared bucket,
  // which is exactly what those environments are.
  const key = req.headers.get('CF-Connecting-IP') ?? ''
  const { success } = await env.CLIENT_RATE.limit({ key })
  return success
}

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
      // Bearer before tag, deliberately. The daemon leg is the one route the
      // rate rule does not cover (it is secret-gated, one socket per
      // machine), so the order is what keeps it that way: tag-first would
      // hand the unthrottled route a free HMAC per anonymous request *and* a
      // tag oracle — 404 for a bad tag, 401 for a good one — that lets the
      // 2^32 guessing walk run where nothing meters it. Bearer-first answers
      // every secretless probe 401, tag right or wrong. And a caller who
      // passes the bearer check holds the very secret tags are minted from,
      // so the tag check behind it can only ever catch honest staleness — an
      // id minted under a secret that has since rotated away — for which "no
      // such machine" is the truthful answer: re-setup abandoned that slot.
      if (!authorizeDaemon(req, env)) return unauthorized()
      if (!(await verifyMachineId(id, env.DAEMON_SECRET))) return noSuchMachine()
      return toHub(id, '/daemon')
    }
    if (claims(url.pathname, '/client')) {
      const id = machineIdFrom(url.pathname, '/client')
      if (id === null) return noSuchMachine()
      if (!(await allowRate(req, env))) return rateLimited()
      if (!(await verifyMachineId(id, env.DAEMON_SECRET))) return noSuchMachine()
      return toHub(id, '/client')
    }
    if (claims(url.pathname, '/api/pair')) {
      const id = machineIdFrom(url.pathname, '/api/pair')
      if (id === null) return noSuchMachine()
      if (req.method === 'POST') {
        if (!(await allowRate(req, env))) return rateLimited()
        if (!(await verifyMachineId(id, env.DAEMON_SECRET))) return noSuchMachine()
        return toHub(id, '/api/pair')
      }
      // A GET of a well-formed pair URL is a browser following a link; the
      // SPA below answers it, the API does not — so it spends no limiter
      // token and earns no HMAC: asset requests are unmetered, and the tag
      // check exists to guard Durable Object wakes, not page loads.
    }
    if (claims(url.pathname, '/directory')) {
      // The fleet directory: one object for the whole relay, no id in the
      // path, three shapes on one URL (spec/fleet-trust.md, "The fleet
      // directory"). Nothing lives under it, and the Worker keeps refusal
      // authority over the whole prefix — `/directory/anything` is the
      // Worker's own 404, never the SPA.
      if (url.pathname !== '/directory') return notFound()
      // The relay holds no fleet key and verifies none of what this leg
      // carries; what it can check is who may *write*, and that is the same
      // bearer secret the daemon leg presents. Checked once, up front,
      // because it decides both the auth answer and the metering below.
      const daemon = authorizeDaemon(req, env)
      // The rate rule meters everything on this prefix that does not hold the
      // secret — which is the credential-less `GET /directory` the spec puts
      // behind it, and equally an anonymous caller waving an `Upgrade` header
      // to reach the 401 by a cheaper road. The secret-holding legs stay
      // unmetered for the reason `/daemon` is: they are secret-gated, and a
      // fleet is a handful of machines.
      if (!daemon && !(await allowRate(req, env))) return rateLimited()
      const upgrade = req.headers.get('Upgrade')?.toLowerCase() === 'websocket'
      if ((upgrade || req.method === 'PUT') && !daemon) return unauthorized()
      if (!upgrade && req.method !== 'GET' && req.method !== 'PUT') {
        return methodNotAllowed('GET, PUT')
      }
      // Fail closed on a Worker deployed without the binding — an older
      // `flue relay setup` than this script. Unlike CLIENT_RATE, which is
      // fail-open because it bounds cost rather than access, there is no
      // degraded directory to serve without the object: 503 says so, and the
      // rest of the relay (which is every session on it) keeps running.
      if (!env.DIRECTORY) {
        return new Response('{"error":"directory unavailable"}', {
          status: 503,
          headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
        })
      }
      return env.DIRECTORY.get(env.DIRECTORY.idFromName(DIRECTORY_NAME)).fetch(req)
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
export { FleetDirectory } from './directory'
export { DaemonHub } from './hub'
