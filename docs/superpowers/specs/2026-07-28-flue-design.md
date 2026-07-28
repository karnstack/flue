# flue — Design

Date: 2026-07-28
Status: Approved

## Problem

Daily work happens in two places: a terminal and a browser. The cost is
switching. Browsers have tab groups, tab search, splits, session restore, and URL
addressing. Terminals have none of it and cannot participate in it. Moving
between a PR page and the shell running that branch is a manual re-orientation,
dozens of times a day.

flue makes a terminal session a browser tab, so it inherits the browser's
organization for free — and makes that same live session reachable from any
device its owner has.

## Goals

1. **Kill the switching.** A terminal session is a browser tab, indistinguishable
   from one.
2. **Credible path to replacing a native terminal.** Full keyboard capture must
   be possible, and VT fidelity must have a real route to parity.
3. **Reachable from anywhere**, with the same live session mirrored across
   devices.

## Principles

- **Open source, no hosted service.** There is no flue account, no flue server,
  no billing. Every remote path runs on infrastructure the user owns.
- **The UI is the product surface.** The CLI is four commands and exists to
  bootstrap and diagnose. Everything else — sessions, devices, pairing, remote
  setup, settings — is in the browser, because that is where the user already is.
- **No favoured provider.** Remote access is a capability with interchangeable
  providers. None is the default; the UI presents them by what the user already
  has.
- **One binary, no runtimes.** No Node, no Python, no toolchain on the user's
  machine. Ever.
- **Same-origin always** (see below). The UI is served by whatever is already
  terminating the user's connection.
- **End-to-end encrypted wherever an intermediary exists.** Terminal traffic is
  credentials, tokens, and source code.

`flue.sh` is documentation and downloads. It is not part of the data path.

## Non-goals

Hosted service, accounts, billing, session sharing with other people,
collaborative editing, on-disk scrollback persistence.

## Key constraints discovered during design

**`libghostty-vt` is VT-only.** Confirmed in `ghostty-org/ghostty` `build.zig`,
which contains a `GhosttyLibVt.initWasm` path. It provides sequence parsing and
terminal state — cursor, styles, wrapping, scrollback — but no renderer. The
renderer library is on the roadmap and not shipped. Browser integration therefore
means writing the WebGL/WebGPU renderer. Hence xterm.js behind a seam, with
libghostty arriving later.

**Browser keys are reserved.** `Cmd+W`, `Cmd+T`, `Cmd+L`, and `Ctrl+Tab` cannot
be `preventDefault`ed by a page, and `chrome.commands` cannot claim them either.
The only escape is `navigator.keyboard.lock()`, which requires fullscreen. Hence
two keyboard modes.

**Browsers block mixed content.** An HTTPS page cannot open `ws://192.168.1.5`.
This is what rules out a plain LAN bind, and it is why the same-origin rule below
exists.

## The same-origin rule

The UI is always served by the same origin that terminates the connection:

| transport | UI served by | origin |
|---|---|---|
| local | the daemon | `http://127.0.0.1:PORT` |
| cloudflare-relay | the user's Worker | `https://<name>.workers.dev` |
| cloudflare-tunnel | the daemon, via `cloudflared` | `https://flue.example.com` |
| tailscale | the daemon | `https://host.tailnet.ts.net:PORT` |

Consequences: no mixed-content problem, no Chrome Private Network Access
preflight, and — most importantly — no cross-origin allowlist sitting between the
user's shell and every website they visit. An earlier draft of this design served
a hosted UI that reached into `127.0.0.1`, which required exactly such an
allowlist. Removing the hosted service removed the attack surface.

## User experience

### Install and enable

```
brew install karnstack/tap/flue
# or
curl -fsSL https://flue.sh/install | sh
```

Single static binary, no runtime prerequisites.

```
$ flue enable

  ✓ login service installed
  ✓ daemon running on 127.0.0.1:7717
  opening http://127.0.0.1:7717
```

`enable` installs a launchd (macOS) or systemd user (Linux) unit so the daemon
starts at login, then opens the UI. It is an explicit, reversible act rather than
something first run does silently: this is a service that spawns shells at login,
and that deserves a deliberate command.

**After this, the terminal is never required again.** Everything below happens in
the browser.

