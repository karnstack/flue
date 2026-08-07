package main

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"mime"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"testing"

	"github.com/karnstack/flue/internal/cloudflare"
	"github.com/karnstack/flue/internal/config"
	"github.com/karnstack/flue/internal/daemon"
	relaybundle "github.com/karnstack/flue/relay"
	"github.com/karnstack/flue/web"
)

// setupToken is the API token every test in this file pastes in. It is a
// distinctive string on purpose: several assertions are "this must appear
// nowhere", and they are only worth anything if a match could not be a
// coincidence.
const setupToken = "cf-token-must-never-be-printed-or-stored"

// --- the fake Cloudflare API -------------------------------------------------

// manifestLine is one entry of the asset upload session's manifest.
type manifestLine struct {
	Hash string `json:"hash"`
	Size int    `json:"size"`
}

// wireMetadata is the `metadata` part of the multipart script upload, decoded
// independently of internal/cloudflare's own (unexported) types. Decoding it
// again here is deliberate: this test is about what actually goes over the
// wire, and sharing the producer's struct would make it agree with itself.
type wireMetadata struct {
	MainModule        string `json:"main_module"`
	CompatibilityDate string `json:"compatibility_date"`
	Bindings          []struct {
		Type      string `json:"type"`
		Name      string `json:"name"`
		ClassName string `json:"class_name"`
	} `json:"bindings"`
	KeepBindings []string `json:"keep_bindings"`
	Migrations   *struct {
		NewTag string `json:"new_tag"`
		Steps  []struct {
			NewSQLiteClasses []string `json:"new_sqlite_classes"`
		} `json:"steps"`
	} `json:"migrations"`
	Assets *struct {
		JWT    string `json:"jwt"`
		Config struct {
			HTMLHandling     string   `json:"html_handling"`
			NotFoundHandling string   `json:"not_found_handling"`
			RunWorkerFirst   []string `json:"run_worker_first"`
			Headers          string   `json:"_headers"`
		} `json:"config"`
	} `json:"assets"`
	Observability *struct {
		Enabled bool `json:"enabled"`
	} `json:"observability"`
}

// fakeCloudflare is a scripted subset of the Cloudflare v4 API: exactly the
// endpoints one `flue relay setup` touches, recording everything it was sent so
// the assertions can be made after the flow returns.
type fakeCloudflare struct {
	t         *testing.T
	srv       *httptest.Server
	accounts  []cloudflare.Account
	subdomain string
	// reject maps a path suffix to the Cloudflare error message that endpoint
	// should fail with, for the tests that check a step failing stops the flow.
	reject map[string]string

	mu               sync.Mutex
	auths            []string
	paths            []string
	manifest         map[string]manifestLine
	uploads          map[string][]byte
	module           []byte
	meta             wireMetadata
	secretName       string
	secretText       string
	secretType       string
	subdomainEnabled bool
	scriptPuts       int
	// migrated records that the Durable Object migration has been applied, so
	// that a second deploy is refused the way the real API refuses one. This is
	// what a re-run of `flue relay setup` actually meets.
	migrated bool
}

func newFakeCloudflare(t *testing.T, accounts []cloudflare.Account, subdomain string) *fakeCloudflare {
	t.Helper()
	f := &fakeCloudflare{
		t:         t,
		accounts:  accounts,
		subdomain: subdomain,
		reject:    map[string]string{},
		manifest:  map[string]manifestLine{},
		uploads:   map[string][]byte{},
	}
	f.srv = httptest.NewServer(http.HandlerFunc(f.route))
	t.Cleanup(f.srv.Close)
	return f
}

// client is a Cloudflare client aimed at the fake, with no token: setup is what
// puts the pasted token on it, which is the property several tests check.
func (f *fakeCloudflare) client() *cloudflare.Client {
	return &cloudflare.Client{Base: f.srv.URL}
}

func (f *fakeCloudflare) route(w http.ResponseWriter, r *http.Request) {
	body, err := io.ReadAll(r.Body)
	if err != nil {
		f.errorf(w, "reading the %s %s body: %v", r.Method, r.URL.Path, err)
		return
	}
	p := r.URL.Path
	f.mu.Lock()
	f.auths = append(f.auths, r.Header.Get("Authorization"))
	f.paths = append(f.paths, p)
	f.mu.Unlock()

	for suffix, msg := range f.reject {
		if strings.HasSuffix(p, suffix) {
			writeAPIError(w, msg)
			return
		}
	}

	switch {
	case p == "/user/tokens/verify":
		writeResult(w, map[string]string{"id": "tok-1", "status": "active"})
	case p == "/accounts":
		writeResult(w, f.accounts)
	case strings.HasSuffix(p, "/assets-upload-session"):
		f.openSession(w, body)
	case strings.HasSuffix(p, "/workers/assets/upload"):
		f.uploadBucket(w, r, body)
	case strings.HasSuffix(p, "/secrets"):
		f.putSecret(w, body)
	case strings.HasSuffix(p, "/scripts/"+relayScriptName+"/subdomain"):
		f.mu.Lock()
		f.subdomainEnabled = true
		f.mu.Unlock()
		writeResult(w, map[string]bool{"enabled": true})
	case strings.HasSuffix(p, "/workers/subdomain"):
		writeResult(w, map[string]string{"subdomain": f.subdomain})
	case strings.HasSuffix(p, "/scripts/"+relayScriptName):
		f.putScript(w, r, body)
	default:
		f.errorf(w, "unexpected request %s %s", r.Method, p)
	}
}

