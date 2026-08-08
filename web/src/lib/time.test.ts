import { describe, expect, it } from 'vitest'

import { ago } from './time'

/** A fixed instant, in ms as `Date.now` hands it over. */
const NOW = 1_760_000_000_000

/** The unix-seconds stamp of a moment `secs` before NOW. */
const at = (secs: number) => NOW / 1000 - secs

describe('ago', () => {
  it('calls anything under a minute just now', () => {
    expect(ago(at(0), NOW)).toBe('just now')
    expect(ago(at(59), NOW)).toBe('just now')
  })

  it('counts minutes under an hour', () => {
    expect(ago(at(60), NOW)).toBe('1m ago')
    expect(ago(at(59 * 60), NOW)).toBe('59m ago')
  })

  it('counts hours under a day', () => {
    expect(ago(at(60 * 60), NOW)).toBe('1h ago')
    expect(ago(at(23 * 60 * 60), NOW)).toBe('23h ago')
  })

  it('counts days beyond that', () => {
    expect(ago(at(24 * 60 * 60), NOW)).toBe('1d ago')
    expect(ago(at(9 * 24 * 60 * 60), NOW)).toBe('9d ago')
  })

  it('clamps a stamp from the future to just now', () => {
    // Clock skew between two machines is ordinary; "-2m ago" is not.
    expect(ago(at(-120), NOW)).toBe('just now')
  })

  it('reads the clock itself when no instant is given', () => {
    expect(ago(Date.now() / 1000 - 300)).toBe('5m ago')
  })
})
