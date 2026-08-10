package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/karnstack/flue/internal/cloudflare"
	"github.com/karnstack/flue/internal/config"
	"github.com/karnstack/flue/internal/daemon"
	"github.com/karnstack/flue/internal/fleet"
)

// The service behind the Remote screen is the same deploy the CLI performs,
// so these tests drive it against the same fake Cloudflare and assert the
// same facts — plus the two things only the service does: answer the account
// question as data instead of a prompt, and start the transport in-process.

func uiService(f *fakeCloudflare, rt *relayRuntime) *relayUIService {
	return &relayUIService{runtime: rt, base: f.srv.URL}
}

// alwaysStarts is a transport that comes up and can be taken down again, for
// the cases that care about the deploy rather than the leg. The real one is
// cmdServe's, which cancels the relay's own context (see forgetRelay).
func alwaysStarts() (bool, func()) { return true, func() {} }

func TestRelayUIProvisionDeploysAndStartsTheTransport(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	f := newFakeCloudflare(t, oneAccount(), "karn")

	started := 0
	rt := &relayRuntime{start: func() (bool, func()) { started++; return true, func() {} }}
	svc := uiService(f, rt)

	res, err := svc.Provision(context.Background(), daemon.RelayUIDeployRequest{Token: setupToken})
	if err != nil {
		t.Fatalf("Provision: %v", err)
	}
	if res.NeedsAccount {
		t.Fatal("one account still produced the account question")
	}
	joined := strings.Join(res.Steps, "\n")
	for _, want := range []string{"token verified", "worker deployed: " + relayScriptName, "secret set", "daemon connecting to the relay"} {
		if !strings.Contains(joined, want) {
			t.Errorf("steps are missing %q:\n%s", want, joined)
		}
	}
	if started != 1 || !rt.running {
		t.Fatalf("transport starts = %d, running = %v; want exactly one start", started, rt.running)
	}
	if res.RestartNeeded {
		t.Fatal("a first deploy demanded a restart")
	}

	cfg, ok, err := config.LoadRelay()
	if err != nil || !ok {
		t.Fatalf("LoadRelay: ok=%v err=%v", ok, err)
	}
	if cfg.Worker != relayScriptName || cfg.Secret == "" {
		t.Fatalf("relay.json = %+v; want the default worker and a secret", cfg)
	}
	// The fleet key is persisted here or the machines that join off this
	// deploy have no relay leg at all: relay.New refuses a config without
	// one, and JoinCommand refuses to spell a line without one. Checked
	// against fleet.Parse rather than for emptiness so a garbled value is
	// caught here rather than on the machine it was pasted into.
	if _, err := fleet.Parse(cfg.FleetSeed); err != nil {
		t.Fatalf("relay.json fleet_seed = %q, want a key fleet.Parse accepts: %v", cfg.FleetSeed, err)
	}
	// Both credentials in the line, because both are what the other machine
	// needs — the address and the secret alone is the line `flue relay join`
	// now refuses.
	if !strings.Contains(res.JoinCommand, "flue relay join wss://") ||
		!strings.Contains(res.JoinCommand, "--secret "+cfg.Secret) ||
		!strings.Contains(res.JoinCommand, "--fleet "+cfg.FleetSeed) {
		t.Fatalf("join command %q does not carry the address, the secret and the fleet key", res.JoinCommand)
	}
	// Stored in exactly one place — cloudflare.json — never in relay.json and
	// never echoed into steps.
	hits := configFilesContaining(t, setupToken)
	if len(hits) != 1 || filepath.Base(hits[0]) != "cloudflare.json" {
		t.Fatalf("the API token should be in cloudflare.json and nowhere else, got %v", hits)
	}
	if strings.Contains(joined, setupToken) {
		t.Fatal("the token appears in the steps")
	}
}

