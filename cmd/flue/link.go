package main

import (
	"context"
	"encoding/base64"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/karnstack/flue/internal/config"
	"github.com/karnstack/flue/internal/controlplane"
	"github.com/karnstack/flue/internal/crypto"
)

// `flue link` is the hosted counterpart of `flue relay setup`.
//
// Both end in a relay.json the daemon dials; what differs is who owns the relay
// and therefore what the daemon has to hold. `flue relay setup` deploys a
// Worker into the user's own Cloudflare account and writes the shared secret it
// set on it. `flue link` deploys nothing: it attaches this machine to a flue.sh
// account and writes the *enrollment token* that account handed back — which is
// not what the relay checks. The relay checks a short-lived channel token
// signed with a key held only by the control plane and the relay, and the daemon
// spends its enrollment token on one of those before each dial. A daemon that
// held the signing key could sign a token naming any account on the service; not
// holding it is the point of the whole arrangement.
//
// The handshake is RFC 8628's device authorization, because the situation is
// the one it was written for: a program on a machine that may have no browser
// needs a credential from a service the user is logged into somewhere else. It
// prints a short code, the user types it into app.flue.sh in whatever browser
// they have, and this polls until they do.

const linkUsage = "usage: flue link [--app <origin>] [--label <name>]"

// defaultPollInterval is how long to wait between polls when the control plane
// does not say. It does say (RFC 8628's `interval`, 5 seconds today); this is
// the floor under a response that omitted it.
const defaultPollInterval = 5 * time.Second

// maxPollInterval caps whatever the control plane asks for. A server that said
// "poll in an hour" would otherwise park a command somebody is watching.
const maxPollInterval = 30 * time.Second

// defaultGrantLife bounds the wait when the control plane does not say how long
// its grant lives. The deployed one says 600 seconds.
const defaultGrantLife = 10 * time.Minute

// fallbackLabel is what a machine calls itself when it cannot ask the operating
// system for a hostname. Something has to go in the device directory.
const fallbackLabel = "flue daemon"

// maxUserCodeLen bounds the code this command prints. The deployed control
// plane sends nine characters (XXXX-XXXX); this is a bound on a string chosen
// by whatever answered, not a claim about the format.
const maxUserCodeLen = 32

// deviceIDLen is the width of the identity both sides derive: twelve
// characters of lowercase hex, hex(sha256(publicKey))[:12]. Written out here
// rather than imported from crypto.DeviceID for the same reason
// internal/daemon writes it out — what this file needs is a bound on a string
// that arrived over the network, and a bound that moved with the deriver would
// stop being one.
const deviceIDLen = 12

func cmdLink(args []string) error {
	fs := flag.NewFlagSet("link", flag.ExitOnError)
	origin := fs.String("app", controlplane.DefaultOrigin,
		"the flue.sh control plane to link this machine to")
	label := fs.String("label", "",
		"the name this machine appears under (default: its hostname)")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if fs.NArg() > 0 {
		return fmt.Errorf("unexpected argument %q; %s", fs.Arg(0), linkUsage)
	}
	// Deliberately no --token flag of any kind. The enrollment token is minted
	// by this flow and written to relay.json; there is no path along which a
	// credential could arrive in argv, where every local user can read it.
	return runLink(context.Background(), os.Stdout, &linker{
		api:   &controlplane.Client{Origin: *origin},
		label: *label,
	})
}

// linker is the flow's inputs. The sleep is the seam: waiting out the control
// plane's five-second interval is the one thing in here a test has no reason to
// do, and everything else — the HTTP, the key, the file — is real.
type linker struct {
	api   *controlplane.Client
	label string
	sleep func(ctx context.Context, d time.Duration) error
}

