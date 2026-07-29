package main

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/karnstack/flue/internal/config"
	"github.com/karnstack/flue/internal/daemon"
	"github.com/karnstack/flue/internal/session"
	"github.com/karnstack/flue/internal/transport/local"
)

// newTestDaemon serves a real daemon.Server on loopback and returns its port.
// It is the genuine handler, not a stand-in, so every assertion about "is a
// flue daemon listening here" is checked against the response a real daemon
// actually produces — and will fail loudly if that response ever changes.
func newTestDaemon(t *testing.T, token string) int {
	t.Helper()

	srv := daemon.New(session.NewRegistry(time.Now), local.NewAuth(token, 0), uiHandler(), version)
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
	// The Host allowlist is port-specific and the port is only known now.
	srv.SetAuth(local.NewAuth(token, port))
	return port
}

// --- daemonAt ---

func TestDaemonAtRecognisesAFlueDaemon(t *testing.T) {
	port := newTestDaemon(t, "tok")
	if !daemonAt(port) {
		t.Fatal("daemonAt = false against a real flue daemon, want true")
	}
}

// TestDaemonAtRejectsAForeignListener is the reason daemonAt exists at all.
// A bare "is anything listening on this port" check is satisfied by any other
// local process that happened to take the port after a daemon died — and both
// flue open and flue status then hand that process the auth token, which is
// full shell access on this machine.
func TestDaemonAtRejectsAForeignListener(t *testing.T) {
	for name, h := range map[string]http.Handler{
		"404": http.NotFoundHandler(),
		"200": http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Write([]byte(`{"sessions":[]}`))
		}),
		"401 without flue's headers": http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			http.Error(w, "nope", http.StatusUnauthorized)
		}),
	} {
		t.Run(name, func(t *testing.T) {
			ts := httptest.NewServer(h)
			defer ts.Close()

			u, _ := url.Parse(ts.URL)
			port, _ := strconv.Atoi(u.Port())
			if daemonAt(port) {
				t.Fatalf("daemonAt = true against a non-flue server (%s), want false", name)
			}
		})
	}
}

func TestDaemonAtRejectsAClosedPort(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("Listen: %v", err)
	}
	port := ln.Addr().(*net.TCPAddr).Port
	ln.Close() // nothing is listening there now

	if daemonAt(port) {
		t.Fatal("daemonAt = true against a closed port, want false")
	}
}

// TestDaemonAtGivesUpOnASilentListener: a port that accepts connections and
// then says nothing must not wedge flue open or flue status forever.
func TestDaemonAtGivesUpOnASilentListener(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("Listen: %v", err)
	}
	defer ln.Close()

	done := make(chan struct{})
	defer close(done)
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			// Hold the connection open, answering nothing.
			go func() { <-done; c.Close() }()
		}
	}()

	port := ln.Addr().(*net.TCPAddr).Port
	start := time.Now()
	if daemonAt(port) {
		t.Fatal("daemonAt = true against a listener that never responds, want false")
	}
	if elapsed := time.Since(start); elapsed > probeTimeout+2*time.Second {
		t.Fatalf("daemonAt took %s against a silent listener, want it to give up near probeTimeout (%s)", elapsed, probeTimeout)
	}
}

// --- fetchSessions ---

func TestFetchSessionsReadsTheListing(t *testing.T) {
	port := newTestDaemon(t, "tok")

	infos, err := fetchSessions(port, "tok")
	if err != nil {
		t.Fatalf("fetchSessions: %v", err)
	}
	if len(infos) != 0 {
		t.Fatalf("fetchSessions returned %d sessions from a fresh daemon, want 0", len(infos))
	}
}

// TestFetchSessionsReportsARejectedToken: the daemon answering 401 means the
// token on disk is not the one the running daemon loaded. Decoding its plain
// text error body as JSON would turn that into an unreadable parse error, so
// it has to be recognised as its own condition.
func TestFetchSessionsReportsARejectedToken(t *testing.T) {
	port := newTestDaemon(t, "the-daemons-token")

	_, err := fetchSessions(port, "a-different-token")
	if !errors.Is(err, errTokenRejected) {
		t.Fatalf("fetchSessions error = %v, want errTokenRejected", err)
	}
}

// --- ensureDaemon ---

func TestEnsureDaemonUsesARunningDaemon(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())

	port := newTestDaemon(t, "tok")
	if err := daemon.WriteRuntime(port); err != nil {
		t.Fatalf("WriteRuntime: %v", err)
	}

	var spawns atomic.Int32
	restore := swapSpawn(t, func() error {
		spawns.Add(1)
		return nil
	})
	defer restore()

	got, err := ensureDaemon()
	if err != nil {
		t.Fatalf("ensureDaemon: %v", err)
	}
	if got != port {
		t.Fatalf("ensureDaemon = %d, want the running daemon's port %d", got, port)
	}
	if n := spawns.Load(); n != 0 {
		t.Fatalf("ensureDaemon spawned %d daemons with one already running, want 0", n)
	}
}

