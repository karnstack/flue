/*
 * The processes an end-to-end run needs, and nothing about what it asserts.
 *
 * A `Fleet` is: the real relay Worker under workerd, served over real TLS on
 * 127.0.0.1, and two real flue daemons with their own config directories and
 * ports, joined to it by the real `flue relay join`. Everything here is a
 * subprocess of the test runner and dies with it; nothing touches the
 * developer's own `~/.config/flue`, their keychain, or a Cloudflare account.
 *
 * # Why the relay runs under wrangler rather than in the vitest pool
 *
 * relay/ already tests the Worker inside `@cloudflare/vitest-pool-workers`,
 * and that pool is the right tool for what it does — but the two daemons here
 * are separate OS processes holding real sockets, and they need a host and a
 * port to dial. `wrangler dev` is the same workerd with a listener in front of
 * it, reading the same `relay/wrangler.jsonc` a developer runs `pnpm dev`
 * against, so the Durable Objects, the migrations, the assets router and
 * `run_worker_first` are the deployed article rather than a description of it.
 *
 * What the harness supplies by hand is exactly what `internal/relaydeploy`
 * supplies on a real deploy and a config file cannot hold: the `DAEMON_SECRET`
 * (a secret, never committed), the `FLUE_VERSION` plain-text var, and the web
 * bundle as the asset directory — `web/dist` plus `relay/public/_headers`,
 * because a real deploy uploads the built app and sends the same headers
 * document (`relayAssetHeaders` in cmd/flue/relay.go, kept byte-identical to
 * `relay/public/_headers` by test). Everything else — the two Durable Object
 * bindings, the v1/v2 migrations, `run_worker_first`, the rate-limit binding —
 * is read out of the real wrangler.jsonc, so a change there that a deploy
 * would have to match is a change this harness runs against.
 *
 * # Why TLS, and where the trust comes from
 *
 * `flue relay join` takes `wss://` or `https://` and refuses everything else
 * (`relayHost`, cmd/flue/relay.go), deliberately: the daemon secret rides an
 * Authorization header on every dial, so a "ws:// is fine on localhost"
 * affordance would be a downgrade path in the one place that must not have
 * one. So the harness mints a throwaway certificate for 127.0.0.1, hands it to
 * `wrangler dev --local-protocol https`, and trusts it on both sides:
 *
 *   - the daemons, through a binary built with `-tags e2e` (cmd/flue/e2etrust.go)
 *     which adds `$FLUE_E2E_CA` to the outbound root pool and nothing else;
 *   - this process, through the `ca` option on every socket and request the
 *     browser shims make (./browser.ts).
 *
 * No production code is relaxed anywhere, and no released binary contains the
 * trust shim.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { request } from './http'

/** The repo root, from this file's own location. */
export const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** The e2e-tagged binary. `make e2e` builds it; a run without it says so. */
const FLUE = join(REPO, 'bin', 'flue-e2e')

/** relay/'s own wrangler, run directly rather than through `pnpm exec`, so the
 *  process this holds a handle to is the one that owns the port. */
const WRANGLER = join(REPO, 'relay', 'node_modules', '.bin', 'wrangler')

/**
 * The ports. Fixed rather than found, and deliberately odd numbers well away
 * from flue's own 7717 and the dev daemon's 7719, so a run cannot be talking
 * to a daemon the developer started. A port already in use fails the run with
 * that as the message rather than by timing out somewhere later.
 */
export const PORTS = { relay: 8788, machineA: 7791, machineB: 7792 } as const

/** How long any wait-for-a-condition helper is given before it gives up. */
const READY_TIMEOUT_MS = 60_000

export interface Machine {
  /** `a` or `b`, for messages. */
  label: string
  /** The loopback port this daemon serves on. */
  port: number
  /** `http://127.0.0.1:<port>` — the origin a tab on this machine has. */
  origin: string
  /** Its XDG_CONFIG_HOME, holding token, relay.json, keys and snapshots. */
  configHome: string
  /** The session token, read off disk exactly as the flue CLI reads it. */
  token: string
  /** The relay id this machine minted at join, once it has joined. */
  machineId: string | null
  proc: ChildProcess
  /** Everything the daemon wrote to stdout and stderr, for failure messages. */
  log: () => string
}

