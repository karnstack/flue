export interface Env {
  HUB: DurableObjectNamespace
  ASSETS: Fetcher
  DAEMON_SECRET: string
}

/** May this request open the daemon leg? Self-host: a bearer secret. */
export function authorizeDaemon(req: Request, env: Env): boolean {
  const h = req.headers.get('Authorization') ?? ''
  const want = `Bearer ${env.DAEMON_SECRET}`
  if (h.length !== want.length) return false
  // constant-time compare
  let diff = 0
  for (let i = 0; i < h.length; i++) diff |= h.charCodeAt(i) ^ want.charCodeAt(i)
  return diff === 0
}

/** May this request open a client channel? Self-host: yes — Noise is the
 * confidentiality; the DO's channel cap and handshake deadline bound abuse.
 * The SaaS front-end replaces this with signed-token verification. */
export function authorizeClient(_req: Request, _env: Env): boolean {
  return true
}

/** Which hub a request lands on. Self-host: one daemon, one hub. The SaaS
 * routes by account/daemon id here. */
export function hubIdFor(_req: Request, env: Env): DurableObjectId {
  return env.HUB.idFromName('hub')
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url)
    if (url.pathname === '/daemon') {
      if (!authorizeDaemon(req, env)) return new Response('unauthorized', { status: 401 })
      return env.HUB.get(hubIdFor(req, env)).fetch(req)
    }
    if (url.pathname === '/client') {
      if (!authorizeClient(req, env)) return new Response('unauthorized', { status: 401 })
      return env.HUB.get(hubIdFor(req, env)).fetch(req)
    }
    if (url.pathname === '/api/pair' && req.method === 'POST') {
      return env.HUB.get(hubIdFor(req, env)).fetch(req)
    }
    return env.ASSETS.fetch(req)
  },
}
export { DaemonHub } from './hub'
