import { Terminal } from '@xterm/xterm'
import { describe, expect, it } from 'vitest'

import { findPaths } from '@/lib/paths'
import { logicalLineAt, pathLinksAt } from './links'
import type { LinkDetector } from './types'

const filled = async (text: string, cols = 40) => {
  const term = new Terminal({ cols, rows: 6, allowProposedApi: true })
  await new Promise<void>((done) => term.write(text, done))
  return term
}

const yes: LinkDetector = {
  find: findPaths,
  verify: (paths) => Promise.resolve(paths.map(() => true)),
  open: () => {},
}

describe('logicalLineAt', () => {
  it('reads one unwrapped row, trailing blanks trimmed', async () => {
    const term = await filled('wrote internal/a.go here')
    expect(logicalLineAt(term, 1)?.text).toBe('wrote internal/a.go here')
  })

  it('assembles a soft-wrapped line from any of its rows', async () => {
    const long = 'wrote docs/superpowers/specs/2026-08-11-file-peek-design.md now'
    const term = await filled(long, 20)
    for (const row of [1, 2, 3]) {
      expect(logicalLineAt(term, row)?.text).toBe(long)
    }
  })

  it('does not leak across a hard newline', async () => {
    const term = await filled('first line\r\nsecond line')
    expect(logicalLineAt(term, 1)?.text).toBe('first line')
    expect(logicalLineAt(term, 2)?.text).toBe('second line')
  })

  it('answers null past the end of the buffer', async () => {
    const term = await filled('short')
    expect(logicalLineAt(term, 4000)).toBeNull()
  })

  it('maps text indices to cells across wide glyphs', async () => {
    const term = await filled('日本 internal/a.md')
    const line = logicalLineAt(term, 1)!
    const at = line.text.indexOf('internal')
    // Two wide glyphs occupy four cells, plus the space: column 6, 1-based.
    expect(line.cells[at]).toEqual({ x: 6, y: 1 })
  })
})

describe('pathLinksAt', () => {
  it('returns a link spanning the wrapped rows, range inclusive and 1-based', async () => {
    const long = 'at docs/superpowers/specs/2026-08-11-file-peek-design.md end'
    const term = await filled(long, 20)
    const links = await pathLinksAt(term, 2, yes)
    expect(links).toHaveLength(1)
    expect(links![0]!.range.start.y).toBe(1)
    expect(links![0]!.range.end.y).toBeGreaterThan(1)
    expect(links![0]!.text).toBe('docs/superpowers/specs/2026-08-11-file-peek-design.md')
  })

  it('offers nothing when verification says no', async () => {
    const term = await filled('maybe not/a/path.txt')
    const no = { ...yes, verify: (p: string[]) => Promise.resolve(p.map(() => false)) }
    expect(await pathLinksAt(term, 1, no)).toBeUndefined()
  })

  it('offers nothing for a line with no candidates, without asking', async () => {
    const term = await filled('nothing here resembles one')
    let asked = 0
    const counting = {
      ...yes,
      verify: (p: string[]) => {
        asked++
        return Promise.resolve(p.map(() => true))
      },
    }
    expect(await pathLinksAt(term, 1, counting)).toBeUndefined()
    expect(asked).toBe(0)
  })

  it('offers only the candidates that verified, spans intact', async () => {
    const term = await filled('real internal/a.go fake missing/b.go')
    const picky = {
      ...yes,
      verify: (p: string[]) => Promise.resolve(p.map((one) => one === 'internal/a.go')),
    }
    const links = await pathLinksAt(term, 1, picky)
    expect(links).toHaveLength(1)
    expect(links![0]!.text).toBe('internal/a.go')
    expect(links![0]!.range.start).toEqual({ x: 6, y: 1 })
    expect(links![0]!.range.end).toEqual({ x: 18, y: 1 })
  })

  it('activate hands the candidate, line number included, to open', async () => {
    const term = await filled('fell over at src/foo.ts:12 sadly')
    const caught: unknown[] = []
    const catching = { ...yes, open: (c: unknown) => caught.push(c) }
    const links = await pathLinksAt(term, 1, catching)
    links![0]!.activate(new MouseEvent('click'), links![0]!.text)
    expect(caught[0]).toMatchObject({ path: 'src/foo.ts', line: 12 })
  })
})
