import { chrome } from './theme'

export interface ManifestIcon {
  src: string
  sizes: string
  type: 'image/png'
  purpose: 'any' | 'maskable'
}

export interface WebAppManifest {
  id: string
  name: string
  short_name: string
  description: string
  start_url: string
  scope: string
  display: 'standalone'
  theme_color: string
  background_color: string
  icons: ManifestIcon[]
}

/**
 * The web app manifest, built rather than committed so its colours cannot
 * drift from the design tokens.
 *
 * `flue open` and `flue serve` hand the browser a URL carrying
 * `?h=<one-time handoff token>`. `start_url` is deliberately the bare origin:
 * an installed app that captured the launch URL would relaunch forever with a
 * token the daemon invalidated on first use.
 */
export function buildManifest(): WebAppManifest {
  return {
    id: '/',
    name: 'flue',
    short_name: 'flue',
    description: 'Your terminal, as a browser tab.',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    theme_color: chrome.canvasDark,
    background_color: chrome.canvasDark,
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      {
        src: '/icons/icon-maskable-192.png',
        sizes: '192x192',
        type: 'image/png',
        purpose: 'maskable',
      },
      {
        src: '/icons/icon-maskable-512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'maskable',
      },
    ],
  }
}
