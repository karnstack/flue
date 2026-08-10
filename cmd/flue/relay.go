package main

import (
	"bufio"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/karnstack/flue/internal/cloudflare"
	"github.com/karnstack/flue/internal/config"
	"github.com/karnstack/flue/internal/crypto"
	"github.com/karnstack/flue/internal/daemon"
	"github.com/karnstack/flue/internal/fleet"
	"github.com/karnstack/flue/internal/relaydeploy"
	"github.com/karnstack/flue/internal/transport/local"
	"github.com/karnstack/flue/internal/transport/relay"
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

const relayUsage = "usage: flue relay <setup|join|status|update|address|leave|reset>"

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
	case "leave":
		return runRelayLeave(os.Stdout, os.Stdin, args[1:])
	case "reset":
		return runRelayReset(os.Stdout, os.Stdin, args[1:])
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
	// The loopback tab is repointed too, and it is the one thing here that a
	// user reads as already handled: a browser paired on the old origin is
	// obviously somebody else's machine, while the tab on this one looks like
	// it lives with the daemon. Its policy names the old origin and forbids the
	// new one — see relayReloadNote.
	sayReloadOpenTabs(w, tellTheDaemon(w))
	fmt.Fprint(w, relayAddressDone)
	return nil
}

// relayAddressDone is the one consequence the ✓ lines do not carry, and the
// one thing about this command no restart ever fixed: the daemon serves
// exactly the origin it dials, so every browser paired on the old one is
// refused from here on — a tab left there reconnects forever — and each must
// pair again on the new address. Said here because nothing else will say it:
// the old origin keeps routing, so the stranding looks like a network fault
// rather than a config change.
//
// What used to lead this note was "restart the daemon to dial it". The daemon
// is told directly now (tellTheDaemon), and a restart is named only in the one
// case where the telling failed.
const relayAddressDone = `
every browser paired on the old origin must open the new address and pair
again — pairings are pinned to the origin they were made on, and a tab on
the old one will only ever reconnect.
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
//
// It no longer opens with "restart the daemon to connect", because a daemon
// no longer has to be restarted to connect: tellTheDaemon has already told the
// running one, and the fleet key this setup minted is read from relay.json at
// every signature rather than at boot. Pair a phone in the next breath and it
// gets a certificate for the fleet, which is the whole of what the restart
// used to buy.
const relaySetupDone = `
relay configured. the token is stored in cloudflare.json (0600, beside
relay.json) so updates need no re-paste; delete that file to forget it.
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
		// No tick: a note is something the deploy could not fix, and the same
		// two-space indent every soft failure in this file already wears.
		OnNote: func(line string) { fmt.Fprintf(w, "  %s\n", line) },
	})
	if err != nil {
		return err
	}
	origin := "https://" + host

	// The fleet key, minted beside the fresh secret and — unlike it — never
	// sent anywhere: no binding, no secret upload, no log line
	// (spec/fleet-trust.md). It travels only in relay.json below and in the
	// join line printed at the end, and it is what signs the device certs
	// every machine on this relay honours. Fresh on every setup for the same
	// reason the secret is: setup is the recovery path, and rotating the
	// fleet key is what un-trusts every cert a compromised machine could
	// have signed.
	fleetKey, err := fleet.Mint(rand.Reader)
	if err != nil {
		return err
	}
	fmt.Fprintln(w, "  ✓ fleet key minted (stays on your machines; Cloudflare never sees it)")

	// This machine's identity on the relay: the id is the slot it dials
	// (/daemon/<id>) and the name is its human label. Minted fresh on every
	// run like the secret — setup is the recovery path, and a stale id would
	// resurrect whatever state the old hub was left holding. Minted under the
	// fresh secret, necessarily: the id carries a MAC tag the Worker verifies
	// against DAEMON_SECRET before routing (config.MachineIDTag), so an id and
	// the secret it was minted under can only ever travel together.
	machineID := config.MintMachineID(hostname, secret, rand.Reader)
	machineName := truncateRunes(hostname, machineNameMaxRunes)

	// The machine's own certificate, signed under the fleet key just minted:
	// what the daemon publishes to the relay's fleet directory so every
	// browser in the fleet can reach this machine without pairing to it
	// (spec/fleet-trust.md, "The fleet directory"). Not fatal — a relay whose
	// machines cannot be discovered still carries every device paired
	// directly to them — and the line says which half is missing.
	machineCert, err := mintMachineCert(fleetKey, machineID, machineName)
	if err != nil {
		fmt.Fprintf(w, "  could not mint this machine's fleet certificate (%v); other devices will not discover this machine\n", err)
	}

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
		FleetSeed:   fleetKey.Seed(),
		Origin:      origin,
		MachineID:   machineID,
		MachineName: machineName,
		MachineCert: machineCert,
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

	// The daemon catches up in place, and the browser tab that daemon served
	// before any of this existed does not: it was handed a policy naming no
	// relay, and its fleet enrolment ran and was refused while this machine
	// still had no fleet key. relayReloadNote says so where it can be acted on.
	sayReloadOpenTabs(w, tellTheDaemon(w))

	// The one line another machine needs, exactly as it should be run there,
	// spelled by joinCommand so this print and the Remote screen's copy can
	// never drift. It carries the secret and now the fleet key — that is the
	// point: the relay is shared by machines that share them, and this is
	// the deliberate hand-off, printed once at the moment the user is wiring
	// their fleet up. Its weight changed when the fleet key came aboard:
	// leaking this line used to buy disruption, and now it buys the fleet —
	// docs/RELAY.md says so where it teaches the line.
	fmt.Fprintf(w, "\nto add another machine, run this on it:\n\n  %s\n", joinCommand(host, secret, fleetKey.Seed()))

	fmt.Fprint(w, relaySetupDone)
	return nil
}

