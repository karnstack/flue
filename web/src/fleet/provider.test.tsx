import { StrictMode, useEffect } from 'react'
import { render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ConnStatus, FlueClient } from '@/client/client'
import { FlueClientProvider, useFlueClient } from '@/client/provider'
import { fakeClient } from '@/testing/socket'
import { FleetClient, type FleetSource } from './fleet'
import { FleetProvider, useFleet } from './provider'
import { LOCAL_MACHINE_ID, type MachineState } from './types'

/**
 * The least FlueClient a fleet source needs. Its one deliberate behaviour:
 * `connect` reports the connection open synchronously, which is the sharpest
 * available probe of ordering — a listener subscribed after connect() ran has
 * already missed the report and can never hear it.
 */
class StubRide {
  connects = 0
  closes = 0
  lists = 0
  private statusCbs: Array<(s: ConnStatus) => void> = []

  onStatus(cb: (s: ConnStatus) => void) {
    this.statusCbs.push(cb)
    return () => {
      const at = this.statusCbs.indexOf(cb)
      if (at >= 0) this.statusCbs.splice(at, 1)
    }
  }
  onSessions() {
    return () => {}
  }
  onWelcome() {
    return () => {}
  }
  onError() {
    return () => {}
  }
  onRevoked() {
    return () => {}
  }
  connect() {
    this.connects++
    for (const cb of [...this.statusCbs]) cb('open')
  }
  close() {
    this.closes++
  }
  list() {
    this.lists++
  }
}

function scriptedFleet() {
  const ride = new StubRide()
  const source: FleetSource = {
    id: LOCAL_MACHINE_ID,
    name: 'Mesa',
    client: ride as unknown as FlueClient,
  }
  return { fleet: new FleetClient([source]), ride }
}

/** Records the fleet each render sees, so two consumers can be compared. */
function Probe({ seen }: { seen: FleetClient[] }) {
  seen.push(useFleet())
  return null
}

/** Subscribes the way a route does: in a mount effect, and nowhere earlier. */
function Listener({ heard }: { heard: MachineState[][] }) {
  const fleet = useFleet()
  useEffect(
    () =>
      fleet.onFleet((_sessions, machines) => {
        heard.push(machines)
      }),
    [fleet, heard],
  )
  return null
}

