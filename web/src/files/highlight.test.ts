import { afterEach, describe, expect, it, vi } from 'vitest'

import { highlight } from './highlight'
import type { HighlightAnswer, HighlightAsk } from './highlight.worker'

// jsdom has no Worker global, so the first cases exercise the façade's
// same-thread path — the same code a browser without module workers runs.
describe('highlight', () => {
  it('highlights through the same-thread path when no worker exists', async () => {
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

class FakeWorker {
  static built: FakeWorker[] = []
  onmessage: ((e: { data: HighlightAnswer }) => void) | null = null
  onerror: (() => void) | null = null
  onmessageerror: (() => void) | null = null
  posted: HighlightAsk[] = []
  terminated = false
  constructor() {
    FakeWorker.built.push(this)
  }
  postMessage(m: HighlightAsk) {
    this.posted.push(m)
  }
  terminate() {
    this.terminated = true
  }
}

const lastWorker = () => FakeWorker.built[FakeWorker.built.length - 1]!

describe('highlight, through a worker', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('posts the ask and resolves on its answer', async () => {
    vi.stubGlobal('Worker', FakeWorker)
    const answer = highlight('let y = 2\n', 'typescript')
    const w = lastWorker()
    expect(w.posted[0]).toMatchObject({ text: 'let y = 2\n', lang: 'typescript' })
    w.onmessage!({ data: { id: w.posted[0]!.id, lines: [[{ text: 'let' }]] } })
    await expect(answer).resolves.toEqual([[{ text: 'let' }]])
    // Collapse the singleton so the next case gets a worker of its own.
    w.onerror!()
  })

  it('a worker fault answers every open ask null and discards the worker', async () => {
    vi.stubGlobal('Worker', FakeWorker)
    const first = highlight('a\n', 'typescript')
    const second = highlight('b\n', 'typescript')
    const w = lastWorker()
    expect(w.posted).toHaveLength(2)
    w.onmessageerror!()
    await expect(first).resolves.toBeNull()
    await expect(second).resolves.toBeNull()
    expect(w.terminated).toBe(true)
  })

  it('gives up on a worker that never answers, terminating it', async () => {
    vi.stubGlobal('Worker', FakeWorker)
    vi.useFakeTimers()
    const answer = highlight('c\n', 'typescript')
    const w = lastWorker()
    await vi.advanceTimersByTimeAsync(10_000)
    await expect(answer).resolves.toBeNull()
    expect(w.terminated).toBe(true)
  })
})
