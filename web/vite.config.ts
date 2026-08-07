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
import { SHELL_URL } from './src/lib/sw-strategy'

const MANIFEST_FILE = 'manifest.webmanifest'

/**
 * The service worker's own filename, and it must stay unhashed at the root.
 * A worker's default scope is its own URL's directory, so
 * `/assets/sw-abc123.js` could only ever control `/assets/`, and a name that
 * changed every build would orphan the previously registered worker instead
 * of updating it.
 */
const SW_FILE = 'sw.js'
const SW_ENTRY = 'sw'

/**
 * The port Vite proxies /api and /ws to. Vite only ever fronts the dev
 * daemon, which `make run` starts on 7719 — not 7717, so an installed flue
 * and the dev loop coexist (FLUE_DEV_PORT in the Makefile moves both ends).
 */
const DAEMON_PORT = process.env.FLUE_PORT ?? '7719'
const DAEMON_ORIGIN = `http://127.0.0.1:${DAEMON_PORT}`

/** Emitted files worth holding for an offline load: the shell and its code. */
function isPrecacheable(fileName: string): boolean {
  return fileName.startsWith('assets/') && /\.(js|css)$/.test(fileName)
}

/**
 * A short, stable digest of the precache list.
 *
 * The filenames are already content-hashed, so this changes if and only if
 * the build's output changes — which is exactly the condition under which the
 * worker should open a new cache and drop the old one.
 */
function digest(parts: readonly string[]): string {
  let h = 5381
  for (const part of parts) {
    for (let i = 0; i < part.length; i++) h = (Math.imul(h, 33) ^ part.charCodeAt(i)) >>> 0
  }
  return h.toString(36)
}

/**
 * Emit the web app manifest and the iOS/Android chrome colours from the
 * design tokens, and hand the service worker the list of files it should
 * hold, so none of the three can be a hand-typed value that drifts from the
 * real build.
 *
 * Deliberately not a PWA plugin: the only other thing such a plugin brings
 * is a generated service worker with a caching strategy nobody here chose,
 * and a stale-while-revalidate cache over the daemon's API would be actively
 * wrong. src/sw.ts is hand-written and its policy is unit-tested.
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

    // `order: 'post'` is belt-and-braces, not load-bearing today — measured,
    // not assumed: on vite 7.3.6 the compiled stylesheet is already in the
    // bundle at a default-ordered generateBundle, and both orders produce the
    // same precache list. It is kept because the list is assembled by reading
    // other plugins' output, so "everything has been emitted" is the property
    // this hook actually depends on. What enforces it is sw.build.test.ts,
    // which asserts a .css entry really is in the emitted list; a hook that
    // ran too early would silently ship a JS-only precache, i.e. an offline
    // load with no styles at all.
    generateBundle: {
      order: 'post',
      handler(_options, bundle) {
        this.emitFile({ type: 'asset', fileName: MANIFEST_FILE, source: body })

        const chunk = bundle[SW_FILE]
        if (!chunk || chunk.type !== 'chunk') {
          this.error(`flue:pwa: no ${SW_FILE} chunk in the bundle`)
          return
        }

        // The shell first, then the code it loads. Nothing under /api and
        // nothing at /ws is listed, and nothing ever should be: the point of
        // this cache is to hold a shell that can report a dead daemon, not to
        // answer for the daemon.
        // Root-absolute. A bundle key is a path relative to outDir, and a
        // relative entry would resolve against the worker's own URL — which
        // happens to be right today only because the worker sits at the root.
        const precache = [
          SHELL_URL,
          ...Object.keys(bundle)
            .filter(isPrecacheable)
            .sort()
            .map((name) => `/${name}`),
        ]
        const build = { version: digest(precache), precache }

        // Prepended rather than substituted into a placeholder: this runs
        // after minification, and a `var` declaration at the top of the chunk
        // is hoisted above every reference in it regardless of what esbuild
        // did to the rest of the file.
        chunk.code = `var __FLUE_BUILD__ = ${JSON.stringify(build)};\n${chunk.code}`
      },
    },
  }
}

export default defineConfig({
  plugins: [react(), tailwindcss(), fluePwa()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  /**
   * `pnpm dev` talks to a real daemon, and three separate checks in
   * internal/transport/local decide whether it is allowed to.
   *
   *   - Host must be `127.0.0.1:<daemon port>` exactly, hence changeOrigin.
   *   - Origin, if present, must be the daemon's own; the browser sends the
   *     dev server's, so it is rewritten here.
   *   - The flue_token cookie is set for host 127.0.0.1, and cookies ignore
   *     the port — so a dev page served from 127.0.0.1:5173 carries it, and
   *     one served from localhost:5173 does not. Hence the explicit host.
   *
   * To get that cookie: run `flue serve`, open the URL it prints once, then
   * come back here. Sec-Fetch-Site arrives as same-origin either way, which
   * is what /ws requires.
   */
  server: {
    host: '127.0.0.1',
    proxy: {
      '/api': { target: DAEMON_ORIGIN, changeOrigin: true, headers: { Origin: DAEMON_ORIGIN } },
      '/ws': {
        target: DAEMON_ORIGIN,
        changeOrigin: true,
        ws: true,
        headers: { Origin: DAEMON_ORIGIN },
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      // Named `index` so the app's chunks keep the filenames a single-entry
      // Vite build gives them; the key becomes the chunk name.
      input: {
        index: fileURLToPath(new URL('./index.html', import.meta.url)),
        [SW_ENTRY]: fileURLToPath(new URL('./src/sw.ts', import.meta.url)),
      },
      output: {
        // The worker is registered as a classic script, so its chunk must be
        // self-contained; src/sw.ts imports only src/lib/sw-strategy.ts,
        // which nothing else imports, so Rollup inlines it rather than
        // splitting out a shared chunk. sw.build.test.ts asserts the emitted
        // file really does contain no import statement.
        entryFileNames: (chunk) =>
          chunk.name === SW_ENTRY ? SW_FILE : 'assets/[name]-[hash].js',
      },
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    // Under src/testing/ because that is the one directory styles.css
    // excludes from Tailwind's scan by name. The setup file is not called
    // `*.test.*`, so anywhere else in src/ it sits inside the scan perimeter
    // — one `className` away from compiling a test-only class into the
    // shipped stylesheet, which is the exact hazard the exclusion exists for.
    setupFiles: ['./src/testing/test-setup.ts'],
  },
})
