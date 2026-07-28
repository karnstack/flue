# flue — P1 (Local) + P2 (Anywhere-free) Design

Date: 2026-07-28
Status: Approved

## Problem

Daily work happens in two places: a terminal (Ghostty) and a browser (Dia). The
cost is switching. The browser has grouping, tab search, splits, session restore,
and URL addressing; the terminal has none of that and cannot participate in it.
Every context switch between a PR page and the shell running that branch is a
manual re-orientation.

flue makes the terminal a browser tab, so it inherits the browser's organization
for free, and reachable from any device the user owns.

## Goals

1. **Kill the switching.** Terminal lives in a browser tab, indistinguishable
   from one.
2. **Replace Ghostty eventually.** Full keyboard capture must be possible;
   VT fidelity must have a credible path.
3. **Terminal from anywhere.** Phone, iPad, another laptop — same live sessions,
   mirrored.

## Non-goals for P1+P2

Relay backend, accounts, billing, end-to-end encryption, tab-group binding,
`term://` URL scheme, browser extension, libghostty integration, on-disk
scrollback history, session sharing with other people.

## Phasing (whole product, for context)

| Phase | Scope | Infra cost |
|-------|-------|-----------|
| **P1 Local** | Go daemon on loopback, web UI, sessions, detach/reattach, keyboard modes | none |
| **P2 Anywhere-free** | Tailscale transport, flue.sh static UI, multi-daemon picker | none |
| P3 Relay SaaS | Workers + Durable Objects relay, accounts, device pairing, E2E encryption, billing | paid tier funds it |
| P4 Browser-native | tab groups, `term://` scheme, extension | — |
| P5 Fidelity | `libghostty-vt` native in daemon, then wasm in browser | — |

**This document specifies P1 + P2 only.** They are specified together because the
transport abstraction must be designed once rather than retrofitted.

### Business model (context for why P2 exists)

Free tier is local + Tailscale: it never touches flue infrastructure, so it costs
nothing to operate and can be unlimited. Paid tier (P3) is the relay, for users
who will not install Tailscale. This is why Tailscale is a first-class transport
and not an afterthought.

## Key constraints discovered during design

**Browsers block mixed content.** An HTTPS page cannot open `ws://192.168.1.5`.
Therefore a plain LAN bind (`0.0.0.0` over HTTP) can never serve the hosted UI.
`127.0.0.1` and `localhost` are exempt as "potentially trustworthy" origins, so
local stays direct; remote requires real TLS, which Tailscale provides for free
via `tailscale cert` on `*.ts.net` names.

**`libghostty-vt` is VT-only.** Confirmed in `ghostty-org/ghostty` `build.zig`,
which has a `GhosttyLibVt.initWasm` path. It provides sequence parsing and
terminal state (cursor, styles, wrapping, scrollback) — no renderer. The renderer
library is on the roadmap, not shipped. Any browser integration means writing the
WebGL/WebGPU renderer. Hence xterm.js in P1 behind a seam, libghostty in P5.

**Browser keys are reserved.** `Cmd+W`, `Cmd+T`, `Cmd+L`, `Ctrl+Tab` cannot be
`preventDefault`ed by a page, and `chrome.commands` cannot claim them either. The
only full-keyboard escape is `navigator.keyboard.lock()`, which requires
fullscreen. Hence two keyboard modes.

## Architecture

### Repo layout

```
flue/
  cmd/flued/            # daemon binary
  internal/
    session/            # PTY, ring buffer, registry
    transport/          # loopback + tailnet listeners
    wire/               # protocol codec (Go side)
    config/
  web/                  # TS app, pnpm + vite
    src/emulator/       # Emulator interface + xterm.js implementation
    src/client/         # protocol client, reconnect, delta application
    src/ui/             # device rail, session list, terminal view
  spec/protocol.md      # language-neutral wire spec
  testdata/
    vt/                 # VT conformance corpus, consumed by Go and TS
    wire/               # protocol golden files, consumed by Go and TS
```

The daemon embeds the built web app via `go:embed web/dist` and serves it on
loopback. In P2 the identical artifact also deploys to Cloudflare Pages as
`flue.sh`. One build, two homes.

