package service

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// fakeRunner records every command and answers from a script keyed by the
// command's verb — launchctl's first argument. CI never talks to launchd.
type fakeRunner struct {
	calls    [][]string
	fail     map[string]error   // verb -> error, every call
	failOnce map[string]error   // verb -> error, consumed by the first call
	seq      map[string][]error // verb -> errors consumed call by call, then fall through
	out      map[string]string  // verb -> combined output
}

func (f *fakeRunner) Run(name string, args ...string) ([]byte, error) {
	f.calls = append(f.calls, append([]string{name}, args...))
	v := verbOf(name, args)
	if q := f.seq[v]; len(q) > 0 {
		f.seq[v] = q[1:]
		return []byte(f.out[v]), q[0]
	}
	if err, ok := f.failOnce[v]; ok {
		delete(f.failOnce, v)
		return []byte(f.out[v]), err
	}
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
	l := NewLaunchd("/usr/local/bin/flue", home, 501, r)
	// awaitBootout polls in real time; tests script the poll answers and
	// must never actually sleep between them.
	l.sleep = func(time.Duration) {}
	return l, filepath.Join(home, "Library", "LaunchAgents", "sh.flue.daemon.plist")
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
	// Re-running enable when already enabled with an unchanged binary is not
	// an error and never restarts a healthy daemon: bootstrap refuses a
	// loaded label, the plist on disk is byte-identical to what Enable just
	// rewrote, so enable falls through to print (is it loaded?) and
	// kickstart (start it if it is dead) — not bootout, which would kill a
	// healthy daemon and its sessions for nothing. Contrast
	// TestLaunchdEnableConvergesAChangedExe, where bootout is the point.
	r := &fakeRunner{}
	l, _ := newLaunchdUnderTest(t, r)
	if err := l.Enable(); err != nil {
		t.Fatalf("first Enable: %v", err)
	}

	r.calls = nil
	r.fail = map[string]error{"bootstrap": errFake("Bootstrap failed: 5: Input/output error")}
	if err := l.Enable(); err != nil {
		t.Fatalf("Enable on an already-enabled service: %v", err)
	}
	if vs := r.verbs(); strings.Join(vs, ",") != "bootstrap,print,kickstart" {
		t.Fatalf("verbs = %v, want [bootstrap print kickstart]", vs)
	}
}

