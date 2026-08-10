/*
 * Enough of a browser for the app's own modules to run unmodified in Node.
 *
 * The point of this file is that the harness asserts against **the code the
 * browser ships**, not a re-implementation of it. `enrolThisBrowser`,
 * `readDirectoryViaDaemon`, `readDirectory`, `fleetSources`, `FleetClient`,
 * `relaySocket`, the Noise implementation and the certificate verifier are all
 * imported from web/src and called as the app calls them. What they need from
 * a browser is small and entirely mechanical: an origin, two web storages, a
 * key store, a fetch and a WebSocket. Those are here.
 *
 * # A tab is a storage partition
 *
 * `openTab` installs a fresh set of globals and hands back a `close()` that
 * takes them off again. Two tabs on two origins get two IndexedDB instances
 * and two localStorages, which is exactly the property the fleet design turns
 * on: a browser paired on the relay's origin and a tab on the daemon's own
 * loopback origin are different browsers as far as every stored key is
 * concerned (spec/fleet-trust.md, "The third delivery"). One tab is open at a
 * time, so the globals are never ambiguous.
 *
 * # What it is not
 *
 * It is not a browser, and the two places that matters are stated here rather
 * than discovered later:
 *
 *   - **No CORS.** `request()` will happily read a cross-origin response that
 *     a real tab would discard for want of `Access-Control-Allow-Origin`. That
 *     is the exact hole the `GET /directory` bug lived in, so the harness
 *     asserts the *header* a browser would decide on rather than pretending to
 *     be the browser deciding.
 *   - **No CSP.** Nothing here enforces `connect-src`. Same treatment: the
 *     policy the daemon serves is asserted as a header.
 *
 * Everything else — the Noise handshake, the wire protocol, the certificate
 * checks, the fleet's expansion and its discovery poll — is the real thing
 * running against real daemons, and needs no browser to be real.
 */
import { IDBFactory } from 'fake-indexeddb'
import { WebSocket as NodeWebSocket } from 'ws'

import { request, type Answer } from './http'

/** A minimal `Storage`, per tab. The app reads and writes strings and treats
 *  anything it cannot parse as an empty store, so this is the whole surface. */
class MemoryStorage {
  private items = new Map<string, string>()
  get length(): number {
    return this.items.size
  }
  key(i: number): string | null {
    return [...this.items.keys()][i] ?? null
  }
  getItem(k: string): string | null {
    return this.items.get(k) ?? null
  }
  setItem(k: string, v: string): void {
    this.items.set(k, String(v))
  }
  removeItem(k: string): void {
    this.items.delete(k)
  }
  clear(): void {
    this.items.clear()
  }
}

export interface TabOptions {
  /** The origin this tab was served from: a daemon's loopback address, or the
   *  relay's. It decides `location`, and which credential requests carry. */
  origin: string
  /** The daemon session token, for a tab on a daemon's own origin. A real tab
   *  presents the `flue_token_<port>` cookie the first load exchanged its
   *  handoff for; this presents the `X-Flue-Token` header, which
   *  internal/transport/local treats as the same credential from a caller that
   *  can read the token file. */
  token?: string
  /** The PEM to trust, for a tab whose origin is the harness's own relay. */
  ca?: string
}

export interface Tab {
  origin: string
  /** Fire the `focus` event the fleet listens for; see FleetClient.connect.
   *  This is how "a machine that joined after the tab opened shows up without
   *  a reload" is driven, rather than by waiting out the 60 s interval. */
  focus(): void
  close(): void
}

type Listener = () => void

/**
 * The stores that belong to an origin rather than to a tab.
 *
 * IndexedDB and localStorage outlive the tab that wrote them and are shared by
 * every tab on the same origin; sessionStorage does not, and is built fresh in
 * `openTab` below. Keeping that distinction is not pedantry here — it is the
 * property the whole fleet design rests on. A browser that pairs on the relay's
 * origin keeps its device key, its certificate and its pinned fleet key there,
 * and comes back to them on the next visit, while a tab on the daemon's own
 * loopback address is a different origin and shares none of it
 * (spec/fleet-trust.md, "The third delivery").
 */
const origins = new Map<string, { indexedDB: IDBFactory; localStorage: MemoryStorage }>()

function storesFor(origin: string): { indexedDB: IDBFactory; localStorage: MemoryStorage } {
  let held = origins.get(origin)
  if (held === undefined) {
    held = { indexedDB: new IDBFactory(), localStorage: new MemoryStorage() }
    origins.set(origin, held)
  }
  return held
}

const GLOBALS = [
  'location',
  'window',
  'localStorage',
  'sessionStorage',
  'indexedDB',
  'WebSocket',
  'fetch',
] as const

/**
 * Open a tab: install this origin's globals, and hand back the handle that
 * takes them away again. Every global is restored on close, including the
 * ones that were undefined to begin with, so a run leaves the process as it
 * found it and two tabs cannot see each other's storage.
 */