Language choice: **Go** for the daemon. It must run on every machine the user
owns and be installable as a single static binary (`brew install flue`, or curl
one file). A Node runtime prerequisite is the wrong tax for that. `creack/pty`
handles PTYs; goroutine-per-session fits the concurrency model. The web app stays
TypeScript with pnpm.

### Units

Each unit has one purpose, a defined interface, and is testable alone.

**`internal/session`** — owns PTYs and their scrollback. Knows nothing about
HTTP, WebSockets, or auth.
- Interface: `Registry.Spawn(opts) (*Session, error)`, `Registry.List()`,
  `Registry.Get(id)`, `Session.Write(p []byte)`, `Session.Resize(cols, rows)`,
  `Session.Signal(sig)`, `Session.Subscribe(fromSeq) (<-chan Chunk, error)`,
  `Session.Close()`.
- Depends on: `creack/pty`, the OSC title scanner.

**`internal/transport`** — listeners and authentication. Produces authenticated
connections; knows nothing about sessions.
- Interface: `Listener.Serve(mux http.Handler) error`, and a
  `Authenticator.Authenticate(*http.Request) (Peer, error)` per transport.
- Two implementations: `Loopback`, `Tailnet`.

**`internal/wire`** — protocol encode/decode. Pure functions, no I/O.

**`web/src/emulator`** — the `Emulator` interface and its xterm.js
implementation. The narrow seam that makes P5 a swap rather than a rewrite.
- Interface: `write(bytes: Uint8Array): void`, `resize(cols, rows): void`,
  `snapshot(): Grid`, `onData(cb: (bytes: Uint8Array) => void)`,
  `attachTo(el: HTMLElement)`, `dispose()`.

**`web/src/client`** — protocol client: connect, attach, reconnect with backoff,
apply deltas, request full snapshot on eviction. No DOM knowledge.

**`web/src/ui`** — device rail, session list, terminal view, keyboard mode
handling. Consumes `client` and `emulator`.

### Transport abstraction

Transports differ only in listener binding and authentication. The HTTP mux, the
protocol, and every handler below it are identical.

| | loopback | tailnet |
|---|---|---|
| bind | `127.0.0.1:PORT` | the specific tailnet address; never `0.0.0.0` |
| auth | token file + Origin allowlist + Host check | tailscaled LocalAPI `WhoIs` on peer IP → login allowlist |
| TLS | none (trustworthy origin) | `tailscale cert`, auto-renewed |
| default | enabled | disabled; `flue serve --tailscale` |

The tailnet path carries real user and device identity from the tailnet, so it
needs no shared secret.

### Protocol

WebSocket. **Text frames carry JSON control messages; binary frames carry data.**
No custom framing layer.

Binary frame layout:

```
[1 byte type][4 bytes ref, big-endian][payload]
type 0x00 = output (s→c)
type 0x01 = input  (c→s)
```

`ref` is a `uint32` handed out at attach time so keystrokes do not carry session
UUIDs.

Control messages:

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

WebSocket ping/pong frames handle liveness; no application-level ping.

**Sequencing.** The daemon assigns each session a monotonically increasing
byte-offset `seq`. On reattach the client sends its `lastSeq`. If that offset is
still inside the ring, the daemon replies `attached{truncated:false}` and streams
the delta. If it has been evicted, the daemon replies
`attached{truncated:true, seq:<baseSeq>}` followed by the full ring contents, and
the client resets its emulator before writing.

### Session model

```go
type Session struct {
    ID        string
    pty       *os.File
    ring      *Ring      // bounded bytes, default 2 MiB, tracks baseSeq
    cols      uint16
    rows      uint16
    primary   ClientID   // owns the PTY dimensions
    clients   []ClientID
    Title     string     // from OSC 0/2
    Cwd       string
    Cmd       []string
    State     State      // running | exited
    ExitCode  int
    ExitedAt  time.Time
}
```

- Ring size configurable; default 2 MiB. Eviction drops oldest bytes and advances
  `baseSeq`.
- `exited` sessions are retained for 10 minutes so their final output remains
  readable, then reaped.
- `Title` requires a minimal OSC 0/2 scanner in the daemon. That scanner is the
  server-side seam `libghostty-vt` fills in P5 — at which point reattach can send
  a rendered screen snapshot rather than a raw byte replay.
- Sessions inherit the user's login shell environment. flue is a terminal; a
  sanitized environment would defeat the purpose.