// openSession answers the asset upload session, asking for every file back so
// the upload leg runs too — that is where the file *contents* go over the wire.
func (f *fakeCloudflare) openSession(w http.ResponseWriter, body []byte) {
	var req struct {
		Manifest map[string]manifestLine `json:"manifest"`
	}
	if err := json.Unmarshal(body, &req); err != nil {
		f.errorf(w, "decoding the asset manifest: %v", err)
		return
	}
	hashes := make([]string, 0, len(req.Manifest))
	f.mu.Lock()
	for path, line := range req.Manifest {
		f.manifest[path] = line
		hashes = append(hashes, line.Hash)
	}
	f.mu.Unlock()
	writeResult(w, map[string]any{"jwt": "session-jwt", "buckets": [][]string{hashes}})
}

func (f *fakeCloudflare) uploadBucket(w http.ResponseWriter, r *http.Request, body []byte) {
	mr, ok := f.multipart(w, r, body)
	if !ok {
		return
	}
	for {
		part, err := mr.NextPart()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			f.errorf(w, "reading an asset part: %v", err)
			return
		}
		raw, err := io.ReadAll(base64.NewDecoder(base64.StdEncoding, part))
		if err != nil {
			f.errorf(w, "decoding asset %q: %v", part.FormName(), err)
			return
		}
		f.mu.Lock()
		f.uploads[part.FormName()] = raw
		f.mu.Unlock()
	}
	writeResult(w, map[string]string{"jwt": "completion-jwt"})
}

func (f *fakeCloudflare) putScript(w http.ResponseWriter, r *http.Request, body []byte) {
	mr, ok := f.multipart(w, r, body)
	if !ok {
		return
	}
	for {
		part, err := mr.NextPart()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			f.errorf(w, "reading a script part: %v", err)
			return
		}
		raw, err := io.ReadAll(part)
		if err != nil {
			f.errorf(w, "reading script part %q: %v", part.FormName(), err)
			return
		}
		switch part.FormName() {
		case "metadata":
			var meta wireMetadata
			if err := json.Unmarshal(raw, &meta); err != nil {
				f.errorf(w, "decoding the script metadata: %v", err)
				return
			}
			f.mu.Lock()
			f.meta = meta
			f.mu.Unlock()
		case "index.js":
			f.mu.Lock()
			f.module = raw
			f.mu.Unlock()
		default:
			f.errorf(w, "unexpected script part %q", part.FormName())
			return
		}
	}

	f.mu.Lock()
	f.scriptPuts++
	repeat := f.migrated && f.meta.Migrations != nil
	if f.meta.Migrations != nil {
		f.migrated = true
	}
	keepsSecrets := false
	for _, k := range f.meta.KeepBindings {
		if k == "secret_text" {
			keepsSecrets = true
		}
	}
	f.mu.Unlock()
	if repeat {
		writeAPIError(w, "Cannot apply new-sqlite-class migration to class DaemonHub that is already depended on by existing Durable Objects")
		return
	}

	// A script upload replaces the binding set. Secrets are bindings, so an
	// upload that does not ask to keep `secret_text` leaves the Worker with no
	// DAEMON_SECRET at all — the API says nothing about it and the deploy
	// reports success. The fake models that, because a fake that quietly kept
	// the secret would let exactly this bug through.
	f.mu.Lock()
	if !keepsSecrets {
		f.secretName, f.secretText, f.secretType = "", "", ""
	}
	f.mu.Unlock()
	writeResult(w, map[string]string{"id": "flue-relay"})
}

func (f *fakeCloudflare) putSecret(w http.ResponseWriter, body []byte) {
	var req struct {
		Name string `json:"name"`
		Text string `json:"text"`
		Type string `json:"type"`
	}
	if err := json.Unmarshal(body, &req); err != nil {
		f.errorf(w, "decoding the secret: %v", err)
		return
	}
	f.mu.Lock()
	f.secretName, f.secretText, f.secretType = req.Name, req.Text, req.Type
	f.mu.Unlock()
	writeResult(w, map[string]string{"name": req.Name})
}