// TestEnsureDaemonSpawnsExactlyOnceUnderConcurrentCallers is the race the
// start lock exists for. Two "flue open"s in two terminals on a machine with
// no daemon yet must not each start one: on a fresh install each daemon would
// generate its own token, and whichever one loses the race to bind may still
// be the one whose token landed on disk — leaving every later flue open
// handing the surviving daemon a token it will reject forever.
func TestEnsureDaemonSpawnsExactlyOnceUnderConcurrentCallers(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())

	port := newTestDaemon(t, "tok")

	var spawns atomic.Int32
	restore := swapSpawn(t, func() error {
		spawns.Add(1)
		// Widen the window a real spawn leaves open between "decided to
		// start one" and "the daemon is discoverable".
		time.Sleep(200 * time.Millisecond)
		return daemon.WriteRuntime(port)
	})
	defer restore()

	const callers = 4
	var wg sync.WaitGroup
	ports := make([]int, callers)
	errs := make([]error, callers)
	for i := range callers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			ports[i], errs[i] = ensureDaemon()
		}()
	}
	wg.Wait()

	for i := range callers {
		if errs[i] != nil {
			t.Fatalf("caller %d: ensureDaemon: %v", i, errs[i])
		}
		if ports[i] != port {
			t.Fatalf("caller %d: ensureDaemon = %d, want %d", i, ports[i], port)
		}
	}
	if n := spawns.Load(); n != 1 {
		t.Fatalf("%d concurrent ensureDaemon calls spawned %d daemons, want exactly 1", callers, n)
	}
}

// TestEnsureDaemonIgnoresARecordFromADeadProcess: the record outlives the
// daemon, and the port it names is then free for anything to take. A real flue
// daemon answering there is not enough to adopt it — the record has to name a
// process that still exists.
func TestEnsureDaemonIgnoresARecordFromADeadProcess(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())

	port := newTestDaemon(t, "tok")
	writeRuntimeRecord(t, port, deadPID(t))

	var spawns atomic.Int32
	restore := swapSpawn(t, func() error {
		spawns.Add(1)
		return errors.New("spawn refused by the test")
	})
	defer restore()

	if got, err := ensureDaemon(); err == nil {
		t.Fatalf("ensureDaemon = %d, nil for a record naming a dead process; want it to start a new daemon instead of adopting that one", got)
	}
	if n := spawns.Load(); n != 1 {
		t.Fatalf("ensureDaemon made %d spawn attempts, want 1", n)
	}
}

// TestEnsureDaemonIgnoresAnotherUsersRecord is the case a "is a flue daemon
// listening there" check cannot catch on its own, because the answer is yes:
// on a shared machine the process now holding flue's default port may be
// another user's flue daemon, which looks identical from outside. Adopting it
// would hand that user this user's token, and the token is unrestricted shell
// access. PID 1 stands in for it — a live process this user cannot signal.
func TestEnsureDaemonIgnoresAnotherUsersRecord(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("running as root: every live process is signalable, so there is no foreign PID to test with")
	}
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())

	port := newTestDaemon(t, "tok")
	writeRuntimeRecord(t, port, 1) // init/launchd: alive, and not ours

	var spawns atomic.Int32
	restore := swapSpawn(t, func() error {
		spawns.Add(1)
		return errors.New("spawn refused by the test")
	})
	defer restore()

	if got, err := ensureDaemon(); err == nil {
		t.Fatalf("ensureDaemon = %d, nil for a record owned by another user; want it not to adopt that daemon", got)
	}
	if n := spawns.Load(); n != 1 {
		t.Fatalf("ensureDaemon made %d spawn attempts, want 1", n)
	}
}

func TestOwnedByUs(t *testing.T) {
	if !ownedByUs(os.Getpid()) {
		t.Error("ownedByUs(own pid) = false, want true")
	}
	if ownedByUs(0) {
		t.Error("ownedByUs(0) = true; a record that cannot say who owns it must fail closed, not fall back to a probe-only check")
	}
	if ownedByUs(-1) {
		t.Error("ownedByUs(-1) = true; kill(2) reads a negative pid as a process group, which must never be treated as ownership")
	}
	if pid := deadPID(t); ownedByUs(pid) {
		t.Errorf("ownedByUs(%d) = true for a reaped process, want false", pid)
	}
}

