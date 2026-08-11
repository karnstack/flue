import { describe, expect, it } from 'vitest'

import { findPaths, MAX_CANDIDATES } from './paths'

/** Just the paths, for the cases where the offsets are not the point. */
const paths = (line: string) => findPaths(line).map((c) => c.path)

describe('findPaths', () => {
  it('takes the four shapes a path appears in', () => {
    expect(paths('wrote /etc/hosts')).toEqual(['/etc/hosts'])
    expect(paths('see ~/.claude/settings.json')).toEqual(['~/.claude/settings.json'])
    expect(paths('run ./scripts/build.sh')).toEqual(['./scripts/build.sh'])
    expect(paths('and ../sibling/main.go')).toEqual(['../sibling/main.go'])
    expect(paths('edited internal/wire/binary.go')).toEqual(['internal/wire/binary.go'])
    expect(paths('check CLAUDE.md')).toEqual(['CLAUDE.md'])
  })

  it('leaves a bare word alone', () => {
    // The one shape that must not match, because it is most of every line.
    expect(paths('I have written the new parser and it works')).toEqual([])
  })

  it('strips the punctuation a sentence puts after a path', () => {
    expect(paths('in src/main.ts.')).toEqual(['src/main.ts'])
    expect(paths('see (src/main.ts) for it')).toEqual(['src/main.ts'])
    expect(paths('"src/main.ts", then')).toEqual(['src/main.ts'])
    expect(paths('at src/main.ts; then')).toEqual(['src/main.ts'])
    expect(paths('[src/main.ts]')).toEqual(['src/main.ts'])
  })

  it('reads a line and column suffix off the end', () => {
    // toStrictEqual, not toEqual: toEqual counts an explicit `col: undefined`
    // as equal to no `col` at all, so it would pass a candidate that carries
    // the key with nothing in it, which is what goes on the wire.
    expect(findPaths('src/main.ts:42')).toStrictEqual([
      { path: 'src/main.ts', start: 0, end: 14, line: 42 },
    ])
    expect(findPaths('src/main.ts:42:7')).toStrictEqual([
      { path: 'src/main.ts', start: 0, end: 16, line: 42, col: 7 },
    ])
    // A trailing colon is punctuation, not an empty suffix.
    expect(paths('src/main.ts:')).toEqual(['src/main.ts'])
  })

  it('drops a position too large to be one, and keeps the path', () => {
    // Number gives 1e+22 for this, which JSON.stringify writes as a number no
    // daemon can seek to, and enough more digits reach Infinity, which it
    // writes as null. Opening at the top beats opening at either.
    expect(findPaths('src/a.ts:9999999999999999999999')).toStrictEqual([
      { path: 'src/a.ts', start: 0, end: 31 },
    ])
    expect(findPaths(`src/a.ts:${'9'.repeat(31)}`)).toStrictEqual([
      { path: 'src/a.ts', start: 0, end: 40 },
    ])
    // The column goes on its own, and a real line beside it survives.
    expect(findPaths('src/a.ts:12:9999999999999999999999')).toStrictEqual([
      { path: 'src/a.ts', start: 0, end: 34, line: 12 },
    ])
  })

  it('underlines the suffix along with the path', () => {
    // The range covers the whole thing a reader would click, so clicking the
    // ":42" opens the file at line 42 rather than doing nothing.
    const [only] = findPaths('at src/main.ts:42 today')
    expect(only).toMatchObject({ start: 3, end: 17 })
  })

  it('leaves URLs to the link addon that already owns them', () => {
    expect(paths('https://example.com/a/b')).toEqual([])
    expect(paths('git+ssh://host/repo.git')).toEqual([])
  })

  it('leaves the inside of a URL alone, where a token no longer looks like one', () => {
    // A query string is built from the characters that end a token, so each of
    // these reaches the shape test as a piece with no scheme on it and every
    // mark of a path. Only the whole line says otherwise, and the whole line is
    // what the addon is already underlining.
    expect(paths('https://x.com/search?q=src/main.ts')).toEqual([])
    expect(paths('https://x.com/a?next=/etc/hosts')).toEqual([])
    expect(paths('https://x.com/a,b/c.ts')).toEqual([])
    // And a link ends at a space, so the rest of the line is still read.
    expect(paths('https://x.com/a?q=1 and src/main.ts')).toEqual(['src/main.ts'])
  })

  it('does not take a flag apart into a path', () => {
    // `=` ends a token, so the value is offered on its own and the flag is not.
    expect(paths('--config=web/vite.config.ts')).toEqual(['web/vite.config.ts'])
  })

  it('offers several candidates from one line, in order, with offsets', () => {
    const line = 'moved a/b.go to c/d.go'
    expect(findPaths(line)).toStrictEqual([
      { path: 'a/b.go', start: 6, end: 12 },
      { path: 'c/d.go', start: 16, end: 22 },
    ])
  })

  it('repeats a path that appears twice, because each one underlines', () => {
    expect(paths('a/b.go and a/b.go')).toEqual(['a/b.go', 'a/b.go'])
  })

  it('stops at the cap rather than handing back a line-length list', () => {
    const line = Array.from({ length: 200 }, (_, i) => `d/f${i}.ts`).join(' ')
    expect(findPaths(line)).toHaveLength(MAX_CANDIDATES)
  })

  it('takes no candidate from an empty line', () => {
    expect(findPaths('')).toEqual([])
    expect(findPaths('   ')).toEqual([])
  })
})
