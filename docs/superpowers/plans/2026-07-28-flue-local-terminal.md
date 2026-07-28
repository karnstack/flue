# flue Local Terminal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A daily-drivable terminal in a browser tab — Go daemon on loopback owning PTYs and scrollback, TypeScript web app rendering them, sessions surviving tab close.

**Architecture:** The daemon holds each PTY plus a bounded scrollback ring keyed by a monotonic byte offset (`seq`). Browsers connect over WebSocket, `attach` with their `lastSeq`, and receive either a byte-exact delta or a full ring snapshot. Closing a tab detaches without killing the process. Multiple clients on one session mirror each other; exactly one is `primary` and owns the PTY dimensions. Rendering sits behind a narrow `Emulator` interface so xterm.js can later be swapped for `libghostty-vt`.

**Tech Stack:** Go 1.26 (`github.com/creack/pty`, `github.com/coder/websocket`); React 19 SPA with TanStack Router, Vite, Tailwind v4, shadcn/ui, Heroicons; `@xterm/xterm` with the WebGL and fit addons; Vitest with Testing Library; pnpm and mise.

## Global Constraints

- Module path is `github.com/karnstack/flue`. Go 1.26.
- **No adapter ever binds `0.0.0.0`.** This task builds only the loopback listener, which binds `127.0.0.1`.
- The daemon requires no runtime toolchain on the user's machine. Node and pnpm are build-time only.
- Binary protocol frame is exactly `[1 byte type][4 bytes ref big-endian][payload]`. Type `0x00` is output (daemon→client), `0x01` is input (client→daemon).
- WebSocket **text** frames carry JSON control messages; **binary** frames carry data. No custom framing layer.
- Scrollback ring default is 2 MiB, configurable.
- Exited sessions are retained for 10 minutes, then reaped.
- Loopback auth requires all three: valid token, Origin equal to the daemon's own origin, and `Host` header of `127.0.0.1:PORT` or `localhost:PORT`. No wildcard CORS under any condition.
- The token is exchanged for an `HttpOnly; SameSite=Strict` cookie on first load, stripped from the URL, and every response sets `Referrer-Policy: no-referrer`.
- Config lives under `$XDG_CONFIG_HOME/flue` (falling back to `~/.config/flue`), files mode `0600`.
- Use `pnpm`, never `npm` or `npx`. One-off tools run through `pnpm dlx`.
- Spec: `docs/superpowers/specs/2026-07-28-flue-design.md`.

**Design constraints** (from the `design` skill's guidelines; every UI task inherits these):

- Neutral is **zinc**. Never `gray-*` or `slate-*`.
- Accent is **amber**, used only for active nav state, focus rings, and the single primary button per screen. Never for body text — amber on dark fails contrast at body sizes.
- Both themes ship, driven by `prefers-color-scheme`. No manual toggle.
- `antialiased` on the root element; `isolate` on the app container.
- Body text is `text-base` on mobile, `sm:text-sm` and above. Never `text-xs` for body copy.
- Headings use `font-semibold` or `font-medium`, never `font-bold`, with `tracking-tight` above `text-xl` and no `leading-*` modifier.
- Nav states differ by color and background only — never by `font-weight`, and never a high-contrast fill for the active item.
- Icons are Heroicons Micro (16px, `size-4`) only, each with `shrink-0` inside a flex container.
- `min-w-0` on flex children that must shrink; `shrink-0` on those that must not.
- Dividers use opacity-based colors (`border-zinc-950/10 dark:border-white/10`), never solid neutrals.
- Reach for the lightest surface treatment that works: whitespace, then dividers, then cards. Tables sit on the page background with horizontal rules only.
- One primary button per screen. Application-UI buttons are `text-sm` with compact padding.
- `tabular-nums` on any value that changes over time.
- `role="list"` on every `<ul>` without a list-style class.
- No emojis in any UI copy.

---

### Task 1: Repo scaffolding and the scrollback ring

**Files:**
- Create: `mise.toml`
- Create: `go.mod`
- Create: `internal/session/ring.go`
- Test: `internal/session/ring_test.go`

**Interfaces:**
- Consumes: nothing.
- Produces: `session.NewRing(size int) *Ring`, `(*Ring).Write(p []byte)`, `(*Ring).BaseSeq() uint64`, `(*Ring).EndSeq() uint64`, `(*Ring).Since(seq uint64) (data []byte, ok bool)`. `Since` returns `ok=false` when `seq` is older than `BaseSeq()`, meaning the caller must send a full snapshot.

- [ ] **Step 1: Create the toolchain pin**

`mise.toml`:

```toml
[tools]
go = "1.26.1"
node = "24.18.0"
# pnpm via the npm backend: the default aqua backend has an asset-name
# mismatch (expects pnpm-macos-arm64; pnpm ships pnpm-darwin-arm64.tar.gz).
"npm:pnpm" = "11.9.0"
```

- [ ] **Step 2: Initialise the Go module**

```bash
go mod init github.com/karnstack/flue
```

- [ ] **Step 3: Write the failing test**

`internal/session/ring_test.go`:

```go
package session

import (
	"bytes"
	"testing"
)

func TestRingWriteAndSince(t *testing.T) {
	r := NewRing(16)
	r.Write([]byte("hello"))

	if got := r.BaseSeq(); got != 0 {
		t.Fatalf("BaseSeq = %d, want 0", got)
	}
	if got := r.EndSeq(); got != 5 {
		t.Fatalf("EndSeq = %d, want 5", got)
	}

	data, ok := r.Since(0)
	if !ok {
		t.Fatal("Since(0) ok = false, want true")
	}
	if !bytes.Equal(data, []byte("hello")) {
		t.Fatalf("Since(0) = %q, want %q", data, "hello")
	}

	data, ok = r.Since(2)
	if !ok || !bytes.Equal(data, []byte("llo")) {
		t.Fatalf("Since(2) = %q, %v; want %q, true", data, ok, "llo")
	}

	data, ok = r.Since(5)
	if !ok || len(data) != 0 {
		t.Fatalf("Since(5) = %q, %v; want empty, true", data, ok)
	}
}

func TestRingEvictionAdvancesBaseSeq(t *testing.T) {
	r := NewRing(8)
	r.Write([]byte("abcdefgh"))
	r.Write([]byte("ijkl"))

	if got := r.BaseSeq(); got != 4 {
		t.Fatalf("BaseSeq = %d, want 4", got)
	}
	if got := r.EndSeq(); got != 12 {
		t.Fatalf("EndSeq = %d, want 12", got)
	}

	data, ok := r.Since(4)
	if !ok || !bytes.Equal(data, []byte("efghijkl")) {
		t.Fatalf("Since(4) = %q, %v; want %q, true", data, ok, "efghijkl")
	}

	if _, ok := r.Since(3); ok {
		t.Fatal("Since(3) ok = true, want false (evicted)")
	}
}

func TestRingWriteLargerThanCapacity(t *testing.T) {
	r := NewRing(4)
	r.Write([]byte("abcdefghij"))

	if got := r.BaseSeq(); got != 6 {
		t.Fatalf("BaseSeq = %d, want 6", got)
	}
	data, ok := r.Since(6)
	if !ok || !bytes.Equal(data, []byte("ghij")) {
		t.Fatalf("Since(6) = %q, %v; want %q, true", data, ok, "ghij")
	}
}

func TestRingWrapPreservesOrder(t *testing.T) {
	r := NewRing(6)
	for _, s := range []string{"ab", "cd", "ef", "gh"} {
		r.Write([]byte(s))
	}
	data, ok := r.Since(r.BaseSeq())
	if !ok || !bytes.Equal(data, []byte("cdefgh")) {
		t.Fatalf("Since(base) = %q, %v; want %q, true", data, ok, "cdefgh")
	}
}
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `go test ./internal/session/ -run TestRing -v`
Expected: FAIL — `undefined: NewRing`.

- [ ] **Step 5: Implement the ring**

`internal/session/ring.go`:

```go
package session

// Ring is a fixed-capacity byte buffer that tracks a monotonic sequence
// number for every byte ever written. Bytes are addressed by absolute seq,
// so a reattaching client can ask for everything since the offset it last
// saw. Once the buffer is full, the oldest bytes are evicted and BaseSeq
// advances past them.
//
// Ring is not safe for concurrent use; Session serialises access.
type Ring struct {
	buf []byte
	w   int    // next write index
	n   int    // bytes currently stored, <= len(buf)
	end uint64 // seq just past the most recently written byte
}

// NewRing returns a Ring holding at most size bytes.
func NewRing(size int) *Ring {
	if size < 1 {
		size = 1
	}
	return &Ring{buf: make([]byte, size)}
}

// Write appends p, evicting the oldest bytes if necessary.
func (r *Ring) Write(p []byte) {
	r.end += uint64(len(p))

	// A write larger than capacity keeps only the tail.
	if len(p) >= len(r.buf) {
		copy(r.buf, p[len(p)-len(r.buf):])
		r.w = 0
		r.n = len(r.buf)
		return
	}

	first := copy(r.buf[r.w:], p)
	if first < len(p) {
		copy(r.buf, p[first:])
	}
	r.w = (r.w + len(p)) % len(r.buf)
	if r.n += len(p); r.n > len(r.buf) {
		r.n = len(r.buf)
	}
}

// BaseSeq is the seq of the oldest byte still retained.
func (r *Ring) BaseSeq() uint64 { return r.end - uint64(r.n) }

// EndSeq is the seq just past the newest byte written.
func (r *Ring) EndSeq() uint64 { return r.end }

// Since returns every retained byte at or after seq. ok is false when seq
// has already been evicted, which means the caller must send a full
// snapshot instead of a delta. A seq beyond EndSeq yields an empty slice
// and ok=true; that is a client that is simply up to date.
func (r *Ring) Since(seq uint64) ([]byte, bool) {
	if seq < r.BaseSeq() {
		return nil, false
	}
	if seq >= r.end {
		return []byte{}, true
	}
	count := int(r.end - seq)
	out := make([]byte, count)
	start := (r.w - count + len(r.buf)) % len(r.buf)
	first := copy(out, r.buf[start:])
	if first < count {
		copy(out[first:], r.buf)
	}
	return out, true
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `go test ./internal/session/ -run TestRing -v`
Expected: PASS, all four tests.

- [ ] **Step 7: Commit**

```bash
git add mise.toml go.mod internal/session/ring.go internal/session/ring_test.go
git commit -m "feat(session): add seq-addressed scrollback ring"
```

---

### Task 2: OSC title scanner

**Files:**
- Create: `internal/session/title.go`
- Test: `internal/session/title_test.go`

**Interfaces:**
- Consumes: nothing.
- Produces: `session.NewTitleScanner() *TitleScanner` and `(*TitleScanner).Feed(p []byte) (title string, ok bool)`. `Feed` is a streaming scanner: it may be called with arbitrary chunk boundaries, and returns the most recent complete title found in this chunk, if any.

This is the server-side VT seam. Today it recognises only OSC 0 and OSC 2; later `libghostty-vt` replaces it wholesale.

> **The reference implementation below is buggy — see commit `0afcf3f` for the corrected version.** Task review caught two defects in it during execution. First, the ignore path (`stIgnore`/`stIgnoreEsc`) had no bound analogous to `maxTitleLen`, so a single unterminated non-title OSC sequence — a truncated OSC 8 hyperlink, say — wedged the scanner permanently, and it then consumed the terminator of the *next* legitimate title as well. Second, the abandon transitions consumed the byte that triggered them, so an `ESC` arriving mid-sequence was swallowed instead of starting a fresh one. The fix bounds the ignore path and re-dispatches the triggering byte after resetting to ground. The prose requirement above governs: the scanner must always return to a state where a subsequent well-formed sequence still parses.

- [ ] **Step 1: Write the failing test**

`internal/session/title_test.go`:

```go
package session

import "testing"

func TestTitleScannerBEL(t *testing.T) {
	s := NewTitleScanner()
	title, ok := s.Feed([]byte("\x1b]0;my title\x07rest"))
	if !ok || title != "my title" {
		t.Fatalf("Feed = %q, %v; want %q, true", title, ok, "my title")
	}
}

func TestTitleScannerST(t *testing.T) {
	s := NewTitleScanner()
	title, ok := s.Feed([]byte("\x1b]2;other\x1b\\"))
	if !ok || title != "other" {
		t.Fatalf("Feed = %q, %v; want %q, true", title, ok, "other")
	}
}

func TestTitleScannerSplitAcrossChunks(t *testing.T) {
	s := NewTitleScanner()
	if _, ok := s.Feed([]byte("\x1b]0;split ")); ok {
		t.Fatal("Feed returned a title before the terminator")
	}
	title, ok := s.Feed([]byte("title\x07"))
	if !ok || title != "split title" {
		t.Fatalf("Feed = %q, %v; want %q, true", title, ok, "split title")
	}
}

func TestTitleScannerIgnoresOtherOSC(t *testing.T) {
	s := NewTitleScanner()
	if title, ok := s.Feed([]byte("\x1b]8;;https://example.com\x07")); ok {
		t.Fatalf("Feed = %q, true; want ok=false for OSC 8", title)
	}
}

func TestTitleScannerLastWins(t *testing.T) {
	s := NewTitleScanner()
	title, ok := s.Feed([]byte("\x1b]0;first\x07\x1b]0;second\x07"))
	if !ok || title != "second" {
		t.Fatalf("Feed = %q, %v; want %q, true", title, ok, "second")
	}
}

func TestTitleScannerBoundsRunawaySequence(t *testing.T) {
	s := NewTitleScanner()
	long := make([]byte, 0, maxTitleLen+64)
	long = append(long, "\x1b]0;"...)
	for i := 0; i < maxTitleLen+32; i++ {
		long = append(long, 'x')
	}
	if _, ok := s.Feed(long); ok {
		t.Fatal("Feed accepted an unterminated oversized title")
	}
	// The scanner must have abandoned the sequence, so a well-formed one
	// that follows still parses.
	title, ok := s.Feed([]byte("\x1b]0;ok\x07"))
	if !ok || title != "ok" {
		t.Fatalf("Feed = %q, %v; want %q, true", title, ok, "ok")
	}
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `go test ./internal/session/ -run TestTitle -v`
Expected: FAIL — `undefined: NewTitleScanner`.

- [ ] **Step 3: Implement the scanner**

`internal/session/title.go`:

```go
package session

import "strings"

// maxTitleLen bounds an in-progress OSC payload so a malformed stream
// cannot grow the scanner without limit.
const maxTitleLen = 1024

type titleState int

const (
	stGround titleState = iota
	stEsc               // saw ESC
	stOSC               // saw ESC ], reading the numeric parameter
	stTitle             // reading the title payload
	stTitleEsc          // inside the payload, saw ESC (candidate ST)
	stIgnore            // inside an OSC we do not care about
	stIgnoreEsc
)

// TitleScanner extracts window titles from OSC 0 and OSC 2 sequences in a
// byte stream. It tolerates arbitrary chunk boundaries.
type TitleScanner struct {
	state titleState
	param []byte
	buf   strings.Builder
}

func NewTitleScanner() *TitleScanner { return &TitleScanner{} }

// Feed consumes p and reports the last complete title it contained.
func (s *TitleScanner) Feed(p []byte) (string, bool) {
	var last string
	var found bool

	for _, c := range p {
		switch s.state {
		case stGround:
			if c == 0x1b {
				s.state = stEsc
			}

		case stEsc:
			if c == ']' {
				s.state = stOSC
				s.param = s.param[:0]
			} else if c == 0x1b {
				// stay in stEsc
			} else {
				s.state = stGround
			}

		case stOSC:
			switch {
			case c == ';':
				p := string(s.param)
				if p == "0" || p == "2" {
					s.state = stTitle
					s.buf.Reset()
				} else {
					s.state = stIgnore
				}
			case c >= '0' && c <= '9':
				if len(s.param) < 8 {
					s.param = append(s.param, c)
				} else {
					s.state = stIgnore
				}
			default:
				s.state = stGround
			}

		case stTitle:
			switch {
			case c == 0x07: // BEL terminator
				last, found = s.buf.String(), true
				s.buf.Reset()
				s.state = stGround
			case c == 0x1b:
				s.state = stTitleEsc
			case s.buf.Len() >= maxTitleLen:
				s.buf.Reset()
				s.state = stGround
			default:
				s.buf.WriteByte(c)
			}

		case stTitleEsc:
			if c == '\\' { // ST terminator
				last, found = s.buf.String(), true
				s.buf.Reset()
				s.state = stGround
			} else {
				// Not a terminator: abandon this sequence rather than
				// silently absorbing an escape we do not model.
				s.buf.Reset()
				s.state = stGround
			}

		case stIgnore:
			switch c {
			case 0x07:
				s.state = stGround
			case 0x1b:
				s.state = stIgnoreEsc
			}

		case stIgnoreEsc:
			if c == '\\' {
				s.state = stGround
			} else {
				s.state = stIgnore
			}
		}
	}

	return last, found
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `go test ./internal/session/ -run TestTitle -v`
Expected: PASS, all six tests.

- [ ] **Step 5: Commit**

```bash
git add internal/session/title.go internal/session/title_test.go
git commit -m "feat(session): add streaming OSC 0/2 title scanner"
```

---

### Task 3: Session and Registry

**Files:**
- Create: `internal/session/session.go`
- Create: `internal/session/registry.go`
- Test: `internal/session/session_test.go`
- Modify: `go.mod` (adds `github.com/creack/pty`)

**Interfaces:**
- Consumes: `NewRing`, `NewTitleScanner` from Tasks 1–2.
- Produces:
  - `session.SpawnOpts{Cwd string; Cmd []string; Cols, Rows uint16; RingSize int}`
  - `session.NewRegistry(clock func() time.Time) *Registry`
  - `(*Registry).Spawn(opts SpawnOpts) (*Session, error)`
  - `(*Registry).List() []*Session`, `(*Registry).Get(id string) (*Session, bool)`
  - `(*Registry).Reap()` — removes sessions that exited more than `ExitedRetention` ago
  - `(*Session).ID() string`, `.Info() Info`, `.Write(p []byte) error`, `.Resize(cols, rows uint16) error`, `.Signal(sig os.Signal) error`, `.Close() error`
  - `(*Session).Subscribe(fromSeq uint64) *Sub` and `(*Session).Unsubscribe(*Sub)`
  - `session.Sub{Backlog []byte; StartSeq uint64; Truncated bool; C <-chan []byte; Done <-chan struct{}}`
  - `session.Info{ID, Title, Cwd string; Cmd []string; State string; ExitCode int; Cols, Rows uint16; LastActive time.Time}`
  - `session.ExitedRetention = 10 * time.Minute`

`Subscribe` is atomic: the returned `Backlog` plus everything subsequently delivered on `C` is exactly the byte stream from `StartSeq` onward, with no gap and no duplication. A subscriber that cannot keep up has its channel closed and is dropped, which surfaces to the client as a disconnect; it then reattaches with its `lastSeq`.

- [ ] **Step 1: Add the PTY dependency**

```bash
go get github.com/creack/pty@latest
```

- [ ] **Step 2: Write the failing test**

`internal/session/session_test.go`:

```go
package session

import (
	"bytes"
	"strings"
	"testing"
	"time"
)

func waitFor(t *testing.T, sub *Sub, want string, timeout time.Duration) []byte {
	t.Helper()
	var acc []byte
	acc = append(acc, sub.Backlog...)
	deadline := time.After(timeout)
	for !bytes.Contains(acc, []byte(want)) {
		select {
		case b, ok := <-sub.C:
			if !ok {
				t.Fatalf("subscriber closed while waiting for %q; got %q", want, acc)
			}
			acc = append(acc, b...)
		case <-deadline:
			t.Fatalf("timed out waiting for %q; got %q", want, acc)
		}
	}
	return acc
}

func TestSpawnProducesOutput(t *testing.T) {
	r := NewRegistry(time.Now)
	s, err := r.Spawn(SpawnOpts{Cmd: []string{"sh", "-c", "echo hello-flue"}, Cols: 80, Rows: 24})
	if err != nil {
		t.Fatalf("Spawn: %v", err)
	}
	defer s.Close()

	sub := s.Subscribe(0)
	defer s.Unsubscribe(sub)
	waitFor(t, sub, "hello-flue", 5*time.Second)
}

func TestResizePropagatesToPTY(t *testing.T) {
	r := NewRegistry(time.Now)
	s, err := r.Spawn(SpawnOpts{
		Cmd:  []string{"sh", "-c", "sleep 0.3; stty size"},
		Cols: 80, Rows: 24,
	})
	if err != nil {
		t.Fatalf("Spawn: %v", err)
	}
	defer s.Close()

	sub := s.Subscribe(0)
	defer s.Unsubscribe(sub)

	if err := s.Resize(100, 40); err != nil {
		t.Fatalf("Resize: %v", err)
	}
	got := waitFor(t, sub, "40 100", 5*time.Second)
	if !strings.Contains(string(got), "40 100") {
		t.Fatalf("stty size output = %q, want it to contain %q", got, "40 100")
	}
}

func TestWriteReachesPTY(t *testing.T) {
	r := NewRegistry(time.Now)
	s, err := r.Spawn(SpawnOpts{Cmd: []string{"cat"}, Cols: 80, Rows: 24})
	if err != nil {
		t.Fatalf("Spawn: %v", err)
	}
	defer s.Close()

	sub := s.Subscribe(0)
	defer s.Unsubscribe(sub)

	if err := s.Write([]byte("ping\n")); err != nil {
		t.Fatalf("Write: %v", err)
	}
	waitFor(t, sub, "ping", 5*time.Second)
}

func TestTwoSubscribersBothReceive(t *testing.T) {
	r := NewRegistry(time.Now)
	s, err := r.Spawn(SpawnOpts{Cmd: []string{"cat"}, Cols: 80, Rows: 24})
	if err != nil {
		t.Fatalf("Spawn: %v", err)
	}
	defer s.Close()

	a := s.Subscribe(0)
	defer s.Unsubscribe(a)
	b := s.Subscribe(0)
	defer s.Unsubscribe(b)

	if err := s.Write([]byte("both\n")); err != nil {
		t.Fatalf("Write: %v", err)
	}
	waitFor(t, a, "both", 5*time.Second)
	waitFor(t, b, "both", 5*time.Second)
}

func TestSubscribeTruncatedWhenSeqEvicted(t *testing.T) {
	r := NewRegistry(time.Now)
	s, err := r.Spawn(SpawnOpts{
		Cmd:      []string{"sh", "-c", "printf 'a%.0s' $(seq 1 4096)"},
		Cols:     80,
		Rows:     24,
		RingSize: 64,
	})
	if err != nil {
		t.Fatalf("Spawn: %v", err)
	}
	defer s.Close()

	sub := s.Subscribe(0)
	waitFor(t, sub, "aaaa", 5*time.Second)
	s.Unsubscribe(sub)

	// Wait for the process to finish so the ring has definitely wrapped.
	deadline := time.After(5 * time.Second)
	for s.Info().State != "exited" {
		select {
		case <-deadline:
			t.Fatal("process did not exit")
		case <-time.After(10 * time.Millisecond):
		}
	}

	late := s.Subscribe(0)
	defer s.Unsubscribe(late)
	if !late.Truncated {
		t.Fatal("Truncated = false, want true after eviction")
	}
	if late.StartSeq == 0 {
		t.Fatal("StartSeq = 0, want the ring's advanced base")
	}
}

func TestExitedSessionsReapedAfterRetention(t *testing.T) {
	now := time.Now()
	clock := func() time.Time { return now }
	r := NewRegistry(clock)

	s, err := r.Spawn(SpawnOpts{Cmd: []string{"sh", "-c", "exit 3"}, Cols: 80, Rows: 24})
	if err != nil {
		t.Fatalf("Spawn: %v", err)
	}

	deadline := time.After(5 * time.Second)
	for s.Info().State != "exited" {
		select {
		case <-deadline:
			t.Fatal("process did not exit")
		case <-time.After(10 * time.Millisecond):
		}
	}
	if got := s.Info().ExitCode; got != 3 {
		t.Fatalf("ExitCode = %d, want 3", got)
	}

	r.Reap()
	if _, ok := r.Get(s.ID()); !ok {
		t.Fatal("session reaped before the retention window elapsed")
	}

	now = now.Add(ExitedRetention + time.Second)
	r.Reap()
	if _, ok := r.Get(s.ID()); ok {
		t.Fatal("session still present after the retention window")
	}
}

func TestTitleFromOSC(t *testing.T) {
	r := NewRegistry(time.Now)
	s, err := r.Spawn(SpawnOpts{
		Cmd:  []string{"sh", "-c", "printf '\\033]0;flue-title\\007'; sleep 0.2"},
		Cols: 80, Rows: 24,
	})
	if err != nil {
		t.Fatalf("Spawn: %v", err)
	}
	defer s.Close()

	deadline := time.After(5 * time.Second)
	for s.Info().Title != "flue-title" {
		select {
		case <-deadline:
			t.Fatalf("Title = %q, want %q", s.Info().Title, "flue-title")
		case <-time.After(10 * time.Millisecond):
		}
	}
}
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `go test ./internal/session/ -run 'TestSpawn|TestResize|TestWrite|TestTwo|TestSubscribe|TestExited|TestTitleFrom' -v`
Expected: FAIL — `undefined: NewRegistry`.

- [ ] **Step 4: Implement Session**

`internal/session/session.go`:

```go
package session

import (
	"errors"
	"os"
	"os/exec"
	"sync"
	"time"

	"github.com/creack/pty"
)

// ExitedRetention is how long an exited session stays listable so its final
// output remains readable before the registry reaps it.
const ExitedRetention = 10 * time.Minute

// DefaultRingSize is the default scrollback capacity per session.
const DefaultRingSize = 2 << 20 // 2 MiB

// subChanDepth bounds how far a subscriber may fall behind before it is
// dropped. A dropped subscriber reconnects and reattaches with its lastSeq,
// so no output is lost — it is re-fetched from the ring.
const subChanDepth = 256

var ErrSessionClosed = errors.New("session closed")

// SpawnOpts configures a new session.
type SpawnOpts struct {
	Cwd      string
	Cmd      []string // empty means the user's login shell
	Cols     uint16
	Rows     uint16
	RingSize int // zero means DefaultRingSize
}

// Info is a snapshot of session state safe to serialise.
type Info struct {
	ID         string    `json:"id"`
	Title      string    `json:"title"`
	Cwd        string    `json:"cwd"`
	Cmd        []string  `json:"cmd"`
	State      string    `json:"state"` // "running" | "exited"
	ExitCode   int       `json:"exitCode"`
	Cols       uint16    `json:"cols"`
	Rows       uint16    `json:"rows"`
	LastActive time.Time `json:"lastActive"`
}

// Sub is one subscriber's view of a session's output stream. Backlog plus
// everything delivered on C is exactly the byte stream from StartSeq
// onward. Truncated reports that the requested seq had already been
// evicted, so StartSeq is later than what was asked for and the client must
// reset its emulator before writing Backlog.
type Sub struct {
	Backlog   []byte
	StartSeq  uint64
	Truncated bool
	C         <-chan []byte

	ch     chan []byte
	closed bool
}

// Session owns one PTY and its scrollback.
type Session struct {
	id    string
	pty   *os.File
	cmd   *exec.Cmd
	clock func() time.Time

	mu         sync.Mutex
	ring       *Ring
	title      *TitleScanner
	subs       map[*Sub]struct{}
	info       Info
	exitedAt   time.Time
	closed     bool
	exitedOnce sync.Once
}

func (s *Session) ID() string { return s.id }

// Info returns a snapshot of the session's state.
func (s *Session) Info() Info {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.info
}

// Write sends bytes to the PTY.
func (s *Session) Write(p []byte) error {
	s.mu.Lock()
	closed := s.closed
	s.info.LastActive = s.clock()
	s.mu.Unlock()
	if closed {
		return ErrSessionClosed
	}
	_, err := s.pty.Write(p)
	return err
}

// Resize changes the PTY window size.
func (s *Session) Resize(cols, rows uint16) error {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return ErrSessionClosed
	}
	s.info.Cols, s.info.Rows = cols, rows
	s.mu.Unlock()
	return pty.Setsize(s.pty, &pty.Winsize{Cols: cols, Rows: rows})
}

// Signal delivers a signal to the process group.
func (s *Session) Signal(sig os.Signal) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed || s.cmd.Process == nil {
		return ErrSessionClosed
	}
	return s.cmd.Process.Signal(sig)
}

// Subscribe registers a subscriber for output at or after fromSeq. The
// backlog and the channel together are gap-free.
func (s *Session) Subscribe(fromSeq uint64) *Sub {
	s.mu.Lock()
	defer s.mu.Unlock()

	start := fromSeq
	truncated := false
	data, ok := s.ring.Since(fromSeq)
	if !ok {
		truncated = true
		start = s.ring.BaseSeq()
		data, _ = s.ring.Since(start)
	}

	ch := make(chan []byte, subChanDepth)
	sub := &Sub{
		Backlog:   data,
		StartSeq:  start,
		Truncated: truncated,
		C:         ch,
		ch:        ch,
	}
	s.subs[sub] = struct{}{}
	return sub
}

// Unsubscribe removes a subscriber and closes its channel.
func (s *Session) Unsubscribe(sub *Sub) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.dropLocked(sub)
}

