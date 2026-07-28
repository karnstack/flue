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
- **Transports are the extension point.** No single remote transport is forced on
  anyone. Users who refuse Cloudflare, or refuse Tailscale, still have a path.
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
| loopback | the daemon | `http://127.0.0.1:PORT` |
| relay | the user's Worker | `https://<name>.workers.dev` |
| tunnel | the daemon, via `cloudflared` | `https://flue.example.com` |
| tailnet | the daemon | `https://host.tailnet.ts.net:PORT` |

Consequences: no mixed-content problem, no Chrome Private Network Access
preflight, and — most importantly — no cross-origin allowlist sitting between the
user's shell and every website they visit. An earlier draft of this design served
a hosted UI that reached into `127.0.0.1`, which required exactly such an
allowlist. Removing the hosted service removed the attack surface.

## User experience

### Install

```
brew install karnstack/tap/flue
# or
curl -fsSL https://flue.sh/install | sh
```

Single static binary. No runtime prerequisites.

### Local — the ten-second path

```
$ cd ~/code/myproject
$ flue open

  daemon started on 127.0.0.1:7717
  session 1a2b · ~/code/myproject · zsh
  opening http://127.0.0.1:7717/d/local/s/1a2b
```

A browser tab opens with a shell in that directory. That is the entire local
story: no config file, no account, no cloud, no network. Closing the tab detaches;
the shell keeps running. Reopening the URL reattaches.

This path must stay this short. It is the first thing anyone tries.

### Remote via relay — one-time setup, roughly two minutes

```
$ flue relay deploy

  ✓ wrangler found (logged in as karn@example.com)
  ✓ deployed relay to your Cloudflare account
  ✓ device key generated, registered as "macbook"

  relay: https://flue-relay.karn.workers.dev
  free tier is sufficient for personal use
```

Then run the daemon with the relay adapter enabled:

```
$ flue serve --relay
  connected to relay · outbound only, no ports opened
```

Pair a phone:

```
$ flue pair

  ┌───────────────┐
  │   ▄▄▄▄▄ ▄ ▄▄  │   scan with your phone camera
  │   █   █ ▀▄█▄  │
  │   █▄▄▄█ █ ▄█  │   or open the relay URL and enter:
  └───────────────┘        warm-otter-4821

  waiting… ✓ paired "karn's iPhone"
```

The QR carries the relay URL, the daemon's static public key, and a single-use
pairing token. The phone generates its own keypair and completes a Noise IK
handshake against the pinned daemon key, so the relay cannot impersonate either
side. From then on the phone loads the relay URL, sees the device list, taps a
session, and is attached. Adding it to the home screen makes it a PWA.

### Other transports

```
$ flue serve --tunnel flue.karn.dev    # requires a domain on Cloudflare
$ flue serve --tailnet                 # requires Tailscale on each device
```

Adapters compose; `flue serve --relay --tailnet` runs both.

### Everyday commands

```
flue open [path]     # spawn a session and open it in the browser
flue list            # sessions on this daemon
flue kill <id>       # terminate a session
flue devices         # paired browsers, with labels and last-seen
flue revoke <id>     # revoke a paired device
flue status          # daemon state, active adapters, session count
```

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
      loopback/
      relay/
      tunnel/
      tailnet/
    crypto/               # Noise IK handshake, framing, device keystore
    wire/                 # protocol codec (Go side)
    config/
  relay/                  # Cloudflare Worker + Durable Object, deployed by user
  web/                    # TS app, pnpm + vite
    src/emulator/         # Emulator interface + xterm.js implementation
    src/client/           # protocol client, reconnect, delta application
    src/crypto/           # browser half of Noise IK, key storage
    src/ui/               # device rail, session list, terminal view
  spec/protocol.md        # language-neutral wire spec
  testdata/
    vt/                   # VT conformance corpus, consumed by Go and TS
    wire/                 # protocol golden files, consumed by Go and TS
    noise/                # handshake vectors, consumed by Go and TS
