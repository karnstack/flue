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
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"time"

	"github.com/karnstack/flue/internal/config"
	"github.com/karnstack/flue/internal/crypto"
	"github.com/karnstack/flue/internal/daemon"
	"github.com/karnstack/flue/internal/service"
	"github.com/karnstack/flue/internal/session"
	"github.com/karnstack/flue/internal/transport/local"
	"github.com/karnstack/flue/internal/transport/relay"
	"github.com/karnstack/flue/web"
)

// version is stamped at release time by goreleaser via
// -ldflags "-s -w -X main.version={{.Version}}". A from-source build
// reports "dev", which is the honest answer: it corresponds to no release.
// It must stay a package-level var named exactly "version" — the ldflags
// target is the string "main.version".
var version = "dev"

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
	case "enable":
		err = cmdEnable()
	case "disable":
		err = cmdDisable()
	case "status":
		err = cmdStatus()
	case "relay":
		err = cmdRelay(os.Args[2:])
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

const usageText = `flue — your terminal, as a browser tab

  flue enable             install the login service, start the daemon, open the UI
  flue disable            remove the login service
  flue status             daemon, login service, and session diagnostics
  flue relay setup        deploy a relay to your own Cloudflare account
  flue relay status       show the configured relay
  flue open [path]        spawn a session in path and open it in the browser
  flue serve [--port N] [--open]   run the daemon in the foreground
`

func usage() {
	fmt.Fprint(os.Stderr, usageText)
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
	// Opt-in, never default: serve's other callers are programmatic — the
	// login service and startDetachedDaemon both run bare `serve` — and a
	// daemon that popped a browser tab at every login would be obnoxious.
	openUI := fs.Bool("open", false, "open the UI in a browser once serving")
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
	// Bring back what the previous daemon saved on its way out: each session
	// returns under its old id with its scrollback and a fresh shell in its
	// directory. Failures are reported and skipped — revival is a courtesy,
	// and the daemon always comes up.
	for _, snap := range session.LoadAndClearSnapshots(snapshotsDir()) {
		if _, err := reg.Revive(snap); err != nil {
			fmt.Fprintf(os.Stderr, "flue: could not revive session %s: %v\n", snap.ID, err)
		}
	}
	// Held rather than inlined into daemon.New because the banner below mints
	// its own handoff token from it. Doing that in-process needs no
	// authentication ceremony: this is the process that read the token file, so
	// it is by construction the principal CheckMint exists to identify.
	auth := local.NewAuth(token, *port)
	identity, err := loadIdentity()
	if err != nil {
		return err
	}
	srv := daemon.New(reg, auth, uiHandler(), version, identity)

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
	//
	// Registered before the hold below so it runs after it: the deferred
	// stop waits for holdRuntime to have returned, which is what stops a
	// re-assertion from landing after this removal and leaving behind exactly
	// the stale record it was there to prevent.
	defer func() { _ = daemon.ClearRuntime() }()

	holdCtx, stopHold := context.WithCancel(ctx)
	held := make(chan struct{})
	go func() {
		defer close(held)
		holdRuntime(holdCtx, *port, reassertInterval)
	}()
	defer func() {
		stopHold()
		<-held
	}()

	// After the bind is confirmed, deliberately. The relay's Durable Object
	// hands the daemon leg to whoever dialled last and closes the incumbent
	// (relay/src/hub.ts), so a second daemon started by mistake — the usual
	// reason the bind fails — would kick the working one off the relay on its
	// way to exiting. Dialling only once this process owns the port means the
	// daemon that is actually serving is the one that is reachable.
	startRelay(ctx, srv, identity)

	// Only now, after the bind is confirmed and the runtime record is in place,
	// so the link is never printed for a daemon that turned out not to be
	// serving.
	fmt.Print(serveBanner(*port, auth, *openUI))

	// ListenAndServe reports a ctx-caused shutdown as nil, not as
	// http.ErrServerClosed, so there is nothing to filter out here: whatever
	// it returns is the exit status of the daemon.
	servedErr := <-serveErr

	// The daemon is no longer serving, but the shells are still its children
	// and the rings are intact — this is the one moment revival state can be
	// written. Nothing runs on SIGKILL, so a killed daemon revives nothing;
	// that is the accepted shape of a graceful-only snapshot.
	if err := session.SaveSnapshots(snapshotsDir(), reg.Snapshots()); err != nil {
		fmt.Fprintf(os.Stderr, "flue: could not save sessions for revival: %v\n", err)
	}
	return servedErr
}

