import { describe, expect, it } from 'vitest'

import { highlight } from './highlight'

// jsdom has no Worker global, so these exercise the façade's inline path —
// the same code a browser without module workers would run.
describe('highlight', () => {
  it('highlights through the inline path when no worker exists', async () => {
    const lines = await highlight('const x = 1\n', 'typescript')
    expect(lines!.flat().some((t) => t.light !== undefined)).toBe(true)
  })

  it('answers null for a null language without loading anything', async () => {
    expect(await highlight('text', null)).toBeNull()
  })

  it('answers null for an unknown language', async () => {
    expect(await highlight('text', 'made-up-lang')).toBeNull()
  })
})
