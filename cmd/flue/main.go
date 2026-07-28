// Command flue runs the flue daemon and opens terminal sessions in the
// browser.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
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

const (
	// startTimeout is how long flue open waits for a daemon it started to
	// become reachable.
	startTimeout = 5 * time.Second
	// lockTimeout must exceed startTimeout: the process holding the start
	// lock may legitimately spend all of startTimeout inside it, and a
	// waiter that gave up sooner would go start a second daemon for exactly
	// the reason the lock exists to prevent.
	lockTimeout = startTimeout + 5*time.Second
	// probeTimeout bounds a single loopback request. It exists so a port
	// that accepts connections and then says nothing — which is one of the
	// things "something is listening there" can turn out to mean — cannot
	// wedge the CLI indefinitely.
	probeTimeout = 2 * time.Second
)

// loadToken is config.LoadOrCreateToken, indirected through a package
// variable so a test can exercise cmdServe's carried "empty token is fatal"
// check even though LoadOrCreateToken cannot currently return ("", nil) in
// practice. Same seam pattern internal/session uses for killGroup, for the
// same reason: the substitution belongs to the test, not to any code path a
// real invocation of flue serve takes.
var loadToken = config.LoadOrCreateToken

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

// cmdServe runs the daemon in the foreground until its context is cancelled
// (Ctrl-C, SIGTERM) or it fails to serve.
//
// It deliberately does not advertise the daemon — neither the runtime file
// nor the "daemon running" message — until the listener has actually bound.
// ListenAndServe blocks for the life of the daemon, so confirming that means
// running it in a goroutine and giving it a moment to fail: a bind failure is
// the only thing that can make it return before Serve blocks. Advertising on
// the strength of having *asked* the daemon to listen, rather than having
// confirmed it, would leave runtime.json pointing at a port our daemon never
// got — most likely one somebody else already holds.
func cmdServe(args []string) error {
	fs := flag.NewFlagSet("serve", flag.ExitOnError)
	port := fs.Int("port", defaultPort, "loopback port")
	if err := fs.Parse(args); err != nil {
		return err
	}
	// Port 0 would bind a kernel-assigned port, which the daemon has no way
	// to report: it would advertise 0 in runtime.json and print a URL nobody
	// can reach. Refuse it here rather than come up unreachable.
	if *port < 1 || *port > 65535 {
		return fmt.Errorf("port must be between 1 and 65535, got %d", *port)
	}

	// Locked, because flue serve is one of the two ways a token gets created
	// and the other one (flue open, via ensureDaemon) can be running at the
	// same time in another terminal or from a login service. See
	// loadTokenLocked for what an unserialized creation costs.
	token, err := loadTokenLocked()
	if err != nil {
		return fmt.Errorf("load auth token: %w", err)
	}
	// Carried constraint: a daemon that spawns shells must never come up
	// authenticating against an empty token. Auth.Check's constantEqual
	// already fails closed on "" (an empty want never matches), and
	// Server.ListenAndServe refuses to start with no authenticator at all —
	// but both of those are backstops for a nil/misconfigured Auth, not a
	// check on the token's content. LoadOrCreateToken cannot currently
	// return ("", nil), but startup policy must not depend on that staying
	// true; refuse outright rather than trust it.
	if token == "" {
		return errors.New("refusing to start: auth token is empty")
	}

	reg := session.NewRegistry(time.Now)
	srv := daemon.New(reg, local.NewAuth(token, *port), uiHandler(), version)

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	serveErr := make(chan error, 1)
	go func() { serveErr <- srv.ListenAndServe(ctx, *port) }()

	if err := confirmListening(serveErr, listenGrace); err != nil {
		return err
	}

	if err := daemon.WriteRuntime(*port); err != nil {
		return err
	}
	// Take the record with us on the way out. It cannot be relied on —
	// nothing runs on SIGKILL — but when it does run it turns a later "flue
	// status" from a guess about whatever now holds the port into a plain
	// "not running".
	defer func() { _ = daemon.ClearRuntime() }()

	fmt.Printf("daemon running on 127.0.0.1:%d\n", *port)
	fmt.Printf("  http://127.0.0.1:%d/?t=%s\n", *port, token)

	// ListenAndServe reports a ctx-caused shutdown as nil, not as
	// http.ErrServerClosed, so there is nothing to filter out here: whatever
	// it returns is the exit status of the daemon.
	return <-serveErr
}

