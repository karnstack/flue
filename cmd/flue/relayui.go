package main

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/karnstack/flue/internal/cloudflare"
	"github.com/karnstack/flue/internal/config"
	"github.com/karnstack/flue/internal/daemon"
	"github.com/karnstack/flue/internal/fleet"
	"github.com/karnstack/flue/internal/relaydeploy"
	relaybundle "github.com/karnstack/flue/relay"
)

// relayUIService is daemon.RelayUI: the deploy service behind the Remote
// screen, living in this package because this package owns the embedded
// bundles, the config directory, and the transport's lifecycle. It performs
// the same deploy `flue relay setup`/`update` perform — internal/relaydeploy
// is the shared implementation — with the terminal's prompts replaced by
// request/response shapes.
//
// The token in every request is used for that request's Cloudflare calls and
// goes no further, the same guarantee the CLI makes: never stored, never
// logged, never echoed into an error.
type relayUIService struct {
	// mu serialises deploys. Two concurrent Deploy clicks would race on
	// relay.json and on the transport start; the second waits and then
	// operates on the state the first left.
	mu sync.Mutex

	// runtime is the transport's start-once bookkeeping, shared with
	// cmdServe, which performs the boot-time start.
	runtime *relayRuntime

	// base aims the Cloudflare client somewhere else in tests; "" is the real
	// API.
	base string

	// log hears what the deploy did — worker names and outcomes, never a
	// token and never the secret. Nil is quiet, which is what tests want.
	log *slog.Logger

	// shippedOrigin and shippedStamp remember the last deploy this process
	// completed: where it shipped and what stamp it shipped. They exist for
	// the minutes right after a deploy — Cloudflare's API accepts a new
	// Worker before every edge serves it, and until propagation finishes the
	// relay's /api/health still answers with the previous stamp. A Status
	// that trusted only the health read would put the update card back under
	// the checkmarks the deploy just earned, and taking that offer redeploys
	// identical bytes. Their own mutex, not mu: Status must render during a
	// deploy, not queue behind one. Lost on a daemon restart, deliberately —
	// by the time a daemon comes back, propagation is long done and the
	// health read is telling the truth again.
	shippedMu     sync.Mutex
	shippedOrigin string
	shippedStamp  string
}

func (s *relayUIService) logf() *slog.Logger {
	if s.log == nil {
		return slog.New(slog.DiscardHandler)
	}
	return s.log
}

// relayRuntime tracks whether this daemon process has a relay transport
// running, and how to start, stop and replace one. It exists for the
// first-deploy moment: a daemon that booted with no relay.json should start
// dialling the relay the user just deployed without being restarted.
//
// The stop half exists for the opposite moment. Disconnecting from the Remote
// screen deletes relay.json, and a daemon that kept its socket after that
// would be one telling the user they are off a relay their machine is still
// answering on — which is the one claim this feature must not make. So start
// hands back the way to undo itself, rather than the caller keeping a cancel
// somewhere and hoping the two stay in step.
//
// Restart is the two together, and it is what a *second* deploy needs. A
// daemon whose leg is already up used to be told to restart itself: the leg
// dialled the old relay.json, the file had just been replaced, and nothing in
// the process could reconcile the two. It can now — stop that leg, start
// another, and the new one reads the file that is there — so "restart the
// daemon" stops being an answer this program gives.
type relayRuntime struct {
	mu      sync.Mutex
	running bool
	// start brings the transport up and returns whether it did, together with
	// the teardown for the leg it just started. A start that returns false
	// returns no teardown; a stop is only ever called for a leg that ran.
	start func() (started bool, stop func())
	// stop is the running leg's teardown, held here so only the goroutine that
	// owns `running` can ever call it — once, and never for a leg that has
	// already gone.
	stop func()
}

// startOnce starts the transport if none is running. It reports (started,
// alreadyRunning).
func (rt *relayRuntime) startOnce() (bool, bool) {
	rt.mu.Lock()
	defer rt.mu.Unlock()
	if rt.running {
		return false, true
	}
	if rt.start == nil {
		return false, false
	}
	started, stop := rt.start()
	rt.running, rt.stop = started, nil
	if started {
		rt.stop = stop
	}
	return started, false
}