### In the UI

The UI is the whole product:

- **Sessions** — list across every device, with title, cwd, command, running or
  exited, last active. Create, attach, rename, kill.
- **Devices** — every paired browser, with a label and last-seen. Pair a new one.
  Revoke.
- **Remote access** — provider setup, described below.
- **Settings** — scrollback size, keyboard mode binding, theme, fonts.

Attaching a session opens it in its own browser tab at `/d/<deviceId>/s/<id>`,
which is bookmarkable, pinnable, and restorable by the browser like any other
tab. That is the point of the project.

### Setting up remote access

One screen, one question, phrased by what the user already has rather than by
mechanism. Providers are ordered by what `Detect()` finds installed:

```
  How do you want to reach this machine?

  ▸ Tailscale            already running on this machine
      Direct connection, nothing in between. Needs Tailscale on each device.

  ▸ Cloudflare
      Runs on your own Cloudflare account. Free tier is enough.
      No domain required.

  ▸ Cloudflare + your domain
      Uses a domain you already have on Cloudflare, with Access for sign-in.

  ▸ Not now
      This machine only. You can add remote access any time.
```

Each provider then renders its own setup steps in the UI. For Cloudflare:

```
  Connect Cloudflare

  1. Create an API token with these permissions:
       Account · Workers Scripts · Edit
       Account · Account Settings · Read

     [ Open Cloudflare token page ]

  2. Paste it here:  [________________________]

     flue uses this once to deploy, then deletes it.
```

Then flue discovers the account, deploys the Worker, enables the `workers.dev`
subdomain, sets the shared secret, registers this device, and **deletes the API
token**. Progress is shown step by step. The user pastes one string and clicks
once.

### Pairing a phone

From Devices → Pair, the laptop's browser renders a QR on screen. The phone's
camera scans it and lands on the relay URL, already pairing. A typed phrase
(`warm-otter-4821`) is the fallback.

Rendering the QR in the browser rather than as ASCII in a terminal is the whole
reason this flow belongs in the UI.

The QR carries the transport URL, the daemon's static public key, and a
single-use pairing token. The phone generates its own keypair and completes a
Noise IK handshake against the pinned daemon key, so the intermediary cannot
impersonate either side.

Once paired, the phone has the same UI and the same capabilities as the laptop.
See *Security* for why there is deliberately no split between them.

### CLI surface

```
flue enable       # install the login service, start the daemon, open the UI
flue disable      # remove the login service
flue status       # daemon state, active providers, session count — diagnostics
flue open [path]  # spawn a session in path and open it
```

`flue open` survives the move to a UI-first design only because it is genuinely
useful from a shell prompt: you are already in a directory and want a flue
session there.

Sessions spawned without an explicit command run the user's login shell
(`$SHELL`, falling back to the passwd entry) as a login shell, inheriting the
user's environment. flue is a terminal; a sanitized environment would defeat the
purpose.

## Architecture

### Repo layout

```
flue/
  cmd/flue/               # CLI + daemon binary
  internal/
    session/              # PTY, ring buffer, registry
    transport/            # adapter interface + implementations
      local/
      cfrelay/
      cftunnel/
      tailscale/
    provider/             # provider registry: detection, setup steps, config
    cloudflare/           # REST client: script upload, subdomain, secrets
    crypto/               # Noise IK handshake, framing, device keystore
    service/              # launchd / systemd unit install and removal
    wire/                 # protocol codec (Go side)
    config/
  relay/                  # Cloudflare Worker + Durable Object source
  web/                    # TS app, pnpm + vite
    src/emulator/         # Emulator interface + xterm.js implementation
    src/client/           # protocol client, reconnect, delta application
    src/crypto/           # browser half of Noise IK, key storage
    src/ui/               # sessions, devices, providers, settings, terminal
  spec/protocol.md        # language-neutral wire spec
  testdata/
    vt/                   # VT conformance corpus, consumed by Go and TS
    wire/                 # protocol golden files, consumed by Go and TS
    noise/                # handshake vectors, consumed by Go and TS
```

The daemon embeds the built web app via `go:embed web/dist`. The relay Worker
serves the identical artifact.