func TestRelayUIUpdateUsesTheStoredToken(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	f := newFakeCloudflare(t, twoAccounts(), "karn")
	svc := uiService(f, &relayRuntime{start: alwaysStarts})

	// Deploy with a typed token and a chosen account; both get stored.
	if _, err := svc.Provision(context.Background(), daemon.RelayUIDeployRequest{Token: setupToken, AccountID: twoAccounts()[0].ID}); err != nil {
		t.Fatalf("Provision: %v", err)
	}

	// Update with an empty token: the stored credential answers, and the
	// stored account skips the picker even though the token reaches two.
	res, err := svc.Update(context.Background(), daemon.RelayUIDeployRequest{})
	if err != nil {
		t.Fatalf("Update with stored token: %v", err)
	}
	if res.NeedsAccount {
		t.Fatal("the stored account should have skipped the picker")
	}
	if !strings.Contains(strings.Join(res.Steps, "\n"), "worker deployed") {
		t.Fatalf("update did not deploy: %v", res.Steps)
	}
}

func TestRelayUIProvisionAsksWhichAccountAndDeploysNothing(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	f := newFakeCloudflare(t, twoAccounts(), "karn")
	svc := uiService(f, &relayRuntime{start: alwaysStarts})

	res, err := svc.Provision(context.Background(), daemon.RelayUIDeployRequest{Token: setupToken})
	if err != nil {
		t.Fatalf("Provision: %v", err)
	}
	if !res.NeedsAccount || len(res.Accounts) != 2 {
		t.Fatalf("result = %+v; want the two-account question", res)
	}
	if f.scriptPuts != 0 {
		t.Fatalf("the account question was accompanied by %d deploys", f.scriptPuts)
	}
	if _, ok, _ := config.LoadRelay(); ok {
		t.Fatal("relay.json exists before an account was chosen")
	}

	// Answering deploys.
	res, err = svc.Provision(context.Background(), daemon.RelayUIDeployRequest{Token: setupToken, AccountID: twoAccounts()[1].ID})
	if err != nil {
		t.Fatalf("Provision with account: %v", err)
	}
	if res.NeedsAccount || f.scriptPuts == 0 {
		t.Fatalf("choosing an account did not deploy (res=%+v, puts=%d)", res, f.scriptPuts)
	}
}

func TestRelayUIProvisionOnARunningTransportSaysRestart(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	f := newFakeCloudflare(t, oneAccount(), "karn")
	rt := &relayRuntime{running: true, start: func() (bool, func()) { t.Fatal("a second transport was started"); return false, nil }}
	svc := uiService(f, rt)

	res, err := svc.Provision(context.Background(), daemon.RelayUIDeployRequest{Token: setupToken})
	if err != nil {
		t.Fatalf("Provision: %v", err)
	}
	if !res.RestartNeeded {
		t.Fatal("re-deploying under a live transport did not ask for a restart")
	}
}

func TestRelayUIUpdateRotatesNothing(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	f := newFakeCloudflare(t, oneAccount(), "karn")
	svc := uiService(f, &relayRuntime{running: true})

	// Seed with the CLI's setup, the way a real machine got configured.
	var out strings.Builder
	if err := runRelaySetup(&out, strings.NewReader(setupToken+"\n"), f.client(), nil); err != nil {
		t.Fatalf("runRelaySetup: %v", err)
	}
	before, err := os.ReadFile(filepath.Join(os.Getenv("XDG_CONFIG_HOME"), "flue", "relay.json"))
	if err != nil {
		t.Fatalf("reading relay.json: %v", err)
	}

	res, err := svc.Update(context.Background(), daemon.RelayUIDeployRequest{Token: setupToken})
	if err != nil {
		t.Fatalf("Update: %v", err)
	}
	if f.secretPuts != 1 {
		t.Fatalf("secret puts = %d; update must not touch the secret", f.secretPuts)
	}
	after, _ := os.ReadFile(filepath.Join(os.Getenv("XDG_CONFIG_HOME"), "flue", "relay.json"))
	if string(before) != string(after) {
		t.Fatal("update rewrote relay.json")
	}
	if !strings.Contains(strings.Join(res.Steps, "\n"), "secret, machine ids and pairings unchanged") {
		t.Fatalf("update's steps do not state what was preserved: %v", res.Steps)
	}
}

