/*
 * The maintainer's flow, end to end, against real processes.
 *
 *   install → serve → set a relay up → pair a browser → install on a second
 *   machine → paste the join line → and then, with nothing else done: each
 *   machine's own tab lists the other's sessions, the paired browser lists
 *   both, a session on the far machine takes input and answers, and a revoke
 *   on either machine kills the device everywhere.
 *
 * Every unit suite in this repo stubs the seam between two of those steps, and
 * every recent bug lived in one of the seams: a fleet key read at boot on one
 * side and live on the other, a directory route no browser could reach, a
 * loopback tab with no fleet identity, a certificate published where the commit
 * message said it no longer was, a control message with no consumer. Each
 * component was right about itself and wrong about its neighbour. This is the
 * suite that gives the neighbours to each other.
 *
 * Run it with `make e2e`. It is not in CI; see docs/DEVELOPMENT.md.
 *
 * # What is real and what is not
 *
 * Real: the relay Worker, under workerd, from the same relay/wrangler.jsonc a
 * deploy is checked against, with its Durable Objects, its migrations, its
 * asset router and its rate-limit binding. Two flue daemons, from the repo's
 * own binary, in their own config directories, joined by the real `flue relay
 * join` over real TLS. The browser's own modules — enrolment, the directory
 * reader, the certificate verifier, the Noise client, the fleet — imported
 * from web/src and called the way the app calls them.
 *
 * Not real: a browser. There is no Chromium here, which means **CORS and CSP
 * are not enforced by anything in this file**, and both are browser-enforced.
 * Where they matter the assertion is on the header a browser would decide
 * from — the relay's missing `Access-Control-Allow-Origin`, the daemon's
 * `connect-src` — which is the whole of the input to that decision and is
 * checked against a live server rather than a fixture. What that cannot prove
 * is that a real browser then behaves as specified. Also not real: the pairing
 * *page*. The ceremony's HTTP call is made here directly; web/src/routes/pair.tsx
 * has its own suite.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ed25519 } from '@noble/curves/ed25519.js'

import { FlueClient, daemonSocketUrl, type ConnStatus } from '@/client/client'
import type { SessionInfo, Welcome } from '@/client/protocol'
import { verifyCert, type Cert } from '@/crypto/cert'
import {
  loadOrCreateDeviceKey,
  loadPinnedDeviceCert,
  loadPinnedFleetKey,
  savePinnedDaemonKeyFor,
  savePinnedDeviceCert,
  savePinnedFleetKey,
} from '@/crypto/keys'
import { enrolThisBrowser, readDirectoryViaDaemon } from '@/fleet/enrol'
import { FleetClient, fleetSources } from '@/fleet/fleet'
import { LOCAL_MACHINE_ID, type FleetSession, type MachineState } from '@/fleet/types'
import { readDirectory } from '@/relay/directory'
import { saveMachine } from '@/relay/machines'
import { relaySocket } from '@/relay/socket'

import { openTab, type Tab } from './browser'
import { startFleet, stopFleet, until, type Fleet } from './harness'
import { request } from './http'

/** A run-unique string, so an assertion cannot pass on a stale artifact. */
const NONCE = Math.random().toString(36).slice(2, 10)
/** The command machine B's session is spawned with, and how every later
 *  assertion recognises it among whatever else is running. */
const MARKER = `flue-e2e-${NONCE}`

let fleet: Fleet
/** The fleet public key, derived from the seed the join line carried — the
 *  same key every daemon signs under and every browser pins. */
let fleetPub: Uint8Array
/** Machine B's marker session, spawned before anything was joined. */
let markerSession = ''
/** What the pairing ceremony on A handed the relay-origin browser. */
let paired: { deviceId: string; deviceCert: Uint8Array; daemonPub: Uint8Array } | null = null

/** The one tab that is open. Two would share Node's globals; see ./browser. */
let tab: Tab | null = null

/**
 * Open the tab. The harness CA goes on every one of them, whatever the origin:
 * a tab on a daemon's loopback address still opens `wss://<relay>/client/<id>`
 * for every other machine in the fleet, and in the world this stands in for
 * that certificate is signed by somebody the browser already trusts.
 */
