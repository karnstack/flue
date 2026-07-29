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