// machineNameMaxRunes bounds a machine's display name. It is free text for
// humans — never part of a URL — so the only limit it needs is one that keeps
// a machine list rendering as a list.
const machineNameMaxRunes = 64

// tellTheDaemon hands the running daemon, if there is one, the news that
// relay.json has changed, and prints what it did about it.
//
// This is the other half of "no restarts". Everything the daemon *signs* now
// follows relay.json by itself, read at the moment of signing (fleetOnDisk),
// but a socket is not a file read: a daemon dialling the relay it was
// configured with an hour ago cannot notice a new one, and one dialling
// nothing cannot notice that there is now something to dial. So the command
// that wrote the file knocks on the daemon's loopback door — the same
// identified daemon `flue open` and `flue status` talk to, the same token
// header, a POST with no body — and the daemon replaces its relay leg in
// place (relayUIService.Reload).
//
// It prints and never fails. Every outcome here is either "the daemon caught
// up" or "there is no daemon to catch up", and neither is a reason to fail a
// setup that has already deployed a Worker and written a config. The only case
// that costs the user anything is a daemon that is running and could not be
// reached, which is the one case that still names a restart — the honest
// remainder, rather than the blanket instruction this used to print for
// everyone.
//
// It reports whether a daemon is running at all — told or not, because a
// daemon that could not be told is still a daemon that has served pages. That
// is the question sayReloadOpenTabs needs answered, and asking it twice would
// mean two probes that could disagree.
func tellTheDaemon(w io.Writer) (running bool) {
	port, ok := ourDaemon()
	if !ok {
		// Nothing is running, so nothing is stale: whatever starts next reads
		// the file that is now on disk.
		fmt.Fprintln(w, "  ✓ no daemon is running; the next one to start reads relay.json as it is now")
		return false
	}
	steps, err := reloadRelayLeg(port)
	if err != nil {
		fmt.Fprintf(w, "  ! the daemon on 127.0.0.1:%d could not be told (%v)\n", port, err)
		fmt.Fprintln(w, "    restart it to pick this up: flue disable && flue enable, or restart flue serve")
		return true
	}
	for _, step := range steps {
		fmt.Fprintf(w, "  ✓ %s\n", step)
	}
	return true
}

// relayReloadNote is the one consequence of rewriting relay.json that neither
// this command nor the daemon it just told can repair: a flue tab that was
// already open on this machine when it ran.
//
// A page's Content-Security-Policy is fixed when the daemon serves the
// document, and it names the relay origin relay.json held at that moment
// (internal/daemon.LocalCSPFor). So a tab served before this command carries a
// policy that forbids the relay this machine has now — both
// `wss://<relay>/client/<id>` and the `/directory` read — and no header can be
// changed after the fact, by anything. The tab's fleet enrolment is the same
// story from the other end: it runs once per load (web/src/fleet/enrol.ts),
// and a tab loaded before this machine held a fleet key was answered 409 and
// never asks again. Neither failure announces itself — the directory read
// reports "no machines" for every fault by design — so the tab goes on showing
// a fleet of one and looks perfectly healthy doing it.
//
// A reload is the whole fix and the only one; polling, reconnecting and
// restarting the daemon are not, which is why this is said out loud rather
// than left for the page to sort out. The Remote screen reached the same
// conclusion and offers the button (web/src/components/cloudflare-connect.tsx,
// ReloadAfterDeploy); this is that sentence for a terminal.
//
// No tick, and the two-space indent every note in this file wears: a ✓ is
// something that happened, and this is something the command could not do.
const relayReloadNote = "  reload any flue tab you already have open on this machine\n" +
	"    what a page may connect to is fixed when the daemon serves it, so a tab\n" +
	"    served before this command cannot reach the relay this machine has now —\n" +
	"    nothing it does on its own repairs that, and a reload repairs all of it\n"

