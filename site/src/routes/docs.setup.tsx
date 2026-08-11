import { createFileRoute } from '@tanstack/react-router'

import { Code, DocPage, Lead, Link, Note, P, Section, Shell, Step, Steps } from '@/components/doc-page'
import { docTitle, findDoc } from '@/lib/docs'

const DOC = findDoc('setup')!

export const Route = createFileRoute('/docs/setup')({
  head: () => ({
    meta: [{ title: docTitle(DOC) }, { name: 'description', content: DOC.blurb }],
  }),
  component: Setup,
})

function Setup() {
  return (
    <DocPage slug="setup" title={DOC.title} blurb={DOC.blurb}>
      <Section title="The shape to aim for">
        <Lead>
          One relay. Every machine joined to it. Every device paired once. Everything below is a
          way of reaching that.
        </Lead>
        <P>
          A fleet is the machines you own, seen as one list. The relay is what lets them find each
          other when they are not on the same network, and you deploy exactly one of them, into
          your own Cloudflare account. If you only ever use flue on the machine in front of you,
          you need step one and nothing else.
        </P>
      </Section>

      <Section title="The steps">
        <Steps>
          <Step n={1} title="Install flue on every machine that runs work">
            <P>
              A laptop, a desktop, a Pi, a VPS. Any machine that should own sessions gets flue.
            </P>
            <Shell
              lines={[
                '$ brew install karnstack/tap/flue',
                '  # or: curl -fsSL https://flue.sh/install.sh | sh',
                '$ flue enable',
              ]}
            />
            <P>
              <Code>flue enable</Code> installs a login service so the daemon comes back after a
              reboot, starts it, and opens the UI. On Linux it also runs{' '}
              <Code>loginctl enable-linger</Code>, so your sessions survive your last logout. If
              lingering cannot be turned on, which happens in some containers, flue warns you and
              names the command to run.
            </P>
          </Step>

          <Step n={2} title="Deploy one relay, on one machine">
            <P>
              Run this once, on whichever machine is convenient. It needs a Cloudflare API token.
              It deploys the Worker and the web app, mints the fleet key, and joins this machine.
            </P>
            <Shell
              lines={[
                '$ flue relay setup',
                '  token verified',
                '  worker deployed: flue-relay',
                '  web app uploaded',
                '  reachable at https://flue-relay.you.workers.dev',
                '  fleet key minted (Cloudflare never sees it)',
                '  this machine joined as laptop (laptop-9f3a)',
              ]}
            />
            <Note title="Run flue relay setup once, and only once">
              <P>
                Running it again on the same Cloudflare account does not give you a second relay.
                It replaces the one you have. Setup is the recovery path for a leaked secret, so
                every run mints a fresh secret, a fresh fleet key and a fresh machine id.
              </P>
              <P>
                That resets the fleet. Every other machine is left holding a secret the relay no
                longer accepts, and every device has to pair again, because the new fleet key
                retires every device certificate the old one signed.
              </P>
              <P>
                So the way back is forwards. Take the join line the most recent setup printed, run
                it on every other machine, and pair your devices again. The line from the first
                setup does not work any more.
              </P>
              <P>
                Running setup against a <em>different</em> Cloudflare account is the other case.
                That does leave the first Worker deployed and reachable, and no command removes
                it, so delete it in the Cloudflare dashboard yourself.
              </P>
            </Note>
          </Step>

          <Step n={3} title="Join every other machine">
            <P>
              Setup prints a join line. Run it once on each remaining machine. There is no token
              to paste and nothing to deploy a second time.
            </P>
            <Shell
              lines={[
                '$ flue relay join wss://flue-relay.you.workers.dev \\',
                '    --secret <secret> --fleet <fleet key>',
              ]}
            />
            <P>
              Guard that line the way you would guard a root password. It carries the fleet key,
              so whoever holds it holds the fleet.
            </P>
          </Step>

          <Step n={4} title="Pair each device once">
            <P>
              Open flue on the phone, the tablet or the second laptop, and scan the QR code the
              machine shows.
            </P>
            <Note title="Pairing works per fleet, not per machine">
              <P>
                The machine that runs the pairing signs a device certificate that every machine in
                the fleet accepts. A phone paired with your laptop can reach the Pi and the VPS
                with no second pairing.
              </P>
              <P>
                It does work per browser. Safari and Chrome on the same iPad each pair on their
                own, because each one holds its own keys.
              </P>
            </Note>
            <P>
              Pair over the daemon&rsquo;s own address when the browser can already reach the
              machine, on the same network or over something like Tailscale. Pairing through a
              relay is a trust decision about that relay, and{' '}
              <Link href="/docs/faq">the FAQ says exactly what it costs</Link>. A phone that is not
              on the network has no direct path, and there the relay is the only way to pair at
              all.
            </P>
          </Step>

          <Step n={5} title="Add it to the home screen, on iPhone and iPad">
            <P>
              Share, then Add to Home Screen. It runs fullscreen after that, and the key bar stops
              fighting Safari&rsquo;s toolbar.
            </P>
            <P>
              This is a comfort step and nothing more. Installing does not pin the code the origin
              serves: an ordinary load still asks the origin for the page and then fetches whatever
              bundle that page names. <Link href="/docs/faq">The FAQ</Link> is blunt about why that
              matters.
            </P>
          </Step>
        </Steps>
      </Section>

      <Section title="Which machine should run what">
        <Lead>
          Put long jobs on a machine that stays on. Keep the laptop for the work you are watching.
        </Lead>
        <P>
          A laptop sleeps. The sessions on a sleeping machine are not lost, but they are out of
          reach until it wakes. The switcher still lists them, greyed and marked unreachable, and
          it still opens them, so nothing disappears. It is just that nothing runs either.
        </P>
        <P>
          So a desktop, a Pi or a VPS is where agent runs and long builds want to live. That is
          also the honest version of what flue does for you: the work stays on the machine that
          owns it, and you stop having to be in the same room as it.
        </P>
      </Section>

      <Section title="If something is wrong">
        <P>
          <Code>flue status</Code> is the first thing to run. It reports the daemon, the login
          service and the sessions it can see.
        </P>
        <P>
          A machine missing from the list is usually one of three things. It is asleep or
          offline. It never ran <Code>flue relay join</Code>. Or somebody ran{' '}
          <Code>flue relay setup</Code> a second time, which reset the relay and left this
          machine holding a secret the relay no longer accepts.
        </P>
        <P>
          Run <Code>flue relay status</Code> on the machine that is missing, and read the fleet
          line rather than the address. A reset does not change the address, so an address that
          matches tells you nothing.
        </P>
        <Shell
          lines={[
            '$ flue relay status',
            'relay:    configured (wss://flue-relay.you.workers.dev), status unknown from here',
            "fleet:    unreachable (the relay refused this machine's credential; the",
            '          secret in relay.json is not the one this Worker holds)',
          ]}
        />
        <P>
          That is the reset. The fix is the join line the most recent setup printed, run on this
          machine. A fleet line that says entries are signed by something else means the same
          problem seen from the other end: the relay now belongs to a fleet whose key this
          machine does not hold. A fleet line that says this machine is not in the directory
          means your other devices cannot discover it yet.
        </P>
        <P>
          Sessions that vanish after you log out of a Linux box mean lingering is off. Run{' '}
          <Code>loginctl enable-linger</Code> as that user.
        </P>
      </Section>
    </DocPage>
  )
}