Language: **Go** for the daemon. It must run on every machine the user owns and
install as a single static binary. `creack/pty` handles PTYs; goroutine-per-
session fits. The web app and the Worker are TypeScript, bundled at release time.

### No Node on the user's machine

The Worker is bundled with esbuild **in CI, at release time**, into a single JS
module that is embedded in the Go binary via `go:embed`. Deployment then happens
over the Cloudflare REST API directly:

```
PUT  /accounts/{account_id}/workers/scripts/{name}
       multipart: metadata (main_module, DO binding, new_sqlite_classes
       migration, compatibility_date) + the bundled module
POST /accounts/{account_id}/workers/scripts/{name}/subdomain   {"enabled": true}
PUT  /accounts/{account_id}/workers/scripts/{name}/secrets
```

Node is a build dependency for the project, never a runtime dependency for the
user. `wrangler` is not invoked, not vendored, and not required.

### Units

**`internal/session`** — owns PTYs and their scrollback. Knows nothing about
HTTP, WebSockets, transports, or crypto.

```go
Registry.Spawn(opts) (*Session, error)
Registry.List() []*Session
Registry.Get(id) (*Session, bool)
Session.Write(p []byte) error
Session.Resize(cols, rows uint16) error
Session.Signal(sig os.Signal) error
Session.Subscribe(fromSeq uint64) (<-chan Chunk, error)
Session.Close() error
```

**`internal/transport`** — yields authenticated connections. Knows nothing about
sessions.

**`internal/provider`** — setup and detection for each remote-access option.
Separate from `transport` because setup and data flow have different lifetimes:
setup runs once, interactively, driven by the UI.

**`internal/cloudflare`** — REST client. Pure HTTP, no shelling out.

**`internal/crypto`** — Noise IK handshake, framing, device keystore. Pure.

**`internal/service`** — installs and removes the launchd or systemd unit.

**`internal/wire`** — protocol encode/decode. Pure functions.

**`web/src/emulator`** — the `Emulator` interface and its xterm.js
implementation. The seam that makes the libghostty swap a substitution rather
than a rewrite.

```ts
interface Emulator {
  write(bytes: Uint8Array): void
  resize(cols: number, rows: number): void
  snapshot(): Grid
  onData(cb: (bytes: Uint8Array) => void): void
  attachTo(el: HTMLElement): void
  dispose(): void
}
```

**`web/src/client`** — connect, attach, reconnect with backoff, apply deltas,
request a full snapshot on eviction. No DOM knowledge.

**`web/src/ui`** — sessions, devices, provider setup, settings, terminal view,
keyboard modes.

### Transport adapters

The critical detail: local **listens**, relay **dials out**. An interface shaped
like `Serve(listener)` cannot express both. So the abstraction is "produces
authenticated connections", direction-agnostic.

```go
type Transport interface {
    Name() string
    Run(ctx context.Context, accept func(Conn, Peer)) error
    Discover() []DeviceHint
    Close() error
}
```

`Discover()` generalizes peer discovery per transport rather than special-casing
it: the relay Durable Object knows registered devices, `tailscale status` knows
tailnet peers, tunnel is a configured hostname, local is itself.

| adapter | direction | authentication | intermediary | needs |
|---|---|---|---|---|
| `local` | listen `127.0.0.1` | token file + Origin + Host | none | nothing |
| `tailscale` | listen tailnet address | tailscaled LocalAPI `WhoIs` → login allowlist | none; often direct peer-to-peer | Tailscale per device |
| `cfrelay` | dial `wss://` outbound | device key at the Worker; Noise IK end-to-end | user's Worker, ciphertext only | Cloudflare account |
| `cftunnel` | listen loopback behind `cloudflared` | Cloudflare Access `Cf-Access-Jwt-Assertion` | Cloudflare | domain on Cloudflare |

No adapter binds `0.0.0.0`, ever. Binding all interfaces would expose a
shell-spawning port on every network the machine joins, including untrusted ones.

`local` is always on. Every other adapter is opt-in, and none is preferred by the
software — ordering in the UI comes from `Detect()`, which reflects what the user
already runs.

The relay carries every browser attached to a device over one outbound socket, so
the relay link adds a channel header — `[4B channel][payload]` — leaving the
session protocol untouched. That framing is confined to the `cfrelay` adapter;
nothing above it knows a relay exists.

