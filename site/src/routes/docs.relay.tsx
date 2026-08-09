import { createFileRoute } from '@tanstack/react-router'

import { Code, DocPage, Lead, Link, Note, P, Section, Shell } from '@/components/doc-page'
import { RelayProtocol } from '@/components/mock/diagrams'
import { findDoc } from '@/lib/docs'
import { REPO_URL } from '@/lib/site'

const DOC = findDoc('relay')!

export const Route = createFileRoute('/docs/relay')({
  head: () => ({
    meta: [{ title: `${DOC.title} — flue` }, { name: 'description', content: DOC.blurb }],
  }),
  component: Relay,
})

const RELAY_DOC = `${REPO_URL}/blob/main/docs/RELAY.md`

const SEES = [
  { can: false, text: 'The contents of any session. Keystrokes, output and scrollback are Noise ciphertext it holds no key for.' },
  { can: false, text: "Your daemon's private key, or any device's." },
  { can: true, text: 'Who connected, when, and how much traffic moved each way. Enough for traffic analysis, never content.' },
  { can: true, text: 'The pairing exchange, which crosses a cleartext control channel carrying a single-use token that lives two minutes.' },
]

function Relay() {
  return (
    <DocPage slug="relay" title={DOC.title} blurb={DOC.blurb}>
      <Section title="The daemon never listens on the network">
        <Lead>
          It binds loopback and nothing else. Reaching a machine from elsewhere is one opt-in
          command, and what that command deploys belongs to you.
        </Lead>
        <P>
          There is no hosted service to sign into and no port to forward. Instead, both ends dial
          out to a small Worker running in your own Cloudflare account, and the Worker bridges
          them.
        </P>
      </Section>

      <Section title="The protocol in one picture">
        <RelayProtocol />
        <P>
          The Worker is inside the encrypted run rather than at the end of it. It moves opaque
          frames between two sockets; the Noise channel is between your browser and your daemon,
          with the daemon's key pinned when the browser paired.
        </P>
      </Section>

      <Section title="Setting it up">
        <P>
          Run this once, on one machine. It verifies the token, deploys the Worker and the web app,
          and joins this machine to it.
        </P>
        <Shell
          lines={[
            '$ flue relay setup',
            '',
            '  token verified',
            '  worker deployed: flue-relay',
            '  web app uploaded',
            '  reachable at https://flue-relay.you.workers.dev',
            '  this machine joined as laptop (laptop-9f3a)',
          ]}
        />
        <P>
          Every other machine runs the <Code>flue relay join</Code> line that setup prints. No
          token, nothing to deploy, and one relay fronts every machine you own. Each browser pairs
          once, from the QR code the machine shows.
        </P>
        <Note title="The API token stays on the machine that used it">
          <P>
            It is written to one file only you can read, kept so that updating the relay never asks
            for it again, and deleted whenever you want it forgotten.
          </P>
        </Note>
      </Section>

      <Section title="What it costs">
        <P>
          A Worker and one Durable Object per machine. Cloudflare's free plan is enough for
          personal use. The caps, the counters and how to read them are in{' '}
          <Link href={RELAY_DOC}>the operator runbook</Link>.
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
          There is one more thing worth knowing, and it is not about the cryptography: the web app
          is served by the relay origin, so you are trusting that origin to serve the published
          code. <Link href="/docs/faq">The FAQ says exactly what that means</Link>, because it is
          the honest limit of every end-to-end encrypted web app.
        </P>
      </Section>

      <Section title="Prefer the direct path when you have one">
        <P>
          Pairing through a relay is a trust decision about that relay. Pair over the daemon's own
          origin when the browser can already reach the machine directly, on the same LAN or across
          a private network like Tailscale. A phone that is off the network has no such path, and
          there the relay is the only way to pair at all.
        </P>
      </Section>
    </DocPage>
  )
}