function open(origin: string, opts: { token?: string } = {}): Tab {
  if (tab !== null) throw new Error('a tab is already open; close it first')
  tab = openTab({ origin, ca: fleet.ca, ...opts })
  return tab
}

function shut(): void {
  tab?.close()
  tab = null
}

/** The relay's own answer, as the harness (not a browser) can always read it. */
function relayGet(path: string, headers: Record<string, string> = {}) {
  return request(`${fleet.relayOrigin}${path}`, { ca: fleet.ca, headers })
}

/** Every blob the relay is holding that this fleet key signed. */
async function directoryCerts(): Promise<Cert[]> {
  const res = await relayGet('/directory')
  const doc = JSON.parse(res.body) as { entries?: Array<{ blob?: string }> }
  const out: Cert[] = []
  for (const entry of doc.entries ?? []) {
    if (typeof entry.blob !== 'string') continue
    const cert = verifyCert(fleetPub, Uint8Array.from(Buffer.from(entry.blob, 'base64')))
    if (cert !== null) out.push(cert)
  }
  return out
}

/** Connect a client and resolve on its welcome, or reject on a deadline. */
function connected(client: FlueClient, timeoutMs = 30_000): Promise<Welcome> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      off()
      reject(new Error('no welcome before the deadline'))
    }, timeoutMs)
    const off = client.onWelcome((w) => {
      clearTimeout(timer)
      off()
      resolve(w)
    })
    client.connect()
  })
}

/** The last thing the fleet said, kept so an assertion can wait on it. */
interface FleetView {
  sessions: FleetSession[]
  machines: MachineState[]
}

function watch(f: FleetClient): { latest: () => FleetView } {
  let latest: FleetView = { sessions: [], machines: [] }
  f.onFleet((sessions, machines) => {
    latest = { sessions, machines }
  })
  return { latest: () => latest }
}

beforeAll(async () => {
  fleet = await startFleet()
  fleetPub = ed25519.getPublicKey(Uint8Array.from(Buffer.from(fleet.fleetSeed, 'base64url')))
}, 180_000)

afterAll(async () => {
  shut()
  if (fleet !== undefined) await stopFleet(fleet)
})