func (s *Session) dropLocked(sub *Sub) {
	if _, ok := s.subs[sub]; !ok {
		return
	}
	delete(s.subs, sub)
	if !sub.closed {
		sub.closed = true
		close(sub.ch)
	}
}

// Close terminates the process and releases the PTY.
func (s *Session) Close() error {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return nil
	}
	s.closed = true
	for sub := range s.subs {
		s.dropLocked(sub)
	}
	s.mu.Unlock()

	if s.cmd.Process != nil {
		_ = s.cmd.Process.Kill()
	}
	return s.pty.Close()
}

// pump copies PTY output into the ring and fans it out to subscribers.
func (s *Session) pump() {
	buf := make([]byte, 32*1024)
	for {
		n, err := s.pty.Read(buf)
		if n > 0 {
			chunk := make([]byte, n)
			copy(chunk, buf[:n])

			s.mu.Lock()
			s.ring.Write(chunk)
			if title, ok := s.title.Feed(chunk); ok {
				s.info.Title = title
			}
			s.info.LastActive = s.clock()
			for sub := range s.subs {
				select {
				case sub.ch <- chunk:
				default:
					// Subscriber is too far behind. Drop it; it will
					// reattach with its lastSeq and re-read the ring.
					s.dropLocked(sub)
				}
			}
			s.mu.Unlock()
		}
		if err != nil {
			s.markExited()
			return
		}
	}
}

func (s *Session) markExited() {
	s.exitedOnce.Do(func() {
		code := 0
		if err := s.cmd.Wait(); err != nil {
			var ee *exec.ExitError
			if errors.As(err, &ee) {
				code = ee.ExitCode()
			} else {
				code = -1
			}
		}
		s.mu.Lock()
		s.info.State = "exited"
		s.info.ExitCode = code
		s.exitedAt = s.clock()
		for sub := range s.subs {
			s.dropLocked(sub)
		}
		s.mu.Unlock()
	})
}
```

- [ ] **Step 5: Implement Registry**

`internal/session/registry.go`:

```go
package session

import (
	"crypto/rand"
	"encoding/hex"
	"os"
	"os/exec"
	"os/user"
	"sync"
	"time"

	"github.com/creack/pty"
)

// Registry owns every session on this daemon.
type Registry struct {
	clock func() time.Time

	mu       sync.Mutex
	sessions map[string]*Session
}

func NewRegistry(clock func() time.Time) *Registry {
	if clock == nil {
		clock = time.Now
	}
	return &Registry{clock: clock, sessions: map[string]*Session{}}
}

// loginShell returns the user's shell, preferring $SHELL and falling back to
// the passwd entry, then to /bin/sh.
func loginShell() string {
	if sh := os.Getenv("SHELL"); sh != "" {
		return sh
	}
	if u, err := user.Current(); err == nil {
		if u.HomeDir != "" {
			if _, err := os.Stat("/bin/zsh"); err == nil {
				return "/bin/zsh"
			}
		}
	}
	return "/bin/sh"
}

func newID() string {
	var b [8]byte
	_, _ = rand.Read(b[:])
	return hex.EncodeToString(b[:])
}

// Spawn starts a new session. An empty Cmd runs the user's login shell as a
// login shell, inheriting the environment: flue is a terminal, and a
// sanitised environment would defeat the purpose.
func (r *Registry) Spawn(opts SpawnOpts) (*Session, error) {
	argv := opts.Cmd
	if len(argv) == 0 {
		argv = []string{loginShell(), "-l"}
	}

	cmd := exec.Command(argv[0], argv[1:]...)
	cmd.Dir = opts.Cwd
	cmd.Env = append(os.Environ(), "TERM=xterm-256color")

	cols, rows := opts.Cols, opts.Rows
	if cols == 0 {
		cols = 80
	}
	if rows == 0 {
		rows = 24
	}

	f, err := pty.StartWithSize(cmd, &pty.Winsize{Cols: cols, Rows: rows})
	if err != nil {
		return nil, err
	}

	size := opts.RingSize
	if size == 0 {
		size = DefaultRingSize
	}

	cwd := opts.Cwd
	if cwd == "" {
		cwd, _ = os.Getwd()
	}

	s := &Session{
		id:    newID(),
		pty:   f,
		cmd:   cmd,
		clock: r.clock,
		ring:  NewRing(size),
		title: NewTitleScanner(),
		subs:  map[*Sub]struct{}{},
		info: Info{
			Cwd:        cwd,
			Cmd:        argv,
			State:      "running",
			Cols:       cols,
			Rows:       rows,
			LastActive: r.clock(),
		},
	}
	s.info.ID = s.id
	go s.pump()

	r.mu.Lock()
	r.sessions[s.id] = s
	r.mu.Unlock()
	return s, nil
}

func (r *Registry) Get(id string) (*Session, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	s, ok := r.sessions[id]
	return s, ok
}

func (r *Registry) List() []*Session {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]*Session, 0, len(r.sessions))
	for _, s := range r.sessions {
		out = append(out, s)
	}
	return out
}

