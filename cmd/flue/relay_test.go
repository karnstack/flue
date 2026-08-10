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
	"reflect"
	"regexp"
	"strings"
	"sync"
	"testing"

	"github.com/karnstack/flue/internal/cloudflare"
	"github.com/karnstack/flue/internal/config"
	"github.com/karnstack/flue/internal/crypto"
	"github.com/karnstack/flue/internal/daemon"
	"github.com/karnstack/flue/internal/fleet"
	relaybundle "github.com/karnstack/flue/relay"
	"github.com/karnstack/flue/web"
)

// setupToken is the API token every test in this file pastes in. It is a
// distinctive string on purpose: several assertions are "this must appear
// nowhere", and they are only worth anything if a match could not be a
// coincidence.
const setupToken = "cf-token-must-never-be-printed-or-stored"

// testFleetSeed is a fleet key spelled the way the join line spells one: 32
// bytes, unpadded base64url. Fixed rather than minted, so a test that asserts
// on a rebuilt join line can name the string it expects.
const testFleetSeed = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"

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
		Type        string `json:"type"`
		Name        string `json:"name"`
		ClassName   string `json:"class_name"`
		Text        string `json:"text"`
		NamespaceID string `json:"namespace_id"`
		Simple      *struct {
			Limit  int `json:"limit"`
			Period int `json:"period"`
		} `json:"simple"`
	} `json:"bindings"`
	KeepBindings []string `json:"keep_bindings"`
	Migrations   *struct {
		OldTag string `json:"old_tag"`
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
	// script is the Worker name the fake expects requests for; the default is
	// relayScriptName, and a test that deploys under --worker overrides it.
	script string
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
	secretPuts       int
	secretName       string
	secretText       string
	secretType       string
	subdomainEnabled bool
	scriptPuts       int
	// migrationTag is what the account's copy of the script carries, exactly
	// as the real API reports it on the script list — empty until a deploy
	// applies a migration, and then whatever that migration's new_tag was.
	//
	// Modelling it is what makes a re-run of `flue relay setup` behave here the
	// way it does in production: the client reads this tag first and sends no
	// migration when there is nothing outstanding, so the already-applied
	// refusal below is reached only when a deploy insists on a migration the
	// tag says is done.
	migrationTag string
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
		script:    relayScriptName,
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
	case strings.HasSuffix(p, "/scripts/"+f.script+"/subdomain"):
		f.mu.Lock()
		f.subdomainEnabled = true
		f.mu.Unlock()
		writeResult(w, map[string]bool{"enabled": true})
	case strings.HasSuffix(p, "/workers/subdomain"):
		writeResult(w, map[string]string{"subdomain": f.subdomain})
	case strings.HasSuffix(p, "/workers/scripts"):
		// The account's script list, which is where the deploy reads the
		// migration tag from. An account that has never been deployed to
		// answers an empty list.
		f.mu.Lock()
		tag := f.migrationTag
		f.mu.Unlock()
		if tag == "" {
			writeResult(w, []any{})
			return
		}
		writeResult(w, []any{map[string]string{"id": f.script, "migration_tag": tag}})
	case strings.HasSuffix(p, "/scripts/"+f.script):
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
	// The precondition the real API enforces: a migration is applied only if
	// the script's tag is the one the request claims it is. old_tag empty means
	// "this script has no migration history", which is false the moment one has
	// been applied.
	claimed, carried := "", f.migrationTag
	if f.meta.Migrations != nil {
		claimed = f.meta.Migrations.OldTag
	}
	repeat := f.meta.Migrations != nil && claimed != carried
	if f.meta.Migrations != nil && !repeat {
		f.migrationTag = f.meta.Migrations.NewTag
	}
	keepsSecrets := false
	for _, k := range f.meta.KeepBindings {
		if k == "secret_text" {
			keepsSecrets = true
		}
	}
	f.mu.Unlock()
	if repeat {
		// The refusal the real API actually sends when the precondition does
		// not hold, verbatim from the first live `flue relay update` (error
		// 10079). An earlier fake used a "class … already depended on" wording
		// that the real API apparently reserves for other cases; the matcher
		// missed this one in production, so the fake speaks the observed
		// dialect. Both tags are named the way the real message names them.
		writeAPIErrorCode(w, 10079, fmt.Sprintf(
			"Actor migration tag precondition failed, got tag '%s' when expected tag is '%s'. Please make sure the tags match and try again.",
			claimed, carried))
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
	f.secretPuts++
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
	writeAPIErrorCode(w, 10000, msg)
}

func writeAPIErrorCode(w http.ResponseWriter, code int, msg string) {
	b, _ := json.Marshal(msg)
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusBadRequest)
	_, _ = fmt.Fprintf(w, `{"success":false,"errors":[{"code":%d,"message":%s}],"result":null}`, code, b)
}

// --- helpers -----------------------------------------------------------------

