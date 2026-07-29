import { StrictMode } from 'react'
import { render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { FlueClient, type SocketLike } from './client'
import { FlueClientProvider, useFlueClient } from './provider'

class StubSocket implements SocketLike {
  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onmessage: ((data: string | ArrayBuffer) => void) | null = null
  shut = false

  send() {}
  close() {
    if (this.shut) return
    this.shut = true
    this.onclose?.()
  }
}

function stubbedClient() {
  const sockets: StubSocket[] = []
  const c = new FlueClient('ws://127.0.0.1:7717/ws', () => {
    const s = new StubSocket()
    sockets.push(s)
    return s
  })
  return { c, sockets }
}

/** Records the client each render sees, so two consumers can be compared. */
function Probe({ seen }: { seen: FlueClient[] }) {
  seen.push(useFlueClient())
  return null
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('FlueClientProvider', () => {
  it('hands every consumer the same client', () => {
    const { c } = stubbedClient()
    const seen: FlueClient[] = []

    render(
      <FlueClientProvider client={c}>
        <Probe seen={seen} />
        <Probe seen={seen} />
      </FlueClientProvider>,
    )

    expect(seen).toHaveLength(2)
    expect(seen[0]).toBe(c)
    expect(seen[1]).toBe(c)
  })

  it('connects on mount and stops on unmount', () => {
    const { c, sockets } = stubbedClient()

    const view = render(
      <FlueClientProvider client={c}>
        <Probe seen={[]} />
      </FlueClientProvider>,
    )
    expect(sockets).toHaveLength(1)
    expect(c.status).toBe('connecting')

    view.unmount()
    expect(c.status).toBe('closed')
    expect(sockets[0]!.shut).toBe(true)
    expect(sockets).toHaveLength(1)
  })

  it('leaves exactly one live socket under StrictMode', () => {
    // React double-invokes an effect on mount in development, so the client
    // is connected, closed, and connected again. The first socket must be
    // shut and no reconnect timer left running behind it.
    vi.useFakeTimers()
    const { c, sockets } = stubbedClient()

    render(
      <StrictMode>
        <FlueClientProvider client={c}>
          <Probe seen={[]} />
        </FlueClientProvider>
      </StrictMode>,
    )

    expect(sockets).toHaveLength(2)
    expect(sockets[0]!.shut).toBe(true)
    expect(sockets[1]!.shut).toBe(false)
    expect(c.status).toBe('connecting')

    vi.advanceTimersByTime(120_000)
    expect(sockets).toHaveLength(2)
    vi.useRealTimers()
  })

  it('builds its own client, aimed at the origin serving the page', () => {
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
    const seen: FlueClient[] = []

    render(
      <FlueClientProvider>
        <Probe seen={seen} />
      </FlueClientProvider>,
    )

    expect(seen[0]).toBeInstanceOf(FlueClient)
    // jsdom serves the test document from http://localhost:3000.
    expect(urls).toEqual(['ws://localhost:3000/ws'])
  })
})

describe('useFlueClient', () => {
  it('refuses to run outside a provider', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => render(<Probe seen={[]} />)).toThrow(/FlueClientProvider/)
  })
})
