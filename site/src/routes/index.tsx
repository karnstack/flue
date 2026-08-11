import { Fragment } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { ArrowRight, Cloud, HardDrive, Lock, Plus, Smartphone } from 'lucide-react'

import { CopyCommand } from '@/components/copy-command'
import { ScatteredFigure, WaitingFigure, WindowFigure } from '@/components/mock/figures'
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

const ENABLE_LINES = [
  prompt('flue enable'),
  ok('login service installed'),
  ok('daemon running on 127.0.0.1:7717'),
  output('  opening http://127.0.0.1:7717'),
]

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

const PROBLEMS = [
  {
    term: 'You close the window and the build dies.',
    detail:
      'A shell belongs to the window that opened it. Lose the window, through a reboot, a dropped SSH link or a closed tab, and you lose what was running in it. You also lose the twenty minutes it takes to get back to where you were.',
    figure: WindowFigure,
  },
  {
    term: 'The agent asked a question an hour ago.',
    detail:
      'Long jobs need answers at times when you are not at your desk. If you cannot reach the machine from the device in your pocket, the run just sits there and waits for you.',
    figure: WaitingFigure,
  },
  {
    term: 'Four machines, and no single list.',
    detail:
      'A laptop, a desktop, a Pi, a VPS. Each one keeps its sessions to itself. To find out what is running, you have to log in to all four and read four answers.',
    figure: ScatteredFigure,
  },
]

