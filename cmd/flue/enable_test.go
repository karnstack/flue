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
	warns        []string // what Warnings reports after Enable
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
func (f *fakeManager) Warnings() []string { return f.warns }

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

// TestRunEnableRelaysEnableWarnings: a manager that succeeded with a caveat
// (systemd with enable-linger refused) gets its warning onto the transcript,
// under the installed checkmark, without failing the run.
func TestRunEnableRelaysEnableWarnings(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	token, err := config.LoadOrCreateToken()
	if err != nil {
		t.Fatalf("LoadOrCreateToken: %v", err)
	}
	port := newTestDaemon(t, token)
	if err := daemon.WriteRuntime(port); err != nil {
		t.Fatalf("WriteRuntime: %v", err)
	}

	const warn = `loginctl enable-linger failed — run "loginctl enable-linger" yourself`
	m := &fakeManager{warns: []string{warn}}
	swapManager(t, m)
	restore := swapBrowser(t, func(string) error { return nil })
	defer restore()

	var out bytes.Buffer
	if err := runEnable(&out, 2*time.Second); err != nil {
		t.Fatalf("runEnable with a warning must still succeed: %v", err)
	}
	if !strings.Contains(out.String(), "✓ login service installed") {
		t.Fatalf("transcript missing the installed checkmark:\n%s", out.String())
	}
	if !strings.Contains(out.String(), "! "+warn) {
		t.Fatalf("transcript missing the warning line:\n%s", out.String())
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