// stopNow tears the relay leg down and reports whether there was one. Idempotent
// — a second call finds nothing running and says so — because "leave" is a thing
// a user can click twice, and because the CLI may have deleted relay.json first.
func (rt *relayRuntime) stopNow() bool {
	rt.mu.Lock()
	defer rt.mu.Unlock()
	return rt.stopLocked()
}

func (rt *relayRuntime) stopLocked() bool {
	if !rt.running {
		return false
	}
	stop := rt.stop
	rt.running, rt.stop = false, nil
	if stop != nil {
		stop()
	}
	return true
}

// restart replaces whatever leg is running with one built from the relay.json
// that exists now, and reports whether a leg is dialling when it returns.
//
// One lock for both halves, deliberately: a stop and a start that could
// interleave with another caller's would be two legs on one relay, which is the
// state the Durable Object resolves by closing the incumbent — the working
// socket — on the newcomer's behalf. It is also why the whole operation is
// here rather than assembled from stopNow and startOnce at the call sites.
//
// Called by every path that rewrites relay.json under a running daemon: a
// deploy or an address change from the Remote screen, and Reload, which is
// what `flue relay setup`/`join`/`address`/`leave` in a terminal reach for.
// A false answer means there is nothing to dial — relay.json is gone, or
// carries a configuration relay.New refuses — and the daemon serves loopback
// exactly as it would have.
func (rt *relayRuntime) restart() bool {
	rt.mu.Lock()
	defer rt.mu.Unlock()
	rt.stopLocked()
	if rt.start == nil {
		return false
	}
	started, stop := rt.start()
	if started {
		rt.running, rt.stop = true, stop
	}
	return started
}

func (s *relayUIService) client(token string) *cloudflare.Client {
	return &cloudflare.Client{Base: s.base, Token: token}
}

// deployStamp is what FLUE_VERSION carries on a deploy, and what the update
// comparison runs on. A release stamps its version. A from-source build's
// "dev" would compare equal to every other "dev", leaving relay changes
// invisible to the update card during development — so dev stamps carry a
// short hash of the exact bytes a deploy would ship: change the Worker or
// the web bundle, rebuild, and the deployed relay reads as out of date.
func deployStamp() string {
	if version != "dev" {
		return version
	}
	h := sha256.New()
	h.Write(relaybundle.Module())
	if assets, err := webAssets(); err == nil {
		for _, a := range assets {
			io.WriteString(h, a.Path)
			h.Write(a.Body)
		}
	}
	return "dev-" + hex.EncodeToString(h.Sum(nil))[:12]
}

// canDeploy is the release-binary check, phrased for a screen instead of a
// terminal.
func canDeploy() (bool, string) {
	if len(relaybundle.Module()) == 0 {
		return false, "this build carries no relay worker; build a release binary with `make build` (a dev build leaves it out)"
	}
	if _, err := webAssets(); err != nil {
		return false, err.Error()
	}
	return true, ""
}

func (s *relayUIService) Status(ctx context.Context) daemon.RelayUIStatus {
	st := daemon.RelayUIStatus{Version: deployStamp()}
	st.CanDeploy, st.CanDeployReason = canDeploy()

	if cf, ok, _ := config.LoadCloudflare(); ok {
		st.HasToken = true
		st.AccountName = cf.AccountName
	}

	cfg, ok, err := config.LoadRelay()
	if err != nil || !ok {
		return st
	}
	st.Configured = true
	// The same faults `flue status` names, from the same function, so the
	// terminal and the screen can never disagree about whether this file is
	// one the daemon will dial. A relay.json from before the fleet key is the
	// case that made this necessary: it parses, so Configured is true, and
	// relay.New refuses it, so the transport never comes up.
	st.Problems = relayProblems(cfg)
	st.Origin = cfg.Origin
	if w, err := updateWorkerName("", cfg); err == nil {
		st.Worker = w
	}
	// This process's own deploy outranks the health read: right after one,
	// the edge can keep serving the previous Worker — previous stamp and
	// all — for seconds, occasionally longer, and believing /api/health in
	// that window turns a finished deploy into an update offer. The memory
	// declines to answer whenever it has gone stale (see shippedVersion),
	// and the health read decides as before.
	if stamp, ok := s.shippedVersion(cfg.Origin); ok {
		st.DeployedVersion = stamp
	} else {
		st.DeployedVersion = deployedVersion(ctx, cfg.Origin)
	}
	return st
}

