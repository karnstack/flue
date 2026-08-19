import { createFileRoute } from '@tanstack/react-router'
import type { ReactNode } from 'react'

import { Code, DocPage, Link, P } from '@/components/doc-page'
import { docTitle, findDoc } from '@/lib/docs'
import { REPO_URL } from '@/lib/site'

const DOC = findDoc('faq')!

export const Route = createFileRoute('/docs/faq')({
  head: () => ({
    meta: [{ title: docTitle(DOC) }, { name: 'description', content: DOC.blurb }],
  }),
  component: Faq,
})

const RELAY_DOC = `${REPO_URL}/blob/main/docs/RELAY.md`
const FAQ_DOC = `${REPO_URL}/blob/main/docs/faq.md`
const PROTOCOL_DOC = `${REPO_URL}/blob/main/spec/relay-protocol.md`

/**
 * The verdict is the answer. The body is for the reader who wants to know
 * why, and every one of them is short enough to read standing up: the long
 * versions live in the repository and are linked where they matter.
 */
const QUESTIONS: { q: string; verdict: string; body?: ReactNode }[] = [
  {
    q: 'Can flue read my terminal?',
    verdict: 'No. There is nothing of ours in the path to read it with.',
    body: (
      <P>
        There is no flue server. Local sessions never leave your machine. Remote ones cross a relay
        that runs in <em>your</em> Cloudflare account, not ours.
      </P>
    ),
  },
  {
    q: 'Can Cloudflare read it?',
    verdict: 'Not in transit. But encryption is not the whole story, and the rest matters.',
    body: (
      <>
        <P>
          Your browser and your daemon run a Noise IK handshake directly with each other. Your
          browser pinned the daemon&rsquo;s key when you paired the device. Everything after that
          is ciphertext, and the relay holds no key for it.
        </P>
        <P>
          Here is the part encryption does not fix. The web app&rsquo;s JavaScript is served by the
          relay origin, so you are trusting that origin to serve the published code. The code that
          holds your keys is code you fetched. This is true of every end-to-end encrypted web app,
          and it is true of this one. Self-hosting is the answer flue has, which is why it is the
          only way flue is deployed.
        </P>
        <P>
          The full version, including the exact move a hostile origin would make and what we do
          about it, is in <Link href={FAQ_DOC}>the repository&rsquo;s FAQ</Link>.
        </P>
      </>
    ),
  },
  {
    q: 'Does flue run any servers?',
    verdict: 'No, and none are planned.',
    body: (
      <P>
        <Code>flue relay setup</Code> deploys the Worker and the web app into your own Cloudflare
        account. No flue account, no billing, nothing of anyone else&rsquo;s between your browser
        and your machines. flue.sh is a landing page and stores nothing.
      </P>
    ),
  },
  {
    q: 'What does it cost?',
    verdict: "Nothing. It is MIT licensed, and Cloudflare's free plan covers personal use.",
    body: (
      <P>
        The relay is a Worker with one Durable Object per machine, plus one more for the fleet
        directory. What it deploys and what the caps are is in{' '}
        <Link href={RELAY_DOC}>the relay runbook</Link>.
      </P>
    ),
  },
  {
    q: 'Do I have to set up remote access?',
    verdict: 'No. The daemon listens on loopback and nothing else until you ask for more.',
    body: (
      <P>
        Remote access is one opt-in command. Skip it and flue is a local tool that happens to keep
        your sessions alive. The steps, if you want it, are in{' '}
        <Link href="/docs/setup">the setup guide</Link>.
      </P>
    ),
  },
  {
    q: 'How many relays do I need?',
    verdict: 'One, for all your machines.',
    body: (
      <P>
        Run <Code>flue relay setup</Code> on one machine, then run the join line it prints on every
        other machine. Running setup a second time does not add a relay. It replaces the one you
        have, with a fresh secret and a fresh fleet key, so every machine then has to re-join with
        the newly printed line and every device has to pair again.
      </P>
    ),
  },
  {
    q: 'Do I have to pair my phone with every machine?',
    verdict: 'No. Pair it once and it reaches the whole fleet.',
    body: (
      <P>
        The machine that runs the pairing signs a device certificate that every machine in the
        fleet accepts. You do pair per browser, though: Safari and Chrome on the same iPad each
        hold their own keys, so each one pairs on its own.
      </P>
    ),
  },
  {
    q: 'What happens when I close the tab?',
    verdict: 'Nothing. Closing detaches the session. It does not kill it.',
    body: (
      <P>
        The session owns its shell and its scrollback, so the build keeps running. Reattach from
        any device and it replays what you missed.
      </P>
    ),
  },
  {
    q: 'What happens to my sessions when flue updates or restarts?',
    verdict: 'Nothing. Sessions outlive the daemon.',
    body: (
      <P>
        Every session runs in its own small holder process, separate from the daemon. Update flue,
        restart it, even have it crash: the shells and agents keep running, and the next daemon
        picks them back up with their scrollback intact. A machine reboot is the one thing that
        ends a session, and even then flue brings it back with its history, a fresh shell, and the
        command that resumes the agent conversation it was in.
      </P>
    ),
  },
  {
    q: 'Can two devices use one session at once?',
    verdict: 'Yes, and they mirror live.',
    body: (
      <P>
        What you type on the phone appears in the laptop&rsquo;s browser. The terminal takes the
        size of whichever view you are using, so picking up the phone fits the session to the
        phone, and your next keystroke on the laptop fits it back.
      </P>
    ),
  },
  {
    q: 'What happens to sessions on a laptop that goes to sleep?',
    verdict: 'They stop running, and they come back when it wakes.',
    body: (
      <P>
        Nothing is lost. The switcher still shows the ones this browser has opened before, greyed
        and marked unreachable, and it still opens them. It remembers per browser, so your phone
        lists where your phone has been. If a job needs to keep going while you are away, start it
        on a machine that stays on: a desktop, a Pi, a VPS.
      </P>
    ),
  },
  {
    q: 'Which platforms?',
    verdict: 'macOS, Linux and WSL, as one static Go binary.',
    body: <P>No Node, no Python, no toolchain. Windows works through WSL.</P>,
  },
  {
    q: 'What can a relay operator see, even encrypted?',
    verdict: 'Who connected, when, how much traffic moved, and the whole pairing exchange.',
    body: (
      <P>
        Enough to analyse a session, never to read one. The pairing exchange is worth naming rather
        than filing under metadata: it crosses a cleartext control channel carrying a single-use
        token that lives two minutes. The full list is in{' '}
        <Link href={PROTOCOL_DOC}>the protocol spec</Link>.
      </P>
    ),
  },
]

function Faq() {
  return (
    <DocPage slug="faq" title={DOC.title} blurb={DOC.blurb}>
      <dl className="flex flex-col">
        {QUESTIONS.map((item, i) => (
          <div
            key={item.q}
            className={
              i === 0 ? 'py-8 first:pt-0' : 'border-t border-dashed border-border py-8 last:pb-0'
            }
          >
            <dt className="max-w-[40ch] text-xl font-semibold tracking-tight text-balance">
              {item.q}
            </dt>
            <dd className="mt-3 flex max-w-[68ch] flex-col gap-4">
              <p className="max-w-[60ch] text-lg/8 text-pretty">{item.verdict}</p>
              {item.body}
            </dd>
          </div>
        ))}
      </dl>
    </DocPage>
  )
}