// sayReloadOpenTabs prints relayReloadNote when there is a daemon that could
// have served the tab it is about.
//
// With no daemon there is no such tab: this page comes from a daemon on
// loopback and from nowhere else. A tab left over from a daemon that has since
// exited is not the exception it looks like — it is already staring at a dead
// socket, and what it needs is a daemon, not a reload.
//
// It takes the answer rather than asking, because tellTheDaemon has just asked
// and a second probe could come back different.
func sayReloadOpenTabs(w io.Writer, daemonRunning bool) {
	if !daemonRunning {
		return
	}
	fmt.Fprint(w, relayReloadNote)
}

// reloadRelayLeg is the request half of the above: POST RelayReloadPath with
// the session token in the header — never a URL, never a cookie, for the
// reasons mintHandoff spells out — and the steps the daemon answers with.
func reloadRelayLeg(port int) ([]string, error) {
	token, err := loadToken()
	if err != nil {
		return nil, err
	}
	u := &url.URL{
		Scheme: "http",
		Host:   fmt.Sprintf("127.0.0.1:%d", port),
		Path:   daemon.RelayReloadPath,
	}
	req, err := http.NewRequest(http.MethodPost, u.String(), nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set(local.HeaderName, token)
	resp, err := probeClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		// The body is plain text on every refusal this endpoint has, and it
		// carries no credential — but it is the daemon's own words about the
		// user's own machine, so the status alone is what gets reported.
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4<<10))
		return nil, fmt.Errorf("answered %s", resp.Status)
	}
	var body daemon.RelayUIDeployResult
	if err := json.NewDecoder(io.LimitReader(resp.Body, maxMintBytes)).Decode(&body); err != nil {
		return nil, err
	}
	return body.Steps, nil
}

// mintMachineCert signs this machine's fleet machine certificate: the id it
// holds on the relay, its display name, and the Noise static key every device
// that reaches it must pin (spec/fleet-trust.md, Certificates).
//
// It is minted here — in the three commands that write relay.json — rather
// than by the daemon, and the reason is the directory's shape rather than
// convenience. The relay stores blobs by the hash of their own bytes, so a
// cert re-minted at each start would carry a fresh `iat`, land under a fresh
// key, and spend one of the directory's 512 entries every time the daemon
// restarted. Minting it exactly where the facts it asserts are decided means
// one blob, for the life of this machine's place on this relay.
//
// It reads (and, on a machine that has never served, creates) the daemon's
// static key, which is the same key `flue serve` would load a moment later:
// the cert has to name the key devices will actually meet, and a cert naming a
// key that did not exist yet would be a browser pinning nothing.
//
// A failure is returned, not swallowed. Every caller treats it as "this
// machine joins without a machine cert" and says so — the honest half of a
// half-configured relay, exactly as `flue relay setup` already treats a fleet
// key it cannot mint.
func mintMachineCert(key fleet.Key, machineID, machineName string) ([]byte, error) {
	if !key.Valid() {
		return nil, fleet.ErrNoKey
	}
	dir, err := config.Dir()
	if err != nil {
		return nil, fmt.Errorf("locate the config directory: %w", err)
	}
	static, err := crypto.LoadOrCreateStaticKey(dir)
	if err != nil {
		return nil, fmt.Errorf("load the daemon static key: %w", err)
	}
	return key.Sign(fleet.MachineCert{
		ID:    machineID,
		Name:  machineName,
		Noise: static.Public,
		IAT:   time.Now().Unix(),
	})
}

const relayJoinUsage = "usage: flue relay join <url> --secret <secret> --fleet <fleet key> [--name <label>]"