// TestLoadTokenLockedIsConsistentAcrossConcurrentCallers is the second half of
// the start-lock story, and the half that actually matters. Serializing the
// *spawn* is only useful if every process also ends up holding the same token:
// config.LoadOrCreateToken generates on first use and installs with a
// last-writer-wins rename, so two unserialized creations leave one caller
// holding a token that is not the one on disk. When that caller is the daemon,
// every later flue open reads the other token and gets a 401 forever.
func TestLoadTokenLockedIsConsistentAcrossConcurrentCallers(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())

	const callers = 8
	got := make([]string, callers)
	errs := make([]error, callers)
	var wg sync.WaitGroup
	for i := range callers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			got[i], errs[i] = loadTokenLocked()
		}()
	}
	wg.Wait()

	dir, err := config.Dir()
	if err != nil {
		t.Fatalf("config.Dir: %v", err)
	}
	onDisk, err := os.ReadFile(filepath.Join(dir, "token"))
	if err != nil {
		t.Fatalf("read token file: %v", err)
	}
	want := strings.TrimSpace(string(onDisk))
	if want == "" {
		t.Fatal("token file is empty after loadTokenLocked")
	}
	for i := range callers {
		if errs[i] != nil {
			t.Fatalf("caller %d: loadTokenLocked: %v", i, errs[i])
		}
		if got[i] != want {
			t.Fatalf("caller %d got token %q but the token on disk is %q; a daemon holding one and the CLI reading the other means 401 on every request", i, got[i], want)
		}
	}
}

// --- holding the runtime record ---

// TestHoldRuntimeRestoresARecordAnotherDaemonRemoved is the whole reason
// holdRuntime exists, in the order it actually happens:
//
//	daemon A serves 7717 and owns the record
//	the user runs `flue serve --port 7718` by hand, and B takes the record
//	the user stops B, whose PID-guarded ClearRuntime correctly removes it
//	A is now alive, serving, and named by nothing
//
// Without a re-assertion that state is permanent, and every later flue open
// starts a daemon that cannot bind and then refuses — until the user kills a
// daemon that was working fine.
func TestHoldRuntimeRestoresARecordAnotherDaemonRemoved(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())

	if err := daemon.WriteRuntime(7717); err != nil {
		t.Fatalf("WriteRuntime: %v", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		holdRuntime(ctx, 7717, 10*time.Millisecond)
	}()

	removeRuntimeRecord(t)
	waitFor(t, 2*time.Second, "the daemon to re-assert its own record", func() bool {
		port, pid, ok := daemon.ReadRuntimeRecord()
		return ok && port == 7717 && pid == os.Getpid()
	})

	cancel()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("holdRuntime did not return when its context was cancelled")
	}
}

func TestReassertRuntimeTakesOverARecordNamingADeadProcess(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())

	writeRuntimeRecord(t, 7718, deadPID(t))
	reassertRuntime(7717)

	port, pid, ok := daemon.ReadRuntimeRecord()
	if !ok || port != 7717 || pid != os.Getpid() {
		t.Fatalf("record = %d, %d, %v after reassert over a dead process's record; want 7717, %d, true", port, pid, ok, os.Getpid())
	}
}

// TestReassertRuntimeLeavesALiveDaemonsRecord: two daemons are allowed to be
// up at once, and only one of them can be in the record. Whichever wrote it
// last keeps it — if both re-asserted over each other every tick, flue open
// would land on a different daemon each time it looked.
func TestReassertRuntimeLeavesALiveDaemonsRecord(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())

	other := livePID(t)
	writeRuntimeRecord(t, 7718, other)
	reassertRuntime(7717)

	port, pid, ok := daemon.ReadRuntimeRecord()
	if !ok || port != 7718 || pid != other {
		t.Fatalf("record = %d, %d, %v; want the live daemon's own record 7718, %d, true left untouched", port, pid, ok, other)
	}
}

// --- cmdServe takes the token lock ---

// TestCmdServeWaitsForTheTokenLock pins the fix that the empty-token test
// cannot: both loadToken and loadTokenLocked bottom out in the same package
// variable, so swapping it says nothing about which one cmdServe called.
// Holding token.lock does: an unlocked read finishes immediately, a locked one
// cannot start until the lock is free.
func TestCmdServeWaitsForTheTokenLock(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())

	// Refuse as soon as the token is reached, so cmdServe returns without
	// binding anything once it gets past the lock.
	orig := loadToken
	loadToken = func() (string, error) { return "", nil }
	defer func() { loadToken = orig }()

	unlock, err := acquireLock("token.lock", 2*time.Second)
	if err != nil {
		t.Fatalf("acquireLock: %v", err)
	}

	done := make(chan error, 1)
	go func() { done <- cmdServe(nil) }()

	select {
	case err := <-done:
		unlock()
		t.Fatalf("cmdServe returned (%v) while token.lock was held; it must create the token under that lock, not read it unlocked", err)
	case <-time.After(300 * time.Millisecond):
	}

	unlock()
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("cmdServe = nil once the lock was released, want the empty-token refusal")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("cmdServe did not finish after token.lock was released")
	}
}

