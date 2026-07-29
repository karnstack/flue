# flue product lane Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement `flue enable`/`flue disable` per spec §1, land all four follow-ups from `docs/FOLLOW-UPS.md` (reqId correlation, `head` replay gating, docs made true, minimal audit log), then a design-skill-driven visual pass over the web app.

**Architecture:** A new self-contained `internal/service` package (interface + darwin launchd + linux systemd implementations + a fake runner for tests) consumed only by `cmd/flue`. Wire changes (`reqId`, `head`) touch `internal/wire`, `internal/daemon/conn.go`, `web/src/client`, `testdata/wire/control.json`, and `spec/protocol.md` together by design — the shared golden fixture forces it. The web client gains exact request correlation, which retires four ordering heuristics; the terminal gains a per-attach mute gate so replayed probe replies never reach the shell's stdin.

**Tech Stack:** Go 1.26.1 (`creack/pty`, `coder/websocket`, `log/slog`); React 19 + TanStack Router + Vite + Tailwind v4; Vitest with Testing Library; pnpm 11.9.0 and mise.

## Global Constraints

- go 1.26.1; pnpm 11.9.0 via mise — NEVER npm/npx. One-off tools run through `pnpm dlx`.
- web/dist must exist before any go build/test/vet (`make web` first, or full `make test`). `//go:embed all:dist` in web/embed.go will not compile without it.
- CLI surface stays exactly four commands (enable, disable, status, open) plus serve as the daemon entrypoint — no new commands.
- Commit style follows repo history (conventional commits, lowercase, definite articles, e.g. "fix(session): hold the session lock across the winsize ioctl").
- Every commit ends with "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>".
- TDD — failing test before implementation.
- CI (and this plan's test steps) never touch real launchd or systemd. Every service-manager interaction goes through the `Runner` seam; unit-file generation is pure and asserted byte-for-byte.
- Every web test lives under `web/src/` named `*.test.ts(x)`, helpers under `web/src/testing/`. A test placed elsewhere compiles its classes into the shipped stylesheet.
- Tailwind scans raw bytes: prose in comments and object keys are class candidates. `web/src/styles.build.test.ts` guards by allowlist; `KNOWN_DEAD` is shrink-only — reword code rather than adding to it.
- `web/dist/` stays gitignored.
- Baseline: `make test` run on 2026-07-30 is green — all Go packages pass, web suite 21 files / 296 tests pass, exit 0. Nothing flaky observed. (jsdom prints harmless "Not implemented: Window's scrollTo" noise; ignore it.)

---

### Task 1: internal/service — unit-file rendering, byte-for-byte

**Files:**
- Create: `internal/service/unit.go`
- Test: `internal/service/unit_test.go`

**Interfaces:**
- Consumes: nothing (pure functions, stdlib only).
- Produces:
  - `const LaunchdLabel = "sh.flue.daemon"`
  - `func LaunchdPlist(exe string) []byte` — the launchd agent plist running `<exe> serve`.
  - `func SystemdUnit(exe string) []byte` — the systemd user unit running `<exe> serve`.
- Later tasks rely on these exact names: Task 2 (`LaunchdPlist`, `LaunchdLabel`), Task 3 (`SystemdUnit`).

- [ ] **Step 1: Write the failing table-driven test**

`internal/service/unit_test.go`:

```go
package service

import "testing"

// The unit files are asserted byte for byte: paths, escaping, and the resolved
// executable are exactly what a service manager parses, and "roughly right"
// XML or INI is how a login service silently fails to start.

func TestLaunchdPlist(t *testing.T) {
	cases := []struct {
		name string
		exe  string
		want string
	}{
		{
			name: "plain path",
			exe:  "/usr/local/bin/flue",
			want: `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>sh.flue.daemon</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/flue</string>
    <string>serve</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
</dict>
</plist>
`,
		},
		{
			name: "path with an ampersand is XML-escaped",
			exe:  "/Users/karn/dev & play/flue",
			want: `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>sh.flue.daemon</string>
  <key>ProgramArguments</key>
  <array>
    <string>/Users/karn/dev &amp; play/flue</string>
    <string>serve</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
</dict>
</plist>
`,
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := string(LaunchdPlist(c.exe)); got != c.want {
				t.Fatalf("LaunchdPlist(%q) =\n%s\nwant\n%s", c.exe, got, c.want)
			}
		})
	}
}

func TestSystemdUnit(t *testing.T) {
	cases := []struct {
		name string
		exe  string
		want string
	}{
		{
			name: "plain path",
			exe:  "/usr/local/bin/flue",
			want: `[Unit]
Description=flue daemon

[Service]
ExecStart="/usr/local/bin/flue" serve
Restart=on-failure

[Install]
WantedBy=default.target
`,
		},
		{
			name: "path with a space survives the quoting",
			exe:  "/home/karn/my tools/flue",
			want: `[Unit]
Description=flue daemon

[Service]
ExecStart="/home/karn/my tools/flue" serve
Restart=on-failure

[Install]
WantedBy=default.target
`,
		},
		{
			name: "percent is doubled so systemd does not read a specifier",
			exe:  "/opt/100%tools/flue",
			want: `[Unit]
Description=flue daemon

[Service]
ExecStart="/opt/100%%tools/flue" serve
Restart=on-failure

[Install]
WantedBy=default.target
`,
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := string(SystemdUnit(c.exe)); got != c.want {
				t.Fatalf("SystemdUnit(%q) =\n%s\nwant\n%s", c.exe, got, c.want)
			}
		})
	}
}
```

- [ ] **Step 2: Run it to see it fail**

Run: `go test ./internal/service/ -v`
Expected: FAIL to build — `undefined: LaunchdPlist`, `undefined: SystemdUnit`. (If `web/dist` is missing, run `make web` first.)

- [ ] **Step 3: Implement the renderers**

`internal/service/unit.go`:

```go
// Package service installs and removes the flue login service: a launchd
// agent on darwin, a systemd user unit on linux. It is self-contained —
// cmd/flue consumes it and nothing else does — and every interaction with a
// real service manager goes through the Runner seam so tests never touch one.
package service

import (
	"encoding/xml"
	"strings"
)

// LaunchdLabel is the launchd service label and the plist's basename.
const LaunchdLabel = "sh.flue.daemon"

// LaunchdPlist renders the launchd agent plist that runs `exe serve` at login.
// exe is the resolved binary path (os.Executable, symlinks resolved), so a
// brew-installed and a hand-built flue both point at themselves.
func LaunchdPlist(exe string) []byte {
	return []byte(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>` + LaunchdLabel + `</string>
  <key>ProgramArguments</key>
  <array>
    <string>` + xmlEscape(exe) + `</string>
    <string>serve</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
</dict>
</plist>
`)
}

// SystemdUnit renders the systemd user unit that runs `exe serve` at login.
// The path is double-quoted for systemd's ExecStart lexer, and % is doubled
// because ExecStart expands specifiers.
func SystemdUnit(exe string) []byte {
	return []byte(`[Unit]
Description=flue daemon

[Service]
ExecStart=` + systemdQuote(exe) + ` serve
Restart=on-failure

[Install]
WantedBy=default.target
`)
}

func xmlEscape(s string) string {
	var b strings.Builder
	// EscapeText cannot fail on a strings.Builder.
	_ = xml.EscapeText(&b, []byte(s))
	return b.String()
}