func (l *linker) wait(ctx context.Context, d time.Duration) error {
	if l.sleep != nil {
		return l.sleep(ctx, d)
	}
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-timer.C:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// runLink runs the whole handshake and writes relay.json.
//
// Nothing is written until the very end, and the last thing before the write is
// a *remote* call — minting a channel token with the credential that was just
// handed over. That ordering is the point: it turns "the control plane said
// approved" into "this credential works and here is the relay it names", so a
// relay.json only ever exists for a machine that can actually dial. Everything
// that can fail happens in front of it, and re-running the command is the fix
// for anything that did.
func runLink(ctx context.Context, w io.Writer, l *linker) error {
	// First, and before anything on disk or on the network is touched: a
	// mistyped --app is the one failure that should cost nothing. It also
	// settles the *spelling* of the origin, which matters beyond tidiness —
	// relay.json stores it, and a stored origin that differs from the one the
	// client sends as its `Origin` header is a 403 the next time the daemon
	// needs a token.
	origin, err := controlplane.NormalizeOrigin(l.api.Origin)
	if err != nil {
		return err
	}
	l.api.Origin = origin
	// http:// is accepted because `vite dev` is where this flow gets developed,
	// and refusing it would mean nobody could. It is never *silent*, though: the
	// poll that approves this machine carries its permanent enrollment token
	// back over that connection, and every mint after it sends the token out
	// again. On loopback that is fine; anywhere else it is the credential in
	// plaintext across the network.
	warnIfCleartext(w, "the control plane", origin)

	dir, err := config.Dir()
	if err != nil {
		return fmt.Errorf("locate the config directory: %w", err)
	}
	// The same key the daemon serves with, created here if this is a fresh
	// install. It is what the account will know this machine by — the device id
	// is hex(sha256(key))[:12] on both sides — so enrolling with anything else
	// would register a machine no browser could ever reach.
	key, err := crypto.LoadOrCreateStaticKey(dir)
	if err != nil {
		return fmt.Errorf("load this machine's key: %w", err)
	}
	// Standard base64, padded: the encoding app/src/lib/device-id.ts insists on,
	// and the only spelling of a key the control plane stores.
	publicKey := base64.StdEncoding.EncodeToString(key.Public)

	label := strings.TrimSpace(l.label)
	if label == "" {
		label = hostLabel()
	}

	// Said before the grant is opened, because opening one starts a ten-minute
	// clock and the operator should know what is about to be replaced before
	// they walk to another machine.
	existing, hadRelay, loadErr := config.LoadRelay()
	if loadErr == nil && hadRelay && !existing.Hosted() && existing.Secret != "" {
		fmt.Fprintf(w, "  note: this will replace the self-hosted relay in relay.json\n\n")
	}

	grant, err := l.api.StartDeviceAuth(ctx, label, publicKey)
	if err != nil {
		return fmt.Errorf("ask %s to enrol this machine: %w", l.api.Origin, err)
	}

	// The user code and the URL, and nothing else from the grant: the device
	// code beside them is a live bearer credential for as long as the grant is
	// open, and this text goes into terminal scrollback.
	//
	// Both are strings the *remote side* chose, and they are about to be written
	// to a terminal that interprets some bytes rather than drawing them — so
	// both are checked before they are printed. See printableCode and
	// verificationPage.
	userCode, err := printableCode(grant.UserCode)
	if err != nil {
		return err
	}
	page, err := verificationPage(grant.VerificationURL, l.api.Origin)
	if err != nil {
		return err
	}
	fmt.Fprintf(w, "  open %s and enter this code:\n\n      %s\n\n", page, userCode)
	fmt.Fprintf(w, "  waiting for approval…\n")

	poll, err := l.await(ctx, grant)
	if err != nil {
		return err
	}

	// Safe to print unescaped: await refused anything that is not twelve
	// characters of lowercase hex.
	fmt.Fprintf(w, "  ✓ approved — this machine is %s\n", poll.DeviceID)

	// The proof, and the only way to learn where the relay is: neither
	// startDeviceAuth nor pollDeviceAuth names it, and this mint does.
	//
	// It is read exactly once — here — and written into relay.json. The daemon
	// dials what that file says on every reconnect for the rest of its life and
	// never takes the address out of a later mint (see
	// controlplane.DaemonTokens). So a control plane that moves its relay does
	// *not* move its linked machines with it: each one keeps dialling the old
	// address until somebody runs `flue link` again on it. That is a known
	// limitation rather than a decision, and it is the same missing piece as
	// `flue unlink` — both want a command that rewrites relay.json after
	// enrolment, which today only this one does.
	channel, err := l.api.DaemonToken(ctx, poll.DeviceID, poll.DeviceToken)
	if err != nil {
		return fmt.Errorf("this machine was enrolled, but %s would not mint it a relay token: %w",
			l.api.Origin, err)
	}
	dialURL, relayOrigin, err := relayEndpoints(channel.RelayURL)
	if err != nil {
		return fmt.Errorf("%s named a relay this daemon cannot dial: %w", l.api.Origin, err)
	}
	// The relay is the other place a credential goes out: every dial presents a
	// channel token in an Authorization header, over this URL.
	warnIfCleartext(w, "the relay", dialURL)

	// Last, and it replaces the whole file rather than merging into it. A
	// relay.json naming both a self-hosted secret and a flue.sh enrolment is one
	// transport/relay.New refuses outright — there is no honest way to guess
	// which was meant — so a merge would cost remote access entirely.
	if err := config.SaveRelay(config.Relay{
		URL:             dialURL,
		Origin:          relayOrigin,
		ControlPlane:    l.api.Origin,
		DeviceID:        poll.DeviceID,
		EnrollmentToken: poll.DeviceToken,
	}); err != nil {
		return fmt.Errorf("save the relay configuration: %w", err)
	}

	fmt.Fprintf(w, "  ✓ relay: %s\n", dialURL)
	// The closing note names the device list, because that is also where this
	// machine is revoked — and revoking is the thing somebody has to be able to
	// find in a hurry, from a terminal transcript they still have open.
	fmt.Fprintf(w, linkDone, l.api.Origin+"/devices")
	return nil
}

const linkDone = `
linked. restart the daemon (flue disable && flue enable, or restart
flue serve) to connect. manage or revoke this machine at
%s
`

// await polls until the grant is decided, or until it expires.
func (l *linker) await(ctx context.Context, grant controlplane.Grant) (controlplane.Poll, error) {
	interval := time.Duration(grant.Interval) * time.Second
	if interval < time.Second {
		interval = defaultPollInterval
	}
	if interval > maxPollInterval {
		interval = maxPollInterval
	}
	life := time.Duration(grant.ExpiresIn) * time.Second
	if life <= 0 {
		life = defaultGrantLife
	}
	deadline := time.Now().Add(life)

	for {
		// Before the first poll, not after it: nobody has had time to approve
		// anything yet, and the control plane asked for this interval.
		if err := l.wait(ctx, interval); err != nil {
			return controlplane.Poll{}, err
		}

		poll, err := l.api.PollDeviceAuth(ctx, grant.DeviceCode)
		if err != nil {
			// A full bucket or somebody's outage is not a reason to abandon a
			// grant that is still live — the person may be halfway through
			// typing the code. Anything else is about this daemon and will not
			// improve with waiting.
			var refusal *controlplane.Error
			if errors.As(err, &refusal) && refusal.Retryable() && time.Now().Before(deadline) {
				continue
			}
			return controlplane.Poll{}, fmt.Errorf("ask whether this machine was approved: %w", err)
		}

		switch poll.Status {
		case controlplane.StatusPending:
			if time.Now().After(deadline) {
				return controlplane.Poll{}, errors.New("the code expired before anyone approved it; run flue link again")
			}
		case controlplane.StatusApproved:
			// Before the token, because this is the field that outlives the
			// command: it is printed, written into relay.json, and sent as a
			// parameter of every mint the daemon ever makes. A device id is
			// derived from a key on both sides and has exactly one shape, so
			// anything else is a control plane this daemon should not be
			// storing strings from — start over rather than keep it.
			if !validDeviceID(poll.DeviceID) {
				return controlplane.Poll{}, errors.New(
					"the control plane approved this machine under something that is not a device id; run flue link again")
			}
			if poll.DeviceToken == "" {
				// The token exists in exactly one response, ever — the poll
				// that minted the device — and this is that response arriving
				// twice, or the first one having been lost. There is nothing to
				// recover: the grant is spent and its credential is gone.
				return controlplane.Poll{}, errors.New(
					"this machine was approved, but the reply carrying its credential did not arrive; run flue link again to enrol it")
			}
			return poll, nil
		case controlplane.StatusConflict:
			// Same string, same terminal, and this one is interpolated into an
			// error rather than dropped — so a malformed id becomes a blank
			// rather than a reason to lose the message that explains the
			// conflict.
			id := poll.DeviceID
			if !validDeviceID(id) {
				id = "unknown"
			}
			return controlplane.Poll{}, fmt.Errorf(
				"this machine (%s) is already enrolled on another flue.sh account; remove it from that account's device list, then run flue link again",
				id)
		case controlplane.StatusExpired:
			return controlplane.Poll{}, errors.New("the code expired, or was already used; run flue link again")
		default:
			// A control plane newer than this flue. Not something to keep
			// polling about.
			return controlplane.Poll{}, fmt.Errorf("the control plane answered with a status this flue does not understand; upgrade flue and run flue link again")
		}
	}
}

// relayEndpoints turns the relay address the control plane named into the two
// strings the transport needs: what to dial, and the origin browsers reach it
// on.
//
// The control plane's RELAY_URL is the socket address (`wss://relay.flue.sh`)
// because that is what its other consumers need, and it names the host without
// a path. Both edits here are the same ones app/src/server/devices.ts makes for
// the browser, in the other direction: swap the scheme for the origin, and give
// the dial the daemon leg's path.
//
// Tolerant about which of the two schemes arrives and about a path that is
// already there, because a control plane is entitled to name either — and
// intolerant about anything else, since a relay address that is not one is a
// misconfiguration to report rather than to guess at.
func relayEndpoints(raw string) (dialURL, origin string, err error) {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil {
		return "", "", fmt.Errorf("%q is not a URL: %w", raw, err)
	}
	var socketScheme, originScheme string
	switch u.Scheme {
	case "wss", "https":
		socketScheme, originScheme = "wss", "https"
	case "ws", "http":
		socketScheme, originScheme = "ws", "http"
	default:
		return "", "", fmt.Errorf("%q is not a relay address", raw)
	}
	if u.Host == "" {
		return "", "", fmt.Errorf("%q names no host", raw)
	}
	path := strings.TrimSuffix(u.Path, "/")
	if path == "" {
		path = "/daemon"
	}
	return socketScheme + "://" + u.Host + path, originScheme + "://" + u.Host, nil
}

// validDeviceID reports whether id has the one shape a device identity has:
// twelve characters of lowercase hex.
//
// Both sides derive it from the machine's public key — hex(sha256(key))[:12] in
// crypto.DeviceID and in app/src/lib/device-id.ts — so this is not a guess about
// a format, it is the format. What makes it worth checking is where the string
// goes: into a terminal, into relay.json, and into the body of every token
// request this machine makes for as long as it is enrolled.
func validDeviceID(id string) bool {
	if len(id) != deviceIDLen {
		return false
	}
	for _, r := range id {
		if (r < '0' || r > '9') && (r < 'a' || r > 'f') {
			return false
		}
	}
	return true
}

// printableCode is the user code, checked before it reaches a terminal.
//
// A terminal does not draw every byte it is given: a carriage return rewrites
// the line above, and an ESC moves the cursor, repaints, retitles the window,
// or on some emulators answers back. The string being checked was chosen by
// whatever answered the start call, which is the definition of somewhere else,
// and it is printed with no escaping into a session the operator is watching.
//
// The check is "graphic ASCII, and short" rather than the control plane's own
// alphabet on purpose. The alphabet lives in app/ (USER_CODE_ALPHABET), the
// daemon is installed and updated separately, and a client that hard-refused an
// alphabet it had not been told about would be the same drift in the other
// direction — an installed flue that stops working because a server changed a
// constant. Anything a person can read off a screen and type passes; nothing
// that moves a cursor does.
func printableCode(raw string) (string, error) {
	if raw == "" {
		return "", errors.New("the control plane opened a grant with no code for the operator to type; run flue link again")
	}
	if len(raw) > maxUserCodeLen {
		return "", errors.New("the control plane answered with a user code far longer than one; not printing it")
	}
	for _, r := range raw {
		// '!' through '~': printable ASCII with no space, which is every
		// character a code has ever been made of and no character a terminal
		// acts on.
		if r < '!' || r > '~' {
			return "", errors.New("the control plane answered with a user code that is not printable text; not printing it")
		}
	}
	return raw, nil
}

// verificationPage is where the operator is told to go, checked against the
// control plane they asked for.
//
// The app builds this URL from the request's own origin (`new URL('/enroll',
// requestOrigin())`), so on a control plane that is behaving it is always the
// origin this command was pointed at — which makes same-origin a condition that
// costs a correct server nothing and catches the case worth catching: a URL that
// walks the operator somewhere else to "approve" a link. url.Parse refuses a raw
// string containing control bytes outright, and String() re-escapes what it
// parsed, so the printed result is ASCII this terminal will only draw.
//
// The refusal deliberately does not quote what arrived — printing it is the
// thing being avoided.
func verificationPage(raw, origin string) (string, error) {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || u.Scheme == "" || u.Host == "" {
		return "", fmt.Errorf("%s answered with a verification page that is not a URL; run flue link again", origin)
	}
	if u.Scheme+"://"+u.Host != origin {
		return "", fmt.Errorf(
			"%s wants this machine approved on a different site; not sending you there — run flue link again, and check --app",
			origin)
	}
	return u.String(), nil
}

// warnIfCleartext says out loud when a credential is about to cross a link
// nothing encrypts.
//
// http:// and ws:// are accepted everywhere in this flow because a developer
// pointing a daemon at `vite dev` and a local relay is the ordinary way this
// gets worked on. What must not happen is the same thing quietly: the enrollment
// token comes back over the control-plane connection and the channel token goes
// out over the relay one, so on anything but loopback this is the machine's
// credentials in plaintext to everyone on the path.
func warnIfCleartext(w io.Writer, what, addr string) {
	if !strings.HasPrefix(addr, "http://") && !strings.HasPrefix(addr, "ws://") {
		return
	}
	fmt.Fprintf(w, "  warning: %s (%s) is not encrypted — this machine's credentials will travel in cleartext; fine on localhost, unsafe over a network\n\n", what, addr)
}

// hostLabel is what this machine calls itself in somebody's device list.
func hostLabel() string {
	if name, err := os.Hostname(); err == nil && strings.TrimSpace(name) != "" {
		return name
	}
	return fallbackLabel
}