```

The daemon embeds the built web app via `go:embed web/dist`. The relay Worker
serves the identical artifact. One build, several homes.

Language: **Go** for the daemon. It must run on every machine the user owns and
install as a single static binary. A Node runtime prerequisite is the wrong tax
for that. `creack/pty` handles PTYs; goroutine-per-session fits. The web app is
TypeScript with pnpm.

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

**`internal/crypto`** — Noise IK handshake, transport-layer framing, device
keystore. Pure; no I/O.

**`internal/wire`** — protocol encode/decode. Pure functions.

**`web/src/emulator`** — the `Emulator` interface and its xterm.js
implementation. This is the seam that makes the libghostty swap a substitution
rather than a rewrite.

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

**`web/src/ui`** — device rail, session list, terminal view, keyboard modes.

### Transport adapters

The critical detail: loopback **listens**, relay **dials out**. An interface
shaped like `Serve(listener)` cannot express both. So the abstraction is
"produces authenticated connections", direction-agnostic.

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
tailnet peers, tunnel is a manually configured hostname, loopback is itself.

| adapter | direction | authentication | intermediary | setup cost |
|---|---|---|---|---|
| `loopback` | listen `127.0.0.1` | token file + Origin + Host | none | none |
| `relay` | dial `wss://` outbound | device key at the Worker; Noise IK end-to-end | user's Worker (ciphertext only) | `wrangler deploy`, no domain needed |
| `tunnel` | listen loopback behind `cloudflared` | Cloudflare Access `Cf-Access-Jwt-Assertion` | Cloudflare | domain on Cloudflare |
| `tailnet` | listen tailnet address | tailscaled LocalAPI `WhoIs` → login allowlist | none; often direct peer-to-peer | Tailscale on each device |

None binds `0.0.0.0`, ever. Binding all interfaces would expose a shell-spawning
port on every network the machine joins, including untrusted ones.

The relay carries every browser attached to a device over one outbound socket,
so the relay link adds a channel header — `[4B channel][payload]` — leaving the
session protocol untouched. That framing is confined entirely to the relay
adapter; nothing above it knows a relay exists.

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

Applies to any adapter with an intermediary in the data path — `relay` today,
and `tunnel` if it is added there later. Default on, not optional: a security
default that is off is security that mostly does not exist.

**Handshake: Noise IK.** The browser initiates and already knows the daemon's
static public key from the pairing QR, so the daemon's identity is pinned. This
gives mutual authentication and forward secrecy, and means a malicious or
compromised relay cannot impersonate either side or read anything.

**Primitives:** X25519, HKDF-SHA256, ChaCha20-Poly1305. `flynn/noise` on the Go
side; `@noble/curves` and `@noble/ciphers` in the browser — audited, small, and
free of WebCrypto's patchy X25519 support.

**Pairing.** `flue pair` prints a QR containing the relay URL, the daemon static
public key, and a single-use, short-lived pairing token. The browser generates
its own keypair, and the token authorizes registering that public key with the
daemon. A typed phrase (`warm-otter-4821`) is offered as a fallback for devices
without a camera.

**Nonces and replay.** A strictly incrementing counter per direction; frames
arriving out of order or reusing a counter are rejected and the connection is
torn down. The underlying WebSocket is ordered and reliable, so no reordering
window is needed.

**Key storage.** Browser keys live in IndexedDB. Daemon keys live in
`$XDG_CONFIG_HOME/flue/keys`, mode `0600`. Since a stolen browser key is a
persistent grant, `flue devices` lists paired devices with labels and last-seen
times, and `flue revoke <id>` removes one.

## Error handling

| Condition | Behavior |
|---|---|
| PTY exits | Emit `exit{code}`; hold session `exited` for 10 min; then reap |
| Connection drops | Client reconnects with exponential backoff and jitter, reattaches with `lastSeq` |
| `lastSeq` evicted from ring | `attached{truncated:true}`; client resets emulator, writes the full ring, renders a truncation marker |
| Ring overflow | Evict oldest bytes, advance `baseSeq` |
| Daemon crash or restart | All sessions die. Accepted: scrollback is memory-only by design |
| Relay unreachable | Daemon retries outbound with backoff; loopback stays fully functional throughout |
| Noise handshake failure | Connection closed, no protocol frames processed, event logged |
| Replayed or out-of-order nonce | Connection torn down immediately and logged |
| Unpaired device key | `error{code:"unpaired"}`; the daemon does not reveal whether the device ID exists |
| Invalid or missing token (loopback) | 401, no upgrade |
| Disallowed Origin or Host (loopback) | 403, no upgrade, logged |
| Unknown tailnet peer | 403, no upgrade, logged with the resolved identity |
| `spawn` on an unauthenticated connection | `error{code:"unauthenticated"}` |
| Adapter prerequisite missing (`wrangler`, `cloudflared`, `tailscaled`) | That adapter fails to start with a specific, actionable message; other adapters are unaffected |