// loadIdentity reads the daemon's static keypair and its paired-device
// registry out of the config directory, creating the key on first run.
//
// Threaded the same way as the auth token: read here, once, by the process
// that is about to serve, and handed to the daemon at construction — the
// daemon never reaches into the config directory itself. Failures are fatal
// rather than degraded. A daemon that could not load its static key would come
// up unable to prove it is the daemon its already-paired devices trust, and
// starting anyway would present the user with a working-looking flue whose
// pairing silently does nothing; crypto.LoadOrCreateStaticKey refuses to
// regenerate over a key it cannot parse for the same reason.
func loadIdentity() (daemon.Identity, error) {
	dir, err := config.Dir()
	if err != nil {
		return daemon.Identity{}, fmt.Errorf("locate the config directory: %w", err)
	}
	key, err := crypto.LoadOrCreateStaticKey(dir)
	if err != nil {
		return daemon.Identity{}, fmt.Errorf("load the daemon static key: %w", err)
	}
	return daemon.Identity{Key: key, Devices: crypto.NewDeviceStore(dir)}, nil
}

// startRelay dials the configured relay, if there is one, and keeps it dialled
// until ctx ends. It returns as soon as the transport is started; Run does the
// waiting, on a goroutine of its own.
//
// Nothing here is fatal, and that is the whole shape of it. flue's promise is a
// terminal in a browser tab on this machine; the relay is what makes that tab
// openable from somewhere else. A relay.json that cannot be read, one missing a
// field, a relay that is down — each of them costs remote access and none of
// them is a reason to refuse the local daemon. Every failure is a log line and
// the daemon comes up serving loopback exactly as it would have.
//
// The secret never reaches the log. relay.New's errors name the field that is
// missing rather than the value that is there, and the transport logs the URL
// it dials and nothing else from the config.
func startRelay(ctx context.Context, srv *daemon.Server, identity daemon.Identity) {
	// The same sink and format the daemon's own default logger uses, which
	// launchd and systemd already capture.
	logger := slog.New(slog.NewTextHandler(os.Stderr, nil))

	rc, ok, err := config.LoadRelay()
	if err != nil {
		// Configured and unreadable is worth a line: "no relay" is the ordinary
		// state, but this is a file somebody wrote and this daemon cannot use.
		logger.Warn("relay not started", "err", err)
		return
	}
	if !ok {
		return
	}

	t, err := relay.New(relay.Config{URL: rc.URL, Secret: rc.Secret, Origin: rc.Origin},
		srv, identity.Key, identity.Devices, logger)
	if err != nil {
		logger.Warn("relay not started", "err", err)
		return
	}
	// Before the goroutine, never after it. The transport reports this itself
	// the moment it starts dialling, and this only covers the window before it
	// is scheduled — but a seed written *after* the goroutine started races the
	// transport's own reports and can overwrite "connected" with "connecting"
	// on a relay that is already up. Nothing would correct it until the socket
	// dropped: welcomes would announce a dead relay and pairing URLs would go
	// back to naming loopback while the relay was carrying traffic.
	srv.SetRelayStatus(daemon.RelayConnecting, "")
	go func() {
		if err := t.Run(ctx); err != nil {
			logger.Warn("relay stopped", "err", err)
		}
	}()
}

