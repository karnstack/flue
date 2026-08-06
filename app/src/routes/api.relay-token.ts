// POST /api/relay-token — the wire for `server/refresh-token.ts`.
//
// The policy is in that file, including why this endpoint exists at all and
// why it is the only cross-origin door in the control plane. This file is the
// wire, and a wire on a CORS path has four jobs it can get wrong.
//
// **The origin allowlist, before anything else.** Exactly two origins are
// answered: this service's own, and the relay's (derived from `RELAY_URL`). A
// request naming any other — or naming none — gets 403 with no CORS headers on
// it at all, so the browser cannot read the refusal either. This runs ahead of
// the session read on purpose: it is the CSRF guard for a path the global CSRF
// middleware does not cover (src/start.ts filters on `handlerType ===
// 'serverFn'`, and this is a server route), and `SameSite=Lax` does not cover
// it either, because a sibling subdomain is same-*site* and its POST would
// arrive carrying a live session cookie.
//
// **`Access-Control-Allow-Origin` is one exact origin, never `*` and never a
// reflection of whatever asked.** With `Allow-Credentials: true` a wildcard is
// not merely lax, it is rejected by the browser — so the shape someone reaches
// for when "CORS does not work" is the shape that cannot work. `Vary: Origin`
// rides along on every answer, including the refusals, so nothing between here
// and the browser can hand one origin's allowance to another.
//
// **The preflight is answered narrowly.** `OPTIONS` succeeds only for an
// allowed origin asking about `POST`; anything else is the same 403.
//
// **The refusal shape.** Every failure is JSON with a status, and nothing here
// throws: an uncaught throw is Start's error path, and drizzle raises a failed
// statement as `Failed query: <SQL>\nparams: <every bound value>` — which on
// this path is the account id and the device id. Logged where it is useful,
// answered with a fixed string. Same treatment routes/enroll.tsx gives the
// daemon endpoints, for the same reason.
import { createFileRoute } from '@tanstack/react-router'
import {
  RefreshRefused,
  refreshClientToken,
  relayBrowserOrigin,
} from '../server/refresh-token'

/** A device id is 12 hex characters; nothing longer is worth reading. */
const MAX_DEVICE_ID = 64

/**
 * The longest body this endpoint will parse.
 *
 * `deviceId=<12 hex>` is 21 bytes. The bound is here because the parse happens
 * before the session is read — it has to, the device id is what the session is
 * then checked against — so without it an `Origin` header (trivially set by
 * anything that is not a browser) buys a full `formData()` of whatever the
 * caller felt like sending. 1 KiB is fifty times the real body and nothing at
 * all to refuse.
 *
 * **A body that declares no length is refused rather than read.** The bound is
 * `Content-Length`, and a *missing* header is not a zero-length body — it is a
 * body sent with `Transfer-Encoding: chunked`, whose length is not knowable
 * until it has been read, which is the one thing this must not do. Reading the
 * absence as zero would have been a bound that every caller it exists for could
 * step around: a browser always declares the length of a form body, so anything
 * streaming one here is by construction not the client this endpoint is for.
 */
const MAX_BODY_BYTES = 1024

/**
 * The declared length of a request body, or null if it did not declare one.
 *
 * Parsed strictly rather than with `Number`, which reads `''` as 0, `' 12'` as
 * 12 and `'1e3'` as 1000 — none of which is a byte count, and the first of
 * which is the bypass this whole function exists to close. A byte count is
 * digits.
 */
function declaredLength(request: Request): number | null {
  const raw = request.headers.get('content-length')
  if (raw === null || !/^\d+$/.test(raw)) return null
  return Number(raw)
}

/** How long a browser may cache the preflight. Ten minutes; nothing here
 *  changes between deploys, and a longer window outlives a rollback. */
const PREFLIGHT_MAX_AGE = '600'

/**
 * The origin to answer, or null.
 *
 * Two are allowed and they are allowed for different reasons. The relay's,
 * because that is where the tab that needs a token lives. This service's own,
 * because a same-origin request is not a cross-origin request at all, and a
 * check that only knew about the relay would refuse the dashboard the day
 * something on it needs a token.
 *
 * A missing `Origin` is refused rather than waved through. Every browser sends
 * one on a `fetch` with a method other than GET/HEAD, so absence here means a
 * client that is not the one this endpoint is for — and "no origin" is exactly
 * what a stripped or proxied request looks like.
 *
 * `relayBrowserOrigin()` throws when `RELAY_URL` is unset. That is a
 * misconfigured deployment, and refusing is the right answer: the mint would
 * fail a line later anyway, and a 403 says "not allowed" rather than leaking
 * that the service cannot configure itself.
 */
