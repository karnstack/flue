// The document every screen on app.flue.sh is rendered into.
//
// Three things live here and nowhere else, and each of them is here because it
// has to be exactly one per page.
//
// **The chrome.** A hairline header carrying the flue mark, and a footer with
// the two links every page owes a reader. Four screens that each drew their own
// heading and nothing else read as four small tools; the same four under one
// bar read as one product — and the mark is the daemon dashboard's mark, pixel
// for pixel (see components/wordmark.tsx), because that dashboard is the other
// half of the same thing.
//
// **The toaster.** Sonner keeps one global queue, so a second `<Toaster/>`
// mounted by a route renders every toast twice. It lives at the root, which is
// also what lets any screen call `toast(...)` without wiring anything.
//
// **The column.** `min-h-svh` and `flex-1` here rather than on each screen: a
// page that centres itself with its own `min-h-svh` under a header is a page
// that is one header taller than the viewport, and scrolls for no reason.
import { createRootRoute, HeadContent, Scripts } from '@tanstack/react-router'
import { Toaster } from '@/components/ui/sonner'
import { Wordmark } from '@/components/wordmark'
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
    <html lang="en" className="antialiased">
      <head>
        <HeadContent />
      </head>
      <body>
        {/* `isolate` on the app container, so a portalled overlay — a dialog, a
            dropdown, a toast — stacks against the viewport rather than against
            whatever happens to have a z-index inside the page. */}
        <div className="isolate flex min-h-svh flex-col">
          <SiteHeader />
          {/* `flex-1` and a column, so a screen that wants to centre itself can
              say `flex-1 place-content-center` instead of claiming the whole
              viewport height a second time. */}
          <div className="flex flex-1 flex-col">{children}</div>
          <SiteFooter />
        </div>
        <Toaster />
        <Scripts />
      </body>
    </html>
  )
}

/**
 * The bar at the top of every screen: the mark, and nothing else.
 *
 * Deliberately empty on the right. This shell is rendered without a loader, so
 * it does not know whether the visitor has a session — and a nav that offered
 * "Your machines" to a signed-out reader, or "Sign in" to a signed-in one,
 * would be the one element on the page that is wrong half the time. Each screen
 * carries its own actions, where the answer is known.
 */
function SiteHeader() {
  return (
    <header className="border-b border-foreground/10">
      <div className="mx-auto flex h-14 w-full max-w-4xl items-center px-4 sm:px-6 lg:px-8">
        <a
          href="/"
          aria-label="Homepage"
          className="rounded-md outline-offset-4 focus-visible:outline-2"
        >
          <Wordmark />
        </a>
      </div>
    </header>
  )
}

/**
 * The two links every page owes a reader: what they agreed to, and where to
 * write when something is being done to them through this service.
 *
 * The abuse address is on /terms too. It is repeated here because the person
 * who needs it most is not the account holder — it is whoever is on the
 * receiving end of a machine, and they will not read the terms first.
 */
function SiteFooter() {
  return (
    <footer className="border-t border-foreground/10">
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-2 px-4 py-6 text-base/6 text-muted-foreground sm:flex-row sm:items-center sm:justify-between sm:px-6 sm:text-sm/6 lg:px-8">
        <p>flue.sh — a terminal on your own machines, from anywhere.</p>
        <nav className="flex items-center gap-4">
          <a className="underline underline-offset-4 hover:text-foreground" href="/terms">
            Terms
          </a>
          <a
            className="underline underline-offset-4 hover:text-foreground"
            href="mailto:abuse@flue.sh"
          >
            Report abuse
          </a>
        </nav>
      </div>
    </footer>
  )
}
