// / — the front door.
//
// Not a marketing page: that is `site/`, served from flue.sh itself. This is
// app.flue.sh, which only ever has two kinds of visitor — somebody who is
// signed in and wants their machines, and somebody who is not and wants to sign
// in — so the page is one sentence and two links.
//
// It deliberately does not redirect. A loader that sent a signed-out visitor
// to /login would make the bookmarked address of this app a place you can never
// look at, and a signed-in one to /devices would cost every visit a round trip
// to decide something the two links below settle for free.
import { createFileRoute } from '@tanstack/react-router'
import { LogInIcon, MonitorSmartphoneIcon } from 'lucide-react'
import { Button } from '../components/ui/button'

export const Route = createFileRoute('/')({ component: Index })

function Index() {
  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col justify-center gap-6 px-4 py-12 sm:px-6 sm:py-16">
      <div className="flex flex-col gap-3">
        {/* Not the footer's line. That one is the product's, repeated on every
            screen; saying it twice on the one page where both are visible
            reads as a template that ran out of copy. */}
        <h1 className="font-heading text-2xl font-medium tracking-tight text-balance sm:text-3xl">
          Your machines, one sign-in away.
        </h1>
        <p className="max-w-[60ch] text-base/7 text-pretty text-muted-foreground sm:text-sm/6">
          flue.sh is the control plane for the flue daemon. Sign in, connect a machine with{' '}
          <code className="font-mono">flue enable</code>, and open a shell on it from any browser —
          a phone included.
        </p>
      </div>

      {/* Stacked and full width on a phone, side by side above it. Two
          half-width buttons at 390px is two truncated labels. */}
      <div className="flex flex-col gap-3 sm:flex-row">
        <Button asChild>
          <a href="/login">
            <LogInIcon data-icon="inline-start" />
            Sign in
          </a>
        </Button>
        <Button variant="outline" asChild>
          <a href="/devices">
            <MonitorSmartphoneIcon data-icon="inline-start" />
            Your machines
          </a>
        </Button>
      </div>
    </main>
  )
}
