/**
 * Fail if an em-dash or en-dash reached anything a reader sees.
 *
 * Scans the prerendered HTML under dist/client, the llms.txt copied there
 * from public/, and the repository README. Source files are deliberately not
 * scanned: code comments keep their own voice, and scanning the build output
 * is the only way to check exactly what a visitor is served.
 *
 * Run by `pnpm check:prose`, and by `pnpm build` once the site is clean.
 */
import { readdir, readFile, stat } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SITE = join(dirname(fileURLToPath(import.meta.url)), '..')
const DIST = join(SITE, 'dist', 'client')
const README = resolve(SITE, '..', 'README.md')

/** The characters the house style forbids. A plain hyphen is fine. */
const BANNED = [
  ['—', 'em-dash'],
  ['–', 'en-dash'],
]

async function exists(path) {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

/** Every .html file under dist/client, plus llms.txt if it was copied. */
async function targets(dir = DIST, out = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      await targets(full, out)
      continue
    }
    if (entry.name.endsWith('.html') || entry.name === 'llms.txt') out.push(full)
  }
  return out
}

if (!(await exists(DIST))) {
  throw new Error('check-prose: no dist/client — run `pnpm build` first')
}

/** At most this many occurrences are printed. The exit code counts them all. */
const MAX_PRINTED = 40

/** Characters either side of a hit to show, since a page is one long line. */
const WINDOW = 60

/**
 * A readable window around one hit. Prerendered HTML is a single line tens of
 * kilobytes long, so a line slice shows markup from somewhere else entirely.
 * Whitespace is collapsed so the window stays on one terminal row.
 */
function context(text, at) {
  const before = text.slice(Math.max(0, at - WINDOW), at)
  const after = text.slice(at + 1, at + 1 + WINDOW)
  const squash = (s) => s.replace(/\s+/g, ' ')
  const lead = at > WINDOW ? '…' : ''
  const tail = at + 1 + WINDOW < text.length ? '…' : ''
  return `${lead}${squash(before)}${text[at]}${squash(after)}${tail}`
}

const prerendered = await targets()

/**
 * A dist/client with no HTML in it means the build did not finish, and
 * scanning only the README would report clean having checked almost nothing.
 * Count the pages, not the list: the README is always on the end of it.
 */
if (!prerendered.some((file) => file.endsWith('.html'))) {
  throw new Error('check-prose: no prerendered pages under dist/client, did vite build run?')
}

const files = [...prerendered, README]

/** One entry per file that has hits, in scan order, each with every hit. */
const found = []
let total = 0

for (const file of files) {
  const text = await readFile(file, 'utf8')
  const label = file === README ? 'README.md' : relative(DIST, file)
  const hits = []

  let line = 1
  let lineStart = 0
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') {
      line += 1
      lineStart = i + 1
      continue
    }
    const banned = BANNED.find(([char]) => char === text[i])
    if (!banned) continue
    hits.push({ line, column: i - lineStart + 1, name: banned[1], context: context(text, i) })
  }

  if (hits.length > 0) {
    found.push({ label, hits })
    total += hits.length
  }
}

if (total > 0) {
  console.error(`check-prose: ${total} dash(es) in copy a reader sees\n`)

  let printed = 0
  for (const { label, hits } of found) {
    console.error(`  ${label}  (${hits.length})`)
    for (const hit of hits) {
      if (printed === MAX_PRINTED) break
      console.error(`    ${label}:${hit.line}:${hit.column}  ${hit.name}  ${hit.context}`)
      printed += 1
    }
    if (printed === MAX_PRINTED) break
  }
  if (total > printed) console.error(`\n  … and ${total - printed} more`)

  console.error('\nUse a full stop, a colon, commas or brackets instead.')
  process.exit(1)
}

console.log(`check-prose: ${files.length} files, no em-dashes or en-dashes`)
