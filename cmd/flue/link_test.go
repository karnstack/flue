package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"fmt"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/karnstack/flue/internal/config"
	"github.com/karnstack/flue/internal/controlplane"
	"github.com/karnstack/flue/internal/crypto"
)

// The three credentials the link flow moves. Distinctive strings, because
// several assertions in this file are "this appears nowhere", and those are
// only worth something if a match could not be a coincidence.
const (
	linkDeviceCode   = "device-code-must-never-be-printed"
	linkDeviceToken  = "enrollment-token-must-never-be-printed"
	linkChannelToken = "channel-token-must-never-be-printed"
)

// fakeApp is app.flue.sh's three daemon-facing server functions, in process and
// at the addresses the deployed ones live at — internal/controlplane derives
// those paths, and app/test/server-fn-ids.json is what keeps the derivation
// honest, so a fake that answered anywhere else would be testing nothing.
type fakeApp struct {
	ts *httptest.Server

	mu sync.Mutex
	// forms is every request body the app received, decoded.
	forms []url.Values
	// polls is answered one entry per poll; the last repeats.
	polls []string
	// startStatus/startBody and tokenStatus/tokenBody override the ordinary
	// answers, for the failure paths.
	startStatus int
	startBody   string
	tokenStatus int
	tokenBody   string
}

func newFakeApp(t *testing.T) *fakeApp {
	t.Helper()
	f := &fakeApp{}
	f.ts = httptest.NewServer(http.HandlerFunc(f.serve))
	t.Cleanup(f.ts.Close)
	return f
}

func (f *fakeApp) origin() string { return f.ts.URL }

func (f *fakeApp) serve(w http.ResponseWriter, r *http.Request) {
	if err := r.ParseForm(); err != nil {
		http.Error(w, "bad form", http.StatusBadRequest)
		return
	}
	if r.Header.Get("Origin") == "" {
		// The deployed app's CSRF middleware refuses a server-fn POST with no
		// origin signal, which is what a bare http.Post sends.
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}

	f.mu.Lock()
	defer f.mu.Unlock()
	f.forms = append(f.forms, r.PostForm)

	write := func(status int, body string) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_, _ = w.Write([]byte(body))
	}

	switch r.URL.Path {
	case controlplane.StartDeviceAuthPath():
		if f.startStatus != 0 {
			write(f.startStatus, f.startBody)
			return
		}
		write(http.StatusOK, fmt.Sprintf(`{
			"userCode":"BCDF-GHJK",
			"deviceCode":%q,
			"verificationUrl":%q,
			"verificationUrlComplete":%q,
			"expiresIn":600,
			"interval":5
		}`, linkDeviceCode, f.origin()+"/enroll", f.origin()+"/enroll?code=BCDF-GHJK"))

	case controlplane.PollDeviceAuthPath():
		body := `{"status":"pending"}`
		if len(f.polls) > 0 {
			body = f.polls[0]
			if len(f.polls) > 1 {
				f.polls = f.polls[1:]
			}
		}
		write(http.StatusOK, body)

	case controlplane.DaemonTokenPath():
		if f.tokenStatus != 0 {
			write(f.tokenStatus, f.tokenBody)
			return
		}
		write(http.StatusOK, fmt.Sprintf(
			`{"token":%q,"relayUrl":"wss://relay.flue.sh","expiresIn":300}`, linkChannelToken))

	default:
		http.Error(w, "not found", http.StatusNotFound)
	}
}

// formFor is the body of the first request to path.
func (f *fakeApp) formFor(t *testing.T, path string) url.Values {
	t.Helper()
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, form := range f.forms {
		if form.Has("label") && path == controlplane.StartDeviceAuthPath() {
			return form
		}
		if form.Has("deviceCode") && path == controlplane.PollDeviceAuthPath() {
			return form
		}
		if form.Has("enrollmentToken") && path == controlplane.DaemonTokenPath() {
			return form
		}
	}
	t.Fatalf("nothing was posted to %s", path)
	return nil
}

// approved is the poll body the control plane sends on the minting poll.
func approved(deviceID string) string {
	return fmt.Sprintf(`{"status":"approved","deviceId":%q,"deviceToken":%q}`, deviceID, linkDeviceToken)
}

// newTestLinker builds the flow with its wait collapsed to nothing: the poll
// interval is the control plane's business and waiting it out is not what these
// tests are about.
func newTestLinker(f *fakeApp, label string) *linker {
	return &linker{
		api:   &controlplane.Client{Origin: f.origin()},
		label: label,
		sleep: func(context.Context, time.Duration) error { return nil },
	}
}

