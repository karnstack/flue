import { describe, expect, it } from 'vitest'

import { knownLanguages } from './lang'
import { HIGHLIGHT_MAX_BYTES, HIGHLIGHT_MAX_LINES, hasGrammar, tokenizePeek } from './tokenize'

describe('tokenizePeek', () => {
  it('colours a keyword differently from a string, in both schemes', async () => {
    const lines = await tokenizePeek('const x = "hi"\n', 'typescript')
    const flat = lines!.flat()
    const kw = flat.find((t) => t.text.includes('const'))!
    const str = flat.find((t) => t.text.includes('hi'))!
    expect(kw.light).toBeTruthy()
    expect(kw.dark).toBeTruthy()
    expect(kw.light).not.toBe(str.light)
    expect(kw.dark).not.toBe(str.dark)
  })

  it('answers one token row per input line', async () => {
    const lines = await tokenizePeek('a\nb\nc', 'typescript')
    expect(lines).toHaveLength(3)
  })

  it('reassembles to the input, row by row', async () => {
    const text = 'func main() {\n\tprintln("hey")\n}'
    const lines = await tokenizePeek(text, 'go')
    expect(lines!.map((row) => row.map((t) => t.text).join('')).join('\n')).toBe(text)
  })

  it('loads a second language into the same engine', async () => {
    expect(await tokenizePeek('x = 1\n', 'python')).not.toBeNull()
    expect(await tokenizePeek('SELECT 1;\n', 'sql')).not.toBeNull()
  })

  it('declines past the size cap', async () => {
    expect(await tokenizePeek('x'.repeat(HIGHLIGHT_MAX_BYTES + 1), 'typescript')).toBeNull()
  })

  it('declines past the line cap', async () => {
    expect(await tokenizePeek('\n'.repeat(HIGHLIGHT_MAX_LINES + 1), 'typescript')).toBeNull()
  })

  it('declines a language it does not know', async () => {
    expect(await tokenizePeek('hello', 'made-up-lang')).toBeNull()
  })

  it('carries a grammar for every language the name map can answer', () => {
    expect(knownLanguages().filter((lang) => !hasGrammar(lang))).toEqual([])
  })
})
