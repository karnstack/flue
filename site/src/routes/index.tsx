import { Fragment } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { ArrowRight, Cloud, HardDrive, Lock, Plus, Smartphone } from 'lucide-react'

import { CopyCommand } from '@/components/copy-command'
import { FleetWindow, PhoneFrame } from '@/components/mock/fleet'
import { SwitcherWindow } from '@/components/mock/switcher'
import { MockTerminal, ok, output, prompt } from '@/components/mock/terminal'
import { SiteFooter } from '@/components/site-footer'
import { SiteHeader } from '@/components/site-header'
import { GithubMark } from '@/components/wordmark'
import { BREW_CMD, INSTALL_CMD, REPO_URL } from '@/lib/site'

export const Route = createFileRoute('/')({
  component: Home,
})

const RELAY_LINES = [
  prompt('flue relay setup'),
  ok('token verified'),
  ok('worker deployed: flue-relay'),
  ok('web app uploaded'),
  ok('reachable at https://flue-relay.you.workers.dev'),
  ok('fleet key minted (Cloudflare never sees it)'),
  ok('this machine joined as laptop (laptop-9f3a-3f9a12cd)'),
  output('\n  to add another machine, run this on it:\n'),
  output('    flue relay join wss://flue-relay.you.workers.dev --secret … --fleet …'),
]

/**
 * Four sections, where there were seven.
 *
 * The seven were a problem/solution/trust/CTA run, which is the shape a SaaS
 * landing page takes and the wrong dress for a thing one person wrote for
 * themselves and gave away. What replaced the three-card problem grid is one
 * true story about why it exists, which is shorter and argues better.
 */
function Home() {
  return (
    <>
      <SiteHeader />
      <main className="relative">
        <Rails />
        <Hero />
        <SectionRule />
        <Sessions />
        <SectionRule />
        <Remote />
        <SectionRule />
        <Install />
      </main>
      <SiteFooter />
    </>
  )
}

/**
 * Two dashed rails at the container's edges, running the height of the page.
 *
 * They are the page's only structural line: every section's content already
 * aligns to them, so drawing them turns an invisible measure into something
 * the eye can follow, and the plus marks where a section rule crosses them
 * turn each boundary into a corner rather than a cut.
 */
function Rails() {
  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden">
      <div className="mx-auto h-full max-w-6xl border-x border-dashed border-zinc-950/12 dark:border-white/12" />
    </div>
  )
}

/** A section boundary: a dashed rule, crossed at both rails. */
function SectionRule() {
  return (
    <div aria-hidden="true" className="relative border-t border-dashed border-border">
      <div className="absolute inset-x-0 -top-px mx-auto max-w-6xl">
        <Plus className="absolute -top-2 -left-2 size-4 text-zinc-950/20 dark:text-white/20" />
        <Plus className="absolute -top-2 -right-2 size-4 text-zinc-950/20 dark:text-white/20" />
      </div>
    </div>
  )
}

/* ---------------------------------------------------------------- hero --- */

function Eyebrow() {
  return (
    <a
      href={REPO_URL}
      target="_blank"
      rel="noreferrer"
      /* Nowrap and short on purpose: a pill that wraps to two lines stops
         reading as a pill. */
      className="inline-flex items-center gap-2 rounded-full border border-border py-1 pr-3 pl-1.5 text-sm whitespace-nowrap text-muted-foreground hover:bg-accent hover:text-foreground"
    >
      <span className="rounded-full bg-primary/10 px-2 py-0.5 font-mono text-xs font-medium text-primary">
        MIT
      </span>
      Open source, no hosted service
    </a>
  )
}

function Headline() {
  return (
    <h1 className="max-w-[24ch] text-4xl font-semibold tracking-tight text-balance sm:text-5xl lg:text-6xl">
      The desk stops mattering.
    </h1>
  )
}

function Subline() {
  return (
    <p className="mt-5 max-w-[52ch] text-lg text-pretty text-muted-foreground">
      Builds, agents and SSH sessions keep running on the machine that owns them. Every one of them
      is one tab away, on any screen you have.
    </p>
  )
}

