/**
 * Fail the build when a route did not make it into dist/client.
 *
 * This exists because a build that is missing pages can still exit 0.
 * `prerender.retryCount` looked like the fix for a flaky prerender and is not:
 * its retry path calls `addCrawlPageTask(page)` again, that function returns
 * early on `seen.has(page.path)`, and the page is therefore never re-queued
 * (@tanstack/start-plugin-core/dist/esm/prerender.js). Because the retry
 * branch was taken, `failOnError` never throws either, so the run ends with
 * "Prerendered 2 pages", exit code 0, and four documents that are simply gone.
 * The sitemap is then written from what survived, so nothing downstream
 * notices.
 *
 * The retry option is no longer set and the prerender is serialized instead,
 * which is what actually removed the race. This check stays regardless: it is
 * cheap, and it catches a page vanishing for any reason rather than for that
 * one.
 *
 * Run by `pnpm build`, after `vite build` and before the sitemap.
 */
import { readdir, access } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROUTES = join(HERE, '..', 'src', 'routes')
const CLIENT = join(HERE, '..', 'dist', 'client')

/**
 * The URL path a route file is prerendered to.
 *
 * TanStack's flat file routes: dots are directory separators, and `index` is
 * the directory itself. Files starting with `__` are layouts rather than
 * pages, and are skipped. A route that ever takes a parameter would not be
 * prerenderable from its filename alone, and this asserts none exist rather
 * than guessing at one.
 */
function routePath(file) {
  const parts = file.replace(/\.tsx$/, '').split('.')
  if (parts.some((part) => part.startsWith('$'))) {
    throw new Error(`check-pages: ${file} takes a parameter, so this script needs updating`)
  }
  const segments = parts.filter((part) => part !== 'index')
  return segments.length === 0 ? '/' : `/${segments.join('/')}`
}

const expected = (await readdir(ROUTES))
  .filter((file) => file.endsWith('.tsx') && !file.startsWith('__'))
  .map((file) => ({ file, path: routePath(file) }))
  .sort((a, b) => a.path.localeCompare(b.path))

if (expected.length === 0) {
  throw new Error('check-pages: no route files found under src/routes')
}

const missing = []
for (const route of expected) {
  const html = join(CLIENT, route.path === '/' ? '' : route.path, 'index.html')
  try {
    await access(html)
  } catch {
    missing.push(route)
  }
}

if (missing.length > 0) {
  const lines = missing.map((route) => `  ${route.path}  (src/routes/${route.file})`)
  throw new Error(
    [
      `check-pages: ${missing.length} of ${expected.length} routes were not prerendered:`,
      ...lines,
      '',
      'The prerender logs the failure as "Encountered error" and then exits 0.',
      'Re-run the build; if it repeats, the page itself is throwing while rendering.',
    ].join('\n'),
  )
}

console.log(`check-pages: ${expected.length} routes, all prerendered`)
