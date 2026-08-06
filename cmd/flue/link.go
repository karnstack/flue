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
	fmt.Fprintf(w, "  open %s and enter this code:\n\n      %s\n\n",
		grant.VerificationURL, grant.UserCode)
	fmt.Fprintf(w, "  waiting for approval…\n")

	poll, err := l.await(ctx, grant)
	if err != nil {
		return err
	}

	fmt.Fprintf(w, "  ✓ approved — this machine is %s\n", poll.DeviceID)

	// The proof, and the only way to learn where the relay is: the control
	// plane names it with every token it signs, so a service that moves its
	// relay moves its daemons with it rather than needing every relay.json
	// rewritten by hand.
	channel, err := l.api.DaemonToken(ctx, poll.DeviceID, poll.DeviceToken)
	if err != nil {
		return fmt.Errorf("this machine was enrolled, but %s would not mint it a relay token: %w",
			l.api.Origin, err)
	}
	dialURL, relayOrigin, err := relayEndpoints(channel.RelayURL)
	if err != nil {
		return fmt.Errorf("%s named a relay this daemon cannot dial: %w", l.api.Origin, err)
	}

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
			return controlplane.Poll{}, fmt.Errorf(
				"this machine (%s) is already enrolled on another flue.sh account; remove it from that account's device list, then run flue link again",
				poll.DeviceID)
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

// hostLabel is what this machine calls itself in somebody's device list.
func hostLabel() string {
	if name, err := os.Hostname(); err == nil && strings.TrimSpace(name) != "" {
		return name
	}
	return fallbackLabel
}
