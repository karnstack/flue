import { createFileRoute } from '@tanstack/react-router'
import type { ReactNode } from 'react'

import { Code, DocPage, Link, P } from '@/components/doc-page'
import { findDoc } from '@/lib/docs'
import { REPO_URL } from '@/lib/site'

const DOC = findDoc('faq')!

export const Route = createFileRoute('/docs/faq')({
  head: () => ({
    meta: [{ title: `${DOC.title} — flue` }, { name: 'description', content: DOC.blurb }],
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
        There is no flue server. Local sessions never leave your machine, and remote ones cross a
        relay that runs in <em>your</em> Cloudflare account, not ours.
      </P>
    ),
  },
  {
    q: 'Can Cloudflare read it?',
    verdict: 'Not in transit. But encryption is not the whole story, and the rest matters.',
    body: (
      <>
        <P>
          Your browser and your daemon run a Noise IK handshake directly with each other, with the
          daemon's key pinned when you paired the device. Everything after that is ciphertext the
          relay holds no key for.
        </P>
        <P>
          The part encryption does not fix: the web app's JavaScript is served by the relay origin,
          so you are trusting that origin to serve the published code. Code that holds your keys is
          code you fetched. This is true of every end-to-end encrypted web app and it is true of
          this one. Self-hosting is the answer flue has, which is why it is the only deployment it
          offers.
        </P>
        <P>
          The full version, including the exact move a hostile origin would make and what we do
          about it, is in <Link href={FAQ_DOC}>the repository's FAQ</Link>.
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
        account. No flue account, no billing, nothing of anyone else's between your browser and
        your machines. flue.sh is a landing page and stores nothing.
      </P>
    ),
  },
  {
    q: 'What does it cost?',
    verdict: "Nothing. It is MIT licensed, and Cloudflare's free plan covers personal use.",
    body: (
      <P>
        The relay is a Worker with one Durable Object per machine. What it deploys and what the
        caps are is in <Link href={RELAY_DOC}>the relay runbook</Link>.
      </P>
    ),
  },
  {
    q: 'Do I have to set up remote access?',
    verdict: 'No. The daemon binds loopback and nothing else until you ask for more.',
    body: (
      <P>
        Remote access is one opt-in command. Skip it and flue is a local tool that happens to keep
        your sessions alive.
      </P>
    ),
  },
  {
    q: 'What happens when I close the tab?',
    verdict: 'Nothing. Closing detaches; it does not kill.',
    body: (
      <P>
        The daemon owns the shell and its scrollback, so the build keeps running. Reattach from any
        device and it replays what you missed.
      </P>
    ),
  },
  {
    q: 'Can two devices use one session at once?',
    verdict: 'Yes, and they mirror live.',
    body: (
      <P>
        Typing on the phone shows up in the laptop's browser. The phone's 40 columns do not shrink
        the laptop.
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
        Enough for traffic analysis of a session, never its content. The pairing exchange is the
        one worth naming rather than filing under metadata: it crosses a cleartext control channel
        carrying a single-use token that lives two minutes. The full list is in{' '}
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
