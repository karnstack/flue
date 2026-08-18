import { describe, expect, it, vi } from 'vitest'

import type { PathEntry } from '@/client/protocol'
import { createPathDetector, VERIFY_HIT_MS, VERIFY_MISS_MS } from './detector'

const answering = (kind: 'file' | 'dir' | 'none') => {
  const stat = vi.fn(
    async (paths: string[]): Promise<PathEntry[]> =>
      paths.map((p) => (kind === 'none' ? { path: p, exists: false } : { path: p, exists: true, kind })),
  )
  return { stat }
}

describe('createPathDetector', () => {
  it('finds with the shared matcher and opens through the dep', () => {
    const caught: unknown[] = []
    const d = createPathDetector({ stat: async () => [], open: (c) => caught.push(c) })
    const [c] = d.find('at src/a.ts:3')
    d.open(c!)
    expect(caught[0]).toMatchObject({ path: 'src/a.ts', line: 3 })
  })

  it('verifies files true, everything else false', async () => {
    const files = createPathDetector({ stat: answering('file').stat, open: () => {} })
    await expect(files.verify(['a'])).resolves.toEqual([true])
    const dirs = createPathDetector({ stat: answering('dir').stat, open: () => {} })
    await expect(dirs.verify(['a'])).resolves.toEqual([false])
    const gone = createPathDetector({ stat: answering('none').stat, open: () => {} })
    await expect(gone.verify(['a'])).resolves.toEqual([false])
  })

  it('remembers a hit for thirty seconds, not longer', async () => {
    let t = 0
    const { stat } = answering('file')
    const d = createPathDetector({ stat, open: () => {}, now: () => t })
    await d.verify(['a'])
    t = VERIFY_HIT_MS - 1
    await expect(d.verify(['a'])).resolves.toEqual([true])
    expect(stat).toHaveBeenCalledTimes(1)
    t = VERIFY_HIT_MS + 1
    await d.verify(['a'])
    expect(stat).toHaveBeenCalledTimes(2)
  })

  it('forgets a miss after two seconds, so a file written moments later revives', async () => {
    let t = 0
    const { stat } = answering('none')
    const d = createPathDetector({ stat, open: () => {}, now: () => t })
    await d.verify(['a'])
    t = VERIFY_MISS_MS - 1
    await d.verify(['a'])
    expect(stat).toHaveBeenCalledTimes(1)
    t = VERIFY_MISS_MS + 1
    await d.verify(['a'])
    expect(stat).toHaveBeenCalledTimes(2)
  })

  it('sends one stat per hovered line, deduplicated', async () => {
    const { stat } = answering('file')
    const d = createPathDetector({ stat, open: () => {} })
    await expect(d.verify(['a', 'b', 'a'])).resolves.toEqual([true, true, true])
    expect(stat).toHaveBeenCalledTimes(1)
    expect(stat).toHaveBeenCalledWith(['a', 'b'])
  })

  it('splits past the protocol ceiling of 32 paths per stat', async () => {
    const { stat } = answering('file')
    const d = createPathDetector({ stat, open: () => {} })
    const many = Array.from({ length: 40 }, (_, i) => `p${i}`)
    await expect(d.verify(many)).resolves.toEqual(many.map(() => true))
    expect(stat).toHaveBeenCalledTimes(2)
    expect(stat.mock.calls[0]![0]).toHaveLength(32)
    expect(stat.mock.calls[1]![0]).toHaveLength(8)
  })

  it('answers all-false when stat rejects, and does not poison the cache', async () => {
    let broken = true
    const stat = vi.fn(async (paths: string[]): Promise<PathEntry[]> => {
      if (broken) throw new Error('flue: not connected')
      return paths.map((p) => ({ path: p, exists: true, kind: 'file' as const }))
    })
    const d = createPathDetector({ stat, open: () => {} })
    await expect(d.verify(['a'])).resolves.toEqual([false])
    broken = false
    await expect(d.verify(['a'])).resolves.toEqual([true])
  })
})
