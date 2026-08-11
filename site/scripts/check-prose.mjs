/**
 * Fail if an em-dash or en-dash reached anything a reader sees.
 *
 * Scans every text asset under dist/client — the prerendered HTML, and the
 * files copied there from public/ such as llms.txt and the diagrams — plus
 * two files named outright: the repository README, and scripts/install.sh.
 * Code comments keep their own voice and are never scanned; for everything
 * the site itself renders, the build output is the only honest thing to read,
 * because it is exactly what a visitor is served.
 *
 * install.sh is the exception, and it is named from source on purpose.
 * flue.sh/install.sh is piped into a shell by anyone following the homepage
 * or the README, so its die() messages are copy a reader sees. But the copy
 * under dist/client is generated: site/public/install.sh is gitignored and
 * staged by `make site-dev`, and `make site-deploy` copies the installer into
 * dist/client *after* this check has already run (Makefile). So a fresh
 * checkout has no copy to scan, and the copy that ships is not the copy that
 * was scanned. Reading scripts/install.sh, the canonical source the release
 * infra owns, is the only way the gate covers it whatever the staging order.
 * The built copy is still scanned when it is there, which costs nothing and
 * catches the two drifting apart.
 *
 * Run by `pnpm check:prose`, and by `pnpm build` once the site is clean.
 */
import { readdir, readFile, stat } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SITE = join(dirname(fileURLToPath(import.meta.url)), '..')
const DIST = join(SITE, 'dist', 'client')
const README = resolve(SITE, '..', 'README.md')
const INSTALLER = resolve(SITE, '..', 'scripts', 'install.sh')

/**
 * What a hit is called. Both named files live outside dist/client, so the
 * `relative(DIST, ...)` the built assets use would print a path climbing out
 * of the build directory instead of the one somebody has to go and edit.
 */
const LABELS = new Map([
  [README, 'README.md'],
  [INSTALLER, 'scripts/install.sh'],
])

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

/**
 * Extensions of the files a reader is served as text.
 *
 * An allowlist rather than a denylist, because the thing that must never be
 * scanned is a binary: og.png and the screenshots would report hits on
 * whatever bytes happen to sit where a dash would be. .js and .css are left
 * off for the same reason a source file is — the bundles are compiled output,
 * and any prose in them is already being read in the page it renders.
 */
const TEXT_EXT = ['.html', '.txt', '.svg', '.xml', '.sh']

/** Every text asset under dist/client, whatever put it there. */
async function targets(dir = DIST, out = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      await targets(full, out)
      continue
    }
    if (TEXT_EXT.some((ext) => entry.name.endsWith(ext))) out.push(full)
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
 * scanning only the named files would report clean having checked almost
 * nothing. Asked of `prerendered` and never of `files`, which is the whole
 * point: the README and the installer are appended below and are always
 * readable, so a guard that counted the scan list could be satisfied by two
 * files that say nothing about whether vite ran.
 */
if (!prerendered.some((file) => file.endsWith('.html'))) {
  throw new Error('check-prose: no prerendered pages under dist/client, did vite build run?')
}

const files = [...prerendered, README, INSTALLER]

/** One entry per file that has hits, in scan order, each with every hit. */
const found = []
let total = 0

for (const file of files) {
  const text = await readFile(file, 'utf8')
  const label = LABELS.get(file) ?? relative(DIST, file)
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
