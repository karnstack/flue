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