// writeRuntimeRecord writes a runtime record naming an arbitrary PID, which
// daemon.WriteRuntime deliberately will not do (it always records its own).
func writeRuntimeRecord(t *testing.T, port, pid int) {
	t.Helper()
	dir, err := config.Dir()
	if err != nil {
		t.Fatalf("config.Dir: %v", err)
	}
	rec := fmt.Sprintf(`{"port":%d,"pid":%d}`, port, pid)
	if err := os.WriteFile(filepath.Join(dir, "runtime.json"), []byte(rec), 0o600); err != nil {
		t.Fatalf("write runtime record: %v", err)
	}
}

func removeRuntimeRecord(t *testing.T) {
	t.Helper()
	dir, err := config.Dir()
	if err != nil {
		t.Fatalf("config.Dir: %v", err)
	}
	if err := os.Remove(filepath.Join(dir, "runtime.json")); err != nil {
		t.Fatalf("remove runtime record: %v", err)
	}
}

// deadPID returns the PID of a process that has exited and been reaped.
func deadPID(t *testing.T) int {
	t.Helper()
	cmd := exec.Command("true")
	if err := cmd.Run(); err != nil {
		t.Fatalf("run true: %v", err)
	}
	return cmd.Process.Pid
}

// livePID returns the PID of a live process this user owns, other than the
// test process itself.
func livePID(t *testing.T) int {
	t.Helper()
	cmd := exec.Command("sleep", "30")
	if err := cmd.Start(); err != nil {
		t.Fatalf("start sleep: %v", err)
	}
	t.Cleanup(func() {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
	})
	return cmd.Process.Pid
}

func waitFor(t *testing.T, timeout time.Duration, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("timed out after %s waiting for %s", timeout, what)
}

func swapSpawn(t *testing.T, fn func() error) (restore func()) {
	t.Helper()
	orig := spawnDaemon
	spawnDaemon = fn
	return func() { spawnDaemon = orig }
}

func swapBrowser(t *testing.T, fn func(string) error) (restore func()) {
	t.Helper()
	orig := openBrowser
	openBrowser = fn
	return func() { openBrowser = orig }
}

// --- cmdServe port validation ---

func TestCmdServeRejectsAnUnusablePort(t *testing.T) {
	for _, arg := range []string{"0", "-1", "70000"} {
		t.Run(arg, func(t *testing.T) {
			t.Setenv("XDG_CONFIG_HOME", t.TempDir())
			err := cmdServe([]string{"--port", arg})
			if err == nil {
				t.Fatalf("cmdServe --port %s = nil error, want a refusal", arg)
			}
			if !strings.Contains(err.Error(), "port") {
				t.Fatalf("cmdServe --port %s error = %q, want it to mention the port", arg, err.Error())
			}
		})
	}
}

// --- carried constraint: fatal empty token ---

// TestCmdServeRefusesEmptyToken exercises the carried constraint directly:
// flue serve must refuse to start rather than come up with an empty auth
// token, regardless of whether LoadOrCreateToken can currently produce one.
// Auth.Check's constantEqual and Server.ListenAndServe's nil-authenticator
// check are backstops for a different failure shape (no authenticator at
// all); neither one inspects the token's content, so this check is the only
// thing that would catch a future change to config.LoadOrCreateToken that
// let ("", nil) through.
func TestCmdServeRefusesEmptyToken(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())

	orig := loadToken
	loadToken = func() (string, error) { return "", nil }
	defer func() { loadToken = orig }()

	err := cmdServe(nil)
	if err == nil {
		t.Fatal("cmdServe = nil error with an empty token, want a refusal")
	}
	if !strings.Contains(err.Error(), "empty") {
		t.Fatalf("cmdServe error = %q, want it to mention the empty token", err.Error())
	}
}

// --- openURL ---

func TestOpenURLEscapesSpecialCharacters(t *testing.T) {
	// A directory name containing URL metacharacters must not break the URL
	// or let its bytes smuggle in extra query parameters (an "h=" among
	// them) that were never meant to be there.
	cwd := "/Users/karn/some project & stuff #2/100%done"
	got := openURL(7717, "handoff123", cwd)

	u, err := url.Parse(got)
	if err != nil {
		t.Fatalf("openURL produced an unparseable URL %q: %v", got, err)
	}
	if u.Query().Get("cwd") != cwd {
		t.Fatalf("cwd round-trip = %q, want %q (raw URL: %s)", u.Query().Get("cwd"), cwd, got)
	}
	if u.Query().Get(local.HandoffParam) != "handoff123" {
		t.Fatalf("%s = %q, want %q — a badly escaped cwd must not smuggle an extra handoff param (raw URL: %s)",
			local.HandoffParam, u.Query().Get(local.HandoffParam), "handoff123", got)
	}
	if n := len(u.Query()[local.HandoffParam]); n != 1 {
		t.Fatalf("%s appeared %d times, want exactly 1 (raw URL: %s)", local.HandoffParam, n, got)
	}
}

