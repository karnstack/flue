import type { LinkCandidate } from '@/emulator/types'

/*
 * Pulls path-shaped spans out of one logical line of terminal text.
 *
 * Generous on purpose: verification against the daemon decides what gets
 * decorated, so a stray match costs one cached stat while a miss is a path
 * that never opens at all. Tokens are whitespace-separated — a path with a
 * space in it is not findable in plain terminal output anyway.
 */

const OPENERS = new Set(['(', '[', '{', '<', '"', "'", '`'])
const CLOSERS = new Set([')', ']', '}', '>', '"', "'", '`', '.', ',', ';', ':', '!', '?'])
/** Anything with a URL scheme belongs to the web-links handler, not here. */
const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i
const ROOTED = /^(?:~\/|\.\/|\.\.\/|\/)./
const RELATIVE = /^[\w.~$@+-][\w.~$@+=%-]*(?:\/[\w.~$@+=%-]+)+\/?$/
const BARE_FILE = /^[\w$@+-][\w.$@+-]*\.[A-Za-z][A-Za-z0-9]{0,15}$/
const LINE_COL = /:(\d{1,7})(?::(\d{1,4}))?$/

export function findPaths(text: string): LinkCandidate[] {
  const found: LinkCandidate[] = []
  for (const token of text.matchAll(/\S+/g)) {
    let start = token.index
    let raw = token[0]
    while (raw.length > 0 && OPENERS.has(raw[0]!)) {
      raw = raw.slice(1)
      start++
    }
    while (raw.length > 0 && CLOSERS.has(raw[raw.length - 1]!)) raw = raw.slice(0, -1)
    if (raw.length === 0) continue
    let path = raw
    let line: number | undefined
    let col: number | undefined
    const suffix = LINE_COL.exec(raw)
    if (suffix !== null) {
      path = raw.slice(0, suffix.index)
      line = Number(suffix[1])
      if (suffix[2] !== undefined) col = Number(suffix[2])
    }
    if (path.length === 0 || SCHEME.test(path)) continue
    if (!ROOTED.test(path) && !RELATIVE.test(path) && !BARE_FILE.test(path)) continue
    found.push({ path, start, end: start + raw.length, line, col })
  }
  return found
}