// snapshotsDir is where shutdown snapshots live between daemons. An empty
// string when the config dir is unavailable — Load treats it as no
// snapshots, Save fails with a path error it reports; neither stops a
// daemon.
func snapshotsDir() string {
	dir, err := config.Dir()
	if err != nil {
		return ""
	}
	return filepath.Join(dir, session.SnapshotsDirName)
}

// serveBanner is what flue serve prints once it is listening.
//
// It takes the authenticator rather than a token string on purpose. The banner
// mints its own handoff token, so there is no parameter along which the session
// token could ever be handed to it — the mistake this line is most likely to
// regress into, since it is exactly what it used to print. Minting in-process
// needs no authentication ceremony: flue serve read the token file, so it is by
// construction the principal CheckMint exists to identify.
//
// The link carries a one-time handoff token, which is a deliberate and narrow
// exception to "a handoff token is never written out". Two things make it an
// acceptable one. What lands in scrollback is single-use and dead in
// HandoffTTL, so it is worth nothing by the time anyone reads it — which is
// precisely the exposure that made the permanent session token unacceptable
// here. And it is the user's own terminal: not a log file, not argv, and not
// anything another process can read without already being able to read far
// more.
//
// A mint failure is not a reason to refuse to serve. Its only cause is the
// system entropy source, and a daemon that shut itself down because it could
// not decorate its own banner would be a far worse trade than a banner that
// just points at flue open. That is why this returns a string and no error:
// cmdServe cannot propagate a failure it is never told about, so "the daemon
// still starts" is a property of this signature rather than of anyone
// remembering to ignore an error. It degrades to *no* credential, never to the
// session token.
//
// When flue open starts the daemon detached, this banner goes to /dev/null
// (startDetachedDaemon leaves Stdout nil), so the token is wasted rather than
// leaked. Wasting one costs nothing: the store is bounded and it expires on its
// own.
//
// With openUI it first launches the browser the way flue open does — same
// mint, same launcher — so nobody has to race HandoffTTL by hand. The printed
// link is the fallback when the launch fails, and a spent token is never
// printed: the success message carries no credential at all.
func serveBanner(port int, auth *local.Auth, openUI bool) string {
	handoff, err := auth.Mint()
	if err != nil {
		return bannerText(port, "")
	}
	if openUI {
		if err := openBrowser(openURL(port, handoff, "")); err == nil {
			return fmt.Sprintf("daemon running on 127.0.0.1:%d\n  opened the UI in your browser; run \"flue open\" for another tab\n", port)
		}
		// The launch failed, so the link is the way in — flue open's own
		// fallback, for the same reason.
	}
	return bannerText(port, handoff)
}

// bannerText formats the banner. An empty handoff yields the degraded form.
//
// The TTL is short enough that the link is convenience for someone watching the
// daemon start rather than something to come back to, so the banner says so —
// otherwise the user meets that fact as an unexplained 401.
func bannerText(port int, handoff string) string {
	head := fmt.Sprintf("daemon running on 127.0.0.1:%d\n", port)
	if handoff == "" {
		return head + "  run \"flue open\" to get a browser tab\n"
	}
	return head +
		fmt.Sprintf("  %s\n", openURL(port, handoff, "")) +
		fmt.Sprintf("  that link works once and expires in %s; run \"flue open\" for another\n", local.HandoffTTL)
}

// reassertInterval is how often a serving daemon checks that the runtime
// record still names a live process, and takes the slot back if it does not.
//
// It has to stay comfortably below startTimeout, because that is what makes
// the repair invisible: a flue open that arrives inside the window finds no
// record, starts a daemon that cannot bind, and then waits startTimeout for
// one to appear — during which this fires and the record comes back, so the
// wait loop finds it and the invocation succeeds normally instead of failing.
const reassertInterval = 2 * time.Second

