package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/karnstack/flue/internal/cloudflare"
	"github.com/karnstack/flue/internal/config"
	"github.com/karnstack/flue/internal/daemon"
	"github.com/karnstack/flue/internal/fleet"
	"github.com/karnstack/flue/internal/session"
	"github.com/karnstack/flue/internal/transport/local"
)

// The service behind the Remote screen is the same deploy the CLI performs,
// so these tests drive it against the same fake Cloudflare and assert the
// same facts — plus the two things only the service does: answer the account
// question as data instead of a prompt, and start the transport in-process.

func uiService(f *fakeCloudflare, rt *relayRuntime) *relayUIService {
	return &relayUIService{runtime: rt, base: f.srv.URL}
}

// serveWithRelayUI is a real daemon on loopback with a relay service behind
// its /api/relay endpoints — the daemon a CLI command in another process finds
// through the runtime record and talks to over the loopback token. A nil
// service leaves those endpoints 404, which is what a build from before them
// looks like from the outside.
func serveWithRelayUI(t *testing.T, token string, ui daemon.RelayUI) int {
	t.Helper()
	srv := daemon.New(session.NewRegistry(time.Now), local.NewAuth(token, 0), uiHandler(), version, daemon.Identity{})
	if ui != nil {
		srv.SetRelayUI(ui)
	}
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)
	t.Cleanup(srv.Shutdown)
	u, err := url.Parse(ts.URL)
	if err != nil {
		t.Fatalf("parse %q: %v", ts.URL, err)
	}
	port, err := strconv.Atoi(u.Port())
	if err != nil {
		t.Fatalf("port of %q: %v", ts.URL, err)
	}
	// The Host allowlist is port-specific and the port is only known now.
	srv.SetAuth(local.NewAuth(token, port))
	return port
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
	// Nothing on a deploy result may send the user to a terminal to restart
	// their daemon: the leg is replaced in this process and the fleet key is
	// read from the file at every signature. This is pinned as a string search
	// because the old warning was a step line, not a flag.
	if strings.Contains(joined, "restart") {
		t.Errorf("a deploy still asks for a restart:\n%s", joined)
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

// TestRelayUIProvisionReplacesALiveTransport: a second deploy used to be the
// end of the road for this process. The leg was dialling the relay.json that
// existed when it started, the deploy had just replaced that file — new
// secret, new machine id, new fleet key — and the only answer the screen had
// was "restart the daemon", with a window in between where a phone paired here
// got a phone that could never roam.
//
// So the leg is replaced instead, and in the one order that is safe: the old
// one is stopped and waited for before the new one dials, because two legs on
// one relay is a Durable Object closing the working socket in favour of the
// newcomer (relay/src/hub.ts).
func TestRelayUIProvisionReplacesALiveTransport(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	f := newFakeCloudflare(t, oneAccount(), "karn")

	var order []string
	rt := &relayRuntime{
		running: true,
		stop:    func() { order = append(order, "stop") },
		start: func() (bool, func()) {
			order = append(order, "start")
			return true, func() {}
		},
	}
	svc := uiService(f, rt)

	res, err := svc.Provision(context.Background(), daemon.RelayUIDeployRequest{Token: setupToken})
	if err != nil {
		t.Fatalf("Provision: %v", err)
	}
	if len(order) != 2 || order[0] != "stop" || order[1] != "start" {
		t.Fatalf("leg lifecycle = %v, want the old leg stopped and then a new one started", order)
	}
	if !rt.running {
		t.Fatal("no leg is running after a deploy")
	}
	joined := strings.Join(res.Steps, "\n")
	if strings.Contains(joined, "restart") {
		t.Errorf("re-deploying still asks for a restart:\n%s", joined)
	}
	if !strings.Contains(joined, "daemon connecting to the relay") {
		t.Errorf("steps do not say the daemon is dialling the new relay:\n%s", joined)
	}
}

// TestRelayUIReloadFollowsRelayJSON is the hook the CLI knocks on: `flue relay
// setup` in a terminal writes relay.json from a process of its own, and the
// daemon that has been running since login has to end up dialling it without
// anybody restarting anything.
func TestRelayUIReloadFollowsRelayJSON(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	f := newFakeCloudflare(t, oneAccount(), "karn")

	// A daemon with no relay at all: reload has nothing to dial and says so.
	rt := &relayRuntime{start: alwaysStarts}
	svc := uiService(f, rt)
	res, err := svc.Reload(context.Background())
	if err != nil {
		t.Fatalf("Reload with no relay.json: %v", err)
	}
	if rt.running {
		t.Fatal("reload started a leg with no relay.json to dial")
	}
	if !strings.Contains(strings.Join(res.Steps, "\n"), "no relay is configured") {
		t.Errorf("steps = %v, want the no-relay answer", res.Steps)
	}

	// The other terminal writes one.
	var out strings.Builder
	if err := runRelaySetup(&out, strings.NewReader(setupToken+"\n"), f.client(), nil); err != nil {
		t.Fatalf("runRelaySetup: %v", err)
	}
	cfg, _, _ := config.LoadRelay()

	res, err = svc.Reload(context.Background())
	if err != nil {
		t.Fatalf("Reload: %v", err)
	}
	if !rt.running {
		t.Fatal("the daemon did not start dialling the relay the CLI just configured")
	}
	if !strings.Contains(strings.Join(res.Steps, "\n"), cfg.URL) {
		t.Errorf("steps = %v, want the relay it is now dialling (%s)", res.Steps, cfg.URL)
	}

	// And `flue relay leave` from a terminal: the file is gone, so the leg goes
	// with it rather than the user being told to restart.
	if err := config.DeleteRelay(); err != nil {
		t.Fatalf("DeleteRelay: %v", err)
	}
	res, err = svc.Reload(context.Background())
	if err != nil {
		t.Fatalf("Reload after leave: %v", err)
	}
	if rt.running {
		t.Fatal("the relay leg outlived the relay.json that configured it")
	}
	if !strings.Contains(strings.Join(res.Steps, "\n"), "relay leg stopped") {
		t.Errorf("steps = %v, want the stopped leg said out loud", res.Steps)
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
	var order []string
	svc := &relayUIService{runtime: &relayRuntime{
		running: true,
		stop:    func() { order = append(order, "stop") },
		start: func() (bool, func()) {
			order = append(order, "start")
			return true, func() {}
		},
	}}
	res, err := svc.SetAddress(context.Background(), "https://relay2.example.com")
	if err != nil {
		t.Fatalf("SetAddress: %v", err)
	}
	// The leg was dialling the old name. It dials the new one now, in this
	// process — the address is the one thing a repoint can actually fix
	// without help.
	if len(order) != 2 || order[0] != "stop" || order[1] != "start" {
		t.Fatalf("leg lifecycle = %v, want the old address dropped and the new one dialled", order)
	}
	joined := strings.Join(res.Steps, "\n")
	if strings.Contains(joined, "restart") {
		t.Errorf("a repoint still asks for a restart:\n%s", joined)
	}
	// What no restart fixes, and what the card must keep saying: a pairing
	// lives in a browser, keyed to the origin it was made on.
	if !strings.Contains(joined, "pair again") {
		t.Errorf("steps do not carry the pairing consequence:\n%s", joined)
	}
	cfg, _, _ = config.LoadRelay()
	if cfg.URL != "wss://relay2.example.com" {
		t.Fatalf("URL = %q after SetAddress", cfg.URL)
	}
	if _, err := svc.SetAddress(context.Background(), "ftp://nope"); err == nil {
		t.Fatal("a non-wss address was accepted")
	}
}

// TestRelayJoinFromTheCLIRestartsARunningDaemonsLeg is the two processes, in
// one test: a daemon serving on loopback, and `flue relay join` run beside it
// the way a user runs it — in a terminal, from a binary that shares nothing
// with the daemon but the config directory.
//
// The daemon's leg has to end up dialling the relay that join just wrote. It
// used to end up dialling whatever it had at startup, with "restart the
// daemon" printed as the way out, and every browser paired in between reaching
// a machine that could not roam.
func TestRelayJoinFromTheCLIRestartsARunningDaemonsLeg(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())

	token, err := config.LoadOrCreateToken()
	if err != nil {
		t.Fatalf("LoadOrCreateToken: %v", err)
	}
	legs := 0
	rt := &relayRuntime{start: func() (bool, func()) { legs++; return true, func() {} }}
	port := serveWithRelayUI(t, token, &relayUIService{runtime: rt})
	if err := daemon.WriteRuntime(port); err != nil {
		t.Fatalf("WriteRuntime: %v", err)
	}

	var out strings.Builder
	err = runRelayJoin(&out, []string{
		"wss://relay.example.com",
		"--secret", "s3cr3t-daemon-secret",
		"--fleet", testFleetSeed,
	})
	if err != nil {
		t.Fatalf("runRelayJoin: %v", err)
	}
	if legs != 1 || !rt.running {
		t.Fatalf("relay legs started = %d, running = %v; the daemon never picked up the join", legs, rt.running)
	}
	printed := out.String()
	if !strings.Contains(printed, "wss://relay.example.com") {
		t.Errorf("join does not report the daemon dialling the new relay:\n%s", printed)
	}
	if strings.Contains(printed, "flue disable && flue enable") {
		t.Errorf("join still tells the user to restart a daemon it just reconfigured:\n%s", printed)
	}
}

// TestRelayJoinKeepsTheRestartNoteForADaemonItCannotTell: the honest
// remainder. A daemon that is running and does not answer this endpoint —
// an older build, or one wedged — is the one case where a restart really is
// the way to make it dial the new relay, and the only case that may say so.
func TestRelayJoinKeepsTheRestartNoteForADaemonItCannotTell(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())

	token, err := config.LoadOrCreateToken()
	if err != nil {
		t.Fatalf("LoadOrCreateToken: %v", err)
	}
	// A daemon with no relay service wired: the endpoint 404s, exactly as a
	// build from before it existed would.
	port := serveWithRelayUI(t, token, nil)
	if err := daemon.WriteRuntime(port); err != nil {
		t.Fatalf("WriteRuntime: %v", err)
	}

	var out strings.Builder
	if err := runRelayJoin(&out, []string{
		"wss://relay.example.com",
		"--secret", "s3cr3t-daemon-secret",
		"--fleet", testFleetSeed,
	}); err != nil {
		t.Fatalf("runRelayJoin: %v", err)
	}
	printed := out.String()
	if !strings.Contains(printed, "could not be told") || !strings.Contains(printed, "flue disable && flue enable") {
		t.Errorf("a daemon that could not be told was not reported, so nothing tells the user to restart it:\n%s", printed)
	}
}

