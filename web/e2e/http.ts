/*
 * The one HTTP client this harness uses, over node:http and node:https.
 *
 * Node's global `fetch` cannot be told about a certificate authority at
 * runtime — `NODE_EXTRA_CA_CERTS` is read once, at process start, and the
 * harness mints its throwaway CA long after that — and the local relay is
 * served over TLS because `flue relay join` refuses anything else. So every
 * request goes through here, where `ca` is just an option.
 *
 * The answer is deliberately the narrow shape the web modules declare they
 * read: `DirectoryAnswer` in web/src/relay/directory.ts is `{ ok, status,
 * text() }` and nothing more, and `EnrolPost` in web/src/fleet/enrol.ts
 * returns the same. Those interfaces exist so a test can answer without a
 * Response implementation, and this is a test answering without one — with
 * headers alongside, because two of the facts worth asserting here are
 * headers (the relay's missing `Access-Control-Allow-Origin`, and the
 * daemon's Content-Security-Policy).
 *
 * It is emphatically *not* a browser. It does not enforce CORS, it does not
 * enforce CSP, and it attaches no credentials on its own. Where those matter
 * the harness asserts the headers a browser would decide on, and says so.
 */
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'

export interface Answer {
  ok: boolean
  status: number
  headers: Record<string, string>
  text(): Promise<string>
  body: string
}

export interface RequestOptions {
  method?: string
  headers?: Record<string, string>
  body?: string
  /** A PEM to trust for this request, for the harness's own relay. */
  ca?: string
}

/** One request, resolved when the whole body has arrived. */
export function request(url: string, opts: RequestOptions = {}): Promise<Answer> {
  const target = new URL(url)
  const send = target.protocol === 'https:' ? httpsRequest : httpRequest
  return new Promise((resolve, reject) => {
    const req = send(
      target,
      {
        method: opts.method ?? 'GET',
        headers: opts.headers ?? {},
        ...(opts.ca !== undefined && { ca: opts.ca }),
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => {
          const status = res.statusCode ?? 0
          const body = Buffer.concat(chunks).toString('utf8')
          const headers: Record<string, string> = {}
          for (const [k, v] of Object.entries(res.headers)) {
            if (typeof v === 'string') headers[k.toLowerCase()] = v
            else if (Array.isArray(v)) headers[k.toLowerCase()] = v.join(', ')
          }
          resolve({
            ok: status >= 200 && status < 300,
            status,
            headers,
            body,
            text: () => Promise.resolve(body),
          })
        })
      },
    )
    req.on('error', reject)
    if (opts.body !== undefined) req.write(opts.body)
    req.end()
  })
}