func TestRelayUIUpdateWithoutARelayIsABadRequest(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	f := newFakeCloudflare(t, oneAccount(), "karn")
	svc := uiService(f, &relayRuntime{})

	_, err := svc.Update(context.Background(), daemon.RelayUIDeployRequest{Token: setupToken})
	if err == nil || !strings.Contains(err.Error(), "no relay is configured") {
		t.Fatalf("err = %v; want the no-relay refusal", err)
	}
}

func TestRelayUIStatusReportsTheDeployedVersion(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())

	health := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/health" {
			http.NotFound(w, r)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "version": "9.9.9"})
	}))
	t.Cleanup(health.Close)

	if err := config.SaveRelay(config.Relay{
		URL:       "wss://flue-relay.karn.workers.dev",
		Secret:    "s",
		Origin:    health.URL,
		MachineID: "m-1",
		Worker:    "flue-relay",
	}); err != nil {
		t.Fatalf("SaveRelay: %v", err)
	}

	svc := &relayUIService{runtime: &relayRuntime{}}
	st := svc.Status(context.Background())
	if !st.Configured || st.Worker != "flue-relay" {
		t.Fatalf("status = %+v; want the configured relay", st)
	}
	if st.DeployedVersion != "9.9.9" {
		t.Fatalf("deployed version = %q, want 9.9.9", st.DeployedVersion)
	}
	if st.Version != deployStamp() {
		t.Fatalf("binary version = %q, want %q", st.Version, deployStamp())
	}
}

// staleHealth is a relay edge mid-propagation: whatever was just deployed,
// /api/health still answers with the previous deploy's stamp — which is what
// a real relay does for seconds, occasionally longer, after every deploy.
func staleHealth(t *testing.T) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/health" {
			http.NotFound(w, r)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "version": "0.0.0-previous"})
	}))
	t.Cleanup(srv.Close)
	return srv
}

// seedRelayAt writes the relay.json of a machine already joined to a relay
// whose origin is the given server — the state the update card renders from.
func seedRelayAt(t *testing.T, origin string) {
	t.Helper()
	if err := config.SaveRelay(config.Relay{
		URL:       "wss://flue-relay.karn.workers.dev",
		Secret:    "s",
		Origin:    origin,
		MachineID: "m-1",
		Worker:    relayScriptName,
	}); err != nil {
		t.Fatalf("SaveRelay: %v", err)
	}
}

// TestRelayUIStatusTrustsItsOwnDeployWhileTheEdgeCatchesUp is the repro that
// earned the service its memory: deploy, watch every checkmark land, and the
// card underneath still says "update the relay" — because Cloudflare's API
// accepted the new Worker while the edge kept serving the old one, previous
// stamp and all, and Status believed the edge. The user obliges and
// redeploys identical bytes; time was the actual fix. After a successful
// deploy the service's own memory answers instead.
func TestRelayUIStatusTrustsItsOwnDeployWhileTheEdgeCatchesUp(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	f := newFakeCloudflare(t, oneAccount(), "karn")
	stale := staleHealth(t)
	seedRelayAt(t, stale.URL)
	svc := uiService(f, &relayRuntime{running: true})

	// Before this process has deployed anything, the health read decides —
	// its differing stamp is what puts the update card up at all.
	if st := svc.Status(context.Background()); st.DeployedVersion != "0.0.0-previous" {
		t.Fatalf("deployed version before deploying = %q, want the health read's 0.0.0-previous", st.DeployedVersion)
	}

	if _, err := svc.Update(context.Background(), daemon.RelayUIDeployRequest{Token: setupToken}); err != nil {
		t.Fatalf("Update: %v", err)
	}

	// The edge still answers the previous stamp; Status must not believe it.
	if st := svc.Status(context.Background()); st.DeployedVersion != deployStamp() {
		t.Fatalf("deployed version right after a successful deploy = %q, want this binary's %q", st.DeployedVersion, deployStamp())
	}

	// Provision remembers the same way: a first deploy's Status answers from
	// memory too, without dialling the fresh workers.dev origin at all.
	if _, err := svc.Provision(context.Background(), daemon.RelayUIDeployRequest{Token: setupToken}); err != nil {
		t.Fatalf("Provision: %v", err)
	}
	if st := svc.Status(context.Background()); st.DeployedVersion != deployStamp() {
		t.Fatalf("deployed version right after a provision = %q, want %q", st.DeployedVersion, deployStamp())
	}
}