// Reap removes sessions that exited more than ExitedRetention ago.
func (r *Registry) Reap() {
	now := r.clock()
	r.mu.Lock()
	defer r.mu.Unlock()
	for id, s := range r.sessions {
		s.mu.Lock()
		exited := s.info.State == "exited"
		at := s.exitedAt
		s.mu.Unlock()
		if exited && now.Sub(at) >= ExitedRetention {
			_ = s.Close()
			delete(r.sessions, id)
		}
	}
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `go test ./internal/session/ -v`
Expected: PASS. If `TestResizePropagatesToPTY` is flaky, the `sleep 0.3` gives `Resize` time to land before `stty` reads the size — do not shorten it.

- [ ] **Step 7: Commit**

```bash
git add go.mod go.sum internal/session/session.go internal/session/registry.go internal/session/session_test.go
git commit -m "feat(session): add PTY session and registry with detachable subscribers"
```

---

### Task 4: Protocol codec and golden files

**Files:**
- Create: `internal/wire/binary.go`
- Create: `internal/wire/control.go`
- Create: `spec/protocol.md`
- Create: `testdata/wire/control.json`
- Test: `internal/wire/wire_test.go`

**Interfaces:**
- Consumes: `session.Info` from Task 3.
- Produces:
  - `wire.FrameOutput byte = 0x00`, `wire.FrameInput byte = 0x01`
  - `wire.EncodeBinary(typ byte, ref uint32, payload []byte) []byte`
  - `wire.DecodeBinary(b []byte) (typ byte, ref uint32, payload []byte, err error)`
  - Client message structs: `Hello`, `List`, `Spawn`, `Attach`, `Detach`, `Resize`, `Signal`, `CloseSession`
  - Server message structs: `Welcome`, `Sessions`, `Attached`, `Exit`, `SizeChanged`, `Error`
  - `wire.DecodeControl(b []byte) (any, error)` and `wire.EncodeControl(msg any) ([]byte, error)`

- [ ] **Step 1: Write the failing test**

`internal/wire/wire_test.go`:

```go
package wire

import (
	"bytes"
	"encoding/json"
	"os"
	"testing"
)

func TestBinaryRoundTrip(t *testing.T) {
	enc := EncodeBinary(FrameOutput, 7, []byte("payload"))
	if len(enc) != 5+len("payload") {
		t.Fatalf("len = %d, want %d", len(enc), 5+len("payload"))
	}
	if enc[0] != FrameOutput {
		t.Fatalf("type byte = %#x, want %#x", enc[0], FrameOutput)
	}

	typ, ref, payload, err := DecodeBinary(enc)
	if err != nil {
		t.Fatalf("DecodeBinary: %v", err)
	}
	if typ != FrameOutput || ref != 7 || !bytes.Equal(payload, []byte("payload")) {
		t.Fatalf("got (%#x, %d, %q), want (%#x, 7, %q)", typ, ref, payload, FrameOutput, "payload")
	}
}

func TestBinaryRefIsBigEndian(t *testing.T) {
	enc := EncodeBinary(FrameInput, 0x01020304, nil)
	want := []byte{FrameInput, 0x01, 0x02, 0x03, 0x04}
	if !bytes.Equal(enc, want) {
		t.Fatalf("enc = % x, want % x", enc, want)
	}
}

func TestDecodeBinaryRejectsShortFrame(t *testing.T) {
	for _, b := range [][]byte{nil, {}, {0x00}, {0x00, 1, 2, 3}} {
		if _, _, _, err := DecodeBinary(b); err == nil {
			t.Fatalf("DecodeBinary(% x) err = nil, want an error", b)
		}
	}
}

func TestDecodeBinaryRejectsUnknownType(t *testing.T) {
	if _, _, _, err := DecodeBinary([]byte{0x7f, 0, 0, 0, 0}); err == nil {
		t.Fatal("DecodeBinary with type 0x7f err = nil, want an error")
	}
}

func TestDecodeControlDispatchesByType(t *testing.T) {
	msg, err := DecodeControl([]byte(`{"type":"attach","id":"abc","lastSeq":42}`))
	if err != nil {
		t.Fatalf("DecodeControl: %v", err)
	}
	a, ok := msg.(Attach)
	if !ok {
		t.Fatalf("msg is %T, want wire.Attach", msg)
	}
	if a.ID != "abc" || a.LastSeq != 42 {
		t.Fatalf("got %+v, want {ID:abc LastSeq:42}", a)
	}
}

func TestDecodeControlRejectsUnknownType(t *testing.T) {
	if _, err := DecodeControl([]byte(`{"type":"nope"}`)); err == nil {
		t.Fatal("DecodeControl of an unknown type err = nil, want an error")
	}
}

func TestEncodeControlSetsTypeField(t *testing.T) {
	b, err := EncodeControl(Attached{Ref: 3, ID: "s1", Cols: 80, Rows: 24, Seq: 9})
	if err != nil {
		t.Fatalf("EncodeControl: %v", err)
	}
	var got map[string]any
	if err := json.Unmarshal(b, &got); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}
	if got["type"] != "attached" {
		t.Fatalf("type = %v, want \"attached\"", got["type"])
	}
}

// TestGoldenControlMessages pins the wire format so the Go and TypeScript
// implementations cannot drift. web/src/client decodes this same file.
func TestGoldenControlMessages(t *testing.T) {
	raw, err := os.ReadFile("../../testdata/wire/control.json")
	if err != nil {
		t.Fatalf("read golden: %v", err)
	}
	var cases []struct {
		Name string          `json:"name"`
		JSON json.RawMessage `json:"json"`
	}
	if err := json.Unmarshal(raw, &cases); err != nil {
		t.Fatalf("parse golden: %v", err)
	}
	if len(cases) == 0 {
		t.Fatal("golden file has no cases")
	}
	for _, c := range cases {
		if _, err := DecodeControl(c.JSON); err != nil {
			t.Errorf("%s: DecodeControl: %v", c.Name, err)
		}
	}
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `go test ./internal/wire/ -v`
Expected: FAIL — `undefined: EncodeBinary`.

- [ ] **Step 3: Implement the binary codec**

`internal/wire/binary.go`:

```go
package wire

import (
	"encoding/binary"
	"errors"
	"fmt"
)

// Binary frame types. Layout is [1 byte type][4 bytes ref BE][payload].
const (
	FrameOutput byte = 0x00 // daemon -> client
	FrameInput  byte = 0x01 // client -> daemon
)

const binaryHeaderLen = 5

var ErrShortFrame = errors.New("wire: frame shorter than header")

// EncodeBinary builds a binary data frame.
func EncodeBinary(typ byte, ref uint32, payload []byte) []byte {
	out := make([]byte, binaryHeaderLen+len(payload))
	out[0] = typ
	binary.BigEndian.PutUint32(out[1:5], ref)
	copy(out[binaryHeaderLen:], payload)
	return out
}

// DecodeBinary parses a binary data frame. The returned payload aliases b.
func DecodeBinary(b []byte) (typ byte, ref uint32, payload []byte, err error) {
	if len(b) < binaryHeaderLen {
		return 0, 0, nil, ErrShortFrame
	}
	typ = b[0]
	if typ != FrameOutput && typ != FrameInput {
		return 0, 0, nil, fmt.Errorf("wire: unknown frame type %#x", typ)
	}
	ref = binary.BigEndian.Uint32(b[1:5])
	return typ, ref, b[binaryHeaderLen:], nil
}
```

- [ ] **Step 4: Implement the control codec**

`internal/wire/control.go`:

```go
package wire

import (
	"encoding/json"
	"fmt"

	"github.com/karnstack/flue/internal/session"
)

// Client -> server control messages.

type Hello struct {
	Ver  string   `json:"ver"`
	Caps []string `json:"caps,omitempty"`
}

type List struct{}

type Spawn struct {
	Cwd  string   `json:"cwd,omitempty"`
	Cmd  []string `json:"cmd,omitempty"`
	Cols uint16   `json:"cols"`
	Rows uint16   `json:"rows"`
}

type Attach struct {
	ID      string `json:"id"`
	LastSeq uint64 `json:"lastSeq"`
}

type Detach struct {
	Ref uint32 `json:"ref"`
}

type Resize struct {
	Ref     uint32 `json:"ref"`
	Cols    uint16 `json:"cols"`
	Rows    uint16 `json:"rows"`
	Primary bool   `json:"primary"`
}

type Signal struct {
	Ref uint32 `json:"ref"`
	Sig string `json:"sig"`
}

type CloseSession struct {
	Ref uint32 `json:"ref"`
}

// Server -> client control messages.

type Welcome struct {
	DaemonID string   `json:"daemonId"`
	Host     string   `json:"host"`
	Ver      string   `json:"ver"`
	Caps     []string `json:"caps,omitempty"`
}

type Sessions struct {
	Sessions []session.Info `json:"sessions"`
}

type Attached struct {
	Ref       uint32 `json:"ref"`
	ID        string `json:"id"`
	Cols      uint16 `json:"cols"`
	Rows      uint16 `json:"rows"`
	Title     string `json:"title"`
	Seq       uint64 `json:"seq"`
	Truncated bool   `json:"truncated"`
	Primary   bool   `json:"primary"`
}

type Exit struct {
	Ref  uint32 `json:"ref"`
	Code int    `json:"code"`
}

type SizeChanged struct {
	Ref     uint32 `json:"ref"`
	Cols    uint16 `json:"cols"`
	Rows    uint16 `json:"rows"`
	Primary bool   `json:"primary"`
}

type Error struct {
	Code string `json:"code"`
	Msg  string `json:"msg"`
}

// typeName maps a message value to its wire discriminator.
func typeName(msg any) (string, bool) {
	switch msg.(type) {
	case Hello:
		return "hello", true
	case List:
		return "list", true
	case Spawn:
		return "spawn", true
	case Attach:
		return "attach", true
	case Detach:
		return "detach", true
	case Resize:
		return "resize", true
	case Signal:
		return "signal", true
	case CloseSession:
		return "close", true
	case Welcome:
		return "welcome", true
	case Sessions:
		return "sessions", true
	case Attached:
		return "attached", true
	case Exit:
		return "exit", true
	case SizeChanged:
		return "sizeChanged", true
	case Error:
		return "error", true
	}
	return "", false
}

// EncodeControl marshals msg and injects its "type" discriminator.
func EncodeControl(msg any) ([]byte, error) {
	name, ok := typeName(msg)
	if !ok {
		return nil, fmt.Errorf("wire: %T is not a control message", msg)
	}
	body, err := json.Marshal(msg)
	if err != nil {
		return nil, err
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(body, &fields); err != nil {
		return nil, err
	}
	fields["type"] = json.RawMessage(`"` + name + `"`)
	return json.Marshal(fields)
}

// DecodeControl parses a control message into its concrete type.
func DecodeControl(b []byte) (any, error) {
	var probe struct {
		Type string `json:"type"`
	}
	if err := json.Unmarshal(b, &probe); err != nil {
		return nil, err
	}

	into := func(v any) (any, error) {
		if err := json.Unmarshal(b, v); err != nil {
			return nil, err
		}
		return v, nil
	}
	deref := func(v any, err error) (any, error) {
		if err != nil {
			return nil, err
		}
		switch t := v.(type) {
		case *Hello:
			return *t, nil
		case *List:
			return *t, nil
		case *Spawn:
			return *t, nil
		case *Attach:
			return *t, nil
		case *Detach:
			return *t, nil
		case *Resize:
			return *t, nil
		case *Signal:
			return *t, nil
		case *CloseSession:
			return *t, nil
		case *Welcome:
			return *t, nil
		case *Sessions:
			return *t, nil
		case *Attached:
			return *t, nil
		case *Exit:
			return *t, nil
		case *SizeChanged:
			return *t, nil
		case *Error:
			return *t, nil
		}
		return nil, fmt.Errorf("wire: unhandled message %T", v)
	}

	switch probe.Type {
	case "hello":
		return deref(into(&Hello{}))
	case "list":
		return deref(into(&List{}))
	case "spawn":
		return deref(into(&Spawn{}))
	case "attach":
		return deref(into(&Attach{}))
	case "detach":
		return deref(into(&Detach{}))
	case "resize":
		return deref(into(&Resize{}))
	case "signal":
		return deref(into(&Signal{}))
	case "close":
		return deref(into(&CloseSession{}))
	case "welcome":
		return deref(into(&Welcome{}))
	case "sessions":
		return deref(into(&Sessions{}))
	case "attached":
		return deref(into(&Attached{}))
	case "exit":
		return deref(into(&Exit{}))
	case "sizeChanged":
		return deref(into(&SizeChanged{}))
	case "error":
		return deref(into(&Error{}))
	}
	return nil, fmt.Errorf("wire: unknown control message type %q", probe.Type)
}
```

- [ ] **Step 5: Write the golden file**

`testdata/wire/control.json`:

```json
[
  { "name": "hello",       "json": { "type": "hello", "ver": "0.1.0", "caps": ["binary"] } },
  { "name": "list",        "json": { "type": "list" } },
  { "name": "spawn",       "json": { "type": "spawn", "cwd": "/home/karn/code", "cmd": ["zsh", "-l"], "cols": 120, "rows": 40 } },
  { "name": "attach",      "json": { "type": "attach", "id": "a1b2c3d4e5f60718", "lastSeq": 4096 } },
  { "name": "detach",      "json": { "type": "detach", "ref": 3 } },
  { "name": "resize",      "json": { "type": "resize", "ref": 3, "cols": 200, "rows": 50, "primary": true } },
  { "name": "signal",      "json": { "type": "signal", "ref": 3, "sig": "SIGINT" } },
  { "name": "close",       "json": { "type": "close", "ref": 3 } },
  { "name": "welcome",     "json": { "type": "welcome", "daemonId": "local", "host": "macbook", "ver": "0.1.0" } },
  { "name": "sessions",    "json": { "type": "sessions", "sessions": [] } },
  { "name": "attached",    "json": { "type": "attached", "ref": 3, "id": "a1b2c3d4e5f60718", "cols": 120, "rows": 40, "title": "zsh", "seq": 4096, "truncated": false, "primary": true } },
  { "name": "attachedTrunc","json": { "type": "attached", "ref": 4, "id": "a1b2c3d4e5f60718", "cols": 120, "rows": 40, "title": "zsh", "seq": 99000, "truncated": true, "primary": false } },
  { "name": "exit",        "json": { "type": "exit", "ref": 3, "code": 130 } },
  { "name": "sizeChanged", "json": { "type": "sizeChanged", "ref": 4, "cols": 200, "rows": 50, "primary": false } },
  { "name": "error",       "json": { "type": "error", "code": "unauthenticated", "msg": "spawn requires an authenticated connection" } }
]
```

- [ ] **Step 6: Write the protocol spec document**

`spec/protocol.md`:

````markdown
# flue wire protocol

Transport is a WebSocket. **Text frames carry JSON control messages; binary
frames carry data.** There is no additional framing layer.

## Binary frames

```
[1 byte type][4 bytes ref, big-endian][payload]

0x00  output  daemon -> client
0x01  input   client -> daemon
```

`ref` is a `uint32` assigned by the daemon at attach time, so keystrokes do
not carry session IDs.

## Control messages

Every control message is a JSON object with a `type` discriminator.

### Client to server

| type | fields |
|---|---|
| `hello` | `ver`, `caps[]` |
| `list` | — |
| `spawn` | `cwd`, `cmd[]`, `cols`, `rows` |
| `attach` | `id`, `lastSeq` |
| `detach` | `ref` |
| `resize` | `ref`, `cols`, `rows`, `primary` |
| `signal` | `ref`, `sig` |
| `close` | `ref` |

### Server to client

| type | fields |
|---|---|
| `welcome` | `daemonId`, `host`, `ver`, `caps[]` |
| `sessions` | `sessions[]` |
| `attached` | `ref`, `id`, `cols`, `rows`, `title`, `seq`, `truncated`, `primary` |
| `exit` | `ref`, `code` |
| `sizeChanged` | `ref`, `cols`, `rows`, `primary` |
| `error` | `code`, `msg` |

## Sequencing

The daemon assigns each session a monotonic byte-offset `seq`. On reattach a
client sends its `lastSeq`.

- If `lastSeq` is still within the ring, the daemon replies
  `attached{truncated:false, seq:<lastSeq>}` and streams the delta.
- If it has been evicted, the daemon replies
  `attached{truncated:true, seq:<baseSeq>}`. The client **must reset its
  emulator** before writing the bytes that follow.

`seq` in `attached` is always the seq of the first byte the client is about to
receive.

## Liveness

WebSocket ping/pong frames only. There is no application-level ping.

## Conformance

`testdata/wire/control.json` holds one example of every control message. Both
the Go and the TypeScript implementations decode it in their test suites, so
the two cannot drift.
````

- [ ] **Step 7: Run the tests to verify they pass**

Run: `go test ./internal/wire/ -v`
Expected: PASS, all eight tests.

- [ ] **Step 8: Commit**

```bash
git add internal/wire spec/protocol.md testdata/wire/control.json
git commit -m "feat(wire): add binary and control codecs with golden fixtures"
```

---

### Task 5: Loopback authentication

**Files:**
- Create: `internal/config/paths.go`
- Create: `internal/transport/local/auth.go`
- Test: `internal/transport/local/auth_test.go`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `config.Dir() (string, error)` — `$XDG_CONFIG_HOME/flue`, falling back to `~/.config/flue`, created `0700`
  - `config.LoadOrCreateToken() (string, error)` — 32 random bytes hex-encoded, stored `0600` at `<dir>/token`
  - `local.NewAuth(token string, port int) *Auth`
  - `(*Auth).Check(r *http.Request) error` — nil when the request carries a valid token **and** an allowed Origin **and** an allowed Host
  - `(*Auth).Middleware(next http.Handler) http.Handler` — enforces `Check`, performs the token-to-cookie exchange, sets `Referrer-Policy: no-referrer`
  - `local.CookieName = "flue_token"`

Auth is deliberately all-or-nothing: token, Origin, and Host are each required. The Host check is what defends against DNS rebinding — a name an attacker controls that resolves to loopback.

- [ ] **Step 1: Write the failing test**

`internal/transport/local/auth_test.go`:

```go
package local

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

const testToken = "0123456789abcdef"

func req(t *testing.T, host, origin, query, cookie string) *http.Request {
	t.Helper()
	r := httptest.NewRequest("GET", "http://"+host+"/"+query, nil)
	r.Host = host
	if origin != "" {
		r.Header.Set("Origin", origin)
	}
	if cookie != "" {
		r.AddCookie(&http.Cookie{Name: CookieName, Value: cookie})
	}
	return r
}

func TestAuthCheck(t *testing.T) {
	a := NewAuth(testToken, 7717)

	cases := []struct {
		name    string
		host    string
		origin  string
		query   string
		cookie  string
		wantErr bool
	}{
		{"token in query", "127.0.0.1:7717", "http://127.0.0.1:7717", "?t=" + testToken, "", false},
		{"token in cookie", "127.0.0.1:7717", "http://127.0.0.1:7717", "", testToken, false},
		{"localhost host and origin", "localhost:7717", "http://localhost:7717", "", testToken, false},
		{"no token", "127.0.0.1:7717", "http://127.0.0.1:7717", "", "", true},
		{"wrong token", "127.0.0.1:7717", "http://127.0.0.1:7717", "?t=nope", "", true},
		{"foreign origin", "127.0.0.1:7717", "https://evil.example.com", "", testToken, true},
		{"rebound host", "evil.example.com:7717", "http://127.0.0.1:7717", "", testToken, true},
		{"wrong port in host", "127.0.0.1:9999", "http://127.0.0.1:7717", "", testToken, true},
		{"wrong port in origin", "127.0.0.1:7717", "http://127.0.0.1:9999", "", testToken, true},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			err := a.Check(req(t, c.host, c.origin, c.query, c.cookie))
			if c.wantErr && err == nil {
				t.Fatal("Check err = nil, want an error")
			}
			if !c.wantErr && err != nil {
				t.Fatalf("Check err = %v, want nil", err)
			}
		})
	}
}

func TestAuthAllowsMissingOriginForNonBrowserClients(t *testing.T) {
	// curl and the flue CLI send no Origin. A present-but-wrong Origin is
	// rejected; an absent one is not, because only browsers set it and
	// only browsers can be tricked into cross-origin requests.
	a := NewAuth(testToken, 7717)
	if err := a.Check(req(t, "127.0.0.1:7717", "", "?t="+testToken, "")); err != nil {
		t.Fatalf("Check err = %v, want nil", err)
	}
}

func TestMiddlewareExchangesTokenForCookie(t *testing.T) {
	a := NewAuth(testToken, 7717)
	h := a.Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req(t, "127.0.0.1:7717", "http://127.0.0.1:7717", "?t="+testToken, ""))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if got := rec.Header().Get("Referrer-Policy"); got != "no-referrer" {
		t.Fatalf("Referrer-Policy = %q, want %q", got, "no-referrer")
	}

	var found *http.Cookie
	for _, c := range rec.Result().Cookies() {
		if c.Name == CookieName {
			found = c
		}
	}
	if found == nil {
		t.Fatal("no flue_token cookie set")
	}
	if !found.HttpOnly {
		t.Error("cookie HttpOnly = false, want true")
	}
	if found.SameSite != http.SameSiteStrictMode {
		t.Errorf("cookie SameSite = %v, want Strict", found.SameSite)
	}
}

func TestMiddlewareRejectsUnauthenticated(t *testing.T) {
	a := NewAuth(testToken, 7717)
	h := a.Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Fatal("handler ran for an unauthenticated request")
	}))

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req(t, "127.0.0.1:7717", "https://evil.example.com", "", testToken))

	if rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403", rec.Code)
	}
}

func TestMiddlewareNeverSetsWildcardCORS(t *testing.T) {
	a := NewAuth(testToken, 7717)
	h := a.Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req(t, "127.0.0.1:7717", "http://127.0.0.1:7717", "?t="+testToken, ""))
	if got := rec.Header().Get("Access-Control-Allow-Origin"); got == "*" {
		t.Fatal("Access-Control-Allow-Origin = *, which is never permitted")
	}
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `go test ./internal/transport/local/ -v`
Expected: FAIL — `undefined: NewAuth`.

- [ ] **Step 3: Implement config paths and the token file**

`internal/config/paths.go`:

```go
package config

import (
	"crypto/rand"
	"encoding/hex"
	"os"
	"path/filepath"
	"strings"
)

// Dir returns the flue config directory, creating it if needed.
func Dir() (string, error) {
	base := os.Getenv("XDG_CONFIG_HOME")
	if base == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", err
		}
		base = filepath.Join(home, ".config")
	}
	dir := filepath.Join(base, "flue")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", err
	}
	return dir, nil
}

// LoadOrCreateToken returns the daemon's loopback token, generating and
// persisting one at mode 0600 on first use.
func LoadOrCreateToken() (string, error) {
	dir, err := Dir()
	if err != nil {
		return "", err
	}
	path := filepath.Join(dir, "token")

	if b, err := os.ReadFile(path); err == nil {
		if tok := strings.TrimSpace(string(b)); tok != "" {
			return tok, nil
		}
	}

	var raw [32]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return "", err
	}
	tok := hex.EncodeToString(raw[:])
	if err := os.WriteFile(path, []byte(tok), 0o600); err != nil {
		return "", err
	}
	return tok, nil
}
```

- [ ] **Step 4: Implement the auth middleware**

`internal/transport/local/auth.go`:

```go
// Package local implements the loopback transport: a listener bound to
// 127.0.0.1 and authenticated by a token file, an Origin allowlist, and a
// Host check.
package local

import (
	"crypto/subtle"
	"errors"
	"fmt"
	"net/http"
)

// CookieName is where the token lives after the first request, so it never
// stays in the URL where history and referrers would leak it.
const CookieName = "flue_token"

var (
	ErrNoToken      = errors.New("local: missing or invalid token")
	ErrBadOrigin    = errors.New("local: origin not allowed")
	ErrBadHost      = errors.New("local: host not allowed")
)

// Auth enforces loopback authentication. All three checks are required:
// a valid token, an allowed Origin, and an allowed Host. The Host check
// defends against DNS rebinding, where a name the attacker controls
// resolves to 127.0.0.1.
type Auth struct {
	token   string
	hosts   map[string]struct{}
	origins map[string]struct{}
}

func NewAuth(token string, port int) *Auth {
	h1 := fmt.Sprintf("127.0.0.1:%d", port)
	h2 := fmt.Sprintf("localhost:%d", port)
	return &Auth{
		token: token,
		hosts: map[string]struct{}{h1: {}, h2: {}},
		origins: map[string]struct{}{
			"http://" + h1: {},
			"http://" + h2: {},
		},
	}
}

// Check reports whether r is authenticated.
func (a *Auth) Check(r *http.Request) error {
	if _, ok := a.hosts[r.Host]; !ok {
		return ErrBadHost
	}
	// A missing Origin is allowed: non-browser clients (curl, the flue CLI)
	// do not send one, and only browsers can be induced into cross-origin
	// requests. A present-but-unlisted Origin is always rejected.
	if origin := r.Header.Get("Origin"); origin != "" {
		if _, ok := a.origins[origin]; !ok {
			return ErrBadOrigin
		}
	}
	if !a.validToken(r) {
		return ErrNoToken
	}
	return nil
}

func (a *Auth) validToken(r *http.Request) bool {
	if c, err := r.Cookie(CookieName); err == nil && constantEqual(c.Value, a.token) {
		return true
	}
	return constantEqual(r.URL.Query().Get("t"), a.token)
}

func constantEqual(got, want string) bool {
	return subtle.ConstantTimeCompare([]byte(got), []byte(want)) == 1
}

// Middleware enforces Check, exchanges a URL token for a cookie, and sets
// the response headers every flue response needs.
func (a *Auth) Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Referrer-Policy", "no-referrer")

		if err := a.Check(r); err != nil {
			status := http.StatusForbidden
			if errors.Is(err, ErrNoToken) {
				status = http.StatusUnauthorized
			}
			http.Error(w, err.Error(), status)
			return
		}

		// First load carries the token in the URL. Move it into an
		// HttpOnly cookie so it stops appearing in history and referrers;
		// the client then strips it from the URL with replaceState.
		if r.URL.Query().Get("t") != "" {
			http.SetCookie(w, &http.Cookie{
				Name:     CookieName,
				Value:    a.token,
				Path:     "/",
				HttpOnly: true,
				SameSite: http.SameSiteStrictMode,
			})
		}

		next.ServeHTTP(w, r)
	})
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `go test ./internal/transport/local/ ./internal/config/ -v`
Expected: PASS, every subtest of `TestAuthCheck` plus the four middleware tests.

- [ ] **Step 6: Commit**

```bash
git add internal/config internal/transport/local
git commit -m "feat(local): add loopback auth with token, origin, and host checks"
```

---

### Task 6: Daemon server and WebSocket handler

**Files:**
- Create: `internal/daemon/server.go`
- Create: `internal/daemon/conn.go`
- Test: `internal/daemon/server_test.go`
- Modify: `go.mod` (adds `github.com/coder/websocket`)

**Interfaces:**
- Consumes: `session.Registry`, `wire.*`, `local.NewAuth` from Tasks 3–5.
- Produces:
  - `daemon.New(reg *session.Registry, auth *local.Auth, ui http.Handler, version string) *Server`
  - `(*Server).Handler() http.Handler`
  - `(*Server).ListenAndServe(ctx context.Context, port int) error` — binds `127.0.0.1` only

Attachment bookkeeping lives here, not in `session`: `ref` allocation, the `primary` client that owns PTY dimensions, and promotion when the primary leaves.

- [ ] **Step 1: Add the WebSocket dependency**

```bash
go get github.com/coder/websocket@latest
```

- [ ] **Step 2: Write the failing test**

`internal/daemon/server_test.go`:

```go
package daemon

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/karnstack/flue/internal/session"
	"github.com/karnstack/flue/internal/transport/local"
	"github.com/karnstack/flue/internal/wire"
)

const tok = "0123456789abcdef"

func newTestServer(t *testing.T) (*httptest.Server, *session.Registry) {
	t.Helper()
	reg := session.NewRegistry(time.Now)
	srv := New(reg, nil, http.NotFoundHandler(), "test")

	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)

	// Rebuild auth against the port httptest actually chose.
	port := 0
	if _, p, ok := strings.Cut(strings.TrimPrefix(ts.URL, "http://"), ":"); ok {
		for _, c := range p {
			port = port*10 + int(c-'0')
		}
	}
	srv.SetAuth(local.NewAuth(tok, port))
	return ts, reg
}

func dial(t *testing.T, ts *httptest.Server) *websocket.Conn {
	t.Helper()
	url := "ws" + strings.TrimPrefix(ts.URL, "http") + "/ws?t=" + tok
	c, _, err := websocket.Dial(context.Background(), url, nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	t.Cleanup(func() { c.Close(websocket.StatusNormalClosure, "") })
	return c
}

func writeControl(t *testing.T, c *websocket.Conn, msg any) {
	t.Helper()
	b, err := wire.EncodeControl(msg)
	if err != nil {
		t.Fatalf("EncodeControl: %v", err)
	}
	if err := c.Write(context.Background(), websocket.MessageText, b); err != nil {
		t.Fatalf("write: %v", err)
	}
}

// readUntil reads frames until pred returns true or the deadline passes.
// Binary payloads are accumulated so callers can assert on output.
func readUntil(t *testing.T, c *websocket.Conn, pred func(msg any, out []byte) bool) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	var out []byte
	for {
		typ, data, err := c.Read(ctx)
		if err != nil {
			t.Fatalf("read: %v (output so far %q)", err, out)
		}
		if typ == websocket.MessageBinary {
			_, _, payload, err := wire.DecodeBinary(data)
			if err != nil {
				t.Fatalf("DecodeBinary: %v", err)
			}
			out = append(out, payload...)
			if pred(nil, out) {
				return
			}
			continue
		}
		msg, err := wire.DecodeControl(data)
		if err != nil {
			t.Fatalf("DecodeControl: %v", err)
		}
		if pred(msg, out) {
			return
		}
	}
}

func TestWebSocketRejectsUnauthenticated(t *testing.T) {
	ts, _ := newTestServer(t)
	url := "ws" + strings.TrimPrefix(ts.URL, "http") + "/ws"
	if _, _, err := websocket.Dial(context.Background(), url, nil); err == nil {
		t.Fatal("dial without a token succeeded, want failure")
	}
}

func TestHelloReturnsWelcome(t *testing.T) {
	ts, _ := newTestServer(t)
	c := dial(t, ts)
	writeControl(t, c, wire.Hello{Ver: "test"})
	readUntil(t, c, func(msg any, _ []byte) bool {
		_, ok := msg.(wire.Welcome)
		return ok
	})
}

func TestSpawnAttachAndOutput(t *testing.T) {
	ts, _ := newTestServer(t)
	c := dial(t, ts)

	writeControl(t, c, wire.Hello{Ver: "test"})
	writeControl(t, c, wire.Spawn{Cmd: []string{"sh", "-c", "echo spawned-ok; sleep 2"}, Cols: 80, Rows: 24})

	readUntil(t, c, func(msg any, out []byte) bool {
		return bytes.Contains(out, []byte("spawned-ok"))
	})
}