func (f *fakeCloudflare) multipart(w http.ResponseWriter, r *http.Request, body []byte) (*multipart.Reader, bool) {
	_, params, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil {
		f.errorf(w, "parsing the content type of %s: %v", r.URL.Path, err)
		return nil, false
	}
	boundary, ok := params["boundary"]
	if !ok {
		f.errorf(w, "%s carried no multipart boundary", r.URL.Path)
		return nil, false
	}
	return multipart.NewReader(bytes.NewReader(body), boundary), true
}

// errorf fails the test and answers the request. It is Errorf rather than
// Fatalf because this runs on the server's goroutine, where FailNow does not do
// what it looks like it does.
func (f *fakeCloudflare) errorf(w http.ResponseWriter, format string, args ...any) {
	f.t.Errorf("fake cloudflare: "+format, args...)
	http.Error(w, "fake cloudflare rejected this", http.StatusInternalServerError)
}

func writeResult(w http.ResponseWriter, result any) {
	b, err := json.Marshal(result)
	if err != nil {
		http.Error(w, "encode", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_, _ = fmt.Fprintf(w, `{"success":true,"errors":[],"messages":[],"result":%s}`, b)
}

func writeAPIError(w http.ResponseWriter, msg string) {
	b, _ := json.Marshal(msg)
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusBadRequest)
	_, _ = fmt.Fprintf(w, `{"success":false,"errors":[{"code":10000,"message":%s}],"result":null}`, b)
}

// --- helpers -----------------------------------------------------------------

// machineIDRe is the relay's id grammar (relay/src/index.ts), which every id
// this command mints has to satisfy or the Worker answers the dial with 404.
var machineIDRe = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,62}$`)

func oneAccount() []cloudflare.Account {
	return []cloudflare.Account{{ID: "acct-0123456789abcdef", Name: "Karn's Account"}}
}

// webDistFiles is what the embedded UI actually contains, so the "(NN files)"
// line can be checked against the real bundle rather than a guess.
func webDistFiles(t *testing.T) []string {
	t.Helper()
	dist, err := web.Dist()
	if err != nil {
		t.Fatalf("web.Dist: %v", err)
	}
	var names []string
	err = fs.WalkDir(dist, ".", func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if !d.IsDir() {
			names = append(names, p)
		}
		return nil
	})
	if err != nil {
		t.Fatalf("walking the web dist: %v", err)
	}
	return names
}

func loadSavedRelay(t *testing.T) config.Relay {
	t.Helper()
	rc, ok, err := config.LoadRelay()
	if err != nil {
		t.Fatalf("LoadRelay: %v", err)
	}
	if !ok {
		t.Fatal("no relay.json was written")
	}
	return rc
}

// configFilesContaining reports every file under the config directory whose
// bytes contain needle.
func configFilesContaining(t *testing.T, needle string) []string {
	t.Helper()
	dir, err := config.Dir()
	if err != nil {
		t.Fatalf("config.Dir: %v", err)
	}
	var hits []string
	err = filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			return nil
		}
		b, err := os.ReadFile(p)
		if err != nil {
			return err
		}
		if bytes.Contains(b, []byte(needle)) {
			hits = append(hits, p)
		}
		return nil
	})
	if err != nil {
		t.Fatalf("walking the config dir: %v", err)
	}
	return hits
}

// --- the tests ---------------------------------------------------------------

// TestRunRelaySetupDeploysTheWorkerAndTheWebApp is the whole flow against a
// scripted API: what got deployed, what got saved, what got printed, and what
// must not have gone anywhere.
func TestRunRelaySetupDeploysTheWorkerAndTheWebApp(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	f := newFakeCloudflare(t, oneAccount(), "karn")

	var out bytes.Buffer
	if err := runRelaySetup(&out, strings.NewReader(setupToken+"\n"), f.client()); err != nil {
		t.Fatalf("runRelaySetup: %v", err)
	}

	// The module is the embedded bundle, byte for byte — not a placeholder and
	// not something rebuilt on the fly.
	if want := relaybundle.Module(); !bytes.Equal(f.module, want) {
		t.Fatalf("deployed module is %d bytes, want the embedded bundle's %d", len(f.module), len(want))
	}
	if f.meta.MainModule != "index.js" {
		t.Fatalf("main_module = %q, want index.js", f.meta.MainModule)
	}
	if f.meta.CompatibilityDate != relayCompatibilityDate {
		t.Fatalf("compatibility_date = %q, want %q", f.meta.CompatibilityDate, relayCompatibilityDate)
	}

	// The two settings whose absence is invisible until the deployed Worker is
	// running: without the ASSETS binding every /api/* fallthrough calls fetch
	// on undefined, and without observability there are no logs to find out
	// with. Both are silent in a deploy that otherwise reports success.
	var gotAssets, gotHub bool
	for _, b := range f.meta.Bindings {
		switch {
		case b.Type == "assets" && b.Name == "ASSETS":
			gotAssets = true
		case b.Type == "durable_object_namespace" && b.Name == "HUB" && b.ClassName == "DaemonHub":
			gotHub = true
		}
	}
	if !gotAssets {
		t.Fatalf("no assets binding named ASSETS in %+v; env.ASSETS would be undefined in the deployed worker", f.meta.Bindings)
	}
	if !gotHub {
		t.Fatalf("no HUB -> DaemonHub durable object binding in %+v", f.meta.Bindings)
	}
	if f.meta.Observability == nil || !f.meta.Observability.Enabled {
		t.Fatalf("observability = %+v, want enabled", f.meta.Observability)
	}
	// The third setting of this kind, and the one that bites hardest: a script
	// upload replaces the binding set, DAEMON_SECRET is a `secret_text`
	// binding, and an upload that does not ask for secrets to be kept unbinds
	// it — while reporting a successful deploy.
	if !slicesEqual(f.meta.KeepBindings, []string{"secret_text"}) {
		t.Fatalf("keep_bindings = %v, want [secret_text]; this deploy would unbind %s", f.meta.KeepBindings, daemonSecretName)
	}

	if f.meta.Migrations == nil || len(f.meta.Migrations.Steps) != 1 ||
		len(f.meta.Migrations.Steps[0].NewSQLiteClasses) != 1 ||
		f.meta.Migrations.Steps[0].NewSQLiteClasses[0] != "DaemonHub" {
		t.Fatalf("migrations = %+v, want one step introducing the SQLite class DaemonHub", f.meta.Migrations)
	}
	if f.meta.Assets == nil {
		t.Fatal("no assets attached to the script")
	}
	if got, want := f.meta.Assets.Config.RunWorkerFirst, []string{"/daemon", "/daemon/*", "/client", "/client/*", "/api/*"}; !slicesEqual(got, want) {
		t.Fatalf("run_worker_first = %v, want %v", got, want)
	}

	// The web bundle came from the embedded FS, contents and all.
	files := webDistFiles(t)
	if len(f.manifest) != len(files) {
		t.Fatalf("manifest has %d entries, want %d (the whole embedded web dist)", len(f.manifest), len(files))
	}
	shell, ok := f.manifest["/index.html"]
	if !ok {
		t.Fatalf("no /index.html in the uploaded manifest: %v", f.manifest)
	}
	dist, err := web.Dist()
	if err != nil {
		t.Fatalf("web.Dist: %v", err)
	}
	wantShell, err := fs.ReadFile(dist, "index.html")
	if err != nil {
		t.Fatalf("reading the embedded index.html: %v", err)
	}
	if got := f.uploads[shell.Hash]; !bytes.Equal(got, wantShell) {
		t.Fatalf("uploaded index.html is %d bytes, want the embedded shell's %d", len(got), len(wantShell))
	}

	// The secret the Worker got is the secret the daemon will present.
	saved := loadSavedRelay(t)
	if f.secretName != daemonSecretName {
		t.Fatalf("secret name = %q, want %q", f.secretName, daemonSecretName)
	}
	if f.secretType != "secret_text" {
		t.Fatalf("secret type = %q, want secret_text", f.secretType)
	}
	if f.secretText == "" || f.secretText != saved.Secret {
		t.Fatal("the secret set on the worker is not the secret saved in relay.json")
	}
	raw, err := base64.RawURLEncoding.DecodeString(saved.Secret)
	if err != nil {
		t.Fatalf("the saved secret is not base64url: %v", err)
	}
	if len(raw) != daemonSecretBytes {
		t.Fatalf("the saved secret decodes to %d bytes, want %d", len(raw), daemonSecretBytes)
	}

	// The URL is the bare host — the /daemon/<machine id> leg is the
	// transport's to append, so a relay.json is one machine's whole
	// registration: address, credential, and which machine it is.
	const host = "flue-relay.karn.workers.dev"
	if saved.URL != "wss://"+host {
		t.Fatalf("relay.json url = %q, want the bare wss://%s", saved.URL, host)
	}
	if saved.Origin != "https://"+host {
		t.Fatalf("relay.json origin = %q", saved.Origin)
	}
	if !machineIDRe.MatchString(saved.MachineID) {
		t.Fatalf("relay.json machine_id = %q, which is not a valid machine id", saved.MachineID)
	}
	hostname, err := os.Hostname()
	if err != nil {
		t.Fatalf("os.Hostname: %v", err)
	}
	if saved.MachineName != hostname {
		t.Fatalf("relay.json machine_name = %q, want this machine's hostname %q", saved.MachineName, hostname)
	}
	if !f.subdomainEnabled {
		t.Fatal("the workers.dev subdomain was never enabled")
	}

	// The transcript, checkmark by checkmark — and the one line the user
	// copies to every other machine, url and secret exactly as saved.
	transcript := out.String()
	for _, want := range []string{
		"✓ token verified",
		"✓ account: Karn's Account (",
		"✓ worker deployed: flue-relay",
		fmt.Sprintf("✓ web app uploaded (%d files)", len(files)),
		"✓ secret set",
		"✓ reachable at https://" + host,
		"flue relay join wss://" + host + " --secret " + saved.Secret,
		"does not store it",
	} {
		if !strings.Contains(transcript, want) {
			t.Fatalf("transcript is missing %q:\n%s", want, transcript)
		}
	}

	// The token was used, and then it was forgotten.
	usedIt := false
	for _, a := range f.auths {
		if a == "Bearer "+setupToken {
			usedIt = true
		}
	}
	if !usedIt {
		t.Fatalf("the pasted token never reached the API: %v", f.auths)
	}
	if strings.Contains(transcript, setupToken) {
		t.Fatalf("the API token was echoed back:\n%s", transcript)
	}
	if hits := configFilesContaining(t, setupToken); len(hits) > 0 {
		t.Fatalf("the API token was written to %v", hits)
	}
}

// TestRunRelaySetupIsSafeToRerun is the property everything above rests on:
// every failure in this flow is recovered from by running it again, so running
// it again has to work. The fake refuses the second deploy's migration exactly
// as Cloudflare does, which is what a real re-run meets — the second run must
// come out the far side with a fresh secret the worker and relay.json agree on.
// TestRunRelaySetupSendsTheSecurityHeaders: the relay serves the same bundle
// the daemon does, from the internet rather than from loopback, and until this
// existed it served it with none of the daemon's security headers — including
// the `script-src 'self'` that web/src/crypto/keys.ts names as the reason it is
// willing to hold a raw private key in IndexedDB.
//
// Asserted off the wire, because the mechanism is easy to get wrong in a way
// that looks right: a `_headers` file among the assets would upload cleanly,
// serve itself at /_headers, and apply to nothing.
func TestRunRelaySetupSendsTheSecurityHeaders(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	f := newFakeCloudflare(t, oneAccount(), "karn")

	var out bytes.Buffer
	if err := runRelaySetup(&out, strings.NewReader(setupToken+"\n"), f.client()); err != nil {
		t.Fatalf("runRelaySetup: %v", err)
	}
	if f.meta.Assets == nil {
		t.Fatal("no assets in the script metadata")
	}
	got := f.meta.Assets.Config.Headers
	if !strings.Contains(got, "Content-Security-Policy: "+daemon.RelayCSP) {
		t.Errorf("assets._headers does not carry the relay CSP:\n%q", got)
	}
	if !strings.Contains(got, "Referrer-Policy: no-referrer") {
		t.Errorf("assets._headers does not carry Referrer-Policy:\n%q", got)
	}
	// The loopback sockets are the one directive the relay must not inherit:
	// wildcard ports on an origin whose own socket is a same-origin wss.
	if strings.Contains(got, "127.0.0.1") || strings.Contains(got, "localhost") {
		t.Errorf("assets._headers carries the daemon's loopback connect-src:\n%q", got)
	}
	// The relay's policy grants nothing beyond 'self': the bundle on a relay
	// origin talks to that origin alone, and any second origin appearing here
	// is a policy widening someone has to justify.
	if !strings.Contains(got, "connect-src 'self';") {
		t.Errorf("assets._headers does not pin connect-src to 'self' exactly:\n%q", got)
	}
	if strings.Contains(got, "https:;") || strings.Contains(got, "flue.sh") {
		t.Errorf("assets._headers widens connect-src past the relay's own origin:\n%q", got)
	}
	// And nothing uploaded the document as an asset, which is the failure this
	// whole mechanism exists to avoid.
	for path := range f.manifest {
		if path == "/_headers" || path == "/_redirects" {
			t.Errorf("%s was uploaded as a static asset; it would be published and applied to nothing", path)
		}
	}
}

// TestRelayAssetHeadersMatchTheWranglerCopy is the drift guard the two-config
// deploy needs (docs/FOLLOW-UPS.md §12). `wrangler dev` reads a real file and
// has no config key for this; `flue relay setup` sends a string. A developer
// and a user must not end up on different policies, and neither side fails
// loudly on its own.
func TestRelayAssetHeadersMatchTheWranglerCopy(t *testing.T) {
	path := filepath.Join("..", "..", "relay", "public", "_headers")
	onDisk, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("reading %s: %v", path, err)
	}
	if string(onDisk) != relayAssetHeaders {
		t.Errorf("relay/public/_headers and relayAssetHeaders differ\n--- file ---\n%s\n--- constant ---\n%s", onDisk, relayAssetHeaders)
	}
}

func TestRunRelaySetupIsSafeToRerun(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	f := newFakeCloudflare(t, oneAccount(), "karn")

	var out bytes.Buffer
	if err := runRelaySetup(&out, strings.NewReader(setupToken+"\n"), f.client()); err != nil {
		t.Fatalf("first runRelaySetup: %v", err)
	}
	first := loadSavedRelay(t)

	out.Reset()
	if err := runRelaySetup(&out, strings.NewReader(setupToken+"\n"), f.client()); err != nil {
		t.Fatalf("second runRelaySetup: %v", err)
	}
	second := loadSavedRelay(t)

	if second.Secret == first.Secret {
		t.Fatal("the second run reused the first run's secret; setup is supposed to mint a fresh one")
	}
	if f.secretText != second.Secret {
		t.Fatal("the worker holds a secret the saved relay.json does not")
	}
	if second.URL != first.URL || second.Origin != first.Origin {
		t.Fatalf("the second run changed the address: %+v then %+v", first, second)
	}
	// Three PUTs, not two: the second run's first attempt is the one the
	// already-applied migration rejects. Two would mean the fake never refused
	// anything and this test proved nothing about re-running.
	if f.scriptPuts != 3 {
		t.Fatalf("script PUTs = %d, want 3 (deploy, refused re-deploy, retry without the migration)", f.scriptPuts)
	}
	// f.meta is the retry PUT: the upload that lands on a Worker that already
	// holds a live secret. Asserted on the decoded request, not on the fake's
	// state, so it cannot pass because of how the fake models a drop.
	if !slicesEqual(f.meta.KeepBindings, []string{"secret_text"}) {
		t.Fatalf("the re-run's script upload sent keep_bindings = %v, want [secret_text]", f.meta.KeepBindings)
	}
}

// TestRunRelaySetupRerunLeavesALiveRelayWorking is the failure this ordering and
// keep_bindings exist for. A re-run against a relay that is already serving gets
// as far as re-deploying the Worker and then fails — the account's workers.dev
// subdomain is unreachable, say. The relay on the other end must be exactly as
// it was: same address, same secret, and relay.json still describing it. The
// unsafe shapes both end here — an upload that dropped the secret bindings would
// leave the Worker with no DAEMON_SECRET at all, and setting the new secret
// before the last fallible remote step would leave the Worker holding a secret
// relay.json has never heard of. Either way the daemon 401s forever, with
// nothing anywhere saying so.
func TestRunRelaySetupRerunLeavesALiveRelayWorking(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	f := newFakeCloudflare(t, oneAccount(), "karn")

	var out bytes.Buffer
	if err := runRelaySetup(&out, strings.NewReader(setupToken+"\n"), f.client()); err != nil {
		t.Fatalf("first runRelaySetup: %v", err)
	}
	live := loadSavedRelay(t)

	f.reject["/workers/subdomain"] = "computer says no"
	out.Reset()
	if err := runRelaySetup(&out, strings.NewReader(setupToken+"\n"), f.client()); err == nil {
		t.Fatal("the re-run succeeded despite the subdomain step failing")
	}

	if f.secretText != live.Secret {
		t.Fatalf("the worker's %s is %q after a failed re-run, want the live relay's unchanged secret", daemonSecretName, f.secretText)
	}
	if got := loadSavedRelay(t); got != live {
		t.Fatalf("relay.json changed under a failed re-run: %+v, want %+v", got, live)
	}
}

// TestRunRelaySetupPromptsWhenThereIsMoreThanOneAccount: the choice is the
// user's, and the one they typed is the one deployed to.
func TestRunRelaySetupPromptsWhenThereIsMoreThanOneAccount(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	accounts := []cloudflare.Account{
		{ID: "acct-one", Name: "Personal"},
		{ID: "acct-two", Name: "Work"},
	}
	f := newFakeCloudflare(t, accounts, "karn")

	var out bytes.Buffer
	if err := runRelaySetup(&out, strings.NewReader(setupToken+"\n2\n"), f.client()); err != nil {
		t.Fatalf("runRelaySetup: %v", err)
	}

	transcript := out.String()
	for _, want := range []string{"1) Personal", "2) Work", "✓ account: Work ("} {
		if !strings.Contains(transcript, want) {
			t.Fatalf("transcript is missing %q:\n%s", want, transcript)
		}
	}
	// Everything after the choice must have gone to the chosen account.
	for _, p := range f.paths {
		if strings.HasPrefix(p, "/accounts/") && !strings.HasPrefix(p, "/accounts/acct-two/") {
			t.Fatalf("request to %q, but the user chose acct-two", p)
		}
	}
}

func TestRunRelaySetupRejectsAnUnusableAccountChoice(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	accounts := []cloudflare.Account{
		{ID: "acct-one", Name: "Personal"},
		{ID: "acct-two", Name: "Work"},
	}
	f := newFakeCloudflare(t, accounts, "karn")

	var out bytes.Buffer
	err := runRelaySetup(&out, strings.NewReader(setupToken+"\nnope\n9\n0\n"), f.client())
	if err == nil {
		t.Fatal("runRelaySetup accepted a choice that names no account")
	}
	if _, ok, _ := config.LoadRelay(); ok {
		t.Fatal("relay.json was written for a setup that never picked an account")
	}
}

func TestRunRelaySetupRefusesAnEmptyToken(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	f := newFakeCloudflare(t, oneAccount(), "karn")

	var out bytes.Buffer
	if err := runRelaySetup(&out, strings.NewReader("\n"), f.client()); err == nil {
		t.Fatal("runRelaySetup accepted an empty token")
	}
	if len(f.paths) != 0 {
		t.Fatalf("an empty token still reached the API: %v", f.paths)
	}
}

// TestRunRelaySetupStopsAtTheFailingStep: a step that fails is reported and
// nothing downstream of it runs — in particular relay.json is not written for a
// relay that was never deployed.
func TestRunRelaySetupStopsAtTheFailingStep(t *testing.T) {
	for _, tc := range []struct {
		name   string
		suffix string
	}{
		{"token verification", "/user/tokens/verify"},
		{"the account list", "/accounts"},
		{"the deploy", "/scripts/" + relayScriptName},
		{"the secret", "/secrets"},
		{"the subdomain", "/workers/subdomain"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("XDG_CONFIG_HOME", t.TempDir())
			f := newFakeCloudflare(t, oneAccount(), "karn")
			f.reject[tc.suffix] = "computer says no"

			var out bytes.Buffer
			err := runRelaySetup(&out, strings.NewReader(setupToken+"\n"), f.client())
			if err == nil {
				t.Fatalf("runRelaySetup succeeded with %s failing", tc.name)
			}
			if !strings.Contains(err.Error(), "computer says no") {
				t.Fatalf("error %q does not carry what Cloudflare said", err)
			}
			if strings.Contains(err.Error(), setupToken) {
				t.Fatalf("the error carries the API token: %v", err)
			}
			if _, ok, _ := config.LoadRelay(); ok {
				t.Fatal("relay.json was written for a setup that failed")
			}
		})
	}
}

// --- flue relay join ---------------------------------------------------------

// TestRunRelayJoinWritesTheRelayConfig is the second machine's whole ceremony:
// no Cloudflare API, no token — the relay already exists — just the url and
// secret the first machine's setup printed, written to relay.json with a fresh
// machine id minted here.
func TestRunRelayJoinWritesTheRelayConfig(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())

	var out bytes.Buffer
	if err := runRelayJoin(&out, []string{"wss://flue-relay.karn.workers.dev", "--secret", "s3cr3t-from-setup"}); err != nil {
		t.Fatalf("runRelayJoin: %v", err)
	}

	saved := loadSavedRelay(t)
	if saved.URL != "wss://flue-relay.karn.workers.dev" {
		t.Fatalf("relay.json url = %q, want the bare wss:// host", saved.URL)
	}
	// The origin is derived the way setup derives it: the same host, https.
	if saved.Origin != "https://flue-relay.karn.workers.dev" {
		t.Fatalf("relay.json origin = %q, want https://flue-relay.karn.workers.dev", saved.Origin)
	}
	if saved.Secret != "s3cr3t-from-setup" {
		t.Fatalf("relay.json secret = %q, want the one given", saved.Secret)
	}
	if !machineIDRe.MatchString(saved.MachineID) {
		t.Fatalf("relay.json machine_id = %q, which is not a valid machine id", saved.MachineID)
	}
	hostname, err := os.Hostname()
	if err != nil {
		t.Fatalf("os.Hostname: %v", err)
	}
	if saved.MachineName != hostname {
		t.Fatalf("relay.json machine_name = %q, want this machine's hostname %q", saved.MachineName, hostname)
	}

	// 0600, the same argument as setup's write: the file holds the relay's
	// whole credential.
	dir, err := config.Dir()
	if err != nil {
		t.Fatalf("config.Dir: %v", err)
	}
	info, err := os.Stat(filepath.Join(dir, "relay.json"))
	if err != nil {
		t.Fatalf("Stat relay.json: %v", err)
	}
	if mode := info.Mode().Perm(); mode != 0o600 {
		t.Errorf("relay.json mode = %o, want 0600", mode)
	}
}

// TestRunRelayJoinNormalizesAnHTTPSURL: the address on the setup screen is an
// https origin as often as it is a wss url — they name the same host, and a
// user who pastes the one they can see must not be told it is wrong.
func TestRunRelayJoinNormalizesAnHTTPSURL(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())

	var out bytes.Buffer
	if err := runRelayJoin(&out, []string{"https://flue-relay.karn.workers.dev", "--secret", "s"}); err != nil {
		t.Fatalf("runRelayJoin: %v", err)
	}
	saved := loadSavedRelay(t)
	if saved.URL != "wss://flue-relay.karn.workers.dev" {
		t.Fatalf("relay.json url = %q, want the https url normalized to wss://", saved.URL)
	}
	if saved.Origin != "https://flue-relay.karn.workers.dev" {
		t.Fatalf("relay.json origin = %q", saved.Origin)
	}
}

// TestRunRelayJoinTakesADisplayName: --name replaces the hostname as the
// machine's label. It is free text for humans and never enters a URL, so it is
// stored as given.
func TestRunRelayJoinTakesADisplayName(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())

	var out bytes.Buffer
	if err := runRelayJoin(&out, []string{"wss://r.example", "--secret", "s", "--name", "Study Mac Mini"}); err != nil {
		t.Fatalf("runRelayJoin: %v", err)
	}
	if saved := loadSavedRelay(t); saved.MachineName != "Study Mac Mini" {
		t.Fatalf("relay.json machine_name = %q, want the --name given", saved.MachineName)
	}
}

// TestRunRelayJoinRefusesBadArguments: every refusal names what was missing or
// wrong, because this command is run from a line pasted across machines and
// the mistakes are predictable — a lost flag, a scheme that is neither wss nor
// https, an old-style url with the /daemon path still on it.
func TestRunRelayJoinRefusesBadArguments(t *testing.T) {
	for _, tc := range []struct {
		name string
		args []string
		want string // must appear in the error
	}{
		{"no arguments at all", nil, "url"},
		{"no url", []string{"--secret", "s"}, "url"},
		{"no secret", []string{"wss://r.example"}, "--secret"},
		{"empty secret", []string{"wss://r.example", "--secret", ""}, "--secret"},
		{"a scheme that is neither", []string{"http://r.example", "--secret", "s"}, "wss://"},
		{"no host", []string{"wss://", "--secret", "s"}, "url"},
		{"a path on the url", []string{"wss://r.example/daemon", "--secret", "s"}, "path"},
		{"a name past 64 runes", []string{"wss://r.example", "--secret", "s", "--name", strings.Repeat("é", 65)}, "--name"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("XDG_CONFIG_HOME", t.TempDir())
			var out bytes.Buffer
			err := runRelayJoin(&out, tc.args)
			if err == nil {
				t.Fatalf("runRelayJoin(%q) succeeded, want a refusal", tc.args)
			}
			if !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("error %q does not name %q", err, tc.want)
			}
			if _, ok, _ := config.LoadRelay(); ok {
				t.Fatal("relay.json was written for a join that was refused")
			}
		})
	}
}

func TestRunRelayStatusReportsTheConfiguredRelay(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())

	var out bytes.Buffer
	if err := runRelayStatus(&out); err != nil {
		t.Fatalf("runRelayStatus: %v", err)
	}
	if !strings.Contains(out.String(), "not configured") {
		t.Fatalf("status = %q, want it to say there is no relay", out.String())
	}

	if err := config.SaveRelay(config.Relay{
		URL:         "wss://flue-relay.karn.workers.dev",
		Secret:      "s3cret-value",
		Origin:      "https://flue-relay.karn.workers.dev",
		MachineID:   "karns-macbook-pro-a1b2",
		MachineName: "Karn's MacBook Pro",
	}); err != nil {
		t.Fatalf("SaveRelay: %v", err)
	}
	out.Reset()
	if err := runRelayStatus(&out); err != nil {
		t.Fatalf("runRelayStatus: %v", err)
	}
	got := out.String()
	if !strings.Contains(got, "wss://flue-relay.karn.workers.dev") {
		t.Fatalf("status = %q, want the relay's URL", got)
	}
	if strings.Contains(got, "s3cret-value") {
		t.Fatalf("status printed the relay secret: %q", got)
	}
}

func TestCmdRelayRejectsAnUnknownSubcommand(t *testing.T) {
	if err := cmdRelay(nil); err == nil {
		t.Fatal("cmdRelay with no subcommand should fail")
	}
	if err := cmdRelay([]string{"teardown"}); err == nil {
		t.Fatal("cmdRelay accepted an unknown subcommand")
	}
}

// TestUsageMentionsRelay keeps the relay lines in the help text: a subcommand
// nobody can discover may as well not exist.
func TestUsageMentionsRelay(t *testing.T) {
	for _, want := range []string{"flue relay setup", "flue relay join", "flue relay status"} {
		if !strings.Contains(usageText, want) {
			t.Fatalf("usage text does not mention %q:\n%s", want, usageText)
		}
	}
}

func slicesEqual(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