func systemdQuote(s string) string {
	r := strings.NewReplacer(`\`, `\\`, `"`, `\"`, "%", "%%")
	return `"` + r.Replace(s) + `"`
}
```

- [ ] **Step 4: Run the tests again**

Run: `go test ./internal/service/ -v`
Expected: PASS (both tables, all subtests).

- [ ] **Step 5: Commit**

```bash
git add internal/service/unit.go internal/service/unit_test.go
git commit -m "$(cat <<'EOF'
feat(service): render the launchd plist and the systemd user unit

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: internal/service — Runner, Manager, and the launchd flows

**Files:**
- Create: `internal/service/service.go`
- Create: `internal/service/launchd.go`
- Test: `internal/service/launchd_test.go`

**Interfaces:**
- Consumes: `LaunchdPlist(exe string) []byte`, `LaunchdLabel` (Task 1).
- Produces:
  - `type Runner interface { Run(name string, args ...string) ([]byte, error) }`
  - `type ExecRunner struct{}` implementing Runner via `exec.Command(...).CombinedOutput()`
  - `type Status struct { Installed bool; Running bool }`
  - `type Manager interface { Enable() error; Disable() error; Status() (Status, error) }`
  - `func NewLaunchd(exe, home string, uid int, r Runner) *Launchd` — `*Launchd` implements Manager; plist lands at `<home>/Library/LaunchAgents/sh.flue.daemon.plist`.
- Later tasks rely on: Task 3 adds `NewSystemd`, `ForPlatform`, `ErrNoUserManager` to this same package; Task 4 consumes `service.Manager`, `service.Status`, `service.ForPlatform`, `service.ExecRunner`, `service.ErrNoUserManager`.

- [ ] **Step 1: Write the failing tests, with a fake runner**

`internal/service/launchd_test.go`:

```go
package service

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// fakeRunner records every command and answers from a script keyed by the
// command's verb — launchctl's first argument. CI never talks to launchd.
type fakeRunner struct {
	calls [][]string
	fail  map[string]error  // verb -> error
	out   map[string]string // verb -> combined output
}

func (f *fakeRunner) Run(name string, args ...string) ([]byte, error) {
	f.calls = append(f.calls, append([]string{name}, args...))
	v := verbOf(name, args)
	return []byte(f.out[v]), f.fail[v]
}

// verbOf names a call for scripting: launchctl's first arg, systemctl's first
// arg after --user, else the binary itself.
func verbOf(name string, args []string) string {
	if name == "systemctl" && len(args) > 1 && args[0] == "--user" {
		return args[1]
	}
	if len(args) > 0 {
		return args[0]
	}
	return name
}

func (f *fakeRunner) verbs() []string {
	var vs []string
	for _, c := range f.calls {
		vs = append(vs, verbOf(c[0], c[1:]))
	}
	return vs
}

func newLaunchdUnderTest(t *testing.T, r Runner) (*Launchd, string) {
	t.Helper()
	home := t.TempDir()
	return NewLaunchd("/usr/local/bin/flue", home, 501, r), filepath.Join(home, "Library", "LaunchAgents", "sh.flue.daemon.plist")
}

func TestLaunchdEnableWritesTheUnitAndBootstraps(t *testing.T) {
	r := &fakeRunner{}
	l, plist := newLaunchdUnderTest(t, r)

	if err := l.Enable(); err != nil {
		t.Fatalf("Enable: %v", err)
	}

	got, err := os.ReadFile(plist)
	if err != nil {
		t.Fatalf("read plist: %v", err)
	}
	if string(got) != string(LaunchdPlist("/usr/local/bin/flue")) {
		t.Fatalf("plist on disk does not match LaunchdPlist output:\n%s", got)
	}
	if vs := r.verbs(); len(vs) != 1 || vs[0] != "bootstrap" {
		t.Fatalf("verbs = %v, want exactly [bootstrap]", vs)
	}
	// The exact invocation, as the spec commits to it: the modern spelling.
	want := []string{"launchctl", "bootstrap", "gui/501", plist}
	if len(r.calls) != 1 || strings.Join(r.calls[0], " ") != strings.Join(want, " ") {
		t.Fatalf("call = %v, want %v", r.calls[0], want)
	}
}

func TestLaunchdEnableConvergesWhenAlreadyLoaded(t *testing.T) {
	// Re-running enable when already enabled is not an error: bootstrap
	// refuses a loaded label, so enable falls through to print (is it
	// loaded?) and kickstart (start it if it is dead) — and never bootout,
	// which would kill a healthy daemon and its sessions.
	r := &fakeRunner{
		fail: map[string]error{"bootstrap": errFake("Bootstrap failed: 5: Input/output error")},
	}
	l, _ := newLaunchdUnderTest(t, r)

	if err := l.Enable(); err != nil {
		t.Fatalf("Enable on an already-enabled service: %v", err)
	}
	if vs := r.verbs(); strings.Join(vs, ",") != "bootstrap,print,kickstart" {
		t.Fatalf("verbs = %v, want [bootstrap print kickstart]", vs)
	}
}

func TestLaunchdEnableReportsARealBootstrapFailure(t *testing.T) {
	// bootstrap failed AND the label is not loaded: that is a real failure,
	// and the error carries launchctl's own output so the user sees why.
	r := &fakeRunner{
		fail: map[string]error{
			"bootstrap": errFake("exit status 5"),
			"print":     errFake("could not find service"),
		},
		out: map[string]string{"bootstrap": "Bootstrap failed: 125: domain does not exist"},
	}
	l, _ := newLaunchdUnderTest(t, r)

	err := l.Enable()
	if err == nil {
		t.Fatal("Enable = nil for a failed bootstrap of an unloaded label, want an error")
	}
	if !strings.Contains(err.Error(), "domain does not exist") {
		t.Fatalf("error %q does not carry launchctl's output", err)
	}
}

func TestLaunchdDisableRemovesAndBootsOut(t *testing.T) {
	r := &fakeRunner{}
	l, plist := newLaunchdUnderTest(t, r)
	if err := l.Enable(); err != nil {
		t.Fatalf("Enable: %v", err)
	}

	if err := l.Disable(); err != nil {
		t.Fatalf("Disable: %v", err)
	}
	if _, err := os.Stat(plist); !os.IsNotExist(err) {
		t.Fatalf("plist still on disk after Disable (stat err %v)", err)
	}
	if vs := r.verbs(); vs[len(vs)-1] != "bootout" {
		t.Fatalf("verbs = %v, want bootout last", vs)
	}
}

func TestLaunchdDisableIsIdempotent(t *testing.T) {
	// Nothing installed, bootout refuses: still nil. Disabling what is not
	// enabled reports plainly and exits 0 at the CLI layer.
	r := &fakeRunner{fail: map[string]error{"bootout": errFake("Boot-out failed: 3: No such process")}}
	l, _ := newLaunchdUnderTest(t, r)

	if err := l.Disable(); err != nil {
		t.Fatalf("Disable with nothing installed: %v", err)
	}
	if err := l.Disable(); err != nil {
		t.Fatalf("second Disable: %v", err)
	}
}

func TestLaunchdStatus(t *testing.T) {
	r := &fakeRunner{fail: map[string]error{"print": errFake("could not find service")}}
	l, _ := newLaunchdUnderTest(t, r)

	st, err := l.Status()
	if err != nil {
		t.Fatalf("Status: %v", err)
	}
	if st.Installed || st.Running {
		t.Fatalf("Status = %+v before Enable, want neither installed nor running", st)
	}

	if err := l.Enable(); err != nil {
		t.Fatalf("Enable: %v", err)
	}
	delete(r.fail, "print") // launchctl print now succeeds: the agent is loaded

	st, err = l.Status()
	if err != nil {
		t.Fatalf("Status: %v", err)
	}
	if !st.Installed || !st.Running {
		t.Fatalf("Status = %+v after Enable with print succeeding, want installed and running", st)
	}
}

// errFake is a plain error whose text looks like the tool's own.
type errFake string

func (e errFake) Error() string { return string(e) }
```

- [ ] **Step 2: Run it to see it fail**

Run: `go test ./internal/service/ -v`
Expected: FAIL to build — `undefined: Runner`, `undefined: NewLaunchd`, `undefined: Launchd`.

- [ ] **Step 3: Implement Runner, Manager, and Launchd**

`internal/service/service.go`:

```go
package service

import "os/exec"

// Runner executes one service-manager command and returns its combined
// output. It exists so the command flows are testable against a fake and so
// CI never touches a real launchd or systemd.
type Runner interface {
	Run(name string, args ...string) ([]byte, error)
}

// ExecRunner is the production Runner.
type ExecRunner struct{}

func (ExecRunner) Run(name string, args ...string) ([]byte, error) {
	return exec.Command(name, args...).CombinedOutput()
}

// Status reports the login service's two independent facts.
type Status struct {
	Installed bool // the unit file is on disk
	Running   bool // the service manager reports it alive
}

// Manager installs, removes, and inspects the flue login service.
//
//   - Enable converges: it rewrites the unit if it drifted, loads it if it is
//     not loaded, and starts it if it is dead — without restarting a healthy
//     daemon, whose sessions must survive a re-run of flue enable.
//   - Disable is idempotent: disabling what is not enabled is nil.
type Manager interface {
	Enable() error
	Disable() error
	Status() (Status, error)
}
```

`internal/service/launchd.go`:

```go
package service

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
)

// Launchd manages the login service through launchctl on darwin.
type Launchd struct {
	exe  string
	home string
	uid  int
	run  Runner
}

func NewLaunchd(exe, home string, uid int, r Runner) *Launchd {
	return &Launchd{exe: exe, home: home, uid: uid, run: r}
}

func (l *Launchd) unitPath() string {
	return filepath.Join(l.home, "Library", "LaunchAgents", LaunchdLabel+".plist")
}

func (l *Launchd) domainTarget() string { return fmt.Sprintf("gui/%d", l.uid) }
func (l *Launchd) serviceTarget() string {
	return fmt.Sprintf("gui/%d/%s", l.uid, LaunchdLabel)
}

// Enable writes the plist and bootstraps it — the modern spelling, not
// `launchctl load`. When the label is already bootstrapped, bootstrap
// refuses; that is convergence, not failure, so Enable verifies the label is
// loaded (print) and kickstarts it in case it is dead. kickstart without -k
// never restarts a running service, which is what keeps a re-run of flue
// enable from killing live sessions.
func (l *Launchd) Enable() error {
	if err := os.MkdirAll(filepath.Dir(l.unitPath()), 0o755); err != nil {
		return err
	}
	if err := os.WriteFile(l.unitPath(), LaunchdPlist(l.exe), 0o644); err != nil {
		return err
	}
	out, err := l.run.Run("launchctl", "bootstrap", l.domainTarget(), l.unitPath())
	if err == nil {
		return nil
	}
	if _, perr := l.run.Run("launchctl", "print", l.serviceTarget()); perr == nil {
		_, _ = l.run.Run("launchctl", "kickstart", l.serviceTarget())
		return nil
	}
	return fmt.Errorf("launchctl bootstrap: %v: %s", err, out)
}

// Disable boots the agent out and removes the plist. Both halves tolerate
// absence: a bootout of an unloaded label and a remove of a missing file are
// what "already disabled" looks like, and that is a success.
func (l *Launchd) Disable() error {
	_, _ = l.run.Run("launchctl", "bootout", l.serviceTarget())
	if err := os.Remove(l.unitPath()); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	return nil
}

func (l *Launchd) Status() (Status, error) {
	var st Status
	if _, err := os.Stat(l.unitPath()); err == nil {
		st.Installed = true
	}
	if _, err := l.run.Run("launchctl", "print", l.serviceTarget()); err == nil {
		st.Running = true
	}
	return st, nil
}
```

- [ ] **Step 4: Run the tests again**

Run: `go test ./internal/service/ -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/service/service.go internal/service/launchd.go internal/service/launchd_test.go
git commit -m "$(cat <<'EOF'
feat(service): drive launchd through a runner the tests can fake

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: internal/service — systemd flows and the no-user-manager refusal

**Files:**
- Create: `internal/service/systemd.go`
- Test: `internal/service/systemd_test.go`
- Modify: `internal/service/service.go` (append `ForPlatform` and `ErrUnsupported`)

**Interfaces:**
- Consumes: `SystemdUnit(exe string) []byte` (Task 1), `Runner`, `Status`, `Manager` (Task 2), `fakeRunner`/`verbOf`/`errFake` from `launchd_test.go` (same package).
- Produces:
  - `func NewSystemd(exe, home string, r Runner) *Systemd` — unit lands at `<home>/.config/systemd/user/flue.service`; `*Systemd` implements Manager.
  - `var ErrNoUserManager = errors.New("service: systemd user services are not available here (no user manager — common on WSL)")`
  - `var ErrUnsupported = errors.New("service: no login-service support on this platform")`
  - `func ForPlatform(goos, exe, home string, uid int, r Runner) (Manager, error)` — darwin → Launchd, linux → Systemd, else ErrUnsupported.
- Task 4 relies on `ForPlatform`, `ErrNoUserManager`, `ErrUnsupported` exactly as spelled.

- [ ] **Step 1: Write the failing tests**

`internal/service/systemd_test.go`:

```go
package service

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func newSystemdUnderTest(t *testing.T, r Runner) (*Systemd, string) {
	t.Helper()
	home := t.TempDir()
	return NewSystemd("/usr/local/bin/flue", home, r), filepath.Join(home, ".config", "systemd", "user", "flue.service")
}

func TestSystemdEnableWritesTheUnitAndEnablesNow(t *testing.T) {
	r := &fakeRunner{out: map[string]string{"is-system-running": "running\n"}}
	s, unit := newSystemdUnderTest(t, r)

	if err := s.Enable(); err != nil {
		t.Fatalf("Enable: %v", err)
	}

	got, err := os.ReadFile(unit)
	if err != nil {
		t.Fatalf("read unit: %v", err)
	}
	if string(got) != string(SystemdUnit("/usr/local/bin/flue")) {
		t.Fatalf("unit on disk does not match SystemdUnit output:\n%s", got)
	}
	// Probe, pick up the (possibly rewritten) unit, then the spec's exact
	// command: systemctl --user enable --now flue. enable --now starts the
	// service only if it is not already active, which is the convergence
	// the spec asks for — a healthy daemon is not restarted.
	if vs := strings.Join(r.verbs(), ","); vs != "is-system-running,daemon-reload,enable" {
		t.Fatalf("verbs = %v, want [is-system-running daemon-reload enable]", r.verbs())
	}
	last := r.calls[len(r.calls)-1]
	if strings.Join(last, " ") != "systemctl --user enable --now flue" {
		t.Fatalf("call = %v, want systemctl --user enable --now flue", last)
	}
}

func TestSystemdEnableIsConvergentOnRerun(t *testing.T) {
	r := &fakeRunner{out: map[string]string{"is-system-running": "degraded\n"}}
	// degraded exits non-zero yet the manager is answering; that must not be
	// read as "no systemd".
	r.fail = map[string]error{"is-system-running": errFake("exit status 1")}
	s, _ := newSystemdUnderTest(t, r)

	if err := s.Enable(); err != nil {
		t.Fatalf("first Enable: %v", err)
	}
	if err := s.Enable(); err != nil {
		t.Fatalf("second Enable must converge, got: %v", err)
	}
}

func TestSystemdEnableRefusesWithoutAUserManager(t *testing.T) {
	// The WSL shape: systemctl exists but there is no user bus to talk to.
	r := &fakeRunner{
		fail: map[string]error{"is-system-running": errFake("exit status 1")},
		out:  map[string]string{"is-system-running": "Failed to connect to bus: No such file or directory\n"},
	}
	s, unit := newSystemdUnderTest(t, r)

	err := s.Enable()
	if !errors.Is(err, ErrNoUserManager) {
		t.Fatalf("Enable error = %v, want ErrNoUserManager", err)
	}
	if _, serr := os.Stat(unit); !os.IsNotExist(serr) {
		t.Fatal("Enable wrote a unit file it knows nothing can load")
	}
}

func TestSystemdDisableIsIdempotent(t *testing.T) {
	// Nothing installed and every systemctl call failing: still nil.
	r := &fakeRunner{fail: map[string]error{
		"disable":       errFake("Failed to disable unit: Unit file flue.service does not exist."),
		"daemon-reload": errFake("Failed to connect to bus"),
	}}
	s, _ := newSystemdUnderTest(t, r)

	if err := s.Disable(); err != nil {
		t.Fatalf("Disable with nothing installed: %v", err)
	}
}

func TestSystemdDisableRemovesTheUnit(t *testing.T) {
	r := &fakeRunner{out: map[string]string{"is-system-running": "running\n"}}
	s, unit := newSystemdUnderTest(t, r)
	if err := s.Enable(); err != nil {
		t.Fatalf("Enable: %v", err)
	}

	if err := s.Disable(); err != nil {
		t.Fatalf("Disable: %v", err)
	}
	if _, err := os.Stat(unit); !os.IsNotExist(err) {
		t.Fatal("unit still on disk after Disable")
	}
	if vs := r.verbs(); vs[len(vs)-1] != "daemon-reload" {
		t.Fatalf("verbs = %v, want daemon-reload after the unit is removed", vs)
	}
}

func TestSystemdStatus(t *testing.T) {
	r := &fakeRunner{
		fail: map[string]error{"is-active": errFake("exit status 3")},
		out:  map[string]string{"is-system-running": "running\n"},
	}
	s, _ := newSystemdUnderTest(t, r)

	st, err := s.Status()
	if err != nil {
		t.Fatalf("Status: %v", err)
	}
	if st.Installed || st.Running {
		t.Fatalf("Status = %+v before Enable, want neither", st)
	}

	if err := s.Enable(); err != nil {
		t.Fatalf("Enable: %v", err)
	}
	delete(r.fail, "is-active")

	st, err = s.Status()
	if err != nil {
		t.Fatalf("Status: %v", err)
	}
	if !st.Installed || !st.Running {
		t.Fatalf("Status = %+v after Enable with is-active succeeding, want both", st)
	}
}

func TestForPlatform(t *testing.T) {
	r := &fakeRunner{}
	if m, err := ForPlatform("darwin", "/x/flue", t.TempDir(), 501, r); err != nil || m == nil {
		t.Fatalf("darwin: %v, %v", m, err)
	}
	if m, err := ForPlatform("linux", "/x/flue", t.TempDir(), 1000, r); err != nil || m == nil {
		t.Fatalf("linux: %v, %v", m, err)
	}
	if _, err := ForPlatform("windows", "/x/flue", t.TempDir(), 0, r); !errors.Is(err, ErrUnsupported) {
		t.Fatalf("windows err = %v, want ErrUnsupported", err)
	}
}
```

- [ ] **Step 2: Run it to see it fail**

Run: `go test ./internal/service/ -v`
Expected: FAIL to build — `undefined: NewSystemd`, `undefined: ErrNoUserManager`, `undefined: ForPlatform`.

- [ ] **Step 3: Implement Systemd and ForPlatform**

`internal/service/systemd.go`:

```go
package service

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// ErrNoUserManager reports that systemctl --user has nobody to talk to —
// the common WSL shape. The CLI turns this into a one-line pointer at
// `flue serve`; it is never a stack trace.
var ErrNoUserManager = errors.New("service: systemd user services are not available here (no user manager — common on WSL)")

// Systemd manages the login service through systemctl --user on linux.
type Systemd struct {
	exe  string
	home string
	run  Runner
}

func NewSystemd(exe, home string, r Runner) *Systemd {
	return &Systemd{exe: exe, home: home, run: r}
}

func (s *Systemd) unitPath() string {
	return filepath.Join(s.home, ".config", "systemd", "user", "flue.service")
}

// available reports whether a user manager is reachable at all.
//
// `is-system-running` answers "degraded" with a non-zero exit on perfectly
// usable systems, so a bare error is not evidence of absence. Absence looks
// like exactly two things: the binary is missing, or the output says the
// user bus is unreachable.
func (s *Systemd) available() error {
	out, err := s.run.Run("systemctl", "--user", "is-system-running")
	if err == nil {
		return nil
	}
	if errors.Is(err, exec.ErrNotFound) || strings.Contains(string(out), "Failed to connect to bus") {
		return fmt.Errorf("%w: %s", ErrNoUserManager, strings.TrimSpace(string(out)))
	}
	return nil
}

// Enable writes the unit, reloads, and runs the spec's exact command:
// `systemctl --user enable --now flue`. Rewriting the unit unconditionally is
// what converges drift; enable --now starts the service only when it is not
// already active, so a healthy daemon is never restarted.
func (s *Systemd) Enable() error {
	if err := s.available(); err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(s.unitPath()), 0o755); err != nil {
		return err
	}
	if err := os.WriteFile(s.unitPath(), SystemdUnit(s.exe), 0o644); err != nil {
		return err
	}
	if out, err := s.run.Run("systemctl", "--user", "daemon-reload"); err != nil {
		return fmt.Errorf("systemctl --user daemon-reload: %v: %s", err, out)
	}
	if out, err := s.run.Run("systemctl", "--user", "enable", "--now", "flue"); err != nil {
		return fmt.Errorf("systemctl --user enable --now flue: %v: %s", err, out)
	}
	return nil
}

// Disable stops and disables the unit, removes the file, and reloads. Every
// systemctl failure is tolerated: on a machine with no user manager the file
// removal is the whole operation, and "already disabled" is a success.
func (s *Systemd) Disable() error {
	_, _ = s.run.Run("systemctl", "--user", "disable", "--now", "flue")
	if err := os.Remove(s.unitPath()); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	_, _ = s.run.Run("systemctl", "--user", "daemon-reload")
	return nil
}