// TestRelayUIFailedUpdateLeavesTheHealthReadInCharge: a deploy the API
// refused changed nothing at the edge, so it earns no memory — the card
// keeps offering exactly what the health read supports.
func TestRelayUIFailedUpdateLeavesTheHealthReadInCharge(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	f := newFakeCloudflare(t, oneAccount(), "karn")
	f.reject["/scripts/"+relayScriptName] = "computer says no"
	stale := staleHealth(t)
	seedRelayAt(t, stale.URL)
	svc := uiService(f, &relayRuntime{running: true})

	if _, err := svc.Update(context.Background(), daemon.RelayUIDeployRequest{Token: setupToken}); err == nil {
		t.Fatal("the rejected deploy reported success")
	}
	if st := svc.Status(context.Background()); st.DeployedVersion != "0.0.0-previous" {
		t.Fatalf("deployed version after a failed deploy = %q, want the health read's 0.0.0-previous", st.DeployedVersion)
	}
}

// TestRelayUIStaleShipMemoryLosesToTheHealthRead pins the two ways the
// memory expires. A binary whose stamp changed no longer ships what the
// memory says was shipped — in practice a rebuilt daemon, whose restart
// drops the memory anyway; the guard states the invariant without leaning on
// the restart. And an origin that moved on names a relay this process never
// deployed to. Both must yield to the health read, so a genuinely newer
// build still gets its update card.
func TestRelayUIStaleShipMemoryLosesToTheHealthRead(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	f := newFakeCloudflare(t, oneAccount(), "karn")
	stale := staleHealth(t)
	seedRelayAt(t, stale.URL)
	svc := uiService(f, &relayRuntime{running: true})

	if _, err := svc.Update(context.Background(), daemon.RelayUIDeployRequest{Token: setupToken}); err != nil {
		t.Fatalf("Update: %v", err)
	}

	// The rebuilt-binary shape: the memory holds a stamp this binary would
	// not ship. (A test cannot rebuild itself, so it plants the mismatch.)
	svc.shippedMu.Lock()
	svc.shippedStamp = "dev-some-other-build"
	svc.shippedMu.Unlock()
	if st := svc.Status(context.Background()); st.DeployedVersion != "0.0.0-previous" {
		t.Fatalf("deployed version under a stale stamp = %q, want the health read's 0.0.0-previous", st.DeployedVersion)
	}

	// The moved-origin shape, through the real path: deploy again (memory
	// back in force), then repoint the address. The new origin answers no
	// health read — port 1 refuses instantly — and the memory, keyed to the
	// origin it shipped to, must not answer for it.
	if _, err := svc.Update(context.Background(), daemon.RelayUIDeployRequest{Token: setupToken}); err != nil {
		t.Fatalf("second Update: %v", err)
	}
	if st := svc.Status(context.Background()); st.DeployedVersion != deployStamp() {
		t.Fatalf("deployed version after re-deploying = %q, want %q", st.DeployedVersion, deployStamp())
	}
	if _, err := svc.SetAddress(context.Background(), "wss://127.0.0.1:1"); err != nil {
		t.Fatalf("SetAddress: %v", err)
	}
	if st := svc.Status(context.Background()); st.DeployedVersion != "" {
		t.Fatalf("deployed version after repointing = %q, want empty: neither memory nor a health read can speak for the new origin", st.DeployedVersion)
	}
}

// twoAccounts mirrors oneAccount for the picker tests.
func twoAccounts() []cloudflare.Account {
	return []cloudflare.Account{
		{ID: "acct-1111111111", Name: "personal"},
		{ID: "acct-2222222222", Name: "work"},
	}
}