func TestAttachedCarriesRefAndSeq(t *testing.T) {
	ts, reg := newTestServer(t)
	s, err := reg.Spawn(session.SpawnOpts{Cmd: []string{"sleep", "2"}, Cols: 80, Rows: 24})
	if err != nil {
		t.Fatalf("Spawn: %v", err)
	}
	defer s.Close()

	c := dial(t, ts)
	writeControl(t, c, wire.Hello{Ver: "test"})
	writeControl(t, c, wire.Attach{ID: s.ID(), LastSeq: 0})

	readUntil(t, c, func(msg any, _ []byte) bool {
		a, ok := msg.(wire.Attached)
		if !ok {
			return false
		}
		if a.ID != s.ID() {
			t.Fatalf("Attached.ID = %q, want %q", a.ID, s.ID())
		}
		if !a.Primary {
			t.Fatal("first attacher Primary = false, want true")
		}
		return true
	})
}

func TestInputReachesPTYAndMirrorsToBothClients(t *testing.T) {
	ts, reg := newTestServer(t)
	s, err := reg.Spawn(session.SpawnOpts{Cmd: []string{"cat"}, Cols: 80, Rows: 24})
	if err != nil {
		t.Fatalf("Spawn: %v", err)
	}
	defer s.Close()

	var refs [2]uint32
	conns := [2]*websocket.Conn{dial(t, ts), dial(t, ts)}
	for i, c := range conns {
		writeControl(t, c, wire.Hello{Ver: "test"})
		writeControl(t, c, wire.Attach{ID: s.ID(), LastSeq: 0})
		idx := i
		readUntil(t, c, func(msg any, _ []byte) bool {
			a, ok := msg.(wire.Attached)
			if ok {
				refs[idx] = a.Ref
			}
			return ok
		})
	}

	frame := wire.EncodeBinary(wire.FrameInput, refs[0], []byte("mirrored\n"))
	if err := conns[0].Write(context.Background(), websocket.MessageBinary, frame); err != nil {
		t.Fatalf("write input: %v", err)
	}

	for _, c := range conns {
		readUntil(t, c, func(_ any, out []byte) bool {
			return bytes.Contains(out, []byte("mirrored"))
		})
	}
}

func TestSecondAttacherIsNotPrimary(t *testing.T) {
	ts, reg := newTestServer(t)
	s, err := reg.Spawn(session.SpawnOpts{Cmd: []string{"sleep", "2"}, Cols: 80, Rows: 24})
	if err != nil {
		t.Fatalf("Spawn: %v", err)
	}
	defer s.Close()

	first := dial(t, ts)
	writeControl(t, first, wire.Hello{Ver: "test"})
	writeControl(t, first, wire.Attach{ID: s.ID(), LastSeq: 0})
	readUntil(t, first, func(msg any, _ []byte) bool { _, ok := msg.(wire.Attached); return ok })

	second := dial(t, ts)
	writeControl(t, second, wire.Hello{Ver: "test"})
	writeControl(t, second, wire.Attach{ID: s.ID(), LastSeq: 0})
	readUntil(t, second, func(msg any, _ []byte) bool {
		a, ok := msg.(wire.Attached)
		if ok && a.Primary {
			t.Fatal("second attacher Primary = true, want false")
		}
		return ok
	})
}

func TestNonPrimaryResizeDoesNotChangePTY(t *testing.T) {
	ts, reg := newTestServer(t)
	s, err := reg.Spawn(session.SpawnOpts{Cmd: []string{"sleep", "2"}, Cols: 80, Rows: 24})
	if err != nil {
		t.Fatalf("Spawn: %v", err)
	}
	defer s.Close()

	first := dial(t, ts)
	writeControl(t, first, wire.Hello{Ver: "test"})
	writeControl(t, first, wire.Attach{ID: s.ID(), LastSeq: 0})
	readUntil(t, first, func(msg any, _ []byte) bool { _, ok := msg.(wire.Attached); return ok })

	second := dial(t, ts)
	writeControl(t, second, wire.Hello{Ver: "test"})
	writeControl(t, second, wire.Attach{ID: s.ID(), LastSeq: 0})
	var ref uint32
	readUntil(t, second, func(msg any, _ []byte) bool {
		a, ok := msg.(wire.Attached)
		if ok {
			ref = a.Ref
		}
		return ok
	})

	writeControl(t, second, wire.Resize{Ref: ref, Cols: 40, Rows: 10, Primary: false})
	time.Sleep(200 * time.Millisecond)

	if got := s.Info().Cols; got != 80 {
		t.Fatalf("Cols = %d after a non-primary resize, want 80", got)
	}
}

func TestPrimarySeizureResizesPTY(t *testing.T) {
	ts, reg := newTestServer(t)
	s, err := reg.Spawn(session.SpawnOpts{Cmd: []string{"sleep", "2"}, Cols: 80, Rows: 24})
	if err != nil {
		t.Fatalf("Spawn: %v", err)
	}
	defer s.Close()

	c := dial(t, ts)
	writeControl(t, c, wire.Hello{Ver: "test"})
	writeControl(t, c, wire.Attach{ID: s.ID(), LastSeq: 0})
	var ref uint32
	readUntil(t, c, func(msg any, _ []byte) bool {
		a, ok := msg.(wire.Attached)
		if ok {
			ref = a.Ref
		}
		return ok
	})

	writeControl(t, c, wire.Resize{Ref: ref, Cols: 120, Rows: 40, Primary: true})

	deadline := time.After(3 * time.Second)
	for s.Info().Cols != 120 {
		select {
		case <-deadline:
			t.Fatalf("Cols = %d, want 120", s.Info().Cols)
		case <-time.After(10 * time.Millisecond):
		}
	}
}

func TestListReturnsSessions(t *testing.T) {
	ts, reg := newTestServer(t)
	s, err := reg.Spawn(session.SpawnOpts{Cmd: []string{"sleep", "2"}, Cols: 80, Rows: 24})
	if err != nil {
		t.Fatalf("Spawn: %v", err)
	}
	defer s.Close()

	c := dial(t, ts)
	writeControl(t, c, wire.Hello{Ver: "test"})
	writeControl(t, c, wire.List{})
	readUntil(t, c, func(msg any, _ []byte) bool {
		l, ok := msg.(wire.Sessions)
		if !ok {
			return false
		}
		for _, info := range l.Sessions {
			if info.ID == s.ID() {
				return true
			}
		}
		return false
	})
}

func TestAttachUnknownSessionReturnsError(t *testing.T) {
	ts, _ := newTestServer(t)
	c := dial(t, ts)
	writeControl(t, c, wire.Hello{Ver: "test"})
	writeControl(t, c, wire.Attach{ID: "does-not-exist"})
	readUntil(t, c, func(msg any, _ []byte) bool {
		e, ok := msg.(wire.Error)
		return ok && e.Code == "not_found"
	})
}

func TestHTTPSessionsEndpointRequiresAuth(t *testing.T) {
	ts, _ := newTestServer(t)
	resp, err := http.Get(ts.URL + "/api/sessions")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusOK {
		t.Fatal("status = 200 without a token, want a rejection")
	}
}

func TestHTTPSessionsEndpointWithAuth(t *testing.T) {
	ts, reg := newTestServer(t)
	s, err := reg.Spawn(session.SpawnOpts{Cmd: []string{"sleep", "2"}, Cols: 80, Rows: 24})
	if err != nil {
		t.Fatalf("Spawn: %v", err)
	}
	defer s.Close()

	resp, err := http.Get(ts.URL + "/api/sessions?t=" + tok)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}
	var got struct {
		Sessions []session.Info `json:"sessions"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(got.Sessions) == 0 {
		t.Fatal("sessions is empty, want at least one")
	}
}
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `go test ./internal/daemon/ -v`
Expected: FAIL — `undefined: New`.

- [ ] **Step 4: Implement the per-connection state machine**

`internal/daemon/conn.go`:

```go
package daemon

import (
	"context"
	"sync"
	"syscall"

	"github.com/coder/websocket"
	"github.com/karnstack/flue/internal/session"
	"github.com/karnstack/flue/internal/wire"
)

// attachment is one client's hold on one session.
type attachment struct {
	ref uint32
	s   *session.Session
	sub *session.Sub
}

// conn is the per-WebSocket state machine. Every write to the socket goes
// through writeMu, because control and output frames originate on
// different goroutines.
type conn struct {
	ws  *websocket.Conn
	srv *Server

	writeMu sync.Mutex

	mu      sync.Mutex
	nextRef uint32
	attach  map[uint32]*attachment
}

func newConn(ws *websocket.Conn, srv *Server) *conn {
	return &conn{ws: ws, srv: srv, attach: map[uint32]*attachment{}}
}

func (c *conn) sendControl(ctx context.Context, msg any) error {
	b, err := wire.EncodeControl(msg)
	if err != nil {
		return err
	}
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	return c.ws.Write(ctx, websocket.MessageText, b)
}

func (c *conn) sendBinary(ctx context.Context, typ byte, ref uint32, payload []byte) error {
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	return c.ws.Write(ctx, websocket.MessageBinary, wire.EncodeBinary(typ, ref, payload))
}

func (c *conn) sendError(ctx context.Context, code, msg string) {
	_ = c.sendControl(ctx, wire.Error{Code: code, Msg: msg})
}

// serve runs the read loop until the socket closes.
func (c *conn) serve(ctx context.Context) {
	defer c.closeAll()

	_ = c.sendControl(ctx, wire.Welcome{
		DaemonID: "local",
		Host:     c.srv.hostname,
		Ver:      c.srv.version,
	})

	for {
		typ, data, err := c.ws.Read(ctx)
		if err != nil {
			return
		}
		if typ == websocket.MessageBinary {
			c.handleBinary(ctx, data)
			continue
		}
		msg, err := wire.DecodeControl(data)
		if err != nil {
			c.sendError(ctx, "bad_message", err.Error())
			continue
		}
		c.handleControl(ctx, msg)
	}
}

func (c *conn) handleBinary(ctx context.Context, data []byte) {
	typ, ref, payload, err := wire.DecodeBinary(data)
	if err != nil {
		c.sendError(ctx, "bad_frame", err.Error())
		return
	}
	if typ != wire.FrameInput {
		c.sendError(ctx, "bad_frame", "clients may only send input frames")
		return
	}

	c.mu.Lock()
	a := c.attach[ref]
	c.mu.Unlock()
	if a == nil {
		c.sendError(ctx, "bad_ref", "no such attachment")
		return
	}
	if err := a.s.Write(payload); err != nil {
		c.sendError(ctx, "write_failed", err.Error())
	}
}

func (c *conn) handleControl(ctx context.Context, msg any) {
	switch m := msg.(type) {
	case wire.Hello:
		// Welcome was already sent on connect; hello is a no-op that lets
		// the client announce capabilities.

	case wire.List:
		infos := []session.Info{}
		for _, s := range c.srv.reg.List() {
			infos = append(infos, s.Info())
		}
		_ = c.sendControl(ctx, wire.Sessions{Sessions: infos})

	case wire.Spawn:
		s, err := c.srv.reg.Spawn(session.SpawnOpts{
			Cwd: m.Cwd, Cmd: m.Cmd, Cols: m.Cols, Rows: m.Rows,
		})
		if err != nil {
			c.sendError(ctx, "spawn_failed", err.Error())
			return
		}
		c.attachTo(ctx, s, 0)

	case wire.Attach:
		s, ok := c.srv.reg.Get(m.ID)
		if !ok {
			c.sendError(ctx, "not_found", "no such session")
			return
		}
		c.attachTo(ctx, s, m.LastSeq)

	case wire.Detach:
		c.detach(m.Ref)

	case wire.Resize:
		c.mu.Lock()
		a := c.attach[m.Ref]
		c.mu.Unlock()
		if a == nil {
			c.sendError(ctx, "bad_ref", "no such attachment")
			return
		}
		// Only the primary owns PTY dimensions. A non-primary resize is
		// ignored unless the client is explicitly seizing primary, which
		// is what stops a phone from shrinking a laptop's view.
		if m.Primary {
			c.srv.setPrimary(a.s.ID(), c)
		}
		if !c.srv.isPrimary(a.s.ID(), c) {
			return
		}
		if err := a.s.Resize(m.Cols, m.Rows); err != nil {
			c.sendError(ctx, "resize_failed", err.Error())
			return
		}
		c.srv.broadcastSize(ctx, a.s.ID(), m.Cols, m.Rows)

	case wire.Signal:
		c.mu.Lock()
		a := c.attach[m.Ref]
		c.mu.Unlock()
		if a == nil {
			c.sendError(ctx, "bad_ref", "no such attachment")
			return
		}
		sig := syscall.SIGINT
		switch m.Sig {
		case "SIGTERM":
			sig = syscall.SIGTERM
		case "SIGHUP":
			sig = syscall.SIGHUP
		case "SIGKILL":
			sig = syscall.SIGKILL
		}
		if err := a.s.Signal(sig); err != nil {
			c.sendError(ctx, "signal_failed", err.Error())
		}

	case wire.CloseSession:
		c.mu.Lock()
		a := c.attach[m.Ref]
		c.mu.Unlock()
		if a == nil {
			c.sendError(ctx, "bad_ref", "no such attachment")
			return
		}
		_ = a.s.Close()

	default:
		c.sendError(ctx, "bad_message", "unexpected message from client")
	}
}

// attachTo subscribes to s from lastSeq and starts streaming output.
func (c *conn) attachTo(ctx context.Context, s *session.Session, lastSeq uint64) {
	sub := s.Subscribe(lastSeq)

	c.mu.Lock()
	c.nextRef++
	ref := c.nextRef
	a := &attachment{ref: ref, s: s, sub: sub}
	c.attach[ref] = a
	c.mu.Unlock()

	primary := c.srv.claimPrimaryIfUnset(s.ID(), c)
	info := s.Info()

	_ = c.sendControl(ctx, wire.Attached{
		Ref:       ref,
		ID:        s.ID(),
		Cols:      info.Cols,
		Rows:      info.Rows,
		Title:     info.Title,
		Seq:       sub.StartSeq,
		Truncated: sub.Truncated,
		Primary:   primary,
	})

	if len(sub.Backlog) > 0 {
		_ = c.sendBinary(ctx, wire.FrameOutput, ref, sub.Backlog)
	}

	go c.stream(ctx, a)
}

// stream forwards output until the subscriber is closed.
func (c *conn) stream(ctx context.Context, a *attachment) {
	for chunk := range a.sub.C {
		if err := c.sendBinary(ctx, wire.FrameOutput, a.ref, chunk); err != nil {
			return
		}
	}
	// The channel closes when the process exits or the subscriber fell
	// behind. Report the exit if the session is done.
	if info := a.s.Info(); info.State == "exited" {
		_ = c.sendControl(ctx, wire.Exit{Ref: a.ref, Code: info.ExitCode})
	}
}

func (c *conn) detach(ref uint32) {
	c.mu.Lock()
	a := c.attach[ref]
	delete(c.attach, ref)
	c.mu.Unlock()
	if a == nil {
		return
	}
	a.s.Unsubscribe(a.sub)
	c.srv.releasePrimary(a.s.ID(), c)
}

func (c *conn) closeAll() {
	c.mu.Lock()
	refs := make([]uint32, 0, len(c.attach))
	for ref := range c.attach {
		refs = append(refs, ref)
	}
	c.mu.Unlock()
	for _, ref := range refs {
		c.detach(ref)
	}
}
```

- [ ] **Step 5: Implement the server**

`internal/daemon/server.go`:

```go
// Package daemon wires sessions, the wire protocol, and a transport into an
// HTTP server. It owns attachment bookkeeping: ref allocation, which client
// is primary for a session, and promotion when a primary leaves.
package daemon

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/karnstack/flue/internal/session"
	"github.com/karnstack/flue/internal/transport/local"
	"github.com/karnstack/flue/internal/wire"
)

// Server serves the flue API and the embedded UI on loopback.
type Server struct {
	reg      *session.Registry
	ui       http.Handler
	version  string
	hostname string

	authMu sync.RWMutex
	auth   *local.Auth

	primaryMu sync.Mutex
	primary   map[string]*conn // session ID -> primary connection
	attached  map[string][]*conn
}

func New(reg *session.Registry, auth *local.Auth, ui http.Handler, version string) *Server {
	host, _ := os.Hostname()
	return &Server{
		reg:      reg,
		ui:       ui,
		version:  version,
		hostname: host,
		auth:     auth,
		primary:  map[string]*conn{},
		attached: map[string][]*conn{},
	}
}

// SetAuth swaps the authenticator. Used by tests, which learn their port
// only after the listener is bound.
func (s *Server) SetAuth(a *local.Auth) {
	s.authMu.Lock()
	defer s.authMu.Unlock()
	s.auth = a
}

func (s *Server) checkAuth(r *http.Request) error {
	s.authMu.RLock()
	a := s.auth
	s.authMu.RUnlock()
	if a == nil {
		return nil
	}
	return a.Check(r)
}

// Handler returns the full HTTP handler: UI, JSON API, and WebSocket.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/ws", s.handleWS)
	mux.HandleFunc("/api/sessions", s.handleSessions)
	mux.Handle("/", s.uiHandler())

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("Content-Security-Policy",
			"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "+
				"img-src 'self' data:; connect-src 'self' ws://127.0.0.1:* ws://localhost:*; "+
				"object-src 'none'; base-uri 'none'; frame-ancestors 'none'")
		mux.ServeHTTP(w, r)
	})
}

func (s *Server) uiHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := s.checkAuth(r); err != nil {
			http.Error(w, err.Error(), http.StatusUnauthorized)
			return
		}
		if r.URL.Query().Get("t") != "" {
			s.authMu.RLock()
			a := s.auth
			s.authMu.RUnlock()
			if a != nil {
				http.SetCookie(w, &http.Cookie{
					Name:     local.CookieName,
					Value:    r.URL.Query().Get("t"),
					Path:     "/",
					HttpOnly: true,
					SameSite: http.SameSiteStrictMode,
				})
			}
		}
		s.ui.ServeHTTP(w, r)
	})
}

func (s *Server) handleSessions(w http.ResponseWriter, r *http.Request) {
	if err := s.checkAuth(r); err != nil {
		http.Error(w, err.Error(), http.StatusUnauthorized)
		return
	}
	infos := []session.Info{}
	for _, sess := range s.reg.List() {
		infos = append(infos, sess.Info())
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"sessions": infos})
}

func (s *Server) handleWS(w http.ResponseWriter, r *http.Request) {
	if err := s.checkAuth(r); err != nil {
		http.Error(w, err.Error(), http.StatusUnauthorized)
		return
	}
	ws, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		// The Origin check has already run in checkAuth against our own
		// allowlist, which is stricter than the library's host comparison.
		InsecureSkipVerify: true,
	})
	if err != nil {
		return
	}
	ws.SetReadLimit(1 << 20)
	defer ws.Close(websocket.StatusInternalError, "closing")

	c := newConn(ws, s)
	c.serve(r.Context())
	ws.Close(websocket.StatusNormalClosure, "")
}

// ListenAndServe binds 127.0.0.1 only. No adapter ever binds 0.0.0.0.
func (s *Server) ListenAndServe(ctx context.Context, port int) error {
	addr := fmt.Sprintf("127.0.0.1:%d", port)
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		return err
	}

	srv := &http.Server{Handler: s.Handler()}
	go func() {
		ticker := time.NewTicker(time.Minute)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				_ = srv.Close()
				return
			case <-ticker.C:
				s.reg.Reap()
			}
		}
	}()
	return srv.Serve(ln)
}

// --- primary bookkeeping ---

// claimPrimaryIfUnset registers c as attached and makes it primary when the
// session has none. Reports whether c ended up primary.
func (s *Server) claimPrimaryIfUnset(id string, c *conn) bool {
	s.primaryMu.Lock()
	defer s.primaryMu.Unlock()
	s.attached[id] = append(s.attached[id], c)
	if s.primary[id] == nil {
		s.primary[id] = c
		return true
	}
	return s.primary[id] == c
}

func (s *Server) setPrimary(id string, c *conn) {
	s.primaryMu.Lock()
	defer s.primaryMu.Unlock()
	s.primary[id] = c
}

func (s *Server) isPrimary(id string, c *conn) bool {
	s.primaryMu.Lock()
	defer s.primaryMu.Unlock()
	return s.primary[id] == c
}

// releasePrimary drops c from the session and promotes the most recently
// attached remaining client if c was primary.
func (s *Server) releasePrimary(id string, c *conn) {
	s.primaryMu.Lock()
	defer s.primaryMu.Unlock()

	list := s.attached[id]
	for i, other := range list {
		if other == c {
			list = append(list[:i], list[i+1:]...)
			break
		}
	}
	if len(list) == 0 {
		delete(s.attached, id)
		delete(s.primary, id)
		return
	}
	s.attached[id] = list
	if s.primary[id] == c {
		s.primary[id] = list[len(list)-1]
	}
}

