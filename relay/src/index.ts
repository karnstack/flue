import {
  bearerToken,
  channelTokenFromSubprotocols,
  CLIENT_SUBPROTOCOL,
  relaySigningSecret,
  verifyChannelToken,
  type ChannelClaims,
} from './channel-auth'

export interface Env {
  HUB: DurableObjectNamespace
  ASSETS: Fetcher
  DAEMON_SECRET: string
  /**
   * The key the control plane signs channel tokens with — a Worker secret
   * (`wrangler secret put RELAY_SIGNING_SECRET`), never a `vars` entry, and
   * bound on exactly two Workers: app/ signs, this one verifies.
   *
   * **Its presence is the mode selector.** Bound: SaaS mode — every leg
   * presents a signed token and lands on a hub named by that token's account
   * and device. Unbound: self-host mode — the daemon presents the shared
   * `DAEMON_SECRET`, browsers present nothing, and there is one hub. Both are
   * compiled in and the environment chooses; see ./channel-auth.
   */
  RELAY_SIGNING_SECRET?: string
  /** Handshake deadline in ms — a test seam (vitest binds 50). Unset in
   * production, where the hub defaults to 30 000. */
  HANDSHAKE_TIMEOUT_MS?: string | number
  /** How long `POST /api/pair` waits for the daemon, in ms — the same test
   * seam (vitest binds 250). Unset in production, where it is 10 000. */
  PAIR_TIMEOUT_MS?: string | number
}

/**
 * What an authorized request carries on to the hub: who it proved itself to
 * be, and what to say back on the 101.
 *
 * `claims` is null in self-host mode and only in self-host mode — there is
 * nothing to prove there beyond the shared secret, and nothing to route by.
 * That is why `hubIdFor` takes the grant rather than re-deriving anything: the
 * account and device a socket lands on are exactly the ones a signature was
 * checked over, and there is no path from an unverified request to a hub name.
 */
export interface Grant {
  claims: ChannelClaims | null
  /** The subprotocol to echo on the upgrade, when the credential came in as
   *  one. Null on every path that did not offer one. */
  protocol: string | null
}

/** The grant a self-hosted relay issues: no claims, nothing to echo. */
const selfHostGrant = (): Grant => ({ claims: null, protocol: null })

/**
 * May this request open the daemon leg?
 *
 * Self-host: a bearer secret, shared with the one daemon the relay serves.
 * SaaS: a `role: 'daemon'` channel token from the control plane, verified
 * offline — its `acc`/`dev` name the hub, so a daemon can only ever attach to
 * its own account's.
 */
export async function authorizeDaemon(req: Request, env: Env): Promise<Grant | null> {
  const secret = relaySigningSecret(env)
  if (secret !== null) {
    return authorizeToken(secret, bearerToken(req.headers.get('Authorization')), 'daemon')
  }

  // Fail closed: if the secret was never bound (`wrangler secret put
  // DAEMON_SECRET` not run), the template compare below would accept the
  // literal "Bearer undefined". No secret means no daemon leg.
  if (!env.DAEMON_SECRET) return null
  const h = req.headers.get('Authorization') ?? ''
  const want = `Bearer ${env.DAEMON_SECRET}`
  if (h.length !== want.length) return null
  // constant-time compare
  let diff = 0
  for (let i = 0; i < h.length; i++) diff |= h.charCodeAt(i) ^ want.charCodeAt(i)
  return diff === 0 ? selfHostGrant() : null
}

/**
 * May this request open a client channel?
 *
 * Self-host: yes — Noise is the confidentiality, and the DO's channel cap and
 * handshake deadline bound the abuse an anonymous socket can be.
 *
 * SaaS: a `role: 'client'` channel token, presented as a WebSocket
 * subprotocol. Not a query parameter: the upgrade is a request to this Worker,
 * and a token in the URL is a token in Workers Logs. The accepted subprotocol
 * is echoed on the 101 (see `fetch`), because a browser that offered one and
 * was answered without one closes the connection itself.
 */
export async function authorizeClient(req: Request, env: Env): Promise<Grant | null> {
  const secret = relaySigningSecret(env)
  if (secret === null) return selfHostGrant()
  const token = channelTokenFromSubprotocols(req.headers.get('Sec-WebSocket-Protocol'))
  const grant = await authorizeToken(secret, token, 'client')
  return grant === null ? null : { ...grant, protocol: CLIENT_SUBPROTOCOL }
}

