/**
 * A reproducible digest of the built web app.
 *
 * Run with `pnpm hash` after `pnpm build`. It prints one hex line — the
 * digest of everything in `web/dist` — followed by a per-file listing.
 *
 * This is the answer to the one thing end-to-end encryption cannot fix: the
 * JavaScript that holds your keys is served to you by whoever runs the origin
 * you loaded it from (`docs/faq.md`). A digest anyone can recompute from the
 * source is what turns "trust the operator" into "check the operator" — build
 * the tag yourself, run this, and compare with the value published for that
 * release.
 *
 * Determinism is the whole point, so the digest reads only what a build
 * produces and never how it was produced: no mtimes, no inode order, no
 * absolute paths, no build host. Files are visited in byte order of their
 * `dist`-relative POSIX path, and each contributes
 *
 *     <path> NUL <byte length in decimal> NUL <bytes>
 *
 * The length is in there because `<path> NUL <bytes>` alone is ambiguous: a
 * single file whose bytes happen to spell `X\0b\0Y` would hash exactly like
 * two files `a` = `X` and `b` = `Y`. That ambiguity is a hole in the one
 * property this script exists to provide, and a decimal length terminated by
 * NUL — which neither a path nor a length can contain — closes it.
 *
 * What determinism still rests on: the same source, the same lockfile, and
 * the same toolchain (`mise.toml` pins go, node and pnpm). Vite's filenames
 * are content-hashed, so the digest changes if and only if the output does.
 *
 * Usage:
 *   node scripts/bundle-hash.mjs                 hash web/dist
 *   node scripts/bundle-hash.mjs <expected-hex>  hash it and compare, exit 1 on a mismatch
 *   node scripts/bundle-hash.mjs --dir <path>    hash some other directory
 */
import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const DEFAULT_DIR = fileURLToPath(new URL('../dist', import.meta.url))
const NUL = Buffer.from([0])

/** Every file under `dir`, as `dir`-relative POSIX paths. */
async function walk(dir, base, found) {
  const entries = await readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    const full = join(dir, entry.name)
    // Anything that is not a directory is a file to read, and readFile follows
    // a symlink to the bytes it points at — which is what a server would
    // serve. A symlink *to* a directory would fail the read loudly rather than
    // be skipped quietly; no Vite output has ever held one.
    if (entry.isDirectory()) await walk(full, base, found)
    else found.push(relative(base, full).split(sep).join('/'))
  }
  return found
}

/**
 * Byte order, not locale order and not UTF-16 code-unit order.
 *
 * `Array.prototype.sort()` compares UTF-16 code units, which disagrees with
 * byte order for anything outside the BMP. No Vite output has ever contained
 * such a filename; the comparator costs nothing and means the digest does not
 * quietly depend on that staying true.
 */
function byBytes(a, b) {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'))
}

async function bundleHash(dir) {
  const paths = (await walk(dir, dir, [])).sort(byBytes)
  const whole = createHash('sha256')
  const files = []
  for (const path of paths) {
    const bytes = await readFile(join(dir, path))
    whole.update(Buffer.from(path, 'utf8'))
    whole.update(NUL)
    whole.update(Buffer.from(String(bytes.byteLength), 'utf8'))
    whole.update(NUL)
    whole.update(bytes)
    files.push({
      path,
      size: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    })
  }
  return { digest: whole.digest('hex'), files }
}

function parseArgs(argv) {
  let dir = DEFAULT_DIR
  let expected = null
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--dir') {
      const next = argv[++i]
      if (next === undefined) throw new Error('--dir needs a path')
      dir = next
    } else if (expected === null) {
      expected = arg
    } else {
      throw new Error(`unexpected argument: ${arg}`)
    }
  }
  return { dir, expected }
}

async function main() {
  let dir
  let expected
  try {
    ;({ dir, expected } = parseArgs(process.argv.slice(2)))
  } catch (err) {
    console.error(`bundle-hash: ${err.message}`)
    process.exitCode = 2
    return
  }

  let result
  try {
    result = await bundleHash(dir)
  } catch (err) {
    // The overwhelmingly likely cause is a dist that was never built, and a
    // digest over a directory that is not there would be a lie either way.
    console.error(`bundle-hash: cannot read ${dir}: ${err.message}`)
    console.error('bundle-hash: run `pnpm build` first')
    process.exitCode = 1
    return
  }

  // An empty directory hashes to the digest of nothing at all, which would
  // compare equal to every other empty build. Refuse rather than publish it.
  if (result.files.length === 0) {
    console.error(`bundle-hash: ${dir} is empty`)
    process.exitCode = 1
    return
  }

  // The digest first and alone on its line, so `| head -1` is the whole
  // answer; the listing below it is what a mismatch is diagnosed with.
  const lines = [result.digest, '']
  for (const file of result.files) lines.push(`${file.sha256}  ${file.size}  ${file.path}`)
  console.log(lines.join('\n'))

  if (expected !== null && expected.toLowerCase() !== result.digest) {
    console.error(`bundle-hash: MISMATCH\n  expected ${expected}\n  got      ${result.digest}`)
    process.exitCode = 1
  }
}

await main()
