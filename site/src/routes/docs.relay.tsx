import { createFileRoute } from '@tanstack/react-router'

import { Code, DocPage, Lead, Link, Note, P, Section, Shell } from '@/components/doc-page'
import { RelayProtocol } from '@/components/mock/diagrams'
import { docTitle, findDoc } from '@/lib/docs'
import { REPO_URL } from '@/lib/site'

const DOC = findDoc('relay')!

export const Route = createFileRoute('/docs/relay')({
  head: () => ({
    meta: [{ title: docTitle(DOC) }, { name: 'description', content: DOC.blurb }],
  }),
  component: Relay,
})

const RELAY_DOC = `${REPO_URL}/blob/main/docs/RELAY.md`

const SEES = [
  { can: false, text: 'What is in any session. Keystrokes, output and scrollback are Noise ciphertext, and the relay holds no key for it.' },
  { can: false, text: "Your daemon's private key, or any device's." },
  { can: true, text: 'Who connected, when, and how much traffic moved each way. Enough to analyse a session, never to read one.' },
  { can: true, text: 'The pairing exchange. It crosses a cleartext control channel carrying a single-use token that lives two minutes.' },
  { can: true, text: "The fleet directory. It holds each machine's id, name and daemon public key, and the whole revocation history. Reading it needs no credential, so anyone who learns the relay's address can read it, not only the operator." },
]

function Relay() {
  return (
    <DocPage slug="relay" title={DOC.title} blurb={DOC.blurb}>
      <Section title="The daemon never listens on the network">
        <Lead>
          It listens on loopback and nothing else. Reaching a machine from somewhere else is one
          opt-in command, and what that command deploys belongs to you.
        </Lead>
        <P>
          There is no hosted service to sign in to and no port to forward. Both ends dial out to a
          small Worker running in your own Cloudflare account, and the Worker connects them.
        </P>
      </Section>

      <Section title="The protocol in one picture">
        <RelayProtocol />
        <P>
          The Worker sits inside the encrypted run rather than at the end of it. It moves opaque
          frames between two sockets. The Noise channel runs between your browser and your daemon,
          with the daemon&rsquo;s key pinned when the browser paired.
        </P>
      </Section>

      <Section title="Setting it up">
        <P>
          Run this once, on one machine. It checks the token, deploys the Worker and the web app,
          and joins this machine to it.
        </P>
        <Shell
          lines={[
            '$ flue relay setup',
            '  ✓ token verified',
            '  ✓ account: Personal (a1b2c3…)',
            '  ✓ worker deployed: flue-relay',
            '  ✓ web app uploaded (128 files)',
            '  ✓ reachable at https://flue-relay.you.workers.dev',
            '  ✓ secret set',
            '  ✓ fleet key minted (stays on your machines; Cloudflare never sees it)',
            '  ✓ this machine joined as laptop (laptop-9f3a-3f9a12cd)',
          ]}
        />
        <P>
          Every other machine runs the <Code>flue relay join</Code> line that setup prints. No
          token, nothing to deploy, and one relay fronts every machine you own. Each browser pairs
          once, from a QR code, and that pairing covers the whole fleet: the machine that runs it
          signs a certificate every other machine accepts, so a phone paired with your laptop can
          reach the Pi as well.
        </P>
        <P>
          The full order to do things in is in <Link href="/docs/setup">the setup guide</Link>.
        </P>
        <Note title="The API token stays on the machine that used it">
          <P>
            It goes into one file only you can read. It is kept so that updating the relay never
            asks for it again, and you can delete it whenever you want it forgotten.
          </P>
        </Note>
      </Section>

      <Section title="What it costs">
        <P>
          A Worker, one Durable Object per machine, and one more holding the fleet directory.
          Cloudflare&rsquo;s free plan is enough for personal use. The caps, the counters and how to
          read them are in <Link href={RELAY_DOC}>the operator runbook</Link>.
        </P>
      </Section>

      <Section title="What the relay can and cannot see">
        <ul role="list" className="flex flex-col">
          {SEES.map((item, i) => (
            <li
              key={item.text}
              className={
                i === 0
                  ? 'flex gap-3 py-3 first:pt-0'
                  : 'flex gap-3 border-t border-dashed border-border py-3 last:pb-0'
              }
            >
              <span
                aria-hidden="true"
                className={
                  item.can
                    ? 'mt-2 size-1.5 shrink-0 rounded-full bg-foreground'
                    : 'mt-2 size-1.5 shrink-0 rounded-full bg-foreground/25'
                }
              />
              <p className="text-base/7 text-pretty text-muted-foreground sm:text-sm/6">
                <span className="font-medium text-foreground">
                  {item.can ? 'Can see: ' : 'Cannot see: '}
                </span>
                {item.text}
              </p>
            </li>
          ))}
        </ul>
        <P>
          There is one more thing worth knowing, and it is not about the cryptography. The web app
          is served by the relay origin, so you are trusting that origin to serve the published
          code. <Link href="/docs/faq">The FAQ says exactly what that means</Link>, because it is
          the honest limit of every end-to-end encrypted web app.
        </P>
      </Section>

      <Section title="Prefer the direct path when you have one">
        <P>
          Pairing through a relay is a trust decision about that relay. Pair over the
          daemon&rsquo;s own address when the browser can already reach the machine, on the same
          network or over something like Tailscale. A phone that is not on the network has no such
          path, and there the relay is the only way to pair at all.
        </P>
      </Section>
    </DocPage>
  )
}