func (s *Systemd) Status() (Status, error) {
	var st Status
	if _, err := os.Stat(s.unitPath()); err == nil {
		st.Installed = true
	}
	if _, err := s.run.Run("systemctl", "--user", "is-active", "flue"); err == nil {
		st.Running = true
	}
	return st, nil
}
```

Append to `internal/service/service.go`:

```go
// ErrUnsupported reports a platform with no login-service support. flue
// ships darwin and linux; WSL is linux with, usually, no user manager —
// which is ErrNoUserManager at Enable time, not this.
var ErrUnsupported = errors.New("service: no login-service support on this platform")

// ForPlatform picks the implementation for goos. It takes goos as a
// parameter rather than reading runtime.GOOS so both arms are testable on
// any host.
func ForPlatform(goos, exe, home string, uid int, r Runner) (Manager, error) {
	switch goos {
	case "darwin":
		return NewLaunchd(exe, home, uid, r), nil
	case "linux":
		return NewSystemd(exe, home, r), nil
	}
	return nil, ErrUnsupported
}
```

(Add `"errors"` to service.go's imports.)

- [ ] **Step 4: Run the tests again**

Run: `go test ./internal/service/ -v`
Expected: PASS (all of Tasks 1–3's tests).

- [ ] **Step 5: Commit**

```bash
git add internal/service/service.go internal/service/systemd.go internal/service/systemd_test.go
git commit -m "$(cat <<'EOF'
feat(service): drive systemd, and say why when there is no user manager

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: cmd/flue — enable, disable, and the status service line

**Files:**
- Modify: `cmd/flue/main.go` (the `main` switch at lines 58–81, `usage()` at lines 83–90, `cmdStatus` at lines 497–527; new functions appended)
- Test: `cmd/flue/enable_test.go` (new file, package main)

**Interfaces:**
- Consumes: `service.Manager`, `service.Status`, `service.ForPlatform(goos, exe, home string, uid int, r Runner) (Manager, error)`, `service.ExecRunner{}`, `service.ErrNoUserManager` (Tasks 2–3); existing `ourDaemon() (int, bool)`, `loadToken`, `mintHandoff(port int, token string) (string, error)`, `openURL(port int, handoff, cwd string) string`, `openBrowser`, `newTestDaemon(t, token) int` from `main_test.go`.
- Produces (package main, used only inside cmd/flue and its tests):
  - `var newServiceManager func() (service.Manager, error)` — the seam tests swap.
  - `func runEnable(w io.Writer, wait time.Duration) error`, `func runDisable(w io.Writer) error`
  - `func serviceLine(mgr service.Manager) string`
  - `const enableWait = 10 * time.Second`
- The CLI surface after this task: `enable`, `disable`, `status`, `open` + `serve`. No other command is ever added.

- [ ] **Step 1: Write the failing tests**

`cmd/flue/enable_test.go`:

```go
package main

import (
	"bytes"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/karnstack/flue/internal/config"
	"github.com/karnstack/flue/internal/daemon"
	"github.com/karnstack/flue/internal/service"
)

type fakeManager struct {
	st           service.Status
	enableErr    error
	enableCalls  int
	disableCalls int
	statusCalls  int
}

func (f *fakeManager) Enable() error {
	f.enableCalls++
	if f.enableErr != nil {
		return f.enableErr
	}
	f.st = service.Status{Installed: true, Running: true}
	return nil
}
func (f *fakeManager) Disable() error {
	f.disableCalls++
	f.st = service.Status{}
	return nil
}
func (f *fakeManager) Status() (service.Status, error) {
	f.statusCalls++
	return f.st, nil
}

func swapManager(t *testing.T, m service.Manager) {
	t.Helper()
	orig := newServiceManager
	newServiceManager = func() (service.Manager, error) { return m, nil }
	t.Cleanup(func() { newServiceManager = orig })
}

// TestRunEnableInstallsWaitsAndOpens is the transcript the parent spec
// commits to: checkmarks per step, then the browser, carrying a handoff
// token and never the session token.
func TestRunEnableInstallsWaitsAndOpens(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	token, err := config.LoadOrCreateToken()
	if err != nil {
		t.Fatalf("LoadOrCreateToken: %v", err)
	}
	port := newTestDaemon(t, token)
	if err := daemon.WriteRuntime(port); err != nil {
		t.Fatalf("WriteRuntime: %v", err)
	}

	m := &fakeManager{}
	swapManager(t, m)
	var launched []string
	restore := swapBrowser(t, func(url string) error {
		launched = append(launched, url)
		return nil
	})
	defer restore()

	var out bytes.Buffer
	if err := runEnable(&out, 2*time.Second); err != nil {
		t.Fatalf("runEnable: %v", err)
	}

	if m.enableCalls != 1 {
		t.Fatalf("Enable called %d times, want 1", m.enableCalls)
	}
	for _, want := range []string{
		"✓ login service installed",
		fmt.Sprintf("✓ daemon running on 127.0.0.1:%d", port),
		fmt.Sprintf("opening http://127.0.0.1:%d", port),
	} {
		if !strings.Contains(out.String(), want) {
			t.Errorf("transcript missing %q:\n%s", want, out.String())
		}
	}
	if len(launched) != 1 {
		t.Fatalf("browser launched %d times, want 1", len(launched))
	}
	if strings.Contains(launched[0], token) {
		t.Fatalf("enable handed the browser the session token: %s", launched[0])
	}
}

// TestRunEnableConvergesWhenAlreadyEnabled: re-running enable is not an
// error; it converges and opens the UI again.
func TestRunEnableConvergesWhenAlreadyEnabled(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	token, err := config.LoadOrCreateToken()
	if err != nil {
		t.Fatalf("LoadOrCreateToken: %v", err)
	}
	port := newTestDaemon(t, token)
	if err := daemon.WriteRuntime(port); err != nil {
		t.Fatalf("WriteRuntime: %v", err)
	}

	m := &fakeManager{st: service.Status{Installed: true, Running: true}}
	swapManager(t, m)
	restore := swapBrowser(t, func(string) error { return nil })
	defer restore()

	var out bytes.Buffer
	if err := runEnable(&out, 2*time.Second); err != nil {
		t.Fatalf("runEnable on an already-enabled service: %v", err)
	}
	if m.enableCalls != 1 {
		t.Fatalf("Enable called %d times, want 1 (Enable itself converges)", m.enableCalls)
	}
}

// TestRunEnablePointsAtServeWithoutSystemd: the WSL message. One line,
// actionable, names flue serve — not silent, not a stack trace.
func TestRunEnablePointsAtServeWithoutSystemd(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	m := &fakeManager{enableErr: fmt.Errorf("%w: Failed to connect to bus", service.ErrNoUserManager)}
	swapManager(t, m)

	var out bytes.Buffer
	err := runEnable(&out, 200*time.Millisecond)
	if err == nil {
		t.Fatal("runEnable = nil without a user manager, want an error")
	}
	if !strings.Contains(err.Error(), "flue serve") {
		t.Fatalf("error %q does not point at flue serve", err)
	}
	if !errors.Is(err, service.ErrNoUserManager) {
		t.Fatalf("error %v does not wrap ErrNoUserManager", err)
	}
}

// TestRunEnableReportsADaemonThatNeverCame: the service installed but no
// daemon answered inside the bounded wait.
func TestRunEnableReportsADaemonThatNeverCame(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	m := &fakeManager{}
	swapManager(t, m)

	var out bytes.Buffer
	err := runEnable(&out, 200*time.Millisecond)
	if err == nil {
		t.Fatal("runEnable = nil with no daemon answering, want an error")
	}
	if !strings.Contains(err.Error(), "flue status") {
		t.Fatalf("error %q does not point at flue status", err)
	}
}

func TestRunDisableRemovesTheService(t *testing.T) {
	m := &fakeManager{st: service.Status{Installed: true, Running: true}}
	swapManager(t, m)

	var out bytes.Buffer
	if err := runDisable(&out); err != nil {
		t.Fatalf("runDisable: %v", err)
	}
	if m.disableCalls != 1 {
		t.Fatalf("Disable called %d times, want 1", m.disableCalls)
	}
	if !strings.Contains(out.String(), "removed") {
		t.Fatalf("transcript does not say the service was removed:\n%s", out.String())
	}
}

// TestRunDisableIsIdempotent: not installed says so plainly and returns nil,
// which main turns into exit 0.
func TestRunDisableIsIdempotent(t *testing.T) {
	m := &fakeManager{}
	swapManager(t, m)

	var out bytes.Buffer
	if err := runDisable(&out); err != nil {
		t.Fatalf("runDisable with nothing installed: %v", err)
	}
	if m.disableCalls != 0 {
		t.Fatalf("Disable called %d times on a not-installed service, want 0", m.disableCalls)
	}
	if !strings.Contains(out.String(), "not installed") {
		t.Fatalf("transcript does not say the service is not installed:\n%s", out.String())
	}
}

func TestServiceLine(t *testing.T) {
	cases := []struct {
		st   service.Status
		want string
	}{
		{service.Status{}, "service:  not installed"},
		{service.Status{Installed: true}, "service:  installed, not running"},
		{service.Status{Installed: true, Running: true}, "service:  installed, running"},
	}
	for _, c := range cases {
		if got := serviceLine(&fakeManager{st: c.st}); got != c.want {
			t.Errorf("serviceLine(%+v) = %q, want %q", c.st, got, c.want)
		}
	}
}

func TestUsageNamesAllFourCommands(t *testing.T) {
	// The CLI surface is a spec commitment: four commands plus serve.
	for _, cmd := range []string{"flue enable", "flue disable", "flue status", "flue open", "flue serve"} {
		if !strings.Contains(usageText, cmd) {
			t.Errorf("usage() is missing %q", cmd)
		}
	}
}
```

- [ ] **Step 2: Run it to see it fail**

Run: `go test ./cmd/flue/ -run 'TestRunEnable|TestRunDisable|TestServiceLine|TestUsage' -v`
Expected: FAIL to build — `undefined: newServiceManager`, `undefined: runEnable`, `undefined: runDisable`, `undefined: serviceLine`, `undefined: usageText`.

- [ ] **Step 3: Implement the commands**

In `cmd/flue/main.go`:

Add `"io"` to the imports and `"github.com/karnstack/flue/internal/service"` to the internal import block.

Extend the `main` switch (after `case "open":`):

```go
	case "enable":
		err = cmdEnable()
	case "disable":
		err = cmdDisable()
```

Replace `usage()` with a tested constant:

```go
const usageText = `flue — your terminal, as a browser tab

  flue enable             install the login service, start the daemon, open the UI
  flue disable            remove the login service
  flue status             daemon, login service, and session diagnostics
  flue open [path]        spawn a session and open it in the browser
  flue serve [--port N]   run the daemon in the foreground
`

func usage() {
	fmt.Fprint(os.Stderr, usageText)
}
```

Append the enable/disable machinery:

```go
// enableWait bounds how long enable waits for the service-started daemon to
// answer. Longer than flue open's startTimeout: launchd/systemd get to fork,
// exec, and bind before ourDaemon can see anything.
const enableWait = 10 * time.Second

// newServiceManager builds the platform's service manager. A package
// variable so tests can substitute a fake — the same seam pattern as
// spawnDaemon and openBrowser, for the same reason: CI must never touch a
// real launchd or systemd.
var newServiceManager = defaultServiceManager

func defaultServiceManager() (service.Manager, error) {
	exe, err := os.Executable()
	if err != nil {
		return nil, err
	}
	// Resolved, per the spec: the unit records the binary itself, so a
	// brew-installed symlink and a hand-built flue both point at themselves.
	if resolved, err := filepath.EvalSymlinks(exe); err == nil {
		exe = resolved
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return nil, err
	}
	return service.ForPlatform(runtime.GOOS, exe, home, os.Getuid(), service.ExecRunner{})
}

func cmdEnable() error { return runEnable(os.Stdout, enableWait) }

// runEnable installs the login service, waits for the daemon it starts, and
// opens the UI — the parent spec's transcript, checkmark by checkmark.
func runEnable(w io.Writer, wait time.Duration) error {
	mgr, err := newServiceManager()
	if err != nil {
		if errors.Is(err, service.ErrUnsupported) {
			return fmt.Errorf("%w; run \"flue serve\" to start the daemon manually", err)
		}
		return err
	}
	if err := mgr.Enable(); err != nil {
		if errors.Is(err, service.ErrNoUserManager) {
			return fmt.Errorf("%w; run \"flue serve\" to start the daemon manually", err)
		}
		return err
	}
	fmt.Fprintf(w, "\n  ✓ login service installed\n")

	port, err := awaitDaemon(wait)
	if err != nil {
		return err
	}
	fmt.Fprintf(w, "  ✓ daemon running on 127.0.0.1:%d\n", port)

	token, err := loadToken()
	if err != nil {
		return fmt.Errorf("load auth token: %w", err)
	}
	handoff, err := mintHandoff(port, token)
	if err != nil {
		return err
	}
	fmt.Fprintf(w, "  opening http://127.0.0.1:%d\n", port)

	target := openURL(port, handoff, "")
	if err := openBrowser(target); err != nil {
		// Same trade as cmdOpen: the fallback link dies in HandoffTTL and
		// lands only in the user's own terminal, only when the launch failed.
		return fmt.Errorf("%w\nopen this within %s to get in:\n%s", err, local.HandoffTTL, target)
	}
	return nil
}

// awaitDaemon polls for a daemon this user owns, the same identity check
// flue open uses — never a bare "something is listening".
func awaitDaemon(wait time.Duration) (int, error) {
	deadline := time.Now().Add(wait)
	for time.Now().Before(deadline) {
		if port, ok := ourDaemon(); ok {
			return port, nil
		}
		time.Sleep(50 * time.Millisecond)
	}
	return 0, fmt.Errorf("the login service is installed but no daemon answered within %s; run \"flue status\" to see what it is doing", wait)
}

func cmdDisable() error { return runDisable(os.Stdout) }

// runDisable removes the login service. Idempotent by spec: disabling when
// not enabled reports that plainly and exits 0.
func runDisable(w io.Writer) error {
	mgr, err := newServiceManager()
	if err != nil {
		return err
	}
	st, err := mgr.Status()
	if err != nil {
		return err
	}
	if !st.Installed {
		fmt.Fprintln(w, "login service is not installed; nothing to do")
		return nil
	}
	if err := mgr.Disable(); err != nil {
		return err
	}
	fmt.Fprintln(w, "  ✓ login service removed")
	return nil
}

// serviceLine is the login-service line flue status gains.
func serviceLine(mgr service.Manager) string {
	st, err := mgr.Status()
	if err != nil {
		return fmt.Sprintf("service:  unknown (%v)", err)
	}
	switch {
	case !st.Installed:
		return "service:  not installed"
	case st.Running:
		return "service:  installed, running"
	default:
		return "service:  installed, not running"
	}
}
```

