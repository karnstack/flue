import { afterEach, describe, expect, it } from 'vitest'
import { stripHandoff, takeCwd, takeRelayHandoff } from './url'

describe('stripHandoff', () => {
  it('removes the handoff token', () => {
    expect(stripHandoff('http://127.0.0.1:7717/?h=secret')).toBe('http://127.0.0.1:7717/')
  })

  it('preserves other parameters', () => {
    expect(stripHandoff('http://127.0.0.1:7717/?h=secret&cwd=%2Ftmp')).toBe(
      'http://127.0.0.1:7717/?cwd=%2Ftmp',
    )
  })

  it('leaves a URL without a handoff token untouched', () => {
    expect(stripHandoff('http://127.0.0.1:7717/d/local/s/abc')).toBe(
      'http://127.0.0.1:7717/d/local/s/abc',
    )
  })

  it('keeps the path and the fragment', () => {
    expect(stripHandoff('http://127.0.0.1:7717/d/local/s/abc?h=secret#top')).toBe(
      'http://127.0.0.1:7717/d/local/s/abc#top',
    )
  })

  it('removes every repetition of the parameter', () => {
    // URLSearchParams.delete removes all entries with the name, but a helper
    // that reached for get()/set() would leave the second copy behind.
    expect(stripHandoff('http://127.0.0.1:7717/?h=one&h=two')).toBe('http://127.0.0.1:7717/')
  })

  it('removes a handoff parameter with an empty value', () => {
    expect(stripHandoff('http://127.0.0.1:7717/?h=')).toBe('http://127.0.0.1:7717/')
  })

  it('is idempotent', () => {
    const once = stripHandoff('http://127.0.0.1:7717/?h=secret&cwd=%2Ftmp')
    expect(stripHandoff(once)).toBe(once)
  })
})

describe('takeCwd', () => {
  afterEach(() => history.replaceState(null, '', '/'))

  it('returns the cwd and strips it from the URL', () => {
    history.replaceState(null, '', '/?cwd=%2FUsers%2Fkarn%2Fcode%2Fflue&other=1')

    expect(takeCwd()).toBe('/Users/karn/code/flue')
    expect(location.search).toBe('?other=1')
  })

  it('returns null when there is nothing to take', () => {
    history.replaceState(null, '', '/')
    expect(takeCwd()).toBeNull()
  })

  it('takes it exactly once', () => {
    history.replaceState(null, '', '/?cwd=%2Ftmp')
    expect(takeCwd()).toBe('/tmp')
    expect(takeCwd()).toBeNull()
  })
})

describe('takeRelayHandoff', () => {
  /** What app.flue.sh navigates here with; see openSession. */
  const FRAGMENT = '#t=a-channel-token&k=a-daemon-key&d=b5d05f15398a&a=https%3A%2F%2Fapp.flue.sh'

  afterEach(() => history.replaceState(null, '', '/'))

  it('reads the whole handoff out of the fragment and scrubs it', () => {
    // A fragment is never put on the wire, so the credential reaches this page
    // and no server's log (app/src/server/devices.ts, openSession). What a
    // fragment does not fix is the history entry, the bookmark and the
    // screenshot — this does.
    history.replaceState(null, '', `/${FRAGMENT}`)

    expect(takeRelayHandoff()).toEqual({
      token: 'a-channel-token',
      daemonKey: 'a-daemon-key',
      deviceId: 'b5d05f15398a',
      controlPlane: 'https://app.flue.sh',
    })
    expect(location.hash).toBe('')
    expect(location.href).not.toContain('a-channel-token')
  })

  it('scrubs the machine’s identity too, not only the secret', () => {
    // `d` and `k` are not credentials, but a leftover `#d=…&k=…` is the address
    // of somebody's machine sitting in the address bar of every screenshot —
    // and a URL that still carried them would look re-openable long after the
    // token it needs expired.
    history.replaceState(null, '', `/${FRAGMENT}`)
    takeRelayHandoff()
    expect(location.href).not.toContain('b5d05f15398a')
    expect(location.href).not.toContain('a-daemon-key')
    expect(location.href).not.toContain('app.flue.sh')
  })

  it('takes it exactly once', () => {
    history.replaceState(null, '', `/${FRAGMENT}`)
    expect(takeRelayHandoff()).not.toBeNull()
    expect(takeRelayHandoff()).toBeNull()
  })

  it('never reads any of it from the query string', () => {
    // There is no `?t=` and there must not be one: a query parameter is on the
    // wire and in the relay's logs, which is the whole reason the token is in
    // the fragment. A fallback "just in case" would re-open it.
    history.replaceState(null, '', '/?t=a-channel-token&k=key&d=dev&a=https://app.flue.sh')
    expect(takeRelayHandoff()).toBeNull()
    expect(location.search).toContain('t=a-channel-token')
  })

  it('returns null and touches nothing when there is no handoff', () => {
    history.replaceState(null, '', '/d/local/s/abc?x=1#somewhere')
    expect(takeRelayHandoff()).toBeNull()
    expect(location.hash).toBe('#somewhere')
    expect(location.search).toBe('?x=1')
  })

  it('keeps the path, the query and any other fragment parameter', () => {
    history.replaceState(null, '', `/d/local/s/abc?x=1${FRAGMENT}&other=2`)

    expect(takeRelayHandoff()?.token).toBe('a-channel-token')
    expect(location.pathname).toBe('/d/local/s/abc')
    expect(location.search).toBe('?x=1')
    expect(location.hash).toBe('#other=2')
  })

  it('is null for a partial handoff, and scrubs what arrived anyway', () => {
    // Three of the four is not a session: it can only fail later, further from
    // the thing that was wrong. The spent-looking parameters still go.
    for (const partial of [
      '#t=tok',
      '#t=tok&k=key',
      '#t=tok&k=key&d=b5d05f15398a',
      '#k=key&d=b5d05f15398a&a=https%3A%2F%2Fapp.flue.sh',
      '#t=&k=key&d=b5d05f15398a&a=https%3A%2F%2Fapp.flue.sh',
    ]) {
      history.replaceState(null, '', `/${partial}`)
      expect(takeRelayHandoff()).toBeNull()
      expect(location.hash).toBe('')
    }
  })
})