func TestLinkStoresWhatApprovalReturns(t *testing.T) {
	base := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", base)
	f := newFakeApp(t)
	f.polls = []string{approved("abc123abc123")}

	var out bytes.Buffer
	if err := runLink(context.Background(), &out, newTestLinker(f, "karn's laptop")); err != nil {
		t.Fatalf("runLink: %v", err)
	}

	// What the person is told: the code to type and where to type it. Both are
	// the control plane's own strings, not something this command invented.
	printed := out.String()
	if !strings.Contains(printed, "BCDF-GHJK") {
		t.Errorf("the user code was not printed:\n%s", printed)
	}
	if !strings.Contains(printed, f.origin()+"/enroll") {
		t.Errorf("the verification URL was not printed:\n%s", printed)
	}

	// What was sent: the label the operator chose, and this machine's own Noise
	// static public key — the same bytes the device id is derived from, so a
	// wrong key here would enroll a machine nobody can reach.
	start := f.formFor(t, controlplane.StartDeviceAuthPath())
	if got := start.Get("label"); got != "karn's laptop" {
		t.Errorf("label = %q, want the one that was asked for", got)
	}
	key, err := crypto.LoadOrCreateStaticKey(filepath.Join(base, "flue"))
	if err != nil {
		t.Fatalf("LoadOrCreateStaticKey: %v", err)
	}
	if got, want := start.Get("publicKey"), base64.StdEncoding.EncodeToString(key.Public); got != want {
		t.Errorf("publicKey = %q, want this daemon's own static key %q", got, want)
	}

	// And what was stored. The enrollment token and the device id come from the
	// approving poll; the relay's address comes from the token mint, which is
	// also what proves the enrollment works before this says it linked.
	rc, ok, err := config.LoadRelay()
	if err != nil || !ok {
		t.Fatalf("LoadRelay = (%v, %v), want a saved relay", ok, err)
	}
	if !rc.Hosted() {
		t.Error("the saved relay is not a hosted one")
	}
	if rc.EnrollmentToken != linkDeviceToken {
		t.Error("the enrollment token was not stored")
	}
	if rc.DeviceID != "abc123abc123" {
		t.Errorf("DeviceID = %q, want the id the control plane assigned", rc.DeviceID)
	}
	if rc.ControlPlane != f.origin() {
		t.Errorf("ControlPlane = %q, want %q", rc.ControlPlane, f.origin())
	}
	if rc.URL != "wss://relay.flue.sh/daemon" {
		t.Errorf("URL = %q, want the relay's daemon leg", rc.URL)
	}
	if rc.Origin != "https://relay.flue.sh" {
		t.Errorf("Origin = %q, want the relay's https origin", rc.Origin)
	}
	if rc.Secret != "" {
		t.Error("a hosted relay was saved with a shared secret; the dial would be ambiguous")
	}
}

// TestLinkNeverWritesACredentialAnywhereButRelayJSON is the file's central
// claim, and it is checked two ways because they fail differently: a credential
// in the transcript is one somebody screenshots, and a credential in another
// file is one that outlives the 0600 this command is careful about.
func TestLinkNeverWritesACredentialAnywhereButRelayJSON(t *testing.T) {
	base := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", base)
	f := newFakeApp(t)
	f.polls = []string{`{"status":"pending"}`, approved("abc123abc123")}

	var out bytes.Buffer
	if err := runLink(context.Background(), &out, newTestLinker(f, "l")); err != nil {
		t.Fatalf("runLink: %v", err)
	}

	for _, secret := range []string{linkDeviceCode, linkDeviceToken, linkChannelToken} {
		if strings.Contains(out.String(), secret) {
			t.Errorf("the transcript carries a credential:\n%s", out.String())
		}
	}

	relayPath := filepath.Join(base, "flue", "relay.json")
	err := filepath.WalkDir(base, func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		b, err := os.ReadFile(p)
		if err != nil {
			return err
		}
		if strings.Contains(string(b), linkDeviceToken) && p != relayPath {
			t.Errorf("%s holds the enrollment token", p)
		}
		if strings.Contains(string(b), linkChannelToken) {
			t.Errorf("%s holds a channel token; those are minted per dial and never stored", p)
		}
		return nil
	})
	if err != nil {
		t.Fatalf("walk the config dir: %v", err)
	}

	info, err := os.Stat(relayPath)
	if err != nil {
		t.Fatalf("stat relay.json: %v", err)
	}
	if mode := info.Mode().Perm(); mode != 0o600 {
		t.Errorf("relay.json mode = %o, want 0600", mode)
	}
}