// relayJoinDone mirrors relaySetupDone without the token line: join never saw
// a Cloudflare credential, so there is nothing to tell the user to delete —
// and, like setup, nothing to tell them to restart. The running daemon has
// been told (tellTheDaemon) and signs under the fleet key this join line
// carried from the moment the file was written.
const relayJoinDone = `
relay configured. this machine is on the fleet now: pair a browser here and
it reaches every machine on this relay.
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
	fleetSeed := fs.String("fleet", "", "the fleet key, from flue relay setup")
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
	// Required unconditionally, not "when the relay was set up with one".
	// Join is a local command — it never talks to the relay, so it cannot
	// ask how setup ran — and every setup from this flue on mints a fleet
	// key, so the only line without --fleet is one printed by an older
	// setup, whose relay the compatibility rules retire anyway
	// (spec/fleet-trust.md): its ids stopped routing on the Worker this
	// binary deploys, and the fix is re-running setup, which prints a line
	// this check accepts. One rule, no state to consult, and a lost flag —
	// the ordinary paste accident — is caught here rather than as a daemon
	// that quietly cannot admit its fleet's devices.
	if *fleetSeed == "" {
		return errors.New("no --fleet was given; " + relayJoinUsage)
	}
	fleetKey, err := fleet.Parse(*fleetSeed)
	if err != nil {
		// The parse error says what the value failed to be (base64url, 32
		// bytes) and never echoes it: the seed is the fleet's signing key,
		// and a near-miss paste is close enough to the credential to keep
		// out of the transcript.
		return fmt.Errorf("--fleet: %w", err)
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

	// This machine's certificate under the fleet key that arrived on the join
	// line — the artifact the daemon publishes so the fleet's browsers can
	// find this machine at all (spec/fleet-trust.md, "New machine"). Its
	// absence costs discovery and nothing else, so it is reported rather than
	// fatal: a join that stopped here would leave a machine with no relay
	// config over a convenience.
	machineCert, err := mintMachineCert(fleetKey, machineID, machineName)
	if err != nil {
		fmt.Fprintf(w, "  could not mint this machine's fleet certificate (%v); other devices will not discover this machine\n", err)
	}

	// The same shape setup writes, derived the same way: bare wss:// URL, the
	// https origin on the same host. SaveRelay is 0600 — the file holds the
	// relay's whole credential, the fleet key now included. The seed is
	// stored as the parsed key re-spells it, which for a value that passed
	// fleet.Parse is the input verbatim; going through the round trip means
	// the file can only ever hold a spelling Parse accepts.
	if err := config.SaveRelay(config.Relay{
		URL:         "wss://" + host,
		Secret:      *secret,
		FleetSeed:   fleetKey.Seed(),
		Origin:      "https://" + host,
		MachineID:   machineID,
		MachineName: machineName,
		MachineCert: machineCert,
	}); err != nil {
		return fmt.Errorf("save the relay configuration: %w", err)
	}

	fmt.Fprintf(w, "  ✓ this machine joined wss://%s as %s (%s)\n", host, machineName, machineID)
	// The daemon is told and catches up; a tab already open on this machine
	// cannot be, and this is the command where that hurts most — the whole
	// point of joining is the fleet, and an unreloaded tab shows a fleet of
	// one. relayReloadNote has the why.
	sayReloadOpenTabs(w, tellTheDaemon(w))
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

// runRelayStatus prints what is configured — the same line `flue status`
// carries, one answer decided in one place — and then asks the relay itself
// about the fleet directory.
//
// The second line is why this command exists separately from `flue status`.
// relayLine reports a file on disk and says so; the directory is the one part
// of a fleet whose health cannot be read from any local file, and it is
// readable from here without the daemon's help because `GET /directory` needs
// no credential and its contents are signed. So a user asking "is my fleet
// actually wired up" gets an answer that came from the relay, in a command
// they ran on purpose — while `flue status`, which is printed on every
// enable/disable and reads no network, stays local.
func runRelayStatus(w io.Writer) error {
	fmt.Fprintln(w, relayLine())
	rc, ok, err := config.LoadRelay()
	if err != nil || !ok {
		// relayLine already said which of the two this is, in its own words.
		return nil
	}
	fmt.Fprintln(w, directoryLine(rc))
	return nil
}

// directoryLine is what the relay's fleet directory says about this fleet,
// read live and verified locally.
//
// Verified is the number that means something. The relay hands out whatever it
// is holding, so "entries" is the relay's claim; what a fleet key can check is
// how many of those blobs it signed, and the breakdown after it is the fleet
// as this machine's own key can prove it: machines, devices, revocations. A
// gap between the two numbers is worth seeing — it is a rotated fleet key, or
// a relay that is not the one this machine thinks it is.
func directoryLine(rc config.Relay) string {
	// The two ways this machine holds no usable fleet key, and the same
	// consequence under both — said out loud, because it is invisible from
	// everywhere else and permanent for every device paired while it lasts.
	// The daemon signs with this file, read when it signs (fleetOnDisk), so
	// what is unusable here is unusable in the running daemon too.
	const cannotSign = "\n          this daemon signs nothing for a fleet: a browser paired here" +
		"\n          pins no fleet key and gets no certificate, and no reload or" +
		"\n          reconnect repairs that — it must pair again once this is fixed"
	if rc.FleetSeed == "" {
		// relayLine already names this as the fault that stops the daemon
		// dialling at all; there is nothing this line could verify.
		return "fleet:    unknown (this relay.json carries no fleet key)" + cannotSign +
			"\n          fix: re-run `flue relay setup`, or `flue relay join --fleet ...` from a machine that has the key"
	}
	key, err := fleet.Parse(rc.FleetSeed)
	if err != nil {
		return "fleet:    unknown (the fleet key in relay.json cannot be parsed)" + cannotSign +
			"\n          fix: re-run `flue relay join --fleet ...` with the line from a machine still on this relay"
	}
	ctx, cancel := context.WithTimeout(context.Background(), relayStepTimeout)
	defer cancel()
	counts, err := fetchDirectory(ctx, rc, key.Public())
	if err != nil {
		// Named without the URL: relayLine printed it one line up.
		return fmt.Sprintf("fleet:    unreachable (%v)", err)
	}
	line := fmt.Sprintf("fleet:    %s, %d verified under this fleet key",
		plural(counts.Entries, "entry", "entries"), counts.Verified)
	// Machines and revocations, which is what the directory carries. Device
	// certificates are not published to it — they go to the device that owns
	// them (spec/fleet-trust.md) — so a count of them here would read as "this
	// fleet has no devices" when it means "the directory does not list them",
	// which are different claims and only the second is true. It is still
	// *counted*, because a non-zero value is a real signal.
	//
	// The line does not name a cause, because there is no honest one to name.
	// No released flue has a fleet directory at all, so "an older flue is
	// still publishing them" — which this line used to say — cannot ever be
	// true; what is left is a build from between the two, or a hand-written
	// PUT by whoever holds the daemon secret. Both deserve a look and neither
	// is a diagnosis a status line can make from a count.
	line += fmt.Sprintf(" (%s, %s)",
		plural(counts.Machines, "machine", "machines"),
		plural(counts.Revocations, "revocation", "revocations"))
	if counts.Devices > 0 {
		line += fmt.Sprintf("\n          %s in the directory; nothing in this fleet should be publishing one",
			plural(counts.Devices, "device certificate", "device certificates"))
	}
	if counts.Entries != counts.Verified {
		line += fmt.Sprintf("\n          %s signed by something else; this relay may belong to another fleet",
			plural(counts.Entries-counts.Verified, "entry is", "entries are"))
	}
	line += capacityLine(counts.Entries)
	if counts.MachineListed {
		return line
	}
	return line + "\n          this machine is not in the directory: other devices will not discover it"
}

// capacityLine is the warning that the directory is filling up, or the flatter
// statement that it is already full. Empty for a fleet with room, because a
// status report that says "everything is fine" in three ways is one nobody
// reads.
//
// It is here because the cap fails hard and silently. At MaxDirectoryEntries
// the relay refuses every new blob — before storing it and therefore before
// pushing it, so a revocation made past that point reaches nobody — and no
// deploy, update or re-setup frees an entry. Without this line the first thing
// an operator sees is a 507 in a daemon log after a revoke they believed had
// crossed the fleet.
func capacityLine(entries int) string {
	switch {
	case entries >= relay.MaxDirectoryEntries:
		return fmt.Sprintf("\n          the directory is full (%d of %d): nothing new is distributed, not even a revocation. `flue relay reset` empties it and the fleet republishes",
			entries, relay.MaxDirectoryEntries)
	case entries >= relay.DirectoryWarnAt:
		return fmt.Sprintf("\n          the directory is %d of %d entries full; at %d nothing new is distributed, not even a revocation. `flue relay reset` empties it and the fleet republishes",
			entries, relay.MaxDirectoryEntries, relay.MaxDirectoryEntries)
	default:
		return ""
	}
}

// plural is the one-or-many spelling of a count. The status report is prose a
// person reads, and "1 machines" is the kind of thing that makes a tool look
// like it is guessing.
func plural(n int, one, many string) string {
	if n == 1 {
		return fmt.Sprintf("%d %s", n, one)
	}
	return fmt.Sprintf("%d %s", n, many)
}

// directoryCounts is what one read of the directory found.
type directoryCounts struct {
	Entries     int
	Verified    int
	Machines    int
	Devices     int
	Revocations int
	// MachineListed is whether one of the verified machine certs names this
	// machine's id — the difference between "the fleet is fine" and "the fleet
	// is fine and cannot see me".
	MachineListed bool
}

// fetchDirectory reads `GET /directory` and verifies every entry under pub.
//
// It presents the daemon secret even though the route is credential-less, for
// the reason the daemon's own reader does: the Worker meters exactly the
// callers that present none, and that budget exists for browsers.
func fetchDirectory(ctx context.Context, rc config.Relay, pub ed25519.PublicKey) (directoryCounts, error) {
	var out directoryCounts
	url := directoryURL(rc.URL)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return out, err
	}
	if rc.Secret != "" {
		req.Header.Set("Authorization", "Bearer "+rc.Secret)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return out, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		if resp.StatusCode == http.StatusServiceUnavailable {
			// The Worker's own answer for a deploy that predates the directory
			// binding (relay/src/index.ts). Naming it is worth a sentence: the
			// fix is `flue relay update`, not anything about this machine.
			return out, errors.New("this relay has no directory; run `flue relay update` to redeploy it")
		}
		return out, fmt.Errorf("the relay answered HTTP %d", resp.StatusCode)
	}
	var doc struct {
		Entries []struct {
			Blob []byte `json:"blob"`
		} `json:"entries"`
	}
	// The same ceiling the daemon reads under: a status command must not be an
	// unbounded read from a machine on the internet either.
	if err := json.NewDecoder(io.LimitReader(resp.Body, maxDirectoryRead)).Decode(&doc); err != nil {
		return out, errors.New("the relay answered something that is not a directory")
	}
	out.Entries = len(doc.Entries)
	for _, e := range doc.Entries {
		cert, err := fleet.Verify(pub, e.Blob)
		if err != nil {
			continue
		}
		out.Verified++
		switch c := cert.(type) {
		case fleet.MachineCert:
			out.Machines++
			if c.ID == rc.MachineID {
				out.MachineListed = true
			}
		case fleet.DeviceCert:
			out.Devices++
		case fleet.Revocation:
			out.Revocations++
		}
	}
	return out, nil
}

// maxDirectoryRead bounds the body this command will parse: the directory's
// own ceiling (512 entries of 4 KiB) in base64, with room to spare.
const maxDirectoryRead = 4 << 20

// directoryURL is `/directory` on the host relay.json dials, as HTTP.
//
// Derived from the socket URL rather than from Origin, the same way the
// daemon's own directory leg derives it: the directory to ask about a fleet is
// the one attached to the relay this machine dials, and a half-edited
// relay.json should not be able to send the question somewhere else. ws is
// handled beside wss because a local relay under `pnpm dev` is spelled that
// way.
func directoryURL(relayURL string) string {
	base := strings.TrimRight(relayURL, "/")
	switch {
	case strings.HasPrefix(base, "wss://"):
		base = "https://" + strings.TrimPrefix(base, "wss://")
	case strings.HasPrefix(base, "ws://"):
		base = "http://" + strings.TrimPrefix(base, "ws://")
	}
	return base + "/directory"
}

// resetDirectory empties the relay's fleet directory: `DELETE /directory` under
// the daemon secret, which wipes every blob and the entry count with it and
// closes the push sockets so each daemon reconnects and re-publishes at once.
//
// The secret is the whole credential here, as it is on a PUT. The relay holds
// no fleet key and can judge no blob, so what it can gate is who may *write*,
// and emptying the store is the largest write there is.
func resetDirectory(ctx context.Context, rc config.Relay) (removed int, err error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodDelete, directoryURL(rc.URL), nil)
	if err != nil {
		return 0, err
	}
	req.Header.Set("Authorization", "Bearer "+rc.Secret)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	switch resp.StatusCode {
	case http.StatusOK:
	case http.StatusUnauthorized:
		return 0, errors.New("the relay refused this machine's credential; the secret in relay.json is not the one this Worker holds")
	case http.StatusServiceUnavailable:
		// The Worker's own answer for a deploy that predates the directory
		// binding (relay/src/index.ts), and the same sentence fetchDirectory
		// gives it: there is nothing to reset because there is nothing there.
		return 0, errors.New("this relay has no directory; run `flue relay update` to redeploy it")
	default:
		return 0, fmt.Errorf("the relay answered HTTP %d", resp.StatusCode)
	}
	var doc struct {
		Reset   bool `json:"reset"`
		Removed int  `json:"removed"`
	}
	// A small, fixed-shape answer, read under a bound for the reason every
	// other read of this relay is: the far end is a machine on the internet and
	// this process is not obliged to trust its brevity.
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<10)).Decode(&doc); err != nil || !doc.Reset {
		return 0, errors.New("the relay answered something that is not a directory reset")
	}
	return doc.Removed, nil
}

const relayLeaveUsage = "usage: flue relay leave [--yes]"

// relayWorkerLabel names the Cloudflare script a relay.json points at, for the
// one sentence that has to be about the thing leaving does *not* remove.
//
// It falls back to the host because the name is not always recorded: a
// relay.json written by `flue relay join` never knew it (join deploys nothing),
// and updateWorkerName can only derive one from a workers.dev address. "The
// Worker behind relay.example.com" is still enough to find in a dashboard,
// which is all this label is for.
func relayWorkerLabel(cfg config.Relay) string {
	if w, err := updateWorkerName("", cfg); err == nil {
		return "the Worker " + w
	}
	return "the Worker behind " + strings.TrimPrefix(cfg.URL, "wss://")
}

// relayLeaveWarning is what the command says before it asks, and half of it is
// about what leaving does *not* do — which is the half a user cannot check and
// will otherwise assume, in whichever direction is wrong for them.
//
// The first paragraph is the cost, and it is unrecoverable in the strict sense:
// relay.json is the only copy of two credentials this machine holds. The
// second is the one a user is likeliest to have backwards — leaving does not
// undeploy anything, because leaving makes no API call at all. The third is
// the reassurance, and it is load-bearing too: "leave the relay" reads like
// "unpair everything", and somebody would otherwise re-pair four phones for
// no reason.
func relayLeaveWarning(cfg config.Relay) string {
	return fmt.Sprintf(`this deletes relay.json — this machine's place on the relay, the relay's
