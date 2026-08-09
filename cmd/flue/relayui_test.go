package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/karnstack/flue/internal/cloudflare"
	"github.com/karnstack/flue/internal/config"
	"github.com/karnstack/flue/internal/daemon"
)

// The service behind the Remote screen is the same deploy the CLI performs,
// so these tests drive it against the same fake Cloudflare and assert the
// same facts — plus the two things only the service does: answer the account
// question as data instead of a prompt, and start the transport in-process.

func uiService(f *fakeCloudflare, rt *relayRuntime) *relayUIService {
	return &relayUIService{runtime: rt, base: f.srv.URL}
}

func TestRelayUIProvisionDeploysAndStartsTheTransport(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	f := newFakeCloudflare(t, oneAccount(), "karn")

	started := 0
	rt := &relayRuntime{start: func() bool { started++; return true }}
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
	if !strings.Contains(res.JoinCommand, "flue relay join wss://") || !strings.Contains(res.JoinCommand, cfg.Secret) {
		t.Fatalf("join command %q does not carry the address and the secret", res.JoinCommand)
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
	svc := uiService(f, &relayRuntime{start: func() bool { return true }})

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
	svc := uiService(f, &relayRuntime{start: func() bool { return true }})

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
	rt := &relayRuntime{running: true, start: func() bool { t.Fatal("a second transport was started"); return false }}
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
	}); err != nil {
		t.Fatalf("SaveRelay: %v", err)
	}
	cmd, ok, err := svc.JoinCommand(context.Background())
	if err != nil || !ok {
		t.Fatalf("JoinCommand: ok %v err %v", ok, err)
	}
	if cmd != "flue relay join wss://flue-relay-dev.karn.workers.dev --secret fleet-s3cret" {
		t.Fatalf("join command = %q", cmd)
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
