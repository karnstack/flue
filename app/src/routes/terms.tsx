// /terms — what this service is for, and what happens when it is used for
// something else.
//
// A shell relay is dual-use in the plainest sense: the same bytes that let
// somebody fix a build from their phone let somebody else run a stranger's
// laptop. So this page exists to say three things out loud, before anyone signs
// up rather than after something goes wrong:
//
//   1. what the service may be used for (your own machines, and nothing else);
//   2. that an account or a single machine can be switched off — the kill
//      switch in server/kill-switch.ts, stated as a term rather than
//      discovered as an outage;
//   3. where to write when somebody is on the receiving end of it.
//
// Placeholder in the sense the plan means: plain English written by the people
// building it, not a lawyer's document, and it says so. The *policy* is not
// placeholder — every sentence about the kill switch describes code that
// exists, and `test/terms.test.ts` pins that this page is reachable and linked
// from the sign-in screen.
//
// No session, no loader, no server function: a static document, so a signed-out
// visitor (which is everyone reading it before they sign up) gets it server-
// rendered on the first request.
import { createFileRoute } from '@tanstack/react-router'
import { ArrowLeftIcon } from 'lucide-react'
import { Button } from '../components/ui/button'
import { Separator } from '../components/ui/separator'

/** Where an abuse report goes. Repeated in the copy, so it is written once. */
const ABUSE_CONTACT = 'abuse@flue.sh'

export const Route = createFileRoute('/terms')({
  component: TermsPage,
  head: () => ({ meta: [{ title: 'Terms of service — flue' }] }),
})

function TermsPage() {
  return (
    // `max-w-2xl` — a measure, not the page width the other screens use. This is
    // the one page on the service that is read rather than operated, and a
    // paragraph run out to the width of a device list is a paragraph nobody
    // finishes.
    <main className="mx-auto w-full max-w-2xl px-4 py-8 sm:px-6 sm:py-12">
      <header className="flex flex-col gap-3">
        <h1 className="font-heading text-xl font-medium tracking-tight text-balance sm:text-2xl">
          Terms of service
        </h1>
        <p className="text-base/7 text-pretty text-muted-foreground sm:text-sm/6">
          flue.sh is small and invite-only. These terms are short, in plain English, and written by
          the people who build it — not a lawyer. Everything they say about switching an account off
          is a description of code that exists.
        </p>
      </header>

      <Separator className="my-8" />

      {/* One size for the whole document, set once on the container: 16px on a
          phone, where these paragraphs are most likely to be read, settling to
          14px where the measure is wider. */}
      <div className="flex flex-col gap-8 text-base/7 text-pretty sm:text-sm/6">
        <Section title="What flue.sh does">
          <p>
            flue.sh connects your browser to a terminal on a machine you have connected to your
            account. The relay carries that session between the two. It is not your machine, it does
            not choose what runs there, and the daemon you installed runs commands as whoever
            started it.
          </p>
        </Section>

        <Section title="Acceptable use">
          <p>
            Use flue.sh to reach <strong>machines you own or are authorised to administer</strong>.
            That is the whole rule; everything below is what it rules out.
          </p>
          <ul className="flex list-disc flex-col gap-2 pl-5">
            <li>
              Do not connect a machine you do not have permission to control, or use a session to
              reach systems that somebody else runs.
            </li>
            <li>
              Do not use flue.sh as a step in attacking anyone — as a way to disguise where traffic
              comes from, as command-and-control for software you have put on other people’s
              computers, or to move stolen data.
            </li>
            <li>Do not use it for anything unlawful where you are, or where your machines are.</li>
            <li>
              Do not try to reach another account’s machines, or the service’s own infrastructure,
              beyond what the product hands you.
            </li>
          </ul>
        </Section>

        <Section title="Accounts and machines can be switched off">
          <p>
            We can disable an account, or a single machine on an account, at any time and without
            notice — if we believe it is being used against these terms, if we are required to, or
            if the service itself is at risk.
          </p>
          <p>
            What that does, precisely: when we disable an account we delete its sessions, so
            everyone signed into it is signed out at once, no new terminal session can be opened,
            and no connected machine can renew the short-lived credential it needs to stay
            reachable. Because those sessions are deleted rather than paused, switching an account
            back on does not restore them — you sign in again. A terminal that is already open ends
            when it is closed or when the machine next reconnects, whichever comes first.
          </p>
          <p>
            Switching off a single machine leaves you signed in and your other machines working, and
            it stays switched off: reinstalling flue and connecting that machine again does not turn
            it back on, and neither does removing it from your dashboard — a machine we have
            switched off stays on your list, marked, and cannot be removed from there. Only we can
            turn it back on.
          </p>
          <p>
            Short of that, you can take a machine off your account yourself at any time: remove it
            from the dashboard and it can no longer be reached. To end a session that is open right
            now, stop the flue daemon on that machine.
          </p>
        </Section>

        <Section title="Reporting abuse">
          <p>
            If a machine reachable through flue.sh is being used against you, write to{' '}
            <a className="underline underline-offset-4" href={`mailto:${ABUSE_CONTACT}`}>
              {ABUSE_CONTACT}
            </a>
            . Include what you saw, the addresses involved and the times — with timestamps we can
            find the account and switch it off.
          </p>
          <p>
            Security problems in flue.sh itself go to the same address. We would much rather hear
            about them from you.
          </p>
        </Section>

        <Section title="Your side of it">
          <p>
            Anyone who can sign into your account can open a terminal on every machine you have
            connected, so the email address on the account is the key to all of them. Keep it
            secure, and remove machines you no longer use.
          </p>
        </Section>

        <Section title="No warranty">
          <p>
            flue.sh is provided as it is, with no promise that it will be available, and no
            liability for what happens if it is not. It is early software running someone’s shell:
            do not make it the only way to reach something you cannot afford to lose access to.
          </p>
        </Section>

        <Section title="Changes">
          <p>
            These terms will change as the service does. Continuing to use flue.sh after they change
            means the new ones apply; anything that materially changes what is allowed will be said
            on this page.
          </p>
        </Section>
      </div>

      <Separator className="my-8" />

      <Button variant="outline" size="sm" asChild>
        <a href="/login">
          <ArrowLeftIcon data-icon="inline-start" />
          Back to sign in
        </a>
      </Button>
    </main>
  )
}

/** One titled block. The heading level is fixed: this page is a flat list of them. */
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="font-heading text-base font-medium tracking-tight text-balance">{title}</h2>
      {children}
    </section>
  )
}