// machineIDRe is the relay's id grammar (relay/src/index.ts): a slug, then an
// 8-hex MAC tag. Every id this command mints has to satisfy it — and its tag
// has to verify under the secret saved beside it (config.MachineIDTag) — or
// the Worker answers the dial with 404.
var machineIDRe = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,53}-[0-9a-f]{8}$`)

// assertMachineIDMinted checks an id the CLI minted: inside the grammar, and
// tagged under the secret it will dial with — the property the Worker's
// verifyMachineId enforces before any id picks a Durable Object.
func assertMachineIDMinted(t *testing.T, id, secret string) {
	t.Helper()
	if !machineIDRe.MatchString(id) {
		t.Fatalf("machine id %q is not inside the relay's grammar", id)
	}
	slug, tag := id[:len(id)-9], id[len(id)-8:]
	if want := config.MachineIDTag(secret, slug); tag != want {
		t.Fatalf("machine id %q carries tag %q, want %q — the tag must be the MAC of the slug under the saved secret, or the relay will never route this machine", id, tag, want)
	}
}

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
	if err := runRelaySetup(&out, strings.NewReader(setupToken+"\n"), f.client(), nil); err != nil {
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
	var gotAssets, gotHub, gotDirectory, gotVersion, gotRate bool
	for _, b := range f.meta.Bindings {
		switch {
		case b.Type == "assets" && b.Name == "ASSETS":
			gotAssets = true
		case b.Type == "durable_object_namespace" && b.Name == "HUB" && b.ClassName == "DaemonHub":
			gotHub = true
		case b.Type == "durable_object_namespace" && b.Name == "DIRECTORY" && b.ClassName == "FleetDirectory":
			// The fleet directory: one object for the whole relay. Without the
			// binding the Worker answers /directory with 503 by design, which
			// is a relay that carries every session and no fleet — no machine
			// discovery, and no revocation reaching a second machine.
			gotDirectory = true
		case b.Type == "plain_text" && b.Name == "FLUE_VERSION" && b.Text == deployStamp():
			// The version stamp: what the Worker reports on /api/health, and
			// what lets a daemon see a relay older than itself.
			gotVersion = true
		case b.Type == "ratelimit" && b.Name == "CLIENT_RATE":
			// The per-IP bound on the credential-less routes. The numbers are
			// pinned here because they have a dev-only twin in
			// relay/wrangler.jsonc, and this deploy is the one users run.
			if b.NamespaceID != "1001" || b.Simple == nil || b.Simple.Limit != 300 || b.Simple.Period != 60 {
				t.Fatalf("ratelimit binding = %+v, want namespace 1001, 300 per 60s", b)
			}
			gotRate = true
		}
	}
	if !gotVersion {
		t.Fatalf("no FLUE_VERSION plain_text binding carrying %q in %+v", deployStamp(), f.meta.Bindings)
	}
	if !gotAssets {
		t.Fatalf("no assets binding named ASSETS in %+v; env.ASSETS would be undefined in the deployed worker", f.meta.Bindings)
	}
	if !gotHub {
		t.Fatalf("no HUB -> DaemonHub durable object binding in %+v", f.meta.Bindings)
	}
	if !gotDirectory {
		t.Fatalf("no DIRECTORY -> FleetDirectory durable object binding in %+v; the deployed relay would answer /directory with 503 and no revocation would ever reach a second machine", f.meta.Bindings)
	}
	if !gotRate {
		t.Fatalf("no CLIENT_RATE ratelimit binding in %+v; the deployed relay would serve its credential-less routes unmetered", f.meta.Bindings)
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

	// A first deploy into an empty account applies the whole history, in
	// order, and claims no precondition: the two SQLite classes this relay
	// runs on (spec/fleet-trust.md gives the second one its own tag, because
	// v1 is already applied on every relay deployed before the directory
	// existed and an applied migration cannot be edited).
	if f.meta.Migrations == nil {
		t.Fatal("no durable object migration was sent; neither class would exist")
	}
	if f.meta.Migrations.OldTag != "" {
		t.Fatalf("old_tag = %q on a first deploy, want none", f.meta.Migrations.OldTag)
	}
	if f.meta.Migrations.NewTag != "v2" {
		t.Fatalf("new_tag = %q, want v2", f.meta.Migrations.NewTag)
	}
	if len(f.meta.Migrations.Steps) != 2 ||
		!slicesEqual(f.meta.Migrations.Steps[0].NewSQLiteClasses, []string{"DaemonHub"}) ||
		!slicesEqual(f.meta.Migrations.Steps[1].NewSQLiteClasses, []string{"FleetDirectory"}) {
		t.Fatalf("migrations = %+v, want v1 introducing DaemonHub then v2 introducing FleetDirectory", f.meta.Migrations)
	}
	if f.meta.Assets == nil {
		t.Fatal("no assets attached to the script")
	}
	if got, want := f.meta.Assets.Config.RunWorkerFirst, []string{"/daemon", "/daemon/*", "/client", "/client/*", "/api/*", "/directory", "/directory/*"}; !slicesEqual(got, want) {
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
	if len(raw) != 32 {
		t.Fatalf("the saved secret decodes to %d bytes, want %d", len(raw), 32)
	}

	// The second credential, which is the whole of stage 2: setup mints a
	// fleet key, persists it here, and hands it on in the join line. A
	// regression that dropped `FleetSeed:` from this SaveRelay would leave
	// every machine that joined afterwards unable to start its relay leg at
	// all (relay.New refuses a config without one) — and, before this
	// assertion existed, would leave the suite green.
	if _, err := fleet.Parse(saved.FleetSeed); err != nil {
		t.Fatalf("relay.json fleet_seed = %q, want a key fleet.Parse accepts: %v", saved.FleetSeed, err)
	}
	// And it went to Cloudflare in no shape at all — not as the secret, not
	// as a binding, not in the uploaded module. That is the property the
	// whole design rests on (spec/fleet-trust.md): the Worker gates routing
	// and holds nothing that signs.
	if f.secretText == saved.FleetSeed {
		t.Fatal("the fleet key was uploaded as the worker's secret")
	}
	if hits := configFilesContaining(t, saved.FleetSeed); len(hits) != 1 || filepath.Base(hits[0]) != "relay.json" {
		t.Fatalf("the fleet key should be in relay.json and nowhere else, got %v", hits)
	}

	// And the first thing that key signs: this machine's own certificate,
	// which the daemon publishes to the relay's fleet directory so the rest of
	// the fleet's browsers can find it. Setup is where it is minted, because
	// setup is where the id and the name it asserts are decided.
	fleetKey, err := fleet.Parse(saved.FleetSeed)
	if err != nil {
		t.Fatalf("fleet.Parse: %v", err)
	}
	machineCert, err := fleet.Verify(fleetKey.Public(), saved.MachineCert)
	if err != nil {
		t.Fatalf("relay.json holds no machine certificate this fleet key signed: %v", err)
	}
	if mc, ok := machineCert.(fleet.MachineCert); !ok || mc.ID != saved.MachineID {
		t.Fatalf("machine certificate = %+v, want one naming %q", machineCert, saved.MachineID)
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
	assertMachineIDMinted(t, saved.MachineID, saved.Secret)
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
		"✓ fleet key minted",
		// Both credentials, exactly as saved: the line is the hand-off, and
		// a line missing --fleet is one `flue relay join` refuses outright.
		"flue relay join wss://" + host + " --secret " + saved.Secret + " --fleet " + saved.FleetSeed,
		"token stored for one-click updates",
	} {
		if !strings.Contains(transcript, want) {
			t.Fatalf("transcript is missing %q:\n%s", want, transcript)
		}
	}

	// The token was used, never echoed, and stored in exactly one place: the
	// 0600 cloudflare.json that makes the next update a click. Storing it is
	// the product decision; ONE file is the discipline that remains.
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
	hits := configFilesContaining(t, setupToken)
	if len(hits) != 1 || filepath.Base(hits[0]) != "cloudflare.json" {
		t.Fatalf("the API token should be in cloudflare.json and nowhere else, got %v", hits)
	}
	cf, ok, err := config.LoadCloudflare()
	if err != nil || !ok {
		t.Fatalf("LoadCloudflare after setup: ok=%v err=%v", ok, err)
	}
	if cf.Token != setupToken || cf.AccountID == "" {
		t.Fatalf("stored credential = %+v; want the pasted token and the deployed account", cf)
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
	if err := runRelaySetup(&out, strings.NewReader(setupToken+"\n"), f.client(), nil); err != nil {
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
	if err := runRelaySetup(&out, strings.NewReader(setupToken+"\n"), f.client(), nil); err != nil {
		t.Fatalf("first runRelaySetup: %v", err)
	}
	first := loadSavedRelay(t)

	out.Reset()
	if err := runRelaySetup(&out, strings.NewReader(setupToken+"\n"), f.client(), nil); err != nil {
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
	// Two PUTs, one per run, and the second one carries no migration at all:
	// the deploy reads the tag the account's script already carries and finds
	// the history applied. This used to be three, the extra one being a
	// migration sent blind, refused on the tag precondition, and re-sent
	// without it — a round trip that only ever existed because the client
	// could not ask.
	if f.scriptPuts != 2 {
		t.Fatalf("script PUTs = %d, want 2 (one per run, the second with nothing to migrate)", f.scriptPuts)
	}
	if f.meta.Migrations != nil {
		t.Fatalf("the re-run sent a migration for a script already at its last tag: %+v", f.meta.Migrations)
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
	if err := runRelaySetup(&out, strings.NewReader(setupToken+"\n"), f.client(), nil); err != nil {
		t.Fatalf("first runRelaySetup: %v", err)
	}
	live := loadSavedRelay(t)

	f.reject["/workers/subdomain"] = "computer says no"
	out.Reset()
	if err := runRelaySetup(&out, strings.NewReader(setupToken+"\n"), f.client(), nil); err == nil {
		t.Fatal("the re-run succeeded despite the subdomain step failing")
	}

	if f.secretText != live.Secret {
		t.Fatalf("the worker's %s is %q after a failed re-run, want the live relay's unchanged secret", daemonSecretName, f.secretText)
	}
	// reflect rather than ==: the record carries the machine certificate now,
	// and a []byte field is not comparable.
	if got := loadSavedRelay(t); !reflect.DeepEqual(got, live) {
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
	if err := runRelaySetup(&out, strings.NewReader(setupToken+"\n2\n"), f.client(), nil); err != nil {
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
	err := runRelaySetup(&out, strings.NewReader(setupToken+"\nnope\n9\n0\n"), f.client(), nil)
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
	if err := runRelaySetup(&out, strings.NewReader("\n"), f.client(), nil); err == nil {
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
			err := runRelaySetup(&out, strings.NewReader(setupToken+"\n"), f.client(), nil)
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
	if err := runRelayJoin(&out, []string{"wss://flue-relay.karn.workers.dev", "--secret", "s3cr3t-from-setup", "--fleet", testFleetSeed}); err != nil {
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
	// The other half of the line, and the half nothing else can replace: a
	// join that persisted the secret and dropped the fleet key would write a
	// relay.json this daemon refuses to dial (relay.New), which is a machine
	// that joined and then silently has no relay leg.
	if saved.FleetSeed != testFleetSeed {
		t.Fatalf("relay.json fleet_seed = %q, want the one given (%q)", saved.FleetSeed, testFleetSeed)
	}
	assertMachineIDMinted(t, saved.MachineID, saved.Secret)
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

// TestRunRelayJoinMintsThisMachinesFleetCertificate: the join line is where a
// machine joins the fleet, so it is where the machine's own certificate is
// signed — the artifact the daemon publishes to the relay's directory, and the
// only way a browser paired on another machine ever learns that this one
// exists and which Noise key to pin for it (spec/fleet-trust.md, "New
// machine").
//
// It is minted here, once, rather than at every daemon start, because the
// directory is content-addressed: a cert re-signed on each boot carries a
// fresh iat, hashes to a fresh key, and spends one of the directory's 512
// entries every time the daemon restarts.
func TestRunRelayJoinMintsThisMachinesFleetCertificate(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())

	var out bytes.Buffer
	if err := runRelayJoin(&out, []string{"wss://r.example", "--secret", "s", "--fleet", testFleetSeed}); err != nil {
		t.Fatalf("runRelayJoin: %v", err)
	}
	saved := loadSavedRelay(t)
	if len(saved.MachineCert) == 0 {
		t.Fatal("relay.json carries no machine certificate; this machine would never appear in the fleet directory")
	}

	key, err := fleet.Parse(testFleetSeed)
	if err != nil {
		t.Fatalf("fleet.Parse: %v", err)
	}
	cert, err := fleet.Verify(key.Public(), saved.MachineCert)
	if err != nil {
		t.Fatalf("the stored machine certificate does not verify under the fleet key: %v", err)
	}
	mc, ok := cert.(fleet.MachineCert)
	if !ok {
		t.Fatalf("relay.json holds a %s certificate where a machine certificate belongs", cert.Kind())
	}
	if mc.ID != saved.MachineID {
		t.Errorf("the certificate names machine %q, want the id in relay.json %q", mc.ID, saved.MachineID)
	}
	if mc.Name != saved.MachineName {
		t.Errorf("the certificate names %q, want the machine name in relay.json %q", mc.Name, saved.MachineName)
	}
	// The load-bearing field: browsers pin this key for this machine, so a
	// certificate naming anything but the daemon's own static key is a machine
	// every device dials and none can handshake with.
	dir, err := config.Dir()
	if err != nil {
		t.Fatalf("config.Dir: %v", err)
	}
	static, err := crypto.LoadOrCreateStaticKey(dir)
	if err != nil {
		t.Fatalf("LoadOrCreateStaticKey: %v", err)
	}
	if !bytes.Equal(mc.Noise, static.Public) {
		t.Errorf("the certificate names a static key this machine does not hold")
	}
}

// TestRunRelayJoinNormalizesTheAddress: the address arrives however the user
// came by it — the https origin off a browser's address bar as often as the
// wss url setup printed, in whatever case a hand retyped it — and every
// spelling names the same Worker, DNS being indifferent. relay.json has to
// hold the one spelling the relay announces itself with, because the daemon
// compares its configured origin byte for byte against the announced one on
// every channel open (internal/transport/relay/channel.go): a saved
// WSS://HOST would dial fine and then refuse every browser.
func TestRunRelayJoinNormalizesTheAddress(t *testing.T) {
	for _, tc := range []struct {
		name string
		arg  string
	}{
		{"an https origin", "https://flue-relay.karn.workers.dev"},
		{"an uppercase host", "wss://FLUE-Relay.KARN.workers.dev"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("XDG_CONFIG_HOME", t.TempDir())

			var out bytes.Buffer
			if err := runRelayJoin(&out, []string{tc.arg, "--secret", "s", "--fleet", testFleetSeed}); err != nil {
				t.Fatalf("runRelayJoin(%q): %v", tc.arg, err)
			}
			saved := loadSavedRelay(t)
			if saved.URL != "wss://flue-relay.karn.workers.dev" {
				t.Fatalf("relay.json url = %q, want %q normalized to wss:// and lowercase", saved.URL, tc.arg)
			}
			if saved.Origin != "https://flue-relay.karn.workers.dev" {
				t.Fatalf("relay.json origin = %q, want %q normalized to https:// and lowercase", saved.Origin, tc.arg)
			}
		})
	}
}

// TestRunRelayJoinTakesADisplayName: --name replaces the hostname as the
// machine's label. It is free text for humans and never enters a URL, so it is
// stored as given.
func TestRunRelayJoinTakesADisplayName(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())

	var out bytes.Buffer
	if err := runRelayJoin(&out, []string{"wss://r.example", "--secret", "s", "--fleet", testFleetSeed, "--name", "Study Mac Mini"}); err != nil {
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
		{"a scheme that is neither", []string{"http://r.example", "--secret", "s", "--fleet", testFleetSeed}, "wss://"},
		{"no host", []string{"wss://", "--secret", "s"}, "url"},
		{"a path on the url", []string{"wss://r.example/daemon", "--secret", "s", "--fleet", testFleetSeed}, "path"},
		{"a name past 64 runes", []string{"wss://r.example", "--secret", "s", "--fleet", testFleetSeed, "--name", strings.Repeat("é", 65)}, "--name"},
		{"no fleet key", []string{"wss://r.example", "--secret", "s"}, "--fleet"},
		{"a mangled fleet key", []string{"wss://r.example", "--secret", "s", "--fleet", "not-base64url!!"}, "fleet"},
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

	// A stand-in relay, so this command reads a directory rather than the
	// internet. Its host is what relay.json points at: `flue relay status`
	// asks the relay itself about the fleet, which is the one fact no local
	// file carries.
	dir := statusDirectory(t)
	if err := config.SaveRelay(config.Relay{
		URL:         dir.url,
		Secret:      "s3cret-value",
		FleetSeed:   testFleetSeed,
		Origin:      strings.Replace(dir.url, "wss://", "https://", 1),
		MachineID:   "karns-macbook-pro-a1b2-0f9a12cd",
		MachineName: "Karn's MacBook Pro",
	}); err != nil {
		t.Fatalf("SaveRelay: %v", err)
	}
	out.Reset()
	if err := runRelayStatus(&out); err != nil {
		t.Fatalf("runRelayStatus: %v", err)
	}
	got := out.String()
	if !strings.Contains(got, dir.url) {
		t.Fatalf("status = %q, want the relay's URL", got)
	}
	if strings.Contains(got, "s3cret-value") {
		t.Fatalf("status printed the relay secret: %q", got)
	}
	// Neither credential, and the fleet key least of all: this line ends up
	// in terminals, screenshots and bug reports, and the fleet key is the one
	// that admits devices everywhere.
	if strings.Contains(got, testFleetSeed) {
		t.Fatalf("status printed the fleet key: %q", got)
	}
}

// statusDirectory is a relay serving a fleet directory with one entry of each
// kind under testFleetSeed, plus one blob signed by nobody.
type fakeStatusRelay struct {
	url       string
	machineID string
}

func statusDirectory(t *testing.T) fakeStatusRelay {
	t.Helper()
	key, err := fleet.Parse(testFleetSeed)
	if err != nil {
		t.Fatalf("fleet.Parse: %v", err)
	}
	sign := func(c fleet.Cert) []byte {
		blob, err := key.Sign(c)
		if err != nil {
			t.Fatalf("signing a %s: %v", c.Kind(), err)
		}
		return blob
	}
	thirtyTwo := func(fill byte) []byte {
		b := make([]byte, 32)
		for i := range b {
			b[i] = fill
		}
		return b
	}
	const machineID = "karns-macbook-pro-a1b2-0f9a12cd"
	blobs := [][]byte{
		sign(fleet.MachineCert{ID: machineID, Name: "Karn's MacBook Pro", Noise: thirtyTwo(0x01), IAT: 1}),
		sign(fleet.DeviceCert{Device: thirtyTwo(0x02), Name: "phone", PairedOn: machineID, IAT: 2}),
		sign(fleet.Revocation{Device: thirtyTwo(0x03), IAT: 3}),
		// Signed by nothing this fleet key knows: the gap between "entries"
		// and "verified" is the number worth printing.
		[]byte("not a certificate at all"),
	}
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/directory" || r.Method != http.MethodGet {
			http.Error(w, "not found", http.StatusNotFound)
			return
		}
		entries := make([]map[string]any, 0, len(blobs))
		for _, b := range blobs {
			entries = append(entries, map[string]any{"key": "k", "blob": b})
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"v": 1, "entries": entries})
	}))
	t.Cleanup(ts.Close)
	return fakeStatusRelay{url: "ws" + strings.TrimPrefix(ts.URL, "http"), machineID: machineID}
}

// TestRunRelayStatusReportsTheFleetDirectory: the second line, and the reason
// this command talks to the network at all. It reports what the relay is
// holding, how much of it this fleet key actually signed, and — the one thing
// an operator most wants to know after adding a machine — whether this machine
// is in there at all.
func TestRunRelayStatusReportsTheFleetDirectory(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	dir := statusDirectory(t)
	if err := config.SaveRelay(config.Relay{
		URL:         dir.url,
		Secret:      "s",
		FleetSeed:   testFleetSeed,
		Origin:      strings.Replace(dir.url, "wss://", "https://", 1),
		MachineID:   dir.machineID,
		MachineName: "Karn's MacBook Pro",
	}); err != nil {
		t.Fatalf("SaveRelay: %v", err)
	}

	var out bytes.Buffer
	if err := runRelayStatus(&out); err != nil {
		t.Fatalf("runRelayStatus: %v", err)
	}
	got := out.String()
	for _, want := range []string{
		"4 entries",
		"3 verified",
		"1 machine, 1 device, 1 revocation",
		// The entry nobody in this fleet signed, named as such rather than
		// quietly counted: a relay serving blobs this key did not sign is
		// either a rotated fleet key or somebody else's relay.
		"1 entry is signed by something else",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("status does not say %q:\n%s", want, got)
		}
	}
	if strings.Contains(got, "this machine is not in the directory") {
		t.Errorf("status says this machine is missing, but its certificate is there:\n%s", got)
	}
}

// TestRunRelayStatusSaysWhenThisMachineIsMissing: the failure a new machine
// actually has — it joined, but nothing published its certificate, so no
// browser in the fleet can discover it. Silence there looks exactly like
// health.
func TestRunRelayStatusSaysWhenThisMachineIsMissing(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	dir := statusDirectory(t)
	if err := config.SaveRelay(config.Relay{
		URL:         dir.url,
		Secret:      "s",
		FleetSeed:   testFleetSeed,
		Origin:      strings.Replace(dir.url, "wss://", "https://", 1),
		MachineID:   "some-other-machine-a1b2-0f9a12cd",
		MachineName: "Someone Else",
	}); err != nil {
		t.Fatalf("SaveRelay: %v", err)
	}

	var out bytes.Buffer
	if err := runRelayStatus(&out); err != nil {
		t.Fatalf("runRelayStatus: %v", err)
	}
	if !strings.Contains(out.String(), "this machine is not in the directory") {
		t.Errorf("status does not report the missing machine certificate:\n%s", out.String())
	}
}

// TestRunRelayStatusSurvivesARelayWithNoDirectory: a relay deployed by a flue
// older than the directory answers 503 there by design. The status has to name
// the fix rather than print a bare HTTP code, and must not fail the command —
// the first line is still true.
func TestRunRelayStatusSurvivesARelayWithNoDirectory(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusServiceUnavailable)
		_, _ = w.Write([]byte(`{"error":"directory unavailable"}`))
	}))
	t.Cleanup(ts.Close)
	if err := config.SaveRelay(config.Relay{
		URL:         "ws" + strings.TrimPrefix(ts.URL, "http"),
		Secret:      "s",
		FleetSeed:   testFleetSeed,
		Origin:      "http" + strings.TrimPrefix(ts.URL, "http"),
		MachineID:   "karns-macbook-pro-a1b2-0f9a12cd",
		MachineName: "Karn's MacBook Pro",
	}); err != nil {
		t.Fatalf("SaveRelay: %v", err)
	}

	var out bytes.Buffer
	if err := runRelayStatus(&out); err != nil {
		t.Fatalf("runRelayStatus on a relay with no directory: %v", err)
	}
	if !strings.Contains(out.String(), "flue relay update") {
		t.Errorf("status does not name the fix for a relay with no directory:\n%s", out.String())
	}
}

// --- flue relay reset --------------------------------------------------------

// fakeResetRelay is a relay that answers the one route `flue relay reset`
// speaks, and remembers what it was asked.
type fakeResetRelay struct {
	url string

	mu      sync.Mutex
	deletes int
	auth    string
	held    int
}

func resetRelay(t *testing.T, held int) *fakeResetRelay {
	t.Helper()
	f := &fakeResetRelay{held: held}
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/directory" || r.Method != http.MethodDelete {
			http.Error(w, "not found", http.StatusNotFound)
			return
		}
		f.mu.Lock()
		f.deletes++
		f.auth = r.Header.Get("Authorization")
		removed := f.held
		f.held = 0
		f.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"reset": true, "removed": removed})
	}))
	t.Cleanup(ts.Close)
	f.url = "ws" + strings.TrimPrefix(ts.URL, "http")
	return f
}

func (f *fakeResetRelay) seen() (deletes int, auth string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.deletes, f.auth
}

func saveResetRelay(t *testing.T, url string) {
	t.Helper()
	if err := config.SaveRelay(config.Relay{
		URL:         url,
		Secret:      "the-daemon-secret",
		FleetSeed:   testFleetSeed,
		Origin:      strings.Replace(url, "wss://", "https://", 1),
		MachineID:   "karns-macbook-pro-a1b2-0f9a12cd",
		MachineName: "Karn's MacBook Pro",
	}); err != nil {
		t.Fatalf("SaveRelay: %v", err)
	}
}

// TestRunRelayResetEmptiesTheDirectory is the escape hatch working: a full
// directory refuses every later PUT — including a revocation, which is the
// fleet-wide kill switch — and nothing else in flue can clear it, because
// nothing evicts and Durable Object storage outlives every redeploy.
func TestRunRelayResetEmptiesTheDirectory(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	relay := resetRelay(t, 512)
	saveResetRelay(t, relay.url)

	var out bytes.Buffer
	if err := runRelayReset(&out, strings.NewReader("yes\n"), nil); err != nil {
		t.Fatalf("runRelayReset: %v", err)
	}
	deletes, auth := relay.seen()
	if deletes != 1 {
		t.Fatalf("the reset sent %d DELETEs, want 1", deletes)
	}
	// The daemon secret is the whole credential on this route: the relay holds
	// no fleet key and cannot judge a blob, so what it gates is who may write.
	if auth != "Bearer the-daemon-secret" {
		t.Errorf("the reset presented %q, not the daemon secret", auth)
	}
	got := out.String()
	if !strings.Contains(got, "512 entries cleared") {
		t.Errorf("the reset does not report what it removed:\n%s", got)
	}
	// The one thing the count does not say: the fleet puts it back by itself.
	if !strings.Contains(got, "re-publishes") {
		t.Errorf("the reset does not say the fleet refills the directory:\n%s", got)
	}
}

// TestRunRelayResetNeedsConfirmation: the wipe has one cost re-publishing does
// not put back — a revocation whose last holder never reconnects — so it must
// not be reachable by a mistyped command.
func TestRunRelayResetNeedsConfirmation(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	relay := resetRelay(t, 7)
	saveResetRelay(t, relay.url)

	var out bytes.Buffer
	if err := runRelayReset(&out, strings.NewReader("n\n"), nil); err != nil {
		t.Fatalf("runRelayReset declined: %v", err)
	}
	if deletes, _ := relay.seen(); deletes != 0 {
		t.Fatalf("a declined reset still sent %d DELETEs", deletes)
	}
	if !strings.Contains(out.String(), "nothing was reset") {
		t.Errorf("a declined reset does not say so:\n%s", out.String())
	}
	// And the warning has to name the one thing that does not come back.
	if !strings.Contains(out.String(), "never reconnects") {
		t.Errorf("the confirmation does not state the residual risk:\n%s", out.String())
	}
}

// TestRunRelayResetYesSkipsThePrompt: the scripted path, which must not hang
// on a reader nobody is going to type into.
func TestRunRelayResetYesSkipsThePrompt(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	relay := resetRelay(t, 1)
	saveResetRelay(t, relay.url)

	var out bytes.Buffer
	if err := runRelayReset(&out, strings.NewReader(""), []string{"--yes"}); err != nil {
		t.Fatalf("runRelayReset --yes: %v", err)
	}
	if deletes, _ := relay.seen(); deletes != 1 {
		t.Fatalf("--yes sent %d DELETEs, want 1", deletes)
	}
	if !strings.Contains(out.String(), "1 entry cleared") {
		t.Errorf("the reset does not report one entry in the singular:\n%s", out.String())
	}
}

// TestRunRelayResetWithoutARelayPointsAtSetup: the same shape every other relay
// subcommand takes on a machine that has none.
func TestRunRelayResetWithoutARelayPointsAtSetup(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	var out bytes.Buffer
	err := runRelayReset(&out, strings.NewReader("yes\n"), nil)
	if err == nil || !strings.Contains(err.Error(), "flue relay setup") {
		t.Fatalf("reset without a relay: %v", err)
	}
}

// TestRunRelayResetNamesTheUpdateForARelayWithNoDirectory: a Worker deployed by
// a flue older than the directory answers 503 on this route by design, and the
// fix is a redeploy rather than anything about this machine.
func TestRunRelayResetNamesTheUpdateForARelayWithNoDirectory(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusServiceUnavailable)
		_, _ = w.Write([]byte(`{"error":"directory unavailable"}`))
	}))
	t.Cleanup(ts.Close)
	saveResetRelay(t, "ws"+strings.TrimPrefix(ts.URL, "http"))

	var out bytes.Buffer
	err := runRelayReset(&out, strings.NewReader("yes\n"), []string{"--yes"})
	if err == nil || !strings.Contains(err.Error(), "flue relay update") {
		t.Fatalf("reset against a relay with no directory: %v", err)
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
	for _, want := range []string{"flue relay setup", "flue relay join", "flue relay status", "flue relay reset"} {
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

// --- flue relay setup --worker / flue relay update ---------------------------

// TestRelaySetupWorkerFlagDeploysUnderThatName: the flag names the script, and
// everything derived from the script name — the deploy path, the subdomain
// call, the printed line, the record in relay.json — follows it. This is what
// keeps a dev relay and a real one apart in one account.
func TestRelaySetupWorkerFlagDeploysUnderThatName(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	f := newFakeCloudflare(t, oneAccount(), "karn")
	f.script = "flue-relay-dev"

	var out bytes.Buffer
	err := runRelaySetup(&out, strings.NewReader(setupToken+"\n"), f.client(), []string{"--worker", "flue-relay-dev"})
	if err != nil {
		t.Fatalf("runRelaySetup --worker: %v", err)
	}
	if !strings.Contains(out.String(), "worker deployed: flue-relay-dev") {
		t.Fatalf("output does not name the worker it deployed:\n%s", out.String())
	}
	if !f.subdomainEnabled {
		t.Fatal("the workers.dev subdomain was never enabled for the custom-named script")
	}
	cfg, ok, err := config.LoadRelay()
	if err != nil || !ok {
		t.Fatalf("LoadRelay after setup: ok=%v err=%v", ok, err)
	}
	if cfg.Worker != "flue-relay-dev" {
		t.Fatalf("relay.json worker = %q, want flue-relay-dev", cfg.Worker)
	}
	if cfg.URL != "wss://flue-relay-dev.karn.workers.dev" {
		t.Fatalf("relay.json url = %q, want the custom script's workers.dev host", cfg.URL)
	}
}

// TestRelaySetupRefusesABadWorkerName, before any credential is asked for: a
// name the workers.dev grammar would refuse must die here, not as a deploy
// error after a token was pasted.
func TestRelaySetupRefusesABadWorkerName(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	f := newFakeCloudflare(t, oneAccount(), "karn")

	for _, bad := range []string{"Flue-Relay", "flue_relay", "-dev", "dev-", ""} {
		var out bytes.Buffer
		err := runRelaySetup(&out, strings.NewReader(setupToken+"\n"), f.client(), []string{"--worker", bad})
		if err == nil {
			t.Fatalf("--worker %q was accepted", bad)
		}
		if strings.Contains(out.String(), "Token:") {
			t.Fatalf("--worker %q was refused only after asking for a token", bad)
		}
	}
	if len(f.paths) != 0 {
		t.Fatalf("a refused worker name still reached the API: %v", f.paths)
	}
}

// TestRelayUpdateRedeploysAndRotatesNothing is the upgrade contract: a second
// deploy lands, and the secret, the machine id and relay.json are all exactly
// what setup left — because rotating any of them is what would force every
// other machine to re-join and every browser to re-pair.
func TestRelayUpdateRedeploysAndRotatesNothing(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	f := newFakeCloudflare(t, oneAccount(), "karn")

	var out bytes.Buffer
	if err := runRelaySetup(&out, strings.NewReader(setupToken+"\n"), f.client(), nil); err != nil {
		t.Fatalf("runRelaySetup: %v", err)
	}
	before, err := os.ReadFile(filepath.Join(os.Getenv("XDG_CONFIG_HOME"), "flue", "relay.json"))
	if err != nil {
		t.Fatalf("reading relay.json after setup: %v", err)
	}
	pathsBefore := len(f.paths)

	out.Reset()
	if err := runRelayUpdate(&out, strings.NewReader(setupToken+"\n"), f.client(), nil); err != nil {
		t.Fatalf("runRelayUpdate: %v", err)
	}

	// Three, not two: update's deploy meets the already-applied DO migration,
	// is refused, and retries without it — the same path a re-run of setup
	// takes. What matters is that at least one upload landed after setup's.
	if f.scriptPuts < 2 {
		t.Fatalf("script uploads = %d, want setup's and then update's", f.scriptPuts)
	}
	if want := relaybundle.Module(); !bytes.Equal(f.module, want) {
		t.Fatalf("the module deployed by update is %d bytes, want the embedded bundle's %d", len(f.module), len(want))
	}
	if f.secretPuts != 1 {
		t.Fatalf("secret puts = %d, want the single one setup performed", f.secretPuts)
	}
	for _, p := range f.paths[pathsBefore:] {
		if strings.HasSuffix(p, "/subdomain") {
			t.Fatalf("update touched the subdomain endpoint (%s); that is setup's job", p)
		}
	}
	after, err := os.ReadFile(filepath.Join(os.Getenv("XDG_CONFIG_HOME"), "flue", "relay.json"))
	if err != nil {
		t.Fatalf("reading relay.json after update: %v", err)
	}
	if !bytes.Equal(before, after) {
		t.Fatalf("update rewrote relay.json:\nbefore: %s\nafter:  %s", before, after)
	}
	if !strings.Contains(out.String(), "worker updated: "+relayScriptName) {
		t.Fatalf("output does not say what it updated:\n%s", out.String())
	}
	if strings.Contains(out.String(), setupToken) {
		t.Fatal("the API token appears in update's output")
	}
}

// TestRelayUpdateWithoutARelayPointsAtSetup: update refreshes a relay, it does
// not create one, and it must say so before asking for a credential.
func TestRelayUpdateWithoutARelayPointsAtSetup(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	f := newFakeCloudflare(t, oneAccount(), "karn")

	var out bytes.Buffer
	err := runRelayUpdate(&out, strings.NewReader(setupToken+"\n"), f.client(), nil)
	if err == nil {
		t.Fatal("update with no relay.json succeeded")
	}
	if !strings.Contains(err.Error(), "flue relay setup") {
		t.Fatalf("the error does not point at setup: %v", err)
	}
	if strings.Contains(out.String(), "Token:") {
		t.Fatal("update asked for a token before checking a relay exists")
	}
}

// TestUpdateWorkerNameResolution pins the order an update decides which script
// it redeploys: the flag, then relay.json's record, then the workers.dev
// host's first label — and a refusal, never a guess, when none of those hold.
func TestUpdateWorkerNameResolution(t *testing.T) {
	cases := []struct {
		name string
		flag string
		cfg  config.Relay
		want string
		err  bool
	}{
		{name: "flag wins", flag: "from-flag", cfg: config.Relay{Worker: "recorded", URL: "wss://x.karn.workers.dev"}, want: "from-flag"},
		{name: "recorded name", cfg: config.Relay{Worker: "recorded", URL: "wss://x.karn.workers.dev"}, want: "recorded"},
		{name: "derived from workers.dev", cfg: config.Relay{URL: "wss://flue-relay.karn.workers.dev"}, want: "flue-relay"},
		{name: "custom domain refused", cfg: config.Relay{URL: "wss://relay.example.com"}, err: true},
		{name: "bad flag refused", flag: "Nope", cfg: config.Relay{Worker: "recorded"}, err: true},
	}
	for _, tc := range cases {
		got, err := updateWorkerName(tc.flag, tc.cfg)
		if tc.err {
			if err == nil {
				t.Errorf("%s: got %q, want an error", tc.name, got)
			}
			continue
		}
		if err != nil || got != tc.want {
			t.Errorf("%s: got %q, %v; want %q", tc.name, got, err, tc.want)
		}
	}
}
