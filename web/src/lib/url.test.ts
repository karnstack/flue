import { afterEach, describe, expect, it } from 'vitest'
import { stripHandoff, takeCwd } from './url'

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