function InstallBlock({ align = 'left' }: { align?: 'left' | 'center' }) {
  return (
    <div className={align === 'center' ? 'mx-auto max-w-xl' : 'max-w-xl'}>
      <CopyCommand command={INSTALL_CMD} className="mt-8" />
      <p
        className={`mt-3 text-base text-muted-foreground sm:text-sm ${align === 'center' ? 'text-center' : ''}`}
      >
        or <code className="font-mono text-foreground">{BREW_CMD}</code>
      </p>
      <p
        className={`mt-1 text-base text-muted-foreground sm:text-sm ${align === 'center' ? 'text-center' : ''}`}
      >
        macOS, Linux, WSL. One static Go binary. No Node, no Python, no toolchain.
      </p>
    </div>
  )
}

/**
 * The two halves of the claim in one picture: the fleet on a machine, and the
 * ringed row of it open on a phone. They sit beside each other rather than
 * overlapping, since an overlap covers the rows the phone is meant to point
 * at, and the teal ring on the row is what pairs them. Below `lg` the phone
 * drops under the window, since neither fits beside the other at that width.
 */
function ProofMock() {
  return (
    <div className="relative">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -top-8 left-1/2 -z-10 h-56 w-4/5 -translate-x-1/2 rounded-[50%] bg-primary/20 blur-[110px]"
      />
      <div className="flex items-stretch gap-6 max-lg:flex-col max-lg:items-center">
        <FleetWindow className="w-full min-w-0 flex-1" />
        <PhoneFrame />
      </div>
    </div>
  )
}

function Hero() {
  return (
    <section className="relative overflow-hidden pt-16 pb-20 sm:pt-20 sm:pb-28">
      <div aria-hidden="true" className="backdrop-scan pointer-events-none absolute inset-0 -z-10" />

      <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8">
        <div className="flex flex-col items-center text-center">
          <Eyebrow />
          <div className="mt-6 flex flex-col items-center">
            <Headline />
            <Subline />
          </div>
          <div className="w-full">
            <InstallBlock align="center" />
          </div>
        </div>
        <div className="mt-16 lg:mt-20">
          <ProofMock />
        </div>
      </div>
    </section>
  )
}

/* ------------------------------------------------------------- sessions --- */

/**
 * Why it exists, what it does, and the palette you can actually use.
 *
 * One section for what used to be three. The story does the job the problem
 * grid was doing, at a fraction of its height and with the advantage of being
 * true, and the palette below it is the claim in the subline made testable:
 * the reader can press the chord on this page and watch the list arrive.
 */
function Sessions() {
  return (
    <section id="sessions" className="scroll-mt-20 py-20 sm:py-24">
      <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8">
        {/* Why it exists, beside what it is. Same grid and gap as Remote, so
            the column edges of the two sections line up down the page. */}
        <div className="grid grid-cols-[minmax(0,1fr)] gap-12 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:items-center lg:gap-10">
          <div>
            <p className="font-mono text-sm tracking-wide text-primary uppercase">Why it exists</p>
            <blockquote className="mt-6 border-l-2 border-primary/40 pl-5">
              <p className="max-w-[48ch] text-lg text-pretty">
                I wanted my 10,000 steps. Coding agents had other plans, and I am not buying a
                walking pad. So now I start the run on my machine, go for the walk, and read the
                answer on my phone.
              </p>
              <footer className="mt-3 text-base text-muted-foreground sm:text-sm">
                Karn, who wrote this instead of walking
              </footer>
            </blockquote>
          </div>

          <div>
            <h2 className="max-w-[35ch] text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
              One daemon owns the shells. Every screen is only a view.
            </h2>
            <p className="mt-5 max-w-[48ch] text-lg text-pretty text-muted-foreground">
              A small Go daemon holds the terminals and their scrollback. Closing the tab does not
              kill the session. It only detaches it. Reattach and the daemon replays what you
              missed.
            </p>
            <p className="mt-4 max-w-[48ch] text-lg text-pretty text-muted-foreground">
              Two devices can attach to one session and mirror live. Size follows the view you used
              last, so it fits the phone in your hand, and the laptop when you go back to it.
            </p>
          </div>
        </div>

        {/* The palette's heading group, with the heading holding the left
            column and its prose the right, so the run above the full-width
            drawing occupies the same measure the drawing does. */}
        <div className="mt-20 grid grid-cols-[minmax(0,1fr)] gap-x-10 gap-y-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:gap-10">
          <h3 className="max-w-[40ch] text-2xl font-semibold tracking-tight text-balance">
            Finding one of them is the other half.
          </h3>
          <div>
            <p className="max-w-[48ch] text-lg text-pretty text-muted-foreground">
              Press <kbd className="font-mono text-base text-foreground">&#8984;K</kbd> on a Mac, or{' '}
              <kbd className="font-mono text-base text-foreground">Ctrl+Shift+K</kbd> on any platform
              including macOS, from any screen that can see a daemon. Pinned sessions first, with
              number keys on them, then the ones this browser has opened, then the rest.
            </p>
            <p className="mt-4 max-w-[56ch] text-base/7 text-pretty text-muted-foreground sm:text-sm/6">
              The highlighted row shows its last fourteen lines, so you can see which one is the
              build. <kbd className="font-mono text-foreground">Ctrl+Shift+1</kbd> to{' '}
              <kbd className="font-mono text-foreground">9</kbd> jumps straight to a pinned session
              without opening the list. The one below is wired up: press either chord and type.
            </p>
          </div>
        </div>

        {/* Full width rather than in a column: the real dialog is 56rem across
            and the preview pane is the first thing a half-row takes away, which
            is the part worth showing. */}
        <div className="mt-12 lg:mt-14">
          <SwitcherWindow />
        </div>

        <a
          href="/docs/how-it-works"
          className="mt-10 inline-flex items-center gap-1.5 text-base font-medium text-primary hover:underline sm:text-sm"
        >
          How it is built
          <ArrowRight className="size-4 shrink-0" aria-hidden="true" />
        </a>
      </div>
    </section>
  )
}

