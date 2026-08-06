// Run a piece of server code inside one real Start request.
//
// Cookies, request headers and the client IP are all read out of an h3 event
// that Start keeps in AsyncLocalStorage; without that event `getCookie`,
// `setCookie` and `getRequestIP` throw "No StartEvent found". `requestHandler`
// is the same wrapper the deployed Worker's entry uses, so anything driven
// through here sees exactly the context a route loader or a server function
// sees — and the `Set-Cookie` headers the tests read are the ones a browser
// would receive.
import { requestHandler } from '@tanstack/react-start/server'

const ORIGIN = 'https://app.flue.sh/'

export interface RequestOptions {
  /** The Cookie header, verbatim. */
  cookie?: string
  /**
   * The client IP, as Cloudflare's edge would present it. Rate limits bucket
   * on this, so a test that wants two different callers sets two values.
   */
  ip?: string
}

export interface RequestOutcome<T> {
  value: T
  setCookie: Array<string>
}

export async function inRequest<T>(
  body: () => Promise<T>,
  opts: RequestOptions = {},
): Promise<RequestOutcome<T>> {
  let outcome: { ok: true; value: T } | { ok: false; error: unknown } | undefined
  const handle = requestHandler(async () => {
    try {
      outcome = { ok: true, value: await body() }
    } catch (error) {
      // Rethrowing here would let h3 turn the failure into a 500 and swallow
      // it; the test wants the original error, after the response (and its
      // cookies) have been assembled.
      outcome = { ok: false, error }
    }
    return new Response('ok')
  })

  const headers = new Headers()
  if (opts.cookie !== undefined) headers.set('cookie', opts.cookie)
  if (opts.ip !== undefined) headers.set('cf-connecting-ip', opts.ip)
  const res = await handle(new Request(ORIGIN, { headers }), {})

  if (!outcome) throw new Error('the request handler never ran the body')
  if (!outcome.ok) throw outcome.error
  return { value: outcome.value, setCookie: res.headers.getSetCookie() }
}
