import { afterEach, describe, expect, it, vi } from 'vitest'
import { scrubPairingParams, stripHandoff, takeCwd } from './url'

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

describe('scrubPairingParams', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    history.replaceState(null, '', '/')
  })

  it('removes the token and the key from the address bar', () => {
    history.replaceState(null, '', '/pair?t=secret&k=daemonkey')
    scrubPairingParams()
    expect(location.pathname).toBe('/pair')
    expect(location.search).toBe('')
  })

  it('preserves the machine id and name beside them', () => {
    history.replaceState(null, '', '/pair?t=secret&k=daemonkey&d=blue-mesa&n=Blue%20Mesa')
    scrubPairingParams()
    expect(location.search).toBe('?d=blue-mesa&n=Blue+Mesa')
  })

  it('scrubs a key travelling without a token, and the reverse', () => {
    // A link that lost one of the pair in transit still carries the other,
    // and half the secrets in the history is not half the problem.
    history.replaceState(null, '', '/pair?k=daemonkey')
    scrubPairingParams()
    expect(location.search).toBe('')

    history.replaceState(null, '', '/pair?t=secret')
    scrubPairingParams()
    expect(location.search).toBe('')
  })

  it('removes every repetition of the parameters', () => {
    // URLSearchParams.delete removes all entries with the name, but a helper
    // that reached for get()/set() would leave the second copy behind.
    history.replaceState(null, '', '/pair?t=one&t=two&k=a&k=b')
    scrubPairingParams()
    expect(location.search).toBe('')
  })

  it('keeps the path and the fragment', () => {
    history.replaceState(null, '', '/pair?t=secret#top')
    scrubPairingParams()
    expect(location.pathname).toBe('/pair')
    expect(location.hash).toBe('#top')
    expect(location.search).toBe('')
  })

  it('leaves a URL without either parameter untouched', () => {
    // Not merely unchanged — untouched: TanStack's history patches
    // replaceState and re-parses the location on every call, so a rewrite
    // that rewrote nothing would still cost a router pass.
    history.replaceState(null, '', '/pair?d=blue-mesa')
    const replace = vi.spyOn(history, 'replaceState')
    scrubPairingParams()
    expect(replace).not.toHaveBeenCalled()
    expect(location.search).toBe('?d=blue-mesa')
  })

  it('is idempotent', () => {
    history.replaceState(null, '', '/pair?t=secret&k=daemonkey&d=blue-mesa')
    scrubPairingParams()
    const once = location.href
    scrubPairingParams()
    expect(location.href).toBe(once)
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