/* --------------------------------------------------------------- remote --- */

/*
 * The three places your bytes are, in order.
 *
 * The middle one is the point: it is the box you do not have to trust, and it
 * is drawn between the other two so that the dashed run passing through it
 * reads as one channel rather than two hops. The device box says the browser
 * pins the daemon's key, because the browser holds a long-lived key of its own
 * (web/src/crypto/keys.ts) and this panel used to claim the daemon held the
 * only one.
 */
const PATH = [
  {
    title: 'Your machine',
    body: 'The daemon owns the terminals and holds the key your browser pins. It listens on loopback and nothing else.',
    mono: '127.0.0.1:7717',
    icon: HardDrive,
  },
  {
    title: 'Your Cloudflare account',
    body: 'A relay Worker you deployed forwards ciphertext between devices. It holds no key, so it can read nothing.',
    mono: 'flue-relay.you.workers.dev',
    icon: Cloud,
  },
  {
    title: 'Your other devices',
    body: 'Each browser pairs once from a QR code, and pins the daemon’s key from then on.',
    mono: 'phone · tablet · second laptop',
    icon: Smartphone,
  },
]

/**
 * Remote access and the trust argument, together.
 *
 * They were two sections saying one thing twice: the prose and the path both
 * argued that the middle holds no key. Merged, the prose makes the claim and
 * the path shows it, which is the division of labour they should have had.
 */