func TestOpenURLInjectionAttemptCannotOverrideHandoff(t *testing.T) {
	// A cwd deliberately crafted to look like "&h=evil" must not be able to
	// inject a second top-level query parameter at all. Checking only
	// Get("h") == "real-handoff" would not catch a regression here — since
	// openURL always places the handoff before "cwd", an unescaped injection
	// would produce a *second*, trailing value, and Get returns the first one
	// regardless, masking the bug. The real invariant is that it appears
	// exactly once.
	cwd := "/tmp/x&" + local.HandoffParam + "=evil-handoff"
	got := openURL(7717, "real-handoff", cwd)

	u, err := url.Parse(got)
	if err != nil {
		t.Fatalf("openURL produced an unparseable URL %q: %v", got, err)
	}
	if vals := u.Query()[local.HandoffParam]; len(vals) != 1 || vals[0] != "real-handoff" {
		t.Fatalf("%s values = %v, want exactly [\"real-handoff\"] (raw URL: %s)", local.HandoffParam, vals, got)
	}
	if u.Query().Get("cwd") != cwd {
		t.Fatalf("cwd round-trip = %q, want %q (raw URL: %s)", u.Query().Get("cwd"), cwd, got)
	}
}

// --- the handoff token ---

// TestOpenURLEmitsNoSessionTokenParameter pins the shape of the URL: a handoff
// parameter and nothing that could ever have been the session token.
//
// It cannot prove the stronger claim in its own right — openURL is no longer
// handed the session token, so it could not emit one if it tried. The live
// assertion here is that the "t" parameter is gone, which is what would have to
// come back for a regression to reintroduce the exposure.
// TestCmdOpenPutsNoSessionTokenInTheBrowserCommandLine is the real coverage:
// it drives cmdOpen against a real daemon and inspects the exact string handed
// to the browser, with the actual token on disk to compare against.
func TestOpenURLEmitsNoSessionTokenParameter(t *testing.T) {
	got := openURL(7717, "a-fresh-handoff", "/tmp/work")
	u, err := url.Parse(got)
	if err != nil {
		t.Fatalf("unparseable URL %q: %v", got, err)
	}
	if u.Query().Has("t") {
		t.Fatalf("openURL still emits a \"t\" parameter: %s", got)
	}
	if vals := u.Query()[local.HandoffParam]; len(vals) != 1 || vals[0] != "a-fresh-handoff" {
		t.Fatalf("%s values = %v, want exactly [\"a-fresh-handoff\"]: %s", local.HandoffParam, vals, got)
	}
}

// TestOpenURLOmitsAnEmptyCwd: flue serve's banner has no directory to offer, and
// a blank "cwd=" would be one more thing the app has to tell apart from absent.
func TestOpenURLOmitsAnEmptyCwd(t *testing.T) {
	got := openURL(7717, "a-fresh-handoff", "")
	u, err := url.Parse(got)
	if err != nil {
		t.Fatalf("unparseable URL %q: %v", got, err)
	}
	if u.Query().Has("cwd") {
		t.Fatalf("openURL emitted a cwd parameter for an empty cwd: %s", got)
	}
	if u.Query().Get(local.HandoffParam) != "a-fresh-handoff" {
		t.Fatalf("handoff lost when cwd is empty: %s", got)
	}
}

// TestMintHandoffReturnsASingleUseToken drives the real round trip against a
// real daemon: the token the CLI gets back must authenticate one first load and
// then be worthless.
func TestMintHandoffReturnsASingleUseToken(t *testing.T) {
	port := newTestDaemon(t, "tok")

	h, err := mintHandoff(port, "tok")
	if err != nil {
		t.Fatalf("mintHandoff: %v", err)
	}
	if h == "" {
		t.Fatal("mintHandoff returned an empty token")
	}
	if h == "tok" {
		t.Fatal("mintHandoff returned the session token")
	}

	load := func() int {
		req, err := http.NewRequest(http.MethodGet, openURL(port, h, "/tmp"), nil)
		if err != nil {
			t.Fatalf("NewRequest: %v", err)
		}
		req.Header.Set("Sec-Fetch-Site", "none")
		resp, err := probeClient.Do(req)
		if err != nil {
			t.Fatalf("first load: %v", err)
		}
		defer resp.Body.Close()
		return resp.StatusCode
	}

	if got := load(); got != http.StatusOK {
		t.Fatalf("first load = %d, want 200", got)
	}
	if got := load(); got != http.StatusUnauthorized {
		t.Fatalf("second load = %d, want 401 — the handoff token must be single-use", got)
	}
}