Then add the line to `cmdStatus` — insert at the very top of the existing function body (before `recorded, _, ok := daemon.ReadRuntimeRecord()`):

```go
	if mgr, err := newServiceManager(); err == nil {
		fmt.Println(serviceLine(mgr))
	}
```

- [ ] **Step 4: Run the tests, then the whole package**

Run: `go test ./cmd/flue/ -v`
Expected: PASS — the new tests and every pre-existing cmd/flue test.

- [ ] **Step 5: Commit**

```bash
git add cmd/flue/main.go cmd/flue/enable_test.go
git commit -m "$(cat <<'EOF'
feat(cli): add flue enable and flue disable, and teach status about the service

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: reqId on the wire — Go fixture, TS types, and the spec, in one commit

**Files:**
- Modify: `internal/wire/control.go` (`Attach` at lines 26–29, `Spawn` at lines 19–24, `Attached` at lines 64–73, `Error` at lines 87–90)
- Modify: `testdata/wire/control.json`
- Modify: `web/src/client/protocol.ts` (`AttachMsg`, `SpawnMsg`, `Attached`, `ErrorMsg`)
- Modify: `web/src/client/client.test.ts` (the "control message golden file" describe block only)
- Modify: `spec/protocol.md`
- Test: `internal/wire/wire_test.go`

**Interfaces:**
- Consumes: existing `EncodeControl`/`DecodeControl` and the golden round-trip test (which fails on any untagged field — that is the point, and why this all lands in one commit).
- Produces:
  - Go: `wire.Attach.ReqID uint64 \`json:"reqId,omitempty"\``, `wire.Spawn.ReqID`, `wire.Attached.ReqID`, `wire.Error.ReqID` — all `uint64` with tag `reqId,omitempty`. Zero means "no correlation asked for" and marshals to nothing.
  - TS: `reqId?: number` on `AttachMsg`, `SpawnMsg`, `Attached`, `ErrorMsg`.
- Task 6 sets `ReqID` on the daemon's replies; Task 7 generates reqIds in the client. Field spelling on the wire is exactly `reqId`.

- [ ] **Step 1: Write the failing Go test**

Append to `internal/wire/wire_test.go`:

```go
// TestErrorCarriesReqID pins the half FOLLOW-UPS calls mandatory: not_found
// arrives as an error, so a correlation id on attached alone leaves that
// consumer a heuristic.
func TestErrorCarriesReqID(t *testing.T) {
	b, err := EncodeControl(Error{Code: "not_found", Msg: "no such session", ReqID: 7})
	if err != nil {
		t.Fatalf("EncodeControl: %v", err)
	}
	var got map[string]any
	if err := json.Unmarshal(b, &got); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}
	if got["reqId"] != float64(7) {
		t.Fatalf("reqId = %v, want 7", got["reqId"])
	}

	// And a zero reqId is absent, not zero: a request that asked for no
	// correlation is answered exactly as before.
	b, err = EncodeControl(Error{Code: "lagged", Msg: "fell behind"})
	if err != nil {
		t.Fatalf("EncodeControl: %v", err)
	}
	got = nil
	if err := json.Unmarshal(b, &got); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}
	if _, present := got["reqId"]; present {
		t.Fatalf("zero reqId was encoded: %s", b)
	}
}

func TestAttachRoundTripsReqID(t *testing.T) {
	msg, err := DecodeControl([]byte(`{"type":"attach","id":"abc","lastSeq":42,"reqId":9}`))
	if err != nil {
		t.Fatalf("DecodeControl: %v", err)
	}
	a, ok := msg.(Attach)
	if !ok {
		t.Fatalf("msg is %T, want wire.Attach", msg)
	}
	if a.ReqID != 9 {
		t.Fatalf("ReqID = %d, want 9", a.ReqID)
	}
}
```

- [ ] **Step 2: Run it to see it fail**

Run: `go test ./internal/wire/ -v`
Expected: FAIL to build — `unknown field ReqID in struct literal`.

- [ ] **Step 3: Add the four Go fields**

In `internal/wire/control.go`:

```go
type Spawn struct {
	Cwd  string   `json:"cwd,omitempty"`
	Cmd  []string `json:"cmd,omitempty"`
	Cols uint16   `json:"cols"`
	Rows uint16   `json:"rows"`
	// ReqID correlates this request with the attached or error answering it.
	// Client-chosen; zero means the client asked for no correlation.
	ReqID uint64 `json:"reqId,omitempty"`
}

type Attach struct {
	ID      string `json:"id"`
	LastSeq uint64 `json:"lastSeq"`
	// ReqID correlates this request with the attached or error answering it.
	ReqID uint64 `json:"reqId,omitempty"`
}
```

Add to `Attached` (after `Primary bool ...`):

```go
	// ReqID echoes the reqId of the attach or spawn this answers.
	ReqID uint64 `json:"reqId,omitempty"`
```

Add to `Error` (after `Msg string ...`):

```go
	// ReqID echoes the reqId of the request this error answers, when it
	// answers one — not_found and spawn_failed do; a lagged stream does not.
	ReqID uint64 `json:"reqId,omitempty"`
```

Run: `go test ./internal/wire/ -v` — expected: PASS.

- [ ] **Step 4: Extend the shared fixture**

In `testdata/wire/control.json`:
- `attach` line becomes: `{ "name": "attach",      "json": { "type": "attach", "id": "a1b2c3d4e5f60718", "lastSeq": 4096, "reqId": 7 } }`
- `spawn` line gains `"reqId": 6` (after `"rows": 40`).
- `attached` line gains `"reqId": 7` (after `"primary": true`). `attachedTrunc` stays without one — the omitempty case.
- Append after the `error` line (add a trailing comma to `error`):

```json
  { "name": "errorForRequest", "json": { "type": "error", "code": "not_found", "msg": "no such session", "reqId": 7 } }
```

Run: `go test ./internal/wire/ -run TestGoldenControlMessages -v` — expected: PASS (the round-trip compares decoded maps, so this proves the tags).

- [ ] **Step 5: Mirror in TypeScript — types and golden tests**

In `web/src/client/protocol.ts` add to `AttachMsg`, `SpawnMsg`, `Attached`, and `ErrorMsg` (same comment, adjusted per direction):

```ts
  /**
   * Correlates a request with the `attached` or `error` that answers it.
   * Client-chosen and echoed by the daemon; absent when no correlation was
   * asked for. Mirrors `reqId,omitempty` on the Go side.
   */
  reqId?: number
```

In `web/src/client/client.test.ts`, "control message golden file" block:
- The name list in `'covers every message the protocol defines, and nothing else'` gains `'errorForRequest'` at the end.
- `'decodes attach'` literal becomes `{ type: 'attach', id: 'a1b2c3d4e5f60718', lastSeq: 4096, reqId: 7 }`.
- `'decodes spawn'` literal gains `reqId: 6`.
- `'decodes attached'` literal gains `reqId: 7`. (`attachedTrunc` unchanged — pins the optional.)
- Add:

```ts
  it('decodes an error answering a request', () => {
    const want: ErrorMsg = {
      type: 'error',
      code: 'not_found',
      msg: 'no such session',
      reqId: 7,
    }
    expect(fixture('errorForRequest')).toStrictEqual(want)
  })
```

Run: `cd web && pnpm test -- src/client/client.test.ts`
Expected: PASS.

- [ ] **Step 6: Update spec/protocol.md**

- Client-to-server table: `attach` row becomes `` `id`, `lastSeq`, `reqId?` ``; `spawn` row becomes `` `cwd`, `cmd[]`, `cols`, `rows`, `reqId?` ``.
- Server-to-client table: `attached` row gains `` `reqId?` `` at the end; `error` row becomes `` `code`, `msg`, `reqId?` ``.
- Add after the Control messages section:

```markdown
## Correlation

`attach` and `spawn` may carry a client-chosen `reqId`. The daemon echoes it
on the reply that answers the request — the `attached` on success, the
`error` on failure (`not_found`, `spawn_failed`). A reply without a `reqId`
answers a request that carried none. Clients match replies by `reqId` rather
than leaning on arrival order.
```

- [ ] **Step 7: Run both suites and commit as one**

Run: `make test`
Expected: PASS everywhere (nothing consumes the fields yet).

```bash
git add internal/wire/control.go internal/wire/wire_test.go testdata/wire/control.json web/src/client/protocol.ts web/src/client/client.test.ts spec/protocol.md
git commit -m "$(cat <<'EOF'
feat(wire): carry a client-chosen reqId on attach, spawn, attached, and error

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: daemon — echo the reqId on the reply that answers the request

**Files:**
- Modify: `internal/daemon/conn.go` (`handleControl` cases `wire.Spawn` at lines 305–313 and `wire.Attach` at lines 315–321; `attachTo` at lines 377–407; new `sendErrorFor` next to `sendError` at line 208)
- Test: `internal/daemon/server_test.go`

**Interfaces:**
- Consumes: `wire.Attach.ReqID`, `wire.Spawn.ReqID`, `wire.Attached.ReqID`, `wire.Error.ReqID` (Task 5); test helpers `newTestServer`, `dial`, `writeControl`, `readUntil` already in server_test.go.
- Produces:
  - `func (c *conn) attachTo(s *session.Session, lastSeq uint64, reqID uint64)` — third parameter added; both call sites updated.
  - `func (c *conn) sendErrorFor(reqID uint64, code, msg string)`
- Task 10 modifies this same `attachTo` again (adds `Head`); the three-argument signature here is what it starts from.

- [ ] **Step 1: Write the failing tests**

Append to `internal/daemon/server_test.go`:

```go
// --- reqId correlation ---

func TestAttachedEchoesReqID(t *testing.T) {
	ts, reg := newTestServer(t)
	s, err := reg.Spawn(session.SpawnOpts{Cmd: []string{"sleep", "2"}, Cols: 80, Rows: 24})
	if err != nil {
		t.Fatalf("Spawn: %v", err)
	}
	defer s.Close()

	c := dial(t, ts)
	writeControl(t, c, wire.Hello{Ver: "test"})
	writeControl(t, c, wire.Attach{ID: s.ID(), LastSeq: 0, ReqID: 42})
	readUntil(t, c, func(msg any, _ []byte) bool {
		a, ok := msg.(wire.Attached)
		if ok && a.ReqID != 42 {
			t.Fatalf("Attached.ReqID = %d, want 42", a.ReqID)
		}
		return ok
	})
}

func TestSpawnAttachedEchoesReqID(t *testing.T) {
	ts, _ := newTestServer(t)
	c := dial(t, ts)
	writeControl(t, c, wire.Hello{Ver: "test"})
	writeControl(t, c, wire.Spawn{Cmd: []string{"sleep", "2"}, Cols: 80, Rows: 24, ReqID: 5})
	readUntil(t, c, func(msg any, _ []byte) bool {
		a, ok := msg.(wire.Attached)
		if ok && a.ReqID != 5 {
			t.Fatalf("Attached.ReqID = %d, want 5", a.ReqID)
		}
		return ok
	})
}

// TestNotFoundEchoesReqID is the mandatory error half: not_found arrives as
// an error, so the field has to ride wire.Error or the fourth consumer stays
// a heuristic.
func TestNotFoundEchoesReqID(t *testing.T) {
	ts, _ := newTestServer(t)
	c := dial(t, ts)
	writeControl(t, c, wire.Hello{Ver: "test"})
	writeControl(t, c, wire.Attach{ID: "does-not-exist", ReqID: 7})
	readUntil(t, c, func(msg any, _ []byte) bool {
		e, ok := msg.(wire.Error)
		if !ok || e.Code != "not_found" {
			return false
		}
		if e.ReqID != 7 {
			t.Fatalf("Error.ReqID = %d, want 7", e.ReqID)
		}
		return true
	})
}

func TestSpawnFailedEchoesReqID(t *testing.T) {
	ts, _ := newTestServer(t)
	c := dial(t, ts)
	writeControl(t, c, wire.Hello{Ver: "test"})
	writeControl(t, c, wire.Spawn{Cwd: "/definitely/not/a/directory", Cmd: []string{"true"}, Cols: 80, Rows: 24, ReqID: 9})
	readUntil(t, c, func(msg any, _ []byte) bool {
		e, ok := msg.(wire.Error)
		if !ok || e.Code != "spawn_failed" {
			return false
		}
		if e.ReqID != 9 {
			t.Fatalf("Error.ReqID = %d, want 9", e.ReqID)
		}
		return true
	})
}
```

- [ ] **Step 2: Run them to see them fail**

Run: `go test ./internal/daemon/ -run 'EchoesReqID' -v`
Expected: FAIL — `Attached.ReqID = 0, want 42` (and siblings). The build passes because the fields exist since Task 5; the daemon just never sets them.

- [ ] **Step 3: Echo the reqId**

In `internal/daemon/conn.go`, next to `sendError`:

```go
// sendErrorFor answers a specific request: the error echoes the client's
// reqId so the reply is matched without leaning on arrival order. A zero
// reqID marshals to nothing (omitempty), so uncorrelated requests are
// answered exactly as before.
func (c *conn) sendErrorFor(reqID uint64, code, msg string) {
	_ = c.sendControl(wire.Error{ReqID: reqID, Code: code, Msg: msg})
}
```

In `handleControl`, the two cases become:

```go
	case wire.Spawn:
		s, err := c.srv.reg.Spawn(session.SpawnOpts{
			Cwd: m.Cwd, Cmd: m.Cmd, Cols: m.Cols, Rows: m.Rows,
		})
		if err != nil {
			c.sendErrorFor(m.ReqID, "spawn_failed", err.Error())
			return
		}
		c.attachTo(s, 0, m.ReqID)

	case wire.Attach:
		s, ok := c.srv.reg.Get(m.ID)
		if !ok {
			c.sendErrorFor(m.ReqID, "not_found", "no such session")
			return
		}
		c.attachTo(s, m.LastSeq, m.ReqID)
