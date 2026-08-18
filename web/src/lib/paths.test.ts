import { describe, expect, it } from 'vitest'

import { findPaths } from './paths'

const paths = (text: string) => findPaths(text).map((c) => c.path)

describe('findPaths', () => {
  it.each([
    ['wrote internal/wire/binary.go today', ['internal/wire/binary.go']],
    ['see /etc/hosts and ~/notes.md', ['/etc/hosts', '~/notes.md']],
    ['relative ./a.ts and ../b/c.rs', ['./a.ts', '../b/c.rs']],
    ['bare CLAUDE.md name', ['CLAUDE.md']],
    ['dotted styles.build.test.ts name', ['styles.build.test.ts']],
    ['no paths in this sentence at all', []],
    ['not http://example.com/a/b nor wss://relay/x', []],
    ['a lone slash / is nothing', []],
  ])('%s -> %j', (text, want) => {
    expect(paths(text)).toEqual(want)
  })

  it.each([
    ['trailing stop internal/a.go.', 'internal/a.go'],
    ['comma web/src/b.ts, then', 'web/src/b.ts'],
    ['quoted "spec/protocol.md"', 'spec/protocol.md'],
    ['ticked `internal/wire/binary.go`', 'internal/wire/binary.go'],
    ['parenthesised (docs/plan.md)', 'docs/plan.md'],
    ['bracketed [a/b.c];', 'a/b.c'],
  ])('%s strips to %s', (text, want) => {
    expect(paths(text)).toEqual([want])
  })

  it('captures a :line suffix and keeps it inside the span', () => {
    const [c] = findPaths('boom at src/foo.ts:12 sorry')
    expect(c).toMatchObject({ path: 'src/foo.ts', line: 12, col: undefined })
    expect('boom at src/foo.ts:12 sorry'.slice(c!.start, c!.end)).toBe('src/foo.ts:12')
  })

  it('captures :line:col', () => {
    expect(findPaths('src/foo.ts:12:3')[0]).toMatchObject({ path: 'src/foo.ts', line: 12, col: 3 })
  })

  it('strips punctuation after the suffix', () => {
    expect(findPaths('(src/foo.ts:12).')[0]).toMatchObject({ path: 'src/foo.ts', line: 12 })
  })

  it('reports spans in line coordinates', () => {
    const line = 'a internal/a.go b ~/x.md'
    const [first, second] = findPaths(line)
    expect(line.slice(first!.start, first!.end)).toBe('internal/a.go')
    expect(line.slice(second!.start, second!.end)).toBe('~/x.md')
  })

  it.each([
    ['edit .gitignore now', ['.gitignore']],
    ['reads .env and .env.local', ['.env', '.env.local']],
    ['pins .mise.toml here', ['.mise.toml']],
    ['a quoted ".bashrc" too', ['.bashrc']],
    ['under .claude/worktrees today', ['.claude/worktrees']],
    ['an ellipsis ... is not one', []],
    ['nor a sentence that trails off....', []],
  ])('dotfiles: %s -> %j', (text, want) => {
    expect(paths(text)).toEqual(want)
  })

  it('keeps a directory-shaped candidate; verification refuses it later', () => {
    expect(paths('under web/src/ somewhere')).toEqual(['web/src/'])
  })

  it('is generous with word/word pairs, because stat is the arbiter', () => {
    expect(paths('either/or')).toEqual(['either/or'])
  })
})