### Provider registry

Transports move bytes. Providers handle the one-time setup, and are what the UI
actually renders.

```go
type Provider interface {
    ID() string                             // "tailscale", "cloudflare-relay"
    Describe() ProviderInfo                 // title, blurb, requirements, docs URL
    Detect(ctx) (Availability, error)       // installed? configured? reachable?
    SetupSteps() []Step                     // declarative; the UI renders these
    Configure(ctx, answers map[string]any) error
    Transport(cfg Config) (Transport, error)
}
```

`SetupSteps()` returns a declarative description — instructions, input fields,
external links, and progress items — so the UI needs no per-provider code and a
new provider is a registry entry rather than a UI change. Adding a self-hosted
relay or a WireGuard provider later touches nothing outside its own package.

### Protocol

WebSocket. **Text frames carry JSON control messages; binary frames carry data.**
No custom framing layer.

```
[1 byte type][4 bytes ref, big-endian][payload]
type 0x00 = output (daemon → client)
type 0x01 = input  (client → daemon)
```

`ref` is a `uint32` assigned at attach so keystrokes do not carry session UUIDs.

```
c→s  hello   {ver, caps}
     list    {}
     spawn   {cwd, cmd, cols, rows}
     attach  {id, lastSeq}
     detach  {ref}
     resize  {ref, cols, rows, primary}
     signal  {ref, sig}
     close   {ref}

s→c  welcome     {daemonId, host, ver, caps}
     sessions    [{id, title, cwd, cmd, state, cols, rows, lastActive}]
     attached    {ref, id, cols, rows, title, seq, truncated}
     exit        {ref, code}
     sizeChanged {ref, cols, rows, primary}
     revoked     {reason}
     error       {code, msg}
```

WebSocket ping/pong frames handle liveness; there is no application-level ping.

**Sequencing.** The daemon assigns each session a monotonically increasing
byte-offset `seq`. On reattach the client sends its `lastSeq`. If that offset is
still within the ring, the daemon replies `attached{truncated:false}` and streams
the delta. If it has been evicted, the daemon replies
`attached{truncated:true, seq:<baseSeq>}` followed by the full ring contents, and
the client resets its emulator before writing.

When end-to-end encryption is active, everything above — control frames included
— is the *inner* protocol. The intermediary sees only `[4B channel][ciphertext]`.

### Session model

```go
type Session struct {
    ID       string
    pty      *os.File
    ring     *Ring      // bounded bytes, default 2 MiB, tracks baseSeq
    cols     uint16
    rows     uint16
    primary  ClientID   // owns the PTY dimensions
    clients  []ClientID
    Title    string     // from OSC 0/2
    Cwd      string
    Cmd      []string
    State    State      // running | exited
    ExitCode int
    ExitedAt time.Time
}
```

- Ring size configurable, default 2 MiB. Eviction drops the oldest bytes and
  advances `baseSeq`.
- `exited` sessions are retained for 10 minutes so their final output stays
  readable, then reaped.
- `Title` needs a minimal OSC 0/2 scanner in the daemon. That scanner is the
  server-side seam `libghostty-vt` fills later, at which point reattach can send
  a rendered screen snapshot instead of replaying raw bytes.

**Resize policy.** Exactly one attached client is `primary` and owns the PTY
dimensions. Others render the primary's grid scaled to fit via CSS transform and
stay fully interactive. Any client may send `resize{primary:true}` to seize
ownership; the daemon broadcasts `sizeChanged`. When the primary detaches, the
most-recently-active remaining client is promoted. This is what stops a phone at
40 columns from shrinking the laptop's view.

### Data flow

```
browser loads UI (same-origin with its transport)
  → connection established and authenticated by the adapter
  → Noise IK handshake, if the adapter has an intermediary
  → hello / welcome
  → list / sessions
  → attach {id, lastSeq}
  → attached {ref, seq, truncated}
  → binary output frames (delta or full ring), then live stream
keystroke     → binary input frame → session.Write → pty
window resize → resize control msg → pty resize if primary → broadcast
tab close     → connection drops   → client detached; PTY runs on; ring fills
```