function Remote() {
  return (
    <section id="remote" className="scroll-mt-20 py-20 sm:py-24">
      <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8">
        <div className="grid grid-cols-[minmax(0,1fr)] gap-12 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:items-center lg:gap-10">
          <MockTerminal
            title="flue relay setup"
            lines={RELAY_LINES}
            className="shadow-xl lg:order-2"
          />
          <div>
            <p className="font-mono text-sm tracking-wide text-primary uppercase">Remote access</p>
            <h2 className="mt-3 max-w-[35ch] text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
              Reachable from anywhere, with nobody in the middle.
            </h2>
            <p className="mt-5 max-w-[48ch] text-lg text-pretty text-muted-foreground">
              The daemon listens on loopback and nothing else. One command deploys a relay Worker
              and this web app into your own Cloudflare account, on the free plan, and every machine
              you own shares it.
            </p>
            <p className="mt-4 max-w-[56ch] text-base/7 text-pretty text-muted-foreground sm:text-sm/6">
              Everything crossing it is end-to-end encrypted with Noise IK. Your browser pins the
              daemon&rsquo;s key when it pairs, so the Worker forwards ciphertext it holds no key
              for. The relay is new: it works, but it has not been through its release gate, so
              treat it as ready to try rather than ready to rely on.
            </p>
            <a
              href="/docs/relay"
              className="mt-6 inline-flex items-center gap-1.5 text-base font-medium text-primary hover:underline sm:text-sm"
            >
              What it deploys, and what it costs
              <ArrowRight className="size-4 shrink-0" aria-hidden="true" />
            </a>
          </div>
        </div>

        <div className="mt-16 border-t border-dashed border-border pt-10">
          <p className="max-w-[56ch] text-lg text-pretty text-muted-foreground">
            There is no flue account, no flue server and no billing, because there is no company.
            There is me and a Cloudflare free plan. flue.sh serves docs and downloads, and is never
            part of the data path.
          </p>

          {/* The three places, as a path rather than as three cards: dashed
              connectors carry the Noise IK channel from end to end, and the
              middle box is deliberately the one that holds no key. */}
          <ol
            role="list"
            className="mt-12 grid grid-cols-[minmax(0,1fr)] gap-y-10 lg:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)_auto_minmax(0,1fr)] lg:items-stretch lg:gap-y-0"
          >
            {PATH.map((step, i) => (
              <Fragment key={step.title}>
                {i > 0 && <Connector />}
                <li className="relative rounded-xl border border-dashed border-border p-6">
                  <span
                    aria-hidden="true"
                    className="absolute -top-3 left-6 flex items-center gap-2 bg-background px-2 font-mono text-xs tabular-nums text-muted-foreground"
                  >
                    {String(i + 1).padStart(2, '0')}
                  </span>
                  <step.icon className="size-5 shrink-0 text-primary" aria-hidden="true" />
                  <p className="mt-4 text-lg font-medium">{step.title}</p>
                  <p className="mt-2 text-base/7 text-pretty text-muted-foreground sm:text-sm/6">
                    {step.body}
                  </p>
                  <p className="mt-4 truncate font-mono text-xs text-primary">{step.mono}</p>
                </li>
              </Fragment>
            ))}
          </ol>

          <p className="mt-10 flex items-center gap-3 font-mono text-xs text-muted-foreground">
            <Lock className="size-3.5 shrink-0" aria-hidden="true" />
            Noise IK, end to end. The middle box forwards bytes it cannot read.
          </p>
        </div>
      </div>
    </section>
  )
}

/**
 * The dashed run between two boxes in the path. Horizontal from `lg`, where
 * the boxes sit in a row; vertical below it, where they stack.
 */
function Connector() {
  return (
    <li aria-hidden="true" className="flex items-center justify-center lg:px-4">
      <span className="flex items-center gap-1 max-lg:hidden">
        <span className="w-10 border-t border-dashed border-border" />
        <ArrowRight className="size-3.5 shrink-0 text-muted-foreground" />
      </span>
      <span className="flex flex-col items-center gap-1 lg:hidden">
        <span className="h-6 border-l border-dashed border-border" />
      </span>
    </li>
  )
}

/* -------------------------------------------------------------- install --- */

function Install() {
  return (
    <section className="py-20 sm:py-24">
      <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8">
        <div className="flex flex-col items-center text-center">
          <h2 className="max-w-[30ch] text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
            Install it, then close the tab on purpose.
          </h2>
          <p className="mt-5 max-w-[48ch] text-lg text-pretty text-muted-foreground">
            <code className="font-mono text-foreground">flue enable</code> installs a login service,
            starts the daemon and opens the UI. Everything after that happens in the browser.
          </p>
          <p className="mt-3 max-w-[48ch] text-base text-muted-foreground sm:text-sm">
            Setting up more than one machine?{' '}
            <a href="/docs/setup" className="text-primary underline underline-offset-4">
              Read the setup guide
            </a>
            .
          </p>
          <div className="w-full">
            <InstallBlock align="center" />
          </div>
          <a
            href={REPO_URL}
            target="_blank"
            rel="noreferrer"
            className="mt-8 inline-flex items-center gap-2 text-base font-medium text-muted-foreground hover:text-foreground sm:text-sm"
          >
            <GithubMark className="size-4 shrink-0" />
            Read the source
          </a>
        </div>
      </div>
    </section>
  )
}
