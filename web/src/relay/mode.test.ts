import { describe, expect, it } from 'vitest'

import { isRelayOrigin } from './mode'

describe('isRelayOrigin', () => {
  it('is false on every host the daemon serves the app from itself', () => {
    // The daemon binds loopback and nothing else, so these three hostnames are
    // the complete list of ways a page can have come from it.
    for (const hostname of ['127.0.0.1', 'localhost', '[::1]']) {
      expect(isRelayOrigin({ hostname })).toBe(false)
    }
  })

  it('is true on a host the daemon could not have been', () => {
    expect(isRelayOrigin({ hostname: 'flue-relay.example.workers.dev' })).toBe(true)
    expect(isRelayOrigin({ hostname: 'flue.sh' })).toBe(true)
  })
})