func TestLaunchdEnableConvergesAChangedExe(t *testing.T) {
	// The brew-upgrade shape: the loaded job and the plist on disk point at
	// an old binary path. Rewriting the file alone changes nothing — launchd
	// reads a plist only at bootstrap — so Enable must bootout the stale job
	// and bootstrap the fresh plist. The restart is deliberate: the old job
	// would exec a deleted Caskroom path at the next login.
	r := &fakeRunner{}
	home := t.TempDir()
	if err := NewLaunchd("/opt/homebrew/Caskroom/flue/0.0.9/flue", home, 501, r).Enable(); err != nil {
		t.Fatalf("Enable with the old exe: %v", err)
	}

	r.calls = nil
	// The label is loaded, so the first bootstrap refuses; after bootout the
	// domain is clear and the second bootstrap succeeds — failOnce, exactly
	// like the real launchctl. The print script is the loaded check answering
	// "loaded", then the bootout-drain poll answering "gone".
	r.failOnce = map[string]error{"bootstrap": errFake("Bootstrap failed: 5: Input/output error")}
	r.seq = map[string][]error{"print": {nil, errFake("could not find service")}}
	if err := NewLaunchd("/opt/homebrew/bin/flue", home, 501, r).Enable(); err != nil {
		t.Fatalf("Enable with the new exe: %v", err)
	}
	if vs := r.verbs(); strings.Join(vs, ",") != "bootstrap,print,bootout,print,bootstrap" {
		t.Fatalf("verbs = %v, want [bootstrap print bootout print bootstrap]", vs)
	}
	got, err := os.ReadFile(filepath.Join(home, "Library", "LaunchAgents", "sh.flue.daemon.plist"))
	if err != nil {
		t.Fatalf("read plist: %v", err)
	}
	if string(got) != string(LaunchdPlist("/opt/homebrew/bin/flue")) {
		t.Fatalf("plist on disk still carries the old exe:\n%s", got)
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

// TestLaunchdRestartBootsOutAndBootstraps pins the graceful spelling: bootout
// (SIGTERM, the signal the daemon snapshots sessions on) and then bootstrap of
// the plist on disk — never kickstart -k, which kills.
func TestLaunchdRestartBootsOutAndBootstraps(t *testing.T) {
	r := &fakeRunner{}
	l, plist := newLaunchdUnderTest(t, r)
	if err := l.Enable(); err != nil {
		t.Fatalf("Enable: %v", err)
	}
	r.calls = nil
	// The drain poll finds the label already gone on its first look.
	r.fail = map[string]error{"print": errFake("could not find service")}

	if err := l.Restart(); err != nil {
		t.Fatalf("Restart: %v", err)
	}
	if vs := strings.Join(r.verbs(), ","); vs != "bootout,print,bootstrap" {
		t.Fatalf("verbs = %v, want [bootout print bootstrap]", r.verbs())
	}
	want := []string{"launchctl", "bootstrap", "gui/501", plist}
	if got := r.calls[len(r.calls)-1]; strings.Join(got, " ") != strings.Join(want, " ") {
		t.Fatalf("bootstrap call = %v, want %v", got, want)
	}
}

// TestLaunchdRestartToleratesAnUnloadedLabel: a service that is installed but
// not loaded has nothing to boot out, and that is not a failure to stop it —
// the bootstrap is what a restart is for.
func TestLaunchdRestartToleratesAnUnloadedLabel(t *testing.T) {
	r := &fakeRunner{fail: map[string]error{
		"bootout": errFake("Boot-out failed: 5: Input/output error"),
		// Nothing loaded, so the drain poll's print refuses too.
		"print": errFake("could not find service"),
	}}
	l, _ := newLaunchdUnderTest(t, r)
	if err := l.Enable(); err != nil {
		t.Fatalf("Enable: %v", err)
	}

	if err := l.Restart(); err != nil {
		t.Fatalf("Restart with nothing loaded: %v", err)
	}
}

// TestLaunchdEnableWaitsOutADrainingBootout is the `flue disable && flue
// enable` shape that used to fail with "Bootstrap failed: 5: Input/output
// error": disable's bootout only *starts* the teardown, and the label is
// still registered — draining — when enable's bootstrap arrives. Enable must
// wait for the label to leave the domain before bootstrapping again, polling
// print until it refuses.
func TestLaunchdEnableWaitsOutADrainingBootout(t *testing.T) {
	r := &fakeRunner{
		// The first bootstrap refuses because the draining label still owns
		// the name; the one after the drain succeeds.
		failOnce: map[string]error{"bootstrap": errFake("Bootstrap failed: 5: Input/output error")},
		// print: the loaded check sees the label, two drain polls still see
		// it, the third finds it gone.
		seq: map[string][]error{"print": {nil, nil, nil, errFake("could not find service")}},
	}
	l, _ := newLaunchdUnderTest(t, r)
	var slept int
	l.sleep = func(time.Duration) { slept++ }

	if err := l.Enable(); err != nil {
		t.Fatalf("Enable against a draining bootout: %v", err)
	}
	want := "bootstrap,print,bootout,print,print,print,bootstrap"
	if vs := strings.Join(r.verbs(), ","); vs != want {
		t.Fatalf("verbs = %v, want [%s]", r.verbs(), want)
	}
	if slept != 2 {
		t.Fatalf("slept %d times, want 2 — once after each poll that still saw the label", slept)
	}
}

// TestLaunchdRestartWaitsOutADrainingBootout: Restart's own bootout is just
// as asynchronous, and the graceful exit it triggers — the one that saves
// session snapshots — is exactly the slow kind.
func TestLaunchdRestartWaitsOutADrainingBootout(t *testing.T) {
	r := &fakeRunner{seq: map[string][]error{"print": {nil, nil, errFake("could not find service")}}}
	l, _ := newLaunchdUnderTest(t, r)
	if err := l.Enable(); err != nil {
		t.Fatalf("Enable: %v", err)
	}
	r.calls = nil

	if err := l.Restart(); err != nil {
		t.Fatalf("Restart: %v", err)
	}
	if vs := strings.Join(r.verbs(), ","); vs != "bootout,print,print,print,bootstrap" {
		t.Fatalf("verbs = %v, want [bootout print print print bootstrap]", r.verbs())
	}
}

// TestLaunchdRestartGivesUpWaitingEventually: a label that never drains must
// not hang the CLI forever. The wait is bounded; after it, the bootstrap is
// attempted anyway and its own answer is the verdict.
func TestLaunchdRestartGivesUpWaitingEventually(t *testing.T) {
	r := &fakeRunner{} // print always succeeds: the label never leaves
	l, _ := newLaunchdUnderTest(t, r)
	if err := l.Enable(); err != nil {
		t.Fatalf("Enable: %v", err)
	}
	r.calls = nil

	if err := l.Restart(); err != nil {
		t.Fatalf("Restart after an exhausted wait: %v", err)
	}
	vs := r.verbs()
	if vs[len(vs)-1] != "bootstrap" {
		t.Fatalf("verbs end with %q, want the bootstrap still attempted", vs[len(vs)-1])
	}
	prints := 0
	for _, v := range vs {
		if v == "print" {
			prints++
		}
	}
	if want := int(bootoutWait / bootoutPoll); prints != want {
		t.Fatalf("polled print %d times, want exactly the bounded %d", prints, want)
	}
}

func TestLaunchdRestartReportsABootstrapFailure(t *testing.T) {
	r := &fakeRunner{
		fail: map[string]error{
			"bootstrap": errFake("exit status 5"),
			"print":     errFake("could not find service"),
		},
		out: map[string]string{"bootstrap": "Bootstrap failed: 5: Input/output error"},
	}
	l, _ := newLaunchdUnderTest(t, r)

	err := l.Restart()
	if err == nil {
		t.Fatal("Restart = nil when bootstrap failed, want the error")
	}
	if !strings.Contains(err.Error(), "bootstrap") {
		t.Fatalf("Restart error = %q, want it to name the failing call", err)
	}
}