// TestLinkWaitsThroughPending: approval is a person walking to another machine,
// so `pending` is the ordinary answer and the loop has to keep asking with the
// device code it was given.
func TestLinkWaitsThroughPending(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	f := newFakeApp(t)
	f.polls = []string{`{"status":"pending"}`, `{"status":"pending"}`, approved("abc123abc123")}

	var out bytes.Buffer
	if err := runLink(context.Background(), &out, newTestLinker(f, "l")); err != nil {
		t.Fatalf("runLink: %v", err)
	}
	if got := f.formFor(t, controlplane.PollDeviceAuthPath()).Get("deviceCode"); got != linkDeviceCode {
		t.Errorf("polled with %q, want the device code the grant carried", got)
	}
	f.mu.Lock()
	polls := len(f.forms) - 2 // one start, one token mint
	f.mu.Unlock()
	if polls != 3 {
		t.Errorf("polled %d times, want 3 (two pending and the approval)", polls)
	}
}

// TestLinkSaysStartOverWhenApprovalCarriesNoToken.
//
// The token exists in exactly one response, ever: the poll that minted the
// device. If that response is lost — a dropped connection, a proxy that timed
// out — the grant is gone and the next poll answers `approved` with nothing in
// it. There is no way to recover the credential, so the only honest answer is
// to say so and start again. It must not be a crash, and it must not be
// mistaken for success.
func TestLinkSaysStartOverWhenApprovalCarriesNoToken(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	f := newFakeApp(t)
	f.polls = []string{`{"status":"approved","deviceId":"abc123abc123"}`}

	var out bytes.Buffer
	err := runLink(context.Background(), &out, newTestLinker(f, "l"))
	if err == nil {
		t.Fatal("a tokenless approval was treated as a link")
	}
	if !strings.Contains(err.Error(), "flue link") {
		t.Errorf("the error does not say what to do about it: %v", err)
	}
	if _, ok, _ := config.LoadRelay(); ok {
		t.Error("a relay.json was written for a machine with no credential")
	}
}

func TestLinkReportsTheTerminalRefusals(t *testing.T) {
	for _, tc := range []struct {
		name string
		poll string
		says string
	}{
		{
			// Somebody else's account already holds this machine's key. The
			// only fix is on the other account, so the message has to point at
			// it rather than suggest a retry.
			"conflict",
			`{"status":"conflict","deviceId":"abc123abc123"}`,
			"another",
		},
		{
			"expired",
			`{"status":"expired"}`,
			"expired",
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("XDG_CONFIG_HOME", t.TempDir())
			f := newFakeApp(t)
			f.polls = []string{tc.poll}

			var out bytes.Buffer
			err := runLink(context.Background(), &out, newTestLinker(f, "l"))
			if err == nil {
				t.Fatalf("%s came back as a successful link", tc.name)
			}
			if !strings.Contains(err.Error(), tc.says) {
				t.Errorf("error = %q, want it to mention %q", err, tc.says)
			}
			if _, ok, _ := config.LoadRelay(); ok {
				t.Error("a relay.json was written for a link that did not happen")
			}
		})
	}
}

// TestLinkWritesNothingUntilTheEnrollmentIsProven: the token mint is the last
// remote call and it is deliberately made *before* relay.json is written. It is
// what turns "the control plane says approved" into "this credential actually
// works and here is the relay it names" — and a machine whose relay.json was
// written anyway would sit in a reconnect loop the operator has no way to read.
func TestLinkWritesNothingUntilTheEnrollmentIsProven(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	f := newFakeApp(t)
	f.polls = []string{approved("abc123abc123")}
	f.tokenStatus = http.StatusUnauthorized
	f.tokenBody = `{"error":"enroll: this machine is not enrolled"}`

	var out bytes.Buffer
	if err := runLink(context.Background(), &out, newTestLinker(f, "l")); err == nil {
		t.Fatal("runLink succeeded although the credential it stored could mint nothing")
	}
	if _, ok, _ := config.LoadRelay(); ok {
		t.Error("relay.json was written for an enrollment that cannot mint a token")
	}
}