```

`attachTo` gains the parameter and passes it through:

```go
// attachTo subscribes to s from lastSeq and starts streaming output. reqID
// is echoed on the Attached so the client can match the reply to its request.
func (c *conn) attachTo(s *session.Session, lastSeq uint64, reqID uint64) {
```

and in the `wire.Attached` literal add `ReqID: reqID,` after `Primary: primary,`.

- [ ] **Step 4: Run the daemon suite**

Run: `go test ./internal/daemon/ -v`
Expected: PASS — new tests and all pre-existing ones (the `attach` helper sends `ReqID: 0`, which echoes as absent).

- [ ] **Step 5: Commit**

```bash
git add internal/daemon/conn.go internal/daemon/server_test.go
git commit -m "$(cat <<'EOF'
feat(daemon): echo the reqId on the reply that answers the request

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: web client — settle replies by reqId, retire the counters

**Files:**
- Modify: `web/src/client/client.ts` (fields `pending`/`refused` at lines 168–177, `attach` at ~line 301, `spawn` at ~line 281, `forget` at ~line 345, `handleControl` cases `attached`/`error` at lines 464–535, `teardown` at ~line 565, `count` at ~line 586, the reattach replay in `openSocket`'s `onopen` at ~line 407)
- Test: `web/src/client/client.test.ts`

**Interfaces:**
- Consumes: `reqId?: number` on `AttachMsg`, `SpawnMsg`, `Attached`, `ErrorMsg` (Task 5); the daemon's echo (Task 6).
- Produces (the API Tasks 8–9 build on — exact signatures):
  - `spawn(opts: { cwd?: string; cmd?: string[]; cols: number; rows: number }): number | null` — the reqId sent, or null when the socket was down (spawn is still dropped, never held).
  - `abandon(reqId: number): void` — the reply to that request, when it arrives, is handed straight back (`detach`) and adopted by nobody.
  - `onSessionGone(cb: (id: string) => void): () => void` — fired with the session id when an attach is answered `not_found`; the client has already removed the session from its reattach plan.
  - `attach(id: string, lastSeq = 0): void` and `forget(id: string): void` keep their signatures; internally forget abandons every in-flight request for that session.
- Every sent `attach`/`spawn` frame now carries `reqId`, allocated 1, 2, 3… per send on the client instance. Test expectations count them in send order.

- [ ] **Step 1: Write the failing tests for the new behavior**

Append to `web/src/client/client.test.ts` (inside a new `describe('FlueClient correlation', ...)`):

```ts
describe('FlueClient correlation', () => {
  it('numbers attach and spawn requests in send order', () => {
    const { c, sock } = connected()
    c.attach('s1', 0)
    const reqId = c.spawn({ cols: 80, rows: 24 })

    expect(sock.sentControl().slice(1)).toStrictEqual([
      { type: 'attach', id: 's1', lastSeq: 0, reqId: 1 },
      { type: 'spawn', cols: 80, rows: 24, reqId: 2 },
    ])
    expect(reqId).toBe(2)
  })

  it('returns null for a spawn the socket could not carry', () => {
    const { c } = harness()
    c.connect()
    expect(c.spawn({ cols: 80, rows: 24 })).toBeNull()
  })

  it('hands back an abandoned reply and adopts nothing', () => {
    const { c, sock } = connected()
    const seen: number[] = []
    c.onAttached((a) => seen.push(a.ref))

    const reqId = c.spawn({ cols: 80, rows: 24 })!
    c.abandon(reqId)
    sock.emitControl({
      type: 'attached',
      ref: 5,
      id: 'orphan',
      cols: 80,
      rows: 24,
      title: '',
      seq: 0,
      truncated: false,
      primary: true,
      reqId,
    })

    expect(seen).toEqual([])
    expect(c.lastSeqFor(5)).toBeUndefined()
    expect(sock.sentControl()).toContainEqual({ type: 'detach', ref: 5 })
  })

  it('abandons once: a second reply for the session is adopted normally', () => {
    const { c, sock } = connected()
    const seen: number[] = []
    c.onAttached((a) => seen.push(a.ref))

    c.attach('s1', 0) // reqId 1
    c.forget('s1') // abandons reqId 1
    c.attach('s1', 0) // reqId 2
    for (const [ref, reqId] of [
      [1, 1],
      [2, 2],
    ] as const) {
      sock.emitControl({
        type: 'attached',
        ref,
        id: 's1',
        cols: 80,
        rows: 24,
        title: '',
        seq: 0,
        truncated: false,
        primary: ref === 1,
        reqId,
      })
    }

    expect(seen).toEqual([2])
    expect(sock.sentControl()).toContainEqual({ type: 'detach', ref: 1 })
    expect(sock.sentControl()).not.toContainEqual({ type: 'detach', ref: 2 })
  })

  it('announces a session the daemon does not know, by id', () => {
    const { c, sock } = connected()
    const gone: string[] = []
    c.onSessionGone((id) => gone.push(id))

    c.attach('dead', 0) // reqId 1
    sock.emitControl({ type: 'error', code: 'not_found', msg: 'no such session', reqId: 1 })

    expect(gone).toEqual(['dead'])
  })

  it('drops a not_found session from the plan without a forget', async () => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const { c, sockets } = harness()

    c.connect()
    sockets[0]!.open()
    c.attach('dead', 0) // reqId 1
    sockets[0]!.emitControl({ type: 'error', code: 'not_found', msg: 'no such session', reqId: 1 })

    sockets[0]!.close()
    await vi.advanceTimersByTimeAsync(125)
    sockets[1]!.open()

    expect(sockets[1]!.sentControl().filter((m) => m.type === 'attach')).toEqual([])
  })

  it('announces not_found for a reattach replayed after a reconnect', async () => {
    // A daemon restart forgets every session; the replayed attach carries a
    // reqId nothing in the tab holds, so the client itself has to resolve it
    // back to the session. This is the case the old ref-is-null heuristic in
    // the terminal could not cover exactly.
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const { c, sockets } = harness()
    const gone: string[] = []
    c.onSessionGone((id) => gone.push(id))

    c.connect()
    sockets[0]!.open()
    c.attach('s1', 0) // reqId 1
    sockets[0]!.emitControl({
      type: 'attached',
      ref: 1,
      id: 's1',
      cols: 80,
      rows: 24,
      title: '',
      seq: 0,
      truncated: false,
      primary: true,
      reqId: 1,
    })

    sockets[0]!.close()
    await vi.advanceTimersByTimeAsync(125)
    sockets[1]!.open() // the plan replays attach with reqId 2
    sockets[1]!.emitControl({ type: 'error', code: 'not_found', msg: 'no such session', reqId: 2 })

    expect(gone).toEqual(['s1'])
  })

  it('does not abandon a request that was already answered', () => {
    const { c, sock } = connected()
    const seen: number[] = []
    c.onAttached((a) => seen.push(a.ref))

    c.attach('s1', 0) // reqId 1
    sock.emitControl({
      type: 'attached',
      ref: 1,
      id: 's1',
      cols: 80,
      rows: 24,
      title: '',
      seq: 0,
      truncated: false,
      primary: true,
      reqId: 1,
    })
    c.forget('s1') // nothing in flight: must arm nothing

    c.attach('s1', 0) // reqId 2
    sock.emitControl({
      type: 'attached',
      ref: 2,
      id: 's1',
      cols: 80,
      rows: 24,
      title: '',
      seq: 0,
      truncated: false,
      primary: true,
      reqId: 2,
    })

    expect(seen).toEqual([1, 2])
  })
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `cd web && pnpm test -- src/client/client.test.ts`
Expected: FAIL — `c.abandon is not a function`, `c.onSessionGone is not a function`, and frame mismatches (no `reqId` on sent attach).

- [ ] **Step 3: Implement correlation in FlueClient**

In `web/src/client/client.ts`:

Replace the `pending` and `refused` fields (and delete the `count` helper at the bottom of the class) with:

```ts
  /** The next request id; allocated per sent attach/spawn, never reused. */
  private nextReqId = 1

  /**
   * Requests on the wire, reqId -> the session asked for (`null` for a
   * spawn, whose session does not exist yet). Cleared by `teardown`:
   * replies do not survive their socket.
   */
  private pending = new Map<number, string | null>()

  /**
   * Requests whose reply should be handed straight back rather than adopted
   * — a view let go before the answer arrived. See `abandon` and `forget`.
   */
  private abandoned = new Set<number>()
```

Add the listener plumbing next to the other emitters and registrations:

```ts
  private goneListeners = new Emitter<[string]>()
```

```ts
  /**
   * A session the daemon answered `not_found` for. The client has already
   * dropped it from the reattach plan; consumers only need to stop showing
   * it. Fired for the mount-time attach and for a reattach replayed after a
   * reconnect alike — the client resolves the reqId, so consumers never
   * have to.
   */
  onSessionGone(cb: (id: string) => void) {
    return this.goneListeners.add(cb)
  }
```

Replace `attach`, add `sendAttach`, replace `spawn`, replace `forget`, add `abandon`:

```ts
  /**
   * Attach to a session and keep it attached across reconnects.
   *
   * Recorded before it is sent, so a socket that is not ready yet — or that
   * drops before `attached` comes back — still replays this on open. Each
   * sent attach carries a fresh reqId; the daemon echoes it on the reply.
   */
  attach(id: string, lastSeq = 0) {
    this.wanted.set(id, lastSeq)
    this.sendAttach(id, lastSeq)
  }

  private sendAttach(id: string, lastSeq: number) {
    if (!this.ready || !this.sock) return
    const reqId = this.nextReqId++
    this.send({ type: 'attach', id, lastSeq, reqId })
    this.pending.set(reqId, id)
  }

  /**
   * Ask for a new session. Returns the reqId the reply will echo, or null
   * when the socket was down — dropped rather than held, as before: a shell
   * that appears minutes later at a screen nobody is looking at is worse
   * than none.
   */
  spawn(opts: { cwd?: string; cmd?: string[]; cols: number; rows: number }): number | null {
    if (!this.ready || !this.sock) return null
    const { cols, rows, ...rest } = opts
    const reqId = this.nextReqId++
    this.send({ type: 'spawn', ...rest, cols: dimension(cols), rows: dimension(rows), reqId })
    this.pending.set(reqId, null)
    return reqId
  }

  /**
   * Disown one in-flight request. Its reply, when it arrives, is handed
   * straight back (`detach`) and adopted by nobody — the exact mechanism
   * that used to be a per-session refusal count, now naming the one reply
   * it means. A reqId that is not in flight abandons nothing.
   */
  abandon(reqId: number) {
    if (!this.pending.delete(reqId)) return
    this.abandoned.add(reqId)
  }

  /**
   * Stop trying to reattach a session, without naming a ref. Final: the
   * plan entry goes, and every in-flight request for the session is
   * abandoned, so a reply already on the wire cannot re-seed the plan.
   */
  forget(id: string) {
    this.wanted.delete(id)
    for (const [reqId, sid] of this.pending) {
      if (sid === id) {
        this.pending.delete(reqId)
        this.abandoned.add(reqId)
      }
    }
  }
```

In `openSocket`'s `onopen`, the replay loop becomes:

```ts
      for (const [id, lastSeq] of this.wanted) this.sendAttach(id, lastSeq)
```

In `handleControl`, the `attached` case's preamble becomes (the adoption code after it is unchanged):

```ts
      case 'attached': {
        if (msg.reqId !== undefined && this.abandoned.delete(msg.reqId)) {
          // Asked for, then let go of before the answer arrived. Hand the
          // ref straight back rather than adopting an attachment nobody is
          // behind. Named by reqId, so a second attach issued in the
          // meantime — a StrictMode remount — is answered normally.
          this.send({ type: 'detach', ref: msg.ref })
          break
        }
        if (msg.reqId !== undefined) this.pending.delete(msg.reqId)
        // ...existing adoption code from `this.attachments.set(...)` down to
        // `this.attachedListeners.emit(msg)` stays exactly as it is...
        break
      }
```

The `error` case becomes:

```ts
      case 'error': {
        if (msg.reqId !== undefined) {
          this.abandoned.delete(msg.reqId)
          const sid = this.pending.get(msg.reqId)
          this.pending.delete(msg.reqId)
          if (msg.code === 'not_found' && typeof sid === 'string') {
            // The daemon does not know the session, so the plan must stop
            // asking for it — on this connection and every next one.
            this.wanted.delete(sid)
            this.goneListeners.emit(sid)
          }
        }
        this.errorListeners.emit(msg)
        break
      }
```

In `teardown`, replace `this.pending.clear(); this.refused.clear()` with:

```ts
    // Both name replies that were on the wire, and this socket was the wire.
    this.pending.clear()
    this.abandoned.clear()
```

Update the class doc comment: delete the paragraph beginning "That limit is about two views alive at once…" and replace with one sentence: "Replies are matched to requests by `reqId`, so StrictMode's attach/forget/attach inside one round-trip settles each reply against the exact request that asked."

- [ ] **Step 4: Update the pre-existing expectations**

Rule: every assertion on an exact sent `attach` or `spawn` frame gains `reqId: <n>`, where n counts sent attach/spawn frames on that client in order (allocation happens only when the frame is actually sent). Replies emitted by fake sockets that must settle a specific request now echo that request's reqId. Concretely, in `web/src/client/client.test.ts`:

- `'reattaches with lastSeq after a reconnect'`: first attach is reqId 1; the reconnect replay is reqId 2 → `expect(attach).toStrictEqual({ type: 'attach', id: 's1', lastSeq: 5, reqId: 2 })`.
- `'sends attach exactly once when it is issued before the socket opens'`: the pre-open attach is not sent; the replay on open is the first send → `[{ type: 'attach', id: 's1', lastSeq: 12, reqId: 1 }]`.
- `'reattaches a session it spawned...'`: spawn is reqId 1, replay attach is reqId 2 → `[{ type: 'attach', id: 'fresh', lastSeq: 2, reqId: 2 }]`.
- `'ignores a detach naming a ref the session has since been renumbered off'`: attaches are reqIds 1 and 2, first replay is 3, second replay is 4 → final expectation `[{ type: 'attach', id: 's2', lastSeq: 0, reqId: 4 }]`.
- `'plans one attachment per session, however many refs it holds'`: replay → `[{ type: 'attach', id: 's1', lastSeq: 4, reqId: 3 }]`.
- `'refuses an attached that lands after the session was forgotten'`: the emitted `attached` gains `reqId: 1` (it settles the forgotten attach).
- `'adopts only the second reply when a view re-attaches inside the round-trip'`: the two emitted `attached` gain `reqId: ref` (1 and 2).
- `'drops an unanswered refusal when the connection goes'`: the post-reconnect attach is reqId 2; the emitted `attached` gains `reqId: 2`.
- `'retires a session by name, for a view that never got a ref'`: the emitted `error` gains `reqId: 1`.
- `'completes the handshake when a status listener throws on open'` and `'rounds and clamps dimensions...'` and `'sends the remaining control messages the protocol defines'`: sent attach/spawn frames gain their in-order reqIds (`attach` reqId 1 in the handshake test; `spawn` gains `reqId: 1` — or the next number in sequence — in the sending tests; read the failure diff, it prints the actual frame).
- Two expectations outside this file assert exact sent frames and need the same mechanical update (the screens' *behavior* is untouched here — replies without `reqId` are adopted exactly as before — but `toEqual` fails on the extra property):
  - `web/src/routes/sessions.test.tsx`, `'starts a session only when the user asks, and never from an effect'`: expectation becomes `[{ type: 'spawn', cols: 80, rows: 24, reqId: 1 }]`.
  - `web/src/components/terminal.test.tsx`, `'attaches to its own session on mount'`: expectation becomes `[{ type: 'attach', id: 's1', lastSeq: 0, reqId: 1 }]`.
  - Then run the full web suite; if any other test (router.test.tsx included) asserts an exact `attach`/`spawn` frame, apply the same rule — the in-order reqId, read off the failure diff.

Run: `cd web && pnpm test`
Expected: PASS — full suite. The sessions and terminal suites change only in the two frame literals above; their heuristics still see the same ordering and are retired in Tasks 8–9.

- [ ] **Step 5: Commit**

```bash
git add web/src/client/client.ts web/src/client/client.test.ts
git commit -m "$(cat <<'EOF'
feat(web): settle attach and spawn replies by reqId, not arrival order

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: sessions route — retire `owed` and `refuseNext`

**Files:**
- Modify: `web/src/routes/sessions.tsx` (delete `refuseNext` at lines 87–110 and the `owed`/`owe` machinery at lines 160–168; rewrite the effect at lines 170–235 and `startSession` at lines 244–257)
- Test: `web/src/routes/sessions.test.tsx`

**Interfaces:**
- Consumes: `client.spawn(opts): number | null`, `client.abandon(reqId)`, `Attached.reqId?`, `ErrorMsg.reqId?` (Task 7).
- Produces: no new exports. The screen's contract is unchanged: click → spawn → navigate to `/d/local/s/<id>` on the reply, notice on failure, abandon on unmount.

- [ ] **Step 1: Update the tests to the reqId contract (failing first)**

In `web/src/routes/sessions.test.tsx`:

- `'starts a session only when the user asks...'`: expectation is `[{ type: 'spawn', cols: 80, rows: 24, reqId: 1 }]` (Task 7 already made this edit; verify it is in place).
- Everywhere a test emits the `attached` that settles this screen's spawn, add the spawn's reqId (the screen's first spawn on a fresh client is always `reqId: 1`; a second spawn after a settled first is `reqId: 2`):
  - `'hands back the attachment the daemon gave it, then opens the new session'` → `attached({ ref: 4, id: 'fresh1', reqId: 1 })`.
  - `'takes one attached per spawn, not the next one that happens by'` → first emit gains `reqId: 1`; the second emit stays without a reqId (a reattach shape) and must still be ignored.
  - `'hands back a spawn answered after the screen has gone'` → `attached({ ref: 7, id: 'orphan', reqId: 1 })`.
  - `'leaves nothing behind for the reattach plan to re-establish'` → same, `reqId: 1`.
  - `'does not claim a reply an earlier refusal already handed back'` → first emit gains `reqId: 1`, second `reqId: 2`.
- Error settlements gain the reqId too: in `'lets the user try again once a spawn has been answered'`, `'says so when the daemon refuses to start a session'`, `'stops refusing when the spawn it was armed for failed'`, and `'stops waiting for a reply that is never coming'`, the emitted `spawn_failed` error gains `reqId: 1` — and in `'stops refusing when the spawn it was armed for failed'` the follow-up `attached({ ref: 1, id: 'a-terminal' })` deliberately carries **no** reqId and must produce no detach.
- Add one new test:

```ts
  it('ignores a spawn_failed that answers someone else’s request', async () => {
    // reqId is the whole point: an error naming another request must not
    // write off this screen's debt or show its notice.
    const { sock, router } = await mountSessions()
    await userEvent.click(newSession())

    act(() => sock.emitControl({ type: 'error', code: 'spawn_failed', msg: 'nope', reqId: 99 }))
    expect(screen.getByRole('status').textContent).not.toContain('nope')

    act(() => sock.emitControl(attached({ ref: 4, id: 'fresh1', reqId: 1 })))
    await waitFor(() => expect(router.state.location.pathname).toBe('/d/local/s/fresh1'))
  })
```

- [ ] **Step 2: Run them to see them fail**

Run: `cd web && pnpm test -- src/routes/sessions.test.tsx`
Expected: FAIL — the spawn frame carries `reqId: 1` but the old screen navigates on the first `attached` regardless of reqId, so `'takes one attached per spawn'` and the new test fail.

- [ ] **Step 3: Rewrite the screen on reqIds**

In `web/src/routes/sessions.tsx`:

Delete `refuseNext` entirely. Keep `SPAWN_FAILED` (shorten its comment to: a spawn is settled by the `attached` or the `error` echoing its reqId, or by the connection going away). Replace the `owed`/`owe` machinery and the effect body:

```ts
  /**
   * The reqIds of spawns this screen asked for and has not yet seen
   * answered. A ref, because listeners read it without re-registering;
   * `starting` shadows its emptiness for the one thing that renders.
   */
  const spawns = useRef(new Set<number>())
  const [starting, setStarting] = useState(false)

  const settle = useCallback((reqId: number): boolean => {
    if (!spawns.current.delete(reqId)) return false
    setStarting(spawns.current.size > 0)
    return true
  }, [])

  useEffect(() => {
    const offs = [
      client.onSessions(setSessions),

      client.onStatus((s) => {
        setStatus(s)
        setNotice(null)
        // Replies do not survive their socket: a spawn whose answer the
        // outage carried away is never coming, and the client cleared its
        // own bookkeeping the same way.
        if (s !== 'open') {
          spawns.current.clear()
          setStarting(false)
        }
      }),

      client.onError((e) => {
        // Only an error echoing one of this screen's reqIds is this
        // screen's to act on.
        if (e.reqId === undefined || !settle(e.reqId)) return
        if (e.code === SPAWN_FAILED) setNotice(`Could not start a session: ${e.msg}`)
      }),

      client.onAttached((a) => {
        if (a.reqId === undefined || !settle(a.reqId)) return
        // Hand the ref straight back: this screen renders no terminal, and
        // the route it navigates to attaches on its own.
        client.detach(a.ref)
        void navigate({
          to: TERMINAL_PATH,
          params: { deviceId: LOCAL_DEVICE, sessionId: a.id },
        })
      }),
    ]

    client.list()
    const poll = setInterval(() => client.list(), REFRESH_MS)

    return () => {
      clearInterval(poll)
      for (const off of offs) off()
      // Whatever this screen asked for and did not live to see answered:
      // the client hands each reply back when it lands.
      for (const reqId of spawns.current) client.abandon(reqId)
      spawns.current.clear()
    }
  }, [client, navigate, settle])
```

And `startSession`:

```ts
  function startSession() {
    setNotice(null)
    // 80x24 is a starting point, not a decision; the terminal corrects it
    // the moment it can measure a pane.
    const reqId = client.spawn({ cols: 80, rows: 24 })
    if (reqId !== null) {
      spawns.current.add(reqId)
      setStarting(true)
      return
    }
    setNotice('Not connected to the flue daemon, so nothing was started.')
  }
```

- [ ] **Step 4: Run the suite**

Run: `cd web && pnpm test -- src/routes/sessions.test.tsx`
Expected: PASS. Then `cd web && pnpm test` — full suite PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/routes/sessions.tsx web/src/routes/sessions.test.tsx
git commit -m "$(cat <<'EOF'
refactor(web): retire the sessions screen's owed counter and refuseNext

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: terminal route — retire the `not_found` heuristic

**Files:**
- Modify: `web/src/components/terminal.tsx` (the `client.onError` registration at lines 273–286)
- Test: `web/src/components/terminal.test.tsx`

**Interfaces:**
- Consumes: `client.onSessionGone(cb: (id: string) => void)` (Task 7).
- Produces: no new exports. Phase `'gone'` is now driven by the client's exact resolution instead of "an error with no ref held".

- [ ] **Step 1: Update the tests (failing first)**

In `web/src/components/terminal.test.tsx`, find the existing test that emits `{ type: 'error', code: 'not_found', ... }` and asserts the "This session is gone" pill. Update it to the exact contract — the mount attach is `reqId: 1` on a fresh client:

```ts
  it('shows gone when the daemon answers its attach with not_found', () => {
    const { sock } = mountTerminal((em) => <Terminal sessionId="s1" createEmulator={em.create} />)

    act(() =>
      sock.emitControl({ type: 'error', code: 'not_found', msg: 'no such session', reqId: 1 }),
    )

    expect(screen.getByRole('status').textContent).toContain('gone')
  })

  it('ignores a not_found that answers someone else’s attach', () => {
    // Exactness is the point of the reqId: before it, any not_found arriving
    // while this view held no ref was assumed to be its own.
    const { sock } = mountTerminal((em) => <Terminal sessionId="s1" createEmulator={em.create} />)

    act(() =>
      sock.emitControl({ type: 'error', code: 'not_found', msg: 'no such session', reqId: 99 }),
    )

    expect(screen.queryByRole('status')?.textContent ?? '').not.toContain('gone')
  })
```

The first test in the file — `'attaches to its own session on mount'` — already expects `[{ type: 'attach', id: 's1', lastSeq: 0, reqId: 1 }]` since Task 7; verify, and add `reqId` the same way to any other exact-attach expectation the run flags.

- [ ] **Step 2: Run them to see them fail**

Run: `cd web && pnpm test -- src/components/terminal.test.tsx`
Expected: FAIL — `'ignores a not_found that answers someone else’s attach'` fails against the old heuristic (any not_found with no ref flips the pill).

- [ ] **Step 3: Swap the heuristic for the exact signal**

In `web/src/components/terminal.tsx`, replace the whole `client.onError` registration (lines 273–286) with:

```ts
    offs.push(
      client.onSessionGone((id) => {
        // The client resolved the not_found to its session by reqId and has
        // already dropped it from the reattach plan — for the mount-time
        // attach and for a replay after a daemon restart alike. Terminal
        // states are final: a later reconnect must not walk this back.
        if (id !== sessionId || over) return
        over = true
        setPhase('gone')
      }),
    )
```

The cleanup keeps its `else client.forget(sessionId)` branch — forget is now the only caller left that needs it, and it is idempotent.

- [ ] **Step 4: Run the suite**

Run: `cd web && pnpm test`
Expected: PASS — full suite.

- [ ] **Step 5: Commit**

```bash
git add web/src/components/terminal.tsx web/src/components/terminal.test.tsx
git commit -m "$(cat <<'EOF'
refactor(web): retire the terminal's not_found heuristic

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: `head` on `attached` — wire, conn.go, fixture, TS types, spec, one commit

**Files:**
- Modify: `internal/wire/control.go` (`Attached`, from Task 6 state)
- Modify: `internal/daemon/conn.go` (`attachTo` — the `Subscribe` call at line ~379 and the `wire.Attached` literal)
- Modify: `testdata/wire/control.json` (`attached`, `attachedTrunc`)
- Modify: `web/src/client/protocol.ts` (`Attached`), `web/src/client/client.test.ts` (golden literals), `web/src/testing/socket.ts` (`attached()` helper)
- Modify: `spec/protocol.md`
- Test: `internal/daemon/server_test.go`

**Interfaces:**
- Consumes: `sub.StartSeq uint64` and `sub.Backlog []byte` on `session.Sub` (internal/session/session.go lines 70–78); `attachTo(s, lastSeq, reqID)` from Task 6.
- Produces:
  - Go: `wire.Attached.Head uint64 \`json:"head"\`` — always present, computed as `sub.StartSeq + uint64(len(sub.Backlog))` in `attachTo`.
  - TS: `head: number` (required) on `Attached`; `testing/socket.ts`'s `attached()` helper defaults `head` to `seq` so every existing test models a fresh spawn.
- Task 11's mute gate reads `a.head` and opens immediately when `head === seq`.

- [ ] **Step 1: Write the failing daemon tests**

Append to `internal/daemon/server_test.go`:

```go
// --- head: where the replayed backlog ends ---

// TestAttachedHeadCoversTheBacklog: attach to a session whose entire output
// is already in the ring. head must equal seq plus every backlog byte the
// client is about to receive — the offset at which live output begins.
func TestAttachedHeadCoversTheBacklog(t *testing.T) {
	ts, reg := newTestServer(t)
	s, err := reg.Spawn(session.SpawnOpts{Cmd: []string{"sh", "-c", "echo replayed"}, Cols: 80, Rows: 24})
	if err != nil {
		t.Fatalf("Spawn: %v", err)
	}
	defer s.Close()
	waitForExit(t, s)

	c := dial(t, ts)
	writeControl(t, c, wire.Hello{Ver: "test"})
	writeControl(t, c, wire.Attach{ID: s.ID(), LastSeq: 0})

	var att wire.Attached
	readUntil(t, c, func(msg any, _ []byte) bool {
		a, ok := msg.(wire.Attached)
		if ok {
			att = a
		}
		return ok
	})

	var backlog []byte
	readUntil(t, c, func(msg any, out []byte) bool {
		_, done := msg.(wire.Exit)
		if done {
			backlog = append([]byte(nil), out...)
		}
		return done
	})

	if att.Head != att.Seq+uint64(len(backlog)) {
		t.Fatalf("Head = %d, want Seq %d + backlog %d", att.Head, att.Seq, len(backlog))
	}
	if att.Head == att.Seq {
		t.Fatal("Head == Seq for a session with output in the ring; the gate would never arm")
	}
}

// TestAttachedHeadEqualsSeqOnAFreshSpawn: an empty backlog omits the output
// frame entirely, which is why gating on "the first output frame" was wrong.
// head == seq is what lets the client open the gate immediately.
func TestAttachedHeadEqualsSeqOnAFreshSpawn(t *testing.T) {
	ts, reg := newTestServer(t)
	s, err := reg.Spawn(session.SpawnOpts{Cmd: []string{"cat"}, Cols: 80, Rows: 24})
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
		if a.Head != a.Seq {
			t.Fatalf("Head = %d, Seq = %d; want equal on an empty backlog", a.Head, a.Seq)
		}
		return true
	})
}
```

- [ ] **Step 2: Run them to see them fail**

Run: `go test ./internal/daemon/ -run 'AttachedHead' -v`
Expected: FAIL to build — `a.Head undefined (type wire.Attached has no field or method Head)`.

- [ ] **Step 3: Add the field and compute it**

In `internal/wire/control.go`, add to `Attached` (after `Truncated`):

```go
	// Head is the offset one past the replayed backlog: bytes below Head are
	// history, bytes at or after it are live. Head == Seq means no backlog.
	Head uint64 `json:"head"`
```

In `internal/daemon/conn.go` `attachTo`, immediately after `sub := s.Subscribe(lastSeq)` — the two adjacent lines FOLLOW-UPS names:

```go
	sub := s.Subscribe(lastSeq)
	// head is where the replayed backlog ends. The scrollback carries the
	// shell's own DA/DECRQM/OSC-11 probe replies, and the emulator answers
	// them again on write; the client mutes its input until it has consumed
	// head bytes so those answers never reach the shell's stdin.
	head := sub.StartSeq + uint64(len(sub.Backlog))
```

and add `Head: head,` to the `wire.Attached` literal (after `Truncated: sub.Truncated,`).

Run: `go test ./internal/daemon/ ./internal/wire/ -v` — expected: PASS, except `TestGoldenControlMessages` now fails (fixture lacks `head` while re-encode emits it). That failure is the fixture forcing the one-commit rule; fix it next.

- [ ] **Step 4: Extend the fixture, the TS types, and the helper**

- `testdata/wire/control.json`: `attached` gains `"head": 8192` (a delta with 4096 bytes of backlog behind `"seq": 4096`); `attachedTrunc` gains `"head": 99512`.
- `web/src/client/protocol.ts` `Attached` gains (after `truncated`):

```ts
  /**
   * The offset one past the replayed backlog. Bytes below `head` are
   * history; bytes at or after it are live. `head === seq` means the
   * backlog is empty and there is nothing to mute.
   */
  head: number
```

- `web/src/client/client.test.ts`: `'decodes attached'` literal gains `head: 8192`; `'decodes a truncated attached'` gains `head: 99512`. Every other emitted `attached` object literal in this file gains `head: <its seq value>` (the fresh-attach shape; TypeScript now requires the field — the compiler lists every site).
- `web/src/testing/socket.ts`: the `attached()` helper becomes:

```ts
/** A complete `attached`, so a caller only names the fields it cares about.
 *  `head` defaults to `seq` — the fresh-spawn shape, in which nothing is
 *  muted — so only replay tests say otherwise. */
export function attached(over: Partial<Attached> & { ref: number; id: string }): Attached {
  const seq = over.seq ?? 0
  return {
    type: 'attached',
    cols: 80,
    rows: 24,
    title: '',
    seq,
    head: seq,
    truncated: false,
    primary: true,
    ...over,
  }
}
```

- [ ] **Step 5: Update spec/protocol.md**

- Server-to-client table `attached` row becomes: `` `ref`, `id`, `cols`, `rows`, `title`, `seq`, `head`, `truncated`, `primary`, `reqId?` ``.
- In the Sequencing section, after the `seq` paragraph, add:

```markdown
`head` in `attached` is the offset one past the replayed backlog: every byte
below `head` is history the ring is about to replay, and every byte at or
after it is live output. `head == seq` means the backlog is empty (the
daemon omits the output frame entirely in that case). Clients must not let
emulator-generated replies to replayed bytes — DA, DECRQM, OSC 11 probe
responses — reach the daemon: mute input until `head` bytes have been
consumed.
```

- [ ] **Step 6: Run everything and commit as one**

Run: `make test`
Expected: PASS — Go golden, TS golden, daemon, and both app suites.

```bash
git add internal/wire/control.go internal/daemon/conn.go internal/daemon/server_test.go testdata/wire/control.json web/src/client/protocol.ts web/src/client/client.test.ts web/src/testing/socket.ts spec/protocol.md
git commit -m "$(cat <<'EOF'
feat(wire): tell the client where the replayed backlog ends

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 11: terminal — mute onData until the backlog is consumed

**Files:**
- Modify: `web/src/components/terminal.tsx` (effect-local state at lines 117–124, the `emulator.onData` registration at lines 193–197, the `onAttached` handler at lines 228–243, the `onOutput` handler at lines 245–249)
- Test: `web/src/components/terminal.test.tsx`

**Interfaces:**
- Consumes: `Attached.head` (Task 10); `attached()` helper defaulting `head` to `seq`.
- Produces: no new exports. The gate is per-attach state — two effect-local numbers reset by every `attached` — so a socket dying mid-backlog re-arms it with the next attachment, exactly as the spec's error-handling section requires.

- [ ] **Step 1: Write the failing tests**

Append to `web/src/components/terminal.test.tsx`:

```ts
  describe('the replay mute gate', () => {
    it('opens immediately on a fresh spawn, where head equals seq', () => {
      // Gating on "the first output frame" would never open here: the
      // daemon omits that frame entirely when the backlog is empty.
      const { sock, em } = mountTerminal((e) => (
        <Terminal sessionId="s1" createEmulator={e.create} />
      ))
      act(() => sock.emitControl(attached({ ref: 1, id: 's1', seq: 0 }))) // head defaults to seq

      act(() => em.live().send('ls\r'))

      expect(sock.input()).toEqual([{ ref: 1, text: 'ls\r' }])
    })

    it('mutes emulator replies while the backlog replays', () => {
      // The ring holds the shell's own DA/DECRQM/OSC-11 probe replies, and
      // xterm answers them again as they are written. Reproduced 4/4 before
      // the gate: reload, reopen, route navigation, second mirror tab.
      const { sock, em } = mountTerminal((e) => (
        <Terminal sessionId="s1" createEmulator={e.create} />
      ))
      act(() => sock.emitControl(attached({ ref: 1, id: 's1', seq: 0, head: 10 })))

      act(() => sock.emitOutput(1, '123456')) // 6 of 10 backlog bytes
      act(() => em.live().send('\x1b[?1;2c')) // xterm answering a replayed DA probe

      expect(sock.input()).toEqual([])

      act(() => sock.emitOutput(1, '7890')) // backlog complete: consumed == head
      act(() => em.live().send('ls\r'))

      expect(sock.input()).toEqual([{ ref: 1, text: 'ls\r' }])
    })

    it('opens at exactly head, not one byte later', () => {
      const { sock, em } = mountTerminal((e) => (
        <Terminal sessionId="s1" createEmulator={e.create} />
      ))
      act(() => sock.emitControl(attached({ ref: 1, id: 's1', seq: 0, head: 4 })))
      act(() => sock.emitOutput(1, 'abcd'))

      act(() => em.live().send('x'))

      expect(sock.input()).toEqual([{ ref: 1, text: 'x' }])
    })

    it('re-arms with the attachment after a reconnect mid-backlog', async () => {
      // The gate is per-attach state, not per-connection: a socket dying
      // mid-backlog resets it with the next attached, whose head names the
      // next replay's end.
      vi.useFakeTimers()
      vi.spyOn(Math, 'random').mockReturnValue(0)
      const { client, sockets, sock, em } = mountTerminal((e) => (
        <Terminal sessionId="s1" createEmulator={e.create} />
      ))
      act(() => sock.emitControl(attached({ ref: 1, id: 's1', seq: 0, head: 6 })))
      act(() => sock.emitOutput(1, 'abc')) // 3 of 6, then the socket dies

      act(() => sock.close())
      await act(() => vi.advanceTimersByTimeAsync(125))
      act(() => sockets[1]!.open())
      // The reattach resumes at 3; the daemon replays 3..8 as backlog.
      act(() => sockets[1]!.emitControl(attached({ ref: 1, id: 's1', seq: 3, head: 8 })))

      act(() => em.live().send('\x1b]11;rgb:0000/0000/0000\x07')) // OSC 11 reply to a replayed probe
      expect(sockets[1]!.input()).toEqual([])

      act(() => sockets[1]!.emitOutput(1, 'defgh')) // 3 + 5 = 8 == head
      act(() => em.live().send('ok'))
      expect(sockets[1]!.input()).toEqual([{ ref: 1, text: 'ok' }])
      void client
    })

    it('mutes a second mirror tab replaying the full ring', () => {
      // The second tab attaches with lastSeq 0 and receives the whole ring
      // as backlog — the fourth reproduction of the bug, same gate.
      const { sock, em } = mountTerminal((e) => (
        <Terminal sessionId="s1" createEmulator={e.create} />
      ))
      act(() => sock.emitControl(attached({ ref: 2, id: 's1', seq: 0, head: 5, primary: false })))
      act(() => sock.emitOutput(2, 'ring!'))
      act(() => em.live().send('live'))

      expect(sock.input()).toEqual([{ ref: 2, text: 'live' }])
    })
  })
```

- [ ] **Step 2: Run them to see them fail**

Run: `cd web && pnpm test -- src/components/terminal.test.tsx`
Expected: FAIL — `'mutes emulator replies while the backlog replays'` sees the DA reply in `sock.input()` (nothing mutes yet).

- [ ] **Step 3: Implement the gate**

In `web/src/components/terminal.tsx`, in the effect's local state block (next to `let dims`):

```ts
    // The replay mute gate, per-attach state: every `attached` re-arms it.
    // consumed counts this ref's output bytes from seq; input is muted while
    // consumed < muteUntil, so emulator-generated answers to replayed probe
    // sequences (DA, DECRQM, OSC 11) never reach the shell's stdin.
    // head === seq on a fresh spawn opens the gate immediately.
    let consumed = 0
    let muteUntil = 0
```

The `emulator.onData` registration becomes:

```ts
    emulator.onData((bytes) => {
      // No ref, no destination — and no input while the backlog replays.
      if (ref === null || consumed < muteUntil) return
      client.sendInput(ref, bytes)
    })
```

In the `onAttached` handler, after `dims = { cols: a.cols, rows: a.rows }`:

```ts
        consumed = a.seq
        muteUntil = a.head
```

The `onOutput` handler becomes:

```ts
      client.onOutput((r, bytes) => {
        if (r !== ref) return
        consumed += bytes.length
        emulator.write(bytes)
      }),
```

- [ ] **Step 4: Run the suite**

Run: `cd web && pnpm test`
Expected: PASS — full suite. (The pre-existing input tests pass because the `attached()` helper's `head` defaults to `seq`.)

- [ ] **Step 5: Commit**

```bash
git add web/src/components/terminal.tsx web/src/components/terminal.test.tsx
git commit -m "$(cat <<'EOF'
fix(web): mute the emulator's probe replies until the backlog is consumed

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 12: docs made true — `?cwd=` honored, usage() corrected, Sec-Fetch-Site named

**Files:**
- Modify: `web/src/lib/url.ts`, `web/src/lib/url.test.ts`
- Modify: `web/src/routes/sessions.tsx`, `web/src/routes/sessions.test.tsx`
- Modify: `cmd/flue/main.go` (`usageText` from Task 4)
- Modify: `docs/superpowers/specs/2026-07-28-flue-design.md` (the adapter table row at line 337)
- Modify: `README.md` (the status line at lines 10–11)

**Interfaces:**
- Consumes: `client.spawn(opts): number | null` with `cwd` (Task 7); the sessions screen's `spawns` set and `settle` (Task 8).
- Produces: `export function takeCwd(): string | null` in `web/src/lib/url.ts` — reads `cwd` from `location.href`, strips it with `history.replaceState`, returns it; null when absent. Consumed only by the sessions route.

- [ ] **Step 1: Write the failing test for takeCwd**

Append to `web/src/lib/url.test.ts`:

```ts
describe('takeCwd', () => {
  afterEach(() => history.replaceState(null, '', '/'))

  it('returns the cwd and strips it from the URL', () => {
    history.replaceState(null, '', '/?cwd=%2FUsers%2Fkarn%2Fcode%2Fflue&other=1')

    expect(takeCwd()).toBe('/Users/karn/code/flue')
    expect(location.search).toBe('?other=1')
  })

  it('returns null when there is nothing to take', () => {
    history.replaceState(null, '', '/')
    expect(takeCwd()).toBeNull()
  })

  it('takes it exactly once', () => {
    history.replaceState(null, '', '/?cwd=%2Ftmp')
    expect(takeCwd()).toBe('/tmp')
    expect(takeCwd()).toBeNull()
  })
})
```

(Add `takeCwd` to the existing import from `./url`, and `describe`/`afterEach` to the vitest import if missing.)

Run: `cd web && pnpm test -- src/lib/url.test.ts`
Expected: FAIL — `takeCwd` is not exported.

- [ ] **Step 2: Implement takeCwd**

Append to `web/src/lib/url.ts`:

```ts
/**
 * Take the one-shot `cwd` that `flue open <path>` put in the URL.
 *
 * Read once and stripped immediately with replaceState, for the same reason
 * a spawn never lives in a mount effect: anything that re-reads the URL — a
 * StrictMode remount, a reload, a bookmark — must not start a second shell.
 * Consuming the parameter is what makes the spawn once-only.
 */
export function takeCwd(): string | null {
  const u = new URL(location.href)
  const cwd = u.searchParams.get('cwd')
  if (cwd === null) return null
  u.searchParams.delete('cwd')
  const query = u.searchParams.toString()
  history.replaceState(null, '', `${u.origin}${u.pathname}${query ? `?${query}` : ''}${u.hash}`)
  return cwd
}
```

Run: `cd web && pnpm test -- src/lib/url.test.ts` — expected: PASS.

- [ ] **Step 3: Write the failing sessions-route tests**

Append to `web/src/routes/sessions.test.tsx` (jsdom's `location`/`history` are real; the router's memory history is independent of them):

```ts
  describe('the cwd flue open hands over', () => {
    afterEach(() => history.replaceState(null, '', '/'))

    it('spawns a session in that directory and navigates to it', async () => {
      history.replaceState(null, '', '/?cwd=%2FUsers%2Fkarn%2Fproj')
      const { sock, router } = await mountSessions()

      expect(sock.ofType('spawn')).toEqual([
        { type: 'spawn', cwd: '/Users/karn/proj', cols: 80, rows: 24, reqId: 1 },
      ])
      expect(location.search).toBe('') // consumed, so a reload spawns nothing

      act(() => sock.emitControl(attached({ ref: 1, id: 'fresh', reqId: 1 })))
      await waitFor(() => expect(router.state.location.pathname).toBe('/d/local/s/fresh'))
    })

    it('holds the spawn until the socket opens', async () => {
      history.replaceState(null, '', '/?cwd=%2Ftmp')
      const { sock } = await mountSessions({ open: false })
      expect(sock.ofType('spawn')).toEqual([])

      act(() => sock.open())

      expect(sock.ofType('spawn')).toEqual([
        { type: 'spawn', cwd: '/tmp', cols: 80, rows: 24, reqId: 1 },
      ])
    })

    it('spawns nothing when no cwd was handed over', async () => {
      const { sock } = await mountSessions()
      expect(sock.ofType('spawn')).toEqual([])
    })
  })
```

Run: `cd web && pnpm test -- src/routes/sessions.test.tsx`
Expected: FAIL — no spawn is sent (nothing reads the parameter yet).

- [ ] **Step 4: Wire the cwd into the sessions screen**

In `web/src/routes/sessions.tsx`:

Add the import: `import { takeCwd } from '@/lib/url'`.

Inside `SessionsRoute`, next to the `spawns` ref (Task 8):

```ts
  /**
   * The directory flue open asked for, taken from the URL exactly once —
   * `undefined` before the first render has looked. Held until the socket
   * can carry the spawn: a cold load from flue open mounts this screen
   * while the client is still connecting.
   */
  const pendingCwd = useRef<string | null | undefined>(undefined)
  if (pendingCwd.current === undefined) pendingCwd.current = takeCwd()
```

Add a helper above the effect:

```ts
  const spawnPendingCwd = useCallback(() => {
    const cwd = pendingCwd.current
    if (typeof cwd !== 'string') return
    const reqId = client.spawn({ cwd, cols: 80, rows: 24 })
    if (reqId === null) return // still down; the next open retries
    pendingCwd.current = null
    spawns.current.add(reqId)
    setStarting(true)
  }, [client])
```

In the effect (Task 8's version): call `spawnPendingCwd()` immediately after `client.list()`, add `if (s === 'open') spawnPendingCwd()` as the last line of the `onStatus` listener, and add `spawnPendingCwd` to the effect's dependency array.

Run: `cd web && pnpm test` — expected: PASS, full suite.

- [ ] **Step 5: Correct usage() and commit the web+CLI half**

In `cmd/flue/main.go`, the `usageText` open line becomes:

```
  flue open [path]        spawn a session in path and open it in the browser
```

Run: `go test ./cmd/flue/ -run TestUsage -v` — expected: PASS.

```bash
git add web/src/lib/url.ts web/src/lib/url.test.ts web/src/routes/sessions.tsx web/src/routes/sessions.test.tsx cmd/flue/main.go
git commit -m "$(cat <<'EOF'
feat(web): spawn the session flue open asked for in its directory

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 6: Make the specs and README true, and commit the docs half**

- `docs/superpowers/specs/2026-07-28-flue-design.md`, adapter table line 337: change the `local` row's authentication cell from `token file + Origin + Host` to `token file + Origin + Host + Sec-Fetch-Site (the load-bearing check against a co-resident loopback origin)`.
- `README.md` lines 10–11: replace the status note with:

```markdown
> Status: local terminal works and `flue enable` installs the login service.
> Remote transports and pairing are next.
```

```bash
git add docs/superpowers/specs/2026-07-28-flue-design.md README.md
git commit -m "$(cat <<'EOF'
docs: name Sec-Fetch-Site as the load-bearing local check

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 13: daemon — the minimal audit log

**Files:**
- Modify: `internal/daemon/server.go` (`Server` struct at lines 85–112, `New` at lines 114–131, `withAuth` at lines 257–266, `handleMint` at lines 329–362, `handleWS` at lines 364–409)
- Modify: `internal/daemon/conn.go` (`conn` struct at lines 125–141, `newConn` at lines 143–152, `attachTo`, `detach`)
- Test: `internal/daemon/server_test.go`

**Interfaces:**
- Consumes: `log/slog` (stdlib); `conn`/`attachTo`/`detach` as left by Tasks 6 and 10.
- Produces:
  - `func (s *Server) SetLogger(l *slog.Logger)` — mirrors `SetAuth`; production default is a text handler on `os.Stderr` (launchd/systemd capture stderr, so no plumbing in cmd/flue is needed).
  - `func newConn(ctx context.Context, cancel context.CancelFunc, ws *websocket.Conn, srv *Server, peer string) *conn` — fifth parameter, the resolved peer (`r.RemoteAddr` for the local transport).
  - Log lines: `attach` and `detach` at Info with `peer`, `session`, `ref`; `auth rejected` at Warn with `peer`, `path` (plus `status` on the middleware path, `err` on the ws path); `mint rejected` at Warn with `peer`, `err`.

- [ ] **Step 1: Write the failing tests**

Append to `internal/daemon/server_test.go`:

```go
// --- the audit log ---

// syncBuffer is a bytes.Buffer safe for the conn goroutines that log from
// off the test's own goroutine.
type syncBuffer struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (s *syncBuffer) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.Write(p)
}

func (s *syncBuffer) String() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.String()
}

func auditServer(t *testing.T) (*httptest.Server, *session.Registry, *syncBuffer) {
	t.Helper()
	ts, reg, srv := newTestServerUI(t, http.NotFoundHandler())
	buf := &syncBuffer{}
	srv.SetLogger(slog.New(slog.NewTextHandler(buf, nil)))
	return ts, reg, buf
}

func waitForLog(t *testing.T, buf *syncBuffer, want string) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if strings.Contains(buf.String(), want) {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("log never contained %q; log so far:\n%s", want, buf.String())
}

// TestAuditLogsARejectedRequest covers the middleware path — the auth
// decision local.Auth.Middleware makes for every API and UI request.
func TestAuditLogsARejectedRequest(t *testing.T) {
	ts, _, buf := auditServer(t)

	resp, err := http.Get(ts.URL + "/api/sessions")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	resp.Body.Close()

	waitForLog(t, buf, "auth rejected")
	waitForLog(t, buf, "path=/api/sessions")
	if !strings.Contains(buf.String(), "peer=") {
		t.Fatalf("rejection logged without the resolved peer:\n%s", buf.String())
	}
}

func TestAuditLogsARejectedUpgrade(t *testing.T) {
	ts, _, buf := auditServer(t)

	url := "ws" + strings.TrimPrefix(ts.URL, "http") + "/ws"
	if c, _, err := websocket.Dial(context.Background(), url, nil); err == nil {
		c.Close(websocket.StatusNormalClosure, "")
		t.Fatal("dial without a token succeeded")
	}

	waitForLog(t, buf, "auth rejected")
	waitForLog(t, buf, "path=/ws")
}

func TestAuditLogsARejectedMint(t *testing.T) {
	ts, _, buf := auditServer(t)

	resp, err := http.DefaultClient.Do(mintReq(t, ts, "not-the-token"))
	if err != nil {
		t.Fatalf("mint: %v", err)
	}
	resp.Body.Close()

	waitForLog(t, buf, "mint rejected")
}

func TestAuditLogsAttachAndDetach(t *testing.T) {
	ts, reg, buf := auditServer(t)
	s, err := reg.Spawn(session.SpawnOpts{Cmd: []string{"sleep", "5"}, Cols: 80, Rows: 24})
	if err != nil {
		t.Fatalf("Spawn: %v", err)
	}
	defer s.Close()

	c, ref := attach(t, ts, s.ID())
	waitForLog(t, buf, "msg=attach")
	waitForLog(t, buf, "session="+s.ID())

	writeControl(t, c, wire.Detach{Ref: ref})
	waitForLog(t, buf, "msg=detach")
}

// TestAuditDoesNotLogAnAcceptedRequest: the audit log names decisions, not
// traffic — an accepted request is not an event.
func TestAuditDoesNotLogAnAcceptedRequest(t *testing.T) {
	ts, _, buf := auditServer(t)

	resp := get(t, ts, "/api/sessions", "same-origin")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}
	if strings.Contains(buf.String(), "auth rejected") {
		t.Fatalf("an accepted request was logged as a rejection:\n%s", buf.String())
	}
}
```

(Add `"log/slog"` to server_test.go's imports.)

- [ ] **Step 2: Run them to see them fail**

Run: `go test ./internal/daemon/ -run 'TestAudit' -v`
Expected: FAIL to build — `srv.SetLogger undefined`.

- [ ] **Step 3: Implement the logging**

In `internal/daemon/server.go`:

Add `"log/slog"` to the imports. Add to the `Server` struct (next to `authMu`):

```go
	logMu sync.RWMutex
	log   *slog.Logger
```

In `New`, add to the returned literal:

```go
		log: slog.New(slog.NewTextHandler(os.Stderr, nil)),
```

Add next to `SetAuth`:

```go
// SetLogger swaps the audit logger. The default writes to stderr, which
// launchd and systemd already capture; tests substitute a buffer.
func (s *Server) SetLogger(l *slog.Logger) {
	s.logMu.Lock()
	defer s.logMu.Unlock()
	s.log = l
}

func (s *Server) logger() *slog.Logger {
	s.logMu.RLock()
	defer s.logMu.RUnlock()
	return s.log
}
```

Wrap the middleware path — `withAuth` becomes:

```go
func (s *Server) withAuth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		a := s.currentAuth()
		if a == nil {
			http.Error(w, ErrNoAuth.Error(), http.StatusServiceUnavailable)
			return
		}
		// The middleware answers 401/403 itself, so the audit hook watches
		// the status it wrote rather than re-deciding anything. The peer is
		// the resolved identity the local transport has: the socket address.
		rec := &statusRecorder{ResponseWriter: w}
		a.Middleware(next).ServeHTTP(rec, r)
		if rec.status == http.StatusUnauthorized || rec.status == http.StatusForbidden {
			s.logger().Warn("auth rejected", "peer", r.RemoteAddr, "path", r.URL.Path, "status", rec.status)
		}
	})
}

// statusRecorder captures the status code a handler wrote. The withAuth
// routes are plain HTTP (the upgrade lives on /ws, outside it), so no
// Hijacker passthrough is needed.
type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (r *statusRecorder) WriteHeader(code int) {
	r.status = code
	r.ResponseWriter.WriteHeader(code)
}
```

In `handleWS`, the auth failure branch becomes:

```go
	if err := s.checkAuth(r); err != nil {
		s.logger().Warn("auth rejected", "peer", r.RemoteAddr, "path", r.URL.Path, "err", err)
		writeAuthError(w, err)
		return
	}
```

In `handleMint`, the `CheckMint` failure branch becomes:

```go
	if err := a.CheckMint(r); err != nil {
		s.logger().Warn("mint rejected", "peer", r.RemoteAddr, "err", err)
		writeAuthError(w, err)
		return
	}
```

And pass the peer into the conn — the `newConn` call in `handleWS` becomes:

```go
	c := newConn(ctx, cancel, ws, s, r.RemoteAddr)
```

In `internal/daemon/conn.go`: add `peer string` to the `conn` struct (after `srv *Server`); `newConn` gains the parameter and sets it:

```go
func newConn(ctx context.Context, cancel context.CancelFunc, ws *websocket.Conn, srv *Server, peer string) *conn {
	return &conn{
		ctx:    ctx,
		cancel: cancel,
		ws:     ws,
		srv:    srv,
		peer:   peer,
		out:    make(chan frame, outboxDepth),
		attach: map[uint32]*attachment{},
	}
}
```

In `attachTo`, after the `c.mu.Unlock()` that publishes the attachment:

```go
	c.srv.logger().Info("attach", "peer", c.peer, "session", s.ID(), "ref", ref)
```

In `detach`, after the `if a == nil { return }` guard:

```go
	c.srv.logger().Info("detach", "peer", c.peer, "session", a.s.ID(), "ref", ref)
```

- [ ] **Step 4: Run the daemon suite**

Run: `go test ./internal/daemon/ -v`
Expected: PASS — the audit tests and every pre-existing test (connection teardown routes through `detach`, so a dropped tab logs its detaches too, which is the intent).

- [ ] **Step 5: Commit**

```bash
git add internal/daemon/server.go internal/daemon/conn.go internal/daemon/server_test.go
git commit -m "$(cat <<'EOF'
feat(daemon): log every attach, detach, and auth rejection with the peer

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 14: frontend polish — the visual pass (LAST; driven by the design skill at implementation time)

**Files:**
- Modify (visual only — no new features, no behavior changes): `web/src/components/session-table.tsx`, `web/src/components/app-shell.tsx`, `web/src/components/nav.tsx`, `web/src/routes/sessions.tsx` (empty state copy/layout only), `web/src/components/terminal.tsx` (the status pill and chrome only), `web/src/styles.css`, `web/public/` and `web/scripts/generate-icons.mjs` (favicon/app icons, OG image)
- Test: the existing suites — `web/src/components/session-table.test.tsx`, `web/src/styles.build.test.ts`, and the rest of `pnpm test` — must stay green throughout.

**Interfaces:**
- Consumes: everything shipped by Tasks 1–13; the running app.
- Produces: no interface changes of any kind. The bar, from spec §3: nothing looks like a default component; everything looks like one product. In scope: the sessions table, empty states, the terminal chrome, favicon/app icons, and an OG image.

> This task is **driven by the design skill at implementation time**: the concrete visual decisions (spacing, weight, color moves within the existing zinc/amber token system) are made by invoking the `design` skill against the live app, not prescribed here. The steps below are the harness around that work.

- [ ] **Step 1: Build and run the real app**

```bash
make build
./bin/flue serve
```

Then open the UI via `./bin/flue open` from a second terminal. Create a few sessions (one running, one exited) so the table, the empty state, and the terminal chrome are all reachable.

- [ ] **Step 2: Invoke the design skill and take the before screenshots**

Invoke the `design` skill. Screenshot the three surfaces as they are: the sessions screen with rows, the sessions screen empty, and a terminal with its status pill showing. These are the baseline the after-shots are judged against.

- [ ] **Step 3: Apply the pass, surface by surface**

Under the design skill's guidance, restyle — in this order, committing nothing yet:
1. The sessions table (`session-table.tsx`): row density, state presentation, `tabular-nums` on time-varying values, hover/affordance on Open.
2. Empty states (`sessions.tsx` copy block, `app-shell.tsx`): the "No sessions yet" moment must read as designed, not as an unstyled fallback.
3. Terminal chrome (`terminal.tsx`): the status pill and the connecting/exited/gone treatments.
4. Favicon/app icons and an OG image: extend `web/scripts/generate-icons.mjs` and `web/index.html`'s meta tags; run `cd web && pnpm icons`.

Constraints carried from the repo's design system: zinc neutrals, amber accent only for active nav/focus/one primary button per screen, both themes via `prefers-color-scheme`, Heroicons micro at `size-4`, no emojis in UI copy. Remember the Tailwind scanner hazard: no prose in new comments that parses as a class candidate; `KNOWN_DEAD` in `styles.build.test.ts` is shrink-only.

- [ ] **Step 4: Screenshot-verify against the baseline**

Re-screenshot the same three surfaces in both light and dark. Compare against Step 2: every change intentional, nothing regressed, both themes coherent.

- [ ] **Step 5: Run the web tests, then everything**

Run: `cd web && pnpm test`
Expected: PASS — in particular `styles.build.test.ts` (no new dead rules) and `session-table.test.tsx` (no behavior drifted).

Run: `make lint test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add web/src web/public web/scripts web/index.html
git commit -m "$(cat <<'EOF'
style(web): the visual pass — sessions table, empty states, terminal chrome, icons

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```