daemon secret and the fleet key, all of which live in that one file.

rejoining means running the "flue relay join" line from a machine that is
still on this relay — it carries both credentials back, and nothing else
can. neither can be read out of anywhere else: the secret's other copy is a
binding on the Worker, which Cloudflare will not hand back, and the fleet key
has no copy at all outside the relay.json of the machines still on it. if
this is the last machine on the relay, there is no line left to run, and a
fresh "flue relay setup" is the way back — a new secret and a new fleet key,
so every other machine re-joins and every browser pairs again.

leaving also mints nothing: a rejoin gives this machine a new id, so every
browser's record of the old one is dead. devices holding a certificate from
this same fleet find the machine again through the fleet directory; anything
else pairs again.

the relay stays deployed. this command calls Cloudflare not at all — %s
keeps running in your account and keeps serving whatever is still joined to
it. delete it from the Cloudflare dashboard (Workers & Pages) if you want it
gone.

nothing else on this machine is touched: paired devices, this daemon's key,
the revocation list, the stored Cloudflare token and the browser tab on
127.0.0.1 are all exactly as they were.

`, relayWorkerLabel(cfg))
}

// relayLeaveDone is the part that only makes sense once the file is gone: the
// two facts about the relay this machine just walked away from that deleting a
// local file does not change.
//
// The restart note that used to open it is gone with the restart. This command
// deleted relay.json and then told the running daemon (tellTheDaemon), which
// stops the leg — so "you have left" is true of the socket as well as of the
// file by the time this prints. The one case that still names a restart is a
// daemon that could not be reached, and tellTheDaemon names it there rather
// than warning everybody.
const relayLeaveDone = `
two things stay behind on the relay itself. this machine's certificate is
still in the fleet directory — nothing there deletes a single entry, so the
fleet's browsers keep listing this machine until somebody runs "flue relay
reset" — and this machine has stopped re-publishing the revocations it holds.
they are still on disk here and still in the directory, but if that directory
is ever emptied, a revocation whose only remaining holder was this machine
does not come back. revoke that device again from a machine still on the
relay if you are unsure.
`

// runRelayLeave takes this machine off the relay it is on: relay.json, deleted,
// and nothing else.
//
// It is the missing verb. Every other piece of relay state has had a command
// for a while — setup, join, status, update, address, reset — and "I want this
// machine off this relay" meant knowing that flue keeps a relay.json in its
// config directory and removing it by hand, which is a thing a user can only
// do after reading the source or the docs.
//
// It makes no network call, on purpose rather than for want of an API. There is
// nothing honest to call: the Worker is the user's and undeploying it would be
// a much larger action wearing this one's name (the other machines on that
// relay would lose their access to it), and the fleet directory has no
// per-entry delete — `flue relay reset` empties all of it, which is a
// fleet-wide act, not this machine's to perform on its way out. So this is a
// local command, and everything it cannot do it says instead.
//
// The confirmation is runRelayReset's, in the same words and with the same
// --yes for scripts, because the two are the same kind of dangerous: this one
// destroys the only copy of the fleet key a single-machine relay has, and no
// amount of Cloudflare access brings it back.
func runRelayLeave(w io.Writer, r io.Reader, args []string) error {
	fs := flag.NewFlagSet("relay leave", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	yes := fs.Bool("yes", false, "do not ask for confirmation")
	if err := fs.Parse(args); err != nil {
		return fmt.Errorf("%w; %s", err, relayLeaveUsage)
	}
	if fs.NArg() != 0 {
		return fmt.Errorf("unexpected argument %q; %s", fs.Arg(0), relayLeaveUsage)
	}

	cfg, ok, err := config.LoadRelay()
	if err != nil {
		return err
	}
	if !ok {
		// Not an error of the user's making, but not a success either: a
		// command that printed "left the relay" here would be claiming to have
		// done something to a machine that was never on one.
		return errors.New("no relay is configured on this machine; there is nothing to leave")
	}

	if !*yes {
		fmt.Fprint(w, relayLeaveWarning(cfg))
		fmt.Fprint(w, "type yes to continue: ")
		line, readErr := bufio.NewReader(r).ReadString('\n')
		if readErr != nil && !errors.Is(readErr, io.EOF) {
			return fmt.Errorf("read the confirmation: %w", readErr)
		}
		if strings.TrimSpace(line) != "yes" {
			fmt.Fprintln(w, "  this machine is still on the relay")
			return nil
		}
	}

	if err := config.DeleteRelay(); err != nil {
		return fmt.Errorf("delete the relay configuration: %w", err)
	}
	fmt.Fprintf(w, "  ✓ left %s (relay.json deleted)\n", cfg.URL)
	// No sayReloadOpenTabs here, and not by omission. The other three commands
	// leave an open tab with a policy too narrow for the relay this machine now
	// has; leaving leaves it with one too *wide*, which forbids nothing, and the
	// tab keeps every capability it had — its fleet identity is its own, held in
	// the browser, and the relay it was certified for is still standing. A
	// reload is the one thing that would take that away: the next document
	// names no relay origin at all, and re-enrolling against a machine that
	// holds no fleet key gets nothing back. So the advice would be wrong here in
	// the strong sense — following it costs the reader something.
	tellTheDaemon(w)
	fmt.Fprint(w, relayLeaveDone)
	return nil
}

const relayResetUsage = "usage: flue relay reset [--yes]"

// relayResetWarning is what the command says before it asks. Both halves are
// load-bearing: the first is why an operator would ever run this, the second is
// the one thing a wipe can cost that re-publishing does not put back.
const relayResetWarning = `this empties the relay's fleet directory: every machine certificate
and every revocation the relay is holding.