// broadcastSize tells every attached client the new dimensions.
func (s *Server) broadcastSize(ctx context.Context, id string, cols, rows uint16) {
	s.primaryMu.Lock()
	list := append([]*conn(nil), s.attached[id]...)
	primary := s.primary[id]
	s.primaryMu.Unlock()

	for _, c := range list {
		c.mu.Lock()
		var ref uint32
		for r, a := range c.attach {
			if a.s.ID() == id {
				ref = r
				break
			}
		}
		c.mu.Unlock()
		if ref == 0 {
			continue
		}
		_ = c.sendControl(ctx, wire.SizeChanged{
			Ref: ref, Cols: cols, Rows: rows, Primary: c == primary,
		})
	}
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `go test ./internal/daemon/ -v`
Expected: PASS, all twelve tests.

- [ ] **Step 7: Run the whole Go suite**

Run: `go test ./... -v`
Expected: PASS across `session`, `wire`, `config`, `local`, and `daemon`.

- [ ] **Step 8: Commit**

```bash
git add go.mod go.sum internal/daemon
git commit -m "feat(daemon): add websocket server with attach, mirroring, and primary resize"
```

---

### Task 7: CLI

**Files:**
- Create: `cmd/flue/main.go`
- Create: `internal/daemon/discover.go`
- Test: `internal/daemon/discover_test.go`

**Interfaces:**
- Consumes: `config`, `daemon`, `session`, `local` from Tasks 3–6.
- Produces:
  - `daemon.WriteRuntime(port int) error` and `daemon.ReadRuntime() (port int, ok bool)` — a `<config>/runtime.json` file recording the running daemon's port, so `flue open` can find it
  - `flue serve [--port N]`, `flue open [path]`, `flue status`

`flue enable` and `flue disable` land in build-order step 2 with the service package; `serve` is the foreground equivalent used until then.

- [ ] **Step 1: Write the failing test**

`internal/daemon/discover_test.go`:

```go
package daemon

import (
	"testing"
)

func TestRuntimeRoundTrip(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())

	if _, ok := ReadRuntime(); ok {
		t.Fatal("ReadRuntime ok = true with no runtime file, want false")
	}
	if err := WriteRuntime(7717); err != nil {
		t.Fatalf("WriteRuntime: %v", err)
	}
	port, ok := ReadRuntime()
	if !ok || port != 7717 {
		t.Fatalf("ReadRuntime = %d, %v; want 7717, true", port, ok)
	}
}

func TestRuntimeOverwrites(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	if err := WriteRuntime(1111); err != nil {
		t.Fatalf("WriteRuntime: %v", err)
	}
	if err := WriteRuntime(2222); err != nil {
		t.Fatalf("WriteRuntime: %v", err)
	}
	port, ok := ReadRuntime()
	if !ok || port != 2222 {
		t.Fatalf("ReadRuntime = %d, %v; want 2222, true", port, ok)
	}
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `go test ./internal/daemon/ -run TestRuntime -v`
Expected: FAIL — `undefined: WriteRuntime`.

- [ ] **Step 3: Implement runtime discovery**

`internal/daemon/discover.go`:

```go
package daemon

import (
	"encoding/json"
	"os"
	"path/filepath"

	"github.com/karnstack/flue/internal/config"
)

type runtimeFile struct {
	Port int `json:"port"`
	PID  int `json:"pid"`
}

func runtimePath() (string, error) {
	dir, err := config.Dir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "runtime.json"), nil
}

// WriteRuntime records the port the daemon is listening on so other flue
// invocations can find it.
func WriteRuntime(port int) error {
	path, err := runtimePath()
	if err != nil {
		return err
	}
	b, err := json.Marshal(runtimeFile{Port: port, PID: os.Getpid()})
	if err != nil {
		return err
	}
	return os.WriteFile(path, b, 0o600)
}

// ReadRuntime returns the recorded port, if any.
func ReadRuntime() (int, bool) {
	path, err := runtimePath()
	if err != nil {
		return 0, false
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return 0, false
	}
	var rf runtimeFile
	if err := json.Unmarshal(b, &rf); err != nil {
		return 0, false
	}
	if rf.Port == 0 {
		return 0, false
	}
	return rf.Port, true
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `go test ./internal/daemon/ -run TestRuntime -v`
Expected: PASS.

- [ ] **Step 5: Implement the CLI**

`cmd/flue/main.go`:

```go
// Command flue runs the flue daemon and opens terminal sessions in the
// browser.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"runtime"
	"syscall"
	"time"

	"github.com/karnstack/flue/internal/config"
	"github.com/karnstack/flue/internal/daemon"
	"github.com/karnstack/flue/internal/session"
	"github.com/karnstack/flue/internal/transport/local"
)

const version = "0.1.0"

const defaultPort = 7717

func main() {
	if len(os.Args) < 2 {
		usage()
		os.Exit(2)
	}
	var err error
	switch os.Args[1] {
	case "serve":
		err = cmdServe(os.Args[2:])
	case "open":
		err = cmdOpen(os.Args[2:])
	case "status":
		err = cmdStatus()
	case "-h", "--help", "help":
		usage()
	default:
		usage()
		os.Exit(2)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "flue:", err)
		os.Exit(1)
	}
}

func usage() {
	fmt.Fprint(os.Stderr, `flue — your terminal, as a browser tab

  flue serve [--port N]   run the daemon in the foreground
  flue open [path]        spawn a session and open it in the browser
  flue status             daemon state and session count
`)
}

func cmdServe(args []string) error {
	fs := flag.NewFlagSet("serve", flag.ExitOnError)
	port := fs.Int("port", defaultPort, "loopback port")
	if err := fs.Parse(args); err != nil {
		return err
	}

	token, err := config.LoadOrCreateToken()
	if err != nil {
		return err
	}

	reg := session.NewRegistry(time.Now)
	srv := daemon.New(reg, local.NewAuth(token, *port), uiHandler(), version)

	if err := daemon.WriteRuntime(*port); err != nil {
		return err
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	fmt.Printf("daemon running on 127.0.0.1:%d\n", *port)
	fmt.Printf("  http://127.0.0.1:%d/?t=%s\n", *port, token)

	err = srv.ListenAndServe(ctx, *port)
	if errors.Is(err, http.ErrServerClosed) {
		return nil
	}
	return err
}

func cmdOpen(args []string) error {
	cwd := ""
	if len(args) > 0 {
		cwd = args[0]
	}
	if cwd == "" {
		var err error
		if cwd, err = os.Getwd(); err != nil {
			return err
		}
	}
	abs, err := os.Stat(cwd)
	if err != nil {
		return err
	}
	if !abs.IsDir() {
		return fmt.Errorf("%s is not a directory", cwd)
	}

	port, err := ensureDaemon()
	if err != nil {
		return err
	}
	token, err := config.LoadOrCreateToken()
	if err != nil {
		return err
	}

	url := fmt.Sprintf("http://127.0.0.1:%d/?t=%s&cwd=%s", port, token, cwd)
	fmt.Println(url)
	return openBrowser(url)
}

func cmdStatus() error {
	port, ok := daemon.ReadRuntime()
	if !ok {
		fmt.Println("daemon: not running")
		return nil
	}
	if !portOpen(port) {
		fmt.Printf("daemon: not running (stale runtime record for port %d)\n", port)
		return nil
	}
	token, err := config.LoadOrCreateToken()
	if err != nil {
		return err
	}

	resp, err := http.Get(fmt.Sprintf("http://127.0.0.1:%d/api/sessions?t=%s", port, token))
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	var body struct {
		Sessions []session.Info `json:"sessions"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		return err
	}

	fmt.Printf("daemon:   running on 127.0.0.1:%d\n", port)
	fmt.Printf("sessions: %d\n", len(body.Sessions))
	for _, s := range body.Sessions {
		fmt.Printf("  %s  %-8s %s\n", s.ID, s.State, s.Cwd)
	}
	return nil
}

// ensureDaemon starts a background daemon if one is not already listening.
func ensureDaemon() (int, error) {
	if port, ok := daemon.ReadRuntime(); ok && portOpen(port) {
		return port, nil
	}

	exe, err := os.Executable()
	if err != nil {
		return 0, err
	}
	cmd := exec.Command(exe, "serve")
	cmd.Stdout, cmd.Stderr = nil, nil
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := cmd.Start(); err != nil {
		return 0, err
	}
	_ = cmd.Process.Release()

	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if port, ok := daemon.ReadRuntime(); ok && portOpen(port) {
			return port, nil
		}
		time.Sleep(50 * time.Millisecond)
	}
	return 0, errors.New("daemon did not start within 5s")
}

func portOpen(port int) bool {
	c, err := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", port), 300*time.Millisecond)
	if err != nil {
		return false
	}
	_ = c.Close()
	return true
}

func openBrowser(url string) error {
	switch runtime.GOOS {
	case "darwin":
		return exec.Command("open", url).Start()
	case "linux":
		return exec.Command("xdg-open", url).Start()
	}
	return fmt.Errorf("cannot open a browser on %s", runtime.GOOS)
}
```

- [ ] **Step 6: Add a temporary UI handler**

Task 11 replaces this with the embedded build. Until then the daemon serves a placeholder so `flue open` is exercisable end to end.

Add to `cmd/flue/main.go`:

```go
func uiHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		fmt.Fprint(w, `<!doctype html><meta charset="utf-8"><title>flue</title>
<p>flue daemon is running. The web UI lands in a later task.</p>`)
	})
}
```

- [ ] **Step 7: Build and smoke-test manually**

```bash
go build ./... && go vet ./...
go run ./cmd/flue serve --port 7717
```

In a second shell:

```bash
go run ./cmd/flue status
```

Expected: `daemon: running on 127.0.0.1:7717` and `sessions: 0`. Stop the daemon with Ctrl-C.

- [ ] **Step 8: Commit**

```bash
git add cmd/flue internal/daemon/discover.go internal/daemon/discover_test.go
git commit -m "feat(cli): add serve, open, and status commands"
```

---

### Task 8: React scaffolding, design tokens, and shadcn

**Files:**
- Create: `web/package.json`
- Create: `web/tsconfig.json`
- Create: `web/vite.config.ts`
- Create: `web/components.json`
- Create: `web/index.html`
- Create: `web/src/styles.css`
- Create: `web/src/lib/utils.ts`
- Test: `web/src/lib/utils.test.ts`

**Interfaces:**
- Consumes: nothing from Go.
- Produces: `cn(...inputs: ClassValue[]): string` from `@/lib/utils`; the `@/*` path alias resolving to `web/src/*`; design tokens declared in `@theme`.

**Design decisions, fixed here and applied everywhere below:**
- Neutral is **zinc**. Never `gray-*` or `slate-*`.
- Accent is **amber**. Used for active nav indicators, focus rings, and the single primary button per screen. Never for body text — amber on dark fails contrast at body sizes.
- Both themes ship, driven by `prefers-color-scheme` via Tailwind's built-in `dark:` behaviour. No manual toggle.
- Terminal colors are a separate concern from chrome colors and are themed inside the emulator.

- [ ] **Step 1: Create the package manifest**

`web/package.json`:

```json
{
  "name": "@karnstack/flue-web",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc --noEmit && vite build",
    "test": "vitest run",
    "test:watch": "vitest",
    "lint": "tsc --noEmit"
  },
  "dependencies": {
    "@heroicons/react": "^2.2.0",
    "@radix-ui/react-slot": "^1.2.0",
    "@tanstack/react-router": "^1.140.0",
    "@xterm/addon-fit": "^0.11.0",
    "@xterm/addon-webgl": "^0.19.0",
    "@xterm/xterm": "^5.6.0",
    "class-variance-authority": "^0.7.1",
    "clsx": "^2.1.1",
    "react": "^19.2.0",
    "react-dom": "^19.2.0",
    "tailwind-merge": "^3.4.0"
  },
  "devDependencies": {
    "@tailwindcss/vite": "^4.2.0",
    "@testing-library/dom": "^10.4.0",
    "@testing-library/react": "^16.3.0",
    "@testing-library/user-event": "^14.6.0",
    "@types/react": "^19.2.0",
    "@types/react-dom": "^19.2.0",
    "@vitejs/plugin-react": "^5.1.0",
    "jsdom": "^27.0.0",
    "tailwindcss": "^4.2.0",
    "typescript": "^5.9.0",
    "vite": "^7.0.0",
    "vitest": "^4.0.0"
  }
}
```

- [ ] **Step 2: Create TypeScript and Vite configuration**

`web/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "jsx": "react-jsx",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noEmit": true,
    "skipLibCheck": true,
    "types": ["vitest/globals"],
    "baseUrl": ".",
    "paths": { "@/*": ["./src/*"] }
  },
  "include": ["src"]
}
```

`web/vite.config.ts`:

```ts
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath, URL } from 'node:url'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  build: { outDir: 'dist', emptyOutDir: true },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test-setup.ts'],
  },
})
```

`web/index.html`:

```html
<!doctype html>
<html lang="en" class="h-full antialiased">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <title>flue</title>
  </head>
  <body class="h-full">
    <div id="root" class="isolate h-full"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

`antialiased` sits on the root element and `isolate` on the app container, both per the general guidelines — `isolate` prevents z-index conflicts once dialogs and popovers portal in.

- [ ] **Step 3: Install dependencies**

```bash
cd web && pnpm install
```

- [ ] **Step 4: Write the design tokens**

`web/src/styles.css`:

```css
@import 'tailwindcss';
@import '@xterm/xterm/css/xterm.css';

/*
 * flue design tokens.
 *
 * Neutral is zinc, never gray or slate. Accent is amber — it carries active
 * nav state, focus rings, and the one primary button per screen, and is
 * never used for body text, where amber on dark would fail contrast.
 *
 * Both themes ship and follow prefers-color-scheme. There is no toggle.
 */
@theme {
  --font-sans:
    'InterVariable', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif;
  --font-mono:
    ui-monospace, 'SFMono-Regular', 'SF Mono', Menlo, Consolas, monospace;

  --color-accent-fg: var(--color-amber-600);
  --color-accent-bg: var(--color-amber-500);
}

@layer base {
  :root {
    /* Surfaces, so a light theme stays a token change rather than a sweep. */
    --flue-canvas: var(--color-white);
    --flue-panel: var(--color-white);
    --flue-line: --alpha(var(--color-zinc-950) / 10%);
    --flue-muted: var(--color-zinc-500);
  }

  @media (prefers-color-scheme: dark) {
    :root {
      --flue-canvas: var(--color-zinc-950);
      /* Cards sit slightly lighter than the canvas, never darker. */
      --flue-panel: var(--color-zinc-900);
      --flue-line: --alpha(var(--color-white) / 10%);
      --flue-muted: var(--color-zinc-400);
      --color-accent-fg: var(--color-amber-400);
    }
  }

  body {
    background-color: var(--flue-canvas);
  }
}

/* The terminal fills its pane; xterm manages its own internal scrolling. */
@utility flue-term-surface {
  block-size: 100%;
  inline-size: 100%;
}
```

Note `--alpha(...)` rather than `calc()` on a spacing variable, and theme variable references rather than raw hex — both required by the Tailwind authoring rules.

- [ ] **Step 5: Initialise shadcn and add the components used below**

```bash
cd web && pnpm dlx shadcn@latest init --base-color zinc --yes
pnpm dlx shadcn@latest add button sheet --yes
```

Only these two. `sheet` provides the mobile navigation panel, which every app needs below `lg:` regardless of the desktop layout. Add further shadcn components when a task actually needs one — pre-installing a component library's worth of unused files makes the tree harder to reason about for no gain.

Verify `web/components.json` records the alias and base colour:

```json
{
  "$schema": "https://ui.shadcn.com/schema.json",
  "style": "new-york",
  "rsc": false,
  "tsx": true,
  "tailwind": {
    "config": "",
    "css": "src/styles.css",
    "baseColor": "zinc",
    "cssVariables": true
  },
  "aliases": { "components": "@/components", "utils": "@/lib/utils" }
}
```

- [ ] **Step 6: Write the failing test**

`web/src/lib/utils.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { cn } from './utils'

describe('cn', () => {
  it('joins class names', () => {
    expect(cn('a', 'b')).toBe('a b')
  })

  it('drops falsy values', () => {
    expect(cn('a', false && 'b', undefined, 'c')).toBe('a c')
  })

  it('lets a later Tailwind class win over an earlier conflicting one', () => {
    expect(cn('p-2', 'p-4')).toBe('p-4')
  })
})
```

- [ ] **Step 7: Add the test setup file**

`web/src/test-setup.ts`:

```ts
import '@testing-library/dom'

// jsdom implements neither of these, and both are exercised by the
// terminal view's resize handling and focus mode.
if (!globalThis.ResizeObserver) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
}

if (!globalThis.matchMedia) {
  globalThis.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof matchMedia
}
```

- [ ] **Step 8: Run the test to verify it fails**

Run: `cd web && pnpm test`
Expected: FAIL — cannot resolve `./utils` if `shadcn init` did not create it.

- [ ] **Step 9: Ensure the utils module exists**

`web/src/lib/utils.ts` (created by `shadcn init`; write it if absent):

```ts
import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
```

- [ ] **Step 10: Run the test to verify it passes**

Run: `cd web && pnpm test`
Expected: PASS, three tests.

- [ ] **Step 11: Commit**

```bash
git add web/package.json web/pnpm-lock.yaml web/tsconfig.json web/vite.config.ts web/index.html web/components.json web/src/styles.css web/src/lib web/src/test-setup.ts
git commit -m "feat(web): scaffold React, Tailwind v4, and shadcn with flue design tokens"
```

---

### Task 9: App shell and router

**Files:**
- Create: `web/src/components/app-shell.tsx`
- Create: `web/src/components/nav.tsx`
- Create: `web/src/router.tsx`
- Create: `web/src/routes/sessions.tsx` (placeholder, filled in Task 13)
- Create: `web/src/routes/terminal.tsx` (placeholder, filled in Task 12)
- Create: `web/src/main.tsx`
- Create: `web/src/test-utils.tsx`
- Test: `web/src/components/nav.test.tsx`
- Test: `web/src/router.test.tsx`

**Interfaces:**
- Consumes: `cn` from Task 8.
- Produces:
  - `NAV_ITEMS: ReadonlyArray<{ to: string; label: string; icon: ComponentType<{ className?: string }> }>`
  - `<Nav currentPath={string} onNavigate?={() => void} />`
  - `<AppShell currentPath={string}>{children}</AppShell>`
  - `createFlueRouter(): Router` with routes `/`, `/sessions`, `/settings`, and `/d/$deviceId/s/$sessionId`

**Layout rationale.** Management routes render inside `AppShell`, which is a sidebar on `lg:` and up and a `Sheet` below it. The terminal route renders bare and full-bleed: a terminal session *is* the tab, so wrapping it in app chrome would contradict the premise of the project.

- [ ] **Step 1: Write the router test helper and the failing nav test**

`Link` requires a router in context, so component tests that render nav links need one. This helper builds a throwaway router whose routes match the real paths, and is reused by any later component test that renders a `Link`.

`web/src/test-utils.tsx`:

```tsx
import type { ReactNode } from 'react'
import { render } from '@testing-library/react'
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router'

/**
 * Render `ui` inside a minimal router. TanStack's Link throws without a
 * router in context, and the real routes pull in the whole app, so this
 * mirrors only the paths the nav links to.
 */
export function renderWithRouter(ui: ReactNode, initialPath = '/sessions') {
  const rootRoute = createRootRoute({ component: () => ui })
  const paths = ['/', '/sessions', '/devices', '/settings']
  const routeTree = rootRoute.addChildren(
    paths.map((path) =>
      createRoute({ getParentRoute: () => rootRoute, path, component: () => null }),
    ),
  )
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [initialPath] }),
  })
  return render(<RouterProvider router={router as never} />)
}
```

`web/src/components/nav.test.tsx`:

```tsx
import { describe, expect, it, vi } from 'vitest'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWithRouter } from '@/test-utils'
import { Nav, NAV_ITEMS } from './nav'

describe('Nav', () => {
  it('renders every nav item', () => {
    renderWithRouter(<Nav currentPath="/sessions" />)
    for (const item of NAV_ITEMS) {
      expect(screen.getByRole('link', { name: item.label })).toBeTruthy()
    }
  })

  it('marks the current route with aria-current', () => {
    renderWithRouter(<Nav currentPath="/sessions" />)
    const current = screen.getByRole('link', { name: 'Sessions' })
    expect(current.getAttribute('aria-current')).toBe('page')
    expect(screen.getByRole('link', { name: 'Settings' }).getAttribute('aria-current')).toBeNull()
  })

  it('never changes font weight between states', () => {
    // Guideline: nav states differ by color and background only. A weight
    // change causes a layout shift and reads as a different element.
    renderWithRouter(<Nav currentPath="/sessions" />)
    const active = screen.getByRole('link', { name: 'Sessions' })
    const inactive = screen.getByRole('link', { name: 'Settings' })
    const weightClass = /font-(thin|light|normal|medium|semibold|bold|extrabold|black)/
    const activeWeight = active.className.match(weightClass)?.[0]
    const inactiveWeight = inactive.className.match(weightClass)?.[0]
    expect(activeWeight).toBe(inactiveWeight)
  })

  it('calls onNavigate when a link is activated, so the mobile sheet can close', async () => {
    const onNavigate = vi.fn()
    renderWithRouter(<Nav currentPath="/sessions" onNavigate={onNavigate} />)
    await userEvent.click(screen.getByRole('link', { name: 'Settings' }))
    expect(onNavigate).toHaveBeenCalled()
  })

  it('renders client-side router links, not full-reload anchors', () => {
    // A plain <a href> would reload the page and drop the WebSocket. This
    // asserts the anchor is router-managed rather than a raw navigation.
    renderWithRouter(<Nav currentPath="/sessions" />)
    const link = screen.getByRole('link', { name: 'Settings' })
    expect(link.getAttribute('href')).toBe('/settings')
    expect(link.hasAttribute('data-status')).toBe(true)
  })
})
```

- [ ] **Step 2: Write the failing router test**

`web/src/router.test.tsx`:

```tsx
import { describe, expect, it } from 'vitest'
import { createFlueRouter } from './router'

describe('createFlueRouter', () => {
  it('matches the sessions route', () => {
    const router = createFlueRouter()
    const match = router.matchRoutes('/sessions', {})
    expect(match.some((m) => m.routeId.includes('sessions'))).toBe(true)
  })

  it('matches a session terminal route and extracts its params', () => {
    const router = createFlueRouter()
    const match = router.matchRoutes('/d/local/s/abc123', {})
    const terminal = match.find((m) => m.routeId.includes('terminal'))
    expect(terminal).toBeDefined()
    expect(terminal!.params).toMatchObject({ deviceId: 'local', sessionId: 'abc123' })
  })

  it('matches the index route', () => {
    const router = createFlueRouter()
    const match = router.matchRoutes('/', {})
    expect(match.length).toBeGreaterThan(0)
  })
})
```

- [ ] **Step 3: Run both tests to verify they fail**

Run: `cd web && pnpm test`
Expected: FAIL — cannot resolve `./nav` or `./router`.

- [ ] **Step 4: Implement the nav**

`web/src/components/nav.tsx`:

```tsx
import type { ComponentType } from 'react'
import { Link } from '@tanstack/react-router'
import { CommandLineIcon, DevicePhoneMobileIcon, Cog6ToothIcon } from '@heroicons/react/16/solid'
import { cn } from '@/lib/utils'

