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
  { cmd: 'flue status', what: 'Check the daemon, the login service and the sessions.' },
  { cmd: 'flue open [path]', what: 'Start a session here. Useful from a shell prompt.' },
  { cmd: 'flue serve', what: 'Run the daemon in the foreground, with no login service.' },
  { cmd: 'flue relay setup', what: 'Deploy a relay into your own Cloudflare account.' },
  { cmd: 'flue relay join', what: 'Point this machine at a relay another machine deployed.' },
]

function HowItWorks() {
  return (
    <DocPage slug="how-it-works" title={DOC.title} blurb={DOC.blurb}>
      <Section title="One daemon owns the shells">
        <Lead>
          A small Go daemon holds the terminals and their scrollback. Everything that draws them is
          a client, including the tab you are reading this in.
        </Lead>
        <P>
          The whole product rests on that one move. Normally a shell belongs to the window that
          opened it, so closing the window takes the work with it. Here the shell belongs to a
          process that outlives every window, and the window becomes a view instead of an owner.
        </P>
        <P>
          Closing the tab does not kill the session. It only detaches it. The build keeps running,
          the agent keeps working, the SSH session stays up. Reattach and the daemon replays the
          scrollback you missed.
        </P>
      </Section>

      <Section title="Every device is another view">
        <P>
          A client only draws, so there can be more than one. Attach from two devices and they
          mirror live: what you type on the phone appears in the laptop&rsquo;s browser.
        </P>
        <P>
          Size follows the view you are using. Pick up the phone and the session fits the phone.
          Type on the laptop and it fits the laptop again. Being held at another view&rsquo;s size
          is the failure that makes most screen sharing useless for real work.
        </P>
        <Note title="One list, every machine">
          <P>
            Join more than one machine to a relay and the sessions screen shows all of them
            together, grouped by machine, with the same search, tags and pins across the whole
            fleet. Finding out what is running stops meaning logging in to everywhere.
          </P>
        </Note>
      </Section>

      <Section title="One keystroke to any of them">
        <P>
          Press <Code>⌘K</Code> on a Mac, or <Code>Ctrl+Shift+K</Code> on any platform including
          macOS, from any screen that can see a daemon. Pinned sessions come first, with number keys
          on them, then the sessions this browser has opened before, then the rest.
        </P>
        <P>
          The highlighted row shows its own last fourteen lines beside the list, so you can see
          which one is the build instead of guessing from its name. <Code>Ctrl+Shift+1</Code> to{' '}
          <Code>9</Code> jumps straight to a pinned session, and <Code>Ctrl+Shift+]</Code> steps to
          the next one, both without opening the list.
        </P>
        <P>
          When a machine goes unreachable the fleet stops listing its sessions, on purpose: rows
          from a machine nobody can reach are a claim it cannot stand behind. The switcher still
          shows the ones this browser has opened before, greyed and marked unreachable, and it still
          opens them. That memory is per browser, so what your laptop remembers is not what your
          phone remembers.
        </P>
      </Section>

      <Section title="Installing it">
        <P>
          One static binary and no runtime. <Code>flue enable</Code> installs a login service so
          the daemon comes back after a reboot, starts it, and opens the UI.
        </P>
        <Shell
          lines={[
            '$ flue enable',
            '  ✓ login service installed',
            '  ✓ daemon running on 127.0.0.1:7717',
            '  opening http://127.0.0.1:7717',
          ]}
        />
        <P>
          The daemon listens on loopback and nothing else. Reaching it from another device is
          opt-in, and the order to do things in is in{' '}
          <Link href="/docs/setup">the setup guide</Link>.
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
          <Link href={REPO_URL}>one repository</Link>. The dev loop and the split between dev and
          prod are in{' '}
          <Link href={`${REPO_URL}/blob/main/docs/DEVELOPMENT.md`}>DEVELOPMENT.md</Link>. The rough
          edges we already know about are in{' '}
          <Link href={`${REPO_URL}/blob/main/docs/FOLLOW-UPS.md`}>FOLLOW-UPS.md</Link>.
        </P>
      </Section>
    </DocPage>
  )
}
