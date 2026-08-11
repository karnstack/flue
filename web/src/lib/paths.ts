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

/**
 * A whole URL, read off the raw line before any token is cut out of it.
 *
 * It has to be read that way round. The token pattern ends a token at `=`, at
 * the comma and at every bracket, which are the characters a query string is
 * made of, so `https://x.com/search?q=src/main.ts` arrives at pathish() in
 * pieces and the piece that looks like a path is not the piece carrying the
 * scheme. Nothing local to that piece can tell it from a real path, and the
 * cost of getting it wrong is not one wasted request: xterm's web-links addon
 * is already underlining that whole run, so a second provider over part of it
 * is two marks on one piece of text and a click that could go either way.
 *
 * The span ends on the same characters TOKEN ends on, and for the same reason:
 * they are punctuation around a link far more often than a character in one.
 * An earlier version ran to the next space instead, which was not merely
 * over-eager, it was wrong in the costly direction. Compact JSON log output,
 * which is what pino, zap and logrus all print, puts a path one quote away
 * from a URL: in `{"url":"https://x.com/a","file":"src/main.ts"}` a span to the
 * next space covers the whole record, so the path was dropped here, and the
 * addon's own matcher stops at the quote and never marks it either. A path on
 * screen that answers to nothing is the failure this file's header calls the
 * expensive one. The comma and the equals sign stay inside the span, because
 * the addon accepts both and really does mark `https://x.com/a,b/c.ts` end to
 * end.
 *
 * The scheme is bounded at 32 because unbounded it backtracks. On a long run
 * of scheme-shaped characters with no `://` anywhere in it, one hex digest is
 * enough, the engine consumes the run from every start position in turn and
 * the cost goes quadratic. Measured over 100000 characters: 30.5 seconds
 * before the bound, 21ms after, in a function that runs while a pointer moves.
 *
 * One thing the paragraph above overstates. The addon's default matcher takes
 * `http` and `https` only, so `file://` and `git+ssh://` get a span here and a
 * mark from nobody, and suppressing inside them is not deferring to anyone.
 * It costs nothing today, because a token carrying `://` fails pathish()
 * regardless, and a scheme is not a path.
 *
 * Hoisted where the token scanner cannot be: matchAll() walks a copy of the
 * regex, so no `lastIndex` from one line reaches the next.
 */
const URL_RUN = /[A-Za-z][A-Za-z0-9+.-]{0,31}:\/\/[^\s'"`<>|(){}\[\]]*/gu

/** Half-open, in the coordinates of the line the run was found in. */
interface Span {
  start: number
  end: number
}

/** What a sentence leaves on the end of a path. */
const TRAILING = /[.;:]+$/

/** A `:42` or `:42:7` on the end of an otherwise complete path. */
const SUFFIX = /:(\d+)(?::(\d+))?$/

/**
 * A dot near the end of a name, with a short run of letters or digits after it.
 *
 * The length bound is what does the work, because this is the only thing
 * standing between a bare word and the daemon. Unbounded, every dotted
 * expression a program prints reads as a name with a suffix on it, and
 * `payload.someDescriptiveField` becomes a request. Twelve leaves room for the
 * longest suffixes anyone ships, `.properties` and `.storyboard`, and stops
 * well short of the identifiers.
 */
const EXTENSION = /\.[\p{L}\p{N}]{1,12}$/u

/**
 * Every path-shaped run in `line`, in the order they appear.
 *
 * Duplicates are kept: two mentions of one file are two things to underline,
 * and the caller that batches them for verification is the one that dedupes.
 */
export function findPaths(line: string): PathCandidate[] {
  const links: Span[] = []
  for (const m of line.matchAll(URL_RUN)) links.push({ start: m.index, end: m.index + m[0].length })
  // Built per call rather than hoisted, because of the break below: a line that
  // hits the cap leaves the scanner parked mid-line, and a module-level regex
  // with the global flag would carry that `lastIndex` into the next call and
  // begin the next line wherever the capped one ran out of room.
  const scanner = new RegExp(TOKEN, 'gu')
  const out: PathCandidate[] = []
  for (let m = scanner.exec(line); m !== null; m = scanner.exec(line)) {
    if (out.length >= MAX_CANDIDATES) break
    const trimmed = m[0].replace(TRAILING, '')
    if (trimmed === '') continue
    const start = m.index
    const end = start + trimmed.length
    if (links.some((l) => l.start < end && start < l.end)) continue
    const suffix = SUFFIX.exec(trimmed)
    const path = suffix === null ? trimmed : trimmed.slice(0, suffix.index)
    if (!pathish(path)) continue
    const found: PathCandidate = { path, start, end }
    // A suffix too big to be a position is dropped rather than carried. Number
    // has already lost digits past 2^53 and reaches Infinity soon after, which
    // JSON.stringify writes as null, so the daemon would be asked to open a
    // line that no longer says what the terminal said. The path is still worth
    // offering; it opens at the top instead.
    if (suffix !== null) {
      const at = Number(suffix[1])
      if (Number.isSafeInteger(at)) {
        found.line = at
        if (suffix[2] !== undefined) {
          const across = Number(suffix[2])
          if (Number.isSafeInteger(across)) found.col = across
        }
      }
    }
    out.push(found)
  }
  return out
}

/**
 * Whether this run of characters is worth asking the daemon about.
 *
 * The URL work is done over the whole line before this is reached, so the
 * `://` test here is only for what that pass will not call a link: it wants a
 * scheme beginning with a letter, and something like `://host/a.ts` still
 * reads as one to a person, whose eye is what the marks are for.
 */
function pathish(text: string): boolean {
  if (text === '' || text.includes('://')) return false
  if (text.startsWith('/') || text.startsWith('~/')) return true
  if (text.startsWith('./') || text.startsWith('../')) return true
  if (text.includes('/')) return true
  // A bare name has to carry a suffix to be told from a word. A version number
  // satisfies that and will be asked about; the daemon says no, and nothing
  // underlines. `~`, `.` and `..` fall out here too: none of them can match
  // EXTENSION, which needs a letter or a digit after its dot.
  return EXTENSION.test(text)
}