func TestRelayUIJoinCommandRebuildsTheHandOffLine(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	svc := &relayUIService{runtime: &relayRuntime{}}

	// Unconfigured: no line, not an error.
	if _, ok, err := svc.JoinCommand(context.Background()); ok || err != nil {
		t.Fatalf("JoinCommand with no relay = ok %v err %v; want quiet false", ok, err)
	}

	if err := config.SaveRelay(config.Relay{
		URL:       "wss://flue-relay-dev.karn.workers.dev",
		Secret:    "fleet-s3cret",
		Origin:    "https://flue-relay-dev.karn.workers.dev",
		MachineID: "m-1",
		Worker:    "flue-relay-dev",
		FleetSeed: testFleetSeed,
	}); err != nil {
		t.Fatalf("SaveRelay: %v", err)
	}
	cmd, ok, err := svc.JoinCommand(context.Background())
	if err != nil || !ok {
		t.Fatalf("JoinCommand: ok %v err %v", ok, err)
	}
	if cmd != "flue relay join wss://flue-relay-dev.karn.workers.dev --secret fleet-s3cret --fleet "+testFleetSeed {
		t.Fatalf("join command = %q", cmd)
	}
}

// TestRelayUIJoinCommandStaysQuietWithoutAFleetKey: a relay.json from before
// the fleet key exists cannot produce a faithful line — join refuses one
// without --fleet — so the card offers nothing rather than a command that
// would be refused on the machine it was pasted into.
func TestRelayUIJoinCommandStaysQuietWithoutAFleetKey(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	svc := &relayUIService{runtime: &relayRuntime{}}

	if err := config.SaveRelay(config.Relay{
		URL:       "wss://flue-relay-dev.karn.workers.dev",
		Secret:    "fleet-s3cret",
		Origin:    "https://flue-relay-dev.karn.workers.dev",
		MachineID: "m-1",
		Worker:    "flue-relay-dev",
	}); err != nil {
		t.Fatalf("SaveRelay: %v", err)
	}
	if cmd, ok, err := svc.JoinCommand(context.Background()); ok || err != nil {
		t.Fatalf("JoinCommand without a fleet key = %q ok %v err %v; want quiet false", cmd, ok, err)
	}
}

// TestRelayUILeaveStopsTheTransportAndKeepsTheRest is the Remote screen's
// Disconnect: the file goes, the leg goes with it in this same process, and
// nothing else does.
//
// The stop is the half the CLI cannot do — it deletes a file in another process
// and has to ask for a restart — and it is the half that makes the screen's
// claim true. A card that said "you have left the relay" over a live socket
// would be the one lie this feature is able to tell.
func TestRelayUILeaveStopsTheTransportAndKeepsTheRest(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	f := newFakeCloudflare(t, oneAccount(), "karn")

	stops := 0
	rt := &relayRuntime{start: func() (bool, func()) { return true, func() { stops++ } }}
	svc := uiService(f, rt)

	// Deploy first, so this is a machine that is genuinely on a relay with a
	// transport up and a stored token — the state Disconnect is offered in.
	if _, err := svc.Provision(context.Background(), daemon.RelayUIDeployRequest{Token: setupToken}); err != nil {
		t.Fatalf("Provision: %v", err)
	}
	if !rt.running {
		t.Fatal("the deploy did not start a transport; there is no stop to test")
	}

	res, err := svc.Leave(context.Background())
	if err != nil {
		t.Fatalf("Leave: %v", err)
	}
	if stops != 1 || rt.running {
		t.Fatalf("transport stops = %d, running = %v; want exactly one stop", stops, rt.running)
	}
	if _, ok, _ := config.LoadRelay(); ok {
		t.Fatal("relay.json survived the leave")
	}
	joined := strings.Join(res.Steps, "\n")
	for _, want := range []string{
		"relay.json deleted",
		"relay leg stopped",
		// The Worker is not this action's to undeploy, and a user who assumes
		// otherwise is one who thinks they have stopped paying for something.
		"still deployed in your Cloudflare account",
		// And the three things a "leave" might be read as taking with it.
		"paired devices",
		"Cloudflare token",
		"new id",
	} {
		if !strings.Contains(joined, want) {
			t.Errorf("the leave's steps never say %q:\n%s", want, joined)
		}
	}
	// The stored credential is a credential for an account, not for a relay:
	// it deploys and updates any relay in that account, and the connect card
	// documents deleting cloudflare.json as the way to forget it. Leaving a
	// relay takes no view on it.
	if _, ok, err := config.LoadCloudflare(); !ok || err != nil {
		t.Fatalf("the stored Cloudflare token did not survive the leave: ok=%v err=%v", ok, err)
	}
	// And the screen's answer agrees: nothing configured, no origin, no
	// problems to report about a file that is not there.
	if st := svc.Status(context.Background()); st.Configured || st.Origin != "" || len(st.Problems) != 0 {
		t.Fatalf("status after leaving = %+v; want an unconfigured machine", st)
	}
	// Its account is still named, because the token is still stored — that is
	// what makes deploying a new relay one click rather than a trip to the
	// token page.
	if st := svc.Status(context.Background()); !st.HasToken {
		t.Fatal("status after leaving reports no stored token")
	}
}

