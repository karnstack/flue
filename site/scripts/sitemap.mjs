/**
 * Write sitemap.xml and robots.txt from what the build actually produced.
 *
 * The route list is read back out of dist/client rather than kept here: the
 * prerender is what decides which pages exist, so a hand-kept list would be
 * one route behind the first time a document is added, and the stale copy
 * would be the one search engines read. Every `index.html` under dist/client
 * is a page; its directory is the path.
 *
 * `lastmod` comes from each file's mtime — the build wrote it, so it is the
 * moment that page last changed rather than the moment this script ran.
 *
 * Run by `pnpm build`, after `vite build`.
 */
import { readdir, stat, writeFile } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const SITE_URL = 'https://flue.sh'
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'client')

/** Every index.html under dist/client, as `{ path, mtime }`. */
async function pages(dir = ROOT) {
  const out = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...(await pages(full)))
      continue
    }
    if (entry.name !== 'index.html') continue
    const { mtime } = await stat(full)
    const rel = relative(ROOT, dirname(full))
    out.push({ path: rel === '' ? '/' : `/${rel.split(/[\\/]/).join('/')}`, mtime })
  }
  return out
}

/**
 * The home page outranks the documents it links to, which is the only
 * priority claim worth making; everything else is left at the default rather
 * than invented.
 */
function priority(path) {
  return path === '/' ? '1.0' : '0.8'
}

const found = (await pages()).sort((a, b) => a.path.localeCompare(b.path))

if (found.length === 0) {
  throw new Error('sitemap: no prerendered pages under dist/client — did vite build run?')
}

const urls = found
  .map(({ path, mtime }) =>
    [
      '  <url>',
      `    <loc>${SITE_URL}${path === '/' ? '/' : path}</loc>`,
      `    <lastmod>${mtime.toISOString().slice(0, 10)}</lastmod>`,
      `    <priority>${priority(path)}</priority>`,
      '  </url>',
    ].join('\n'),
  )
  .join('\n')

await writeFile(
  join(ROOT, 'sitemap.xml'),
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`,
)

// Nothing here is private and the daemon is not on this origin, so the only
// job robots.txt has is pointing a crawler at the sitemap.
await writeFile(
  join(ROOT, 'robots.txt'),
  ['User-agent: *', 'Allow: /', '', `Sitemap: ${SITE_URL}/sitemap.xml`, ''].join('\n'),
)

console.log(`sitemap: ${found.length} pages -> ${SITE_URL}/sitemap.xml`)
