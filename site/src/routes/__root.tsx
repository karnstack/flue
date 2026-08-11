import { createRootRoute, HeadContent, Scripts } from '@tanstack/react-router'
import type { ReactNode } from 'react'

import { SITE_URL } from '@/lib/site'
import appCss from '@/styles.css?url'

const TITLE = 'flue: continue your Claude Code and Codex sessions on any screen'
const DESCRIPTION =
  'Start on your laptop, check in from your phone or iPad, pick up again at your desk. A small Go daemon holds your terminals, so closing the tab detaches a session instead of killing it. One static Go binary, no hosted service.'

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { title: TITLE },
      { name: 'description', content: DESCRIPTION },
      { property: 'og:title', content: TITLE },
      { property: 'og:description', content: DESCRIPTION },
      { property: 'og:type', content: 'website' },
      { property: 'og:site_name', content: 'flue' },
      { property: 'og:url', content: SITE_URL },
      { property: 'og:image', content: `${SITE_URL}/og.png` },
      { property: 'og:image:width', content: '1200' },
      { property: 'og:image:height', content: '630' },
      {
        property: 'og:image:alt',
        content: 'flue: your agent, build and SSH sessions on every screen you own',
      },
      { name: 'twitter:card', content: 'summary_large_image' },
      { name: 'theme-color', media: '(prefers-color-scheme: light)', content: '#ffffff' },
      { name: 'theme-color', media: '(prefers-color-scheme: dark)', content: '#09090b' },
    ],
    links: [
      { rel: 'icon', href: '/favicon.svg', type: 'image/svg+xml' },
      { rel: 'preconnect', href: 'https://rsms.me' },
      { rel: 'preconnect', href: 'https://fonts.gstatic.com', crossOrigin: 'anonymous' },
      { rel: 'stylesheet', href: appCss },
    ],
  }),
  shellComponent: RootDocument,
})

/* Runs before first paint, so the stored choice (or the OS preference when
   there is none) is on <html> before anything renders and the page never
   flashes the wrong theme. ThemeToggle keeps it in sync from then on. */
const THEME_SCRIPT = `(function(){try{var t=localStorage.getItem("theme");var d=t==="dark"||(t!=="light"&&matchMedia("(prefers-color-scheme: dark)").matches);document.documentElement.classList.toggle("dark",d)}catch(e){}})()`

function RootDocument({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className="antialiased" suppressHydrationWarning>
      <head>
        <HeadContent />
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body className="bg-background font-sans text-foreground">
        <div className="isolate">{children}</div>
        <Scripts />
      </body>
    </html>
  )
}