export const NAV_ITEMS = [
  { to: '/sessions', label: 'Sessions', icon: CommandLineIcon },
  { to: '/devices', label: 'Devices', icon: DevicePhoneMobileIcon },
  { to: '/settings', label: 'Settings', icon: Cog6ToothIcon },
] as const satisfies ReadonlyArray<{
  to: string
  label: string
  icon: ComponentType<{ className?: string }>
}>

export interface NavProps {
  currentPath: string
  /** Called after a link is activated, so the mobile sheet can close itself. */
  onNavigate?: () => void
}

export function Nav({ currentPath, onNavigate }: NavProps) {
  return (
    <nav className="flex flex-col gap-y-1">
      <ul role="list" className="flex flex-col gap-y-1">
        {NAV_ITEMS.map((item) => {
          const active = currentPath.startsWith(item.to)
          const Icon = item.icon
          return (
            <li key={item.to}>
              {/*
                TanStack Link, never a plain anchor: a full page reload on
                every nav click would tear down the WebSocket and remount
                the app, which defeats the point of the SPA.
              */}
              <Link
                to={item.to}
                aria-current={active ? 'page' : undefined}
                onClick={onNavigate}
                className={cn(
                  // Font weight is identical in every state. Only color and
                  // background change, per the navigation guidelines.
                  'flex items-center gap-x-2.5 rounded-md px-2.5 py-2 text-base/6 font-medium sm:py-1.5 sm:text-sm/6',
                  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-500',
                  active
                    ? // Muted background plus accent text, never a
                      // high-contrast fill.
                      'bg-amber-500/10 text-amber-700 dark:text-amber-400'
                    : 'text-zinc-600 hover:bg-zinc-950/5 hover:text-zinc-950 dark:text-zinc-400 dark:hover:bg-white/5 dark:hover:text-white',
                )}
              >
                <Icon className="size-4 shrink-0" aria-hidden="true" />
                {item.label}
              </Link>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}
```

- [ ] **Step 5: Implement the app shell**

`web/src/components/app-shell.tsx`:

```tsx
import { useState, type ReactNode } from 'react'
import { Bars3Icon } from '@heroicons/react/16/solid'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from '@/components/ui/sheet'
import { Nav } from './nav'

export interface AppShellProps {
  currentPath: string
  children: ReactNode
}

function Wordmark() {
  return (
    <div className="px-2.5 text-sm/6 font-medium tracking-tight text-zinc-950 dark:text-white">
      flue
    </div>
  )
}

/**
 * Sidebar on lg: and up, a Sheet below it. Every app needs a mobile
 * navigation affordance regardless of the desktop layout, and a
 * multi-column layout must collapse rather than shrink.
 */
export function AppShell({ currentPath, children }: AppShellProps) {
  const [open, setOpen] = useState(false)

  return (
    <div className="flex h-full flex-col lg:flex-row">
      <header className="flex items-center gap-x-3 border-b border-zinc-950/10 p-3 lg:hidden dark:border-white/10">
        <Sheet open={open} onOpenChange={setOpen}>
          <SheetTrigger asChild>
            <Button variant="ghost" size="sm" aria-label="Open navigation">
              <Bars3Icon className="size-4 shrink-0" aria-hidden="true" />
            </Button>
          </SheetTrigger>
          <SheetContent side="left" className="w-64 p-3">
            <SheetTitle className="px-2.5 text-sm/6 font-medium tracking-tight">flue</SheetTitle>
            <div className="mt-4">
              <Nav currentPath={currentPath} onNavigate={() => setOpen(false)} />
            </div>
          </SheetContent>
        </Sheet>
        <Wordmark />
      </header>

      <aside className="hidden w-56 shrink-0 flex-col gap-y-4 border-r border-zinc-950/10 p-3 lg:flex dark:border-white/10">
        <Wordmark />
        <Nav currentPath={currentPath} />
      </aside>

      <main className="min-w-0 flex-1 overflow-y-auto">{children}</main>
    </div>
  )
}
```

`min-w-0` on the main region is required: it is a `flex-1` child beside a fixed-width sidebar and would otherwise refuse to shrink below its content.

- [ ] **Step 6: Implement the router**

`web/src/router.tsx`:

```tsx
import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  useRouterState,
} from '@tanstack/react-router'
import { AppShell } from '@/components/app-shell'
import { SessionsRoute } from '@/routes/sessions'
import { TerminalRoute } from '@/routes/terminal'

const rootRoute = createRootRoute({ component: () => <Outlet /> })

/**
 * Pathless layout for management screens. The terminal deliberately sits
 * outside it: a session is the tab, so app chrome around it would defeat
 * the premise.
 */
const shellRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: 'shell',
  component: function ShellLayout() {
    const pathname = useRouterState({ select: (s) => s.location.pathname })
    return (
      <AppShell currentPath={pathname}>
        <Outlet />
      </AppShell>
    )
  },
})

const indexRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/',
  component: SessionsRoute,
})

const sessionsRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/sessions',
  component: SessionsRoute,
})

/** Thin placeholder so the nav link resolves. Devices and pairing are a
 *  later build step; a Link to a route that does not exist is a type error
 *  and a dead link. */
function Placeholder({ title, blurb }: { title: string; blurb: string }) {
  return (
    <div className="p-4 sm:p-6 lg:p-8">
      <h1 className="text-2xl/8 font-semibold tracking-tight text-zinc-950 sm:text-xl/7 dark:text-white">
        {title}
      </h1>
      <p className="mt-2 max-w-[65ch] text-base/7 text-pretty text-zinc-600 sm:text-sm/6 dark:text-zinc-400">
        {blurb}
      </p>
    </div>
  )
}

const devicesRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/devices',
  component: () => (
    <Placeholder
      title="Devices"
      blurb="Pairing a phone or another laptop arrives once remote transports land."
    />
  ),
})

const settingsRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/settings',
  component: () => (
    <Placeholder
      title="Settings"
      blurb="Scrollback size, keyboard bindings, and themes arrive with the next build step."
    />
  ),
})

const terminalRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/d/$deviceId/s/$sessionId',
  id: 'terminal',
  component: TerminalRoute,
})

const routeTree = rootRoute.addChildren([
  shellRoute.addChildren([indexRoute, sessionsRoute, devicesRoute, settingsRoute]),
  terminalRoute,
])

export function createFlueRouter() {
  return createRouter({ routeTree, defaultPreload: false })
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof createFlueRouter>
  }
}
```

- [ ] **Step 7: Add route placeholders**

`web/src/routes/sessions.tsx`:

```tsx
export function SessionsRoute() {
  return (
    <div className="p-4 sm:p-6 lg:p-8">
      <h1 className="text-2xl/8 font-semibold tracking-tight text-zinc-950 sm:text-xl/7 dark:text-white">
        Sessions
      </h1>
    </div>
  )
}
```

`web/src/routes/terminal.tsx`:

```tsx
export function TerminalRoute() {
  return <div className="h-full" />
}
```

- [ ] **Step 8: Implement the entry point**

`web/src/main.tsx`:

```tsx
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { RouterProvider } from '@tanstack/react-router'
import '@/styles.css'
import { createFlueRouter } from '@/router'
import { stripToken } from '@/lib/url'

// The daemon has already moved the token into an HttpOnly cookie, so drop
// it from the URL before it reaches history or a referrer header.
const cleaned = stripToken(location.href)
if (cleaned !== location.href) history.replaceState(null, '', cleaned)

const router = createFlueRouter()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
)
```

- [ ] **Step 9: Implement the URL helper**

`web/src/lib/url.ts`:

```ts
/**
 * Remove the token from a URL. The daemon moves it into an HttpOnly cookie
 * on first load; the app then calls this and replaceState so the secret
 * stops appearing in history and referrers.
 */
export function stripToken(url: string): string {
  const u = new URL(url)
  if (!u.searchParams.has('t')) return url
  u.searchParams.delete('t')
  const query = u.searchParams.toString()
  return `${u.origin}${u.pathname}${query ? `?${query}` : ''}`
}
```

- [ ] **Step 10: Write the URL helper test**

`web/src/lib/url.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { stripToken } from './url'

describe('stripToken', () => {
  it('removes the token', () => {
    expect(stripToken('http://127.0.0.1:7717/?t=secret')).toBe('http://127.0.0.1:7717/')
  })

  it('preserves other parameters', () => {
    expect(stripToken('http://127.0.0.1:7717/?t=secret&cwd=%2Ftmp')).toBe(
      'http://127.0.0.1:7717/?cwd=%2Ftmp',
    )
  })

  it('leaves a URL without a token untouched', () => {
    expect(stripToken('http://127.0.0.1:7717/d/local/s/abc')).toBe(
      'http://127.0.0.1:7717/d/local/s/abc',
    )
  })
})
```

- [ ] **Step 11: Run the tests to verify they pass**

Run: `cd web && pnpm test`
Expected: PASS — nav, router, url, and utils suites.

- [ ] **Step 12: Type-check**

Run: `cd web && pnpm lint`
Expected: no TypeScript errors.

- [ ] **Step 13: Commit**

```bash
git add web/src/components web/src/router.tsx web/src/routes web/src/main.tsx web/src/lib
git commit -m "feat(web): add app shell, navigation, and TanStack Router routes"
```

---

### Task 10: Emulator seam, xterm.js, and the VT conformance corpus

**Files:**
- Create: `web/src/emulator/types.ts`
- Create: `web/src/emulator/xterm.ts`
- Create: `testdata/vt/basic.json`
- Test: `web/src/emulator/emulator.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `Grid = { cols: number; rows: number; lines: string[] }` — `lines` has `rows` entries, trailing whitespace trimmed
  - `Emulator` with `write(bytes: Uint8Array)`, `resize(cols, rows)`, `snapshot(): Grid`, `onData(cb: (bytes: Uint8Array) => void)`, `attachTo(el: HTMLElement)`, `dispose()`, `injectForTest(data: string)`
  - `createXtermEmulator(opts?: { cols?: number; rows?: number }): Emulator`

The corpus is the point of this task. It runs against xterm.js today and `libghostty-vt` later, which is what turns that swap into a substitution rather than a rewrite.

- [ ] **Step 1: Write the VT conformance corpus**

`testdata/vt/basic.json`:

```json
[
  {
    "name": "plain text",
    "cols": 20,
    "rows": 3,
    "input": "hello",
    "lines": ["hello", "", ""]
  },
  {
    "name": "newline and carriage return",
    "cols": 20,
    "rows": 3,
    "input": "one\r\ntwo",
    "lines": ["one", "two", ""]
  },
  {
    "name": "carriage return overwrites",
    "cols": 20,
    "rows": 2,
    "input": "abcdef\rXY",
    "lines": ["XYcdef", ""]
  },
  {
    "name": "backspace",
    "cols": 20,
    "rows": 2,
    "input": "abc\b\bZ",
    "lines": ["aZc", ""]
  },
  {
    "name": "erase in line",
    "cols": 20,
    "rows": 2,
    "input": "abcdef\r[2C[K",
    "lines": ["ab", ""]
  },
  {
    "name": "clear screen and home",
    "cols": 20,
    "rows": 3,
    "input": "junk\r\nmore[2J[H",
    "lines": ["", "", ""]
  },
  {
    "name": "cursor position",
    "cols": 20,
    "rows": 3,
    "input": "[2;3Hxy",
    "lines": ["", "  xy", ""]
  },
  {
    "name": "sgr attributes do not alter text",
    "cols": 20,
    "rows": 2,
    "input": "[1;31mred[0m done",
    "lines": ["red done", ""]
  },
  {
    "name": "wrap at column boundary",
    "cols": 5,
    "rows": 3,
    "input": "abcdefgh",
    "lines": ["abcde", "fgh", ""]
  },
  {
    "name": "wide characters occupy two cells",
    "cols": 10,
    "rows": 2,
    "input": "日本語",
    "lines": ["日本語", ""]
  },
  {
    "name": "osc title is not rendered",
    "cols": 20,
    "rows": 2,
    "input": "]0;window titlevisible",
    "lines": ["visible", ""]
  },
  {
    "name": "tab advances to the next stop",
    "cols": 20,
    "rows": 2,
    "input": "a\tb",
    "lines": ["a       b", ""]
  }
]
```

- [ ] **Step 2: Write the failing test**

`web/src/emulator/emulator.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createXtermEmulator } from './xterm'

interface Case {
  name: string
  cols: number
  rows: number
  input: string
  lines: string[]
}

const corpus: Case[] = JSON.parse(
  readFileSync(resolve(__dirname, '../../../testdata/vt/basic.json'), 'utf8'),
)

const encode = (s: string) => new TextEncoder().encode(s)

describe('VT conformance corpus', () => {
  // Deliberately emulator-agnostic: this suite runs against xterm.js today
  // and against libghostty-vt later, which is what makes that swap a
  // substitution rather than a rewrite.
  for (const c of corpus) {
    it(c.name, async () => {
      const em = createXtermEmulator({ cols: c.cols, rows: c.rows })
      em.write(encode(c.input))
      await new Promise((r) => setTimeout(r, 20))

      const grid = em.snapshot()
      expect(grid.cols).toBe(c.cols)
      expect(grid.rows).toBe(c.rows)
      expect(grid.lines).toEqual(c.lines)

      em.dispose()
    })
  }
})

describe('Emulator interface', () => {
  it('reports resized dimensions in the snapshot', () => {
    const em = createXtermEmulator({ cols: 10, rows: 4 })
    em.resize(30, 12)
    const grid = em.snapshot()
    expect(grid.cols).toBe(30)
    expect(grid.rows).toBe(12)
    em.dispose()
  })

  it('delivers typed input to the onData callback as bytes', () => {
    const em = createXtermEmulator({ cols: 10, rows: 4 })
    const seen: Uint8Array[] = []
    em.onData((b) => seen.push(b))

    em.injectForTest('x')

    expect(seen.length).toBe(1)
    expect(new TextDecoder().decode(seen[0]!)).toBe('x')
    em.dispose()
  })
})
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd web && pnpm test`
Expected: FAIL — cannot resolve `./xterm`.

- [ ] **Step 4: Define the Emulator interface**

`web/src/emulator/types.ts`:

```ts
/** A rendered snapshot of the terminal grid, used by tests and by reattach. */
export interface Grid {
  cols: number
  rows: number
  /** One entry per row, trailing whitespace trimmed. */
  lines: string[]
}

/**
 * The narrow seam between flue and whatever emulates the terminal.
 *
 * xterm.js implements this today. libghostty-vt is expected to implement it
 * later, with a WebGL renderer, and nothing outside this directory should
 * need to change when it does — so keep this interface small and free of
 * xterm-specific concepts.
 */
export interface Emulator {
  /** Feed bytes received from the daemon. */
  write(bytes: Uint8Array): void
  /** Change the rendered dimensions. */
  resize(cols: number, rows: number): void
  /** Capture the current grid. */
  snapshot(): Grid
  /** Register a callback for user input, encoded as bytes. */
  onData(cb: (bytes: Uint8Array) => void): void
  /** Mount into the DOM. */
  attachTo(el: HTMLElement): void
  /** Release all resources. */
  dispose(): void
  /** Test-only: simulate user input. */
  injectForTest(data: string): void
}
```

- [ ] **Step 5: Implement the xterm.js emulator**

`web/src/emulator/xterm.ts`:

```ts
import { Terminal } from '@xterm/xterm'
import type { Emulator, Grid } from './types'

export interface XtermOptions {
  cols?: number
  rows?: number
}

/**
 * xterm.js behind the Emulator seam. The WebGL addon loads lazily inside
 * attachTo because it needs a real canvas and would fail under jsdom.
 */
export function createXtermEmulator(opts: XtermOptions = {}): Emulator {
  const term = new Terminal({
    cols: opts.cols ?? 80,
    rows: opts.rows ?? 24,
    allowProposedApi: true,
    convertEol: false,
    scrollback: 10_000,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    fontSize: 13,
  })

  const encoder = new TextEncoder()
  let disposed = false

  return {
    write(bytes: Uint8Array) {
      term.write(bytes)
    },

    resize(cols: number, rows: number) {
      term.resize(cols, rows)
    },

    snapshot(): Grid {
      const buf = term.buffer.active
      const lines: string[] = []
      for (let y = 0; y < term.rows; y++) {
        const line = buf.getLine(buf.viewportY + y)
        lines.push(line ? line.translateToString(true).replace(/\s+$/, '') : '')
      }
      return { cols: term.cols, rows: term.rows, lines }
    },

    onData(cb: (bytes: Uint8Array) => void) {
      term.onData((data) => cb(encoder.encode(data)))
    },

    attachTo(el: HTMLElement) {
      term.open(el)
      // Best-effort GPU rendering; the DOM renderer is a fine fallback.
      void import('@xterm/addon-webgl')
        .then(({ WebglAddon }) => {
          if (!disposed) term.loadAddon(new WebglAddon())
        })
        .catch(() => {})
    },

    dispose() {
      disposed = true
      term.dispose()
    },

    injectForTest(data: string) {
      term.input(data, true)
    },
  }
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd web && pnpm test`
Expected: PASS — twelve corpus cases plus two interface tests. If a corpus expectation disagrees with xterm's real behaviour, fix the **corpus**, not the emulator: the corpus describes correct VT behaviour, and a genuine xterm bug belongs in the file as a skipped case with a comment rather than being papered over.

- [ ] **Step 7: Commit**

```bash
git add web/src/emulator testdata/vt/basic.json
git commit -m "feat(web): add Emulator seam, xterm.js implementation, and VT corpus"
```

---

### Task 11: Protocol client and React hook

**Files:**
- Create: `web/src/client/protocol.ts`
- Create: `web/src/client/client.ts`
- Create: `web/src/client/provider.tsx`
- Modify: `web/src/main.tsx` (wrap the router in the provider)
- Test: `web/src/client/client.test.ts`

**Interfaces:**
- Consumes: `testdata/wire/control.json` from Task 4.
- Produces:
  - `encodeBinary(type: number, ref: number, payload: Uint8Array): ArrayBuffer`
  - `decodeBinary(buf: ArrayBuffer): { type: number; ref: number; payload: Uint8Array }`
  - `FRAME_OUTPUT = 0x00`, `FRAME_INPUT = 0x01`
  - TypeScript types for every control message in `spec/protocol.md`
  - `class FlueClient` with `connect()`, `close()`, `list()`, `spawn(opts)`, `attach(id, lastSeq)`, `detach(ref)`, `sendInput(ref, bytes)`, `resize(ref, cols, rows, primary)`, `lastSeqFor(ref)`
  - Event registration: `onOutput`, `onAttached`, `onExit`, `onSizeChanged`, `onSessions`, `onError`, `onStatus`. **Each one appends a listener and returns an unsubscribe function.** They must never overwrite a previously registered listener — a silent replace is invisible at the call site and costs an afternoon to find.
  - `<FlueClientProvider>{children}</FlueClientProvider>` and `useFlueClient(): FlueClient` reading it from context

`FlueClient` takes an injected socket factory so tests need no real server.

**One client per browser tab, not per component.** The client lives in a React context provider mounted above the router, so a single WebSocket serves every route. A per-component client would open a fresh socket on each navigation, and two components rendering at once would open two.

- [ ] **Step 1: Write the failing test**

