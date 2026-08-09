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
// running, and how to start one. It exists for the first-deploy moment: a
// daemon that booted with no relay.json should start dialling the relay the
// user just deployed without being restarted — and a daemon whose transport
// is already up must NOT be given a second one, so a re-deploy reports
// RestartNeeded instead.
type relayRuntime struct {
	mu      sync.Mutex
	running bool
	start   func() bool
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
	rt.running = rt.start()
	return rt.running, false
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
	if err := config.SaveRelay(config.Relay{
		URL:         "wss://" + host,
		Secret:      secret,
		FleetSeed:   fleetKey.Seed(),
		Origin:      "https://" + host,
		MachineID:   machineID,
		MachineName: machineName,
		Worker:      worker,
	}); err != nil {
		return daemon.RelayUIDeployResult{}, fmt.Errorf("save the relay configuration: %w", err)
	}
	steps = append(steps, "fleet key minted (stays on your machines; Cloudflare never sees it)")
	steps = append(steps, fmt.Sprintf("this machine joined as %s (%s)", machineName, machineID))

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
	if started, already := s.runtime.startOnce(); already {
		// A transport is already up, dialling whatever relay.json said when it
		// started. The new file wins on the next daemon start, and saying so
		// beats silently running against the old relay.
		res.RestartNeeded = true
	} else if started {
		res.Steps = append(res.Steps, "daemon connecting to the relay")
	}
	// Remember what shipped and where: Status answers from this while the
	// edge catches up, instead of trusting a health read that briefly still
	// says the previous deploy.
	s.recordShipped(res.Origin)
	s.logf().Info("relay deployed from the UI", "worker", worker, "host", host, "restartNeeded", res.RestartNeeded)
	return res, nil
}

// joinCommand is the one spelling of the hand-off line, shared by the CLI's
// setup print, the deploy result and the join endpoint so the three can
// never drift. It carries the secret and the fleet key seed, which is the
// line's whole point and its whole weight: docs/RELAY.md and
// spec/fleet-trust.md both say what leaking it now costs.
func joinCommand(host, secret, fleetSeed string) string {
	return fmt.Sprintf("flue relay join wss://%s --secret %s --fleet %s", host, secret, fleetSeed)
}

// SetAddress is `flue relay address` behind the card: the user routed a
// custom domain to the Worker in the Cloudflare dashboard, and this repoints
// relay.json at it. URL and origin only; worker, secret and machine id stay,
// because the Worker behind the name is the same one. What does not stay is
// any existing pairing — the daemon serves exactly the origin it dials, so
// every browser paired on the old one must pair again on the new address
// (see runRelayAddress), and the second step line carries that truth to the
// card. The shipped-deploy memory keys on the origin, so a repoint sends
// Status back to asking the relay itself: the Worker behind the new name
// should be the same one, but that is the health read's fact to confirm,
// not memory's to assume.
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
	s.logf().Info("relay address changed from the UI", "host", host)
	return daemon.RelayUIDeployResult{
		Steps: []string{
			"relay address is now wss://" + host,
			"every browser paired on the old origin must pair again on the new address",
		},
		Origin: "https://" + host,
		// The transport dialling right now read the old file at startup.
		RestartNeeded: true,
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