// listenGrace is how long confirmListening gives ListenAndServe to fail
// before concluding it bound successfully. net.Listen is a synchronous,
// purely local pair of syscalls (socket, then bind+listen) with no failure
// mode that manifests after they return, so this only needs to comfortably
// exceed goroutine-scheduling latency, not model any real network delay.
const listenGrace = 300 * time.Millisecond

// confirmListening blocks until serveErr delivers ListenAndServe's return
// value or grace elapses without one.
//
// This deliberately does not dial the port to check: dialing observes
// whatever is listening there, not specifically our own daemon, so it would
// be fooled by exactly the case this exists to guard against — another,
// unrelated process already occupying the port before our own bind is even
// attempted. (An earlier version of this function did exactly that, and a
// manual test — start something else on the target port, then flue serve
// --port <that port> — caught it: portOpen(port) reported true from the
// foreign listener, and runtime.json got written to a port our daemon had
// in fact failed to bind.) Racing a grace period against serveErr instead
// only reacts to *our own* ListenAndServe's outcome: it can either fail
// synchronously, before Serve ever blocks — which is the only way it
// returns this early — or it has, in truth, already bound and is serving.
func confirmListening(serveErr <-chan error, grace time.Duration) error {
	select {
	case err := <-serveErr:
		if err != nil {
			return err
		}
		return errors.New("daemon stopped before it started listening")
	case <-time.After(grace):
		return nil
	}
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
	// Resolve to an absolute path before it goes anywhere else. It ends up
	// in a URL handed to a daemon that may be a long-running, already-open
	// process — started minutes ago from an unrelated directory, or detached
	// via ensureDaemon below — so a relative path would be interpreted
	// relative to *that* process's working directory, not the shell the user
	// actually typed "flue open" from.
	abs, err := filepath.Abs(cwd)
	if err != nil {
		return err
	}
	cwd = abs

	info, err := os.Stat(cwd)
	if err != nil {
		return err
	}
	if !info.IsDir() {
		return fmt.Errorf("%s is not a directory", cwd)
	}

	port, err := ensureDaemon()
	if err != nil {
		return err
	}
	token, err := loadToken()
	if err != nil {
		return fmt.Errorf("load auth token: %w", err)
	}

	// Catch a token the running daemon will not accept before handing the
	// user a URL that silently 401s in the browser. This happens for real:
	// config discards and regenerates a token file whose mode has been
	// loosened, so a backup or sync tool touching the file leaves an
	// already-running daemon holding a token nobody on disk has any more.
	//
	// Only an outright rejection is fatal. A timeout or a transport error
	// says nothing about the token, and must not stop flue open from doing
	// its job.
	if _, err := fetchSessions(port, token); errors.Is(err, errTokenRejected) {
		return err
	}

	target := openURL(port, token, cwd)
	fmt.Println(target)
	return openBrowser(target)
}

// openURL builds the URL flue open hands to the browser.
//
// cwd is an arbitrary filesystem path, not a token drawn from a known-safe
// alphabet, so it goes through url.Values rather than fmt.Sprintf: a path
// containing "&", "#", "%", or "+" formatted straight into a query string
// would either break the URL outright or let a directory name inject
// additional query parameters (a "t=" among them) that were never meant to
// be there.
func openURL(port int, token, cwd string) string {
	u := &url.URL{
		Scheme: "http",
		Host:   fmt.Sprintf("127.0.0.1:%d", port),
		Path:   "/",
	}
	q := u.Query()
	q.Set("t", token)
	q.Set("cwd", cwd)
	u.RawQuery = q.Encode()
	return u.String()
}

func cmdStatus() error {
	recorded, _, ok := daemon.ReadRuntimeRecord()
	if !ok {
		fmt.Println("daemon: not running")
		return nil
	}
	// A record naming a process that is gone, or one this user cannot signal,
	// is as stale as a record naming a port nothing answers on: either way
	// the daemon it describes is not this user's to talk to.
	port, ok := ourDaemon()
	if !ok {
		fmt.Printf("daemon: not running (stale runtime record for port %d)\n", recorded)
		return nil
	}
	token, err := loadToken()
	if err != nil {
		return fmt.Errorf("load auth token: %w", err)
	}

	infos, err := fetchSessions(port, token)
	if err != nil {
		return err
	}

	fmt.Printf("daemon:   running on 127.0.0.1:%d\n", port)
	fmt.Printf("sessions: %d\n", len(infos))
	for _, s := range infos {
		fmt.Printf("  %s  %-8s %s\n", s.ID, s.State, s.Cwd)
	}
	return nil
}