// TestRelayUILeaveWithNoTransportClaimsNoStop: a daemon that booted without a
// relay and had one written under it by hand has a file and no leg. Leaving
// deletes the file and must not report stopping something that was never up.
func TestRelayUILeaveWithNoTransportClaimsNoStop(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	svc := &relayUIService{runtime: &relayRuntime{}}
	seedRelayAt(t, "https://flue-relay.karn.workers.dev")

	res, err := svc.Leave(context.Background())
	if err != nil {
		t.Fatalf("Leave: %v", err)
	}
	if strings.Contains(strings.Join(res.Steps, "\n"), "relay leg stopped") {
		t.Fatalf("a leave with no transport claimed to have stopped one: %v", res.Steps)
	}
	if _, ok, _ := config.LoadRelay(); ok {
		t.Fatal("relay.json survived the leave")
	}
}

// TestRelayUILeaveWithoutARelayIsABadRequest: the same refusal the CLI gives,
// as a 400 rather than a 502 — the caller asked for something that does not
// apply, and nothing failed.
func TestRelayUILeaveWithoutARelayIsABadRequest(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	svc := &relayUIService{runtime: &relayRuntime{running: true, start: alwaysStarts}}

	_, err := svc.Leave(context.Background())
	if err == nil || !errors.Is(err, daemon.ErrRelayUIBadRequest) {
		t.Fatalf("Leave with no relay = %v; want a bad request", err)
	}
	if !strings.Contains(err.Error(), "nothing to leave") {
		t.Fatalf("Leave's refusal = %q", err)
	}
	// And it changed nothing on the way to refusing.
	if !svc.runtime.running {
		t.Fatal("a refused leave stopped the transport anyway")
	}
}

func TestRelayAddressRepointsWithoutReminting(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	f := newFakeCloudflare(t, oneAccount(), "karn")

	var out strings.Builder
	if err := runRelaySetup(&out, strings.NewReader(setupToken+"\n"), f.client(), nil); err != nil {
		t.Fatalf("runRelaySetup: %v", err)
	}
	before, _, _ := config.LoadRelay()

	// The CLI spelling.
	out.Reset()
	if err := runRelayAddress(&out, []string{"wss://relay.example.com"}); err != nil {
		t.Fatalf("runRelayAddress: %v", err)
	}
	cfg, _, _ := config.LoadRelay()
	if cfg.URL != "wss://relay.example.com" || cfg.Origin != "https://relay.example.com" {
		t.Fatalf("address = %q / %q, want the custom domain", cfg.URL, cfg.Origin)
	}
	if cfg.Secret != before.Secret || cfg.MachineID != before.MachineID || cfg.Worker != before.Worker {
		t.Fatal("changing the address re-minted something it must not touch")
	}

	// The service spelling, and its refusals.
	svc := &relayUIService{runtime: &relayRuntime{running: true}}
	res, err := svc.SetAddress(context.Background(), "https://relay2.example.com")
	if err != nil {
		t.Fatalf("SetAddress: %v", err)
	}
	if !res.RestartNeeded {
		t.Fatal("a live transport dials the old address; the result must say restart")
	}
	cfg, _, _ = config.LoadRelay()
	if cfg.URL != "wss://relay2.example.com" {
		t.Fatalf("URL = %q after SetAddress", cfg.URL)
	}
	if _, err := svc.SetAddress(context.Background(), "ftp://nope"); err == nil {
		t.Fatal("a non-wss address was accepted")
	}
}
