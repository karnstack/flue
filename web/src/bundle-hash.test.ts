// @vitest-environment node
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'

/**
 * `scripts/bundle-hash.mjs` is the check a user runs against a published
 * digest to see whether the JavaScript an origin served them is the code in
 * this repository (`docs/faq.md`). Two properties make that check worth
 * anything, and both are asserted here rather than assumed:
 *
 *   - the same tree hashes the same on any machine, so a mismatch means the
 *     bytes differ and never that the walk found them in another order;
 *   - different trees hash differently — including the pair that a
 *     `<path> NUL <bytes>` framing without a length would collide.
 *
 * The script is spawned rather than imported: it is a CLI, `web/tsconfig.json`
 * does not cover `scripts/`, and spawning is what a user does.
 */
const SCRIPT = fileURLToPath(new URL('../scripts/bundle-hash.mjs', import.meta.url))

const made: string[] = []

async function tree(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'flue-bundle-hash-'))
  made.push(dir)
  for (const [path, body] of Object.entries(files)) {
    const full = join(dir, path)
    await mkdir(join(full, '..'), { recursive: true })
    await writeFile(full, body)
  }
  return dir
}

function hash(dir: string, ...args: string[]): string {
  // stderr piped rather than inherited: two cases below are meant to fail, and
  // their diagnostics belong in the thrown error, not in the test log.
  return execFileSync(process.execPath, [SCRIPT, '--dir', dir, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

function digest(dir: string): string {
  return hash(dir).split('\n')[0]!
}

afterAll(async () => {
  await Promise.all(made.map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('bundle-hash', () => {
  it('prints the same bytes twice for one tree', async () => {
    const dir = await tree({ 'index.html': '<!doctype html>', 'assets/app-abc123.js': 'x' })

    const first = hash(dir)
    expect(first).toBe(hash(dir))
    expect(first.split('\n')[0]).toMatch(/^[0-9a-f]{64}$/)
    // The listing is the diagnosis half, in the same order the digest walked.
    expect(first).toContain('assets/app-abc123.js')
    expect(first).toContain('index.html')
  })

  it('does not depend on the order the files were written', async () => {
    const a = await tree({ 'a.js': 'one', 'b.js': 'two', 'nested/c.css': 'three' })
    const b = await tree({ 'nested/c.css': 'three', 'b.js': 'two', 'a.js': 'one' })

    expect(digest(a)).toBe(digest(b))
  })

  it('agrees whether a filename arrives composed or decomposed', async () => {
    // macOS hands back a decomposed spelling of `café` where Linux hands back
    // a composed one. Same asset, same bytes, and the digest has to say so or
    // a cross-machine comparison fails for a reason that is not tampering.
    // Escapes, not literals: the two spellings look identical in an editor,
    // and this file's own bytes must not decide which one each line holds.
    const composed = await tree({ ['caf\u00e9.js']: 'one' })
    const decomposed = await tree({ ['cafe\u0301.js']: 'one' })

    expect(digest(composed)).toBe(digest(decomposed))
  })

  it('changes when one byte does', async () => {
    const a = await tree({ 'a.js': 'one' })
    const b = await tree({ 'a.js': 'onE' })

    expect(digest(a)).not.toBe(digest(b))
  })

  it('separates a file whose contents look like a second file', async () => {
    // The collision a `<path> NUL <bytes>` framing would have: one file
    // carrying its neighbour's frame inside its own bytes.
    const one = await tree({ 'a.js': 'X\0b.js\0Y' })
    const two = await tree({ 'a.js': 'X', 'b.js': 'Y' })

    expect(digest(one)).not.toBe(digest(two))
  })

  it('fails a comparison against the wrong digest', async () => {
    const dir = await tree({ 'a.js': 'one' })

    expect(() => hash(dir, 'f'.repeat(64))).toThrow()
    expect(() => hash(dir, digest(dir))).not.toThrow()
  })

  it('refuses an empty directory rather than hashing nothing', async () => {
    const dir = await tree({})

    expect(() => hash(dir)).toThrow()
  })
})