// TestLinkReplacesASelfHostedRelayRatherThanMixingCredentials.
//
// relay.json holds one relay. Linking a machine that already had a self-hosted
// one has to leave a file that names exactly one credential: transport/relay.New
// refuses a config carrying both — deliberately, because there is no honest way
// to guess which was meant — so a save that merged them would take remote access
// away entirely.
func TestLinkReplacesASelfHostedRelayRatherThanMixingCredentials(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	if err := config.SaveRelay(config.Relay{
		URL:    "wss://flue-relay.karn.workers.dev/daemon",
		Secret: "a-self-hosted-daemon-secret",
		Origin: "https://flue-relay.karn.workers.dev",
	}); err != nil {
		t.Fatalf("SaveRelay: %v", err)
	}

	f := newFakeApp(t)
	f.polls = []string{approved("abc123abc123")}
	var out bytes.Buffer
	if err := runLink(context.Background(), &out, newTestLinker(f, "l")); err != nil {
		t.Fatalf("runLink: %v", err)
	}

	rc, _, err := config.LoadRelay()
	if err != nil {
		t.Fatalf("LoadRelay: %v", err)
	}
	if rc.Secret != "" {
		t.Fatal("the self-hosted secret survived alongside the flue.sh enrolment")
	}
	if !rc.Hosted() {
		t.Fatal("the linked relay is not a hosted one")
	}
	// And the operator is told, because a relay they deployed themselves just
	// stopped being the one this machine dials.
	if !strings.Contains(out.String(), "replace") {
		t.Errorf("nothing said the self-hosted relay was replaced:\n%s", out.String())
	}
}

// TestLinkNamesTheMachineWhenNobodyElseDoes: the label is what the person sees
// in the device directory, and an empty one would leave every machine on the
// account called the same fallback the control plane invents.
func TestLinkNamesTheMachineWhenNobodyElseDoes(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	f := newFakeApp(t)
	f.polls = []string{approved("abc123abc123")}

	var out bytes.Buffer
	if err := runLink(context.Background(), &out, newTestLinker(f, "")); err != nil {
		t.Fatalf("runLink: %v", err)
	}
	if got := f.formFor(t, controlplane.StartDeviceAuthPath()).Get("label"); got == "" {
		t.Error("this machine enrolled with no name at all")
	}
}

// TestLinkPassesTheControlPlanesRefusalThrough: the messages these endpoints
// answer with are written to be read by whoever runs the daemon, so they reach
// the terminal rather than being flattened into "link failed".
func TestLinkPassesTheControlPlanesRefusalThrough(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	f := newFakeApp(t)
	f.startStatus = http.StatusTooManyRequests
	f.startBody = `{"error":"enroll: too many enrolments from this address — wait a few minutes"}`

	var out bytes.Buffer
	err := runLink(context.Background(), &out, newTestLinker(f, "l"))
	if err == nil {
		t.Fatal("a 429 came back as a successful link")
	}
	if !strings.Contains(err.Error(), "too many enrolments") {
		t.Errorf("error = %q, want the control plane's own message", err)
	}
}

func TestRelayEndpointsFromAMintedRelayURL(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct{ raw, dial, origin string }{
		{"wss://relay.flue.sh", "wss://relay.flue.sh/daemon", "https://relay.flue.sh"},
		{"wss://relay.flue.sh/", "wss://relay.flue.sh/daemon", "https://relay.flue.sh"},
		{"wss://relay.flue.sh/daemon", "wss://relay.flue.sh/daemon", "https://relay.flue.sh"},
		// A control plane that named the browser-facing scheme still has to
		// produce a socket address, because that is what the daemon dials.
		{"https://relay.flue.sh", "wss://relay.flue.sh/daemon", "https://relay.flue.sh"},
		// Plain http/ws is what a developer's local relay looks like.
		{"ws://127.0.0.1:8787", "ws://127.0.0.1:8787/daemon", "http://127.0.0.1:8787"},
	} {
		t.Run(tc.raw, func(t *testing.T) {
			t.Parallel()
			dial, origin, err := relayEndpoints(tc.raw)
			if err != nil {
				t.Fatalf("relayEndpoints(%q): %v", tc.raw, err)
			}
			if dial != tc.dial || origin != tc.origin {
				t.Errorf("relayEndpoints(%q) = (%q, %q), want (%q, %q)", tc.raw, dial, origin, tc.dial, tc.origin)
			}
		})
	}

	for _, bad := range []string{"", "relay.flue.sh", "ftp://relay.flue.sh", "wss://"} {
		if dial, origin, err := relayEndpoints(bad); err == nil {
			t.Errorf("relayEndpoints(%q) = (%q, %q), want a refusal", bad, dial, origin)
		}
	}
}