export interface Fleet {
  /** `https://127.0.0.1:<port>` — the relay's origin, as the daemons see it. */
  relayOrigin: string
  /** The PEM the harness minted, for every TLS client in this process. */
  ca: string
  /** The daemon secret and the fleet seed, as `flue relay setup` would mint
   *  them — the join line's two credentials. */
  secret: string
  fleetSeed: string
  a: Machine
  b: Machine
  /** Run a flue subcommand against one machine's config, as a user would. */
  flue: (machine: Machine, args: string[]) => { stdout: string; stderr: string; status: number }
  /** Join a machine to the relay: the real command, the real join line. */
  join: (machine: Machine, name: string) => void
  /** Stop every process this started, and take the temp directory with it. */
  stop: () => Promise<void>
}

/** A base64url, no padding — the spelling both credentials use. */
function credential(): string {
  return randomBytes(32).toString('base64url')
}

/** Whether a TCP port on loopback already has something listening. */
function portTaken(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = createConnection({ port, host: '127.0.0.1' })
    const done = (taken: boolean) => {
      sock.destroy()
      resolve(taken)
    }
    sock.once('connect', () => done(true))
    sock.once('error', () => done(false))
  })
}

/**
 * Poll until `check` resolves true, or fail with `what` in the message.
 *
 * Every wait in this harness goes through here, and every one of them is on a
 * condition the system actually reaches — a port answering, a directory
 * holding a certificate — rather than on a sleep. A sleep that is long enough
 * on a laptop is a flake on a loaded runner, and a flaky gate is worse than no
 * gate at all.
 */
export async function until(
  what: string,
  check: () => Promise<boolean> | boolean,
  timeoutMs = READY_TIMEOUT_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let last: unknown = null
  for (;;) {
    try {
      if (await check()) return
      last = null
    } catch (err) {
      last = err
    }
    if (Date.now() > deadline) {
      const because = last === null ? '' : ` (last error: ${String(last)})`
      throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}${because}`)
    }
    await new Promise((r) => setTimeout(r, 100))
  }
}

/**
 * Mint the throwaway certificate the local relay is served under.
 *
 * `openssl` rather than a Node library because both platforms this repo is
 * developed and released on already ship one — macOS's LibreSSL 3.3 and
 * Ubuntu's OpenSSL 3 both take `-addext` — and a test-only X.509 dependency in
 * web/package.json would be a dependency in the app's manifest forever.
 *
 * One self-signed certificate serving as both leaf and trust anchor, valid for
 * a day, thrown away with the temp directory at the end of the run.
 */
function mintCert(dir: string): { keyPath: string; certPath: string; ca: string } {
  const keyPath = join(dir, 'relay-key.pem')
  const certPath = join(dir, 'relay-cert.pem')
  const res = spawnSync(
    'openssl',
    [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', keyPath, '-out', certPath,
      '-days', '1', '-subj', '/CN=flue-e2e',
      '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost',
    ],
    { encoding: 'utf8' },
  )
  if (res.error !== undefined || res.status !== 0) {
    throw new Error(
      'could not mint a TLS certificate for the local relay. The harness needs ' +
        'openssl on PATH (macOS and Ubuntu both ship one); it said:\n' +
        String(res.error ?? res.stderr),
    )
  }
  return { keyPath, certPath, ca: readFileSync(certPath, 'utf8') }
}

/**
 * The asset directory the relay serves, assembled the way a deploy assembles
 * it: the built web app, plus the `_headers` document `flue relay setup` sends
 * in the script metadata. Without the second one the relay would serve the
 * bundle with none of the security headers the daemon wraps its own copy in,
 * which is a thing worth being able to assert.
 */
function stageAssets(dir: string): string {
  const dist = join(REPO, 'web', 'dist')
  try {
    cpSync(dist, dir, { recursive: true })
  } catch {
    throw new Error(`no web bundle at ${dist}; run \`make web\` (or \`make e2e\`, which does)`)
  }
  cpSync(join(REPO, 'relay', 'public', '_headers'), join(dir, '_headers'))
  return dir
}