## Security

flue is a daemon whose purpose is spawning shells. The controls below are
requirements.

**Universal.** No adapter binds `0.0.0.0`. `spawn` requires an authenticated
connection. Every attach is logged with the resolved peer identity and session
ID. Every rejection is logged.

**Loopback.** A random token is generated at first start and stored `0600` at
`$XDG_CONFIG_HOME/flue/token`, required on every request and upgrade. The Origin
must be the daemon's own; the `Host` header must be `127.0.0.1:PORT` or
`localhost:PORT`, which defends against DNS rebinding — an attacker-controlled
name that resolves to loopback. No wildcard CORS under any condition. The token
arrives in the URL on first load, where it would leak via history and referrer,
so it is immediately exchanged for an `HttpOnly; SameSite=Strict` cookie,
stripped from the URL with `history.replaceState`, and every response sets
`Referrer-Policy: no-referrer`.

**Relay.** Two independent layers. The Worker authenticates who may open a
channel at all, using a device key for the daemon and a deploy-time secret for
browsers — this is a denial-of-service and enumeration control, not a
confidentiality one. Confidentiality comes from Noise IK, under which the Worker
only ever forwards ciphertext. Compromising the Worker yields no plaintext and no
ability to impersonate.

**Tunnel.** The daemon verifies the `Cf-Access-Jwt-Assertion` JWT against the
configured Access AUD and issuer on every request, and accepts a configured
public origin. It must not trust `cloudflared` merely because the connection
arrived on loopback.

**Tailnet.** Binds the specific tailnet address. Peer identity is resolved via
the local tailscaled LocalAPI `WhoIs`; only logins on the configured allowlist
are accepted. Being on the tailnet is not by itself authorization.

**Web UI.** A strict Content-Security-Policy on every origin that serves it. This
matters more than usual because browser-held Noise keys are a persistent grant to
a shell, and XSS would be key theft.

## Testing

**Authentication and crypto are the highest-priority suites.** A regression in
either is a remote shell.

- **Adapter auth**, table-driven per adapter: disallowed Origin, wrong Host,
  missing token, malformed token, unknown tailnet login, invalid Access JWT,
  expired Access JWT, unpaired device key. Every case must be rejected.
- **Noise handshake vectors** in `testdata/noise/`, executed by both the Go and
  the TypeScript implementations so they cannot drift. Plus negative tests: a
  wrong static key must fail; a replayed nonce must tear down the connection; a
  tampered ciphertext must fail authentication.
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
- **Relay Worker** tested with `@cloudflare/vitest-pool-workers`, including
  Durable Object hibernation and resumption.
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

1. `session` + `wire` + `loopback` + web app with the xterm.js emulator — the
   ten-second local path, daily-drivable.
2. `crypto` + `relay` adapter + the Worker + pairing — phone access.
3. `tunnel` adapter — for people with a domain on Cloudflare.
4. `tailnet` adapter — for people already on Tailscale.
5. Browser extension: tab-group binding, `term://` scheme.
6. `libghostty-vt`: native in the daemon first, so reattach sends a rendered
   snapshot; then wasm in the browser with a WebGL renderer, replacing xterm.js
   behind the `Emulator` seam.

## Open items to resolve during implementation

1. **Ring size default.** 2 MiB is a starting guess; measure against a real build
   log before fixing it.
2. **Durable Object hibernation under load.** Confirm that a hibernating DO
   resumes cleanly mid-stream and that the free tier's 13,000 GB-s/day holds for
   realistic daily use.
3. **`flue relay deploy` without a global wrangler.** Decide whether to vendor
   wrangler, shell out to `npx wrangler`, or drive the Cloudflare API directly.
   Requiring a Node toolchain would undercut the single-binary promise.
4. **Keyboard lock behavior in Dia specifically.** Dia is Chromium-based, but
   confirm `navigator.keyboard.lock()` and hold-`Esc` behave as they do in stock
   Chrome.
