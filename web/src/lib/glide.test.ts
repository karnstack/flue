import { describe, expect, it } from 'vitest'
import { startGlide } from './glide'

/** A hand-cranked animation frame loop. step() advances the clock. */
function frames() {
  const queue: Array<{ id: number; cb: (t: number) => void }> = []
  let nextId = 1
  let now = 0
  return {
    raf: (cb: (t: number) => void) => {
      const id = nextId++
      queue.push({ id, cb })
      return id
    },
    caf: (id: number) => {
      const at = queue.findIndex((f) => f.id === id)
      if (at >= 0) queue.splice(at, 1)
    },
    step(ms: number) {
      now += ms
      const due = queue.splice(0, queue.length)
      for (const f of due) f.cb(now)
    },
    pending: () => queue.length,
  }
}

describe('startGlide', () => {
  it('keeps scrolling after the finger lifts, in decaying whole lines', () => {
    const f = frames()
    let lines = 0
    startGlide({ velocity: 60, onLines: (n) => (lines += n), raf: f.raf, caf: f.caf })

    f.step(16) // first frame establishes the clock; no time has passed yet
    const after1 = lines
    for (let i = 0; i < 30; i++) f.step(16)
    const after31 = lines

    expect(after31).toBeGreaterThan(after1)
    // Half a second of 0.998^ms friction eats most of 60 lines/s: the total
    // lands well under what the starting velocity alone would cover…
    expect(after31).toBeLessThan(30)
    expect(after31).toBeGreaterThan(5)
  })

  it('carries fractions so slow glides still add up to whole lines', () => {
    const f = frames()
    let lines = 0
    startGlide({ velocity: 4, onLines: (n) => (lines += n), raf: f.raf, caf: f.caf })
    f.step(16)
    for (let i = 0; i < 30; i++) f.step(16)
    // 4 lines/s decaying over ~0.5s comes to about 1.25 lines, and every
    // single frame of it is 0.064 of a line: deliverable only by carry.
    expect(lines).toBeGreaterThanOrEqual(1)
  })

  it('emits only whole lines, never fractions', () => {
    const f = frames()
    const emitted: number[] = []
    startGlide({ velocity: 25, onLines: (n) => emitted.push(n), raf: f.raf, caf: f.caf })
    f.step(16)
    for (let i = 0; i < 10; i++) f.step(16)
    for (const n of emitted) expect(Number.isInteger(n)).toBe(true)
  })

  it('scrolls the other way for a negative velocity', () => {
    const f = frames()
    let lines = 0
    startGlide({ velocity: -60, onLines: (n) => (lines += n), raf: f.raf, caf: f.caf })
    f.step(16)
    for (let i = 0; i < 10; i++) f.step(16)
    expect(lines).toBeLessThan(0)
  })

  it('comes to rest on its own and stops asking for frames', () => {
    const f = frames()
    startGlide({ velocity: 10, onLines: () => {}, raf: f.raf, caf: f.caf })
    for (let i = 0; i < 400 && f.pending(); i++) f.step(16)
    expect(f.pending()).toBe(0)
  })

  it('cancel stops it mid-glide', () => {
    const f = frames()
    let lines = 0
    const cancel = startGlide({ velocity: 60, onLines: (n) => (lines += n), raf: f.raf, caf: f.caf })
    f.step(16)
    f.step(16)
    const before = lines
    cancel()
    f.step(16)
    f.step(16)
    expect(lines).toBe(before)
    expect(f.pending()).toBe(0)
  })

  it('declines a velocity too small to glide', () => {
    const f = frames()
    startGlide({ velocity: 0.2, onLines: () => {}, raf: f.raf, caf: f.caf })
    expect(f.pending()).toBe(0)
  })
})