export function openTab(opts: TabOptions): Tab {
  const saved = new Map<string, unknown>()
  const g = globalThis as unknown as Record<string, unknown>
  for (const name of GLOBALS) saved.set(name, g[name])

  const url = new URL(opts.origin)
  const focusListeners: Listener[] = []

  g['location'] = {
    href: url.href,
    origin: url.origin,
    protocol: url.protocol,
    host: url.host,
    hostname: url.hostname,
    port: url.port,
    pathname: '/',
    search: '',
  }
  g['window'] = {
    addEventListener: (type: string, cb: Listener) => {
      if (type === 'focus') focusListeners.push(cb)
    },
    removeEventListener: (type: string, cb: Listener) => {
      if (type !== 'focus') return
      const at = focusListeners.indexOf(cb)
      if (at >= 0) focusListeners.splice(at, 1)
    },
  }
  const stores = storesFor(url.origin)
  g['localStorage'] = stores.localStorage
  g['sessionStorage'] = new MemoryStorage()
  g['indexedDB'] = stores.indexedDB
  g['WebSocket'] = socketClass(opts)
  g['fetch'] = tabFetch(opts)

  return {
    origin: opts.origin,
    focus: () => {
      for (const cb of [...focusListeners]) cb()
    },
    close: () => {
      for (const [name, value] of saved) {
        if (value === undefined) delete g[name]
        else g[name] = value
      }
    },
  }
}

/**
 * The `fetch` this tab's modules find on `globalThis`.
 *
 * `enrolThisBrowser` and `readDirectoryViaDaemon` call it with a *relative*
 * path — `/api/fleet/enrol`, `/api/fleet/directory` — which is meaningless to
 * Node, so resolving those against the tab's origin is the whole of the shim's
 * first job. Its second is the credential: those two routes are behind the
 * session token, which a real tab carries as the `flue_token_<port>` cookie
 * this origin holds. Its third is the harness CA, on a tab whose origin is the
 * local relay.
 *
 * Attaching the token to same-origin requests only is not a nicety: a shim
 * that sent a daemon's credential to whatever host a URL named would be a
 * worse browser than the one it stands in for, and the relay is a different
 * origin by construction.
 */
function tabFetch(opts: TabOptions) {
  const own = new URL(opts.origin)
  return (input: string, init: { method?: string; body?: string } = {}): Promise<Answer> => {
    const url = new URL(input, opts.origin)
    const headers: Record<string, string> = {}
    if (opts.token !== undefined && url.host === own.host) headers['X-Flue-Token'] = opts.token
    if (init.body !== undefined) headers['Content-Type'] = 'application/json'
    return request(url.toString(), {
      method: init.method ?? 'GET',
      headers,
      ...(init.body !== undefined && { body: init.body }),
      ...(opts.ca !== undefined && { ca: opts.ca }),
    })
  }
}

/**
 * The `WebSocket` the app's modules find on `globalThis`.
 *
 * Two things a real browser does for free and Node's global WebSocket cannot
 * be told to do: trust the harness's certificate, and present the daemon's
 * session token. A browser presents the token as the `flue_token_<port>`
 * cookie it holds for this origin; `internal/transport/local` accepts the
 * header form from a caller that can read the token file, which is what this
 * process is.
 *
 * Only the five members `SocketLike` and `RawSocket` name are implemented,
 * because they are the whole of what the app uses.
 */
function socketClass(opts: TabOptions) {
  const isOwnOrigin = (url: string) => new URL(url).host === new URL(opts.origin).host
  return class HarnessSocket {
    binaryType = 'arraybuffer'
    onopen: ((ev?: unknown) => void) | null = null
    onclose: ((ev?: unknown) => void) | null = null
    onmessage: ((ev: { data: string | ArrayBuffer }) => void) | null = null
    onerror: ((ev?: unknown) => void) | null = null
    private ws: NodeWebSocket

    constructor(url: string) {
      const headers: Record<string, string> = {}
      if (opts.token !== undefined && isOwnOrigin(url)) headers['X-Flue-Token'] = opts.token
      this.ws = new NodeWebSocket(url, {
        headers,
        ...(opts.ca !== undefined && { ca: opts.ca }),
      })
      this.ws.binaryType = 'arraybuffer'
      this.ws.on('open', () => this.onopen?.())
      this.ws.on('close', () => this.onclose?.())
      // An error is always followed by a close, and the app's own factories say
      // so: the close path is where everything there is to do happens.
      this.ws.on('error', () => this.onerror?.())
      this.ws.on('message', (data: ArrayBuffer | Buffer, isBinary: boolean) => {
        if (!isBinary) {
          this.onmessage?.({ data: Buffer.from(data as Buffer).toString('utf8') })
          return
        }
        const buf = Buffer.from(data as Buffer)
        this.onmessage?.({ data: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) })
      })
    }

    send(data: string | ArrayBuffer | Uint8Array): void {
      this.ws.send(data as never)
    }

    close(): void {
      this.ws.close()
    }
  }
}