**Resize policy.** Exactly one attached client is `primary` and owns the PTY
dimensions. Other clients render the primary's grid scaled to fit using a CSS
transform, and remain fully interactive. Any client may send
`resize{primary:true}` to seize ownership; the daemon broadcasts `sizeChanged`.
When the primary detaches, the most-recently-active remaining client is promoted.
This is what stops a phone at 40 columns from shrinking the laptop's view.

### Data flow

```
browser loads UI (daemon-served locally, or flue.sh)
  → WS upgrade                       [origin + host + token, or tailnet WhoIs]
  → hello / welcome
  → list / sessions
  → attach {id, lastSeq}
  → attached {ref, seq, truncated}
  → binary output frames (delta or full ring), then live stream
keystroke        → binary input frame → session.Write → pty
window resize    → resize control msg → pty resize (if primary) → broadcast
tab close        → WS closes         → client detached; PTY runs on; ring fills
```

Multiple clients attached to one session receive identical output frames. Input
from any client reaches the PTY. That is the mirroring requirement: typing on the
phone appears live in the laptop browser.

### Web UI

- Left rail: devices — name, transport badge (`local` / `tailnet`), online dot.
  Expanding a device lists its sessions with title, cwd, state, last active.
- Main pane: the terminal.
- URL: `/d/<deviceId>/s/<sessionId>`. Bookmarkable and restorable.
- **No in-app tabs.** One session per browser tab; browser tabs are the tabs.
  This is the core premise, not a simplification.

**Device list persistence.** No backend exists in P1/P2, so the device list lives
in `localStorage` and devices are added manually by hostname. As an assist, the
daemon exposes `GET /api/tailnet/peers`, which shells out to `tailscale status`
and returns peers that appear to be running flue. The browser cannot enumerate a
tailnet; a daemon can.

**Keyboard modes.**
- *Tab mode* (default): the browser keeps `Cmd+*` and `Ctrl+Tab`; the terminal
  receives everything else. Tab groups, tab search, and switching all work.
- *Focus mode*: `requestFullscreen()` followed by `navigator.keyboard.lock()`.
  The terminal receives every key, including `Cmd+W`. Exit is Chromium's built-in
  hold-`Esc` gesture, which remains available while the keyboard is locked.
- A configurable chord toggles between them.

### CLI surface

```
flue serve [--tailscale] [--port N] [--ring-size 2MiB]
                        # run the daemon in the foreground
flue open [path]        # ensure daemon is running, spawn a session in `path`
                        # (default: cwd), open the browser at its URL
flue list               # list sessions on the local daemon
flue kill <id>          # terminate a session
flue status             # daemon state, listeners, session count
```

`flue open` is the everyday entry point and mirrors how `reins` starts its daemon
on demand. A launchd/systemd unit for `flue serve` is a packaging concern, out of
scope for this spec.

Sessions spawned without an explicit command run the user's login shell
(`$SHELL`, falling back to the passwd entry) as a login shell, inheriting the
user's environment.

## Success criteria

P1 is done when the author can run a full workday's terminal work in a Dia tab:
spawn sessions, close and reopen the tab without losing a running build, resize
freely, and use focus mode for full-keyboard TUI work.

P2 is done when a session started on the laptop can be attached from a phone over
Tailscale, input from the phone appears live in the laptop's browser, and the
laptop's column count is unaffected by the phone attaching.

## Error handling

| Condition | Behavior |
|---|---|
| PTY exits | Emit `exit{code}`; hold session in `exited` state 10 min; then reap |
| WebSocket drops | Client reconnects with exponential backoff and jitter, reattaches with `lastSeq` |
| `lastSeq` evicted from ring | `attached{truncated:true}`; client resets emulator, writes full ring, renders a truncation marker |
| Ring overflow | Evict oldest bytes, advance `baseSeq` |
| Daemon crash or restart | All sessions die. Accepted limitation of P1/P2 — scrollback is memory-only by design |
| Invalid or missing token | 401, no WS upgrade |
| Disallowed Origin or Host | 403, no WS upgrade, logged |
| Unknown tailnet peer | 403, no WS upgrade, logged with the resolved identity |
| `spawn` on unauthenticated connection | `error{code:"unauthenticated"}` |
| Tailscale not installed but `--tailscale` passed | Daemon fails to start with a clear message; loopback is unaffected |

## Security

