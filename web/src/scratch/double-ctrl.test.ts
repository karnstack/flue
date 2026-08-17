import { describe, expect, it } from 'vitest'

import { createDoubleCtrl, type DoubleCtrl } from './double-ctrl'

/** Drive the detector like a keyboard would, with a controllable clock. */
function rig(windowMs = 350) {
  let t = 0
  const chord = createDoubleCtrl({ windowMs, now: () => t })
  const at = (ms: number) => {
    t = ms
  }
  const down = (key: string, repeat = false) => chord.keydown({ key, repeat })
  const up = (key: string) => chord.keyup({ key })
  return { chord, at, down, up }
}

/** One bare Ctrl tap: press then release, both at the current clock. */
function tap(r: ReturnType<typeof rig>): boolean {
  r.down('Control')
  return r.up('Control')
}

describe('createDoubleCtrl', () => {
  it('fires on two bare taps inside the window', () => {
    const r = rig()
    expect(tap(r)).toBe(false)
    r.at(200)
    expect(tap(r)).toBe(true)
  })

  it('does not fire when the second press comes too late', () => {
    const r = rig(350)
    tap(r)
    r.at(400)
    expect(tap(r)).toBe(false)
    // But that late tap starts a fresh pair.
    r.at(500)
    expect(tap(r)).toBe(true)
  })

  it('never counts a real chord: Ctrl+C ends with a Ctrl keyup that must not be half a tap', () => {
    const r = rig()
    r.down('Control')
    r.down('c')
    r.up('c')
    expect(r.up('Control')).toBe(false)
    // One genuine tap after the chord is only ever the first of a pair.
    r.at(100)
    expect(tap(r)).toBe(false)
    r.at(200)
    expect(tap(r)).toBe(true)
  })

  it('is spoiled by any key between the taps', () => {
    const r = rig()
    tap(r)
    r.down('a')
    r.up('a')
    r.at(100)
    expect(tap(r)).toBe(false)
  })

  it('cancels a second press that turns into a chord', () => {
    const r = rig()
    tap(r)
    r.at(100)
    r.down('Control')
    r.down('c') // tap, then Ctrl+C: an interrupt, not a chord completion
    r.up('c')
    expect(r.up('Control')).toBe(false)
  })

  it('ignores auto-repeat of a held Ctrl', () => {
    const r = rig()
    tap(r)
    r.at(100)
    r.down('Control')
    r.down('Control', true)
    r.down('Control', true)
    expect(r.up('Control')).toBe(true)
  })

  it('proves nothing from a release it never saw pressed', () => {
    const r = rig()
    tap(r)
    r.at(100)
    // Focus came back mid-hold: keyup with no keydown behind it.
    expect(r.up('Control')).toBe(false)
  })

  it('forgets everything on reset', () => {
    const r = rig()
    tap(r)
    r.chord.reset()
    r.at(100)
    expect(tap(r)).toBe(false)
    r.at(200)
    expect(tap(r)).toBe(true)
  })

  it('keeps firing on later pairs', () => {
    const r = rig()
    tap(r)
    r.at(100)
    expect(tap(r)).toBe(true)
    r.at(300)
    tap(r)
    r.at(400)
    expect(tap(r)).toBe(true)
  })
})

// The type is exported for the provider; keep the import honest.
const _typecheck: DoubleCtrl = createDoubleCtrl()
void _typecheck
