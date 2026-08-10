import { createContext, useContext, useEffect, useRef, type ReactNode } from 'react'

import { daemonSocketUrl, FlueClient } from '@/client/client'
import { FlueClientContext } from '@/client/provider'
import { enrolThisBrowser, readDirectoryViaDaemon } from './enrol'
import { FleetClient } from './fleet'
import { LOCAL_MACHINE_ID } from './types'

const FleetContext = createContext<FleetClient | null>(null)

export interface FleetProviderProps {
  children: ReactNode
  /**
   * A fleet to use instead of building one. The seam tests reach for; nothing
   * in the app passes it, because there is meant to be exactly one fleet and
   * this is where it lives.
   */
  fleet?: FleetClient
  /**
   * The tab's pre-built client, when the entry point made one before the
   * router existed — a relay tab's, riding a Noise channel keyed to the
   * machine this browser chose. It becomes the fleet's local source: `local`
   * has always meant "the machine this tab rides", not literally loopback.
   */
  client?: FlueClient
  /**
   * Whether that client's channel is keyed to a daemon static key this browser
   * pinned at a ceremony. See FleetSource.pinned, which is where it lands and
   * what it decides: a fleet key may be adopted off a welcome from such a
   * machine and no other.
   */
  pinned?: boolean
  /**
   * Whether this page was served by the daemon on its own loopback origin.
   *
   * It unlocks the two things only such a tab can do, and only such a tab needs
   * (fleet/enrol.ts): asking this machine to enrol it as a device of the fleet,
   * and reading the fleet directory through the daemon rather than making a
   * cross-origin fetch the relay answers without a CORS header.
   *
   * Passed in from src/main.tsx through the router's context rather than worked
   * out here, because it is the same one fact `client` and `pinned` describe —
   * how this page was served — and the entry point is where that is known. It
   * is deliberately not `client === undefined`: a test putting a scripted
   * client in context is not a loopback tab, and would post a device key at
   * whatever answered.
   */
  loopback?: boolean
}

/**
 * One fleet per browser tab, mounted at the root of the routes that speak to
 * daemons, so every machine's connection has a single owner.
 *
 * Per-component fleets would multiply what FlueClientProvider's comment warns
 * about by the number of machines: each mount would dial every one of them
 * again, and every daemon would count another attachment.
 *
 * Nested inside another provider it is a pass-through, for the reason that
 * component spells out: the fleet already in context is the tab's fleet, and
 * building a second one here would be the very thing this exists to prevent.
 * That is what lets a test put a scripted fleet above the router and still
 * exercise the real tree.
 */
export function FleetProvider({ children, fleet, client, pinned, loopback }: FleetProviderProps) {
  const inherited = useContext(FleetContext)
  if (fleet === undefined && inherited !== null) return <>{children}</>
  return (
    <OwnFleetProvider fleet={fleet} client={client} pinned={pinned} loopback={loopback}>
      {children}
    </OwnFleetProvider>
  )
}

/**
 * The half that owns a fleet: builds one if it was not given one, connects it
 * on mount, and closes it on unmount — the same split, for the same reason,
 * as OwnClientProvider in client/provider.tsx.
 *
 * The build is synchronous on purpose. A tab starts from one source — the
 * machine it rides — and the fleet grows the rest for itself: the daemon's
 * welcome names the relay origin, and FleetClient.localWelcome builds a
 * source per pinned machine from there (see `expand` in fleet.ts). So there
 * is no async gap in which children would have to render fleetless, and no
 * "not ready yet" state for every consumer to answer for.
 *
 * The local ride is taken in order of who knows best: the client the entry
 * point built (a relay tab's, already keyed to its machine), else a client
 * already in context (a test's scripted one), else a fresh loopback client —
 * built here and not before, so an injected fleet never derives a socket URL
 * at all.
 *
 * It also answers `useFlueClient` for everything below: the fleet's local
 * client goes into the same context that hook has always read, which is how
 * the terminal, Devices and Remote keep working unchanged while the fleet is
 * the one owner of that client's lifecycle. Connecting a ride that something
 * above also connects is safe by FlueClient's own promise: a client that
 * already holds a socket keeps that one and opens no second, a client waiting
 * out a backoff dials early rather than twice, and both closes close once.
 */
function OwnFleetProvider({ children, fleet, client, pinned, loopback }: FleetProviderProps) {
  const legacy = useContext(FlueClientContext)
  const own = useRef<FleetClient | null>(null)
  let active = fleet
  if (!active) {
    own.current ??= new FleetClient(
      [
        {
          id: LOCAL_MACHINE_ID,
          name: '',
          client: client ?? legacy ?? new FlueClient(daemonSocketUrl()),
          // Only ever true of the ride the entry point built, and only when it
          // said so. The other two rides are a loopback socket and whatever a
          // test put in context; neither is keyed to a pinned daemon key, and a
          // flag that travelled without its client would be a claim about the
          // wrong one. See FleetSource.pinned.
          pinned: client !== undefined && pinned === true,
        },
      ],
      // The production expansion, which the fleet builds for itself so it can
      // hear what that build could not reach.
      undefined,
      // And the two seams a loopback tab needs it to use, from the one place
      // that knows this page came off the daemon's own origin.
      loopback === true
        ? { enrol: enrolThisBrowser, directoryFetch: readDirectoryViaDaemon }
        : {},
    )
    active = own.current
  }

  useEffect(() => {
    // Child effects have already run when this fires — React runs effects
    // bottom-up — so every route that subscribed onFleet in its mount effect
    // is listening before the first source dials. onFleet replays nothing at
    // subscribe time; this ordering is what makes that safe to rely on.
    active.connect()
    // React double-invokes this in development, so the pair has to survive
    // connect / close / connect on one fleet. FleetClient is built for it:
    // close stops the poll, closes every source and bumps the epoch, and the
    // next connect wires and dials them all again.
    return () => active.close()
  }, [active])

  const ride = active.clientFor(LOCAL_MACHINE_ID)
  return (
    <FleetContext.Provider value={active}>
      {ride ? (
        <FlueClientContext.Provider value={ride}>{children}</FlueClientContext.Provider>
      ) : (
        children
      )}
    </FleetContext.Provider>
  )
}

/** The tab's fleet. Throws outside the provider rather than returning null. */
export function useFleet(): FleetClient {
  const fleet = useContext(FleetContext)
  if (!fleet) throw new Error('flue: useFleet must be used inside FleetProvider')
  return fleet
}