Every client attached to a session receives identical output frames, and input
from any client reaches the PTY. That is the mirroring requirement: typing on the
phone appears live in the laptop's browser.

### End-to-end encryption

Applies to any adapter with an intermediary — `cfrelay` today, `cftunnel` if
added there later. Default on, not optional: a security default that is off is
security that mostly does not exist.

**Handshake: Noise IK.** The browser initiates and already knows the daemon's
static public key from the pairing QR, so the daemon's identity is pinned. This
gives mutual authentication and forward secrecy, and means a malicious or
compromised intermediary cannot impersonate either side or read anything.

**Primitives:** X25519, HKDF-SHA256, ChaCha20-Poly1305. `flynn/noise` on the Go
side; `@noble/curves` and `@noble/ciphers` in the browser — audited, small, and
free of WebCrypto's patchy X25519 support.

**Nonces and replay.** A strictly incrementing counter per direction; frames
arriving out of order or reusing a counter are rejected and the connection is
torn down. The underlying WebSocket is ordered and reliable, so no reordering
window is needed.

**Key storage.** Browser keys live in IndexedDB. Daemon keys live in
`$XDG_CONFIG_HOME/flue/keys`, mode `0600`.

## Error handling

| Condition | Behavior |
|---|---|
| PTY exits | Emit `exit{code}`; hold session `exited` for 10 min; then reap |
| Connection drops | Client reconnects with exponential backoff and jitter, reattaches with `lastSeq` |
| `lastSeq` evicted from ring | `attached{truncated:true}`; client resets emulator, writes the full ring, renders a truncation marker |
| Ring overflow | Evict oldest bytes, advance `baseSeq` |
| Daemon crash | The login service restarts it; sessions do not survive. Accepted: scrollback is memory-only by design |
| Intermediary unreachable | Daemon retries outbound with backoff; `local` stays fully functional throughout |
| Noise handshake failure | Connection closed, no protocol frames processed, event logged |
| Replayed or out-of-order nonce | Connection torn down immediately and logged |
| Unpaired device key | `error{code:"unpaired"}`; the daemon does not reveal whether the device ID exists |
| Device revoked mid-session | `revoked{reason}` sent, connection closed, key removed — live sessions drop immediately |
| Pairing token expired or reused | Pairing refused; the daemon leaves pairing mode |
| Handoff token expired, unknown, or already spent (local) | 401, no cookie, no fallback to any other credential in the URL; run `flue open` again |
| Mint requested by anything that cannot read the token file (local) | 401 without the session token header, 403 for any browser-shaped request |
| Invalid or missing token (local) | 401, no upgrade |
| Disallowed Origin or Host (local) | 403, no upgrade, logged |
| Unknown tailnet peer | 403, no upgrade, logged with the resolved identity |
| Cloudflare API rejects deploy | Setup surfaces the API's own error text and the step that failed; the token is still discarded |
| Provider prerequisite missing | That provider reports unavailable in the UI with the specific reason; others are unaffected |

## Security

flue is a daemon whose purpose is spawning shells. The controls below are
requirements.

### Pairing is the only trust boundary

There is deliberately no privileged/unprivileged split between devices. A paired
device has a terminal on the machine, and a terminal is already every capability
flue's UI could offer — it can read the config, pair further devices, or install
anything. Restricting the UI while granting a shell would be theatre. Pairing is
therefore the boundary, and all the weight sits on the ceremony and on
revocation:

- Pairing tokens are single-use with a short TTL (about two minutes), and the
  daemon accepts pairing only while explicitly in pairing mode, entered from an
  already-trusted UI. There is no long-lived join code.
- The QR is rendered on a screen the user physically controls and contains the
  daemon's static public key, so the phone pins the daemon's identity and no
  intermediary can interpose.
- Devices are listed with labels and last-seen times. Revocation removes the key
  **and terminates that device's live connections immediately**, so it is a real
  control rather than a bookkeeping one.

### Credentials

The Cloudflare API token is the one credential whose blast radius extends beyond
this machine — it can deploy Workers across the user's whole account. It is used
once during setup and then deleted from disk, and re-requested when a redeploy is
needed. The scoped runtime secrets that remain are useful only against flue's own
Worker.

### Per-adapter