// reloadHint is the phrase the advice is recognised by. Short on purpose: the
// wording of relayReloadNote is prose and will be edited, and a test that
// pinned the paragraph would fail for every improvement to it.
const reloadHint = "reload any flue tab"

// runningDaemon puts a real daemon on loopback and records it, so that the CLI
// commands under test find one exactly as they do beside a `flue serve`.
func runningDaemon(t *testing.T) {
	t.Helper()
	token, err := config.LoadOrCreateToken()
	if err != nil {
		t.Fatalf("LoadOrCreateToken: %v", err)
	}
	rt := &relayRuntime{start: alwaysStarts}
	port := serveWithRelayUI(t, token, &relayUIService{runtime: rt})
	if err := daemon.WriteRuntime(port); err != nil {
		t.Fatalf("WriteRuntime: %v", err)
	}
}

// onARelay is the relay.json of a machine already joined to one, for the
// commands that edit an existing configuration rather than write a first.
func onARelay(t *testing.T) {
	t.Helper()
	if err := config.SaveRelay(config.Relay{
		URL:         "wss://relay.example.com",
		Secret:      "the-daemon-secret",
		FleetSeed:   testFleetSeed,
		Origin:      "https://relay.example.com",
		MachineID:   "karns-macbook-pro-a1b2-0f9a12cd",
		MachineName: "Karn's MacBook Pro",
		Worker:      "flue-relay",
	}); err != nil {
		t.Fatalf("SaveRelay: %v", err)
	}
}