// holdRuntime keeps this daemon's runtime record in place for as long as it
// is serving.
//
// runtime.json is a single slot in a design that permits more than one daemon,
// so a daemon can be orphaned from its own record without anything going
// wrong: start a second one on another port (flue serve --port 7718), stop it,
// and its correct, PID-guarded ClearRuntime removes the record that by then
// describes it — leaving the first daemon alive, serving, and nameless. No
// crash and no adversary is needed to reach that, and it does not heal on its
// own: every later flue open starts a daemon that cannot bind, waits out the
// timeout, and refuses, until the user kills a daemon that was working fine.
//
// The daemon is the right place to fix it, because it is the one process that
// can prove it owns the port. Re-asserting here means flue open never has to
// adopt an unidentified listener to recover, so the identity check stays
// exactly as strict as it was.
func holdRuntime(ctx context.Context, port int, every time.Duration) {
	ticker := time.NewTicker(every)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			reassertRuntime(port)
		}
	}
}

// reassertRuntime takes the runtime slot back if no live process holds it.
func reassertRuntime(port int) {
	if _, pid, ok := daemon.ReadRuntimeRecord(); ok && ownedByUs(pid) {
		// Some live process of this user's owns the slot — this daemon, or
		// another one that is also up. Leave it alone. Two daemons each
		// overwriting the other's record every tick would leave flue open
		// landing on a different one every time it looked; last writer wins
		// is at least stable, and this is what keeps it stable.
		return
	}
	_ = daemon.WriteRuntime(port)
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

	// Ask the daemon for a one-time token to put in the URL. The session
	// token itself never goes into a URL: a URL is argv the moment it reaches
	// open(1) or xdg-open(1), and argv is readable by any local user at
	// Linux's default hidepid=0 and by ps(1) on macOS — so the permanent
	// credential would be exposed for the life of the launch.
	//
	// This is also where a token the running daemon will not accept is
	// caught, which happens for real: config discards and regenerates a token
	// file whose mode has been loosened, so a backup or sync tool touching the
	// file leaves an already-running daemon holding a token nobody on disk has
	// any more. Every failure here is fatal, unlike the old advisory
	// pre-flight: without a handoff token there is no URL to open, and there
	// is deliberately no fallback that would put the session token back into
	// argv.
	handoff, err := mintHandoff(port, token)
	if err != nil {
		return err
	}

	target := openURL(port, handoff, cwd)

	// Print the origin rather than the target. The target carries a live
	// credential, and printing it would write a secret into terminal
	// scrollback for no benefit: by the time anyone read the line the browser
	// would already have spent it.
	fmt.Printf("http://127.0.0.1:%d/\n", port)

	if err := openBrowser(target); err != nil {
		// Nothing else can get the user in from here, so the fallback is worth
		// its cost: a token that dies in HandoffTTL, in this user's own
		// terminal, only when the launch has already failed.
		return fmt.Errorf("%w\nopen this within %s to get in:\n%s", err, local.HandoffTTL, target)
	}
	return nil
}

// maxMintBytes bounds the mint response this CLI will parse. The daemon has
// been identified by ourDaemon, so this is a backstop against a wedged daemon,
// not against a hostile one.
const maxMintBytes = 64 << 10

