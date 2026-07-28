package main

import (
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

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

func swapSpawn(t *testing.T, fn func() error) (restore func()) {
	t.Helper()
	orig := spawnDaemon
	spawnDaemon = fn
	return func() { spawnDaemon = orig }
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
	// or let its bytes smuggle in extra query parameters (a "t=" among
	// them) that were never meant to be there.
	cwd := "/Users/karn/some project & stuff #2/100%done"
	got := openURL(7717, "tok123", cwd)

	u, err := url.Parse(got)
	if err != nil {
		t.Fatalf("openURL produced an unparseable URL %q: %v", got, err)
	}
	if u.Query().Get("cwd") != cwd {
		t.Fatalf("cwd round-trip = %q, want %q (raw URL: %s)", u.Query().Get("cwd"), cwd, got)
	}
	if u.Query().Get("t") != "tok123" {
		t.Fatalf("t = %q, want %q — a badly escaped cwd must not smuggle an extra t param (raw URL: %s)", u.Query().Get("t"), "tok123", got)
	}
	if len(u.Query()["t"]) != 1 {
		t.Fatalf("t appeared %d times, want exactly 1 (raw URL: %s)", len(u.Query()["t"]), got)
	}
}

func TestOpenURLInjectionAttemptCannotOverrideToken(t *testing.T) {
	// A cwd deliberately crafted to look like "&t=evil" must not be able to
	// inject a second top-level query parameter at all. Checking only
	// Get("t") == "real-token" would not catch a regression here — since
	// openURL always places "t" before "cwd", an unescaped injection would
	// produce a *second*, trailing "t" value, and Get returns the first one
	// regardless, masking the bug. The real invariant is that "t" appears
	// exactly once.
	cwd := "/tmp/x&t=evil-token"
	got := openURL(7717, "real-token", cwd)

	u, err := url.Parse(got)
	if err != nil {
		t.Fatalf("openURL produced an unparseable URL %q: %v", got, err)
	}
	if tVals := u.Query()["t"]; len(tVals) != 1 || tVals[0] != "real-token" {
		t.Fatalf("t values = %v, want exactly [\"real-token\"] (raw URL: %s)", tVals, got)
	}
	if u.Query().Get("cwd") != cwd {
		t.Fatalf("cwd round-trip = %q, want %q (raw URL: %s)", u.Query().Get("cwd"), cwd, got)
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
