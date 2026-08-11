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
    await stat(path)
    return true
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

const files = [...(await targets()), README]
const hits = []

for (const file of files) {
  const text = await readFile(file, 'utf8')
  text.split('\n').forEach((line, i) => {
    for (const [char, name] of BANNED) {
      if (!line.includes(char)) continue
      const column = line.indexOf(char) + 1
      const label = file === README ? 'README.md' : relative(DIST, file)
      hits.push(`${label}:${i + 1}:${column}  ${name}  ${line.trim().slice(0, 120)}`)
    }
  })
}

if (hits.length > 0) {
  console.error(`check-prose: ${hits.length} dash(es) in copy a reader sees\n`)
  for (const hit of hits) console.error(`  ${hit}`)
  console.error('\nUse a full stop, a colon, commas or brackets instead.')
  process.exit(1)
}

console.log(`check-prose: ${files.length} files, no em-dashes or en-dashes`)
