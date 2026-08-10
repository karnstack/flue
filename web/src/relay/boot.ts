/*
 * The relay boot seam: which machine this tab rides, turned into either a
 * client or the picker, before the router exists.
 *
 * On a relay origin there is no /ws — there is a Worker at /client/<machine>
 * that forwards bytes it must not be able to read, and one origin fronts every
 * machine this browser has paired with. So the boot needs an answer to "which
 * machine?" before it can build anything: the tab's own selection when it has
 * one, the only machine there is when there is only one (bootMachine owns that
 * judgement), and otherwise the machine picker — which is also where a machine
 * whose pinned key has gone missing lands, because a record this browser
 * cannot handshake for is a row to pick again, not a client to build.
 *
 * The chosen machine's client rides a Noise channel keyed to the static key
 * pinned under that machine's id at pairing time; see ./socket, which
 * FlueClient cannot tell apart from a WebSocket. A key store that will not
 * open at all lands on the picker too: a rejected promise here reaches the
 * entry point, which would mount no app and tell the user even less than the
 * picker does.
 *
 * A module of its own rather than a closure in main.tsx, because main.tsx is
 * the one file that runs at import — nothing can mount it under a test — and
 * this decision is exactly the kind that has to be falsifiable: a boot that
 * dialled the wrong machine's slot, or sealed to the wrong machine's key,
 * would look identical from the outside until the handshake failed forever.
 */
import { FlueClient } from '@/client/client'
import { loadOrCreateDeviceKey, loadPinnedDaemonKeyFor } from '@/crypto/keys'
import { bootMachine } from './machines'
import { relaySocket, type RawSocket } from './socket'

/**
 * What the boot decided: a client for the chosen machine, or the picker.
 *
 * `pinned` says how that client knows its daemon, and it is always true here
 * because this function has exactly one way of building one — the key pinned
 * under the machine's id at a ceremony this browser performed. It is stated
 * rather than assumed downstream because it is a security condition, not a
 * detail: `adoptFleetKey` takes a fleet key off a welcome only from a session
 * keyed that way. Anything that later teaches this function a second way to
 * reach a machine — a machine certificate, say — has to say so here, and the
 * type is what makes that unmissable.
 */
export type RelayBoot = { client: FlueClient; pinned: true } | { picker: true }

/**
 * Decide what a relay-served tab mounts.
 *
 * `origin` is the relay's own — the entry point passes `location.origin`,
 * because the page and the relay it talks to are the same deployment by
 * construction. `wsFactory` is a test seam and nothing more: production passes
 * nothing, and the socket makes real WebSockets.
 */
export async function relayBoot(
  origin: string,
  wsFactory?: (url: string) => RawSocket,
): Promise<RelayBoot> {
  try {
    const machine = bootMachine()
    if (machine === null) return { picker: true }
    const daemonPub = await loadPinnedDaemonKeyFor(machine.id)
    if (daemonPub === null) return { picker: true }
    const identity = { deviceKey: await loadOrCreateDeviceKey(), daemonPub }
    return {
      client: new FlueClient(origin, (o) => relaySocket(o, identity, machine.id, wsFactory)),
      pinned: true,
    }
  } catch {
    return { picker: true }
  }
}
