import { createFileRoute } from '@tanstack/react-router'

import { Code, DocPage, Lead, Link, Note, P, Section, Shell } from '@/components/doc-page'
import { docTitle, findDoc } from '@/lib/docs'
import { REPO_URL } from '@/lib/site'

const DOC = findDoc('how-it-works')!

export const Route = createFileRoute('/docs/how-it-works')({
  head: () => ({
    meta: [{ title: docTitle(DOC) }, { name: 'description', content: DOC.blurb }],
  }),
  component: HowItWorks,
})

const COMMANDS: { cmd: string; what: string }[] = [
  { cmd: 'flue enable', what: 'Install the login service, start the daemon, open the UI.' },
  { cmd: 'flue disable', what: 'Remove it.' },
  { cmd: 'flue status', what: 'Daemon, login service and session diagnostics.' },
  { cmd: 'flue open [path]', what: 'Spawn a session here. Handy from a shell prompt.' },
  { cmd: 'flue serve', what: 'Run the daemon in the foreground, with no login service.' },
  { cmd: 'flue relay setup', what: 'Deploy a relay into your own Cloudflare account.' },
  { cmd: 'flue relay join', what: 'Point this machine at a relay another machine deployed.' },
]

function HowItWorks() {
  return (
    <DocPage slug="how-it-works" title={DOC.title} blurb={DOC.blurb}>
      <Section title="One daemon owns the shells">
        <Lead>
          A small Go daemon holds the terminals and their scrollback. Everything that renders them
          is a client, including the tab you are looking at.
        </Lead>
        <P>
          That single move is what the whole product rests on. A shell normally belongs to the
          window that opened it, so the window closing takes the work with it. Here the shell
          belongs to a process that outlives every window, and the window becomes a view rather
          than an owner.
        </P>
        <P>
          Closing the tab detaches. The build keeps running, the agent keeps working, the SSH
          session stays up. Reattach and the daemon replays the scrollback you missed.
        </P>
      </Section>

      <Section title="Every device is just another view">
        <P>
          Because a client only renders, there can be more than one. Attach from two devices and
          they mirror live: typing on the phone shows up in the laptop's browser within a frame.
        </P>
        <P>
          Size is negotiated rather than shared. The phone's 40 columns do not reflow the laptop,
          which is the failure that makes most screen sharing useless for real work.
        </P>
        <Note title="One list, every machine">
          <P>
            Pair more than one machine and the sessions screen shows all of them together, grouped
            by machine, with the same search, tags and pins across the whole fleet. Knowing what is
            running anywhere stops meaning logging into everywhere.
          </P>
        </Note>
      </Section>

      <Section title="Installing it">
        <P>
          One static binary, no runtime. <Code>flue enable</Code> installs a login service so the
          daemon comes back after a reboot, starts it, and opens the UI.
        </P>
        <Shell
          lines={[
            '$ flue enable',
            '',
            '  login service installed',
            '  daemon running on 127.0.0.1:7717',
            '  opening http://127.0.0.1:7717',
          ]}
        />
        <P>
          The daemon binds loopback and nothing else. Reaching it from another device is opt-in and
          is covered in <Link href="/docs/relay">remote access</Link>.
        </P>
      </Section>

      <Section title="The CLI stays small">
        <P>
          Everything after <Code>flue enable</Code> happens in the browser. The commands exist for
          the things a browser cannot do.
        </P>
        <dl className="mt-2 flex flex-col">
          {COMMANDS.map((item, i) => (
            <div
              key={item.cmd}
              className={
                i === 0
                  ? 'flex flex-col gap-1 py-3 first:pt-0 sm:flex-row sm:gap-6'
                  : 'flex flex-col gap-1 border-t border-dashed border-border py-3 last:pb-0 sm:flex-row sm:gap-6'
              }
            >
              <dt className="w-56 shrink-0 font-mono text-sm text-foreground">{item.cmd}</dt>
              <dd className="text-base/7 text-pretty text-muted-foreground sm:text-sm/6">
                {item.what}
              </dd>
            </div>
          ))}
        </dl>
      </Section>

      <Section title="Where the code is">
        <P>
          The daemon, the web app and the relay Worker are all MIT licensed in{' '}
          <Link href={REPO_URL}>one repository</Link>. The dev loop and the dev/prod split are in{' '}
          <Link href={`${REPO_URL}/blob/main/docs/DEVELOPMENT.md`}>DEVELOPMENT.md</Link>, and the
          rough edges we already know about are in{' '}
          <Link href={`${REPO_URL}/blob/main/docs/FOLLOW-UPS.md`}>FOLLOW-UPS.md</Link>.
        </P>
      </Section>
    </DocPage>
  )
}