**Universal.** No adapter binds `0.0.0.0`. `spawn` requires an authenticated
connection. Every attach, pairing, revocation, and rejection is logged with the
resolved peer identity.

**Local.** A random *session token* is generated at first start and stored `0600`
at `$XDG_CONFIG_HOME/flue/token`, required on every request and upgrade. The
Origin must be the daemon's own; the `Host` header must be `127.0.0.1:PORT` or
`localhost:PORT`, which defends against DNS rebinding — an attacker-controlled
name that resolves to loopback. No wildcard CORS under any condition. Every
response sets `Referrer-Policy: no-referrer`.

*The session token never appears in a URL.* A URL handed to `open(1)` or
`xdg-open(1)` is that process's argv, which any local user can read via
`/proc/<pid>/cmdline` at Linux's default `hidepid=0` and via `ps(1)` on macOS —
so putting the permanent credential there would expose it for the life of the
launch. The daemon does not accept the session token from the query string under
any parameter name; it is accepted only from the `flue_token` cookie or the
`X-Flue-Token` request header.

Instead, `flue open` performs a **one-time handoff**:

1. It asks the running daemon to mint a handoff token: `POST /api/handoff`,
   authenticated by the session token in the `X-Flue-Token` header. Minting is
   refused to the cookie (a browser attaches it automatically, and `SameSite` is
   blind to the port, so a co-resident untrusted origin can cause the victim's
   browser to send it), to the query string, and to any request that carries a
   `Sec-Fetch-Site` header at all — every browser sends that header and the CLI
   never does, so requiring its absence limits minting to a local process that
   can read the token file.
2. The handoff token — 256 bits from `crypto/rand`, in memory only, never written
   to disk and never logged — goes in the URL as `?h=<token>`. It lives about ten
   seconds and is single-use.
3. The first load exchanges it for the `HttpOnly; SameSite=Strict` `flue_token`
   cookie. Redemption is a find-and-delete under one lock, so two concurrent
   presentations yield exactly one success, and a token is removed whether or not
   it was still valid. The client then strips `h` from the URL with
   `history.replaceState`.
4. There is **no fallback**. A handoff token that is unknown, expired or already
   spent fails the request outright: it does not fall through to the cookie, and
   the session token is never accepted from the URL as a second chance.

`POST /api/handoff` is the only route on the daemon reachable by a method other
than GET or HEAD. `OPTIONS` is refused everywhere, so no CORS preflight ever
succeeds and no browser can issue a cross-origin request carrying the header a
mint requires. The exchange itself is a state-changing GET admitted under
`Sec-Fetch-Site: none`, which a redirect can launder — accepted deliberately,
because a laundered request carrying an unknown token changes nothing, one
carrying a token the attacker already knows merely gives the victim's browser a
cookie it is already entitled to (strictly worse for the attacker than spending
it themselves), and the cookie's value is a constant chosen by the daemon rather
than anything from the request, so session fixation is impossible.

`flue serve` prints no credential: its banner gives the origin and points at
`flue open`.

**cfrelay.** Two independent layers. The Worker authenticates who may open a
channel at all, using a device key for the daemon and a scoped secret for
browsers — a denial-of-service and enumeration control, not a confidentiality
one. Confidentiality comes from Noise IK, under which the Worker only ever
forwards ciphertext. Compromising the Worker yields no plaintext and no ability
to impersonate.

**cftunnel.** The daemon verifies the `Cf-Access-Jwt-Assertion` JWT against the
configured Access AUD and issuer on every request, and accepts a configured
public origin. It must not trust `cloudflared` merely because the connection
arrived on loopback.

**tailscale.** Binds the specific tailnet address. Peer identity is resolved via
the local tailscaled LocalAPI `WhoIs`; only logins on the configured allowlist
are accepted. Being on the tailnet is not by itself authorization.

**Web UI.** A strict Content-Security-Policy on every origin that serves it. This
matters more than usual because browser-held Noise keys are a persistent grant to
a shell, and XSS would be key theft.

### Login service

`flue enable` installs a unit that starts a shell-spawning daemon at login. It is
never installed implicitly. `flue disable` removes it, and `flue status` reports
whether it is installed and running.

## Testing

**Authentication and crypto are the highest-priority suites.** A regression in
either is a remote shell.