function allowedOrigin(request: Request): string | null {
  const origin = request.headers.get('origin')
  if (!origin) return null
  if (origin === new URL(request.url).origin) return origin
  try {
    return origin === relayBrowserOrigin() ? origin : null
  } catch (err) {
    console.error('relay-token: cannot resolve the relay origin', err)
    return null
  }
}

/** A JSON answer for an allowed origin, with the credentialed CORS pair. */
function allow(origin: string, body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      'access-control-allow-origin': origin,
      'access-control-allow-credentials': 'true',
      vary: 'Origin',
      // The 200 carries a bearer credential. Nothing may hold a copy: not a
      // browser cache, not a proxy, not the back button.
      'cache-control': 'no-store',
    },
  })
}

/**
 * The refusal for an origin this endpoint does not answer.
 *
 * No CORS headers, so a page on that origin cannot read this either — and the
 * body says nothing but the word. `Vary: Origin` is still here: the answer
 * really does depend on the header, and a cache that missed that could serve
 * this refusal to the relay.
 */
function forbiddenOrigin(): Response {
  return new Response(JSON.stringify({ error: 'forbidden' }), {
    status: 403,
    headers: { 'content-type': 'application/json', vary: 'Origin' },
  })
}

export const Route = createFileRoute('/api/relay-token')({
  server: {
    handlers: {
      /**
       * The preflight. A browser only sends one when the request is not
       * "simple" — the tab's POST is form-encoded with no custom headers, so in
       * practice it skips this — but an endpoint that answers no preflight is
       * one that breaks the moment a caller adds a header, and a preflight
       * answered without an origin check is a hole that never shows up in
       * testing.
       */
      OPTIONS: ({ request }) => {
        const origin = allowedOrigin(request)
        if (!origin) return forbiddenOrigin()
        if (request.headers.get('access-control-request-method') !== 'POST') {
          return forbiddenOrigin()
        }
        return new Response(null, {
          status: 204,
          headers: {
            'access-control-allow-origin': origin,
            'access-control-allow-credentials': 'true',
            'access-control-allow-methods': 'POST',
            'access-control-allow-headers': 'content-type',
            'access-control-max-age': PREFLIGHT_MAX_AGE,
            vary: 'Origin',
          },
        })
      },

      /**
       * A fresh channel token for the named machine, as the tab's session.
       *
       * The body is form-encoded, which is not an accident: it is one of the
       * three content types CORS treats as safelisted, so the tab's request is
       * "simple" and costs no preflight round trip on every reconnect. JSON
       * would cost one.
       */
      POST: async ({ request }) => {
        const origin = allowedOrigin(request)
        if (!origin) return forbiddenOrigin()

        // Before the body is touched, and both halves matter. A request that
        // declares no length at all is refused outright — see MAX_BODY_BYTES;
        // that is the streamed body whose size cannot be known in advance. A
        // `Content-Length` a caller lied *downward* about is not a problem
        // here: what the second check rules out is the honest oversized body,
        // and Workers caps the rest.
        //
        // 411 rather than 413 for the first, because nothing about that request
        // is too large — it simply never said, and `Length Required` is exactly
        // the answer HTTP defines for refusing it on those grounds.
        const declared = declaredLength(request)
        if (declared === null) {
          return allow(origin, { error: 'That request must declare its length.' }, 411)
        }
        if (declared > MAX_BODY_BYTES) {
          return allow(origin, { error: 'That request was too large.' }, 413)
        }

        let deviceId = ''
        try {
          const form = await request.formData()
          const raw = form.get('deviceId')
          if (typeof raw === 'string' && raw.length <= MAX_DEVICE_ID) deviceId = raw
        } catch {
          // A body that is not form-encoded. Falls through as `''`, which the
          // mint refuses without a query — the same answer a bad device id
          // gets, which is the answer it should get.
        }

        try {
          return allow(origin, await refreshClientToken(deviceId), 200)
        } catch (err) {
          if (err instanceof RefreshRefused) {
            return allow(origin, { error: err.message }, err.status)
          }
          console.error('relay-token: unexpected failure', err)
          return allow(origin, { error: 'A token could not be issued. Try again in a moment.' }, 500)
        }
      },

      /**
       * Everything else, including GET.
       *
       * A credential-minting endpoint that answered a GET would be one an
       * `<img src>` could reach, and one a browser would happily prefetch.
       */
      ANY: () =>
        new Response(JSON.stringify({ error: 'method not allowed' }), {
          status: 405,
          headers: { 'content-type': 'application/json', allow: 'POST, OPTIONS' },
        }),
    },
  },
})
