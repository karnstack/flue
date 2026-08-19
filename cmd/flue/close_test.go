package main

import (
	"bytes"
	"errors"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/karnstack/flue/internal/config"
	"github.com/karnstack/flue/internal/daemon"
	"github.com/karnstack/flue/internal/session"
	"github.com/karnstack/flue/internal/transport/local"
)

// newCloseTestDaemon is newTestDaemon with the registry exposed, because these
// tests need to spawn the sessions the command is asked to close and to see
// afterwards whether they went. It also writes the runtime record, which is
// how runClose finds the daemon at all.
func newCloseTestDaemon(t *testing.T) *session.Registry {
	t.Helper()
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())

	token, err := config.LoadOrCreateToken()
	if err != nil {
		t.Fatalf("LoadOrCreateToken: %v", err)
	}
	reg := session.NewRegistry(time.Now)
	srv := daemon.New(reg, local.NewAuth(token, 0), uiHandler(), version, daemon.Identity{})
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)
	t.Cleanup(srv.Shutdown)

	u, err := url.Parse(ts.URL)
	if err != nil {
		t.Fatalf("parse test server URL %q: %v", ts.URL, err)
	}
	port, err := strconv.Atoi(u.Port())
	if err != nil {
		t.Fatalf("parse port from %q: %v", ts.URL, err)
	}
	srv.SetAuth(local.NewAuth(token, port))
	if err := daemon.WriteRuntime(port); err != nil {
		t.Fatalf("WriteRuntime: %v", err)
	}
	return reg
}

func spawnSleeper(t *testing.T, reg *session.Registry) session.Handle {
	t.Helper()
	h, err := reg.Spawn(session.SpawnOpts{Cmd: []string{"sleep", "5"}, Cols: 80, Rows: 24})
	if err != nil {
		t.Fatalf("Spawn: %v", err)
	}
	t.Cleanup(func() { _ = h.Close() })
	return h
}

func TestRunCloseAllClosesEverySession(t *testing.T) {
	reg := newCloseTestDaemon(t)
	spawnSleeper(t, reg)
	spawnSleeper(t, reg)

	var out, errOut bytes.Buffer
	if err := runClose(&out, &errOut, []string{"--all"}); err != nil {
		t.Fatalf("runClose: %v", err)
	}
	if !strings.Contains(out.String(), "✓ closed 2 sessions") {
		t.Errorf("output %q does not report the two closed sessions", out.String())
	}
	if left := reg.List(); len(left) != 0 {
		t.Errorf("the registry still holds %d sessions", len(left))
	}
}

// TestRunCloseByIDClosesOnlyTheNamedOne also pins the singular: one session
// closed is "1 session", not "1 sessions".
func TestRunCloseByIDClosesOnlyTheNamedOne(t *testing.T) {
	reg := newCloseTestDaemon(t)
	going := spawnSleeper(t, reg)
	staying := spawnSleeper(t, reg)

	var out, errOut bytes.Buffer
	if err := runClose(&out, &errOut, []string{going.ID()}); err != nil {
		t.Fatalf("runClose: %v", err)
	}
	if !strings.Contains(out.String(), "✓ closed 1 session\n") {
		t.Errorf("output %q, want the singular closed line", out.String())
	}
	if _, ok := reg.Get(going.ID()); ok {
		t.Error("the named session is still in the registry")
	}
	if _, ok := reg.Get(staying.ID()); !ok {
		t.Error("the unnamed session went with it")
	}
}

// TestRunCloseReportsUnknownIDs: each id that named nothing is reported on
// stderr by name, the ones that exist are closed anyway, and the command
// fails — that is the errUnknownSessions cmdClose turns into exit 1.
func TestRunCloseReportsUnknownIDs(t *testing.T) {
	reg := newCloseTestDaemon(t)
	real := spawnSleeper(t, reg)

	var out, errOut bytes.Buffer
	err := runClose(&out, &errOut, []string{real.ID(), "feedfeed00000000"})
	if !errors.Is(err, errUnknownSessions) {
		t.Fatalf("runClose = %v, want errUnknownSessions", err)
	}
	if !strings.Contains(errOut.String(), "no such session: feedfeed00000000") {
		t.Errorf("stderr %q does not name the unknown id", errOut.String())
	}
	if !strings.Contains(out.String(), "✓ closed 1 session\n") {
		t.Errorf("output %q, want the real session still closed and counted", out.String())
	}
	if _, ok := reg.Get(real.ID()); ok {
		t.Error("the real session is still in the registry")
	}
}

// TestRunCloseWithNoArgumentsIsAUsageError: bare `flue close` could mean
// either form, so it gets the usage line naming both — errCloseUsage, which
// cmdClose turns into exit 2 — and never talks to the daemon at all.
func TestRunCloseWithNoArgumentsIsAUsageError(t *testing.T) {
	var out, errOut bytes.Buffer
	err := runClose(&out, &errOut, nil)
	if !errors.Is(err, errCloseUsage) {
		t.Fatalf("runClose = %v, want errCloseUsage", err)
	}
	for _, form := range []string{"--all", "<id>"} {
		if !strings.Contains(err.Error(), form) {
			t.Errorf("usage error %q does not show the %s form", err, form)
		}
	}
}

func TestRunCloseSaysDaemonNotRunning(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir()) // no runtime record, no daemon

	var out, errOut bytes.Buffer
	if err := runClose(&out, &errOut, []string{"--all"}); err != nil {
		t.Fatalf("runClose = %v, want nil: nothing to close is not a failure", err)
	}
	if !strings.Contains(out.String(), "daemon not running; nothing to close") {
		t.Errorf("output %q, want the not-running notice", out.String())
	}
}

func TestUsageMentionsClose(t *testing.T) {
	if !strings.Contains(usageText, "flue close") {
		t.Fatalf("usage text does not mention %q:\n%s", "flue close", usageText)
	}
}