// TestMintHandoffReportsARejectedToken: the daemon answering 401 means the
// token on disk is not the one the running daemon loaded, which is a real
// state (config regenerates a token file whose mode has been loosened). It has
// to be recognised rather than reported as a decode failure.
func TestMintHandoffReportsARejectedToken(t *testing.T) {
	port := newTestDaemon(t, "the-daemons-token")

	if _, err := mintHandoff(port, "a-different-token"); !errors.Is(err, errTokenRejected) {
		t.Fatalf("mintHandoff error = %v, want errTokenRejected", err)
	}
}

// TestMintHandoffRefusesADaemonThatEchoesTheSessionToken is the CLI's own last
// line of defence. Everything else in this change is about keeping the session
// token out of argv; if a future daemon bug — or an impostor on the port that
// somehow passed the identity checks — answered the mint with the token it was
// given, the CLI would put it straight into a browser command line. Refuse
// rather than trust the peer.
func TestMintHandoffRefusesADaemonThatEchoesTheSessionToken(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintf(w, `{"handoff":%q}`, r.Header.Get(local.HeaderName))
	}))
	defer ts.Close()

	u, _ := url.Parse(ts.URL)
	port, _ := strconv.Atoi(u.Port())

	if got, err := mintHandoff(port, "the-session-token"); err == nil {
		t.Fatalf("mintHandoff = %q, nil for a daemon that echoed the session token; want a refusal", got)
	}
}

// TestCmdOpenPutsNoSessionTokenInTheBrowserCommandLine is the end-to-end
// statement of the requirement: whatever flue open hands the browser, the
// contents of $XDG_CONFIG_HOME/flue/token must not be in it.
func TestCmdOpenPutsNoSessionTokenInTheBrowserCommandLine(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())

	token, err := config.LoadOrCreateToken()
	if err != nil {
		t.Fatalf("LoadOrCreateToken: %v", err)
	}
	port := newTestDaemon(t, token)
	if err := daemon.WriteRuntime(port); err != nil {
		t.Fatalf("WriteRuntime: %v", err)
	}

	var launched []string
	restore := swapBrowser(t, func(url string) error {
		launched = append(launched, url)
		return nil
	})
	defer restore()

	dir := t.TempDir()
	if err := cmdOpen([]string{dir}); err != nil {
		t.Fatalf("cmdOpen: %v", err)
	}
	if len(launched) != 1 {
		t.Fatalf("browser launched %d times, want 1", len(launched))
	}

	got := launched[0]
	if strings.Contains(got, token) {
		t.Fatalf("flue open handed the browser the session token: %s", got)
	}
	u, err := url.Parse(got)
	if err != nil {
		t.Fatalf("unparseable URL %q: %v", got, err)
	}
	if u.Query().Has("t") {
		t.Fatalf("flue open still emits a \"t\" parameter: %s", got)
	}
	h := u.Query().Get(local.HandoffParam)
	if h == "" {
		t.Fatalf("flue open handed the browser no handoff token: %s", got)
	}
	if h == token {
		t.Fatal("the handoff token in the URL is the session token")
	}
	if u.Query().Get("cwd") != dir {
		t.Fatalf("cwd = %q, want %q", u.Query().Get("cwd"), dir)
	}

	// And the token it did hand over is good for exactly one load.
	load := func() int {
		req, err := http.NewRequest(http.MethodGet, got, nil)
		if err != nil {
			t.Fatalf("NewRequest: %v", err)
		}
		req.Header.Set("Sec-Fetch-Site", "none")
		resp, err := probeClient.Do(req)
		if err != nil {
			t.Fatalf("load: %v", err)
		}
		defer resp.Body.Close()
		return resp.StatusCode
	}
	if code := load(); code != http.StatusOK {
		t.Fatalf("the URL flue open produced answered %d, want 200", code)
	}
	if code := load(); code != http.StatusUnauthorized {
		t.Fatalf("the URL flue open produced still worked on a second load (%d), want 401", code)
	}
}

// TestCmdOpenFailsRatherThanFallBackWhenTheTokenIsStale: a daemon holding a
// different token cannot mint, and flue open must say so rather than fall back
// to putting the stored token in the URL.
func TestCmdOpenFailsRatherThanFallBackWhenTheTokenIsStale(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())

	token, err := config.LoadOrCreateToken()
	if err != nil {
		t.Fatalf("LoadOrCreateToken: %v", err)
	}
	port := newTestDaemon(t, "a-token-the-daemon-loaded-earlier")
	if err := daemon.WriteRuntime(port); err != nil {
		t.Fatalf("WriteRuntime: %v", err)
	}

	var launched []string
	restore := swapBrowser(t, func(url string) error {
		launched = append(launched, url)
		return nil
	})
	defer restore()

	err = cmdOpen([]string{t.TempDir()})
	if err == nil {
		t.Fatal("cmdOpen = nil against a daemon that rejects the stored token, want an error")
	}
	if !errors.Is(err, errTokenRejected) {
		t.Fatalf("cmdOpen error = %v, want errTokenRejected", err)
	}
	if len(launched) != 0 {
		t.Fatalf("cmdOpen launched a browser anyway with %q", launched)
	}
	if strings.Contains(err.Error(), token) {
		t.Fatalf("cmdOpen's error message leaks the session token: %v", err)
	}
}