// TestRelayLineReportsAHostedRelay: `flue status` is the one place somebody
// looks to find out why remote access is not working, and a hosted relay that
// read "configured, but incomplete (no secret)" would send them looking for a
// secret that is deliberately not there.
func TestRelayLineReportsAHostedRelay(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	if err := config.SaveRelay(config.Relay{
		URL:             "wss://relay.flue.sh/daemon",
		Origin:          "https://relay.flue.sh",
		ControlPlane:    "https://app.flue.sh",
		DeviceID:        "abc123abc123",
		EnrollmentToken: linkDeviceToken,
	}); err != nil {
		t.Fatalf("SaveRelay: %v", err)
	}

	got := relayLine()
	if strings.Contains(got, "incomplete") {
		t.Errorf("a complete hosted relay was reported as incomplete: %q", got)
	}
	if !strings.Contains(got, "flue.sh") || !strings.Contains(got, "abc123abc123") {
		t.Errorf("status = %q, want it to name flue.sh and this machine's device id", got)
	}
	if strings.Contains(got, linkDeviceToken) {
		t.Errorf("status printed the enrollment token: %q", got)
	}
}

// TestRelayLineNamesAConfigurationThatWillNotDial: a relay.json holding both
// credentials is one transport/relay.New refuses, so the daemon never dials it.
// Reporting that as "configured" would have the report somebody reads to
// diagnose it say everything is fine.
func TestRelayLineNamesAConfigurationThatWillNotDial(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	if err := config.SaveRelay(config.Relay{
		URL:             "wss://relay.flue.sh/daemon",
		Origin:          "https://relay.flue.sh",
		Secret:          "a-self-hosted-daemon-secret",
		ControlPlane:    "https://app.flue.sh",
		DeviceID:        "abc123abc123",
		EnrollmentToken: linkDeviceToken,
	}); err != nil {
		t.Fatalf("SaveRelay: %v", err)
	}

	got := relayLine()
	if !strings.Contains(got, "will not dial") {
		t.Errorf("status = %q, want it to say the daemon will not dial this", got)
	}
	for _, secret := range []string{"a-self-hosted-daemon-secret", linkDeviceToken} {
		if strings.Contains(got, secret) {
			t.Errorf("status printed a credential: %q", got)
		}
	}
}

// TestLinkSettlesOnOneSpellingOfTheOrigin: relay.json stores the control plane
// this machine is linked to, and the daemon later sends that same string as the
// `Origin` header of every token request — which the app's CSRF middleware
// compares against the origin it was reached on. A stored trailing slash is
// therefore not cosmetic: it is a 403 the first time the daemon needs a token,
// on a machine that linked without complaint.
func TestLinkSettlesOnOneSpellingOfTheOrigin(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	f := newFakeApp(t)
	f.polls = []string{approved("abc123abc123")}

	l := newTestLinker(f, "l")
	l.api.Origin = f.origin() + "/"

	var out bytes.Buffer
	if err := runLink(context.Background(), &out, l); err != nil {
		t.Fatalf("runLink: %v", err)
	}
	rc, _, err := config.LoadRelay()
	if err != nil {
		t.Fatalf("LoadRelay: %v", err)
	}
	if rc.ControlPlane != f.origin() {
		t.Errorf("ControlPlane = %q, want %q", rc.ControlPlane, f.origin())
	}
}

// TestLinkRefusesAnUnusableControlPlaneBeforeItTouchesAnything: a mistyped
// --app is the cheapest failure in the flow, and it must stay that way — not a
// key created, not a grant opened, and no ten-minute code printed for a host
// that was never going to answer.
func TestLinkRefusesAnUnusableControlPlaneBeforeItTouchesAnything(t *testing.T) {
	base := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", base)

	var out bytes.Buffer
	err := runLink(context.Background(), &out, &linker{
		api:   &controlplane.Client{Origin: "app.flue.sh"},
		sleep: func(context.Context, time.Duration) error { return nil },
	})
	if err == nil {
		t.Fatal("a control-plane origin with no scheme was accepted")
	}
	if out.Len() != 0 {
		t.Errorf("something was printed before the origin was checked:\n%s", out.String())
	}
	if _, statErr := os.Stat(filepath.Join(base, "flue", "keys", "static.key")); statErr == nil {
		t.Error("a static key was created for a link that could not start")
	}
}