This is the part that carries risk: flue is a daemon whose purpose is spawning
shells. The controls below are requirements, not suggestions.

### Loopback listener

- A random token is generated at first start and stored `0600` at
  `$XDG_CONFIG_HOME/flue/token`. It is required on every HTTP request and every
  WebSocket upgrade.
- **Origin allowlist**: the daemon's own origin, plus `https://flue.sh`. This
  control is load-bearing. Chrome's Private Network Access permits a public HTTPS
  page to reach loopback when the daemon answers the preflight with
  `Access-Control-Allow-Private-Network: true`. flue requires that mechanism for
  the hosted-UI-to-local-daemon path, which means the Origin check is the only
  barrier between the user's shell and any other website they visit. The PNA
  header is returned solely for the allowlisted origin, and solely when the token
  is valid.
- **Host header check**: must be `127.0.0.1:PORT` or `localhost:PORT`. This
  defends against DNS rebinding, where an attacker-controlled name resolves to
  127.0.0.1.
- No wildcard CORS. No `Access-Control-Allow-Origin: *` under any condition.
- The token arrives in the URL on first load, where it would otherwise leak via
  history and referrer. It is immediately exchanged for an
  `HttpOnly; SameSite=Strict; Secure`-where-applicable cookie, stripped from the
  URL with `history.replaceState`, and every response sets
  `Referrer-Policy: no-referrer`.

### Tailnet listener

- Disabled by default; enabled only with `flue serve --tailscale`.
- Binds the specific tailnet address. **Never `0.0.0.0`.** Binding all interfaces
  would expose a shell-spawning port on every network the machine joins,
  including untrusted ones.
- Peer identity is resolved through the local tailscaled LocalAPI `WhoIs` on the
  peer address. Only logins on the configured allowlist are accepted; unknown
  tailnet peers are rejected even though they are on the tailnet.
- TLS uses `tailscale cert` with automatic renewal.

### Both listeners

- `spawn` requires an already-authenticated connection.
- Every attach is logged with the resolved peer identity and session ID.
- Rejections (bad origin, bad host, bad token, unknown peer) are logged.

## Testing

**Authentication tests are the highest-priority suite.** Table-driven, covering:
disallowed Origin, wrong Host, missing token, malformed token, correct token with
wrong Origin, unknown tailnet login, and PNA preflight from a non-allowlisted
origin. Each must be rejected. A regression here is a remote shell.

- **Session units** (Go): ring eviction advances `baseSeq`; delta from a valid
  `lastSeq` is byte-exact; `truncated` is set when `lastSeq < baseSeq`; resize
  propagates (assert via `stty size` inside the PTY); exited sessions are held
  10 minutes then reaped; input from a second client reaches the PTY; output
  broadcasts to all attached clients.
- **Protocol golden files** in `testdata/wire/`, decoded by both the Go and the
  TypeScript implementations, guaranteeing they agree.
- **VT conformance corpus** in `testdata/vt/`: byte sequences paired with
  expected grid state. TypeScript runs it against xterm.js; Go runs it against
  the OSC title scanner now and `libghostty-vt` in P5. Writing this corpus in P1
  is what makes P5 a swap instead of a rewrite.
- **Client reconnect logic** (vitest): backoff, reattach with `lastSeq`, delta
  application, emulator reset on `truncated`.
- **End-to-end** via `reins` driving Dia: open a session URL, type a command,
  screenshot, assert the output; then kill the socket and assert reattach renders
  the same screen.
- **Manual checklist** (cannot be automated — fullscreen requires a user
  gesture): keyboard lock enter/exit, `Cmd+W` captured in focus mode, phone
  scale-to-fit rendering, pinch zoom, primary handoff between two devices.

## Open items to resolve during implementation

1. **Chrome Private Network Access preflight** — verify the exact preflight
   sequence a WebSocket upgrade from `https://flue.sh` to `ws://127.0.0.1`
   triggers in current Chromium, and confirm Dia matches stock Chromium here.
   Spike this before building the hosted-UI path; if it does not work, P2's local
   transport falls back to the daemon-served UI only.
2. **Tailscale certificate acquisition** — confirm `tailscale cert` is usable
   from a non-root daemon process, and determine the renewal trigger.
3. **Ring size default** — 2 MiB is a starting guess. Measure against a real
   build log before fixing it.
