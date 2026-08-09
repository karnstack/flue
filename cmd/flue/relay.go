package main

import (
	"bufio"
	"context"
	"crypto/rand"
	"errors"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/karnstack/flue/internal/cloudflare"
	"github.com/karnstack/flue/internal/config"
	"github.com/karnstack/flue/internal/daemon"
	"github.com/karnstack/flue/internal/relaydeploy"
	relaybundle "github.com/karnstack/flue/relay"
	"github.com/karnstack/flue/web"
)

// The deploy's shape lives in internal/relaydeploy — the daemon's /api/relay
// endpoints share it, and sharing is what keeps a UI deploy and a CLI deploy
// the same deploy. These names remain for this package's tests and prose.
const (
	relayScriptName        = relaydeploy.DefaultWorker
	relayCompatibilityDate = relaydeploy.CompatibilityDate
	relayDOClass           = relaydeploy.DOClass
	relayDOBinding         = relaydeploy.DOBinding
	relayAssetsBinding     = relaydeploy.AssetsBinding
)

var relayRunWorkerFirst = relaydeploy.RunWorkerFirst

// relayAssetHeaders is the `_headers` document the relay serves its static
// assets with — the same security headers the daemon wraps its own responses in
// (internal/daemon.securityHeaders), so the one origin of the two that is
// reachable from the internet is not the one without them.
//
// `daemon.RelayCSP` rather than the daemon's own policy: the loopback WebSocket
// entries in `connect-src` are wildcard ports and mean nothing on an https
// origin whose socket is same-origin `wss://`. The constant says the rest.
//
// It travels in the script upload's metadata, not as a file among the assets.
// Dropping a `_headers` file into the bundle would publish it at `/_headers`
// and change nothing — see cloudflare.assetsConfig.Headers. Its twin for
// `wrangler dev` is relay/public/_headers, which is a real file because that is
// the only form wrangler reads; TestRelayAssetHeadersMatchTheWranglerCopy keeps
// the two identical.
var relayAssetHeaders = "/*\n" +
	"  Referrer-Policy: no-referrer\n" +
	"  Content-Security-Policy: " + daemon.RelayCSP + "\n"

const (
	daemonSecretName   = relaydeploy.SecretName
	relayStepTimeout   = relaydeploy.StepTimeout
	relayDeployTimeout = relaydeploy.DeployTimeout
)

// accountPromptAttempts is how many times setup will re-ask which account to
// deploy into before giving up. Re-asking is worth it — a typo should not cost
// a re-run — but it must terminate on input that is never going to become a
// number, and EOF alone is not enough of a guarantee to rely on.
const accountPromptAttempts = 3

const relayUsage = "usage: flue relay <setup|join|status|update|address>"

func cmdRelay(args []string) error {
	if len(args) == 0 {
		return errors.New(relayUsage)
	}
	switch args[0] {
	case "setup":
		// A fresh client with no token: runRelaySetup is what puts the pasted
		// one on it, and it goes no further than this process.
		return runRelaySetup(os.Stdout, os.Stdin, &cloudflare.Client{}, args[1:])
	case "join":
		return runRelayJoin(os.Stdout, args[1:])
	case "status":
		return runRelayStatus(os.Stdout)
	case "update":
		return runRelayUpdate(os.Stdout, os.Stdin, &cloudflare.Client{}, args[1:])
	case "address":
		return runRelayAddress(os.Stdout, args[1:])
	default:
		return fmt.Errorf("unknown relay subcommand %q; %s", args[0], relayUsage)
	}
}

const relayAddressUsage = "usage: flue relay address <wss://relay.example.com>"