// errTokenRejected reports that a daemon is running and answering, but does
// not accept the token on disk — so it was started with a different one.
var errTokenRejected = errors.New("the running daemon rejected the stored auth token: stop it and start it again to pick up the current token")

// maxListingBytes bounds the session listing this CLI will parse. The daemon
// it is talking to has been identified as flue by daemonAt, so this is a
// backstop against a wedged or corrupted daemon, not against a hostile one.
const maxListingBytes = 1 << 20

// probeClient is used for every loopback request the CLI makes.
//
// Redirects are never followed. Nothing in the daemon's HTTP surface issues
// one, so a redirect means the responder is not the daemon — and following it
// would send a request carrying the auth token to wherever it pointed.
var probeClient = &http.Client{
	Timeout: probeTimeout,
	CheckRedirect: func(*http.Request, []*http.Request) error {
		return http.ErrUseLastResponse
	},
}

// ourDaemon returns the recorded port of a daemon this process may treat as
// its own, and is the only way flue open and flue status are allowed to
// decide where the daemon is.
//
// It is two checks because one is not enough, and the shortfall of each is
// what the other covers:
//
//   - The record outlives the daemon that wrote it — a crash, a kill -9, a
//     reboot with the config directory intact — and the port it names is then
//     free for anything else on the machine to take. So what is listening has
//     to identify itself as flue (daemonAt) before it is sent anything.
//
//   - But one flue daemon looks exactly like another, and on a shared machine
//     the process now holding flue's default port may be another user's
//     daemon. It would answer daemonAt perfectly. Sending it this user's
//     token — which is unrestricted shell access as this user — is the worst
//     outcome in this file, and it is also the *likeliest* mistaken identity,
//     since flue's own default port is exactly the port another flue picks.
//     Signal 0 against the recorded PID is the available evidence: it
//     succeeds only for a live process this user is allowed to signal, so a
//     dead daemon (ESRCH) and another user's daemon (EPERM) both fail it.
//
// Neither check is proof. A PID can be recycled onto an unrelated process of
// this user's, and a local process can trivially imitate the daemon's
// refusal, so a determined local attacker who can bind the port first is not
// shut out by this — only by not being able to bind it. What this does rule
// out is every accident: stale records, ports reused by unrelated services,
// and other users' daemons.
func ourDaemon() (int, bool) {
	port, pid, ok := daemon.ReadRuntimeRecord()
	if !ok || !ownedByUs(pid) {
		return 0, false
	}
	if !daemonAt(port) {
		return 0, false
	}
	return port, true
}

// ownedByUs reports whether pid is a live process this user could signal.
// Signal 0 runs the existence and permission checks and delivers nothing.
//
// A record with no PID at all is not evidence of anything — nothing flue
// writes omits it — so it is left to the probe rather than rejected outright.
func ownedByUs(pid int) bool {
	if pid == 0 {
		return true
	}
	// A negative PID is a process group to kill(2), not a process, and -1 is
	// every process it can reach. Neither is an ownership question, so never
	// let one become a syscall.
	if pid < 0 {
		return false
	}
	return syscall.Kill(pid, 0) == nil
}

// daemonAt reports whether a flue daemon — not merely *something* — is
// listening on port.
//
// The probe deliberately carries no token: it asks an authenticated endpoint
// for something it is not allowed to have, and a flue daemon is recognised by
// the shape of its refusal — 401 from local.Auth's middleware, wrapped in the
// response headers daemon.Server sets on every response. So being wrong about
// an unrelated service costs a spurious "not running", never a leaked
// credential. It says nothing about *which* flue daemon answered; that is
// ourDaemon's PID check, and this must not be used without it.
func daemonAt(port int) bool {
	req, err := http.NewRequest(http.MethodGet, fmt.Sprintf("http://127.0.0.1:%d/api/sessions", port), nil)
	if err != nil {
		return false
	}
	resp, err := probeClient.Do(req)
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4<<10))

	return resp.StatusCode == http.StatusUnauthorized &&
		resp.Header.Get("Referrer-Policy") == "no-referrer" &&
		resp.Header.Get("Content-Security-Policy") != ""
}

