import { beforeEach, describe, expect, it, vi } from 'vitest'

import { forgetVisit, listRecents, recordVisit, RECENTS_CAP, visitKey } from './recents'

const KEY = 'flue.switcher.recents'

/** One visit, with everything a case does not care about filled in. */
function visit(over: Partial<Parameters<typeof recordVisit>[0]> = {}) {
  return {
    machineId: 'local',
    machineName: 'macbook',
    sessionId: 's1',
    label: 'pnpm build',
    cwd: '/home/karn/flue/web',
    ...over,
  }
}

/** What is actually in storage, unvalidated. */
function stored(): unknown {
  return JSON.parse(localStorage.getItem(KEY) ?? 'null')
}

describe('recents', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('remembers nothing in a browser that has been nowhere', () => {
    expect(listRecents()).toEqual([])
  })

  it('hands a visit back with everything the row will need to draw itself', () => {
    recordVisit(visit())
    const [row] = listRecents()
    expect(row).toMatchObject({
      machineId: 'local',
      machineName: 'macbook',
      sessionId: 's1',
      label: 'pnpm build',
      cwd: '/home/karn/flue/web',
    })
    expect(typeof row?.visitedAt).toBe('string')
  })

  it('reads newest first', () => {
    recordVisit(visit({ sessionId: 's1' }))
    recordVisit(visit({ sessionId: 's2' }))
    recordVisit(visit({ sessionId: 's3' }))
    expect(listRecents().map((v) => v.sessionId)).toEqual(['s3', 's2', 's1'])
  })

  it('moves a revisited session to the front rather than doubling it', () => {
    recordVisit(visit({ sessionId: 's1' }))
    recordVisit(visit({ sessionId: 's2' }))
    recordVisit(visit({ sessionId: 's1' }))
    expect(listRecents().map((v) => v.sessionId)).toEqual(['s1', 's2'])
  })

  it('refreshes the description on the way past, so a rename shows', () => {
    recordVisit(visit({ label: 'zsh' }))
    recordVisit(visit({ label: 'the build one' }))
    expect(listRecents()[0]?.label).toBe('the build one')
  })

  it('tells two machines’ sessions apart though they share an id', () => {
    recordVisit(visit({ machineId: 'local', sessionId: 's1' }))
    recordVisit(visit({ machineId: 'studio', sessionId: 's1' }))
    expect(listRecents().map(visitKey)).toEqual(['studio/s1', 'local/s1'])
  })

  it('keeps the cap, dropping the oldest', () => {
    for (let i = 0; i <= RECENTS_CAP; i++) recordVisit(visit({ sessionId: `s${i}` }))
    const kept = listRecents()
    expect(kept).toHaveLength(RECENTS_CAP)
    expect(kept[0]?.sessionId).toBe(`s${RECENTS_CAP}`)
    expect(kept.map((v) => v.sessionId)).not.toContain('s0')
  })

  it('forgets one session and leaves the rest', () => {
    recordVisit(visit({ sessionId: 's1' }))
    recordVisit(visit({ sessionId: 's2' }))
    forgetVisit({ machineId: 'local', sessionId: 's1' })
    expect(listRecents().map((v) => v.sessionId)).toEqual(['s2'])
  })

  it('forgets a session it never knew without complaint', () => {
    recordVisit(visit({ sessionId: 's1' }))
    forgetVisit({ machineId: 'local', sessionId: 'never' })
    expect(listRecents()).toHaveLength(1)
  })

  it('reads a document that is not JSON as no visits at all', () => {
    localStorage.setItem(KEY, 'not json {')
    expect(listRecents()).toEqual([])
  })

  it('reads a document that is not an array the same way', () => {
    localStorage.setItem(KEY, JSON.stringify({ machineId: 'local' }))
    expect(listRecents()).toEqual([])
  })

  it('drops one mangled row and keeps the readable ones beside it', () => {
    localStorage.setItem(
      KEY,
      JSON.stringify([
        { ...visit({ sessionId: 's1' }), visitedAt: '2026-08-01T00:00:00Z' },
        { machineId: 'local' },
        { ...visit({ sessionId: 's2' }), visitedAt: '2026-08-02T00:00:00Z' },
      ]),
    )
    expect(listRecents().map((v) => v.sessionId)).toEqual(['s1', 's2'])
  })

  it('reads a store that somehow holds one session twice as one row', () => {
    const row = { ...visit(), visitedAt: '2026-08-01T00:00:00Z' }
    localStorage.setItem(KEY, JSON.stringify([row, row]))
    expect(listRecents()).toHaveLength(1)
  })

  it('survives a browser that refuses to read storage', () => {
    const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('denied')
    })
    expect(listRecents()).toEqual([])
    get.mockRestore()
  })

  it('survives a browser that refuses to write, and says nothing', () => {
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota')
    })
    expect(() => recordVisit(visit())).not.toThrow()
    set.mockRestore()
    expect(stored()).toBeNull()
  })
})