// runRelayAddress points this machine's relay config at a different hostname
// for the same Worker — the custom-domain move: the user routes a domain to
// the Worker in the Cloudflare dashboard, then tells flue the new name here.
// Only the URL and origin change; the worker, the secret and this machine's
// id are exactly what they were, because the Worker behind the name is.
//
// What does not survive the move is any existing pairing. A pairing is pinned
// to the origin the browser performed it on, and the daemon refuses channels
// and pairing requests announced on any origin it did not dial
// (internal/transport/relay/channel.go) — a security property, not a config
// gap, so it holds against the old origin too, even while workers.dev still
// routes. Every paired browser opens the new address and pairs afresh; its
// keys and records live per origin in the browser anyway, and no amount of
// daemon config can move them. relayAddressDone says so out loud, and
// docs/RELAY.md's custom-domain section says why.
func runRelayAddress(w io.Writer, args []string) error {
	if len(args) != 1 {
		return errors.New(relayAddressUsage)
	}
	host, err := relayHost(args[0])
	if err != nil {
		return err
	}
	cfg, ok, err := config.LoadRelay()
	if err != nil {
		return err
	}
	if !ok {
		return errors.New("no relay is configured on this machine; `flue relay setup` deploys one first")
	}
	cfg.URL = "wss://" + host
	cfg.Origin = "https://" + host
	if err := config.SaveRelay(cfg); err != nil {
		return fmt.Errorf("save the relay configuration: %w", err)
	}
	fmt.Fprintf(w, "  ✓ relay address is now wss://%s\n", host)
	fmt.Fprint(w, relayAddressDone)
	return nil
}

// relayAddressDone is relayJoinDone's restart note plus the one consequence
// the ✓ line does not carry: the daemon serves exactly the origin it dials,
// so every browser paired on the old one is refused from here on — a tab
// left there reconnects forever — and each must pair again on the new
// address. Said here because nothing else will say it: the old origin keeps
// routing, so the stranding looks like a network fault, not a config change.
const relayAddressDone = `
relay address changed. restart the daemon (flue disable && flue enable, or
restart flue serve) to dial it. every browser paired on the old origin must
open the new address and pair again — pairings are pinned to the origin
they were made on, and a tab on the old one will only ever reconnect.
`

const relaySetupUsage = "usage: flue relay setup [--worker <name>]"

// parseWorkerName validates a Cloudflare script name for the --worker flag;
// the grammar itself lives beside the deploy (relaydeploy.ValidWorkerName).
func parseWorkerName(name string) (string, error) {
	if err := relaydeploy.ValidWorkerName(name); err != nil {
		return "", fmt.Errorf("--worker: %w", err)
	}
	return name, nil
}

// relayTokenPrompt is what setup says before it asks for a credential. It names
// the exact template to use, because "Edit Cloudflare Workers" is a preset on
// the token page and the alternative is a user hand-picking permissions and
// meeting the gaps one failed step at a time.
const relayTokenPrompt = `flue needs a Cloudflare API token to deploy your relay.
Create one at https://dash.cloudflare.com/profile/api-tokens with the
"Edit Cloudflare Workers" template, then paste it here.
Token: `

// relaySetupDone is the closing note. It says where the token went because
// that is the one thing a user cannot check for themselves: stored, in one
// 0600 file, so `flue relay update` and the Remote screen's update button
// need no re-paste — and deleting that file is the whole undo.
const relaySetupDone = `
relay configured. restart the daemon (flue disable && flue enable, or
restart flue serve) to connect. the token is stored in cloudflare.json
(0600, beside relay.json) so updates need no re-paste; delete that file to
forget it.
`

