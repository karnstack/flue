/*
 * The machine picker: the relay door, when the answer to "which machine?" is
 * not already made.
 *
 * On a relay origin one address fronts every machine this browser has paired
 * with, so the entry point needs an answer before it can build a client — see
 * relayBoot in src/relay/boot.ts. When there is exactly one machine the boot
 * answers for itself; otherwise this screen is what every path but /pair
 * renders, and it is also registered at /machines so a connected tab can come
 * back and switch.
 *
 * Same frame as /pair and no chrome of any kind, for the same reason: a tab
 * with no machine chosen has nothing it could navigate to, and links to
 * sessions it cannot open would be chrome promising what it does not have.
 *
 * Choosing reloads rather than setting state. The client, its Noise transport
 * and the router context are all built once at the entry point from the
 * selection, so a picker that swapped state under them would leave the tab
 * holding a router whose context still says otherwise — the same judgement the
 * old unpaired explainer made, and it cannot loop for the same reason: the
 * reload re-runs the entry point, which reads the selection this click wrote.
 */
import { useState } from 'react'

import { Button } from '@/components/ui/button'
import { useRefetchOnFocus } from '@/hooks/use-refetch-on-focus'
import { cn } from '@/lib/utils'
import {
  forgetMachine,
  listMachines,
  SELECTED_KEY,
  type MachineRecord,
} from '@/relay/machines'

/*
 * The door pages' shared class string, spelled out rather than imported.
 * Every token has to stay hyphenated for styles.build.test.ts to find it
 * inside a `className`, which is also why it is not assembled from parts.
 */
const PROSE = 'text-base/7 text-pretty text-zinc-600 sm:text-sm/6 dark:text-zinc-400'

/**
 * By name, ties broken by id — the same ordering Devices gives its rows, for
 * the same reason: a list that reshuffles between renders moves the row under
 * the reader's pointer, and two machines named "dev-box" is the ordinary case.
 */
function ordered(machines: MachineRecord[]): MachineRecord[] {
  return [...machines].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
}

/** The frame both of this door's states share: centred, one paragraph wide. */
function Frame({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-sm flex-col justify-center gap-y-5 px-5 py-10 sm:max-w-md">
      <h1 className="text-2xl/8 font-semibold tracking-tight text-zinc-950 sm:text-xl/7 dark:text-white">
        {title}
      </h1>
      {children}
    </main>
  )
}

export function MachinesRoute() {
  const [machines, setMachines] = useState(() => ordered(listMachines()))
  /** What the last forget had to say for itself, when it could not finish. */
  const [failure, setFailure] = useState<string | null>(null)

  // localStorage is this screen's whole source, and another tab's pairing
  // writes it without telling this one; re-reading on focus is what keeps a
  // picker left open from hiding a machine paired a minute ago.
  useRefetchOnFocus(() => setMachines(ordered(listMachines())))

  function connect(id: string) {
    sessionStorage.setItem(SELECTED_KEY, id)
    // From the picker's own address the reload would land back on the picker,
    // now answered — so the tab leaves for home instead. From anywhere else
    // the address is kept: a bookmarked session URL that mounted this door
    // becomes that session the moment the boot has a machine to reach it on.
    if (location.pathname === '/machines') location.replace('/')
    else location.reload()
  }

  async function forget(id: string, name: string) {
    // Awaited, because forgetMachine deletes the key before it drops the
    // record: a row taken off the screen ahead of the answer would be this
    // page claiming a forget the key store then refused — a machine listed
    // nowhere that this browser can still handshake with.
    try {
      await forgetMachine(id)
    } catch {
      setFailure(
        `This browser would not let go of ${name}’s key, so it is still paired here — try again.`,
      )
      return
    }
    setFailure(null)
    setMachines(ordered(listMachines()))
    // Forgetting the machine this tab is riding takes the tab's client with
    // it, and the client was built at boot — so the selection is cleared and
    // the boot asks again, which is the picker.
    if (sessionStorage.getItem(SELECTED_KEY) === id) {
      sessionStorage.removeItem(SELECTED_KEY)
      location.reload()
    }
  }

  if (machines.length === 0) {
    /*
     * The old unpaired explainer, kept as this door's empty state: a browser
     * with no machines written down holds no key for anything, and the way out
     * is still a ceremony that starts on the machine itself. No link to /pair,
     * for the reason that page's own explainer gives — a pairing link is only
     * good with a live token in it.
     */
    return (
      <Frame title="No machines paired yet">
        <p className={PROSE}>
          This browser holds no key for any machine running flue, so there is nothing for it to
          connect to. Either it has never been paired, or the keys it kept were cleared along with
          the rest of this site’s data.
        </p>
        <p className={PROSE}>
          To let it in: open flue on the machine that runs your sessions, go to Devices, and tap
          Pair device. Scan the code it shows with this device, or open the link printed beside it.
        </p>
        <p className={PROSE}>
          The code works once and expires after two minutes, so start it with this device in your
          hand.
        </p>
      </Frame>
    )
  }

  return (
    <Frame title="Choose a machine">
      <p className={PROSE}>
        Every machine this browser is paired with. Connecting opens its sessions; forgetting one
        deletes this browser’s key for it, and pairing again is the only way back.
      </p>
      <ul className="flex flex-col">
        {machines.map((m) => (
          <li
            key={m.id}
            className="flex items-center justify-between gap-x-3 border-b border-zinc-950/5 py-3 first:border-t dark:border-white/5"
          >
            <div className="min-w-0">
              <p className="truncate text-base/6 font-medium text-zinc-950 sm:text-sm/6 dark:text-white">
                {m.name}
              </p>
              <p className="truncate font-mono text-xs/5 text-zinc-500 dark:text-zinc-400">
                {m.id}
              </p>
            </div>
            <span className="flex shrink-0 items-center gap-x-1.5">
              {/*
                Named after their own rows, as every control in a column is:
                a reader hearing "Connect" three times has nothing to tell
                them apart. Forget asks nothing first — what it deletes is
                this browser's key, and pairing again mints another — and
                stays quiet next to the row's one filled control, which takes
                its teal from --primary rather than naming a colour.
              */}
              <Button
                variant="ghost"
                size="sm"
                aria-label={`Forget ${m.name}`}
                className="text-zinc-500 dark:text-zinc-400"
                onClick={() => void forget(m.id, m.name)}
              >
                Forget
              </Button>
              <Button size="sm" aria-label={`Connect to ${m.name}`} onClick={() => connect(m.id)}>
                Connect
              </Button>
            </span>
          </li>
        ))}
      </ul>
      {/*
        Always on the page, never mounted with its text: several screen
        readers announce only changes to a live region that was already in the
        accessibility tree, so a region that appears alongside its first
        message is a message nobody hears — which is also why it is not
        dropped when empty. Empty, it contributes no line box of its own, but
        the frame still deals it a gap-y-5 slot — flex gap does not care that
        an item is empty — so `empty:-mt-5` hands that one slot back, and the
        region costs no space until it has something to say.
      */}
      <p role="status" className={cn(PROSE, 'empty:-mt-5')}>
        {failure}
      </p>
    </Frame>
  )
}