/** Records what useFlueClient answers below the fleet provider. */
function RideProbe({ seen }: { seen: FlueClient[] }) {
  seen.push(useFlueClient())
  return null
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('FleetProvider', () => {
  it('hands every consumer the same fleet', () => {
    const { fleet } = scriptedFleet()
    const seen: FleetClient[] = []

    render(
      <FleetProvider fleet={fleet}>
        <Probe seen={seen} />
        <Probe seen={seen} />
      </FleetProvider>,
    )

    expect(seen).toHaveLength(2)
    expect(seen[0]).toBe(fleet)
    expect(seen[1]).toBe(fleet)
  })

  it('connects on mount and stops on unmount', () => {
    const { fleet, ride } = scriptedFleet()

    const view = render(
      <FleetProvider fleet={fleet}>
        <Probe seen={[]} />
      </FleetProvider>,
    )
    expect(ride.connects).toBe(1)
    expect(ride.closes).toBe(0)

    view.unmount()
    expect(ride.closes).toBe(1)
  })

  it('has every subscriber listening before it connects', () => {
    // onFleet replays nothing at subscribe time, so a provider that connected
    // before its children's effects ran would lose every report a source
    // makes during connect — silently, and only for synchronous reporters.
    // StubRide is exactly that reporter: hearing 'online' at all proves the
    // subscription was in place first.
    const { fleet, ride } = scriptedFleet()
    const heard: MachineState[][] = []

    render(
      <FleetProvider fleet={fleet}>
        <Listener heard={heard} />
      </FleetProvider>,
    )

    expect(ride.connects).toBe(1)
    expect(heard.length).toBeGreaterThan(0)
    expect(heard[0]).toEqual([{ id: LOCAL_MACHINE_ID, name: 'Mesa', status: 'online' }])
  })

  it('leaves exactly one live fleet under StrictMode', () => {
    // React double-invokes an effect on mount in development, so the fleet is
    // connected, closed, and connected again — one fleet, twice dialled, its
    // first epoch cleanly shut behind it.
    const { fleet, ride } = scriptedFleet()
    const seen: FleetClient[] = []

    render(
      <StrictMode>
        <FleetProvider fleet={fleet}>
          <Probe seen={seen} />
        </FleetProvider>
      </StrictMode>,
    )

    expect(ride.connects).toBe(2)
    expect(ride.closes).toBe(1)
    expect(new Set(seen).size).toBe(1)
  })

  it('builds its own fleet around a loopback client, and shares the ride', () => {
    const urls: string[] = []
    class FakeWebSocket {
      binaryType = ''
      onopen: unknown = null
      onclose: unknown = null
      onmessage: unknown = null
      constructor(url: string) {
        urls.push(url)
      }
      send() {}
      close() {}
    }
    vi.stubGlobal('WebSocket', FakeWebSocket)
    const fleets: FleetClient[] = []
    const rides: FlueClient[] = []

    render(
      <FleetProvider>
        <Probe seen={fleets} />
        <RideProbe seen={rides} />
      </FleetProvider>,
    )

    expect(fleets[0]).toBeInstanceOf(FleetClient)
    // jsdom serves the test document from http://localhost:3000.
    expect(urls).toEqual(['ws://localhost:3000/ws'])
    // useFlueClient below the provider answers the fleet's own local client,
    // which is what keeps every consumer of the one-client world working.
    expect(rides[0]).toBe(fleets[0]!.clientFor(LOCAL_MACHINE_ID))
  })

  it('builds that fleet once under StrictMode', () => {
    const instances: Array<{ closed: boolean }> = []
    class FakeWebSocket {
      binaryType = ''
      onopen: unknown = null
      onclose: unknown = null
      onmessage: unknown = null
      closed = false
      constructor() {
        instances.push(this)
      }
      send() {}
      close() {
        this.closed = true
      }
    }
    vi.stubGlobal('WebSocket', FakeWebSocket)
    const seen: FleetClient[] = []

    render(
      <StrictMode>
        <FleetProvider>
          <Probe seen={seen} />
        </FleetProvider>
      </StrictMode>,
    )

    // One fleet across both mounts; connect / close / connect on its one
    // local client leaves the first socket shut and the second live.
    expect(new Set(seen).size).toBe(1)
    expect(instances).toHaveLength(2)
    expect(instances[0]!.closed).toBe(true)
    expect(instances[1]!.closed).toBe(false)
  })

  it('adopts a client already in context as the local ride', () => {
    // A client above the fleet is the tab's ride — a test's scripted client,
    // exactly as router.test.tsx mounts one — so the fleet must fold it in
    // rather than dial a loopback client of its own beside it.
    const urls: string[] = []
    class FakeWebSocket {
      binaryType = ''
      onopen: unknown = null
      onclose: unknown = null
      onmessage: unknown = null
      constructor(url: string) {
        urls.push(url)
      }
      send() {}
      close() {}
    }
    vi.stubGlobal('WebSocket', FakeWebSocket)
    const { client, sockets } = fakeClient()
    const fleets: FleetClient[] = []
    const rides: FlueClient[] = []

    render(
      <FlueClientProvider client={client}>
        <FleetProvider>
          <Probe seen={fleets} />
          <RideProbe seen={rides} />
        </FleetProvider>
      </FlueClientProvider>,
    )

    expect(fleets[0]!.clientFor(LOCAL_MACHINE_ID)).toBe(client)
    expect(rides[0]).toBe(client)
    // One socket between the two providers, and nothing dialled beside it:
    // both of them connecting the same client is the idempotence FlueClient
    // already promises, not a second attachment.
    expect(sockets).toHaveLength(1)
    expect(urls).toEqual([])
  })

  it('passes through when nested inside another fleet provider', () => {
    const { fleet, ride } = scriptedFleet()
    const seen: FleetClient[] = []

    render(
      <FleetProvider fleet={fleet}>
        <FleetProvider>
          <Probe seen={seen} />
        </FleetProvider>
      </FleetProvider>,
    )

    expect(seen[0]).toBe(fleet)
    // The inner provider mounted no lifecycle of its own: one connect, from
    // the one provider that owns the fleet.
    expect(ride.connects).toBe(1)
  })
})

describe('useFleet', () => {
  it('refuses to run outside a provider', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => render(<Probe seen={[]} />)).toThrow(/FleetProvider/)
  })
})