// runRelaySetup deploys the relay Worker and the web app into the user's own
// Cloudflare account, then writes the relay.json the daemon dials.
//
// The writer and reader are the seam: tests drive the whole flow against a fake
// API with the token arriving on a pipe, which is the only place the "the token
// is never echoed and never persisted" requirement can be checked end to end.
// api arrives without a token and leaves with one — it is a local value, and
// the token's entire lifetime is this function call.
//
// Note on echo: the token is read from stdin without switching the terminal out
// of canonical mode, so a pasted token is visible in the user's own scrollback
// the way any pasted line is. Suppressing that needs a termios dance (or
// golang.org/x/term, a dependency flue does not carry) and would buy little:
// the exposure is the user's own screen, which they can clear, and the token
// they were told to delete afterwards anyway. What this function guarantees is
// narrower and more useful: flue itself never writes it — not to the transcript,
// not into an error, not to any file.
func runRelaySetup(w io.Writer, r io.Reader, api *cloudflare.Client, args []string) error {
	fs := flag.NewFlagSet("relay setup", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	workerFlag := fs.String("worker", relayScriptName, "the Cloudflare Worker name to deploy under")
	if err := fs.Parse(args); err != nil {
		return fmt.Errorf("%w; %s", err, relaySetupUsage)
	}
	if fs.NArg() != 0 {
		return fmt.Errorf("unexpected argument %q; %s", fs.Arg(0), relaySetupUsage)
	}
	worker, err := parseWorkerName(*workerFlag)
	if err != nil {
		return err
	}

	// Both of these are checked before a credential is asked for. A binary that
	// cannot deploy anything must not be the reason a user pastes an API token
	// into a terminal. The hostname is read here for the same reason: it is
	// this machine's name and id on the relay, and its one failure mode
	// belongs before the token prompt, not after the deploy.
	module := relaybundle.Module()
	if len(module) == 0 {
		return errors.New("this build carries no relay worker; build a release binary with `make build` (a dev build leaves it out)")
	}
	assets, err := webAssets()
	if err != nil {
		return err
	}
	hostname, err := os.Hostname()
	if err != nil {
		return fmt.Errorf("read this machine's hostname: %w", err)
	}

	in := bufio.NewReader(r)
	token, fromPrompt, err := tokenForCLI(w, in)
	if err != nil {
		return err
	}
	api.Token = token

	if err := withTimeout(relayStepTimeout, api.VerifyToken); err != nil {
		return err
	}
	fmt.Fprintln(w, "  ✓ token verified")

	var accounts []cloudflare.Account
	if err := withTimeout(relayStepTimeout, func(ctx context.Context) error {
		var err error
		accounts, err = api.Accounts(ctx)
		return err
	}); err != nil {
		return fmt.Errorf("list the Cloudflare accounts this token can reach: %w", err)
	}
	account, err := pickAccountPreferring(w, in, accounts, storedAccountID())
	if err != nil {
		return err
	}
	fmt.Fprintf(w, "  ✓ account: %s (%s)\n", account.Name, shortID(account.ID))

	// The choreography — deploy, workers.dev host, fresh secret, in that
	// order and with those orderings' reasons — lives in relaydeploy.Provision;
	// what stays here is the terminal: the ✓ lines, and everything after the
	// Cloudflare part is done.
	host, secret, err := relaydeploy.Provision(relaydeploy.Input{
		API:          api,
		AccountID:    account.ID,
		Worker:       worker,
		Module:       module,
		Assets:       assets,
		AssetHeaders: relayAssetHeaders,
		Version:      deployStamp(),
		OnStep:       func(line string) { fmt.Fprintf(w, "  ✓ %s\n", line) },
	})
	if err != nil {
		return err
	}
	origin := "https://" + host

	// This machine's identity on the relay: the id is the slot it dials
	// (/daemon/<id>) and the name is its human label. Minted fresh on every
	// run like the secret — setup is the recovery path, and a stale id would
	// resurrect whatever state the old hub was left holding. Minted under the
	// fresh secret, necessarily: the id carries a MAC tag the Worker verifies
	// against DAEMON_SECRET before routing (config.MachineIDTag), so an id and
	// the secret it was minted under can only ever travel together.
	machineID := config.MintMachineID(hostname, secret, rand.Reader)
	machineName := truncateRunes(hostname, machineNameMaxRunes)

	// Last, deliberately. relay.json is what makes the daemon dial, and every
	// step above can fail; writing it earlier would leave a daemon dialling a
	// relay that was never finished. Re-running setup is the fix for anything
	// that failed before this line, and it is safe: the deploy and the secret
	// are both upserts, and the deploy keeps the secret already bound to the
	// Worker (see keptBindingTypes in internal/cloudflare), so a run that dies
	// part-way leaves an existing relay working rather than credential-less.
	//
	// The URL is the bare host: the transport appends /daemon/<machine id>
	// itself, so the file cannot hold a path that disagrees with the id
	// beside it.
	if err := config.SaveRelay(config.Relay{
		URL:         "wss://" + host,
		Secret:      secret,
		Origin:      origin,
		MachineID:   machineID,
		MachineName: machineName,
		Worker:      worker,
	}); err != nil {
		return fmt.Errorf("save the relay configuration: %w", err)
	}
	fmt.Fprintf(w, "  ✓ this machine joined as %s (%s)\n", machineName, machineID)

	if fromPrompt {
		// Stored by product decision, 0600 beside relay.json: the next
		// update — CLI or Remote screen — needs no re-paste, and the UI can
		// name the account the relay lives in. Failing to store fails
		// nothing else.
		if err := config.SaveCloudflare(config.Cloudflare{Token: token, AccountID: account.ID, AccountName: account.Name}); err != nil {
			fmt.Fprintf(w, "  could not store the token: %v\n", err)
		} else {
			fmt.Fprintln(w, "  ✓ token stored for one-click updates")
		}
	}

	// The one line another machine needs, exactly as it should be run there.
	// It carries the secret — that is the point: the relay is shared by
	// machines that share it, and this is the deliberate hand-off, printed
	// once at the moment the user is wiring their fleet up.
	fmt.Fprintf(w, "\nto add another machine, run this on it:\n\n  flue relay join wss://%s --secret %s\n", host, secret)

	fmt.Fprint(w, relaySetupDone)
	return nil
}

// machineNameMaxRunes bounds a machine's display name. It is free text for
// humans — never part of a URL — so the only limit it needs is one that keeps
// a machine list rendering as a list.
const machineNameMaxRunes = 64

const relayJoinUsage = "usage: flue relay join <url> --secret <secret> [--name <label>]"

// relayJoinDone mirrors relaySetupDone's restart note without the token line:
// join never saw a Cloudflare credential, so there is nothing to tell the user
// to delete.
const relayJoinDone = `
relay configured. restart the daemon (flue disable && flue enable, or
restart flue serve) to connect.
`

// runRelayJoin points this machine at a relay another machine already
// deployed: the line setup printed there, run here.
//
// No Cloudflare API, no token — the Worker exists and the secret is the whole
// credential. Everything join does is local: validate the address, mint this
// machine a fresh id, and write relay.json. Which is why its failures name the
// argument at fault — the command arrives pasted across machines, and a lost
// flag or a stale path is the ordinary mistake.
func runRelayJoin(w io.Writer, args []string) error {
	if len(args) == 0 || strings.HasPrefix(args[0], "-") {
		return errors.New("no relay url was given; " + relayJoinUsage)
	}
	rawURL := args[0]

	fs := flag.NewFlagSet("relay join", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	secret := fs.String("secret", "", "the relay's daemon secret, from flue relay setup")
	name := fs.String("name", "", "a display name for this machine (defaults to the hostname)")
	if err := fs.Parse(args[1:]); err != nil {
		return fmt.Errorf("%w; %s", err, relayJoinUsage)
	}
	if fs.NArg() != 0 {
		return fmt.Errorf("unexpected argument %q; %s", fs.Arg(0), relayJoinUsage)
	}
	if *secret == "" {
		return errors.New("no --secret was given; " + relayJoinUsage)
	}
	if utf8.RuneCountInString(*name) > machineNameMaxRunes {
		return fmt.Errorf("--name is longer than %d characters", machineNameMaxRunes)
	}

	host, err := relayHost(rawURL)
	if err != nil {
		return err
	}

	hostname, err := os.Hostname()
	if err != nil {
		return fmt.Errorf("read this machine's hostname: %w", err)
	}
	machineName := *name
	if machineName == "" {
		machineName = truncateRunes(hostname, machineNameMaxRunes)
	}
	// Minted under the secret from the join line: the id's MAC tag is what the
	// Worker checks before routing (config.MachineIDTag), so a join pasted
	// with the wrong secret produces an id the relay 404s — the same failure
	// the daemon leg's 401 reports, found one dial later.
	machineID := config.MintMachineID(hostname, *secret, rand.Reader)

	// The same shape setup writes, derived the same way: bare wss:// URL, the
	// https origin on the same host. SaveRelay is 0600 — the file holds the
	// relay's whole credential.
	if err := config.SaveRelay(config.Relay{
		URL:         "wss://" + host,
		Secret:      *secret,
		Origin:      "https://" + host,
		MachineID:   machineID,
		MachineName: machineName,
	}); err != nil {
		return fmt.Errorf("save the relay configuration: %w", err)
	}

	fmt.Fprintf(w, "  ✓ this machine joined wss://%s as %s (%s)\n", host, machineName, machineID)
	fmt.Fprint(w, relayJoinDone)
	return nil
}

// relayHost is the host a pasted relay address names, however the user came by
// it: the wss:// url setup prints, or the https:// origin they can read off a
// browser's address bar — the two name the same Worker, and refusing the one a
// user can see would be pedantry. Anything else is refused by name, including
// a path: the old relay.json format kept /daemon on the URL, and silently
// accepting one here would hide that the contract changed.
//
// Lowercased on the way out, because DNS does not care about case and the
// daemon does: the origin derived from this host is compared byte for byte
// against the one the relay announces on every channel open
// (internal/transport/relay/channel.go), so a hand-typed WSS://RELAY.EXAMPLE
// saved verbatim would dial fine and then have every browser refused as
// arriving on an origin this daemon never dialled.
func relayHost(rawURL string) (string, error) {
	u, err := url.Parse(rawURL)
	if err != nil {
		return "", fmt.Errorf("the relay url could not be parsed: %w", err)
	}
	if u.Scheme != "wss" && u.Scheme != "https" {
		return "", fmt.Errorf("the relay url must be wss:// or https://, got %q", rawURL)
	}
	if u.Host == "" {
		return "", fmt.Errorf("the relay url %q names no host; %s", rawURL, relayJoinUsage)
	}
	if (u.Path != "" && u.Path != "/") || u.RawQuery != "" || u.Fragment != "" {
		return "", fmt.Errorf("the relay url carries a path or query it should not (%q); it is just wss://<host>", rawURL)
	}
	return strings.ToLower(u.Host), nil
}

// truncateRunes bounds free text by runes, which is the unit the limit is
// stated in — a hostname can be multibyte, and cutting bytes could leave an
// invalid final rune.
func truncateRunes(s string, n int) string {
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	runes := []rune(s)
	return string(runes[:n])
}

// runRelayStatus prints what is configured, which is the same line flue status
// carries — one answer, one place it is decided.
func runRelayStatus(w io.Writer) error {
	fmt.Fprintln(w, relayLine())
	return nil
}

const relayUpdateUsage = "usage: flue relay update [--worker <name>]"

// relayUpdateDone says the two things a user cannot see from the ✓ lines: what
// deliberately did not change, and that nothing needs restarting. The deploy
// preserves the secret binding (keptBindingTypes in internal/cloudflare), the
// machine ids live in relay.json files this command never touches, and both
// legs redial a replaced Worker on their own.
const relayUpdateDone = `
relay updated. the secret, the machine ids and every pairing are unchanged —
daemons and browsers reconnect on their own.
`

// runRelayUpdate redeploys the Worker and the web bundle this binary carries
// over the relay this machine is joined to, and changes nothing else.
//
// It is the upgrade path: a new flue release carries a new embedded relay, and
// this is how a deployed one catches up without the resets `flue relay setup`
// exists to perform. No secret is minted (the deploy keeps the bound one), no
// machine id is minted, and relay.json is read but never written — so no other
// machine re-joins and no browser re-pairs.
func runRelayUpdate(w io.Writer, r io.Reader, api *cloudflare.Client, args []string) error {
	fs := flag.NewFlagSet("relay update", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	workerFlag := fs.String("worker", "", "the Worker name to redeploy (defaults to the one relay.json records)")
	if err := fs.Parse(args); err != nil {
		return fmt.Errorf("%w; %s", err, relayUpdateUsage)
	}
	if fs.NArg() != 0 {
		return fmt.Errorf("unexpected argument %q; %s", fs.Arg(0), relayUpdateUsage)
	}

	module := relaybundle.Module()
	if len(module) == 0 {
		return errors.New("this build carries no relay worker; build a release binary with `make build` (a dev build leaves it out)")
	}
	assets, err := webAssets()
	if err != nil {
		return err
	}

	cfg, ok, err := config.LoadRelay()
	if err != nil {
		return err
	}
	if !ok {
		return errors.New("no relay is configured on this machine; `flue relay setup` deploys one, `flue relay update` only refreshes it")
	}
	worker, err := updateWorkerName(*workerFlag, cfg)
	if err != nil {
		return err
	}

	in := bufio.NewReader(r)
	token, fromPrompt, err := tokenForCLI(w, in)
	if err != nil {
		return err
	}
	api.Token = token

	if err := withTimeout(relayStepTimeout, api.VerifyToken); err != nil {
		return err
	}
	fmt.Fprintln(w, "  ✓ token verified")

	var accounts []cloudflare.Account
	if err := withTimeout(relayStepTimeout, func(ctx context.Context) error {
		var err error
		accounts, err = api.Accounts(ctx)
		return err
	}); err != nil {
		return fmt.Errorf("list the Cloudflare accounts this token can reach: %w", err)
	}
	account, err := pickAccountPreferring(w, in, accounts, storedAccountID())
	if err != nil {
		return err
	}
	fmt.Fprintf(w, "  ✓ account: %s (%s)\n", account.Name, shortID(account.ID))

	// The same deploy setup performs, to the same script name. An update of a
	// script that does not exist creates it — with no DAEMON_SECRET bound, so
	// the daemon leg would 401 until a real setup runs. That is the one way
	// this command can leave things worse than it found them, and it is only
	// reachable by naming a worker that was never deployed; the name comes
	// from relay.json precisely so that does not happen by accident.
	if err := relaydeploy.Deploy(relaydeploy.Input{
		API:          api,
		AccountID:    account.ID,
		Worker:       worker,
		Module:       module,
		Assets:       assets,
		AssetHeaders: relayAssetHeaders,
		Version:      deployStamp(),
	}); err != nil {
		return err
	}
	fmt.Fprintf(w, "  ✓ worker updated: %s\n", worker)
	fmt.Fprintf(w, "  ✓ web app uploaded (%d files)\n", len(assets))

	if fromPrompt {
		if err := config.SaveCloudflare(config.Cloudflare{Token: token, AccountID: account.ID, AccountName: account.Name}); err != nil {
			fmt.Fprintf(w, "  could not store the token: %v\n", err)
		} else {
			fmt.Fprintln(w, "  ✓ token stored for one-click updates")
		}
	}

	fmt.Fprint(w, relayUpdateDone)
	return nil
}

// updateWorkerName decides which script an update redeploys: the flag when
// given, the name relay.json records otherwise, and — for a relay.json from
// before the field existed, or written by join — the workers.dev host's first
// label, which is the script name by construction. A host that is not
// workers.dev carries no such fact, and guessing a default there could create
// a second, secret-less Worker; that case asks for the flag instead.
func updateWorkerName(flagValue string, cfg config.Relay) (string, error) {
	if flagValue != "" {
		return parseWorkerName(flagValue)
	}
	if cfg.Worker != "" {
		return parseWorkerName(cfg.Worker)
	}
	host := strings.TrimPrefix(cfg.URL, "wss://")
	if label, rest, ok := strings.Cut(host, "."); ok && strings.HasSuffix(rest, ".workers.dev") {
		return parseWorkerName(label)
	}
	return "", fmt.Errorf("relay.json does not record the worker's name and %q is not a workers.dev host; pass --worker <name>", host)
}

// tokenForCLI hands back the stored Cloudflare token when there is one and
// prompts otherwise. fromPrompt reports which; prompted tokens are stored
// after the deploy succeeds, never before.
func tokenForCLI(w io.Writer, in *bufio.Reader) (token string, fromPrompt bool, err error) {
	if cf, ok, _ := config.LoadCloudflare(); ok {
		fmt.Fprintln(w, "  using the stored Cloudflare token (delete cloudflare.json to be asked again)")
		return cf.Token, false, nil
	}
	t, err := readAPIToken(w, in)
	return t, true, err
}

// pickAccountPreferring is pickAccount with a remembered answer: when the
// stored credential's account is among the choices, it is taken silently —
// asking a question whose answer is on disk would be ceremony.
func pickAccountPreferring(w io.Writer, r *bufio.Reader, accounts []cloudflare.Account, preferredID string) (cloudflare.Account, error) {
	if preferredID != "" {
		for _, a := range accounts {
			if a.ID == preferredID {
				return a, nil
			}
		}
	}
	return pickAccount(w, r, accounts)
}

// readAPIToken prompts for and reads the Cloudflare API token.
//
// EOF with content is not an error: a token piped in without a trailing newline
// arrives that way, and refusing it would break every non-interactive use of
// this command for no benefit.
func readAPIToken(w io.Writer, r *bufio.Reader) (string, error) {
	fmt.Fprint(w, relayTokenPrompt)
	line, err := r.ReadString('\n')
	if err != nil && !errors.Is(err, io.EOF) {
		return "", fmt.Errorf("read the API token: %w", err)
	}
	token := strings.TrimSpace(line)
	if token == "" {
		return "", errors.New("no API token was given; nothing was deployed")
	}
	return token, nil
}

// pickAccount decides which account the relay goes into: silently when the
// token can reach exactly one, and by asking otherwise.
//
// It never guesses between several. Deploying a Worker into the wrong account
// is not a mistake this command can undo, and "the first one" is a rule whose
// answer depends on the order Cloudflare happened to list them in.
func pickAccount(w io.Writer, r *bufio.Reader, accounts []cloudflare.Account) (cloudflare.Account, error) {
	switch len(accounts) {
	case 0:
		return cloudflare.Account{}, errors.New("this API token cannot reach any Cloudflare account; check that it was created with the \"Edit Cloudflare Workers\" template on an account you own")
	case 1:
		return accounts[0], nil
	}

	fmt.Fprintln(w, "\nThis token reaches more than one account. Which should the relay live in?")
	for i, a := range accounts {
		fmt.Fprintf(w, "  %d) %s (%s)\n", i+1, a.Name, shortID(a.ID))
	}
	for attempt := 0; attempt < accountPromptAttempts; attempt++ {
		fmt.Fprintf(w, "Account [1-%d]: ", len(accounts))
		line, readErr := r.ReadString('\n')
		if choice, err := strconv.Atoi(strings.TrimSpace(line)); err == nil && choice >= 1 && choice <= len(accounts) {
			return accounts[choice-1], nil
		}
		if readErr != nil {
			// The input is exhausted, so there is nothing left to re-ask into.
			break
		}
		fmt.Fprintln(w, "  that is not one of the numbers above")
	}
	return cloudflare.Account{}, fmt.Errorf("no account was chosen; run flue relay setup again and answer with a number between 1 and %d", len(accounts))
}

// shortID abbreviates an account id for display. The full one is 32 hex
// characters that say nothing to the person reading them; enough to tell two
// accounts apart is all this line is for.
func shortID(id string) string {
	const keep = 6
	if len(id) <= keep {
		return id
	}
	return id[:keep] + "…"
}

// webAssets turns the embedded web app into the asset list the deploy uploads.
// Paths are rooted at "/" because that is what they will be served at, and what
// the upload session requires.
func webAssets() ([]cloudflare.Asset, error) {
	dist, err := web.Dist()
	if err != nil {
		return nil, err
	}
	var assets []cloudflare.Asset
	err = fs.WalkDir(dist, ".", func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			return nil
		}
		// `_headers` and `_redirects` are configuration, not content:
		// Cloudflare's asset router reads them out of the script metadata
		// (relayAssetHeaders) and never from the bundle, so one that reached the
		// upload would be published at its own URL and applied to nothing.
		// Nothing in web/dist emits either today; this is here so that a
		// well-meant web/public/_headers cannot quietly become a public
		// document that also fails to do its job.
		if p == "_headers" || p == "_redirects" {
			return nil
		}
		body, err := fs.ReadFile(dist, p)
		if err != nil {
			return err
		}
		assets = append(assets, cloudflare.Asset{Path: "/" + p, Body: body})
		return nil
	})
	if err != nil {
		return nil, fmt.Errorf("read the embedded web app: %w", err)
	}
	if len(assets) == 0 {
		return nil, errors.New("the embedded web app is empty; rebuild with `make build`")
	}
	return assets, nil
}

// withTimeout runs one API step under a deadline of its own.
func withTimeout(d time.Duration, fn func(context.Context) error) error {
	ctx, cancel := context.WithTimeout(context.Background(), d)
	defer cancel()
	return fn(ctx)
}