// deployedVersion asks the relay's /api/health which flue deployed it. Best
// effort with a short leash: the Remote screen must render whether or not the
// relay is reachable, and an empty answer just means the UI offers no update.
func deployedVersion(ctx context.Context, origin string) string {
	if origin == "" {
		return ""
	}
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, origin+"/api/health", nil)
	if err != nil {
		return ""
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return ""
	}
	defer resp.Body.Close()
	var health struct {
		Version string `json:"version"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(nil, resp.Body, 4<<10)).Decode(&health); err != nil {
		return ""
	}
	return health.Version
}

// recordShipped is the deploy paths' success line: this process just put its
// own bytes behind origin, whatever /api/health says for the next while. A
// deploy that failed must never reach here — it changed nothing at the edge,
// and the card has to keep offering what the health read supports.
func (s *relayUIService) recordShipped(origin string) {
	s.shippedMu.Lock()
	defer s.shippedMu.Unlock()
	s.shippedOrigin, s.shippedStamp = origin, deployStamp()
}

// shippedVersion answers Status from memory, but only while the memory still
// speaks for the question being asked: the same origin, carrying the stamp
// this binary would ship again. Anything else is stale and must lose to a
// live health read — a relay.json repointed or re-joined elsewhere names a
// deploy this process never performed, and a binary whose own stamp moved on
// has a genuinely newer build whose update card must not be swallowed.
func (s *relayUIService) shippedVersion(origin string) (string, bool) {
	s.shippedMu.Lock()
	defer s.shippedMu.Unlock()
	if s.shippedStamp == "" || s.shippedOrigin != origin || s.shippedStamp != deployStamp() {
		return "", false
	}
	return s.shippedStamp, true
}

// resolveToken decides what credential a deploy runs with: the request's
// token when one was typed, the stored one otherwise, a refusal when there is
// neither. It reports whether the token came from the request — the ones that
// did get stored on success.
func resolveToken(reqToken string) (token string, fromRequest bool, err error) {
	if reqToken != "" {
		return reqToken, true, nil
	}
	cf, ok, err := config.LoadCloudflare()
	if err != nil {
		return "", false, err
	}
	if !ok {
		return "", false, fmt.Errorf("%w: no token in the request and none stored; paste a Cloudflare API token", daemon.ErrRelayUIBadRequest)
	}
	return cf.Token, false, nil
}

// storedAccountID is the account a stored credential deploys into, for
// skipping the picker on update.
func storedAccountID() string {
	cf, ok, _ := config.LoadCloudflare()
	if !ok {
		return ""
	}
	return cf.AccountID
}

// resolveAccount turns a token and an optional chosen id into the account to
// deploy into, or into the picker round trip. It mirrors pickAccount's rules:
// one account decides itself, several are never guessed between.
func (s *relayUIService) resolveAccount(ctx context.Context, api *cloudflare.Client, chosenID string, steps *[]string) (cloudflare.Account, *daemon.RelayUIDeployResult, error) {
	if err := withTimeout(relayStepTimeout, api.VerifyToken); err != nil {
		return cloudflare.Account{}, nil, fmt.Errorf("%w: %s", daemon.ErrRelayUIBadRequest, err.Error())
	}
	*steps = append(*steps, "token verified")

	var accounts []cloudflare.Account
	if err := withTimeout(relayStepTimeout, func(ctx context.Context) error {
		var err error
		accounts, err = api.Accounts(ctx)
		return err
	}); err != nil {
		return cloudflare.Account{}, nil, fmt.Errorf("list the Cloudflare accounts this token can reach: %w", err)
	}
	switch {
	case len(accounts) == 0:
		return cloudflare.Account{}, nil, fmt.Errorf("%w: this API token cannot reach any Cloudflare account; check that it was created with the \"Edit Cloudflare Workers\" template on an account you own", daemon.ErrRelayUIBadRequest)
	case chosenID == "" && len(accounts) == 1:
		chosenID = accounts[0].ID
	case chosenID == "":
		res := &daemon.RelayUIDeployResult{NeedsAccount: true}
		for _, a := range accounts {
			res.Accounts = append(res.Accounts, daemon.RelayUIAccount{ID: a.ID, Name: a.Name})
		}
		return cloudflare.Account{}, res, nil
	}
	for _, a := range accounts {
		if a.ID == chosenID {
			*steps = append(*steps, fmt.Sprintf("account: %s (%s)", a.Name, shortID(a.ID)))
			return a, nil, nil
		}
	}
	return cloudflare.Account{}, nil, fmt.Errorf("%w: the chosen account is not one this token can reach", daemon.ErrRelayUIBadRequest)
}

func (s *relayUIService) Provision(ctx context.Context, req daemon.RelayUIDeployRequest) (daemon.RelayUIDeployResult, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if ok, reason := canDeploy(); !ok {
		return daemon.RelayUIDeployResult{}, fmt.Errorf("%w: %s", daemon.ErrRelayUIBadRequest, reason)
	}
	worker := req.Worker
	if worker == "" {
		worker = relaydeploy.DefaultWorker
	}
	if err := relaydeploy.ValidWorkerName(worker); err != nil {
		return daemon.RelayUIDeployResult{}, fmt.Errorf("%w: %s", daemon.ErrRelayUIBadRequest, err.Error())
	}
	hostname, err := os.Hostname()
	if err != nil {
		return daemon.RelayUIDeployResult{}, fmt.Errorf("read this machine's hostname: %w", err)
	}
	assets, err := webAssets()
	if err != nil {
		return daemon.RelayUIDeployResult{}, err
	}

	token, fromRequest, err := resolveToken(req.Token)
	if err != nil {
		return daemon.RelayUIDeployResult{}, err
	}
	var steps []string
	api := s.client(token)
	account, ask, err := s.resolveAccount(ctx, api, req.AccountID, &steps)
	if err != nil {
		return daemon.RelayUIDeployResult{}, err
	}
	if ask != nil {
		return *ask, nil
	}

	host, secret, err := relaydeploy.Provision(relaydeploy.Input{
		API:          api,
		AccountID:    account.ID,
		Worker:       worker,
		Module:       relaybundle.Module(),
		Assets:       assets,
		AssetHeaders: relayAssetHeaders,
		Version:      deployStamp(),
		OnStep:       func(line string) { steps = append(steps, line) },
	})
	if err != nil {
		return daemon.RelayUIDeployResult{}, err
	}

	// The same record `flue relay setup` writes, for the same reasons — see
	// runRelaySetup for why the id, the secret and the fleet key are fresh,
	// why the id is minted under the fresh secret, why the fleet key goes
	// nowhere but this file and the join line, and why the write is last.
	fleetKey, err := fleet.Mint(rand.Reader)
	if err != nil {
		return daemon.RelayUIDeployResult{}, err
	}
	machineID := config.MintMachineID(hostname, secret, rand.Reader)
	machineName := truncateRunes(hostname, machineNameMaxRunes)
	// And this machine's own certificate under it, for the same reason
	// runRelaySetup mints one: the fleet directory is how the browsers in this
	// fleet learn that this machine exists, and a machine with no cert is a
	// machine only the devices paired directly to it can reach. A failure is a
	// step line, not a failed deploy.
	machineCert, certErr := mintMachineCert(fleetKey, machineID, machineName)
	if err := config.SaveRelay(config.Relay{
		URL:         "wss://" + host,
		Secret:      secret,
		FleetSeed:   fleetKey.Seed(),
		Origin:      "https://" + host,
		MachineID:   machineID,
		MachineName: machineName,
		MachineCert: machineCert,
		Worker:      worker,
	}); err != nil {
		return daemon.RelayUIDeployResult{}, fmt.Errorf("save the relay configuration: %w", err)
	}
	steps = append(steps, "fleet key minted (stays on your machines; Cloudflare never sees it)")
	steps = append(steps, fmt.Sprintf("this machine joined as %s (%s)", machineName, machineID))
	if certErr != nil {
		steps = append(steps, "could not mint this machine's fleet certificate ("+certErr.Error()+"); other devices will not discover this machine")
	}
	// What used to stand here was a warning: the fleet key this process signed
	// with was whatever relay.json held when the daemon booted — never the key
	// minted three lines up — so a phone paired between this deploy and the
	// next restart got a phone that worked here and could never roam. Both
	// halves now read the file: the dialling half at every start, and the
	// signing half at every signature (cmd/flue.fleetOnDisk). There is nothing
	// left to warn about, so the line says what is true instead.
	steps = append(steps, "this daemon signs with the new fleet key from now on")

	if fromRequest {
		// Stored by product decision — one 0600 file beside relay.json — so
		// the next update is a click and the account can be named on the
		// card. Failing to store fails nothing else; the deploy stands.
		if err := config.SaveCloudflare(config.Cloudflare{Token: token, AccountID: account.ID, AccountName: account.Name}); err != nil {
			steps = append(steps, "could not store the token: "+err.Error())
		} else {
			steps = append(steps, "token stored for one-click updates")
		}
	}

	res := daemon.RelayUIDeployResult{
		Steps:       steps,
		Origin:      "https://" + host,
		JoinCommand: joinCommand(host, secret, fleetKey.Seed()),
	}
	// Restart rather than start-if-idle. A daemon that already had a leg was
	// dialling whatever relay.json said when that leg began, which this deploy
	// has just replaced — secret, machine id, fleet key and all — so the leg
	// has to be replaced with it. The stop waits for the old one to be gone
	// before the new one dials (newRelayRuntime), so nothing here has to
	// reconcile two legs' claims about one daemon.
	if s.runtime.restart() {
		res.Steps = append(res.Steps, "daemon connecting to the relay")
	} else {
		res.Steps = append(res.Steps, "the daemon could not start a relay leg for this configuration; `flue relay status` says which field is missing")
	}
	// Remember what shipped and where: Status answers from this while the
	// edge catches up, instead of trusting a health read that briefly still
	// says the previous deploy.
	s.recordShipped(res.Origin)
	s.logf().Info("relay deployed from the UI", "worker", worker, "host", host)
	return res, nil
}

// joinCommand is the one spelling of the hand-off line, shared by the CLI's
// setup print, the deploy result and the join endpoint so the three can
// never drift. It carries the secret and the fleet key seed, which is the
// line's whole point and its whole weight: docs/RELAY.md says what leaking
// it now costs where it teaches the line ("Standing one up"), and
// spec/fleet-trust.md fixes the words — a leaked join line used to buy
// disruption, and with the fleet key aboard it buys the fleet.
func joinCommand(host, secret, fleetSeed string) string {
	return fmt.Sprintf("flue relay join wss://%s --secret %s --fleet %s", host, secret, fleetSeed)
}

// SetAddress is `flue relay address` behind the card: the user routed a
// custom domain to the Worker in the Cloudflare dashboard, and this repoints
// relay.json at it. URL and origin only; worker, secret and machine id stay,
// because the Worker behind the name is the same one. The leg is restarted
// onto the new name in this process, so the daemon dials the address the card
// now shows rather than the one it was started with. What does not stay is
// any existing pairing — the daemon serves exactly the origin it dials, so
// every browser paired on the old one must pair again on the new address
// (see runRelayAddress), and the second step line carries that truth to the
// card. That one is not a restart in disguise and no restart fixes it: a
// pairing lives in a browser, keyed to the origin it was made on. The
// shipped-deploy memory keys on the origin, so a repoint sends Status back to
// asking the relay itself: the Worker behind the new name should be the same
// one, but that is the health read's fact to confirm, not memory's to assume.
func (s *relayUIService) SetAddress(ctx context.Context, address string) (daemon.RelayUIDeployResult, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	host, err := relayHost(address)
	if err != nil {
		return daemon.RelayUIDeployResult{}, fmt.Errorf("%w: %s", daemon.ErrRelayUIBadRequest, err.Error())
	}
	cfg, ok, err := config.LoadRelay()
	if err != nil {
		return daemon.RelayUIDeployResult{}, err
	}
	if !ok {
		return daemon.RelayUIDeployResult{}, fmt.Errorf("%w: no relay is configured on this machine", daemon.ErrRelayUIBadRequest)
	}
	cfg.URL = "wss://" + host
	cfg.Origin = "https://" + host
	if err := config.SaveRelay(cfg); err != nil {
		return daemon.RelayUIDeployResult{}, fmt.Errorf("save the relay configuration: %w", err)
	}
	steps := []string{"relay address is now wss://" + host}
	if s.runtime.restart() {
		steps = append(steps, "the daemon is dialling the new address now")
	}
	steps = append(steps, "every browser paired on the old origin must pair again on the new address")
	s.logf().Info("relay address changed from the UI", "host", host)
	return daemon.RelayUIDeployResult{
		Steps:  steps,
		Origin: "https://" + host,
	}, nil
}

// Leave is `flue relay leave` behind the card: relay.json deleted, the relay
// leg taken down, and nothing else touched.
//
// It is the same operation the CLI performs, and it says the same things,
// because a fact about this machine's Cloudflare account should not have two
// spellings — relayProblems feeding both `flue status` and this screen is the
// precedent. The steps below are the CLI's sentences, shortened to the length
// a checkmark line wants; the parts that must be read *before* the click live
// in the confirmation the Remote screen puts up (cloudflare-connect.tsx),
// where the CLI puts its own warning.
//
// The one difference between the two surfaces is honest and in this direction:
// this runs inside the daemon, so it can actually stop the leg, while the CLI
// can only delete a file and tell the user to restart. Stopping is not a
// courtesy — a screen that reported "you have left the relay" while the socket
// was still carrying browsers would be making the single claim this feature
// cannot get wrong.
//
// What it deliberately does not do: call Cloudflare. The Worker is the user's
// and other machines may still be joined to it, so undeploying it is a
// fleet-wide act wearing a per-machine name; the fleet directory has no
// per-entry delete either. Both are said out loud instead.
func (s *relayUIService) Leave(ctx context.Context) (daemon.RelayUIDeployResult, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	cfg, ok, err := config.LoadRelay()
	if err != nil {
		return daemon.RelayUIDeployResult{}, err
	}
	if !ok {
		return daemon.RelayUIDeployResult{}, fmt.Errorf("%w: no relay is configured on this machine; there is nothing to leave", daemon.ErrRelayUIBadRequest)
	}
	// The file first, the socket second, and the order is deliberate: a delete
	// that failed must leave a machine that is still on the relay in every
	// sense, rather than one whose leg is down and whose config says it should
	// be up — which is the state a restart would silently undo.
	if err := config.DeleteRelay(); err != nil {
		return daemon.RelayUIDeployResult{}, fmt.Errorf("delete the relay configuration: %w", err)
	}

	steps := []string{"left " + cfg.URL + " — relay.json deleted"}
	if s.runtime.stopNow() {
		steps = append(steps, "relay leg stopped; nothing outside this computer reaches this machine now")
	}
	steps = append(steps,
		relayWorkerLabel(cfg)+" is still deployed in your Cloudflare account; delete it there if you want it gone",
		"paired devices, this daemon's key and the stored Cloudflare token are untouched",
		"rejoining needs the join line from a machine still on this relay, and mints this machine a new id",
	)
	s.logf().Info("left the relay from the UI", "url", cfg.URL)
	// No Origin: there is no relay origin any more, and naming the one this
	// machine just left would put an address on a card that means nothing.
	return daemon.RelayUIDeployResult{Steps: steps}, nil
}

// Reload makes this process's relay leg match the relay.json that is on disk
// right now, and reports what it did.
//
// It is the hook the *other* process needs. `flue relay setup`, `join`,
// `address` and `leave` are terminal commands: they rewrite relay.json and
// exit, and the daemon they configure has been running since login with no
// idea any of it happened. Everything a daemon signs already follows the file
// by itself (fleetOnDisk), but a socket cannot be read out of a file on
// demand — so the CLI knocks here, over loopback, with the token it already
// holds, and the leg is replaced in place. That is the whole reason
// `flue relay setup` no longer ends with "now restart the daemon".
//
// It takes no parameters and cannot be told which relay to dial: the answer is
// always "whatever relay.json says", which is what makes it safe to expose to
// a command that has just written that file. A machine with no relay.json gets
// its leg stopped, which is `flue relay leave` completing itself.
func (s *relayUIService) Reload(ctx context.Context) (daemon.RelayUIDeployResult, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	cfg, ok, err := config.LoadRelay()
	if err != nil {
		return daemon.RelayUIDeployResult{}, err
	}
	if !ok {
		// Nothing to dial. Stopping is the honest half of `flue relay leave`,
		// and a daemon that had no leg either way says so in one line.
		if s.runtime.stopNow() {
			s.logf().Info("relay leg stopped after relay.json was removed")
			return daemon.RelayUIDeployResult{Steps: []string{"relay leg stopped; nothing outside this computer reaches this machine now"}}, nil
		}
		return daemon.RelayUIDeployResult{Steps: []string{"no relay is configured on this machine; nothing to dial"}}, nil
	}
	if !s.runtime.restart() {
		// The file is there and the leg refused it. That is a fault worth a
		// sentence rather than a silence, and relayProblems is the one place
		// that names such faults for every surface flue has.
		steps := []string{"the daemon could not dial " + cfg.URL}
		if problems := relayProblems(cfg); len(problems) > 0 {
			steps = append(steps, "relay.json is not usable ("+strings.Join(problems, ", ")+")")
		}
		s.logf().Warn("relay leg not started on reload", "url", cfg.URL)
		return daemon.RelayUIDeployResult{Steps: steps, Origin: cfg.Origin}, nil
	}
	s.logf().Info("relay leg restarted from the current relay.json", "url", cfg.URL)
	return daemon.RelayUIDeployResult{
		Steps:  []string{"the running daemon picked up the new configuration and is dialling " + cfg.URL},
		Origin: cfg.Origin,
	}, nil
}

// JoinCommand rebuilds the hand-off line from relay.json. The "shown once"
// property belongs to the CLI's terminal, not to the secret: the daemon holds
// it in relay.json regardless, and a user adding machine two a month after
// deploying should not need a redeploy to get the line back.
func (s *relayUIService) JoinCommand(ctx context.Context) (string, bool, error) {
	cfg, ok, err := config.LoadRelay()
	if err != nil || !ok {
		return "", false, err
	}
	if cfg.Secret == "" || cfg.FleetSeed == "" {
		// A relay.json without a secret cannot join anything, and one
		// without a fleet key cannot be joined faithfully: join requires
		// --fleet, and a line rebuilt without it would be one the command
		// refuses. A file missing the seed predates the fleet key, and the
		// path back is re-running setup — which mints one and makes this
		// answer true again — not a synthesized line.
		return "", false, nil
	}
	host := strings.TrimPrefix(cfg.URL, "wss://")
	return joinCommand(host, cfg.Secret, cfg.FleetSeed), true, nil
}

func (s *relayUIService) Update(ctx context.Context, req daemon.RelayUIDeployRequest) (daemon.RelayUIDeployResult, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if ok, reason := canDeploy(); !ok {
		return daemon.RelayUIDeployResult{}, fmt.Errorf("%w: %s", daemon.ErrRelayUIBadRequest, reason)
	}
	cfg, ok, err := config.LoadRelay()
	if err != nil {
		return daemon.RelayUIDeployResult{}, err
	}
	if !ok {
		return daemon.RelayUIDeployResult{}, fmt.Errorf("%w: no relay is configured on this machine; deploying one is setup's job", daemon.ErrRelayUIBadRequest)
	}
	worker, err := updateWorkerName(req.Worker, cfg)
	if err != nil {
		return daemon.RelayUIDeployResult{}, fmt.Errorf("%w: %s", daemon.ErrRelayUIBadRequest, err.Error())
	}
	assets, err := webAssets()
	if err != nil {
		return daemon.RelayUIDeployResult{}, err
	}

	token, fromRequest, err := resolveToken(req.Token)
	if err != nil {
		return daemon.RelayUIDeployResult{}, err
	}
	chosen := req.AccountID
	if chosen == "" && !fromRequest {
		// A stored credential remembers its account; an update with neither a
		// typed token nor a chosen account should not meet a picker.
		chosen = storedAccountID()
	}
	var steps []string
	api := s.client(token)
	account, ask, err := s.resolveAccount(ctx, api, chosen, &steps)
	if err != nil {
		return daemon.RelayUIDeployResult{}, err
	}
	if ask != nil {
		return *ask, nil
	}

	if err := relaydeploy.Deploy(relaydeploy.Input{
		API:          api,
		AccountID:    account.ID,
		Worker:       worker,
		Module:       relaybundle.Module(),
		Assets:       assets,
		AssetHeaders: relayAssetHeaders,
		Version:      deployStamp(),
		OnStep:       func(line string) { steps = append(steps, line) },
	}); err != nil {
		return daemon.RelayUIDeployResult{}, err
	}
	steps = append(steps, "secret, machine ids and pairings unchanged")
	if fromRequest {
		if err := config.SaveCloudflare(config.Cloudflare{Token: token, AccountID: account.ID, AccountName: account.Name}); err != nil {
			steps = append(steps, "could not store the token: "+err.Error())
		} else {
			steps = append(steps, "token stored for one-click updates")
		}
	}
	// Same note as Provision's: the deploy succeeded, so Status may say so
	// without waiting for the edge to agree.
	s.recordShipped(cfg.Origin)
	s.logf().Info("relay updated from the UI", "worker", worker)
	return daemon.RelayUIDeployResult{Steps: steps, Origin: cfg.Origin}, nil
}
