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
        // retryCount re-fetches the failed route after retryDelay instead of
        // failing the build (start-plugin-core/src/prerender.ts), so a real
        // error still fails, three attempts later. Costs nothing on a green
        // run. Remove it if the upstream race is fixed.
        retryCount: 3,
        retryDelay: 500,
      },
    }),
    viteReact(),
    tailwindcss(),
  ],
})
