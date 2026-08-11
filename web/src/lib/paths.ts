/**
 * Path-shaped runs of text, found in one line of terminal output.
 *
 * Deliberately generous, and that is the whole design of this file. Whether a
 * candidate underlines is settled by asking the daemon (see files/verify.ts),
 * so a false positive costs one entry in a batched `stat` and nothing on
 * screen, while a false negative is a path a reader can see and cannot click.
 * A matcher tuned to avoid the first produces the second.
 */

/** One run of text that might name a file. */
export interface PathCandidate {
  /** The path itself: punctuation stripped, any line and column suffix removed. */
  path: string
  /** Where the whole match begins in the line it was found in. */
  start: number
  /** One past where it ends, suffix included, so a click on `:42` still lands. */
  end: number
  /** The 1-based line a `:42` suffix named. */
  line?: number
  /** The 1-based column, which only ever appears alongside a line. */
  col?: number
}

/**
 * The most candidates one logical line yields.
 *
 * A wrapped logical line can be thousands of characters long, and every
 * candidate on it costs an entry in a `stat` batch. Sixty-four is two full
 * batches at the daemon's 32-path ceiling, which is already far past any line
 * a human is reading.
 */
export const MAX_CANDIDATES = 64

/**
 * The characters a candidate may be made of.
 *
 * Quotes, angle brackets, every kind of bracket, the pipe, the comma and the
 * equals sign all end a token rather than being stripped afterwards, because
 * each of them is punctuation *around* a path far more often than a character
 * in one. That is what lets `(src/a.ts)` and `--flag=src/a.ts` both come out as
 * `src/a.ts` with no unwinding.
 *
 * The grave accent is spelled as a numeric escape because a raw template
 * literal cannot hold one, and backslashing it produces an escape the `u` flag
 * refuses, which fails where the pattern is compiled rather than where it was
 * written.
 */
const TOKEN = String.raw`[^\s'"\u0060<>|(){}\[\],=]+`

/** What a sentence leaves on the end of a path. */
const TRAILING = /[.;:]+$/

/** A `:42` or `:42:7` on the end of an otherwise complete path. */
const SUFFIX = /:(\d+)(?::(\d+))?$/

/** A file extension: a dot and a short run of letters or digits, at the end. */
const EXTENSION = /\.[\p{L}\p{N}]{1,12}$/u

/** Somewhere in this text there is a letter, a digit or an underscore. */
const SUBSTANTIAL = /[\p{L}\p{N}_]/u

/**
 * Every path-shaped run in `line`, in the order they appear.
 *
 * Duplicates are kept: two mentions of one file are two things to underline,
 * and the caller that batches them for verification is the one that dedupes.
 */
export function findPaths(line: string): PathCandidate[] {
  // Built per call rather than hoisted. A module-level regex with the global
  // flag carries `lastIndex` between calls, and this one is called from a
  // hover handler that can be re-entered while a previous verification is
  // still in flight.
  const scanner = new RegExp(TOKEN, 'gu')
  const out: PathCandidate[] = []
  for (let m = scanner.exec(line); m !== null; m = scanner.exec(line)) {
    if (out.length >= MAX_CANDIDATES) break
    const trimmed = m[0].replace(TRAILING, '')
    if (trimmed === '') continue
    const suffix = SUFFIX.exec(trimmed)
    const path = suffix === null ? trimmed : trimmed.slice(0, suffix.index)
    if (!pathish(path)) continue
    const found: PathCandidate = { path, start: m.index, end: m.index + trimmed.length }
    if (suffix !== null) {
      found.line = Number(suffix[1])
      if (suffix[2] !== undefined) found.col = Number(suffix[2])
    }
    out.push(found)
  }
  return out
}

/**
 * Whether this run of characters is worth asking the daemon about.
 *
 * A URL is refused rather than merely unmatched: xterm's own web-links addon
 * already underlines those, and two providers offering the same range is two
 * underlines and an ambiguous click.
 */
function pathish(text: string): boolean {
  if (text === '' || text.includes('://')) return false
  if (text === '~' || text === '.' || text === '..') return false
  if (text.startsWith('/') || text.startsWith('~/')) return true
  if (text.startsWith('./') || text.startsWith('../')) return true
  if (text.includes('/')) return true
  // A bare name has to carry an extension to be told from a word. A version
  // number satisfies that and will be asked about; the daemon says no, and
  // nothing underlines.
  return EXTENSION.test(text) && SUBSTANTIAL.test(text)
}