/**
 * May this request park a pairing attempt?
 *
 * Self-host: yes, and the spec says why — `POST /api/pair` is credential-less
 * because the pairing token in its body is the credential, and the relay
 * bounds the abuse by size, deadline and concurrency instead.
 *
 * SaaS: that argument does not carry, because there is more than one hub. A
 * pairing attempt has to *name* a daemon, and the only name this Worker will
 * take is one it has verified a signature over — so the browser presents the
 * same `role: 'client'` token its socket does, as a bearer. (A `fetch` can set
 * that header; the subprotocol trick exists only because a WebSocket cannot.
 * The token stays out of the URL either way.)
 */
export async function authorizePair(req: Request, env: Env): Promise<Grant | null> {
  const secret = relaySigningSecret(env)
  if (secret === null) return selfHostGrant()
  return authorizeToken(secret, bearerToken(req.headers.get('Authorization')), 'client')
}

/** A presented token, verified and required to be for the role at hand. */
async function authorizeToken(
  secret: string,
  token: string | null,
  role: ChannelClaims['role'],
): Promise<Grant | null> {
  if (token === null) return null
  const claims = await verifyChannelToken(secret, token)
  // The role is a claim and not a matter of which endpoint was dialled: a
  // daemon's 300-second token must not open a browser channel, and a browser's
  // must not attach as the daemon and be handed every other browser's bytes.
  if (claims === null || claims.role !== role) return null
  return { claims, protocol: null }
}

/**
 * Which hub a request lands on.
 *
 * Self-host: one daemon, one hub. SaaS: one hub per account *and* device, named
 * from the verified claims — which is the whole security argument of the SaaS
 * relay. A browser and a daemon meet only if two independently signed tokens
 * agree on both fields; a token for another account names another Durable
 * Object, and there is nothing in it to reach. Cross-account isolation is
 * therefore a property of addressing rather than of a check somebody has to
 * remember to write.
 *
 * Refusing to route rather than defaulting is the other half: in SaaS mode a
 * grant with no claims cannot exist (`authorizeToken` returns null instead),
 * and if a future edit made one, falling back to the shared `'hub'` would put
 * every account on one Durable Object. A 500 is the correct outcome of that
 * bug; a bridge between strangers is not.
 *
 * The separator is checked for the same reason. `${acc}:${dev}` is a
 * concatenation, and a concatenation is ambiguous the moment a field can
 * contain the separator: `acc="a:b", dev="c"` and `acc="a", dev="b:c"` are two
 * different accounts with one hub name. Neither field can hold a colon today —
 * they are a UUID and twelve hex characters, both assigned by the control
 * plane — so this cannot fire, and it costs one comparison to make sure a
 * change over there can never quietly become a bridge over here.
 */
export function hubIdFor(_req: Request, env: Env, grant: Grant): DurableObjectId {
  if (relaySigningSecret(env) === null) return env.HUB.idFromName('hub')
  const claims = grant.claims
  if (claims === null) throw new Error('saas mode: refusing to route a request with no claims')
  if (claims.acc.includes(':') || claims.dev.includes(':')) {
    throw new Error('saas mode: refusing to route claims that could name another hub')
  }
  return env.HUB.idFromName(`${claims.acc}:${claims.dev}`)
}

const unauthorized = () => new Response('unauthorized', { status: 401 })

/**
 * Echo the accepted subprotocol on the upgrade.
 *
 * RFC 6455 §4.1: a client that offered subprotocols and receives a 101 naming
 * none of them must fail the connection, and browsers do — so without this the
 * SaaS client leg would be refused by the browser itself, having been accepted
 * by everything else. `flue.v1` is what is echoed; the value carrying the
 * token never is.
 */
function withSubprotocol(res: Response, protocol: string | null): Response {
  if (protocol === null || res.status !== 101 || !res.webSocket) return res
  const headers = new Headers(res.headers)
  headers.set('Sec-WebSocket-Protocol', protocol)
  return new Response(null, { status: 101, webSocket: res.webSocket, headers })
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url)
    if (url.pathname === '/daemon') {
      const grant = await authorizeDaemon(req, env)
      if (!grant) return unauthorized()
      return env.HUB.get(hubIdFor(req, env, grant)).fetch(req)
    }
    if (url.pathname === '/client') {
      const grant = await authorizeClient(req, env)
      if (!grant) return unauthorized()
      const res = await env.HUB.get(hubIdFor(req, env, grant)).fetch(req)
      return withSubprotocol(res, grant.protocol)
    }
    if (url.pathname === '/api/pair' && req.method === 'POST') {
      const grant = await authorizePair(req, env)
      if (!grant) return unauthorized()
      return env.HUB.get(hubIdFor(req, env, grant)).fetch(req)
    }
    return env.ASSETS.fetch(req)
  },
}
export { DaemonHub } from './hub'