// mintHandoff asks the running daemon for a one-time handoff token.
//
// The session token travels in a request header, not in the URL and not in a
// cookie. Not the URL because that is the exposure this whole mechanism
// removes; not a cookie because a browser attaches cookies by itself and
// SameSite is blind to the port, so a co-resident untrusted origin on another
// loopback port can cause the victim's browser to send one — a credential the
// browser volunteers must never be enough to mint a fresh one. A custom header
// is the carrier no browser can be induced to send cross-origin, because the
// CORS preflight it would need is answered 405.
func mintHandoff(port int, token string) (string, error) {
	u := &url.URL{
		Scheme: "http",
		Host:   fmt.Sprintf("127.0.0.1:%d", port),
		Path:   daemon.MintPath,
	}
	req, err := http.NewRequest(http.MethodPost, u.String(), nil)
	if err != nil {
		return "", err
	}
	req.Header.Set(local.HeaderName, token)

	resp, err := probeClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("ask the daemon on 127.0.0.1:%d for a handoff token: %w", port, err)
	}
	defer resp.Body.Close()

	// The daemon answers a failed check with a plain-text body, so status has
	// to be checked before decoding.
	switch resp.StatusCode {
	case http.StatusOK:
	case http.StatusUnauthorized:
		return "", errTokenRejected
	default:
		return "", fmt.Errorf("daemon on 127.0.0.1:%d answered %s when asked for a handoff token", port, resp.Status)
	}

	var body struct {
		Handoff string `json:"handoff"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, maxMintBytes)).Decode(&body); err != nil {
		return "", fmt.Errorf("decode handoff token: %w", err)
	}
	if body.Handoff == "" {
		return "", fmt.Errorf("daemon on 127.0.0.1:%d returned an empty handoff token", port)
	}
	// Last line of defence, and cheap. Everything in this file is arranged so
	// the session token never reaches a command line; if the peer ever answers
	// with the token it was given — a daemon bug, or an impostor that got past
	// ourDaemon — refusing here is what stops the CLI from carrying it the rest
	// of the way itself.
	if body.Handoff == token {
		return "", fmt.Errorf("daemon on 127.0.0.1:%d returned the session token as a handoff token; refusing to put it in a URL", port)
	}
	return body.Handoff, nil
}

// openURL builds the URL flue open hands to the browser. It carries a one-time
// handoff token, never the session token.
//
// cwd is an arbitrary filesystem path, not a token drawn from a known-safe
// alphabet, so it goes through url.Values rather than fmt.Sprintf: a path
// containing "&", "#", "%", or "+" formatted straight into a query string
// would either break the URL outright or let a directory name inject
// additional query parameters (an "h=" among them) that were never meant to
// be there.
func openURL(port int, handoff, cwd string) string {
	u := &url.URL{
		Scheme: "http",
		Host:   fmt.Sprintf("127.0.0.1:%d", port),
		Path:   "/",
	}
	q := u.Query()
	q.Set(local.HandoffParam, handoff)
	// An empty cwd is omitted rather than emitted as "cwd=". flue serve's
	// banner has no directory to offer — it is a bookmark-shaped entry point,
	// like a typed URL — and a blank parameter would be one more thing the app
	// has to distinguish from "absent".
	if cwd != "" {
		q.Set("cwd", cwd)
	}
	u.RawQuery = q.Encode()
	return u.String()
}

func cmdStatus() error {
	return statusTo(os.Stdout)
}

// statusTo writes the status report. The first line is always the version —
// "dev" from source, the release version when stamped — because status is
// the CLI's only diagnostics surface and there is deliberately no version
// subcommand to put it on. The writer is the seam — same pattern as
// loadToken and openBrowser — so the test reads the report without
// capturing os.Stdout.
func statusTo(w io.Writer) error {
	fmt.Fprintf(w, "version:  %s\n", version)
	if mgr, err := newServiceManager(); err == nil {
		fmt.Fprintln(w, serviceLine(mgr))
	}
	// Before the daemon lines, because the two branches below both return: a
	// relay line that only appeared for a running daemon would be missing from
	// exactly the report somebody is reading to find out why nothing works.
	fmt.Fprintln(w, relayLine())
	recorded, _, ok := daemon.ReadRuntimeRecord()
	if !ok {
		fmt.Fprintln(w, "daemon:   not running")
		return nil
	}
	// A record naming a process that is gone, or one this user cannot signal,
	// is as stale as a record naming a port nothing answers on: either way
	// the daemon it describes is not this user's to talk to.
	port, ok := ourDaemon()
	if !ok {
		fmt.Fprintf(w, "daemon:   not running (stale runtime record for port %d)\n", recorded)
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

	fmt.Fprintf(w, "daemon:   running on 127.0.0.1:%d\n", port)
	fmt.Fprintf(w, "sessions: %d\n", len(infos))
	for _, s := range infos {
		fmt.Fprintf(w, "  %s  %-8s %s\n", s.ID, s.State, s.Cwd)
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
// A record with no PID is not an ownership claim that succeeds by default: it
// is a record that cannot answer the question, and answering "yes" to it would
// silently degrade ourDaemon back to a probe-only check — the exact hole the
// PID exists to close — with nothing to notice it had happened. Nothing flue
// writes omits the PID, so this only fires on a hand-edited or future record,
// which is precisely when failing closed is worth its cost: one spurious
// "not running", recovered by starting a daemon.
//
// A PID below zero never reaches the syscall at all. kill(2) reads a negative
// PID as a process group and -1 as every process it can reach; neither is an
// ownership question.
func ownedByUs(pid int) bool {
	if pid < 1 {
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
//
// The token goes in a header. The daemon no longer accepts it from a URL at
// all — see local.Auth.validToken — and this is also the carrier that keeps it
// out of anything that records URLs.
func fetchSessions(port int, token string) ([]session.Info, error) {
	u := &url.URL{
		Scheme: "http",
		Host:   fmt.Sprintf("127.0.0.1:%d", port),
		Path:   "/api/sessions",
	}
	req, err := http.NewRequest(http.MethodGet, u.String(), nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set(local.HeaderName, token)
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

// openBrowser is a package variable so a test can observe the exact string
// flue open hands to the browser — which is the only place the "no session
// token in argv" requirement can actually be checked end to end. Same seam
// pattern as spawnDaemon and loadToken, for the same reason.
var openBrowser = launchBrowser

func launchBrowser(url string) error {
	switch runtime.GOOS {
	case "darwin":
		return exec.Command("open", url).Start()
	case "linux":
		return exec.Command("xdg-open", url).Start()
	}
	return fmt.Errorf("cannot open a browser on %s", runtime.GOOS)
}

// uiHandler is the built app, compiled into this binary. It is a function
// rather than a package-level value so the embedded filesystem is walked once
// per daemon rather than once per process — flue open and flue status never
// serve anything.
func uiHandler() http.Handler {
	return web.Handler()
}

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

// relayLine is the relay's line in the status report.
//
// It reports the configuration and stops there. Whether the socket is actually
// up is something only the daemon's own process knows, and it publishes it
// where it is useful — on the welcome, to the UI that draws pairing QRs. This
// CLI would have to open a WebSocket to ask, which is a lot of ceremony for a
// line of text, so it says what it can honestly say from a file on disk.
//
// The URL is printed and the secret never is. A URL is an address; the secret
// is the entire credential for the relay leg, and status output ends up in
// terminals, screenshots and bug reports.
func relayLine() string {
	rc, ok, err := config.LoadRelay()
	switch {
	case err != nil:
		// "unknown", the same word and shape serviceLine uses for the same
		// situation: the question was asked and could not be answered. The
		// error says whether that was an unreadable config directory or a
		// relay.json somebody broke.
		return fmt.Sprintf("relay:    unknown (%v)", err)
	case !ok:
		return "relay:    not configured"
	}

	// A file missing a field is one relay.New refuses, so the daemon never
	// dials it. Reporting that as "configured" would have this report — the one
	// somebody reads to find out why remote access does not work — say that
	// everything is set up. The fields are named; their values never are.
	var missing []string
	if rc.URL == "" {
		missing = append(missing, "no url")
	}
	if rc.Secret == "" {
		missing = append(missing, "no secret")
	}
	if rc.Origin == "" {
		missing = append(missing, "no origin")
	}
	if len(missing) > 0 {
		return fmt.Sprintf("relay:    configured, but incomplete (%s): the daemon will not dial it",
			strings.Join(missing, ", "))
	}

	return fmt.Sprintf("relay:    configured (%s), status unknown from here", rc.URL)
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
