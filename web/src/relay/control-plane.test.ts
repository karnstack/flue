import { describe, expect, it, vi } from 'vitest'
import { RELAY_TOKEN_PATH, refreshClientToken } from './control-plane'

const APP = 'https://app.flue.sh'

/** A `fetch` that records what it was asked and answers what it was given. */
function fakeFetch(answer: Response | Error) {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const doFetch = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    if (answer instanceof Error) throw answer
    return answer
  })
  return { doFetch, calls }
}

const ok = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })

describe('refreshClientToken', () => {
  it('posts the device id to the control plane and returns the token', async () => {
    const { doFetch, calls } = fakeFetch(ok({ token: 'a-fresh-token' }))

    expect(await refreshClientToken(APP, 'b5d05f15398a', doFetch)).toBe('a-fresh-token')

    const call = calls[0]!
    expect(call.url).toBe(`${APP}${RELAY_TOKEN_PATH}`)
    expect(call.init.method).toBe('POST')
    expect(call.init.body).toBe('deviceId=b5d05f15398a')
  })

  it('sends the session cookie, which is the whole credential', async () => {
    // Without `credentials: 'include'` a cross-origin fetch carries no cookie
    // and every refresh is a 401 — the failure this whole path exists to stop.
    const { doFetch, calls } = fakeFetch(ok({ token: 't' }))
    await refreshClientToken(APP, 'b5d05f15398a', doFetch)
    expect(calls[0]!.init.credentials).toBe('include')
  })

  it('asks in the one shape that costs no preflight', async () => {
    // Form-encoded with no custom header is a "simple" request in CORS terms,
    // so the browser sends it straight out. JSON would add an OPTIONS round
    // trip to every reconnect.
    const { doFetch, calls } = fakeFetch(ok({ token: 't' }))
    await refreshClientToken(APP, 'b5d05f15398a', doFetch)

    const headers = calls[0]!.init.headers as Record<string, string>
    expect(headers).toEqual({ 'content-type': 'application/x-www-form-urlencoded' })
  })

  it('never follows a redirect', async () => {
    // A signed-out document gets a redirect to /login. Following one here
    // would parse an HTML sign-in page looking for a token.
    const { doFetch, calls } = fakeFetch(ok({ token: 't' }))
    await refreshClientToken(APP, 'b5d05f15398a', doFetch)
    expect(calls[0]!.init.redirect).toBe('error')
  })

  it('throws for every refusal, so the socket reports an ordinary close', async () => {
    for (const status of [401, 403, 429, 500]) {
      const { doFetch } = fakeFetch(new Response('{"error":"no"}', { status }))
      await expect(refreshClientToken(APP, 'b5d05f15398a', doFetch)).rejects.toThrow()
    }
  })

  it('throws when the answer carries no token', async () => {
    for (const body of [{}, { token: '' }, { token: 42 }]) {
      const { doFetch } = fakeFetch(ok(body))
      await expect(refreshClientToken(APP, 'b5d05f15398a', doFetch)).rejects.toThrow()
    }
  })

  it('refuses a token that could not be a subprotocol value', async () => {
    // It rides in `Sec-WebSocket-Protocol` as `flue.token.<token>`, and
    // `new WebSocket` raises a *synchronous* SyntaxError for a value that is
    // not an HTTP token. Refusing here is a close the socket recovers from;
    // passing it on is a throw at the dial.
    for (const token of ['has a space', 'has,a,comma', 'new\nline', 'a'.repeat(5000)]) {
      const { doFetch } = fakeFetch(ok({ token }))
      await expect(refreshClientToken(APP, 'b5d05f15398a', doFetch)).rejects.toThrow()
    }
  })

  it('gives up rather than hanging forever', async () => {
    // A fetch has no timeout of its own, and a promise that never settles is
    // worse than one that fails: the socket then never dials *and never
    // closes*, so FlueClient parks at `reconnecting` with no retry armed.
    const { doFetch, calls } = fakeFetch(ok({ token: 't' }))
    await refreshClientToken(APP, 'b5d05f15398a', doFetch)
    expect(calls[0]!.init.signal).toBeInstanceOf(AbortSignal)
  })

  it('throws when the control plane cannot be reached at all', async () => {
    const { doFetch } = fakeFetch(new Error('network down'))
    await expect(refreshClientToken(APP, 'b5d05f15398a', doFetch)).rejects.toThrow()
  })
})