`web/src/client/client.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { decodeBinary, encodeBinary, FRAME_INPUT, FRAME_OUTPUT } from './protocol'
import { FlueClient, type SocketLike } from './client'

/** A scriptable stand-in for WebSocket. */
class FakeSocket implements SocketLike {
  sent: Array<string | ArrayBuffer> = []
  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onmessage: ((data: string | ArrayBuffer) => void) | null = null

  send(data: string | ArrayBuffer) {
    this.sent.push(data)
  }
  close() {
    this.onclose?.()
  }

  open() {
    this.onopen?.()
  }
  emitControl(msg: unknown) {
    this.onmessage?.(JSON.stringify(msg))
  }
  emitBinary(type: number, ref: number, text: string) {
    this.onmessage?.(encodeBinary(type, ref, new TextEncoder().encode(text)))
  }
  sentControl(): any[] {
    return this.sent.filter((s): s is string => typeof s === 'string').map((s) => JSON.parse(s))
  }
}

describe('binary framing', () => {
  it('round-trips', () => {
    const buf = encodeBinary(FRAME_OUTPUT, 7, new TextEncoder().encode('hi'))
    const got = decodeBinary(buf)
    expect(got.type).toBe(FRAME_OUTPUT)
    expect(got.ref).toBe(7)
    expect(new TextDecoder().decode(got.payload)).toBe('hi')
  })

  it('writes ref big-endian, matching the Go implementation', () => {
    const buf = encodeBinary(FRAME_INPUT, 0x01020304, new Uint8Array())
    expect([...new Uint8Array(buf)]).toEqual([FRAME_INPUT, 1, 2, 3, 4])
  })

  it('rejects a short frame', () => {
    expect(() => decodeBinary(new Uint8Array([0, 1, 2]).buffer)).toThrow()
  })
})

describe('control message golden file', () => {
  // The same fixture the Go suite decodes, so the two cannot drift.
  const cases: Array<{ name: string; json: any }> = JSON.parse(
    readFileSync(resolve(__dirname, '../../../testdata/wire/control.json'), 'utf8'),
  )

  it('has cases', () => {
    expect(cases.length).toBeGreaterThan(0)
  })

  for (const c of cases) {
    it(`${c.name} has a known type discriminator`, () => {
      const known = new Set([
        'hello', 'list', 'spawn', 'attach', 'detach', 'resize', 'signal', 'close',
        'welcome', 'sessions', 'attached', 'exit', 'sizeChanged', 'error',
      ])
      expect(known.has(c.json.type)).toBe(true)
    })
  }
})

function connected(): { c: FlueClient; sock: FakeSocket } {
  const sock = new FakeSocket()
  const c = new FlueClient('ws://127.0.0.1:7717/ws', () => sock)
  c.connect()
  sock.open()
  return { c, sock }
}

describe('FlueClient', () => {
  it('sends hello on connect', () => {
    const { sock } = connected()
    expect(sock.sentControl()[0].type).toBe('hello')
  })

  it('emits output and tracks lastSeq', () => {
    const { c, sock } = connected()
    const chunks: string[] = []
    c.onOutput((_ref, bytes) => chunks.push(new TextDecoder().decode(bytes)))

    sock.emitControl({ type: 'attached', ref: 1, id: 's1', cols: 80, rows: 24, title: '', seq: 100, truncated: false, primary: true })
    sock.emitBinary(FRAME_OUTPUT, 1, 'abc')

    expect(chunks).toEqual(['abc'])
    expect(c.lastSeqFor(1)).toBe(103)
  })

  it('reports truncated so the view can reset the emulator', () => {
    const { c, sock } = connected()
    const seen: boolean[] = []
    c.onAttached((a) => seen.push(a.truncated))

    sock.emitControl({ type: 'attached', ref: 1, id: 's1', cols: 80, rows: 24, title: '', seq: 5000, truncated: true, primary: false })

    expect(seen).toEqual([true])
    expect(c.lastSeqFor(1)).toBe(5000)
  })

  it('reattaches with lastSeq after a reconnect', async () => {
    vi.useFakeTimers()
    const sockets: FakeSocket[] = []
    const c = new FlueClient('ws://127.0.0.1:7717/ws', () => {
      const s = new FakeSocket()
      sockets.push(s)
      return s
    })

    c.connect()
    sockets[0]!.open()
    c.attach('s1', 0)
    sockets[0]!.emitControl({ type: 'attached', ref: 1, id: 's1', cols: 80, rows: 24, title: '', seq: 0, truncated: false, primary: true })
    sockets[0]!.emitBinary(FRAME_OUTPUT, 1, 'hello')
    expect(c.lastSeqFor(1)).toBe(5)

    sockets[0]!.close()
    await vi.advanceTimersByTimeAsync(2000)
    expect(sockets.length).toBeGreaterThan(1)
    sockets[1]!.open()

    const attach = sockets[1]!.sentControl().find((m) => m.type === 'attach')
    expect(attach).toBeDefined()
    expect(attach.id).toBe('s1')
    expect(attach.lastSeq).toBe(5)

    vi.useRealTimers()
  })

  it('backs off exponentially between reconnect attempts', async () => {
    vi.useFakeTimers()
    const sockets: FakeSocket[] = []
    const c = new FlueClient('ws://127.0.0.1:7717/ws', () => {
      const s = new FakeSocket()
      sockets.push(s)
      return s
    })

    c.connect()
    sockets[0]!.open()
    sockets[0]!.close()

    await vi.advanceTimersByTimeAsync(100)
    const afterFirst = sockets.length
    sockets[afterFirst - 1]!.close()

    await vi.advanceTimersByTimeAsync(100)
    // The second delay must exceed the first, so no new socket yet.
    expect(sockets.length).toBe(afterFirst)

    await vi.advanceTimersByTimeAsync(5000)
    expect(sockets.length).toBeGreaterThan(afterFirst)

    vi.useRealTimers()
  })

  it('encodes input as a binary frame', () => {
    const { c, sock } = connected()
    c.sendInput(3, new TextEncoder().encode('k'))

    const bin = sock.sent.find((s): s is ArrayBuffer => typeof s !== 'string')
    expect(bin).toBeDefined()
    const got = decodeBinary(bin!)
    expect(got.type).toBe(FRAME_INPUT)
    expect(got.ref).toBe(3)
    expect(new TextDecoder().decode(got.payload)).toBe('k')
  })

  it('surfaces server errors', () => {
    const { c, sock } = connected()
    const errs: string[] = []
    c.onError((e) => errs.push(e.code))
    sock.emitControl({ type: 'error', code: 'not_found', msg: 'no such session' })
    expect(errs).toEqual(['not_found'])
  })

  it('delivers to every registered listener, never just the last one', () => {
    // A single-slot callback would silently drop the first listener, which
    // is invisible at the call site.
    const { c, sock } = connected()
    const first: string[] = []
    const second: string[] = []
    c.onError((e) => first.push(e.code))
    c.onError((e) => second.push(e.code))

    sock.emitControl({ type: 'error', code: 'not_found', msg: 'no such session' })

    expect(first).toEqual(['not_found'])
    expect(second).toEqual(['not_found'])
  })

  it('stops delivering after unsubscribe', () => {
    const { c, sock } = connected()
    const seen: string[] = []
    const off = c.onError((e) => seen.push(e.code))

    sock.emitControl({ type: 'error', code: 'first', msg: '' })
    off()
    sock.emitControl({ type: 'error', code: 'second', msg: '' })

    expect(seen).toEqual(['first'])
  })

  it('exposes the session list', () => {
    const { c, sock } = connected()
    const seen: string[][] = []
    c.onSessions((list) => seen.push(list.map((s) => s.id)))
    sock.emitControl({
      type: 'sessions',
      sessions: [
        { id: 's1', title: 'zsh', cwd: '/tmp', cmd: ['zsh'], state: 'running', exitCode: 0, cols: 80, rows: 24, lastActive: '2026-07-28T00:00:00Z' },
      ],
    })
    expect(seen).toEqual([['s1']])
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd web && pnpm test`
Expected: FAIL — cannot resolve `./protocol`.

- [ ] **Step 3: Implement the protocol module**

`web/src/client/protocol.ts`:

```ts
export const FRAME_OUTPUT = 0x00
export const FRAME_INPUT = 0x01

const HEADER_LEN = 5

/** Build a binary data frame: [1B type][4B ref BE][payload]. */
export function encodeBinary(type: number, ref: number, payload: Uint8Array): ArrayBuffer {
  const out = new Uint8Array(HEADER_LEN + payload.length)
  out[0] = type
  new DataView(out.buffer).setUint32(1, ref, false) // big-endian
  out.set(payload, HEADER_LEN)
  return out.buffer
}

export function decodeBinary(buf: ArrayBuffer): {
  type: number
  ref: number
  payload: Uint8Array
} {
  if (buf.byteLength < HEADER_LEN) throw new Error('flue: frame shorter than header')
  const view = new DataView(buf)
  const type = view.getUint8(0)
  if (type !== FRAME_OUTPUT && type !== FRAME_INPUT) {
    throw new Error(`flue: unknown frame type 0x${type.toString(16)}`)
  }
  return {
    type,
    ref: view.getUint32(1, false),
    payload: new Uint8Array(buf, HEADER_LEN),
  }
}

// Control messages, mirroring spec/protocol.md exactly. The shared golden
// fixture in testdata/wire/control.json keeps them honest against Go.

export interface SessionInfo {
  id: string
  title: string
  cwd: string
  cmd: string[]
  state: 'running' | 'exited'
  exitCode: number
  cols: number
  rows: number
  lastActive: string
}

export interface Welcome { type: 'welcome'; daemonId: string; host: string; ver: string }
export interface Sessions { type: 'sessions'; sessions: SessionInfo[] }
export interface Attached {
  type: 'attached'
  ref: number
  id: string
  cols: number
  rows: number
  title: string
  seq: number
  truncated: boolean
  primary: boolean
}
export interface Exit { type: 'exit'; ref: number; code: number }
export interface SizeChanged {
  type: 'sizeChanged'
  ref: number
  cols: number
  rows: number
  primary: boolean
}
export interface ErrorMsg { type: 'error'; code: string; msg: string }

export type ServerMessage = Welcome | Sessions | Attached | Exit | SizeChanged | ErrorMsg
```

- [ ] **Step 4: Implement the client**

`web/src/client/client.ts`:

```ts
import {
  decodeBinary,
  encodeBinary,
  FRAME_INPUT,
  FRAME_OUTPUT,
  type Attached,
  type ErrorMsg,
  type ServerMessage,
  type SessionInfo,
  type SizeChanged,
} from './protocol'

/** The subset of WebSocket the client needs, so tests can substitute one. */
export interface SocketLike {
  send(data: string | ArrayBuffer): void
  close(): void
  onopen: (() => void) | null
  onclose: (() => void) | null
  onmessage: ((data: string | ArrayBuffer) => void) | null
}

export type ConnStatus = 'connecting' | 'open' | 'reconnecting' | 'closed'

interface Attachment {
  id: string
  lastSeq: number
}

const BACKOFF_BASE_MS = 250
const BACKOFF_MAX_MS = 10_000

type Listener<T extends unknown[]> = (...args: T) => void

/**
 * A set of listeners. Registration appends and returns an unsubscribe —
 * never a single slot that a second registration would silently overwrite,
 * which is invisible at the call site.
 */
class Emitter<T extends unknown[]> {
  private listeners = new Set<Listener<T>>()

  add(cb: Listener<T>): () => void {
    this.listeners.add(cb)
    return () => {
      this.listeners.delete(cb)
    }
  }

  emit(...args: T) {
    // Copy first: a listener may unsubscribe itself while we iterate.
    for (const cb of [...this.listeners]) cb(...args)
  }
}

/**
 * FlueClient owns the socket, the reconnect loop, and per-attachment seq
 * tracking. It knows nothing about React or the DOM.
 */
export class FlueClient {
  private sock: SocketLike | null = null
  private attempt = 0
  private stopped = false
  private attachments = new Map<number, Attachment>()
  /** Sessions to reattach after a reconnect, keyed by session ID. */
  private wanted = new Map<string, number>()

  private output = new Emitter<[number, Uint8Array]>()
  private attached = new Emitter<[Attached]>()
  private exited = new Emitter<[number, number]>()
  private sized = new Emitter<[SizeChanged]>()
  private sessions = new Emitter<[SessionInfo[]]>()
  private errors = new Emitter<[ErrorMsg]>()
  private status = new Emitter<[ConnStatus]>()

  constructor(
    private url: string,
    private factory: (url: string) => SocketLike = (u) => {
      const ws = new WebSocket(u)
      ws.binaryType = 'arraybuffer'
      const wrapper: SocketLike = {
        send: (d) => ws.send(d),
        close: () => ws.close(),
        onopen: null,
        onclose: null,
        onmessage: null,
      }
      ws.onopen = () => wrapper.onopen?.()
      ws.onclose = () => wrapper.onclose?.()
      ws.onmessage = (e) => wrapper.onmessage?.(e.data)
      return wrapper
    },
  ) {}

  // Every registration appends and returns an unsubscribe. Callers in
  // React effects must call it on cleanup.
  onOutput(cb: (ref: number, bytes: Uint8Array) => void) { return this.output.add(cb) }
  onAttached(cb: (a: Attached) => void) { return this.attached.add(cb) }
  onExit(cb: (ref: number, code: number) => void) { return this.exited.add(cb) }
  onSizeChanged(cb: (m: SizeChanged) => void) { return this.sized.add(cb) }
  onSessions(cb: (s: SessionInfo[]) => void) { return this.sessions.add(cb) }
  onError(cb: (e: ErrorMsg) => void) { return this.errors.add(cb) }
  onStatus(cb: (s: ConnStatus) => void) { return this.status.add(cb) }

  /** Byte offset this client has consumed for an attachment ref. */
  lastSeqFor(ref: number): number | undefined {
    return this.attachments.get(ref)?.lastSeq
  }

  connect() {
    this.stopped = false
    this.status.emit(this.attempt === 0 ? 'connecting' : 'reconnecting')

    const sock = this.factory(this.url)
    this.sock = sock

    sock.onopen = () => {
      this.attempt = 0
      this.status.emit('open')
      this.sendControl({ type: 'hello', ver: '0.1.0', caps: ['binary'] })
      // Reattach everything we had, from where we left off.
      for (const [id, lastSeq] of this.wanted) {
        this.sendControl({ type: 'attach', id, lastSeq })
      }
    }

    sock.onclose = () => {
      this.sock = null
      this.attachments.clear()
      if (this.stopped) {
        this.status.emit('closed')
        return
      }
      this.status.emit('reconnecting')
      const delay = Math.min(BACKOFF_BASE_MS * 2 ** this.attempt, BACKOFF_MAX_MS)
      this.attempt++
      // Full jitter, so many tabs reconnecting do not synchronise.
      setTimeout(() => this.connect(), delay * (0.5 + Math.random() * 0.5))
    }

    sock.onmessage = (data) => {
      if (typeof data === 'string') {
        this.handleControl(JSON.parse(data) as ServerMessage)
        return
      }
      const { type, ref, payload } = decodeBinary(data)
      if (type !== FRAME_OUTPUT) return
      const a = this.attachments.get(ref)
      if (a) a.lastSeq += payload.length
      this.output.emit(ref, payload)
    }
  }

  close() {
    this.stopped = true
    this.sock?.close()
  }

  list() { this.sendControl({ type: 'list' }) }

  spawn(opts: { cwd?: string; cmd?: string[]; cols: number; rows: number }) {
    this.sendControl({ type: 'spawn', ...opts })
  }

  attach(id: string, lastSeq = 0) {
    this.wanted.set(id, lastSeq)
    this.sendControl({ type: 'attach', id, lastSeq })
  }

  detach(ref: number) {
    const a = this.attachments.get(ref)
    if (a) this.wanted.delete(a.id)
    this.attachments.delete(ref)
    this.sendControl({ type: 'detach', ref })
  }

  sendInput(ref: number, bytes: Uint8Array) {
    this.sock?.send(encodeBinary(FRAME_INPUT, ref, bytes))
  }

  resize(ref: number, cols: number, rows: number, primary: boolean) {
    this.sendControl({ type: 'resize', ref, cols, rows, primary })
  }

  private sendControl(msg: Record<string, unknown>) {
    this.sock?.send(JSON.stringify(msg))
  }

  private handleControl(msg: ServerMessage) {
    switch (msg.type) {
      case 'attached': {
        // seq is the offset of the first byte we are about to receive, so
        // it is the right starting point whether this is a delta or a
        // post-eviction snapshot.
        this.attachments.set(msg.ref, { id: msg.id, lastSeq: msg.seq })
        this.wanted.set(msg.id, msg.seq)
        this.attached.emit(msg)
        break
      }
      case 'sessions':
        this.sessions.emit(msg.sessions)
        break
      case 'exit':
        this.exited.emit(msg.ref, msg.code)
        break
      case 'sizeChanged':
        this.sized.emit(msg)
        break
      case 'error':
        this.errors.emit(msg)
        break
      case 'welcome':
        break
    }
  }
}
```

- [ ] **Step 5: Implement the provider and hook**

`web/src/client/provider.tsx`:

```tsx
import { createContext, useContext, useEffect, useRef, type ReactNode } from 'react'
import { FlueClient } from './client'

const FlueClientContext = createContext<FlueClient | null>(null)

/**
 * One client per browser tab, mounted above the router so a single
 * WebSocket serves every route. A per-component client would open a fresh
 * socket on every navigation, and two components rendering at once would
 * open two.
 */
export function FlueClientProvider({ children }: { children: ReactNode }) {
  const ref = useRef<FlueClient | null>(null)

  if (ref.current === null) {
    const scheme = location.protocol === 'https:' ? 'wss' : 'ws'
    ref.current = new FlueClient(`${scheme}://${location.host}/ws`)
  }

  useEffect(() => {
    const client = ref.current!
    client.connect()
    // Closing on unmount means a tab close detaches cleanly while the
    // daemon keeps the PTY running.
    return () => client.close()
  }, [])

  return <FlueClientContext.Provider value={ref.current}>{children}</FlueClientContext.Provider>
}

export function useFlueClient(): FlueClient {
  const client = useContext(FlueClientContext)
  if (!client) throw new Error('useFlueClient must be used inside FlueClientProvider')
  return client
}
```

- [ ] **Step 6: Mount the provider above the router**

Modify `web/src/main.tsx` so the router renders inside the provider. The whole tab then shares one socket:

```tsx
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { RouterProvider } from '@tanstack/react-router'
import '@/styles.css'
import { createFlueRouter } from '@/router'
import { FlueClientProvider } from '@/client/provider'
import { stripToken } from '@/lib/url'

// The daemon has already moved the token into an HttpOnly cookie, so drop
// it from the URL before it reaches history or a referrer header.
const cleaned = stripToken(location.href)
if (cleaned !== location.href) history.replaceState(null, '', cleaned)

const router = createFlueRouter()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <FlueClientProvider>
      <RouterProvider router={router} />
    </FlueClientProvider>
  </StrictMode>,
)
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `cd web && pnpm test`
Expected: PASS — framing, golden-file, and all `FlueClient` tests, including the two listener tests.

- [ ] **Step 8: Type-check**

Run: `cd web && pnpm lint`
Expected: no TypeScript errors.

- [ ] **Step 9: Commit**

```bash
git add web/src/client web/src/main.tsx
git commit -m "feat(web): add protocol client with reconnect, seq tracking, and shared provider"
```

---

### Task 12: Terminal route and keyboard modes

**Files:**
- Create: `web/src/lib/keyboard.ts`
- Create: `web/src/components/terminal.tsx`
- Modify: `web/src/routes/terminal.tsx`
- Test: `web/src/lib/keyboard.test.ts`

**Interfaces:**
- Consumes: `Emulator` (Task 10), `FlueClient` and `useFlueClient` (Task 11).
- Produces:
  - `createKeyboardModes(el: HTMLElement): { mode(): 'tab' | 'focus'; enterFocus(): Promise<void>; exitFocus(): Promise<void> }`
  - `<Terminal sessionId?: string; cwd?: string />`

- [ ] **Step 1: Write the failing keyboard test**

`web/src/lib/keyboard.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createKeyboardModes } from './keyboard'

describe('createKeyboardModes', () => {
  let el: HTMLElement

  beforeEach(() => {
    el = document.createElement('div')
    document.body.appendChild(el)
  })

  it('starts in tab mode, where the browser keeps Cmd+*', () => {
    const k = createKeyboardModes(el)
    expect(k.mode()).toBe('tab')
  })

  it('requests fullscreen and keyboard lock when entering focus mode', async () => {
    const requestFullscreen = vi.fn().mockResolvedValue(undefined)
    const lock = vi.fn().mockResolvedValue(undefined)
    el.requestFullscreen = requestFullscreen
    Object.defineProperty(navigator, 'keyboard', {
      value: { lock, unlock: vi.fn() },
      configurable: true,
    })

    const k = createKeyboardModes(el)
    await k.enterFocus()

    expect(requestFullscreen).toHaveBeenCalled()
    expect(lock).toHaveBeenCalled()
    expect(k.mode()).toBe('focus')
  })

  it('stays in tab mode when the Keyboard Lock API is unavailable', async () => {
    el.requestFullscreen = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'keyboard', { value: undefined, configurable: true })

    const k = createKeyboardModes(el)
    await k.enterFocus()

    expect(k.mode()).toBe('tab')
  })

  it('releases the lock when leaving focus mode', async () => {
    const unlock = vi.fn()
    el.requestFullscreen = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'keyboard', {
      value: { lock: vi.fn().mockResolvedValue(undefined), unlock },
      configurable: true,
    })
    document.exitFullscreen = vi.fn().mockResolvedValue(undefined)

    const k = createKeyboardModes(el)
    await k.enterFocus()
    await k.exitFocus()

    expect(unlock).toHaveBeenCalled()
    expect(k.mode()).toBe('tab')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd web && pnpm test`
Expected: FAIL — cannot resolve `./keyboard`.

- [ ] **Step 3: Implement keyboard modes**

`web/src/lib/keyboard.ts`:

```ts
export type KeyboardMode = 'tab' | 'focus'

interface KeyboardLock {
  lock(keys?: string[]): Promise<void>
  unlock(): void
}

/**
 * Two modes, because browsers reserve Cmd+W, Cmd+T, Cmd+L, and Ctrl+Tab and
 * a page cannot preventDefault them.
 *
 * - tab mode: the browser keeps its shortcuts, so tab groups, tab search,
 *   and switching all work. This is the default, and the reason flue lives
 *   in a browser at all.
 * - focus mode: fullscreen plus navigator.keyboard.lock(), so the terminal
 *   receives every key. Chromium's hold-Esc gesture remains the way out.
 */
export function createKeyboardModes(el: HTMLElement) {
  let mode: KeyboardMode = 'tab'

  const keyboard = (): KeyboardLock | undefined =>
    (navigator as Navigator & { keyboard?: KeyboardLock }).keyboard

  async function enterFocus(): Promise<void> {
    const kb = keyboard()
    if (!kb?.lock) {
      // Without Keyboard Lock there is no point going fullscreen: the
      // browser would still swallow Cmd+W, so we would lose tab mode's
      // benefits and gain nothing.
      return
    }
    try {
      await el.requestFullscreen()
      await kb.lock()
      mode = 'focus'
    } catch {
      mode = 'tab'
    }
  }

  async function exitFocus(): Promise<void> {
    keyboard()?.unlock?.()
    try {
      if (document.fullscreenElement) await document.exitFullscreen()
    } catch {
      // Already out of fullscreen; nothing to do.
    }
    mode = 'tab'
  }

  document.addEventListener('fullscreenchange', () => {
    if (!document.fullscreenElement && mode === 'focus') {
      keyboard()?.unlock?.()
      mode = 'tab'
    }
  })

  return { mode: () => mode, enterFocus, exitFocus }
}
```

- [ ] **Step 4: Implement the terminal component**

`web/src/components/terminal.tsx`:

```tsx
import { useEffect, useRef, useState } from 'react'
import { FitAddon } from '@xterm/addon-fit'
import { createXtermEmulator } from '@/emulator/xterm'
import type { Emulator } from '@/emulator/types'
import { useFlueClient } from '@/client/provider'
import { createKeyboardModes } from '@/lib/keyboard'
import { cn } from '@/lib/utils'

export interface TerminalProps {
  /** Attach to this session, or spawn a new one when absent. */
  sessionId?: string
  cwd?: string
}

/**
 * Full-bleed terminal. Applies the resize policy: the primary client owns
 * the PTY dimensions, and everyone else scales the primary's grid to fit —
 * which is what stops a phone at 40 columns from shrinking a laptop's view.
 */
export function Terminal({ sessionId, cwd }: TerminalProps) {
  const client = useFlueClient()
  const wrapRef = useRef<HTMLDivElement>(null)
  const surfaceRef = useRef<HTMLDivElement>(null)
  const emulatorRef = useRef<Emulator | null>(null)
  const refRef = useRef<number | null>(null)
  const primaryRef = useRef(false)
  const [status, setStatus] = useState<'connecting' | 'live' | 'reconnecting' | 'exited'>(
    'connecting',
  )

  useEffect(() => {
    const wrap = wrapRef.current
    const surface = surfaceRef.current
    if (!wrap || !surface) return

    const emulator = createXtermEmulator({ cols: 80, rows: 24 })
    emulatorRef.current = emulator
    emulator.attachTo(surface)

    const encoder = new TextEncoder()
    const keys = createKeyboardModes(wrap)
    const fit = new FitAddon()

    /** Non-primary clients letterbox rather than resizing the PTY. */
    function applyScale() {
      if (primaryRef.current) {
        surface!.style.removeProperty('--flue-scale')
        surface!.classList.remove('origin-top-left', 'scale-(--flue-scale)')
        return
      }
      const box = surface!.getBoundingClientRect()
      if (box.width === 0 || box.height === 0) return
      const scale = Math.min(wrap!.clientWidth / box.width, wrap!.clientHeight / box.height, 1)
      surface!.style.setProperty('--flue-scale', String(scale))
      surface!.classList.add('origin-top-left', 'scale-(--flue-scale)')
    }

    emulator.onData((bytes) => {
      if (refRef.current !== null) client.sendInput(refRef.current, bytes)
    })

    // Every registration returns an unsubscribe; they are all released on
    // cleanup, because the client outlives this component now.
    const offs: Array<() => void> = []

    offs.push(
      client.onStatus((s) => {
        if (s === 'open') setStatus('live')
        else if (s === 'reconnecting') setStatus('reconnecting')
      }),
    )

    offs.push(
      client.onAttached((a) => {
        refRef.current = a.ref
        primaryRef.current = a.primary
        // A truncated attach means the requested offset had been evicted, so
        // what follows is a fresh snapshot rather than a continuation.
        if (a.truncated) emulator.write(encoder.encode('[2J[H'))
        emulator.resize(a.cols, a.rows)
        applyScale()
        document.title = a.title || 'flue'
        setStatus('live')
      }),
    )

    offs.push(
      client.onOutput((ref, bytes) => {
        if (ref === refRef.current) emulator.write(bytes)
      }),
    )

    offs.push(
      client.onSizeChanged((m) => {
        if (m.ref !== refRef.current) return
        primaryRef.current = m.primary
        emulator.resize(m.cols, m.rows)
        applyScale()
      }),
    )

    offs.push(
      client.onExit((ref, code) => {
        if (ref !== refRef.current) return
        emulator.write(encoder.encode(`\r\n[90m[process exited: ${code}][0m\r\n`))
        setStatus('exited')
      }),
    )

    const onResize = () => {
      if (refRef.current === null) return
      if (!primaryRef.current) {
        applyScale()
        return
      }
      const dims = fit.proposeDimensions()
      if (dims) client.resize(refRef.current, dims.cols, dims.rows, true)
    }
    window.addEventListener('resize', onResize)

    // Ctrl+Shift+Enter is reachable in tab mode because the browser does
    // not claim it.
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && e.key === 'Enter') {
        e.preventDefault()
        void (keys.mode() === 'focus' ? keys.exitFocus() : keys.enterFocus())
      }
    }
    window.addEventListener('keydown', onKey)

    if (sessionId) client.attach(sessionId, 0)
    else client.spawn({ cwd, cols: 80, rows: 24 })

    return () => {
      for (const off of offs) off()
      window.removeEventListener('resize', onResize)
      window.removeEventListener('keydown', onKey)
      emulator.dispose()
      emulatorRef.current = null
    }
  }, [client, sessionId, cwd])

  return (
    <div ref={wrapRef} className="relative h-full w-full overflow-hidden bg-zinc-950">
      <div ref={surfaceRef} className="flue-term-surface" />
      {status !== 'live' && (
        <div
          role="status"
          className={cn(
            'absolute top-3 right-3 rounded-md px-2 py-1 text-base/6 font-medium sm:text-sm/6',
            'bg-zinc-900 text-zinc-300 inset-ring inset-ring-white/10',
          )}
        >
          {status === 'reconnecting'
            ? 'Reconnecting…'
            : status === 'exited'
              ? 'Process exited'
              : 'Connecting…'}
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 5: Wire the terminal route**

`web/src/routes/terminal.tsx`:

```tsx
import { useParams } from '@tanstack/react-router'
import { Terminal } from '@/components/terminal'

export function TerminalRoute() {
  const { sessionId } = useParams({ from: '/d/$deviceId/s/$sessionId' })
  return <Terminal sessionId={sessionId} />
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd web && pnpm test`
Expected: PASS, including the four keyboard tests.

- [ ] **Step 7: Type-check**

Run: `cd web && pnpm lint`
Expected: no TypeScript errors.

- [ ] **Step 8: Commit**

```bash
git add web/src/lib/keyboard.ts web/src/components/terminal.tsx web/src/routes/terminal.tsx
git commit -m "feat(web): add full-bleed terminal route with both keyboard modes"
```

---

### Task 13: Sessions route

**Files:**
- Modify: `web/src/routes/sessions.tsx`
- Create: `web/src/components/session-table.tsx`
- Test: `web/src/components/session-table.test.tsx`

**Interfaces:**
- Consumes: `SessionInfo` (Task 11), `Button` from shadcn (Task 8).
- Produces: `<SessionTable sessions={SessionInfo[]} onOpen={(id: string) => void} />`

**Surface treatment.** A table on the page background with horizontal row dividers — no card wrapper, no vertical rules, no outer border. Sibling rows in a shared context need the lightest separation that works, and cards here would imply each row is an independent object when the set is really one list.

- [ ] **Step 1: Write the failing test**

`web/src/components/session-table.test.tsx`:

```tsx
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SessionTable } from './session-table'
import type { SessionInfo } from '@/client/protocol'

const sessions: SessionInfo[] = [
  {
    id: 'a1b2c3d4', title: 'zsh', cwd: '/Users/karn/code/flue', cmd: ['zsh', '-l'],
    state: 'running', exitCode: 0, cols: 120, rows: 40,
    lastActive: '2026-07-28T10:00:00Z',
  },
  {
    id: 'e5f6a7b8', title: 'build', cwd: '/Users/karn/code/reins', cmd: ['pnpm', 'build'],
    state: 'exited', exitCode: 1, cols: 80, rows: 24,
    lastActive: '2026-07-28T09:30:00Z',
  },
]

describe('SessionTable', () => {
  it('renders a row per session', () => {
    render(<SessionTable sessions={sessions} onOpen={() => {}} />)
    expect(screen.getByText('/Users/karn/code/flue')).toBeTruthy()
    expect(screen.getByText('/Users/karn/code/reins')).toBeTruthy()
  })

  it('distinguishes running from exited', () => {
    render(<SessionTable sessions={sessions} onOpen={() => {}} />)
    expect(screen.getByText('Running')).toBeTruthy()
    expect(screen.getByText('Exited 1')).toBeTruthy()
  })

  it('calls onOpen with the session id', async () => {
    const onOpen = vi.fn()
    render(<SessionTable sessions={sessions} onOpen={onOpen} />)
    await userEvent.click(screen.getAllByRole('button', { name: /open/i })[0]!)
    expect(onOpen).toHaveBeenCalledWith('a1b2c3d4')
  })

  it('shows an empty state when there are no sessions', () => {
    render(<SessionTable sessions={[]} onOpen={() => {}} />)
    expect(screen.getByText(/No sessions yet/i)).toBeTruthy()
  })

  it('uses sentence case headings, never uppercase', () => {
    render(<SessionTable sessions={sessions} onOpen={() => {}} />)
    const heading = screen.getByRole('columnheader', { name: 'Directory' })
    expect(heading.className).not.toMatch(/\buppercase\b/)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd web && pnpm test`
Expected: FAIL — cannot resolve `./session-table`.

- [ ] **Step 3: Implement the table**

`web/src/components/session-table.tsx`:

```tsx
import { Button } from '@/components/ui/button'
import type { SessionInfo } from '@/client/protocol'
import { cn } from '@/lib/utils'

export interface SessionTableProps {
  sessions: SessionInfo[]
  onOpen: (id: string) => void
}

function StateCell({ session }: { session: SessionInfo }) {
  const running = session.state === 'running'
  return (
    <div className="flex items-center gap-x-2">
      <span
        aria-hidden="true"
        className={cn(
          'size-1.5 shrink-0 rounded-full',
          running ? 'bg-amber-500' : 'bg-zinc-950/30 dark:bg-white/30',
        )}
      />
      <span>{running ? 'Running' : `Exited ${session.exitCode}`}</span>
    </div>
  )
}

/**
 * Rows sit directly on the page background with horizontal dividers only.
 * Cards would imply each row is an independent object; this is one list.
 */
export function SessionTable({ sessions, onOpen }: SessionTableProps) {
  if (sessions.length === 0) {
    return (
      <p className="max-w-[65ch] text-base/7 text-pretty text-zinc-600 sm:text-sm/6 dark:text-zinc-400">
        No sessions yet. Run <code className="font-mono">flue open</code> in a directory, or start
        one here.
      </p>
    )
  }

  return (
    <div className="-mx-4 -my-2 overflow-x-auto whitespace-nowrap sm:-mx-6 lg:-mx-8">
      <div className="inline-block min-w-full px-4 py-2 align-middle sm:px-6 lg:px-8">
        <table className="w-full text-left">
          <thead>
            <tr className="border-b border-zinc-950/10 dark:border-white/10">
              <th
                scope="col"
                className="py-2 pr-3 text-base/6 font-medium whitespace-nowrap text-zinc-950 sm:text-sm/6 dark:text-white"
              >
                Directory
              </th>
              <th
                scope="col"
                className="px-3 py-2 text-base/6 font-medium whitespace-nowrap text-zinc-950 sm:text-sm/6 dark:text-white"
              >
                Command
              </th>
              <th
                scope="col"
                className="px-3 py-2 text-base/6 font-medium whitespace-nowrap text-zinc-950 sm:text-sm/6 dark:text-white"
              >
                State
              </th>
              <th scope="col" className="py-2 pl-3">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {sessions.map((s) => (
              <tr key={s.id} className="border-b border-zinc-950/5 dark:border-white/5">
                <td className="py-2.5 pr-3 text-base/6 text-zinc-950 sm:text-sm/6 dark:text-white">
                  {s.cwd}
                </td>
                <td className="px-3 py-2.5 font-mono text-base/6 text-zinc-600 sm:text-sm/6 dark:text-zinc-400">
                  {s.cmd.join(' ')}
                </td>
                <td className="px-3 py-2.5 text-base/6 tabular-nums text-zinc-600 sm:text-sm/6 dark:text-zinc-400">
                  <StateCell session={s} />
                </td>
                <td className="py-2.5 pl-3 text-right">
                  <Button variant="outline" size="sm" onClick={() => onOpen(s.id)}>
                    Open
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
```

- [ ] **Step 4: Implement the sessions route**

`web/src/routes/sessions.tsx`:

```tsx
import { useEffect, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { Button } from '@/components/ui/button'
import { SessionTable } from '@/components/session-table'
import { useFlueClient } from '@/client/provider'
import type { SessionInfo } from '@/client/protocol'

export function SessionsRoute() {
  const client = useFlueClient()
  const navigate = useNavigate()
  const [sessions, setSessions] = useState<SessionInfo[]>([])

  useEffect(() => {
    const offSessions = client.onSessions(setSessions)
    // Spawning yields an `attached`, which is how a newly created session
    // becomes a tab.
    const offAttached = client.onAttached((a) => {
      void navigate({ to: '/d/$deviceId/s/$sessionId', params: { deviceId: 'local', sessionId: a.id } })
    })

    client.list()
    // The protocol has no push for session-list changes, so poll while
    // this screen is open. Cheap, and it stops on unmount.
    const poll = setInterval(() => client.list(), 3000)

    return () => {
      clearInterval(poll)
      offSessions()
      offAttached()
    }
  }, [client, navigate])

  function open(id: string) {
    void navigate({ to: '/d/$deviceId/s/$sessionId', params: { deviceId: 'local', sessionId: id } })
  }

  return (
    <div className="flex flex-col gap-y-6 p-4 sm:p-6 lg:p-8">
      <div className="flex items-start justify-between gap-x-4">
        <div className="min-w-0">
          <h1 className="text-2xl/8 font-semibold tracking-tight text-zinc-950 sm:text-xl/7 dark:text-white">
            Sessions
          </h1>
          <p className="mt-1 max-w-[65ch] text-base/7 text-pretty text-zinc-600 sm:text-sm/6 dark:text-zinc-400">
            Closing a tab detaches. Whatever is running keeps running.
          </p>
        </div>
        <Button
          size="sm"
          className="shrink-0 bg-amber-500 text-zinc-950 hover:bg-amber-400 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-500"
          onClick={() => client.spawn({ cols: 80, rows: 24 })}
        >
          New session
        </Button>
      </div>

      <SessionTable sessions={sessions} onOpen={open} />
    </div>
  )
}
```

This is the only filled/solid button on the screen; every other control uses `outline` or `ghost`, per the one-primary-button rule.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd web && pnpm test`
Expected: PASS across every suite.

- [ ] **Step 6: Type-check and build**

Run: `cd web && pnpm build`
Expected: `tsc --noEmit` clean, and `web/dist` produced.

- [ ] **Step 7: Commit**

```bash
git add web/src/routes/sessions.tsx web/src/components/session-table.tsx
git commit -m "feat(web): add sessions route with a session table"
```

---

### Task 14: Embed the UI and verify end to end

**Files:**
- Create: `web/embed.go`
- Modify: `cmd/flue/main.go` (replace the placeholder `uiHandler`)
- Create: `Makefile`
- Test: `internal/daemon/embed_test.go`

**Interfaces:**
- Consumes: everything above.
- Produces: `web.Handler() http.Handler` — serves the built app from the embedded filesystem, falling back to `index.html` so client-side routes such as `/d/local/s/abc` resolve.

- [ ] **Step 1: Write the failing test**

`internal/daemon/embed_test.go`:

```go
package daemon

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/karnstack/flue/web"
)

func TestEmbeddedUIServesIndex(t *testing.T) {
	ts := httptest.NewServer(web.Handler())
	defer ts.Close()

	resp, err := http.Get(ts.URL + "/")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}
	if ct := resp.Header.Get("Content-Type"); !strings.Contains(ct, "text/html") {
		t.Fatalf("Content-Type = %q, want text/html", ct)
	}
}

func TestEmbeddedUIFallsBackForClientRoutes(t *testing.T) {
	// /d/local/s/<id> is a TanStack Router route; the server must return
	// index.html rather than 404, or a bookmarked session tab breaks.
	ts := httptest.NewServer(web.Handler())
	defer ts.Close()

	resp, err := http.Get(ts.URL + "/d/local/s/abc123")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `go test ./internal/daemon/ -run TestEmbedded -v`
Expected: FAIL — no package `web`.

- [ ] **Step 3: Implement the embedded handler**

`web/embed.go`:

```go
// Package web serves the built flue UI from the daemon binary, so there is
// no runtime dependency on Node or on any files beside the executable.
package web

import (
	"embed"
	"io/fs"
	"net/http"
	"path"
	"strings"
)

//go:embed all:dist
var dist embed.FS

// Handler serves the built app. Unknown paths fall back to index.html so
// client-side routes such as /d/local/s/<id> resolve — a bookmarked session
// tab must open, not 404.
func Handler() http.Handler {
	sub, err := fs.Sub(dist, "dist")
	if err != nil {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			http.Error(w, "flue: UI not built; run `make web`", http.StatusInternalServerError)
		})
	}
	fileServer := http.FileServer(http.FS(sub))

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		clean := path.Clean(strings.TrimPrefix(r.URL.Path, "/"))
		if clean == "." {
			clean = "index.html"
		}
		if f, err := sub.Open(clean); err == nil {
			_ = f.Close()
			fileServer.ServeHTTP(w, r)
			return
		}
		r2 := r.Clone(r.Context())
		r2.URL.Path = "/"
		fileServer.ServeHTTP(w, r2)
	})
}
```

- [ ] **Step 4: Wire it into the CLI**

In `cmd/flue/main.go`, replace the placeholder `uiHandler` with:

```go
func uiHandler() http.Handler {
	return web.Handler()
}
```

and add `"github.com/karnstack/flue/web"` to the imports.

- [ ] **Step 5: Add a Makefile**

`Makefile`:

```make
.PHONY: all web build test test-go test-web lint clean

all: build

web:
	cd web && pnpm install --frozen-lockfile && pnpm build

build: web
	go build -o bin/flue ./cmd/flue

test: test-go test-web

test-go:
	go test ./...

test-web:
	cd web && pnpm test

lint:
	go vet ./...
	cd web && pnpm lint

clean:
	rm -rf bin web/dist
```

- [ ] **Step 6: Build and run the full suite**

```bash
make web
make test
make lint
```

Expected: PASS everywhere. `go build` fails before `make web` because `//go:embed all:dist` requires the directory to exist — that is intentional, and the Makefile encodes the ordering.

- [ ] **Step 7: Manual end-to-end verification**

```bash
make build
./bin/flue open ~/code
```

Verify each of these:

1. A browser tab opens with a working shell in `~/code`.
2. `ls` and `vim` render correctly; colours and cursor movement work.
3. The URL is `/d/local/s/<id>` and contains no `t=` parameter.
4. Resizing the window reflows the terminal.
5. Run `sleep 300`, close the tab, reopen the same URL — the session reattaches with its scrollback, and `sleep` is still running.
6. Open the same URL in a second tab, type in one, and confirm it mirrors into the other.
7. Visit `/sessions` and confirm both sessions are listed with the right directories and states.
8. Press Ctrl+Shift+Enter to enter focus mode; confirm the page goes fullscreen and Cmd+W no longer closes the tab. Hold Esc to leave.
9. Narrow the window below `lg` and confirm the sidebar collapses into the hamburger sheet.
10. Toggle the OS between light and dark appearance and confirm the chrome follows, with no unreadable text in either.
11. Run `./bin/flue status` and confirm it lists the running sessions.

- [ ] **Step 8: Commit**

```bash
git add web/embed.go cmd/flue/main.go Makefile internal/daemon/embed_test.go
git commit -m "feat: embed the built UI in the daemon binary"
```

- [ ] **Step 9: Update the README status**

Replace the status line in `README.md`:

```markdown
> Status: local terminal works. `flue enable`, remote transports, and pairing are next.
```

- [ ] **Step 10: Commit and push**

```bash
git add README.md
git commit -m "docs: update status now that the local terminal works"
git push origin main
```

---

## Self-review notes

Checked against `docs/superpowers/specs/2026-07-28-flue-design.md`.

**Covered:** seq-addressed ring with eviction and `truncated` (Tasks 1, 3, 11, 12); OSC 0/2 title scanner as the server-side VT seam (Task 2); PTY sessions, login-shell default, environment inheritance, exited retention and reaping (Task 3); binary frame layout, control messages, shared golden fixtures, `spec/protocol.md` (Tasks 4, 11); loopback token plus Origin plus Host with the DNS-rebinding defence, cookie exchange, `Referrer-Policy`, no wildcard CORS (Task 5); `127.0.0.1`-only bind, CSP, mirroring, primary-owns-dimensions with promotion (Task 6); `flue open` and `flue status` (Task 7); the `Emulator` seam and the VT conformance corpus that makes the libghostty swap a substitution (Task 10); reconnect with backoff and reattach by `lastSeq` (Task 11); both keyboard modes and bookmarkable session URLs (Task 12); the sessions surface (Task 13); single-binary distribution with no runtime Node (Task 14).

**Design guidelines applied:** zinc neutrals rather than gray or slate; amber accent, never used for body text; both themes via `prefers-color-scheme` with no toggle; `antialiased` on the root and `isolate` on the app container; nav active state uses a muted background and accent text with identical font weight across states; the sidebar collapses to a sheet below `lg:`; body text is `text-base` on mobile and `sm:text-sm` above; headings use `font-semibold` with `tracking-tight` and no `leading-*`; Heroicons Micro at `size-4` only, each with `shrink-0`; `min-w-0` on the flex-1 main region; the session table sits on the background with horizontal dividers only, sentence-case headings, `w-full`, and the two-div responsive wrapper; opacity-based divider colors; one primary button per screen; `tabular-nums` on the state column; `role="list"` on the nav list.

**Deliberately deferred**, each belonging to a later build-order step in the spec: `flue enable`/`disable` and the `service` package (step 2); pairing, device management, and Noise IK (step 3); the provider registry, Cloudflare REST client, and relay (step 4); `tailscale` and `cftunnel` (steps 5–6); the extension (step 7); `libghostty-vt` (step 8). The `/devices` nav entry and the settings screen are present but intentionally thin — they become real in step 2.

**One spec deviation, made explicit:** the spec's `local` auth requires an Origin match. Task 5 accepts a *missing* Origin while rejecting any present-but-unlisted one, because non-browser clients such as `curl` and the flue CLI send no Origin header, and only browsers can be induced into cross-origin requests. `TestAuthAllowsMissingOriginForNonBrowserClients` pins this behaviour.
