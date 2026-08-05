# flue cfrelay (Plan 1: relay substrate + web client) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reach your own daemon from any browser through a Cloudflare Worker relay you deploy to your own account — end-to-end Noise-encrypted, hibernation-cheap, and with every seam the flue.sh SaaS needs already in place.

**Architecture:** The daemon dials **outbound** to a Worker (`/daemon`); browsers connect to the same Worker (`/client`); a Durable Object bridges them, forwarding `[4B channel][ciphertext]` frames it cannot read. Each browser channel runs a Noise IK handshake (browser = initiator pinning the daemon's static key, daemon = responder) and then speaks the existing wire protocol inside the encrypted channel. The daemon gains a transport seam (`MessageConn` + `Server.ServeConn`) so local and relay connections are served by the same code; the web client gains a `SocketLike` implementation so `FlueClient` is untouched. `flue relay setup` deploys the Worker + web bundle to the user's Cloudflare account over the REST API.

**Tech Stack:** Go 1.26 (coder/websocket, flynn/noise), Cloudflare Workers + Durable Objects with WebSocket Hibernation, wrangler v4 (`wrangler.jsonc`), `@cloudflare/vitest-pool-workers` ^0.20.2 + vitest ^4.1, TypeScript ^5.9, existing web SPA (React 19, @noble crypto).

## Global Constraints

- **pnpm only** (`pnpm@11`), never npm/npx; one-off tools via `pnpm dlx`.
- **Go deps:** only what `go.mod` already has (coder/websocket, flynn/noise, creack/pty). No new Go dependencies.
- **relay/ package:** wrangler `^4`, `@cloudflare/vitest-pool-workers` `^0.20.2`, vitest `^4.1.0`, typescript `^5.9`. Config is `wrangler.jsonc`. `compatibility_date: "2026-08-01"`. The DO class is `DaemonHub`, declared via `migrations: [{ tag: "v1", new_sqlite_classes: ["DaemonHub"] }]` so it runs on the Workers **free** plan.
- **The daemon binds 127.0.0.1 only.** Remote reach is the daemon's outbound dial; no adapter ever binds 0.0.0.0.
- **The relay forwards ciphertext only.** No Noise keys, no plaintext terminal bytes, and no session tokens ever reach Worker code. The Worker sees: who connected, channel ids, frame sizes, and the pairing exchange (public keys + single-use pairing token — public-key material by design).
- **No secrets in URLs, argv, or logs.** Same discipline as part 1: the daemon relay secret travels in an `Authorization` header; the Cloudflare API token is read interactively, used, and discarded.
- **The wire protocol above the transport is unchanged.** `internal/wire` messages gain exactly one field (`Welcome.relay`); everything else is transport-level.
- **Keepalive:** Cloudflare closes idle WebSockets around ~100 s. Both legs send the text frame `flue-ping` every 30 s; the DO registers `setWebSocketAutoResponse(new WebSocketRequestResponsePair('flue-ping', 'flue-pong'))` so pings are answered at the edge without waking (or billing) the DO. Both legs silently drop incoming `flue-pong`.
- **Web tests:** 55 failures pre-exist on main (all of `terminal.test.tsx`, 3 in `theme-pref.test.ts` — a jsdom/localStorage environment issue). They are not yours to fix; do not grow the set. `cd web && pnpm test` is otherwise expected green.
- **Tailwind scans raw bytes** in `web/src/`: a single prose word in a comment can become a shipped CSS rule and fail `styles.build.test.ts`. Reword rather than allowlist.
- **Commits:** Conventional Commits, terse subject, why-over-what body only when needed.
- **Go tests:** `go test ./...` green at every task boundary. Relay Worker tests: `cd relay && pnpm test`. Web: `cd web && pnpm test` (modulo the pre-existing 55) and `pnpm lint`.

## File Structure (new/modified)

```
spec/relay-protocol.md                      relay framing + control-channel spec (Task 3)
internal/relaywire/frame.go                 [4B channel] + kind-byte + control messages (Task 3)
internal/relaywire/frame_test.go
testdata/relay/frames.json                  cross-language framing fixtures (Task 3)
internal/daemon/transport.go                MessageConn, ConnMeta, ServeConn (Task 1)
internal/daemon/conn.go                     conn speaks MessageConn instead of *websocket.Conn (Task 1)
internal/daemon/server.go                   handleWS wraps; registerDeviceConn hardening (Tasks 1–2)
internal/crypto/devices.go                  UpdateLastSeen (Task 2)
internal/transport/relay/relay.go           dial + control loop + reconnect (Task 7)
internal/transport/relay/channel.go         per-channel Noise responder + MessageConn (Task 8)
internal/transport/relay/relay_test.go      fake-relay tests (Tasks 7–8)
internal/daemon/pairing.go                  PairDevice extraction (Task 8)
internal/config/relay.go                    relay.json load/save (Task 9)
cmd/flue/main.go                            serve wires the relay transport (Task 9)
cmd/flue/relay.go                           flue relay setup / status (Task 14)
internal/cloudflare/client.go               REST deploy client (Task 13)
internal/cloudflare/client_test.go
relay/                                      the Worker package (Tasks 4–6)
  package.json, wrangler.jsonc, tsconfig.json, vitest.config.ts
  src/index.ts                              routing + auth seam
  src/hub.ts                                DaemonHub Durable Object
  src/frame.ts                              4-byte channel framing
  test/*.test.ts
web/src/relay/frame.ts                      kind-byte framing (Task 10)
web/src/relay/socket.ts                     RelaySocket: SocketLike over Noise (Task 10)
web/src/relay/*.test.ts
web/src/main.tsx / client/provider.tsx      relay-mode wiring (Task 11)
web/src/routes/devices.tsx                  Pair gating (Task 12)
docs/faq.md, docs/RELAY.md                  honesty + runbook (Task 15)
web/scripts/bundle-hash.mjs                 reproducible-bundle hash (Task 15)
```

---

### Task 1: The transport seam — `MessageConn` and `Server.ServeConn`

The daemon's per-connection state machine (`internal/daemon/conn.go`) currently
holds a `*websocket.Conn` and reads/writes it directly. The relay delivers
connections that are not WebSockets from the daemon's point of view — they are
Noise-encrypted channels multiplexed over one socket — so the connection code
must speak an interface instead. This task introduces that interface, converts
`conn` to it, and exports the one entry point every transport uses.

**Files:**
- Create: `internal/daemon/transport.go`
- Modify: `internal/daemon/conn.go` (the `ws` field, `runWriter`, `serve`, `newConn`)
- Modify: `internal/daemon/server.go` (`handleWS` wraps and delegates)
- Test: `internal/daemon/transport_test.go`

**Interfaces (Produces — later tasks rely on these exact names):**

```go
// internal/daemon/transport.go
package daemon

// MessageConn is one client's ordered message stream, however it reached the
// daemon. text distinguishes control JSON (true) from binary data frames.
type MessageConn interface {
	Read(ctx context.Context) (text bool, data []byte, err error)
	Write(ctx context.Context, text bool, data []byte) error
	// Close ends the stream. It must be safe to call more than once and
	// safe to call concurrently with Read/Write.
	Close() error
}

// ConnMeta identifies the peer a MessageConn speaks for.
type ConnMeta struct {
	Peer     string // resolved peer identity, for the audit log
	Origin   string // absolute origin pairing URLs may be built from
	DeviceID string // paired device id; "" on the local transport
}

// ServeConn serves one established, authenticated connection until it ends.
// It blocks. The connection's context is parented to the server's base
// context, so Shutdown reaches it.
func (s *Server) ServeConn(ctx context.Context, mc MessageConn, meta ConnMeta)
```

**Steps:**

- [ ] **Step 1: Write the failing test.** An in-memory `MessageConn` (a pair of channels) drives `ServeConn` directly — no HTTP, no WebSocket:

```go
// internal/daemon/transport_test.go
package daemon

// pipeConn is an in-memory MessageConn for tests: what the test writes to
// `in`, ServeConn reads; what the daemon writes lands on `out`.
type pipeConn struct {
	in     chan pipeMsg
	out    chan pipeMsg
	closed chan struct{}
	once   sync.Once
}
type pipeMsg struct {
	text bool
	data []byte
}

func newPipeConn() *pipeConn {
	return &pipeConn{in: make(chan pipeMsg, 16), out: make(chan pipeMsg, 64), closed: make(chan struct{})}
}
func (p *pipeConn) Read(ctx context.Context) (bool, []byte, error) {
	select {
	case m, ok := <-p.in:
		if !ok {
			return false, nil, io.EOF
		}
		return m.text, m.data, nil
	case <-p.closed:
		return false, nil, io.EOF
	case <-ctx.Done():
		return false, nil, ctx.Err()
	}
}
func (p *pipeConn) Write(ctx context.Context, text bool, data []byte) error {
	select {
	case p.out <- pipeMsg{text, append([]byte(nil), data...)}:
		return nil
	case <-p.closed:
		return errors.New("closed")
	case <-ctx.Done():
		return ctx.Err()
	}
}
func (p *pipeConn) Close() error { p.once.Do(func() { close(p.closed) }); return nil }

// expectControl reads frames off p.out until a text frame arrives, decodes it,
// and returns it; it fails the test after a timeout.
func expectControl(t *testing.T, p *pipeConn) any {
	t.Helper()
	deadline := time.After(2 * time.Second)
	for {
		select {
		case m := <-p.out:
			if !m.text {
				continue
			}
			msg, err := wire.DecodeControl(m.data)
			if err != nil {
				t.Fatalf("undecodable control frame: %v", err)
			}
			return msg
		case <-deadline:
			t.Fatal("no control frame arrived")
		}
	}
}

func TestServeConnSpeaksTheWireProtocol(t *testing.T) {
	srv := New(session.NewRegistry(time.Now), local.NewAuth("tok", 0), nil, "test", Identity{})
	p := newPipeConn()
	done := make(chan struct{})
	go func() { srv.ServeConn(context.Background(), p, ConnMeta{Peer: "test"}); close(done) }()

	// The daemon speaks first: Welcome.
	if w, ok := expectControl(t, p).(wire.Welcome); !ok {
		t.Fatalf("first frame was not a welcome: %#v", w)
	}
	// And answers a list.
	b, _ := wire.EncodeControl(wire.List{})
	p.in <- pipeMsg{text: true, data: b}
	if _, ok := expectControl(t, p).(wire.Sessions); !ok {
		t.Fatal("list was not answered with sessions")
	}
	// Closing the conn ends ServeConn.
	p.Close()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("ServeConn did not return after the conn closed")
	}
}

func TestServeConnRegistersTheDevice(t *testing.T) {
	srv := New(session.NewRegistry(time.Now), local.NewAuth("tok", 0), nil, "test", Identity{})
	p := newPipeConn()
	go srv.ServeConn(context.Background(), p, ConnMeta{Peer: "relay", DeviceID: "abcdefabcdef"})
	expectControl(t, p) // welcome — the conn is up and registered

	srv.connMu.Lock()
	n := len(srv.deviceConns["abcdefabcdef"])
	srv.connMu.Unlock()
	if n != 1 {
		t.Fatalf("device bucket holds %d conns, want 1", n)
	}
}
```

- [ ] **Step 2: Run to verify failure.** `go test ./internal/daemon/ -run TestServeConn -v` — FAIL: `ServeConn` undefined.

- [ ] **Step 3: Implement.**
  - `transport.go`: the interface + `ConnMeta` + `ServeConn`. `ServeConn` mirrors the tail of `handleWS`: derive `ctx, cancel := context.WithCancel(s.baseCtx)` (ignore the passed ctx for lifetime; `defer cancel()`), `c := newConn(ctx, cancel, mc, s, meta.Peer, meta.Origin)`, `s.addConn(c)`, `if meta.DeviceID != "" { s.registerDeviceConn(meta.DeviceID, c) }`, `defer s.removeConn(c)`, `c.serve()`, `_ = mc.Close()`.
  - `conn.go`: change the field `ws *websocket.Conn` to `mc MessageConn`; `frame.typ websocket.MessageType` becomes `text bool`; `runWriter` calls `c.mc.Write(ctx, f.text, f.b)`; `serve`'s read loop calls `c.mc.Read(c.ctx)` and branches on `text` instead of `websocket.MessageBinary`. `sendControl` queues `text: true`, `sendBinary` queues `text: false`. Drop the `websocket` import from `conn.go` entirely.
  - `server.go`: a small adapter in `transport.go`:

```go
// wsMessageConn adapts a coder/websocket connection to MessageConn.
type wsMessageConn struct{ ws *websocket.Conn }

func (w wsMessageConn) Read(ctx context.Context) (bool, []byte, error) {
	typ, data, err := w.ws.Read(ctx)
	return typ == websocket.MessageText, data, err
}
func (w wsMessageConn) Write(ctx context.Context, text bool, data []byte) error {
	typ := websocket.MessageBinary
	if text {
		typ = websocket.MessageText
	}
	return w.ws.Write(ctx, typ, data)
}
func (w wsMessageConn) Close() error { return w.ws.CloseNow() }
```

  `handleWS` keeps everything through `websocket.Accept` + `SetReadLimit`, then ends with `s.ServeConn(r.Context(), wsMessageConn{ws}, ConnMeta{Peer: r.RemoteAddr, Origin: requestOrigin(r)})` followed by `_ = ws.Close(websocket.StatusNormalClosure, "")`.

- [ ] **Step 4: Run the whole package.** `go test ./internal/daemon/ -count=1` — everything green, including the pre-existing suite (it exercises the same paths through real WebSockets).

- [ ] **Step 5: Run everything.** `go test ./...` — green.

- [ ] **Step 6: Commit.** `git commit -m "refactor(daemon): serve connections through a MessageConn seam"`

### Task 2: Carry-forward hardening the relay makes load-bearing

Four items from `docs/FOLLOW-UPS.md` §8 stop being latent the moment a second
transport calls into the daemon. Fix them before the caller exists.

**Files:**
- Modify: `internal/daemon/server.go` (`registerDeviceConn`, `dropConn`)
- Modify: `internal/daemon/conn.go` (store-error responses)
- Modify: `internal/crypto/devices.go` (`UpdateLastSeen`)
- Modify: `internal/daemon/transport.go` (`ServeConn` calls `UpdateLastSeen`)
- Test: `internal/daemon/server_test.go`, `internal/crypto/devices_test.go`

**Interfaces (Produces):**

```go
// internal/crypto/devices.go
// UpdateLastSeen stamps the device's LastSeen to now, reporting whether the
// device exists. Missing devices are not an error: a connection may race its
// own revocation.
func (s *DeviceStore) UpdateLastSeen(id string, now time.Time) (bool, error)
```

**Steps:**

- [ ] **Step 1: Failing tests, all four behaviors.**

```go
// internal/crypto/devices_test.go
func TestUpdateLastSeen(t *testing.T) {
	s := NewDeviceStore(t.TempDir())
	pub := make([]byte, 32)
	dev, _ := s.Add("phone", pub)
	later := time.Now().Add(time.Hour).Truncate(time.Second)
	ok, err := s.UpdateLastSeen(dev.ID, later)
	if err != nil || !ok {
		t.Fatalf("UpdateLastSeen = %v, %v", ok, err)
	}
	list, _ := s.List()
	if !list[0].LastSeen.Equal(later) {
		t.Fatalf("LastSeen = %v, want %v", list[0].LastSeen, later)
	}
	if ok, _ := s.UpdateLastSeen("000000000000", later); ok {
		t.Fatal("an unknown device reported found")
	}
}
```

```go
// internal/daemon/server_test.go (add)
func TestRegisterDeviceConnRefusesAConnAlreadyGone(t *testing.T) {
	// A conn that raced its own teardown: registerDeviceConn after removeConn
	// must not resurrect it into the device bucket, or revocation will later
	// find and close a conn that no longer exists — and miss ones that do.
	srv := New(session.NewRegistry(time.Now), local.NewAuth("t", 0), nil, "test", Identity{})
	c := &conn{}
	srv.addConn(c)
	srv.removeConn(c)
	srv.registerDeviceConn("abcdefabcdef", c)
	srv.connMu.Lock()
	defer srv.connMu.Unlock()
	if len(srv.deviceConns["abcdefabcdef"]) != 0 {
		t.Fatal("a removed conn was registered into the device bucket")
	}
}

func TestStoreErrorsDoNotReachClientsVerbatim(t *testing.T) {
	// A DeviceStore rooted in an unreadable directory fails with an error
	// naming the path — which contains $HOME. The client must get a generic
	// message; the path goes only to the log.
	dir := filepath.Join(t.TempDir(), "gone")
	srv, cl := newTestServerWithIdentity(t, Identity{ // use the existing test helper for a served daemon; see server_test.go
		Key:     testDaemonKey(t),
		Devices: crypto.NewDeviceStore(dir),
	})
	_ = os.RemoveAll(dir) // make List fail after startup
	_ = os.WriteFile(dir, []byte("not a dir"), 0o600)
	cl.send(t, wire.Devices{})
	e := cl.expectError(t, "devices_unavailable")
	if strings.Contains(e.Msg, dir) {
		t.Fatalf("error leaked the store path: %q", e.Msg)
	}
}
```

  (Adapt helper names to what `server_test.go` actually provides — it already has a served-daemon + test-client harness; reuse it rather than inventing one. If constructing a failing store proves brittle, substitute a store whose file is a directory, which makes `load` fail deterministically.)

- [ ] **Step 2: Run to verify failures.** `go test ./internal/daemon/ ./internal/crypto/ -run 'UpdateLastSeen|RegisterDeviceConn|StoreErrors' -v`

- [ ] **Step 3: Implement.**
  - `UpdateLastSeen`: load, find by id, stamp, save; `(false, nil)` when absent.
  - `registerDeviceConn`: inside `connMu`, verify `c` is still present in `s.conns` (linear scan; the slice is small) and return without registering when it is not.
  - `dropConn`: after the `append(list[:i], list[i+1:]...)`, nil the vacated tail slot (`list[len(list)-1] = nil` on the original backing array — copy the standard delete-with-clear idiom: `copy(list[i:], list[i+1:]); list[len(list)-1] = nil; return list[:len(list)-1]`).
  - Store errors: in `conn.go`, replace `err.Error()` with a constant client message on the three sites that carry store errors (`devices_unavailable` ×2, `revoke_failed`): client gets `"the device registry is unavailable"` / `"the device registry could not be written"`; the real error goes to `s.logger().Warn/Error` (the revoke path already logs it — keep that, fix only what the socket carries).
  - `ServeConn`: when `meta.DeviceID != ""` and `s.identity.Devices != nil`, call `s.identity.Devices.UpdateLastSeen(meta.DeviceID, time.Now())` before serving; ignore the not-found case, log a write error at Warn.

- [ ] **Step 4: Run.** `go test ./... -count=1` — green.

- [ ] **Step 5: Commit.** `git commit -m "fix(daemon): harden device-conn registry and stop store errors reaching clients"`

### Task 3: The relay wire protocol — spec, Go framing, fixtures

Everything the relay carries is framed one way, defined once, tested against
shared fixtures in Go now and consumed by the Worker (Task 4) and web (Task 10).

**The protocol (write this into `spec/relay-protocol.md`, prose + tables):**

- Daemon ↔ relay socket (binary WebSocket frames): `[4-byte big-endian channel id][payload]`.
- Channel `0` is the control channel; payloads are single JSON objects:
  - relay → daemon `{"type":"open","channel":N,"origin":"https://..."}` — a browser connected and was assigned channel N; origin is the Worker's own origin.
  - relay → daemon `{"type":"closed","channel":N}` — that browser went away.
  - daemon → relay `{"type":"close","channel":N}` — close that browser's socket.
  - relay → daemon `{"type":"pair","id":I,"origin":"https://...","body":{...}}` — an HTTP `POST /api/pair` arrived; body is the client's JSON verbatim.
  - daemon → relay `{"type":"pairResult","id":I,"status":200,"body":{...}}` — answer to `pair` with the HTTP status and response body to write.
- Channels ≥ 1 carry Noise: the first two payloads are the IK handshake messages (browser initiator → daemon responder → browser), relayed opaquely; every payload after is one Noise transport ciphertext.
- Browser ↔ relay socket: **no channel header** — the Worker knows the channel from the socket itself. The browser sends bare handshake/ciphertext payloads; the Worker wraps/unwraps.
- Inside each decrypted transport payload: `[1 byte kind: 0 = text (control JSON), 1 = binary][wire-protocol bytes]` — preserving the text/binary distinction the wire protocol depends on.
- Keepalive: either leg may send the **text** frame `flue-ping`; the edge answers `flue-pong` via auto-response; receivers drop `flue-pong` silently. These never carry channel headers.
- Auth: the daemon's upgrade request carries `Authorization: Bearer <daemon secret>`. Browser upgrades carry nothing (Noise is the confidentiality; the DO enforces a channel cap and a handshake deadline as DoS bounds).

**Files:**
- Create: `spec/relay-protocol.md`
- Create: `internal/relaywire/frame.go`, `internal/relaywire/control.go`
- Create: `testdata/relay/frames.json`
- Test: `internal/relaywire/frame_test.go`

**Interfaces (Produces):**

```go
package relaywire

const ControlChannel uint32 = 0

// Ping/Pong are the keepalive text frames; never channel-framed.
const (
	Ping = "flue-ping"
	Pong = "flue-pong"
)

type Frame struct {
	Channel uint32
	Payload []byte
}

func Encode(f Frame) []byte            // 4-byte BE channel ++ payload
func Decode(b []byte) (Frame, error)   // error when len(b) < 4

// Kind-byte framing inside a decrypted channel payload.
func EncodePlain(text bool, data []byte) []byte
func DecodePlain(b []byte) (text bool, data []byte, err error) // error on empty or kind > 1

// Control messages, channel 0. Decode returns one of *Open, *Closed,
// *Close, *Pair, *PairResult; unknown types are an error.
type Open struct {
	Type    string `json:"type"` // "open"
	Channel uint32 `json:"channel"`
	Origin  string `json:"origin"`
}
type Closed struct {
	Type    string `json:"type"` // "closed"
	Channel uint32 `json:"channel"`
}
type Close struct {
	Type    string `json:"type"` // "close"
	Channel uint32 `json:"channel"`
}
type Pair struct {
	Type   string          `json:"type"` // "pair"
	ID     uint64          `json:"id"`
	Origin string          `json:"origin"`
	Body   json.RawMessage `json:"body"`
}
type PairResult struct {
	Type   string          `json:"type"` // "pairResult"
	ID     uint64          `json:"id"`
	Status int             `json:"status"`
	Body   json.RawMessage `json:"body"`
}

func EncodeControl(msg any) ([]byte, error)   // sets Type from the concrete type
func DecodeControl(b []byte) (any, error)
```

**Fixture shape (`testdata/relay/frames.json`):**

```json
{
  "channelFrames": [
    { "name": "control", "channel": 0, "payloadB64": "eyJ0eXBlIjoib3BlbiIsImNoYW5uZWwiOjEsIm9yaWdpbiI6Imh0dHBzOi8vci5leGFtcGxlIn0=", "encodedB64": "AAAAAHsidHlwZSI6Im9wZW4iLCJjaGFubmVsIjoxLCJvcmlnaW4iOiJodHRwczovL3IuZXhhbXBsZSJ9" },
    { "name": "channel-7-bytes", "channel": 7, "payloadB64": "3q2+7w==", "encodedB64": "AAAAB96tvu8=" }
  ],
  "plainFrames": [
    { "name": "text", "text": true, "dataB64": "eyJ0eXBlIjoibGlzdCJ9", "encodedB64": "AHsidHlwZSI6Imxpc3QifQ==" },
    { "name": "binary", "text": false, "dataB64": "AQIDBA==", "encodedB64": "AQECAwQ=" }
  ]
}
```

(Generate the base64 values from the implementation once written, then pin them —
the test must decode the JSON and assert both directions, exactly the pattern
`internal/crypto/vectors_test.go` uses for the Noise vectors. The worker and web
suites will consume this same file, which is what makes the three
implementations one protocol.)

**Steps:**

- [ ] **Step 1: Write failing tests** — encode/decode round-trips, the error cases (short frame, empty plain, kind 2), and a fixture-driven test that walks `testdata/relay/frames.json` asserting `Encode(channel,payload) == encoded` and the reverse, plus `EncodeControl`/`DecodeControl` round-trips for all five message types and an unknown-type error.
- [ ] **Step 2: Run to verify failure.** `go test ./internal/relaywire/ -v`
- [ ] **Step 3: Implement** both files; `DecodeControl` unmarshals to a `struct{ Type string }` probe first, then the concrete type, mirroring `internal/wire/control.go`.
- [ ] **Step 4: Generate + pin the fixture** (a tiny `go run` scratch or a test in `-update` style is fine; the committed JSON is the artifact), re-run: green.
- [ ] **Step 5: Write `spec/relay-protocol.md`** covering everything in "The protocol" above, including the browser-leg-has-no-header rule and the keepalive rule.
- [ ] **Step 6: Run everything, commit.** `go test ./... && git add -A && git commit -m "feat(relaywire): relay framing, control messages, and cross-language fixtures"`

### Task 4: The relay Worker — package, routing, auth seam, DO skeleton

**Files:**
- Create: `relay/package.json`, `relay/wrangler.jsonc`, `relay/tsconfig.json`, `relay/vitest.config.ts`, `relay/.gitignore`
- Create: `relay/src/index.ts` (fetch router + auth), `relay/src/hub.ts` (DO skeleton), `relay/src/frame.ts`
- Test: `relay/test/frame.test.ts`, `relay/test/routing.test.ts`

**Key content:**

`relay/wrangler.jsonc`:

```jsonc
{
  "name": "flue-relay",
  "main": "src/index.ts",
  "compatibility_date": "2026-08-01",
  "assets": {
    "directory": "./public",
    "binding": "ASSETS",
    "not_found_handling": "single-page-application",
    "run_worker_first": ["/daemon", "/client", "/api/*"]
  },
  "durable_objects": { "bindings": [{ "name": "HUB", "class_name": "DaemonHub" }] },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["DaemonHub"] }],
  "observability": { "enabled": true }
}
```

(`relay/public/` starts as a directory containing a one-line `index.html`
placeholder page — "flue relay: deploy the web bundle with flue relay setup" —
and is git-kept; the real bundle is injected at deploy time by Task 14. Add
`relay/dist/` to `relay/.gitignore`.)

`relay/package.json` scripts: `"dev": "wrangler dev"`, `"test": "vitest run"`,
`"build": "esbuild src/index.ts --bundle --format=esm --outfile=dist/index.js --external:cloudflare:workers"`,
devDependencies: `wrangler@^4`, `@cloudflare/vitest-pool-workers@^0.20.2`,
`vitest@^4.1.0`, `typescript@^5.9`, `esbuild@^0.25`, `@cloudflare/workers-types@^5`.
`packageManager: "pnpm@11.9.0"` (copy the value from `web/package.json`).

`relay/vitest.config.ts` uses `defineWorkersConfig` from
`@cloudflare/vitest-pool-workers/config` with `wrangler: { configPath: "./wrangler.jsonc" }`.

`relay/src/index.ts` — the auth seam is one function per leg, so the SaaS
front-end (Plan 2) replaces the implementation without touching routing:

```ts
export interface Env {
  HUB: DurableObjectNamespace
  ASSETS: Fetcher
  DAEMON_SECRET: string
}

/** May this request open the daemon leg? Self-host: a bearer secret. */
export function authorizeDaemon(req: Request, env: Env): boolean {
  const h = req.headers.get('Authorization') ?? ''
  const want = `Bearer ${env.DAEMON_SECRET}`
  if (h.length !== want.length) return false
  // constant-time compare
  let diff = 0
  for (let i = 0; i < h.length; i++) diff |= h.charCodeAt(i) ^ want.charCodeAt(i)
  return diff === 0
}

/** May this request open a client channel? Self-host: yes — Noise is the
 * confidentiality; the DO's channel cap and handshake deadline bound abuse.
 * The SaaS front-end replaces this with signed-token verification. */
export function authorizeClient(_req: Request, _env: Env): boolean {
  return true
}

/** Which hub a request lands on. Self-host: one daemon, one hub. The SaaS
 * routes by account/daemon id here. */
export function hubIdFor(_req: Request, env: Env): DurableObjectId {
  return env.HUB.idFromName('hub')
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url)
    if (url.pathname === '/daemon') {
      if (!authorizeDaemon(req, env)) return new Response('unauthorized', { status: 401 })
      return env.HUB.get(hubIdFor(req, env)).fetch(req)
    }
    if (url.pathname === '/client') {
      if (!authorizeClient(req, env)) return new Response('unauthorized', { status: 401 })
      return env.HUB.get(hubIdFor(req, env)).fetch(req)
    }
    if (url.pathname === '/api/pair' && req.method === 'POST') {
      return env.HUB.get(hubIdFor(req, env)).fetch(req)
    }
    return env.ASSETS.fetch(req)
  },
}
export { DaemonHub } from './hub'
```

`relay/src/hub.ts` skeleton for this task: a `DurableObject` subclass whose
`fetch` upgrades `/daemon` and `/client` with `this.ctx.acceptWebSocket(server, ['daemon'])`
/ `(['client'])` (WebSocketPair, return 101 with the client end), registers
`this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('flue-ping', 'flue-pong'))`
in the constructor, refuses a second daemon socket by closing the old one
(code 4000, reason "replaced"), refuses `/client` when no daemon socket exists
(HTTP 503 body `{"error":"daemon offline"}`), and stubs
`webSocketMessage`/`webSocketClose` (forwarding lands in Task 5). Note for
implementers: `ws.accept()` is the non-hibernating API — never call it;
hibernation requires `ctx.acceptWebSocket`, no pending `setTimeout`/`setInterval`
(use DO alarms), and no outbound sockets from the DO (there are none by design).

`relay/src/frame.ts`: `encodeFrame(channel: number, payload: Uint8Array): ArrayBuffer`,
`decodeFrame(buf: ArrayBuffer): { channel: number; payload: Uint8Array }` —
must match `internal/relaywire` byte-for-byte; its test loads
`../../testdata/relay/frames.json` and walks `channelFrames`.

**Steps:**

- [ ] **Step 1: Scaffold the package** (files above), `cd relay && pnpm install`.
- [ ] **Step 2: Failing tests.** `frame.test.ts` (fixture-driven, as described). `routing.test.ts` with `SELF` from `cloudflare:test`: `/daemon` without the bearer → 401; `/daemon` with `Bearer test-secret` and WebSocket upgrade headers → 101; `/client` upgrade with no daemon connected → 503; unknown path → asset response. Provide `DAEMON_SECRET` via `vitest.config.ts` (`miniflare: { bindings: { DAEMON_SECRET: 'test-secret' } }` inside the workers pool options).
- [ ] **Step 3: Run to verify failure**, implement, re-run: `pnpm test` green. Also `pnpm build` produces `dist/index.js`.
- [ ] **Step 4: Commit.** `git add relay testdata && git commit -m "feat(relay): worker package — routing, auth seam, hibernating hub skeleton"`

### Task 5: The Durable Object bridges channels (and hibernates)

**Files:**
- Modify: `relay/src/hub.ts`
- Test: `relay/test/hub.test.ts`

**Behavior to implement (all in `DaemonHub`):**

- Channel assignment: on a `/client` upgrade, allocate the next channel id from
  `this.ctx.storage` (`get/put('nextChannel')`, starting at 1) so ids survive
  hibernation and daemon reconnects; attach it to the socket with
  `server.serializeAttachment({ channel, seen: false, opened: Date.now() })`.
- Announce to the daemon: send `Encode({channel: 0, payload: JSON open{channel, origin}})`
  where origin is `new URL(req.url).origin`.
- `webSocketMessage(ws, msg)`:
  - Ignore string messages entirely (keepalive is handled by auto-response;
    anything else stringly is a protocol error — close that socket, code 1002).
  - From a socket tagged `daemon`: decode the 4-byte header. Channel 0 →
    parse control JSON: `close{channel}` → find the client socket with that
    channel (walk `this.ctx.getWebSockets('client')`, read
    `deserializeAttachment().channel`) and `close(1000, 'daemon closed')`;
    `pairResult` → resolve the pending pair promise (Task 6). Channel ≥ 1 →
    forward the bare payload to that channel's client socket (`ws.send(payload)`);
    a payload for a channel with no socket is dropped.
  - From a socket tagged `client`: read its attachment, mark `seen: true`
    (re-serialize), wrap `[4B channel][bytes]`, send to the daemon socket. No
    daemon socket → `ws.close(1013, 'daemon offline')`.
- `webSocketClose(ws)`: client → tell the daemon `closed{channel}` (when a
  daemon socket exists) and log a per-channel line
  `console.log(JSON.stringify({evt:'channel_closed', channel, fwdToDaemon, fwdToClient, bytesToDaemon, bytesToClient}))`
  from counters kept in the attachment (update them on every forward);
  daemon → close every client socket (1012, 'daemon gone').
- Channel cap: refuse a `/client` upgrade when `getWebSockets('client').length >= 64`
  (HTTP 503, body `{"error":"relay full"}`).
- Handshake deadline: on each `/client` accept, `this.ctx.storage.setAlarm(Date.now() + 30_000)`
  if none pending; in `alarm()`, close (code 4001, 'handshake timeout') every
  client socket whose attachment has `seen: false` and `opened` older than 30 s,
  and re-arm the alarm only if unseen sockets remain.

**Steps:**

- [ ] **Step 1: Failing tests** in `relay/test/hub.test.ts` using the pool's
  `SELF` + real WebSockets: connect a fake daemon (`new WebSocket(...)` against
  `SELF.fetch` upgrades with the bearer header), connect a client, assert the
  daemon receives a well-formed `open` control frame (decode with `frame.ts`),
  client → daemon bytes arrive channel-wrapped, daemon → client bytes arrive
  bare, `close` control closes the client, client disconnect emits `closed`,
  second daemon replaces the first (old one gets 4000), 65th client gets 503,
  and a client that never sends is closed by the alarm (drive time with
  vitest fake timers if the pool supports it; otherwise set the deadline via a
  test-only env binding `HANDSHAKE_TIMEOUT_MS` — bind it to 50 in
  vitest.config.ts and default it to 30000 in code).
- [ ] **Step 2: Run to verify failure, implement, re-run.** `cd relay && pnpm test` green.
- [ ] **Step 3: Commit.** `git commit -m "feat(relay): hub forwards channel frames both ways under hibernation"`

### Task 6: The pairing bridge — HTTP in, control frames through

**Files:**
- Modify: `relay/src/hub.ts` (handle `POST /api/pair` in the DO fetch), `relay/src/index.ts` (already routes it)
- Test: `relay/test/pair.test.ts`

**Behavior:**

- In the DO's `fetch`, `POST /api/pair`: no daemon socket → 502
  `{"error":"daemon offline"}`. Enforce `Content-Length`/body ≤ 4096 bytes
  (413 over). If an `Origin` header is present it must equal the request URL's
  origin (403 otherwise) — the structural equivalent of the daemon's own
  provenance check, run where TLS terminates. Read the body, allocate a pair
  id from storage (`nextPairId`), send control `pair{id, origin, body}` to the
  daemon, and await a promise held in an in-memory `Map<number, resolver>`
  (an in-flight request keeps the DO active, so the map cannot be lost to
  hibernation while it matters) with a 10 s timeout → 504 `{"error":"daemon did not answer"}`.
- On control `pairResult{id, status, body}` from the daemon: resolve the map
  entry; the HTTP response is `status` + `body` with `Content-Type: application/json`
  and `Cache-Control: no-store`. An id with no waiter is dropped.

**Steps:**

- [ ] **Step 1: Failing tests:** pair POST with no daemon → 502; with a fake
  daemon connected, the daemon receives `pair` with the exact body and its
  `pairResult{status: 403, body: {...}}` becomes the HTTP answer verbatim;
  cross-origin `Origin` → 403 and the daemon receives nothing; oversized body
  → 413; a daemon that stays silent → 504 (shrink the timeout via the same
  env-binding pattern as Task 5, e.g. `PAIR_TIMEOUT_MS`).
- [ ] **Step 2: Implement, re-run, green.**
- [ ] **Step 3: Commit.** `git commit -m "feat(relay): bridge the pairing POST to the daemon over the control channel"`

### Task 7: The cfrelay adapter — dial, control loop, keepalive, reconnect

**Files:**
- Create: `internal/transport/relay/relay.go`
- Test: `internal/transport/relay/relay_test.go` (plus a `fake_relay_test.go` helper)

**Interfaces (Produces):**

```go
package relay

// Config is everything the adapter needs to reach a deployed relay.
type Config struct {
	URL    string // wss://flue-relay.<sub>.workers.dev/daemon
	Secret string // the DAEMON_SECRET set at deploy time
	Origin string // https origin the relay serves the UI on
}

// Server is the surface the adapter drives — implemented by *daemon.Server.
type Server interface {
	ServeConn(ctx context.Context, mc daemon.MessageConn, meta daemon.ConnMeta)
	PairDevice(body []byte, peer string) daemon.PairOutcome // Task 8
	SetRelayStatus(status, origin string)                   // Task 9
}

// Transport dials the relay and serves channels until ctx ends. It
// reconnects with jittered exponential backoff (250ms base, 30s cap) and
// only returns when ctx is done.
type Transport struct{ /* unexported */ }

func New(cfg Config, srv Server, identity noise.DHKey, devices *crypto.DeviceStore, log *slog.Logger) *Transport
func (t *Transport) Run(ctx context.Context) error
```

(Define the `Server` interface in this package — consumer-side interface, Go
convention — and note that `PairDevice`/`SetRelayStatus` arrive in Tasks 8–9;
for THIS task, keep the interface to `ServeConn` only and grow it in the tasks
that need more. The constructor takes the full dependency set now so the
signature is stable.)

**Behavior for this task:**

- `Run`: loop until ctx done — dial `cfg.URL` with `websocket.Dial` and
  `HTTPHeader: {"Authorization": {"Bearer " + cfg.Secret}}`, `SetReadLimit(1<<21)`;
  on connect, reset backoff; read loop: text frames equal to `relaywire.Pong` are
  dropped, any other text frame is a protocol error (close, reconnect); binary
  frames are `relaywire.Decode`d and dispatched: channel 0 control (`Open`,
  `Closed`, `Pair` — handled in Task 8; for now log-and-drop), channel ≥ 1 →
  routed to that channel's inbox (Task 8; for now drop).
- Writer: one goroutine owning the socket writes, fed by a channel (mirror the
  daemon's outbox pattern); a 30 s ticker enqueues the text frame
  `relaywire.Ping`.
- Backoff: 250 ms base doubling to a 30 s cap, equal jitter, reset on a
  successful connect (mirror `web/src/client/client.ts` semantics).

**Steps:**

- [ ] **Step 1: Failing tests** against a fake relay: an `httptest.Server`
  whose handler asserts the `Authorization` header, `websocket.Accept`s, and
  exposes send/expect helpers to the test. Tests: (a) the adapter dials and
  authenticates; (b) a wrong secret answered 401 → the adapter retries (observe
  ≥ 2 connection attempts); (c) the adapter sends `flue-ping` within the test
  keepalive interval (make the interval a field defaulted to 30 s, set to 50 ms
  in tests); (d) killing the socket server-side → the adapter reconnects.
- [ ] **Step 2: Verify failure, implement, re-run.** `go test ./internal/transport/relay/ -race -count=1`
- [ ] **Step 3: Commit.** `git commit -m "feat(relay): daemon-side adapter dials the worker and keeps the socket alive"`

### Task 8: Channels — Noise responder, device auth, ServeConn, PairDevice

**Files:**
- Create: `internal/transport/relay/channel.go`
- Modify: `internal/transport/relay/relay.go` (dispatch to channels)
- Modify: `internal/daemon/pairing.go` (extract `PairDevice`)
- Test: `internal/transport/relay/channel_test.go`, extend `internal/daemon/pairing_test.go`

**Interfaces (Produces):**

```go
// internal/daemon/pairing.go
// PairOutcome is the transport-neutral answer to a pairing attempt: the HTTP
// status and JSON body handlePair would have written.
type PairOutcome struct {
	Status int
	Body   []byte
}

// PairDevice runs the pairing ceremony on an already-provenance-checked
// request body: shape checks, redeem, register, broadcast. peer is for the
// audit log. It never returns a body naming filesystem paths.
func (s *Server) PairDevice(body []byte, peer string) PairOutcome
```

`handlePair` becomes: method check → provenance → `out := s.PairDevice(body, r.RemoteAddr)`
→ write `out.Status`/`out.Body` (with the same headers as today). The refusal
body stays the uniform `"pairing refused"` text with status 403; the success
body stays `{"deviceId":..., "daemonPub":...}` — move that construction into
`PairDevice` so both transports answer identically. (`refusePair`'s logging
moves with it; it gains a `peer string` parameter instead of `*http.Request`.)

**Channel behavior (`channel.go`):**

- On control `Open{channel, origin}`: verify `origin == cfg.Origin` (a relay
  announcing a foreign origin is misconfigured or lying — close the channel
  with control `Close` and log Warn); spawn a channel goroutine.
- The channel goroutine: run `crypto.ResponderHandshake(identity, rand.Reader, recv, send)`
  where `recv` pulls the next payload from this channel's inbox (a buffered
  chan fed by the dispatcher) and `send` writes a channel-wrapped frame via the
  transport writer. On handshake error: control `Close`, done.
- Look up the peer's static key: `devices.FindByKey(peerStatic)`. Unknown →
  control `Close{channel}` and a Warn log (an unpaired browser cannot attach; it
  must pair first). Known → build a `channelConn` and call
  `srv.ServeConn(ctx, cc, daemon.ConnMeta{Peer: "relay:" + dev.ID, Origin: origin, DeviceID: dev.ID})`.
- `channelConn` implements `daemon.MessageConn`:
  - `Read`: next inbox ciphertext → `ch.Open` (Noise decrypt) → `relaywire.DecodePlain` → `(text, data)`. Inbox closed (channel `Closed`/socket loss) → `io.EOF`.
  - `Write`: `relaywire.EncodePlain(text, data)` → `ch.Seal` → channel-wrapped frame to the writer.
  - `Close`: enqueue control `Close{channel}` and close the inbox.
- Dispatcher (in `relay.go`): channel ≥ 1 frames → that channel's inbox
  (drop when the inbox is full — 256 deep, same bound as the daemon outbox — by
  closing the channel: a stalled channel must not stall the socket); `Closed` →
  close the inbox; `Pair{id, origin, body}` → verify origin as above, run
  `srv.PairDevice(body, "relay")` on a goroutine, enqueue
  `PairResult{ID: id, Status: out.Status, Body: out.Body}`. On socket loss,
  close every inbox (every relay client sees a clean disconnect and the browser
  reconnects through the ordinary backoff path).

**Steps:**

- [ ] **Step 1: Failing test — the full loop.** In `channel_test.go`, run a
  fake relay (Task 7's helper) + a real `daemon.Server` (with a temp-dir
  `Identity` whose `DeviceStore` holds a pre-registered device key) + the
  transport. The test plays the **browser**: over the fake relay's daemon
  socket, send `open{1, origin}`, then drive a real
  `crypto.InitiatorHandshake` with the device's key against the daemon's public
  key, exchanging channel-1 frames through the fake relay; after the handshake,
  seal `EncodePlain(true, wire List)` — expect a sealed `Sessions` answer, and
  the first frame to be the `Welcome`. Assert: an unknown device key gets
  control `Close` after its handshake; `LastSeen` was stamped (read the store);
  the device bucket holds the conn (revoke closes it — send `wire.Revoke` from
  a second, local test client if the harness makes that easy, else assert via
  `deviceConns` under lock as in Task 1).
- [ ] **Step 2: Failing test — PairDevice.** In `pairing_test.go`: `PairDevice`
  with a live window + valid body returns 200 and a body carrying
  `deviceId`/`daemonPub`; with a wrong token returns 403 and exactly
  `pairing refused\n`; the HTTP handler still behaves identically (existing
  tests keep passing).
- [ ] **Step 3: Verify failures, implement, re-run.** `go test ./... -race -count=1` green.
- [ ] **Step 4: Commit.** `git commit -m "feat(relay): noise channels serve paired devices and bridge pairing"`

### Task 9: Wiring — relay config, serve integration, Welcome.relay, status

**Files:**
- Create: `internal/config/relay.go`
- Modify: `cmd/flue/main.go` (`cmdServe` starts the transport; `statusTo` reports it)
- Modify: `internal/daemon/server.go` (`SetRelayStatus`, relay-aware pairing URL)
- Modify: `internal/daemon/conn.go` (pairStart uses the relay origin when live)
- Modify: `internal/wire/control.go` (+ `web/src/client/protocol.ts`): `Welcome.relay`
- Test: `internal/config/relay_test.go`, `internal/daemon/server_test.go`, `internal/wire/wire_test.go`

**Interfaces (Produces):**

```go
// internal/config/relay.go
type Relay struct {
	URL    string `json:"url"`
	Secret string `json:"secret"`
	Origin string `json:"origin"`
}
// LoadRelay reads relay.json from the config dir; ok=false when absent.
func LoadRelay() (r Relay, ok bool, err error)
// SaveRelay writes relay.json 0600 with the CreateTemp+rename pattern used
// by the token (config/paths.go).
func SaveRelay(r Relay) error

// internal/daemon/server.go
// SetRelayStatus records the relay transport's state: status is one of
// "off", "connecting", "connected"; origin is the relay's https origin
// ("" unless connected). Broadcast-free; clients learn it on their next
// Welcome. It also decides pairing URLs (see below).
func (s *Server) SetRelayStatus(status, origin string)
```

```go
// internal/wire/control.go
type RelayInfo struct {
	Status string `json:"status"` // "off" | "connecting" | "connected"
	Origin string `json:"origin,omitempty"`
}
// Welcome gains: Relay *RelayInfo `json:"relay,omitempty"`
```

```ts
// web/src/client/protocol.ts — Welcome gains:
relay?: { status: 'off' | 'connecting' | 'connected'; origin?: string }
```

**Behavior:**

- `cmdServe`: after `daemon.New`, `if rc, ok, err := config.LoadRelay(); err == nil && ok` →
  build `relay.New(relay.Config{rc.URL, rc.Secret, rc.Origin}, srv, identity.Key, identity.Devices, logger)`
  and `go t.Run(ctx)`. A load error is a Warn, not fatal — the daemon serves
  locally regardless. The transport calls `srv.SetRelayStatus` on every state
  change ("connecting" on dial start, "connected"+origin on success, back to
  "connecting" on loss; `cmdServe` sets "off" initially by default of the zero
  state).
- `conn.handleControl` pairStart: the pairing URL's base becomes
  `s.pairingOrigin(c.origin)` — a new `Server` helper returning the relay
  origin when status is "connected", else the conn's own origin. (A QR that a
  phone can actually reach beats one naming 127.0.0.1 whenever a relay exists.)