// bannerURL returns the http:// link in a banner, or "" if there is none.
func bannerURL(banner string) string {
	for _, f := range strings.Fields(banner) {
		if strings.HasPrefix(f, "http://") {
			return f
		}
	}
	return ""
}

// TestServeBannerMintsRatherThanPrintingTheSessionToken is the regression this
// banner is most likely to suffer, because printing the session token is
// exactly what it used to do. The banner takes the authenticator and mints for
// itself, so there is no parameter along which the session token could be
// handed to it — this asserts the consequence: what it advertises is not the
// session token, is redeemable against that very authenticator, and is spent
// afterwards.
func TestServeBannerMintsRatherThanPrintingTheSessionToken(t *testing.T) {
	const sessionToken = "0123456789abcdef-the-session-token"
	auth := local.NewAuth(sessionToken, 7717)

	out := serveBanner(7717, auth)
	if strings.Contains(out, sessionToken) {
		t.Fatalf("banner printed the session token: %s", out)
	}
	if !strings.Contains(out, "127.0.0.1:7717") {
		t.Errorf("banner does not say where the daemon is: %s", out)
	}

	raw := bannerURL(out)
	if raw == "" {
		t.Fatalf("banner has no link: %s", out)
	}
	u, err := url.Parse(raw)
	if err != nil {
		t.Fatalf("banner link %q is unparseable: %v", raw, err)
	}
	if u.Query().Has("t") {
		t.Fatalf("banner link carries a \"t\" parameter: %s", raw)
	}
	h := u.Query().Get(local.HandoffParam)
	if h == "" {
		t.Fatalf("banner link carries no handoff token: %s", raw)
	}
	if !auth.Redeem(h) {
		t.Fatal("the banner advertised a token its own daemon will not accept")
	}
	if auth.Redeem(h) {
		t.Fatal("the banner's token was redeemable twice")
	}

	// The link dies in seconds, so the banner has to say so — otherwise the
	// user meets that fact as an unexplained 401.
	if !strings.Contains(out, local.HandoffTTL.String()) {
		t.Errorf("banner does not tell the user the link expires in %s: %s", local.HandoffTTL, out)
	}
	if !strings.Contains(out, "flue open") {
		t.Errorf("banner does not say how to get another way in: %s", out)
	}
}

// TestServeBannerDegradesWhenMintingFails. Mint's only failure mode is the
// system entropy source, and a daemon that refused to serve because it could
// not decorate its own banner would be a bad trade. The degraded banner must
// still name the daemon and still point at flue open — and it must not reach
// for the session token as a consolation prize.
func TestServeBannerDegradesWhenMintingFails(t *testing.T) {
	out := bannerText(7717, "")

	if !strings.Contains(out, "127.0.0.1:7717") {
		t.Errorf("degraded banner does not say where the daemon is: %s", out)
	}
	if !strings.Contains(out, "flue open") {
		t.Errorf("degraded banner does not tell the user how to get in: %s", out)
	}
	if strings.Contains(out, "?") || strings.Contains(out, "=") {
		t.Errorf("degraded banner carries a query parameter, so it is carrying a credential: %s", out)
	}
}

// TestServeBannerLinkWorksExactlyOnceAgainstARealDaemon is the integration
// half: the banner's convenience is only real if the link actually logs you in
// over HTTP, and the security claim is only real if it does so once.
func TestServeBannerLinkWorksExactlyOnceAgainstARealDaemon(t *testing.T) {
	srv := daemon.New(session.NewRegistry(time.Now), nil, uiHandler(), version)
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)
	t.Cleanup(srv.Shutdown)

	u, err := url.Parse(ts.URL)
	if err != nil {
		t.Fatalf("parse %q: %v", ts.URL, err)
	}
	port, err := strconv.Atoi(u.Port())
	if err != nil {
		t.Fatalf("parse port from %q: %v", ts.URL, err)
	}
	auth := local.NewAuth("the-session-token", port)
	srv.SetAuth(auth)

	banner := serveBanner(port, auth)
	if strings.Contains(banner, "the-session-token") {
		t.Fatalf("banner leaked the session token: %s", banner)
	}

	link := bannerURL(banner)
	if link == "" {
		t.Fatalf("banner has no link: %s", banner)
	}

	load := func() int {
		req, err := http.NewRequest(http.MethodGet, link, nil)
		if err != nil {
			t.Fatalf("NewRequest: %v", err)
		}
		req.Header.Set("Sec-Fetch-Site", "none")
		resp, err := probeClient.Do(req)
		if err != nil {
			t.Fatalf("load %s: %v", link, err)
		}
		defer resp.Body.Close()
		return resp.StatusCode
	}

	if got := load(); got != http.StatusOK {
		t.Fatalf("the banner's link answered %d, want 200 — the banner promises a way in", got)
	}
	if got := load(); got != http.StatusUnauthorized {
		t.Fatalf("the banner's link still worked on a second load (%d), want 401", got)
	}
}

