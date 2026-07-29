// `defineConfig` comes from `vitest/config`, not `vite`. Vite's own
// `defineConfig` has no `test` key on its type, so the Vitest block below
// would be a type error the moment this file is type-checked.
import { defineConfig } from 'vitest/config'
import type { Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath, URL } from 'node:url'

import { buildManifest } from './src/lib/manifest'
import { chrome } from './src/lib/theme'

const MANIFEST_FILE = 'manifest.webmanifest'

/**
 * Emit the web app manifest and the iOS/Android chrome colours from the
 * design tokens, so neither can be a hand-typed hex that drifts from
 * styles.css.
 *
 * Deliberately not a PWA plugin: the only other thing such a plugin brings
 * is a generated service worker with a caching strategy nobody here chose,
 * and a stale-while-revalidate cache over the daemon's API would be actively
 * wrong. The service worker lands in Task 9 with the router, hand-written.
 */
function fluePwa(): Plugin {
  const body = JSON.stringify(buildManifest(), null, 2)

  return {
    name: 'flue:pwa',

    // `order: 'pre'` puts this ahead of Vite's own %VAR% handling, so the
    // placeholders are already gone by the time it looks for env names.
    transformIndexHtml: {
      order: 'pre',
      handler(html) {
        return html
          .replaceAll('%FLUE_THEME_LIGHT%', chrome.canvasLight)
          .replaceAll('%FLUE_THEME_DARK%', chrome.canvasDark)
      },
    },

    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url?.split('?')[0] !== `/${MANIFEST_FILE}`) return next()
        res.setHeader('Content-Type', 'application/manifest+json')
        res.end(body)
      })
    },

    generateBundle() {
      this.emitFile({ type: 'asset', fileName: MANIFEST_FILE, source: body })
    },
  }
}

export default defineConfig({
  plugins: [react(), tailwindcss(), fluePwa()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  build: { outDir: 'dist', emptyOutDir: true },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test-setup.ts'],
  },
})
