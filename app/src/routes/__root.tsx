import { createRootRoute, HeadContent, Scripts } from '@tanstack/react-router'
// `?url` rather than a bare import: this is the shell, which is rendered on the
// server, and a bare CSS import would have to be turned into an injected style
// tag by the bundler. Asking Vite for the emitted file's URL puts the compiled
// stylesheet in a <link> in the document head instead — one cacheable file,
// present before the first paint rather than after hydration.
import appCss from '../styles.css?url'

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { title: 'flue' },
    ],
    links: [{ rel: 'stylesheet', href: appCss }],
  }),
  shellComponent: RootDocument,
})

function RootDocument({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  )
}