// fetchSessions asks the daemon for its session listing.
func fetchSessions(port int, token string) ([]session.Info, error) {
	u := &url.URL{
		Scheme:   "http",
		Host:     fmt.Sprintf("127.0.0.1:%d", port),
		Path:     "/api/sessions",
		RawQuery: url.Values{"t": {token}}.Encode(),
	}
	req, err := http.NewRequest(http.MethodGet, u.String(), nil)
	if err != nil {
		return nil, err
	}
	resp, err := probeClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	// The daemon answers a failed check with a plain-text body, so status has
	// to be checked before decoding: handing that body to a JSON decoder
	// would report a syntax error instead of the actual problem.
	switch resp.StatusCode {
	case http.StatusOK:
	case http.StatusUnauthorized:
		return nil, errTokenRejected
	default:
		return nil, fmt.Errorf("daemon on 127.0.0.1:%d answered %s", port, resp.Status)
	}

	var body struct {
		Sessions []session.Info `json:"sessions"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, maxListingBytes)).Decode(&body); err != nil {
		return nil, fmt.Errorf("decode session listing: %w", err)
	}
	return body.Sessions, nil
}

// ensureDaemon starts a background daemon if one is not already listening.
//
// A naive check-then-spawn here is not safe against two "flue open"
// invocations racing on a machine with no daemon yet: both would see an
// absent runtime file and each spawn their own "flue serve". That is more
// than a wasted process. On a fresh install, before config.LoadOrCreateToken
// has ever persisted a token, each of the two daemons would generate and try
// to persist its *own* random token. config's atomic rename keeps the token
// *file* from being corrupted, but it does nothing to keep the file in sync
// with what either daemon actually loaded into memory before the race —
// whichever daemon's rename lands second determines the token on disk, and
// that may not be the one the daemon that actually wins the port bind is
// using. Every subsequent flue open/flue status reads the token from disk
// and hands it to that daemon, which then rejects it with 401 forever, until
// someone notices and kills the daemon by hand.
//
// A file lock, held only for the duration of the check-load-spawn sequence,
// makes exactly one flue process responsible for it at a time; everyone else
// waits for the lock and then re-checks, rather than racing the winner.
func ensureDaemon() (int, error) {
	if port, ok := ourDaemon(); ok {
		return port, nil
	}

	unlock, err := acquireStartLock(lockTimeout)
	if err != nil {
		return 0, err
	}
	defer unlock()

	// Whoever held the lock before us may have already finished starting a
	// daemon while we were waiting for it.
	if port, ok := ourDaemon(); ok {
		return port, nil
	}

	// Persist the token before any daemon can generate one, under the lock
	// that keeps the creation single. Doing it here means the daemon we are
	// about to start only ever reads a token that already exists.
	if _, err := loadTokenLocked(); err != nil {
		return 0, fmt.Errorf("load auth token: %w", err)
	}

	if err := spawnDaemon(); err != nil {
		return 0, fmt.Errorf("start daemon: %w", err)
	}

	deadline := time.Now().Add(startTimeout)
	for time.Now().Before(deadline) {
		if port, ok := ourDaemon(); ok {
			return port, nil
		}
		time.Sleep(50 * time.Millisecond)
	}
	// A daemon we just started and never saw almost certainly could not bind.
	// Its output went to /dev/null, so report what can still be observed from
	// here rather than leaving the user with a bare timeout.
	//
	// A flue daemon on the port with no record naming it is a real state — a
	// record deleted by hand, or one this user does not own — and it is not
	// recoverable from here. Adopting it would mean sending this user's token
	// to a daemon nothing identifies as theirs, which is the one thing
	// ourDaemon exists to prevent; so say what is in the way instead.
	if daemonAt(defaultPort) {
		return 0, fmt.Errorf("a flue daemon is already listening on 127.0.0.1:%d, but no runtime record identifies it as yours; stop it and run flue open again", defaultPort)
	}
	if portOpen(defaultPort) {
		return 0, fmt.Errorf("daemon did not start within %s: 127.0.0.1:%d is held by another process", startTimeout, defaultPort)
	}
	return 0, fmt.Errorf("daemon did not start within %s", startTimeout)
}

// spawnDaemon starts a detached daemon. It is a package variable so a test can
// drive ensureDaemon's locking and wait loop without starting a real process —
// under `go test` os.Executable is the test binary, so the real one cannot be
// exercised in-process at all.
var spawnDaemon = startDetachedDaemon

func startDetachedDaemon() error {
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	cmd := exec.Command(exe, "serve")
	// nil Stdout/Stderr route to /dev/null (os/exec's documented behaviour
	// when either is unset), so the detached daemon doesn't hold this
	// terminal's stdout/stderr open after flue open exits.
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	// Don't leave a long-lived daemon holding whatever directory flue open
	// happened to be run from: that keeps the filesystem it lives on busy
	// (an unmount or an eject away from being noticed) for no benefit, since
	// every session carries its own cwd. Home is also the saner fallback for
	// a session that arrives without one.
	cmd.Dir = daemonWorkDir()
	if err := cmd.Start(); err != nil {
		return err
	}
	return cmd.Process.Release()
}

func daemonWorkDir() string {
	if home, err := os.UserHomeDir(); err == nil && home != "" {
		return home
	}
	return "/"
}

// acquireStartLock serializes ensureDaemon's check-load-spawn sequence
// across flue processes.
func acquireStartLock(timeout time.Duration) (unlock func(), err error) {
	return acquireLock("start.lock", timeout)
}

// loadTokenLocked loads the auth token, serializing its *creation* across flue
// processes.
//
// config.LoadOrCreateToken generates a token on first use and installs it with
// an atomic rename. That keeps the file from tearing, but it is last-writer-
// wins: two processes reaching a fresh config directory together each generate
// their own token, and the one left on disk need not be the one held by the
// process that went on to become the daemon. Every later flue open then reads
// a token the running daemon rejects — a 401 on every request, forever, until
// someone kills the daemon by hand.
//
// The lock is separate from the start lock on purpose. ensureDaemon holds the
// start lock across the spawn and takes this one inside it, while flue serve
// takes only this one — so the daemon a flue open starts can never block on a
// lock its own parent is holding. The nesting only ever goes start -> token.
func loadTokenLocked() (string, error) {
	unlock, err := acquireLock("token.lock", lockTimeout)
	if err != nil {
		return "", err
	}
	defer unlock()
	return loadToken()
}

// acquireLock takes an flock(2) advisory lock on a file in the config
// directory, waiting up to timeout for it.
//
// It is flock rather than a lock *file*'s mere existence, because the lock
// must be released if its holder dies while holding it — a crash, a kill -9,
// a panic — and flock ties the lock to the open file descriptor's lifetime,
// which the kernel cleans up when the holding process exits for any reason. A
// lock implemented as "does this file exist" has no such guarantee: one holder
// dying at the wrong moment would wedge every future flue invocation behind a
// lock nobody is left to release.
func acquireLock(name string, timeout time.Duration) (unlock func(), err error) {
	dir, err := config.Dir()
	if err != nil {
		return nil, err
	}
	f, err := os.OpenFile(filepath.Join(dir, name), os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, err
	}

	deadline := time.Now().Add(timeout)
	for {
		err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB)
		if err == nil {
			return func() {
				_ = syscall.Flock(int(f.Fd()), syscall.LOCK_UN)
				_ = f.Close()
			}, nil
		}
		if !errors.Is(err, syscall.EWOULDBLOCK) {
			_ = f.Close()
			return nil, err
		}
		if time.Now().After(deadline) {
			_ = f.Close()
			return nil, fmt.Errorf("timed out waiting for another flue process to release %s", name)
		}
		time.Sleep(50 * time.Millisecond)
	}
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

// uiHandler is the seam Task 14 replaces with the embedded built SPA. Until
// then it serves a placeholder so flue open is exercisable end to end.
func uiHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		fmt.Fprint(w, `<!doctype html><meta charset="utf-8"><title>flue</title>
<p>flue daemon is running. The web UI lands in a later task.</p>`)
	})
}