describe('a fleet, end to end', () => {
  it('runs the relay the way a deploy runs it', async () => {
    // The version binding a deploy stamps (relaydeploy.VersionVar), reported
    // where a daemon reads it.
    const health = await relayGet('/api/health')
    expect(JSON.parse(health.body)).toEqual({ ok: true, version: 'e2e' })

    // The directory answers at all, which means the v2 migration created the
    // FleetDirectory class and the DIRECTORY binding reached the Worker. A
    // relay missing either answers 503 by design (relay/src/index.ts).
    const dir = await relayGet('/directory')
    expect(dir.status).toBe(200)
    expect(JSON.parse(dir.body)).toEqual({ v: 1, entries: [] })

    // The web bundle, under the headers a deploy sends with it. The document
    // is read off relay/public/_headers rather than retyped, because that file
    // is already pinned byte for byte to what `flue relay setup` uploads
    // (TestRelayAssetHeadersMatchTheWranglerCopy).
    const page = await relayGet('/')
    expect(page.status).toBe(200)
    expect(page.body).toContain('<title>flue</title>')
    const headers = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('../../relay/public/_headers', import.meta.url), 'utf8'),
    )
    const wantCsp = /Content-Security-Policy:\s*(.+)/.exec(headers)?.[1]?.trim()
    expect(page.headers['content-security-policy']).toBe(wantCsp)

    // And the router keeps refusal authority over its own prefixes: an id
    // outside the grammar is the Worker's 404 and never the app shell.
    expect((await relayGet('/daemon/NOT-AN-ID')).status).toBe(404)
    expect((await relayGet('/directory/anything')).status).toBe(404)
  })

  it('serves a loopback tab a policy that forbids a relay it has not got', async () => {
    // The CSP trap, stated as the header a browser would decide from. A page
    // served now — before this machine has a relay — carries a `connect-src`
    // that names no relay origin, so a tab left open across `flue relay join`
    // cannot open the socket or read the directory the joined daemon offers.
    // LocalCSPFor fixes the policy when the document is served, deliberately
    // (internal/daemon/server.go), and a reload is the whole of the way out.
    const before = await request(`${fleet.a.origin}/`, {})
    const csp = before.headers['content-security-policy'] ?? ''
    expect(csp).toContain("connect-src 'self' ws://127.0.0.1:*")
    expect(csp).not.toContain(fleet.relayOrigin)
  })

  it('lets a daemon that was already running join, sign, and publish', async () => {
    // The daemon has been up since before this relay existed, which is exactly
    // the window a fleet key read once at boot was never in.
    fleet.join(fleet.a, 'machine-a')
    expect(fleet.a.machineId).toMatch(/^[a-z0-9][a-z0-9-]*-[0-9a-f]{8}$/)

    await until("machine A's certificate to reach the directory", async () => {
      const certs = await directoryCerts()
      return certs.some((c) => c.kind === 'machine' && c.id === fleet.a.machineId)
    })

    // And the same daemon, without a restart, now serves a policy that names
    // the relay: the other half of the trap above.
    const after = await request(`${fleet.a.origin}/`, {})
    expect(after.headers['content-security-policy']).toContain(fleet.relayOrigin)
  })

  it('puts the fleet key in the pairing link', async () => {
    // The bug this is: a daemon that was running when the relay was set up
    // could not sign, so the link went out without `&f=` and the browser that
    // scanned it pinned no fleet key — permanently a fleet of one, with
    // nothing on any screen saying why.
    open(fleet.a.origin, { token: fleet.a.token })
    try {
      const client = new FlueClient(daemonSocketUrl())
      await connected(client)
      const pairing = await new Promise<{ url: string }>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('no pairing message')), 15_000)
        client.onPairing((p) => {
          clearTimeout(timer)
          resolve(p)
        })
        client.startPairing()
      })
      client.close()

      const url = new URL(pairing.url)
      expect(url.origin).toBe(fleet.relayOrigin)
      expect(url.pathname).toBe('/pair')
      expect(url.searchParams.get('t')).toBeTruthy()
      const k = url.searchParams.get('k')
      const f = url.searchParams.get('f')
      expect(k).toBeTruthy()
      expect(f).toBeTruthy()

      // Not merely present: the key in the link is the key the machine
      // certificates in the directory verify under, which is the only sense in
      // which `&f=` is worth anything.
      const linkFleetPub = Uint8Array.from(Buffer.from(f as string, 'base64url'))
      expect(Buffer.from(linkFleetPub)).toEqual(Buffer.from(fleetPub))
      const certs = await directoryCerts()
      expect(certs.some((c) => c.kind === 'machine' && c.id === fleet.a.machineId)).toBe(true)
    } finally {
      shut()
    }
  })

  it('enrols a loopback tab and reads the directory through its own daemon', async () => {
    // A tab on http://127.0.0.1 ran no ceremony, so it holds no fleet key and
    // no certificate — and it cannot read `GET /directory` for itself, because
    // that is a cross-origin fetch the Worker answers without a CORS header.
    // Both halves are the daemon's to answer, on its own origin.
    open(fleet.a.origin, { token: fleet.a.token })
    try {
      expect(await loadPinnedFleetKey()).toBeNull()
      expect(await enrolThisBrowser()).toBe(true)

      const pinned = await loadPinnedFleetKey()
      expect(pinned).not.toBeNull()
      expect(Buffer.from(pinned as Uint8Array)).toEqual(Buffer.from(fleetPub))

      const blob = await loadPinnedDeviceCert()
      expect(blob).not.toBeNull()
      const cert = verifyCert(fleetPub, blob as Uint8Array)
      expect(cert?.kind).toBe('device')
      const key = await loadOrCreateDeviceKey()
      expect(Buffer.from((cert as { device: Uint8Array }).device)).toEqual(
        Buffer.from(key.publicKey),
      )

      // Verbatim is the security property: the browser goes on verifying every
      // blob under the fleet key, because the daemon is transport here and not
      // trust. Byte for byte against the relay's own answer is what says so.
      const viaDaemon = await readDirectoryViaDaemon(`${fleet.relayOrigin}/directory`)
      expect(viaDaemon.ok).toBe(true)
      expect(await viaDaemon.text()).toBe((await relayGet('/directory')).body)
    } finally {
      shut()
    }
  })

  it('answers GET /directory with no Access-Control-Allow-Origin', async () => {
    // This is the fact the endpoint above exists for, and the one no unit test
    // can hold: every `fleetSources` test injects a `directoryFetch`, so the
    // read always succeeds in a suite and always failed in a tab.
    //
    // Asserted rather than fixed. A CORS header on the Worker would only help
    // relays deployed by a flue new enough to carry it, so the daemon proxies
    // instead (internal/daemon/fleet.go says why). Pinning the absence here is
    // what stops the proxy being quietly deleted as redundant.
    const res = await relayGet('/directory', { Origin: fleet.a.origin })
    expect(res.status).toBe(200)
    expect(res.headers['access-control-allow-origin']).toBeUndefined()
    expect(res.headers['access-control-allow-credentials']).toBeUndefined()

    // A preflight is not answered either, so not even a credentialled read
    // could be negotiated.
    const preflight = await request(`${fleet.relayOrigin}/directory`, {
      ca: fleet.ca,
      method: 'OPTIONS',
      headers: {
        Origin: fleet.a.origin,
        'Access-Control-Request-Method': 'GET',
      },
    })
    expect(preflight.headers['access-control-allow-origin']).toBeUndefined()
  })

  it("lists machine B's sessions in machine A's own tab, with no reload", async () => {
    // Machine B, still unjoined, gets the session every later assertion looks
    // for. Spawned through B's own loopback socket, which is what a user at
    // that keyboard would do.
    open(fleet.b.origin, { token: fleet.b.token })
    try {
      const onB = new FlueClient(daemonSocketUrl())
      await connected(onB)
      const sessions = new Promise<SessionInfo[]>((resolve) => {
        const off = onB.onSessions((s) => {
          if (s.some((row) => (row.cmd ?? []).some((arg) => arg.includes(MARKER)))) {
            off()
            resolve(s)
          }
        })
      })
      onB.spawn({ cmd: ['/bin/sh', '-c', `: ${MARKER}; exec /bin/sh`], cols: 80, rows: 24 })
      onB.list()
      const rows = await sessions
      markerSession = rows.find((r) => (r.cmd ?? []).some((a) => a.includes(MARKER)))?.id ?? ''
      expect(markerSession).not.toBe('')
      onB.close()
    } finally {
      shut()
    }

    // Now the tab on machine A, built exactly as FleetProvider builds one for
    // a page the daemon served on its own origin: one loopback source, the
    // enrolment seam, and the directory read that goes through the daemon.
    const t = open(fleet.a.origin, { token: fleet.a.token })
    const f = new FleetClient(
      [{ id: LOCAL_MACHINE_ID, name: '', client: new FlueClient(daemonSocketUrl()), pinned: false }],
      undefined,
      { enrol: enrolThisBrowser, directoryFetch: readDirectoryViaDaemon },
    )
    const view = watch(f)
    try {
      f.connect()
      await until('the local machine to come online', () =>
        view.latest().machines.some((m) => m.id === LOCAL_MACHINE_ID && m.status === 'online'),
      )
      // Machine B does not exist yet as far as this tab is concerned, and that
      // is the point of asserting it: what follows has to be discovery.
      expect(view.latest().machines).toHaveLength(1)

      // The join happens with the tab already open — no reload, no re-pair, no
      // second ceremony. This is step six of the flow.
      fleet.join(fleet.b, 'machine-b')
      await until("machine B's certificate to reach the directory", async () => {
        const certs = await directoryCerts()
        return certs.some((c) => c.kind === 'machine' && c.id === fleet.b.machineId)
      })

      // A focused tab re-reads the directory (FleetClient.onFocus), rate-limited
      // to one read per DISCOVER_FLOOR_MS. Firing it on every poll is what makes
      // this a wait on the condition rather than on a clock.
      await until(
        "machine B's sessions to appear in machine A's tab",
        () => {
          t.focus()
          const { sessions, machines } = view.latest()
          return (
            machines.some((m) => m.id === fleet.b.machineId && m.status === 'online') &&
            sessions.some((s) => s.machineId === fleet.b.machineId && s.id === markerSession)
          )
        },
        90_000,
      )

      const row = view.latest().sessions.find((s) => s.id === markerSession)
      expect(row?.machineId).toBe(fleet.b.machineId)
      expect(row?.machineName).toBe('machine-b')
      expect((row?.cmd ?? []).join(' ')).toContain(MARKER)

      // Step seven: bytes typed here have to reach that shell and come back.
      const remote = f.clientFor(fleet.b.machineId as string)
      expect(remote).not.toBeNull()
      const echoed = `echoed-${NONCE}`
      let seen = ''
      const client = remote as FlueClient
      client.onOutput((_ref, bytes) => {
        seen += new TextDecoder().decode(bytes)
      })
      const ref = await new Promise<number>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('no attach')), 30_000)
        const off = client.onAttached((a) => {
          if (a.id !== markerSession) return
          clearTimeout(timer)
          off()
          resolve(a.ref)
        })
        client.attach(markerSession)
      })
      client.sendInput(ref, new TextEncoder().encode(`echo ${echoed}\n`))
      await until('the shell on machine B to answer', () => seen.includes(echoed), 30_000)
    } finally {
      f.close()
      shut()
    }
  })

  it('keeps device certificates out of the fleet directory', async () => {
    // Two machines have joined and a browser has been enrolled, so if device
    // certificates were published there would be one here. `GET /directory`
    // needs no credential: publishing them made it a public roster of the
    // operator's device keys and their labels, and nothing is ever deleted
    // from it one entry at a time.
    const certs = await directoryCerts()
    expect(certs.map((c) => c.kind).sort()).toEqual(['machine', 'machine'])
    expect(certs.filter((c) => c.kind === 'machine').map((c) => c.id).sort()).toEqual(
      [fleet.a.machineId, fleet.b.machineId].sort(),
    )
  })

  it('lets a browser paired on A reach B with no second ceremony', async () => {
    // The ceremony, on the relay's origin: a fresh storage partition, which is
    // what a browser opening the pairing link actually gets.
    let link: URL
    open(fleet.a.origin, { token: fleet.a.token })
    try {
      const onA = new FlueClient(daemonSocketUrl())
      await connected(onA)
      link = new URL(
        await new Promise<string>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('no pairing message')), 15_000)
          onA.onPairing((p) => {
            clearTimeout(timer)
            resolve(p.url)
          })
          onA.startPairing()
        }),
      )
      onA.close()
    } finally {
      shut()
    }

    open(fleet.relayOrigin)
    try {
      const key = await loadOrCreateDeviceKey()
      // What web/src/routes/pair.tsx posts, to the endpoint it picks on a relay
      // origin: the machine id in the path, because one relay fronts them all.
      const answer = await fetch(`/api/pair/${fleet.a.machineId}`, {
        method: 'POST',
        body: JSON.stringify({
          token: link.searchParams.get('t'),
          publicKey: Buffer.from(key.publicKey).toString('base64'),
          label: `e2e ${NONCE}`,
        }),
      })
      expect(answer.ok).toBe(true)
      const body = JSON.parse(await answer.text()) as {
        daemonPub: string
        deviceId: string
        deviceCert: string
      }

      // The pin the QR carried is what the answer is measured against; a
      // different key answering is the attack the pin exists to catch.
      const daemonPub = Uint8Array.from(Buffer.from(body.daemonPub, 'base64'))
      expect(Buffer.from(daemonPub)).toEqual(
        Buffer.from(Uint8Array.from(Buffer.from(link.searchParams.get('k') as string, 'base64url'))),
      )
      const deviceCert = Uint8Array.from(Buffer.from(body.deviceCert, 'base64'))
      const linkFleetPub = Uint8Array.from(
        Buffer.from(link.searchParams.get('f') as string, 'base64url'),
      )
      expect(verifyCert(linkFleetPub, deviceCert)?.kind).toBe('device')

      await savePinnedDaemonKeyFor(fleet.a.machineId as string, daemonPub)
      await savePinnedFleetKey(linkFleetPub)
      await savePinnedDeviceCert(deviceCert)
      saveMachine({ id: fleet.a.machineId as string, name: 'machine-a', pairedAt: Date.now() })
      paired = { deviceId: body.deviceId, deviceCert, daemonPub }

      // And now the claim: one ceremony, and the fleet is the unit of trust.
      // The sources are built by the app's own builder, from a directory read
      // straight off the relay — this tab is on the relay's origin, so no
      // proxy is involved and none is wanted.
      const sources = await fleetSources({ loopback: false, relayOrigin: fleet.relayOrigin })
      expect(sources.map((s) => s.id).sort()).toEqual(
        [fleet.a.machineId, fleet.b.machineId].sort(),
      )
      // A is pinned because a user performed a ceremony with it; B is not, and
      // is reachable only on the certificate that ceremony minted.
      expect(sources.find((s) => s.id === fleet.b.machineId)?.pinned).toBe(false)

      const f = new FleetClient(sources)
      const view = watch(f)
      f.connect()
      await until(
        "both machines' sessions to reach the paired browser",
        () => {
          const { sessions, machines } = view.latest()
          return (
            machines.filter((m) => m.status === 'online').length === 2 &&
            sessions.some((s) => s.machineId === fleet.b.machineId && s.id === markerSession)
          )
        },
        60_000,
      )
      f.close()
    } finally {
      shut()
    }
  })

  it('kills a revoked browser on every machine in the fleet', async () => {
    expect(paired).not.toBeNull()
    const { deviceId, deviceCert, daemonPub } = paired as NonNullable<typeof paired>

    open(fleet.relayOrigin)
    try {
      const sources = await fleetSources({ loopback: false, relayOrigin: fleet.relayOrigin })
      const f = new FleetClient(sources)
      const view = watch(f)
      f.connect()
      await until(
        'the paired browser to be on both machines',
        () => view.latest().machines.filter((m) => m.status === 'online').length === 2,
        60_000,
      )

      // Revoked on machine A. Machine B was never asked, never told directly,
      // and never talks to A — it learns from the directory, which is the whole
      // of what makes a fleet-wide kill switch work.
      f.clientFor(fleet.a.machineId as string)?.revokeDevice(deviceId)

      await until(
        'machine B to cut the revoked device off',
        () =>
          view.latest().machines.find((m) => m.id === fleet.b.machineId)?.status === 'revoked',
        60_000,
      )
      // Not merely offline: the machine said why, in as many words, and the
      // fleet consumed it. `unreachable` would be a network fault and would
      // keep redialling; this is the verdict, and it stops.
      expect(view.latest().machines.find((m) => m.id === fleet.b.machineId)?.revokedReason).toBe(
        'revoked',
      )
      f.close()

      // And a fresh connection is refused. The registry entry is gone and the
      // revocation outranks the certificate this browser still holds, so the
      // handshake has nothing to be admitted on.
      const deviceKey = await loadOrCreateDeviceKey()
      const retry = new FlueClient(fleet.relayOrigin, (origin) =>
        relaySocket(origin, { deviceKey, daemonPub, deviceCert }, fleet.b.machineId as string),
      )
      const states: ConnStatus[] = []
      retry.onStatus((s) => states.push(s))
      retry.connect()
      await until(
        'the refused dial to report a close',
        () => states.includes('reconnecting') || states.includes('closed'),
        30_000,
      )
      expect(states).not.toContain('open')
      retry.close()

      // The directory carries the revocation, and the reader's rule turns it
      // into the one thing a browser can act on: stop presenting the
      // certificate.
      const certs = await directoryCerts()
      expect(certs.filter((c) => c.kind === 'revoke')).toHaveLength(1)
      const seen = await readDirectory({
        origin: fleet.relayOrigin,
        fleetPub,
        devicePub: deviceKey.publicKey,
      })
      expect(seen.revoked).toBe(true)
      expect(seen.machines.map((m) => m.id).sort()).toEqual(
        [fleet.a.machineId, fleet.b.machineId].sort(),
      )
    } finally {
      shut()
    }
  })
})
