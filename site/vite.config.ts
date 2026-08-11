import tailwindcss from '@tailwindcss/vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import viteReact from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// The site is a marketing page: every route is prerendered at build time, so
// what Cloudflare serves is real HTML with the copy in it. The Worker in
// worker/ only exists for host redirects; it never renders.
export default defineConfig({
  resolve: {
    tsconfigPaths: true,
  },
  // The docs pages import ../../docs/*.md, which lives above this package.
  server: {
    fs: { allow: ['..'] },
  },
  plugins: [
    tanstackStart({
      prerender: {
        enabled: true,
        crawlLinks: true,
        // The prerenderer starts a real preview server on an ephemeral port
        // and fetches every route over TCP, so a route can fail on a socket
        // that was not ready rather than on anything wrong with the page. It
        // surfaces as `fetch failed` with ECONNREFUSED or ETIMEDOUT and no
        // route at fault, and it was frequent enough during this site's
        // rewrite to cost several rebuilds an hour.
        //
        // One fetch at a time is what fixes it. The default is os.cpus().length
        // (prerender.ts), which puts ten simultaneous connections on a server
        // that has only just bound its port. Six pages that each render in
        // milliseconds do not need the parallelism, so the whole race is bought
        // out for a fraction of a second of build time.
        //
        // Not retryCount. That option looks like the fix and is worse than
        // nothing here: its retry calls addCrawlPageTask(page), which returns
        // early because `seen` already holds the path, so the page is never
        // re-queued. Taking the retry branch also skips the failOnError throw,
        // so the build exits 0 with the page missing. scripts/check-pages.mjs
        // now fails the build on a missing page, whatever the cause.
        concurrency: 1,
      },
    }),
    viteReact(),
    tailwindcss(),
  ],
})