// --- confirmListening ---

func TestConfirmListeningReturnsNilAfterGraceWithNoError(t *testing.T) {
	// Standing in for a successful bind: ListenAndServe is still blocked in
	// Serve, so nothing ever arrives on serveErr.
	serveErr := make(chan error)
	if err := confirmListening(serveErr, 30*time.Millisecond); err != nil {
		t.Fatalf("confirmListening: %v", err)
	}
}

func TestConfirmListeningReturnsBindErrorPromptly(t *testing.T) {
	wantErr := errors.New("listen tcp 127.0.0.1:7717: bind: address already in use")
	serveErr := make(chan error, 1)
	serveErr <- wantErr

	start := time.Now()
	err := confirmListening(serveErr, 2*time.Second)
	if !errors.Is(err, wantErr) {
		t.Fatalf("confirmListening error = %v, want %v", err, wantErr)
	}
	if elapsed := time.Since(start); elapsed > time.Second {
		t.Fatalf("confirmListening took %s to report an error that arrived immediately, want it to return promptly rather than waiting out the grace period", elapsed)
	}
}

func TestConfirmListeningErrorsWhenServeReturnsNilEarly(t *testing.T) {
	// If ListenAndServe returns nil before confirmListening's grace period
	// elapses, it stopped (a context already cancelled, say) before ever
	// getting a chance to serve. That must not be reported as success.
	serveErr := make(chan error, 1)
	serveErr <- nil

	if err := confirmListening(serveErr, 2*time.Second); err == nil {
		t.Fatal("confirmListening = nil, want an error when ListenAndServe returned nil before the grace period elapsed")
	}
}

// TestConfirmListeningIgnoresAForeignOccupant is a regression test for a bug
// found while manually smoke-testing cmdServe: an earlier version of
// confirmListening (then named waitForListening) decided the daemon was up
// by dialing the port, rather than by watching serveErr. That is fooled by
// exactly the scenario a "confirm before advertising" check exists to catch
// — something else already listening on the target port before our own
// daemon's bind is even attempted. Dialing found the foreign listener,
// declared success, and let cmdServe write runtime.json and print "daemon
// running" for a bind that had, in fact, failed.
//
// confirmListening must not care what is or isn't reachable on the network;
// it must only react to serveErr, which is what actually reports our own
// ListenAndServe's outcome.
func TestConfirmListeningIgnoresAForeignOccupant(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("Listen: %v", err)
	}
	defer ln.Close() // a foreign process occupying the port

	bindErr := errors.New("listen tcp: bind: address already in use")
	serveErr := make(chan error, 1)
	serveErr <- bindErr

	err = confirmListening(serveErr, 2*time.Second)
	if !errors.Is(err, bindErr) {
		t.Fatalf("confirmListening error = %v, want %v — a reachable port must not be mistaken for our own daemon's bind succeeding", err, bindErr)
	}
}

// --- acquireStartLock ---

func TestAcquireStartLockSerializesConcurrentHolders(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())

	unlock1, err := acquireStartLock(2 * time.Second)
	if err != nil {
		t.Fatalf("first acquireStartLock: %v", err)
	}

	var (
		mu            sync.Mutex
		secondEntered bool
	)
	done := make(chan struct{})
	go func() {
		defer close(done)
		unlock2, err := acquireStartLock(2 * time.Second)
		if err != nil {
			t.Errorf("second acquireStartLock: %v", err)
			return
		}
		mu.Lock()
		secondEntered = true
		mu.Unlock()
		unlock2()
	}()

	// The second goroutine must not be able to acquire the lock while the
	// first holder is still holding it.
	time.Sleep(150 * time.Millisecond)
	mu.Lock()
	entered := secondEntered
	mu.Unlock()
	if entered {
		t.Fatal("second acquireStartLock succeeded while the first holder still held the lock")
	}

	unlock1()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("second acquireStartLock did not complete after the first holder released the lock")
	}
}

func TestAcquireStartLockTimesOutWhenHeld(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())

	unlock, err := acquireStartLock(2 * time.Second)
	if err != nil {
		t.Fatalf("acquireStartLock: %v", err)
	}
	defer unlock()

	_, err = acquireStartLock(100 * time.Millisecond)
	if err == nil {
		t.Fatal("acquireStartLock = nil error while the lock was held, want a timeout error")
	}
	if !strings.Contains(err.Error(), "timed out") {
		t.Fatalf("acquireStartLock error = %q, want it to mention timing out", err.Error())
	}
}