every machine re-publishes everything it holds when it reconnects, so a
fleet that is switched on refills the directory within seconds. what does
not come back is a blob whose only remaining holder never reconnects —
in practice a revocation published by a machine that is now gone. every
machine that already heard that revocation still holds it and re-publishes
it; if you are unsure, revoke the device again from any machine afterwards.

`

// relayResetDone is the note after the wipe: what happens next, without the
// user having to know that publishAll runs on every connect.
const relayResetDone = `
the directory is empty. every connected machine was disconnected from it and
re-publishes what it holds on reconnect, so it refills on its own; a machine
that is switched off refills its share when it next starts.
`

// runRelayReset empties the relay's fleet directory — the escape hatch for a
// full one, and the only one there is.
//
// It exists because the directory refuses a 513th entry rather than evicting
// (relay/src/directory.ts, full), nothing there ever deletes a single entry,
// and Durable Object storage outlives every redeploy: neither `flue relay
// update` nor a fresh `flue relay setup` against a new script name reaches it.
// A directory that has filled up therefore stays full forever, and a full
// directory is a fleet whose *revocations* stop crossing machines — the one
// failure mode in this design that costs more than visibility. So there has to
// be a way to empty it, and this is it.
//
// It is a wipe rather than a prune, and that is not laziness — nor is it a
// judgement that a prune would be unsafe. There is next to nothing to prune:
// a revocation is never superseded, a device certificate is not in the store
// at all, and what is left is a machine certificate a machine re-minted, which
// is single digits out of 512 over a fleet's whole life (spec/fleet-trust.md
// works the count). Removing any *named* entry would mean the relay reading
// the blobs, or checking a signature over the digests, and both give this leg
// an opinion about what it holds. Deleting all of them needs no opinion about
// any of them.
//
// The confirmation is a typed "yes" rather than a flag alone, because the one
// unrecoverable case — a revocation whose last holder never reconnects — is not
// something a person should meet by autocompleting a command. --yes is there
// for the scripted path.
//
// **Why `flue relay setup` does not do this too, having been asked.** It has a
// claim to: a re-setup mints a fresh fleet key, which turns every blob already
// in the directory into a signature no machine in the new fleet can verify —
// dead weight against a 512-entry cap that nothing else ever frees. But setup
// would have to send this request in the seconds after it enabled the
// workers.dev subdomain and bound a *new* secret, and neither of those is live
// at the edge the moment the API accepts it: the reset would be racing two
// propagations at once, so it would fail often, on the one command a user runs
// before they have any idea what a fleet directory is, and it would fail
// loudest on a first deploy where there was nothing to clear. A step that
// unreliable is worse than a separate command that always works. So this is the
// separate command, `flue relay status` says when it is needed, and
// docs/RELAY.md names it as the way out.
func runRelayReset(w io.Writer, r io.Reader, args []string) error {
	fs := flag.NewFlagSet("relay reset", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	yes := fs.Bool("yes", false, "do not ask for confirmation")
	if err := fs.Parse(args); err != nil {
		return fmt.Errorf("%w; %s", err, relayResetUsage)
	}
	if fs.NArg() != 0 {
		return fmt.Errorf("unexpected argument %q; %s", fs.Arg(0), relayResetUsage)
	}

	cfg, ok, err := config.LoadRelay()
	if err != nil {
		return err
	}
	if !ok {
		return errors.New("no relay is configured on this machine; `flue relay setup` deploys one first")
	}
	if cfg.Secret == "" {
		// The daemon secret is the whole credential on this route. Said here
		// rather than met as a 401 from a relay that is not at fault.
		return errors.New("relay.json carries no daemon secret; re-run the join line printed by `flue relay setup`")
	}

	if !*yes {
		fmt.Fprint(w, relayResetWarning)
		fmt.Fprint(w, "type yes to continue: ")
		line, readErr := bufio.NewReader(r).ReadString('\n')
		if readErr != nil && !errors.Is(readErr, io.EOF) {
			return fmt.Errorf("read the confirmation: %w", readErr)
		}
		if strings.TrimSpace(line) != "yes" {
			fmt.Fprintln(w, "  nothing was reset")
			return nil
		}
	}

	ctx, cancel := context.WithTimeout(context.Background(), relayStepTimeout)
	defer cancel()
	removed, err := resetDirectory(ctx, cfg)
	if err != nil {
		return fmt.Errorf("reset the fleet directory: %w", err)
	}
	fmt.Fprintf(w, "  ✓ fleet directory reset (%s cleared)\n", plural(removed, "entry", "entries"))
	fmt.Fprint(w, relayResetDone)
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
		// OnStep is deliberately unset — this command prints its own ✓ lines
		// in its own words — but a note must not go with it: this is the
		// command that meets a relay deployed by a newer flue, and the whole
		// point of the note is that the 10061 which follows says nothing about
		// why.
		OnNote: func(line string) { fmt.Fprintf(w, "  %s\n", line) },
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