/**
 * Signal a child and everything it started.
 *
 * Every child here is spawned `detached`, which puts it at the head of its own
 * process group, and the negative pid is what reaches the group. It is not a
 * nicety: `wrangler dev` is a Node process that runs workerd as a child of its
 * own, and a run that killed only the process it spawned left a listener on the
 * relay's port that the *next* run refused to start beside. A daemon's session
 * shells are the same shape — they are the whole point of the product — and
 * they go the same way.
 */
function signalGroup(proc: ChildProcess, signal: NodeJS.Signals): void {
  if (proc.pid === undefined) return
  try {
    process.kill(-proc.pid, signal)
  } catch {
    // Already gone, or never started. Either way there is nothing to signal.
  }
}

/** Ask a child's whole group to stop, and wait for the OS to have reaped it. */
function reap(proc: ChildProcess): Promise<void> {
  if (proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve()
  return new Promise((resolve) => {
    const hard = setTimeout(() => {
      signalGroup(proc, 'SIGKILL')
      resolve()
    }, 5_000)
    hard.unref()
    proc.once('exit', () => {
      clearTimeout(hard)
      resolve()
    })
    signalGroup(proc, 'SIGTERM')
  })
}

/**
 * Start the relay and two daemons, and hand back the handles to drive them.
 *
 * Nothing is joined to anything here: the maintainer's flow starts with a
 * machine serving and no relay at all, and one of the things worth asserting
 * is what a tab served in that state carries. `fleet.join(...)` is the step.
 */
export async function startFleet(): Promise<Fleet> {
  const root = mkdtempSync(join(tmpdir(), 'flue-e2e-'))
  const procs: ChildProcess[] = []
  const kill = () => {
    for (const p of procs) signalGroup(p, 'SIGKILL')
    rmSync(root, { recursive: true, force: true })
  }
  const stop = async () => {
    await Promise.all(procs.map(reap))
    kill()
  }

  try {
    // Everything this run cannot proceed without, checked before a single
    // process starts. Each of these fails as a timeout somewhere in the middle
    // otherwise, and a timeout is the least informative failure there is.
    if (!existsSync(FLUE)) {
      throw new Error(`no ${FLUE}; build it with \`make e2e\`, which is how this suite is meant to be run`)
    }
    if (!existsSync(WRANGLER)) {
      throw new Error(`no ${WRANGLER}; run \`pnpm install\` in relay/ (\`make e2e\` does)`)
    }
    for (const [what, port] of Object.entries(PORTS)) {
      if (await portTaken(port)) {
        throw new Error(`port ${port} (${what}) is already in use; stop whatever holds it and re-run`)
      }
    }

    const { keyPath, certPath, ca } = mintCert(root)
    const assets = stageAssets(mkdtempSync(join(root, 'assets-')))
    const secret = credential()
    const fleetSeed = credential()
    const relayOrigin = `https://127.0.0.1:${PORTS.relay}`

    const relayLog: string[] = []
    const relay = spawn(
      WRANGLER,
      [
        'dev',
        '--config', join(REPO, 'relay', 'wrangler.jsonc'),
        '--local-protocol', 'https',
        '--https-key-path', keyPath,
        '--https-cert-path', certPath,
        '--ip', '127.0.0.1',
        '--port', String(PORTS.relay),
        '--assets', assets,
        // The two bindings a deploy supplies and a committed config cannot:
        // the secret (`wrangler secret put DAEMON_SECRET` in the real world,
        // `relaydeploy.SecretName` in flue's) and the version stamp
        // (`relaydeploy.VersionVar`). A `--var` lands as a plain-text binding
        // rather than a secret_text one, which the Worker reads identically.
        '--var', `DAEMON_SECRET:${secret}`,
        '--var', 'FLUE_VERSION:e2e',
        // Durable Object state under the run's temp directory, so two runs
        // never inherit each other's directory — and so nothing is left in
        // relay/.wrangler afterwards.
        '--persist-to', join(root, 'wrangler-state'),
        '--log-level', 'warn',
        '--show-interactive-dev-session', 'false',
      ],
      { cwd: join(REPO, 'relay'), stdio: ['ignore', 'pipe', 'pipe'], detached: true },
    )
    procs.push(relay)
    relay.stdout?.on('data', (d: Buffer) => relayLog.push(d.toString()))
    relay.stderr?.on('data', (d: Buffer) => relayLog.push(d.toString()))

    await until(
      `the relay to answer on ${relayOrigin}/api/health`,
      async () => {
        if (relay.exitCode !== null) {
          throw new Error(`wrangler dev exited (${relay.exitCode}):\n${relayLog.join('')}`)
        }
        const res = await request(`${relayOrigin}/api/health`, { ca })
        return res.ok
      },
    )

    const machine = async (label: string, port: number): Promise<Machine> => {
      const configHome = join(root, `machine-${label}`)
      mkdirSync(configHome, { recursive: true })
      const log: string[] = []
      const proc = spawn(FLUE, ['serve', '--port', String(port)], {
        env: { ...process.env, XDG_CONFIG_HOME: configHome, FLUE_E2E_CA: certPath },
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
      })
      procs.push(proc)
      proc.stdout?.on('data', (d: Buffer) => log.push(d.toString()))
      proc.stderr?.on('data', (d: Buffer) => log.push(d.toString()))
      proc.once('error', (err) => log.push(`spawn failed: ${String(err)}\n`))

      // The same readiness test the flue CLI uses on another daemon (`daemonAt`
      // in cmd/flue/main.go): an unauthenticated GET of /api/sessions answered
      // 401 by something serving flue's security headers. It is the last of the
      // three signals to appear, so it means the listener is genuinely up.
      await until(`machine ${label}'s daemon on 127.0.0.1:${port}`, async () => {
        if (proc.exitCode !== null) {
          throw new Error(`flue serve exited (${proc.exitCode}):\n${log.join('')}`)
        }
        const res = await request(`http://127.0.0.1:${port}/api/sessions`)
        return res.status === 401 && res.headers['referrer-policy'] === 'no-referrer'
      })

      return {
        label,
        port,
        origin: `http://127.0.0.1:${port}`,
        configHome,
        token: readFileSync(join(configHome, 'flue', 'token'), 'utf8').trim(),
        machineId: null,
        proc,
        log: () => log.join(''),
      }
    }

    const a = await machine('a', PORTS.machineA)
    const b = await machine('b', PORTS.machineB)

    const flue: Fleet['flue'] = (m, args) => {
      const res = spawnSync(FLUE, args, {
        env: { ...process.env, XDG_CONFIG_HOME: m.configHome, FLUE_E2E_CA: certPath },
        encoding: 'utf8',
      })
      return { stdout: res.stdout ?? '', stderr: res.stderr ?? '', status: res.status ?? -1 }
    }

    const join_: Fleet['join'] = (m, name) => {
      // The line a user copies out of `flue relay setup`, verbatim. The one
      // thing the harness stands in for is the Cloudflare half of setup: it
      // mints the same two credentials setup mints and skips the deploy, and
      // `runRelayJoin` writes the identical relay.json `runRelaySetup` does
      // (the only field setup adds is `worker`, which nothing on this path
      // reads).
      const res = flue(m, [
        'relay', 'join', `wss://127.0.0.1:${PORTS.relay}`,
        '--secret', secret,
        '--fleet', fleetSeed,
        '--name', name,
      ])
      if (res.status !== 0) {
        throw new Error(`flue relay join on ${m.label} failed:\n${res.stdout}\n${res.stderr}`)
      }
      const id = /\(([a-z0-9-]+)\)\s*$/m.exec(res.stdout)?.[1]
      if (id === undefined) throw new Error(`no machine id in join output:\n${res.stdout}`)
      m.machineId = id
    }

    return { relayOrigin, ca, secret, fleetSeed, a, b, flue, join: join_, stop }
  } catch (err) {
    kill()
    throw err
  }
}

/** Stop everything, waiting for each child to actually be gone. A run that
 *  returned while workerd still held the relay's port would fail the next one
 *  for a reason that has nothing to do with the code under test. */
export function stopFleet(fleet: Fleet): Promise<void> {
  return fleet.stop()
}