function Home() {
  return (
    <>
      <SiteHeader />
      <main className="relative">
        <Rails />
        <Hero />
        <SectionRule />
        <Problem />
        <SectionRule />
        <How />
        <SectionRule />
        <Switcher />
        <SectionRule />
        <Remote />
        <SectionRule />
        <Trust />
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
      Builds, agents and SSH sessions keep running on the machine that owns them. Every one of
      them is one tab away, on any screen you have.
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
 * overlapping — an overlap covers the rows the phone is meant to point at —
 * and the teal ring on the row is what pairs them. Below `lg` the phone drops
 * under the window, since neither fits beside the other at that width.
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
      <div
        aria-hidden="true"
        className="backdrop-scan pointer-events-none absolute inset-0 -z-10"
      />

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

/* ------------------------------------------------------------- problem --- */

function Problem() {
  return (
    <section id="problem" className="scroll-mt-20 py-20 sm:py-24">
      <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8">
        <p className="font-mono text-sm tracking-wide text-primary uppercase">The problem</p>
        <h2 className="mt-3 max-w-[35ch] text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
          A terminal forgets you.
        </h2>
        <p className="mt-5 max-w-[56ch] text-lg text-pretty text-muted-foreground">
          Every shell is tied to the window that opened it, and to the machine it runs on. You walk
          away from both.
        </p>

        <dl className="mt-12 grid gap-x-8 gap-y-10 border-t border-dashed border-border pt-10 sm:grid-cols-3">
          {PROBLEMS.map((item) => (
            <div key={item.term}>
              <item.figure />
              <dt className="mt-6 text-lg font-medium text-pretty">{item.term}</dt>
              <dd className="mt-2 text-base/7 text-pretty text-muted-foreground sm:text-sm/6">
                {item.detail}
              </dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  )
}

/* ------------------------------------------------------------------ how --- */

function How() {
  return (
    <section id="how" className="scroll-mt-20 py-20 sm:py-24">
      <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8">
        <div className="grid grid-cols-[minmax(0,1fr)] gap-12 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:items-center lg:gap-10">
          <div>
            <p className="font-mono text-sm tracking-wide text-primary uppercase">How it works</p>
            <h2 className="mt-3 max-w-[35ch] text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
              One daemon owns the shells. Every device just shows them.
            </h2>
            <p className="mt-5 max-w-[56ch] text-lg text-pretty text-muted-foreground">
              A small Go daemon holds the terminals and their scrollback. Closing the tab does not
              kill the session. It only detaches it, so the build keeps going. Reattach and the
              daemon replays what you missed.
            </p>
            <p className="mt-4 max-w-[56ch] text-lg text-pretty text-muted-foreground">
              Two devices can attach to one session and they mirror live. What you type on the phone
              appears in the laptop&rsquo;s browser. Size follows the view you are using. Pick up
              the phone and the session fits the phone. Type on the laptop and it fits the
              laptop again.
            </p>
            <a
              href="/docs/how-it-works"
              className="mt-6 inline-flex items-center gap-1.5 text-base font-medium text-primary hover:underline sm:text-sm"
            >
              How it is built
              <ArrowRight className="size-4 shrink-0" aria-hidden="true" />
            </a>
          </div>
          <MockTerminal title="flue enable" lines={ENABLE_LINES} className="shadow-xl" />
        </div>
      </div>
    </section>
  )
}

/* ------------------------------------------------------------ switching --- */

/**
 * The switcher, full width rather than in a column.
 *
 * The real dialog is 56rem across and does not survive being squeezed into
 * half a row: the preview pane is the first thing to go, and the pane is the
 * argument. Full width also keeps the rhythm either side of it, since How
 * puts its text on the left and Remote puts its mock there.
 */
function Switcher() {
  return (
    <section id="switching" className="scroll-mt-20 py-20 sm:py-24">
      <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8">
        <div className="max-w-[60ch]">
          <p className="font-mono text-sm tracking-wide text-primary uppercase">Switching</p>
          <h2 className="mt-3 max-w-[35ch] text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
            The list comes to you.
          </h2>
          <p className="mt-5 text-lg text-pretty text-muted-foreground">
            Press <kbd className="font-mono text-base text-foreground">&#8984;K</kbd> on a Mac, or{' '}
            <kbd className="font-mono text-base text-foreground">Ctrl+Shift+K</kbd> on any platform
            including macOS, on any screen that can see a daemon. Pinned sessions come first, with
            number keys on them. Then the sessions this browser has opened before. Then the rest.
          </p>
          <p className="mt-4 text-base/7 text-pretty text-muted-foreground sm:text-sm/6">
            Type to narrow the list, use the arrow keys to move, press Enter to go. The
            highlighted row shows its own last fourteen lines beside the list, so you can see
            which one is the build instead of guessing from its name.{' '}
            <kbd className="font-mono text-foreground">Ctrl+Shift+1</kbd> to{' '}
            <kbd className="font-mono text-foreground">9</kbd> jumps straight to a pinned session
            without opening the list at all.
          </p>
        </div>
        <div className="mt-12 lg:mt-14">
          <SwitcherWindow />
        </div>
      </div>
    </section>
  )
}

/* --------------------------------------------------------------- remote --- */

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
              Reachable from anywhere, on infrastructure you own.
            </h2>
            <p className="mt-5 max-w-[56ch] text-lg text-pretty text-muted-foreground">
              The daemon listens on loopback and nothing else, so reaching it from somewhere else is
              opt-in and takes one command. That command deploys a relay Worker and this web app
              into your own Cloudflare account, on the free plan. Every machine you own shares it.
            </p>
            <p className="mt-4 max-w-[56ch] text-base/7 text-pretty text-muted-foreground sm:text-sm/6">
              Everything crossing the relay is end-to-end encrypted with Noise IK. Your browser pins
              the daemon&rsquo;s key when it pairs, so the Worker only forwards ciphertext it holds
              no key for. The relay is new. It is built and it works, but it has not been through
              its release gate yet, so treat it as ready to try rather than ready to rely on.
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
      </div>
    </section>
  )
}

/* ---------------------------------------------------------------- trust --- */

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

function Trust() {
  return (
    <section id="trust" className="scroll-mt-20 py-20 sm:py-24">
      <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8">
        <p className="font-mono text-sm tracking-wide text-primary uppercase">Trust</p>
        <h2 className="mt-3 max-w-[35ch] text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
          There is no hosted service.
        </h2>
        <p className="mt-5 max-w-[56ch] text-lg text-pretty text-muted-foreground">
          No flue account, no flue server, no billing. Three places, and all of them are yours.
          flue.sh serves docs and downloads. It is never part of the data path.
        </p>

        {/* The three places, as a path rather than as three cards: dashed
            connectors carry the Noise IK channel from end to end, and the
            middle box is deliberately the one that holds no key. */}
        <ol
          role="list"
          className="mt-14 grid grid-cols-[minmax(0,1fr)] gap-y-10 lg:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)_auto_minmax(0,1fr)] lg:items-stretch lg:gap-y-0"
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