- `serve`'s `Welcome` carries `Relay: s.relayInfo()` (nil when status "off").
- `statusTo` prints a `relay:` line: `not configured` / `configured (wss://…), status unknown from here` — the CLI reads config only; live status is the UI's job. Keep it to config presence.

**Steps:**

- [ ] **Step 1: Failing tests.** `relay_test.go`: save/load round-trip, 0600
  mode assertion, absent → `ok=false`. `server_test.go`: after
  `SetRelayStatus("connected", "https://r.example")`, a pairStart's `Pairing.URL`
  begins `https://r.example/pair?t=`; after `SetRelayStatus("off", "")` it
  reverts to the conn origin; `Welcome` unmarshals with the relay field when
  set. `wire_test.go`: `Welcome{Relay: …}` JSON round-trip + an entry in
  `testdata/wire/control.json` if that fixture drives the test (follow the
  existing pattern; update `spec/protocol.md`'s Welcome example).
- [ ] **Step 2: Verify failure, implement, re-run.** `go test ./... -count=1`;
  `cd web && pnpm lint` (the TS type change compiles).
- [ ] **Step 3: Commit.** `git commit -m "feat(flue): serve dials a configured relay and says so in welcome"`

### Task 10: The web RelaySocket — Noise initiator behind SocketLike

**Files:**
- Create: `web/src/relay/frame.ts`, `web/src/relay/socket.ts`
- Test: `web/src/relay/frame.test.ts`, `web/src/relay/socket.test.ts`

**Interfaces (Produces):**

```ts
// web/src/relay/frame.ts — kind-byte framing (matches internal/relaywire)
export function encodePlain(text: boolean, data: Uint8Array): Uint8Array
export function decodePlain(buf: Uint8Array): { text: boolean; data: Uint8Array }

// web/src/relay/socket.ts
export const RELAY_PING = 'flue-ping'
export const RELAY_PONG = 'flue-pong'

export interface RelayIdentity {
  deviceKey: DeviceKey            // from web/src/crypto/keys.ts
  daemonPub: Uint8Array           // the pinned daemon static key
}

/**
 * A SocketLike (web/src/client/client.ts) that reaches the daemon through
 * the relay: opens wss://<origin>/client, runs the Noise IK initiator
 * pinning daemonPub, then carries the wire protocol with kind-byte framing
 * inside the encrypted channel. onopen fires only after the handshake
 * completes, so FlueClient's view of "open" means "end-to-end established".
 */
/** The subset of WebSocket the relay socket drives; the default factory
 * wraps `new WebSocket(url)` with binaryType 'arraybuffer'. */
export interface RawSocket {
  send(data: string | ArrayBuffer | Uint8Array): void
  close(): void
  onopen: (() => void) | null
  onclose: (() => void) | null
  onmessage: ((data: string | ArrayBuffer) => void) | null
}

export function relaySocket(
  origin: string,
  identity: RelayIdentity,
  wsFactory?: (url: string) => RawSocket, // seam for tests
): SocketLike
```

(Read `web/src/crypto/noise.ts` first and use its `initiatorHandshake`
exactly as its own tests do — it mirrors the Go side's recv/send-callback
shape and returns a `NoiseChannel` with `seal`/`open`. The relay socket
drives it with callbacks bridged to WebSocket message events.)

**Behavior:**

- `send(data)`: before handshake completion, throw (FlueClient never sends
  before `onopen`; a throw here is a bug surfaced, not handled). After: string
  data → `encodePlain(true, utf8Bytes)`, ArrayBuffer → `encodePlain(false, bytes)`,
  then `channel.seal(...)`, then `ws.send(sealed)`.
- Incoming binary: `channel.open(...)` → `decodePlain` → text ? `onmessage(utf8String)` : `onmessage(arrayBuffer)`.
  A frame that fails to decrypt closes the socket (a relay or peer speaking
  garbage is a dead channel, and FlueClient's reconnect handles the rest).
- Incoming text `RELAY_PONG`: drop. Any other text: close (protocol error).
- Keepalive: every 30 s send `RELAY_PING` (a plain text frame — never
  encrypted, answered at the edge). Clear the interval on close.
- `close()`: closes the underlying ws, clears timers; `onclose` propagates.
- Handshake failure (bad pin, daemon rejected the key): surface as `onclose`
  after firing nothing else — to FlueClient it is an ordinary failed attempt;
  the UI-level "you are not paired" story is Task 11's.

**Steps:**

- [ ] **Step 1: Failing tests.**
  - `frame.test.ts`: fixture-driven against `testdata/relay/frames.json`
    (`plainFrames`) + error cases (empty, kind 2). Import the fixture with a
    relative path and `assert { type: 'json' }` or a `readFileSync` — match how
    `web/src/crypto/noise.test.ts` loads `testdata/noise/ik.json` today.
  - `socket.test.ts`: a scripted fake WebSocket plays the daemon side using the
    web `noise.ts` responder from the existing test utilities (`noise.test.ts`
    shows how both roles run in TS): handshake completes → `onopen` fired;
    a sealed `encodePlain(true, '{"type":"welcome",...}')` from the fake →
    `onmessage` delivers the JSON string; `send('{"type":"list"}')` → fake
    receives a sealed frame that opens to kind 0 + those bytes; binary both
    ways; `RELAY_PONG` text → no `onmessage`; garbage ciphertext → socket
    closed; wrong daemon key in the fake responder → `onclose` without
    `onopen`; ping timer fires (vitest fake timers) → fake received `RELAY_PING`.
- [ ] **Step 2: Verify failure, implement, re-run.** `cd web && pnpm test -- relay` green; `pnpm lint`.
- [ ] **Step 3: Commit.** `git commit -m "feat(web): relay socket — noise initiator behind the SocketLike seam"`

### Task 11: Web wiring — relay mode, identity, and the unpaired screen

**Files:**
- Create: `web/src/relay/mode.ts` (+ test)
- Modify: `web/src/main.tsx` (client construction picks the transport)
- Modify: `web/src/routes/pair.tsx` **only if** it does not already persist the
  device key + pinned daemon key on success (read it first; part 1 built the
  ceremony — extend, don't rewrite)
- Create: `web/src/routes/unpaired.tsx` — the explainer screen
- Test: `web/src/relay/mode.test.ts`, `web/src/routes/unpaired.test.tsx`, extend `web/src/router.test.tsx`

**Interfaces (Produces):**

```ts
// web/src/relay/mode.ts
/** True when this page was served by a relay rather than the daemon:
 * anything that is not a loopback host. (The daemon serves only 127.0.0.1
 * and localhost; a workers.dev or custom origin is the relay by
 * elimination.) */
export function isRelayOrigin(loc: { hostname: string } = location): boolean

/** The identity this browser holds for relay use, or null when it has
 * never paired (no pinned daemon key). */
export async function loadRelayIdentity(): Promise<RelayIdentity | null>
```

**Behavior:**

- `isRelayOrigin`: hostname not in `{'127.0.0.1', 'localhost', '[::1]'}`.
- `main.tsx`: today it builds `new FlueClient(daemonSocketUrl())` (read the
  actual construction site first). New shape: if `isRelayOrigin()`, `await`
  `loadRelayIdentity()` before mounting — null → render the router with a flag
  that routes `/` (and every shell route) to the unpaired screen; non-null →
  `new FlueClient(location.origin, (o) => relaySocket(o, identity))`. Local
  origins keep the exact current path. (Keep the async at the entry point —
  top-level await in `main.tsx` — rather than teaching FlueClient about
  promises.)
- The unpaired screen (`unpaired.tsx`): explains, in the app's plain-and-honest
  copy voice, that this browser holds no key for any daemon, and that the way
  in is: open flue on the machine that runs it → Devices → Pair device → scan
  the QR / open the link on *this* device. No sidebar chrome (same layout
  decision as `/pair`). If a pinned key exists but the daemon refuses the
  handshake, FlueClient stays in its ordinary `reconnecting` state — that is
  the existing status UI's job, not this screen's.
- `/pair` on success must leave behind: the device keypair (it already
  creates one to register) and the daemon's public key via
  `savePinnedDaemonKey` — verify against `web/src/crypto/keys.ts` usage in
  `pair.tsx` and add whichever half is missing.

**Steps:**

- [ ] **Step 1: Failing tests.** `mode.test.ts`: the three loopback hostnames →
  false, `flue-relay.example.workers.dev` → true. `unpaired.test.tsx`: renders
  heading `Not paired with a daemon yet`, no `navigation` landmark, no links
  beyond none. Router test: with the unpaired flag, `/` renders the unpaired
  screen (follow `router.test.tsx`'s `renderAt` harness patterns).
- [ ] **Step 2: Verify failure, implement, re-run.** `cd web && pnpm test`
  (only the pre-existing 55 fail) + `pnpm lint` + `pnpm build`.
- [ ] **Step 3: Commit.** `git commit -m "feat(web): relay mode — encrypted transport when served remotely, honest screen when unpaired"`

### Task 12: Pair gating — the QR promises only what it can deliver

**Files:**
- Modify: `web/src/client/client.ts` (surface `Welcome`), `web/src/routes/devices.tsx`
- Test: `web/src/client/client.test.ts`, `web/src/routes/devices.test.tsx`

**Interfaces (Produces):**

```ts
// client.ts additions
export interface RelayStatus { status: 'off' | 'connecting' | 'connected'; origin?: string }
onWelcome(cb: (w: Welcome) => void): () => void
/** The last welcome's relay info; undefined before the first welcome. */
get relay(): RelayStatus | undefined
```

**Behavior:**

- `client.ts`: the `'welcome'` case stores the message and emits; `relay`
  getter returns `welcome.relay ?? { status: 'off' }` once a welcome arrived.
- `devices.tsx`: the Pair affordance is driven by
  `client.relay` + `isRelayOrigin()`:
  - relay `connected`, or the page itself is on a relay origin → button as today.
  - relay not connected **and** the page is on loopback → button disabled, with
    inline copy: `Remote devices can't reach 127.0.0.1. Run flue relay setup to
    give this daemon an address, then pair.` (exact copy — tests pin it).
  - Re-evaluate on every welcome (reconnects can change it).

**Steps:**

- [ ] **Step 1: Failing tests.** `client.test.ts`: a welcome with
  `relay:{status:'connected',origin:'https://r.example'}` → `onWelcome` fires,
  `client.relay.origin === 'https://r.example'`; before any welcome →
  `undefined`. `devices.test.tsx`: with a welcome carrying `status:'off'` on a
  loopback location → the Pair button is disabled and the explainer copy is on
  screen; with `status:'connected'` → enabled (use the route tests' existing
  fake-client harness; jsdom's location is loopback already).
- [ ] **Step 2: Verify failure, implement, re-run, lint.**
- [ ] **Step 3: Commit.** `git commit -m "feat(web): gate pairing on an address other devices can reach"`

### Task 13: `internal/cloudflare` — the REST deploy client

**Files:**
- Create: `internal/cloudflare/client.go`, `internal/cloudflare/assets.go`
- Test: `internal/cloudflare/client_test.go` (recorded-fixture style: `httptest` + golden JSON)

**Interfaces (Produces):**

```go
package cloudflare

// Client talks to the Cloudflare v4 REST API with a user-supplied token.
// Base is overridable for tests; zero value means the real API.
type Client struct {
	HTTP  *http.Client
	Token string
	Base  string // default https://api.cloudflare.com/client/v4
}

type Account struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

func (c *Client) VerifyToken(ctx context.Context) error       // GET /user/tokens/verify
func (c *Client) Accounts(ctx context.Context) ([]Account, error) // GET /accounts

type Asset struct {
	Path string // e.g. "/index.html", "/assets/index-abc.js"
	Body []byte
}

type DeployInput struct {
	AccountID          string
	ScriptName         string // "flue-relay"
	Module             []byte // the built worker, ESM
	CompatibilityDate  string // "2026-08-01"
	NewSQLiteClasses   []string // ["DaemonHub"] — first deploy only; subsequent deploys omit migrations
	DOBindings         map[string]string // name -> class: {"HUB": "DaemonHub"}
	Assets             []Asset
	AssetsRunWorkerFirst []string // ["/daemon", "/client", "/api/*"]
}

// Deploy uploads assets (upload-session flow), then PUTs the script with its
// metadata (module, compat date, DO binding + migration, assets jwt + config).
func (c *Client) Deploy(ctx context.Context, in DeployInput) error

// SetSecret sets a secret on the script (PUT …/scripts/{name}/secrets).
func (c *Client) SetSecret(ctx context.Context, accountID, script, name, value string) error

// EnableSubdomain makes the script reachable on workers.dev and returns the
// full host, e.g. "flue-relay.<sub>.workers.dev". It reads the account's
// workers.dev subdomain (GET …/workers/subdomain) and enables the script's
// preview/subdomain flag (POST …/scripts/{name}/subdomain {"enabled":true}).
func (c *Client) EnableSubdomain(ctx context.Context, accountID, script string) (host string, err error)
```

**Implementation notes (verify against the live docs before coding — the
implementer should `WebFetch` https://developers.cloudflare.com/workers/static-assets/direct-upload/
and https://developers.cloudflare.com/api/resources/workers/ and follow what
they say if it differs from this sketch; the fixtures then encode whatever the
docs said):**

- Assets flow: `POST …/workers/scripts/{name}/assets-upload-session` with a
  manifest `{"manifest": {"/path": {"hash": <32-hex sha256-truncated>, "size": N}, …}}` →
  response carries a `jwt` and `buckets` (arrays of hashes to upload);
  `POST …/workers/assets/upload?base64=true` with the JWT as bearer and a
  form field per hash (base64 body) for each bucket → final completion `jwt`;
  when `buckets` is empty the session `jwt` is already the completion token.
- Script upload: `PUT …/workers/scripts/{name}` multipart: a `metadata` JSON
  part `{"main_module":"index.js","compatibility_date":…,"bindings":[{"type":"durable_object_namespace","name":"HUB","class_name":"DaemonHub"}],"migrations":{"new_sqlite_classes":["DaemonHub"]},"assets":{"jwt":…,"config":{"not_found_handling":"single-page-application","run_worker_first":[…]}}}`
  plus one part named `index.js` with content type `application/javascript+module`.
  Omit `migrations` when `NewSQLiteClasses` is empty. On a 10013-style
  "migration already applied" error from a re-deploy that did include
  migrations, retry once without them (idempotent re-run).
- Every response is the CF envelope `{"success":bool,"errors":[{"code":N,"message":…}],"result":…}` —
  parse it once in a helper; a non-success surfaces `errors[0]` code+message.
- Timeouts: the caller's ctx bounds everything; no internal retries beyond the
  migration case above.

**Steps:**

- [ ] **Step 1: Failing tests** against `httptest`: fixture handlers assert
  method, path, auth header, and (for Deploy) that the multipart metadata
  decodes to exactly the expected JSON (golden file
  `internal/cloudflare/testdata/deploy_metadata.json`) and the module part is
  byte-identical; the assets session receives the manifest with correct hashes;
  a scripted `buckets` response causes exactly those uploads; envelope errors
  surface as `cloudflare: <code> <message>`. Also: `VerifyToken` on a 401
  envelope returns an error naming the token as invalid; `EnableSubdomain`
  composes `<script>.<sub>.workers.dev` from the subdomain response.
- [ ] **Step 2: Verify failure, implement, re-run.** `go test ./internal/cloudflare/ -count=1`
- [ ] **Step 3: Commit.** `git commit -m "feat(cloudflare): REST client for worker deploys with static assets"`

### Task 14: `flue relay setup` — the guided self-host deploy

**Files:**
- Create: `cmd/flue/relay.go`, `relay/embed.go` (package `relaybundle`)
- Modify: `cmd/flue/main.go` (subcommand routing + usage text), `web/embed.go` (export the dist FS if not already exported — read it first)
- Modify: `relay/.gitignore` / build docs
- Test: `cmd/flue/relay_test.go` (fake CF server end-to-end), `relay/embed_test.go`

**Behavior (`flue relay setup`):**

```
$ flue relay setup
flue needs a Cloudflare API token to deploy your relay.
Create one at https://dash.cloudflare.com/profile/api-tokens with the
"Edit Cloudflare Workers" template, then paste it here.
Token: <read from stdin>
  ✓ token verified
  ✓ account: Karn's Account (abc123…)        (auto-picked when there is exactly one;
                                              numbered prompt otherwise)
  ✓ worker deployed: flue-relay
  ✓ web app uploaded (NN files)
  ✓ secret set
  ✓ reachable at https://flue-relay.<sub>.workers.dev
relay configured. restart the daemon (flue disable && flue enable, or
restart flue serve) to connect. you can delete the API token now — flue
does not store it.
```

- The daemon secret: 32 bytes from `crypto/rand`, base64url — generated fresh
  on every setup run, set as the Worker secret, saved to `relay.json`
  (`config.SaveRelay{URL: "wss://" + host + "/daemon", Secret: …, Origin: "https://" + host}`).
- The Worker module comes from `relaybundle.Module()` (`//go:embed dist/index.js`
  behind a build step: `relay/embed.go` with `//go:embed dist/index.js` and a
  clear failure — follow exactly how `web/embed.go`/`web/dev.go` handle the
  embedded-but-maybe-unbuilt dist, including whatever build tags they use; the
  repo's build flow gains "`cd relay && pnpm build` before `go build`" in the
  README's dev section).
- The web assets come from the embedded web dist: walk the exported web FS and
  turn every file into a `cloudflare.Asset` (paths rooted at `/`).
- The token is read via `bufio` from stdin (piping works in tests), never
  echoed back, never written anywhere. On any step failing, print the step's
  error and exit 1 — re-running is safe (Deploy and SetSecret are upserts;
  see Task 13's migration retry).
- `flue relay status`: prints `relay: not configured` or
  `relay: wss://… (origin https://…)`.
- Subcommand routing in `main.go`: `case "relay":` dispatches on
  `os.Args[2]` (`setup` | `status`), with usage text gaining the two lines.

**Steps:**

- [ ] **Step 1: Failing test.** `relay_test.go`: run the setup flow (factor
  `runRelaySetup(w io.Writer, r io.Reader, api *cloudflare.Client) error` so
  the test injects a fake CF `httptest` server + a stdin reader carrying the
  token) — asserts: the deploy request carried the embedded module + at least
  `index.html` from the web FS, the secret set on the API equals the secret in
  the saved `relay.json` (redirect the config dir via `t.Setenv` the way
  `internal/config` tests do — read them first), the printed transcript
  contains each ✓ line, and the token appears in no output and no file under
  the config dir. `embed_test.go`: `relaybundle.Module()` is non-empty and
  contains `DaemonHub` (guards a stale/empty dist).
- [ ] **Step 2: Verify failure, implement, re-run.** `go test ./cmd/... -count=1`
  (build `relay/dist` first: `cd relay && pnpm build`).
- [ ] **Step 3: Manual smoke note.** Add to `docs/RELAY.md` (created fully in
  Task 15; start the file here with just the heading + this checklist): the
  release-gate manual E2E — real `flue relay setup` against a real account,
  phone pairs via QR, types a command, kills the daemon, watches reconnect.
- [ ] **Step 4: Commit.** `git commit -m "feat(flue): relay setup deploys the worker and web app to your own account"`

### Task 15: Honesty and accounting — FAQ, bundle hash, cost counters, runbook

**Files:**
- Create: `docs/faq.md`
- Create: `web/scripts/bundle-hash.mjs` (+ `"hash": "node scripts/bundle-hash.mjs"` in `web/package.json`)
- Modify: `docs/RELAY.md` (complete it), `README.md` (link the FAQ)
- Modify: `relay/src/hub.ts` only if Task 5's counters missed a direction (verify)
- Test: `web/scripts/bundle-hash` gets a smoke assertion in `web/src/sw.build.test.ts`-style if trivial; otherwise the script's determinism is asserted by running it twice in Step 2

**Content requirements:**

- `docs/faq.md` — three entries, in flue's plain voice:
  - *Can flue (or Cloudflare) read my terminal?* No in transit — Noise IK from
    your browser to your daemon; the relay forwards ciphertext and holds no
    keys. Then the honest caveat, stated exactly: the web app's JavaScript is
    served by the relay origin, so you are trusting whoever operates that
    origin to serve the published, open-source code. E2E cannot remove that
    trust — nothing browser-served can. What we do about it: open source,
    reproducible bundle hash per release (`pnpm hash` against the published
    value), PWA install so updates are the only exposure window. A native app
    — signed, installed, not re-fetched — is the eventual fix and is on the
    roadmap.
  - *What does flue.sh store?* (forward-looking, one paragraph: metadata —
    account email, device names, public keys, last-seen; never terminal
    content, which it cannot read.)
  - *Can I run it without flue.sh?* Yes — `flue relay setup` against your own
    Cloudflare account; link `docs/RELAY.md`.
- `bundle-hash.mjs`: reads `web/dist`, sorts files by path, prints
  `sha256(<path>\0<bytes>\0…)` as one hex line plus a per-file listing —
  deterministic across machines for the same dist.
- `docs/RELAY.md`: the protocol one-pager (link `spec/relay-protocol.md`), the
  cost model with the researched numbers pinned (hibernation-eligible DOs bill
  no duration; 20:1 incoming-message request ratio; free-plan daily caps —
  100 K DO requests, 13 K GB-s; egress free; assets free), the
  fair-use/abuse note (channel cap 64, handshake deadline, output-rate cap as
  a follow-up), how to read the counters: `channel_closed` log lines carry
  frames/bytes per direction — visible in `wrangler tail` and the dashboard —
  and what a month of dogfooding should record before any pricing decision.
- README: a "Remote access" section pointing at RELAY.md + the FAQ.

**Steps:**

- [ ] **Step 1: Write everything above.**
- [ ] **Step 2: Verify.** `cd web && pnpm build && pnpm hash && pnpm hash` —
  identical output twice. `go test ./... && cd relay && pnpm test && cd ../web && pnpm test` — the full gate.
- [ ] **Step 3: Update `docs/FOLLOW-UPS.md`**: mark the §8 items this plan fixed
  (races, LastSeen, store errors, loopback QR) as done with commit refs; add
  new follow-ups discovered during the build (at minimum: per-session output
  rate caps, browser-leg auth for the SaaS, `relay/dist` in the release build,
  and CSP/security headers on relay-served assets via a `_headers` file — the
  daemon sets them per response; the Worker's asset serving currently does not).
- [ ] **Step 4: Commit.** `git commit -m "docs: relay runbook, honest FAQ, reproducible bundle hash"`

---

## Execution notes for the controller

- Tasks 1→2→3 are strictly sequential (each edits what the next consumes).
  4→5→6 (Worker) depends on 3 only. 7→8 depend on 1–3; 8 also touches
  `pairing.go`. 9 depends on 7–8. 10 depends on 3; 11 on 10; 12 on 9+11.
  13 is independent after 3; 14 depends on 4 (build output), 9 (config), 13.
  15 last. Run one implementer at a time regardless (SDD rule).
- The manual end-to-end against a real Cloudflare account is a release gate,
  not a task gate — documented in RELAY.md, run by a human.
- Cost gate verdict lives in RELAY.md; the invite-phase measurement plan is
  Plan 2's input.