- **Adapter auth**, table-driven per adapter: disallowed Origin, wrong Host,
  missing token, malformed token, unknown tailnet login, invalid Access JWT,
  expired Access JWT, unpaired device key. Every case must be rejected.
- **Pairing**: expired token refused, reused token refused, pairing outside
  pairing mode refused, revocation terminates live connections.
- **Local handoff**: a handoff token works exactly once; a second presentation
  fails; an expired one fails; two concurrent exchanges yield exactly one
  success; a failed exchange falls back to nothing; minting requires the session
  token in a request header and is refused to browsers; and no URL `flue open`
  produces contains the session token.
- **Noise handshake vectors** in `testdata/noise/`, executed by both the Go and
  the TypeScript implementations so they cannot drift. Negative tests: a wrong
  static key must fail; a replayed nonce must tear down the connection; a
  tampered ciphertext must fail authentication.
- **Cloudflare REST client** against recorded fixtures: script upload multipart
  shape, subdomain enable, secret set, and error surfacing. Plus one manual
  end-to-end deploy per release against a real account.
- **Session units**: ring eviction advances `baseSeq`; a delta from a valid
  `lastSeq` is byte-exact; `truncated` is set when `lastSeq < baseSeq`; resize
  propagates, asserted via `stty size` inside the PTY; exited sessions are held
  10 minutes then reaped; input from a second client reaches the PTY; output
  broadcasts to every attached client.
- **Protocol golden files** in `testdata/wire/`, decoded by both implementations.
- **VT conformance corpus** in `testdata/vt/`: byte sequences paired with
  expected grid state. TypeScript runs it against xterm.js; Go runs it against
  the OSC title scanner now and `libghostty-vt` later. Writing this corpus early
  is what makes the libghostty swap a substitution rather than a rewrite.
- **Relay Worker** with `@cloudflare/vitest-pool-workers`, including Durable
  Object hibernation and resumption.
- **Service install** on macOS and Linux: enable, verify running, disable, verify
  removed, and that `enable` is idempotent.
- **Client reconnect logic** under vitest with a fake socket: backoff, reattach
  with `lastSeq`, delta application, emulator reset on `truncated`.
- **End-to-end** via `reins` driving Dia: open a session URL, type a command,
  screenshot, assert output; kill the socket and assert reattach renders the same
  screen.
- **Manual checklist**, since fullscreen requires a user gesture: keyboard lock
  enter and exit, `Cmd+W` captured in focus mode, phone scale-to-fit, pinch zoom,
  primary handoff between two devices, QR pairing on a real phone.

## Build order

Dependency order, not phases. Nothing in the design is shaped by where these
boundaries fall.

1. `session` + `wire` + `local` + web app with the xterm.js emulator — a
   daily-drivable terminal in a browser tab.
2. `service` + `flue enable` + the UI shell: sessions, devices, settings.
3. `crypto` + pairing, exercised first over `local` so the ceremony is proven
   before an intermediary exists.
4. `provider` registry + `cloudflare` REST client + `cfrelay` + the Worker —
   phone access.
5. `tailscale` provider.
6. `cftunnel` provider.
7. Browser extension: tab-group binding, `term://` scheme.
8. `libghostty-vt`: native in the daemon first, so reattach sends a rendered
   snapshot; then wasm in the browser with a WebGL renderer, replacing xterm.js
   behind the `Emulator` seam.

## Open items to resolve during implementation

1. **Exact Cloudflare API token permissions.** Verify the minimum set that
   permits script upload with a Durable Object migration and subdomain enable.
   The UI's instructions must match exactly, or setup fails confusingly.
2. **Account selection.** Users with several Cloudflare accounts need a picker
   after the token is pasted; users with one should never see it.
3. **Ring size default.** 2 MiB is a starting guess; measure against a real build
   log.
4. **Durable Object hibernation under load.** Confirm a hibernating DO resumes
   cleanly mid-stream and that the free tier's 13,000 GB-s/day holds for
   realistic daily use.
5. **Keyboard lock behavior in Dia specifically.** Dia is Chromium-based, but
   confirm `navigator.keyboard.lock()` and hold-`Esc` behave as in stock Chrome.