// TestRelayCommandsTellAnOpenTabToReload is the transcript half of the CSP
// trap: a page is served with the relay it may talk to fixed in its
// Content-Security-Policy (internal/daemon.LocalCSPFor), so every command that
// rewrites relay.json strands the tab the user already had open — a fleet of
// one, forever, with nothing in the UI saying why. The daemon is told and
// catches up in place; the tab cannot be told anything, and only the command
// that caused it is in a position to mention it.
//
// The Remote screen has offered its "Reload flue" button since the deploy path
// landed. This pins the same honesty in the terminal, for the three commands
// that write the file: join, setup, and address.
//
// The second half is the part that keeps it honest. A page comes from a daemon
// on loopback and from nowhere else, so with no daemon running there is no tab
// to reload, and advice about one would be noise on the one path — a fresh
// machine configured before its first `flue enable` — where the transcript is
// already someone's first impression of flue.
func TestRelayCommandsTellAnOpenTabToReload(t *testing.T) {
	commands := []struct {
		name string
		run  func(t *testing.T, w io.Writer)
	}{{
		name: "join",
		run: func(t *testing.T, w io.Writer) {
			if err := runRelayJoin(w, []string{
				"wss://relay.example.com",
				"--secret", "s3cr3t-daemon-secret",
				"--fleet", testFleetSeed,
			}); err != nil {
				t.Fatalf("runRelayJoin: %v", err)
			}
		},
	}, {
		name: "setup",
		run: func(t *testing.T, w io.Writer) {
			f := newFakeCloudflare(t, oneAccount(), "karn")
			if err := runRelaySetup(w, strings.NewReader(setupToken+"\n"), f.client(), nil); err != nil {
				t.Fatalf("runRelaySetup: %v", err)
			}
		},
	}, {
		name: "address",
		run: func(t *testing.T, w io.Writer) {
			onARelay(t)
			if err := runRelayAddress(w, []string{"wss://relay2.example.com"}); err != nil {
				t.Fatalf("runRelayAddress: %v", err)
			}
		},
	}}

	for _, c := range commands {
		t.Run(c.name+" beside a running daemon", func(t *testing.T) {
			t.Setenv("XDG_CONFIG_HOME", t.TempDir())
			runningDaemon(t)

			var out strings.Builder
			c.run(t, &out)
			if !strings.Contains(out.String(), reloadHint) {
				t.Errorf("`flue relay %s` never tells the user to reload the tab it just stranded:\n%s", c.name, out.String())
			}
		})
		t.Run(c.name+" with no daemon", func(t *testing.T) {
			t.Setenv("XDG_CONFIG_HOME", t.TempDir())

			var out strings.Builder
			c.run(t, &out)
			if strings.Contains(out.String(), reloadHint) {
				t.Errorf("`flue relay %s` tells the user to reload a tab that cannot exist — no daemon has served one:\n%s", c.name, out.String())
			}
		})
	}
}

// TestRelayLeaveDoesNotTellAnOpenTabToReload is the command deliberately left
// out, and the reason is not that the advice would be merely redundant: it
// would be wrong.
//
// Leaving takes the relay origin *out* of relay.json, so the tab's policy is
// now wider than the daemon's configuration rather than narrower — and a policy
// that permits an origin nothing dials forbids nothing. The tab keeps what it
// had: its fleet identity lives in the browser, and the relay it was certified
// for is still deployed and still carrying the machines that stayed. A reload
// is the one act that would end that — the next document names no relay origin
// at all, and re-enrolling against a machine with no fleet key gets nothing
// back.
func TestRelayLeaveDoesNotTellAnOpenTabToReload(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	runningDaemon(t)
	onARelay(t)

	var out strings.Builder
	if err := runRelayLeave(&out, strings.NewReader("yes\n"), nil); err != nil {
		t.Fatalf("runRelayLeave: %v", err)
	}
	if strings.Contains(out.String(), reloadHint) {
		t.Errorf("leaving tells the user to reload a tab that a reload would take the fleet away from:\n%s", out.String())
	}
}
