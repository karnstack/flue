package cloudflare

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
)

const testToken = "cf-token-do-not-log-me"

// The asset fixtures and their hashes. The hashes are golden values computed
// out-of-band by an independent implementation (Python: sha256 of
// base64(contents)+extension, hex, first 32 chars) so that this test pins the
// Cloudflare content-address contract rather than merely agreeing with
// whatever hashOf happens to do.
var (
	assetHTML = Asset{Path: "/index.html", Body: []byte("<!doctype html>\n<html></html>\n")}
	assetJS   = Asset{Path: "/assets/app-DEADBEEF.js", Body: []byte("console.log(1)\n")}
	assetCSS  = Asset{Path: "/assets/app-DEADBEEF.css", Body: []byte("body{}\n")}
)

const (
	hashHTML = "df1e6b093c7e5cfe2bbf6151b2ab6e5b"
	hashJS   = "c8240647cba3db2d4fd3fcaf1752e297"
	hashCSS  = "8fe2183fbd62057f970b473563d977c8"
)

// deployFixture is the DeployInput every deploy test starts from: it mirrors
// relay/wrangler.jsonc, which is the configuration this client has to be able
// to reproduce over the REST API.
func deployFixture() DeployInput {
	return DeployInput{
		AccountID:         "acct-123",
		ScriptName:        "flue-relay",
		Module:            []byte("export default { fetch() {} };\n"),
		CompatibilityDate: "2026-08-01",
		Migrations: []Migration{
			{Tag: "v1", NewSQLiteClasses: []string{"DaemonHub"}},
			{Tag: "v2", NewSQLiteClasses: []string{"FleetDirectory"}},
		},
		DOBindings:           map[string]string{"HUB": "DaemonHub", "DIRECTORY": "FleetDirectory"},
		Assets:               []Asset{assetHTML, assetJS, assetCSS},
		AssetsRunWorkerFirst: []string{"/daemon", "/client", "/api/*", "/directory", "/directory/*"},
		AssetHeaders:         "/*\n  X-Fixture: yes\n",
		AssetsBinding:        "ASSETS",
		RateLimits:           []RateLimit{{Name: "CLIENT_RATE", NamespaceID: "1001", Limit: 300, Period: 60}},
		Observability:        true,
	}
}

// recorded is one request the fixture server saw, captured eagerly because the
// handler's *http.Request is not valid once the handler returns.
type recorded struct {
	Method      string
	Path        string
	RawQuery    string
	Auth        string
	ContentType string
	Body        []byte
	Header      http.Header
}

// fixture is a scripted Cloudflare API. Tests supply a handler that answers the
// endpoints they care about; the fixture records every request first so the
// assertions can be made after the call under test returns.
type fixture struct {
	t   *testing.T
	srv *httptest.Server

	// deployedTag is the migration tag this account's copy of the script
	// carries, answered on the script-list endpoint Deploy reads it from
	// (deployedMigrationTag). Empty is the honest default: an account with no
	// script yet. Tests that model a relay already deployed set it before
	// calling Deploy.
	//
	// It is answered by the fixture itself rather than by each test's handler
	// because it is a pre-flight read every deploy makes, and thirty handlers
	// each restating "and this is the script list" would be thirty chances to
	// state it differently. The request is still recorded, so a test can
	// assert that the read happened and what it asked for.
	deployedTag string
	// noScriptList makes the endpoint 404 through the test's own handler
	// instead, which is how "the lookup failed" is staged.
	noScriptList bool

	mu   sync.Mutex
	reqs []recorded
}

// scriptListPath is the endpoint Deploy reads the deployed migration tag from.
const scriptListPath = "/accounts/acct-123/workers/scripts"

func newFixture(t *testing.T, h func(w http.ResponseWriter, r *http.Request, body []byte)) *fixture {
	t.Helper()
	f := &fixture{t: t}
	f.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(r.Body)
		if err != nil {
			t.Errorf("fixture: reading %s %s body: %v", r.Method, r.URL.Path, err)
			http.Error(w, "read", http.StatusInternalServerError)
			return
		}
		f.mu.Lock()
		f.reqs = append(f.reqs, recorded{
			Method:      r.Method,
			Path:        r.URL.Path,
			RawQuery:    r.URL.RawQuery,
			Auth:        r.Header.Get("Authorization"),
			ContentType: r.Header.Get("Content-Type"),
			Body:        body,
			Header:      r.Header.Clone(),
		})
		f.mu.Unlock()
		if r.Method == http.MethodGet && r.URL.Path == scriptListPath && !f.noScriptList {
			f.writeScriptList(w)
			return
		}
		h(w, r, body)
	}))
	t.Cleanup(f.srv.Close)
	return f
}

// writeScriptList answers the account's script list the way Cloudflare does:
// one entry per script, carrying its id and its migration tag. An empty
// deployedTag answers an empty account, which is a first deploy.
func (f *fixture) writeScriptList(w http.ResponseWriter) {
	if f.deployedTag == "" {
		writeEnvelope(f.t, w, http.StatusOK, []any{})
		return
	}
	writeEnvelope(f.t, w, http.StatusOK, []any{
		// A neighbouring script, so "find the entry whose id matches" is
		// tested rather than "take the first one".
		map[string]any{"id": "someone-elses-worker", "migration_tag": "v9"},
		map[string]any{"id": "flue-relay", "migration_tag": f.deployedTag},
	})
}

func (f *fixture) client() *Client {
	return &Client{Token: testToken, Base: f.srv.URL}
}

func (f *fixture) requests() []recorded {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]recorded(nil), f.reqs...)
}

// only returns the single request to path, failing if there was not exactly one.
func (f *fixture) only(path string) recorded {
	f.t.Helper()
	var found []recorded
	for _, r := range f.requests() {
		if r.Path == path {
			found = append(found, r)
		}
	}
	if len(found) != 1 {
		f.t.Fatalf("got %d requests to %s, want exactly 1 (all: %s)", len(found), path, f.paths())
	}
	return found[0]
}

func (f *fixture) paths() string {
	var b strings.Builder
	for i, r := range f.requests() {
		if i > 0 {
			b.WriteString(", ")
		}
		fmt.Fprintf(&b, "%s %s", r.Method, r.Path)
	}
	return b.String()
}

// writeEnvelope writes a Cloudflare success envelope around result.
func writeEnvelope(t *testing.T, w http.ResponseWriter, status int, result any) {
	t.Helper()
	raw, err := json.Marshal(result)
	if err != nil {
		t.Fatalf("marshalling fixture result: %v", err)
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	fmt.Fprintf(w, `{"success":true,"errors":[],"messages":[],"result":%s}`, raw)
}

// scriptPut is the one script upload a deploy made, found by method rather
// than by position: the requests around it (the migration-tag read, the asset
// session, the buckets) come and go with the input.
func scriptPut(t *testing.T, f *fixture) recorded {
	t.Helper()
	var found []recorded
	for _, r := range f.requests() {
		if r.Method == http.MethodPut {
			found = append(found, r)
		}
	}
	if len(found) != 1 {
		t.Fatalf("got %d script PUTs, want 1: %s", len(found), f.paths())
	}
	return found[0]
}

// writeAPIError writes a Cloudflare failure envelope.
func writeAPIError(w http.ResponseWriter, status, code int, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	fmt.Fprintf(w, `{"success":false,"errors":[{"code":%d,"message":%q}],"messages":[],"result":null}`, code, message)
}

// part is one decoded multipart part.
type part struct {
	Name        string
	FileName    string
	ContentType string
	Body        []byte
}

func parseParts(t *testing.T, contentType string, body []byte) []part {
	t.Helper()
	mediaType, params, err := mime.ParseMediaType(contentType)
	if err != nil {
		t.Fatalf("parsing Content-Type %q: %v", contentType, err)
	}
	if mediaType != "multipart/form-data" {
		t.Fatalf("Content-Type media type = %q, want multipart/form-data", mediaType)
	}
	mr := multipart.NewReader(strings.NewReader(string(body)), params["boundary"])
	var parts []part
	for {
		p, err := mr.NextPart()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			t.Fatalf("reading multipart body: %v", err)
		}
		b, err := io.ReadAll(p)
		if err != nil {
			t.Fatalf("reading part %q: %v", p.FormName(), err)
		}
		parts = append(parts, part{
			Name:        p.FormName(),
			FileName:    p.FileName(),
			ContentType: p.Header.Get("Content-Type"),
			Body:        b,
		})
	}
	return parts
}

func partNamed(t *testing.T, parts []part, name string) part {
	t.Helper()
	for _, p := range parts {
		if p.Name == name {
			return p
		}
	}
	var names []string
	for _, p := range parts {
		names = append(names, p.Name)
	}
	t.Fatalf("no multipart part named %q; got %v", name, names)
	return part{}
}

// ---------------------------------------------------------------- VerifyToken

func TestVerifyTokenCallsVerifyEndpointAsBearer(t *testing.T) {
	f := newFixture(t, func(w http.ResponseWriter, r *http.Request, _ []byte) {
		writeEnvelope(t, w, http.StatusOK, map[string]any{"id": "tok-1", "status": "active"})
	})

	if err := f.client().VerifyToken(context.Background()); err != nil {
		t.Fatalf("VerifyToken: %v", err)
	}

	got := f.only("/user/tokens/verify")
	if got.Method != http.MethodGet {
		t.Errorf("method = %s, want GET", got.Method)
	}
	if want := "Bearer " + testToken; got.Auth != want {
		t.Errorf("Authorization = %q, want %q", got.Auth, want)
	}
}

// TestVerifyTokenNamesAnInvalidToken: a 401 is the one failure the setup flow
// must be able to explain without the user reading a status code, so the error
// has to say the token is the problem and still carry Cloudflare's own words.
func TestVerifyTokenNamesAnInvalidToken(t *testing.T) {
	f := newFixture(t, func(w http.ResponseWriter, r *http.Request, _ []byte) {
		writeAPIError(w, http.StatusUnauthorized, 1000, "Invalid API Token")
	})

	err := f.client().VerifyToken(context.Background())
	if err == nil {
		t.Fatal("VerifyToken on a 401 = nil, want an error")
	}
	msg := err.Error()
	if !strings.Contains(msg, "token") {
		t.Errorf("error %q does not name the token as the problem", msg)
	}
	if !strings.Contains(msg, "1000") || !strings.Contains(msg, "Invalid API Token") {
		t.Errorf("error %q drops Cloudflare's code/message", msg)
	}

	var apiErr *APIError
	if !errors.As(err, &apiErr) {
		t.Fatalf("error %v is not an *APIError", err)
	}
	if apiErr.Code != 1000 {
		t.Errorf("APIError.Code = %d, want 1000", apiErr.Code)
	}
}

// TestVerifyTokenRejectsAnInactiveToken: Cloudflare answers 200 for a token
// that exists but is expired or disabled. Reporting that as success would send
// the user into a deploy that cannot work.
func TestVerifyTokenRejectsAnInactiveToken(t *testing.T) {
	for _, status := range []string{"expired", "disabled"} {
		t.Run(status, func(t *testing.T) {
			f := newFixture(t, func(w http.ResponseWriter, r *http.Request, _ []byte) {
				writeEnvelope(t, w, http.StatusOK, map[string]any{"id": "tok-1", "status": status})
			})
			err := f.client().VerifyToken(context.Background())
			if err == nil {
				t.Fatalf("VerifyToken with status %q = nil, want an error", status)
			}
			if !strings.Contains(err.Error(), status) {
				t.Errorf("error %q does not mention the token status %q", err, status)
			}
		})
	}
}

// errRoundTripper fails every request without reaching a server, standing in
// for no DNS, no route, or a refused connection.
type errRoundTripper struct{ err error }

func (t errRoundTripper) RoundTrip(*http.Request) (*http.Response, error) { return nil, t.err }

// TestVerifyTokenDoesNotBlameTheTokenForANetworkFailure: "the API token was
// rejected" is a claim about what Cloudflare said, and Cloudflare says nothing
// when the request never arrives. Rewording a transport failure that way sends
// the user off to reissue a credential that was fine, while the real problem —
// their network — goes unmentioned.
func TestVerifyTokenDoesNotBlameTheTokenForANetworkFailure(t *testing.T) {
	c := &Client{
		Token: testToken,
		Base:  "https://api.cloudflare.com/client/v4",
		HTTP:  &http.Client{Transport: errRoundTripper{errors.New("dial tcp: connection refused")}},
	}

	err := c.VerifyToken(context.Background())
	if err == nil {
		t.Fatal("VerifyToken with a dead transport = nil, want an error")
	}
	if strings.Contains(err.Error(), "rejected") {
		t.Errorf("error %q blames the token for a network failure", err)
	}
	if !strings.Contains(err.Error(), "connection refused") {
		t.Errorf("error %q loses the underlying transport failure", err)
	}
}

// ------------------------------------------------------------------- Accounts

func TestAccountsListsAccounts(t *testing.T) {
	f := newFixture(t, func(w http.ResponseWriter, r *http.Request, _ []byte) {
		writeEnvelope(t, w, http.StatusOK, []map[string]any{
			{"id": "acct-123", "name": "Karn's Account"},
			{"id": "acct-456", "name": "Side Project"},
		})
	})

	got, err := f.client().Accounts(context.Background())
	if err != nil {
		t.Fatalf("Accounts: %v", err)
	}
	want := []Account{
		{ID: "acct-123", Name: "Karn's Account"},
		{ID: "acct-456", Name: "Side Project"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("Accounts = %+v, want %+v", got, want)
	}

	req := f.only("/accounts")
	if req.Method != http.MethodGet {
		t.Errorf("method = %s, want GET", req.Method)
	}
	if want := "Bearer " + testToken; req.Auth != want {
		t.Errorf("Authorization = %q, want %q", req.Auth, want)
	}
	// Cloudflare's default page size is 20. Asking for more is the difference
	// between a user with many accounts seeing theirs and not.
	if !strings.Contains(req.RawQuery, "per_page=50") {
		t.Errorf("query = %q, want a per_page above Cloudflare's default of 20", req.RawQuery)
	}
}

// TestAccountsFollowsPagination: a token that can reach more accounts than fit
// on one page must still list all of them. Truncating silently would leave the
// user unable to pick their account with nothing on screen to say why.
func TestAccountsFollowsPagination(t *testing.T) {
	pages := [][]map[string]any{
		{{"id": "acct-1", "name": "One"}, {"id": "acct-2", "name": "Two"}},
		{{"id": "acct-3", "name": "Three"}},
	}
	f := newFixture(t, func(w http.ResponseWriter, r *http.Request, _ []byte) {
		page := r.URL.Query().Get("page")
		idx := 0
		if page == "2" {
			idx = 1
		}
		raw, err := json.Marshal(pages[idx])
		if err != nil {
			t.Fatalf("marshalling page: %v", err)
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintf(w, `{"success":true,"errors":[],"result":%s,
			"result_info":{"page":%s,"per_page":2,"count":%d,"total_count":3,"total_pages":2}}`,
			raw, page, len(pages[idx]))
	})

	got, err := f.client().Accounts(context.Background())
	if err != nil {
		t.Fatalf("Accounts: %v", err)
	}
	want := []Account{
		{ID: "acct-1", Name: "One"},
		{ID: "acct-2", Name: "Two"},
		{ID: "acct-3", Name: "Three"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("Accounts = %+v, want %+v", got, want)
	}

	reqs := f.requests()
	if len(reqs) != 2 {
		t.Fatalf("made %d requests (%s), want 2 pages", len(reqs), f.paths())
	}
	for i, want := range []string{"page=1", "page=2"} {
		if !strings.Contains(reqs[i].RawQuery, want) {
			t.Errorf("request %d query = %q, want %s", i, reqs[i].RawQuery, want)
		}
	}
}

// TestAccountsPaginatesWithoutTotalPages pins pagination against the shape
// Cloudflare actually documents for GET /accounts:
// {count, page, per_page, total_count} — with no total_pages field at all.
// A loop that decides whether to ask for another page by reading total_pages
// sees a zero here, concludes the first page was the last, and drops everyone
// past it without an error. Sixty accounts, fifty on a page: this test fails
// with 50 if that ever comes back.
func TestAccountsPaginatesWithoutTotalPages(t *testing.T) {
	const total = 60
	f := newFixture(t, func(w http.ResponseWriter, r *http.Request, _ []byte) {
		page := 1
		if r.URL.Query().Get("page") == "2" {
			page = 2
		}
		accounts := []map[string]any{}
		for i := (page - 1) * 50; i < total && i < page*50; i++ {
			accounts = append(accounts, map[string]any{
				"id":   fmt.Sprintf("acct-%d", i),
				"name": fmt.Sprintf("Account %d", i),
			})
		}
		raw, err := json.Marshal(accounts)
		if err != nil {
			t.Fatalf("marshalling page: %v", err)
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintf(w, `{"success":true,"errors":[],"result":%s,
			"result_info":{"page":%d,"per_page":50,"count":%d,"total_count":%d}}`,
			raw, page, len(accounts), total)
	})

	got, err := f.client().Accounts(context.Background())
	if err != nil {
		t.Fatalf("Accounts: %v", err)
	}
	if len(got) != total {
		t.Fatalf("Accounts returned %d accounts, want %d: the pages after the first were dropped", len(got), total)
	}
	for i, a := range got {
		if want := fmt.Sprintf("acct-%d", i); a.ID != want {
			t.Fatalf("account %d = %q, want %q", i, a.ID, want)
		}
	}
	if n := len(f.requests()); n != 2 {
		t.Errorf("made %d requests, want 2 (%s)", n, f.paths())
	}
}

// TestAccountsPaginatesWithNoResultInfoAtAll: an answer with no pagination
// block is not automatically a complete one. A full page is a full page, and
// the list only ends where the results do.
func TestAccountsPaginatesWithNoResultInfoAtAll(t *testing.T) {
	f := newFixture(t, func(w http.ResponseWriter, r *http.Request, _ []byte) {
		accounts := []map[string]any{}
		n := 50
		if r.URL.Query().Get("page") == "2" {
			n = 3
		}
		for i := 0; i < n; i++ {
			accounts = append(accounts, map[string]any{"id": fmt.Sprintf("acct-%s-%d", r.URL.Query().Get("page"), i)})
		}
		writeEnvelope(t, w, http.StatusOK, accounts)
	})

	got, err := f.client().Accounts(context.Background())
	if err != nil {
		t.Fatalf("Accounts: %v", err)
	}
	if len(got) != 53 {
		t.Errorf("Accounts returned %d accounts, want 53", len(got))
	}
	if n := len(f.requests()); n != 2 {
		t.Errorf("made %d requests, want 2 (%s)", n, f.paths())
	}
}

// TestAccountsStopsOnAnEmptyPage: a server that keeps claiming there is another
// page must not spin this loop forever.
func TestAccountsStopsOnAnEmptyPage(t *testing.T) {
	f := newFixture(t, func(w http.ResponseWriter, r *http.Request, _ []byte) {
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, `{"success":true,"errors":[],"result":[],
			"result_info":{"page":1,"per_page":50,"count":0,"total_count":9999,"total_pages":9999}}`)
	})

	got, err := f.client().Accounts(context.Background())
	if err != nil {
		t.Fatalf("Accounts: %v", err)
	}
	if len(got) != 0 {
		t.Errorf("Accounts = %+v, want empty", got)
	}
	if n := len(f.requests()); n != 1 {
		t.Errorf("made %d requests for an empty first page, want 1", n)
	}
}

// TestAccountsStopsAtThePageBound: a full page is the signal to ask for
// another one, so a server that answers every page full has to be stopped by
// something other than the results. That something is maxAccountPages.
func TestAccountsStopsAtThePageBound(t *testing.T) {
	f := newFixture(t, func(w http.ResponseWriter, r *http.Request, _ []byte) {
		accounts := make([]map[string]any, 0, 50)
		for i := 0; i < 50; i++ {
			accounts = append(accounts, map[string]any{"id": fmt.Sprintf("acct-%s-%d", r.URL.Query().Get("page"), i)})
		}
		writeEnvelope(t, w, http.StatusOK, accounts)
	})

	got, err := f.client().Accounts(context.Background())
	if err != nil {
		t.Fatalf("Accounts: %v", err)
	}
	if n := len(f.requests()); n != maxAccountPages {
		t.Errorf("made %d requests against an endless server, want the %d-page bound", n, maxAccountPages)
	}
	if len(got) != maxAccountPages*50 {
		t.Errorf("Accounts returned %d accounts, want %d", len(got), maxAccountPages*50)
	}
}

// TestEnvelopeErrorSurfacesCodeAndMessage pins the error text every caller in
// the setup flow is going to print.
func TestEnvelopeErrorSurfacesCodeAndMessage(t *testing.T) {
	f := newFixture(t, func(w http.ResponseWriter, r *http.Request, _ []byte) {
		writeAPIError(w, http.StatusForbidden, 10000, "Authentication error")
	})

	_, err := f.client().Accounts(context.Background())
	if err == nil {
		t.Fatal("Accounts against a failure envelope = nil, want an error")
	}
	if got, want := err.Error(), "cloudflare: 10000 Authentication error"; got != want {
		t.Errorf("error = %q, want %q", got, want)
	}
}

// TestEnvelopeErrorWithoutErrorsStillFails: a body that says success:false but
// lists no errors must not be mistaken for a success.
func TestEnvelopeErrorWithoutErrorsStillFails(t *testing.T) {
	f := newFixture(t, func(w http.ResponseWriter, r *http.Request, _ []byte) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		io.WriteString(w, `{"success":false,"errors":[],"result":null}`)
	})

	if _, err := f.client().Accounts(context.Background()); err == nil {
		t.Fatal("Accounts on success:false with no errors = nil, want an error")
	}
}

// TestNonJSONFailureIsReported: Cloudflare's edge can answer with HTML on a 5xx.
// That must be an error naming the status, not a nil-result success.
func TestNonJSONFailureIsReported(t *testing.T) {
	f := newFixture(t, func(w http.ResponseWriter, r *http.Request, _ []byte) {
		w.WriteHeader(http.StatusBadGateway)
		io.WriteString(w, "<html>bad gateway</html>")
	})

	_, err := f.client().Accounts(context.Background())
	if err == nil {
		t.Fatal("Accounts on a non-JSON 502 = nil, want an error")
	}
	if !strings.Contains(err.Error(), "502") {
		t.Errorf("error %q does not name the HTTP status", err)
	}
}

// TestTokenIsNeverInAnError: the token is a credential and these errors reach
// logs and the terminal.
func TestTokenIsNeverInAnError(t *testing.T) {
	f := newFixture(t, func(w http.ResponseWriter, r *http.Request, _ []byte) {
		writeAPIError(w, http.StatusForbidden, 10000, "Authentication error")
	})

	_, err := f.client().Accounts(context.Background())
	if err == nil {
		t.Fatal("want an error")
	}
	if strings.Contains(err.Error(), testToken) {
		t.Errorf("error %q leaks the API token", err)
	}
	// Every way a Client can end up in a log line. %v on a value misses a
	// pointer-receiver String, and %#v ignores String entirely, so both have to
	// be covered rather than assumed.
	for _, s := range []string{
		fmt.Sprintf("%v", f.client()),
		fmt.Sprintf("%s", f.client()),
		fmt.Sprintf("%v", *f.client()),
		fmt.Sprintf("%s", *f.client()),
		fmt.Sprintf("%#v", f.client()),
		fmt.Sprintf("%#v", *f.client()),
	} {
		if strings.Contains(s, testToken) {
			t.Errorf("formatting a Client leaks the API token: %s", s)
		}
	}
}

// ------------------------------------------------------------------- hashOf

// TestAssetHashMatchesCloudflareReference pins the content-address to
// Cloudflare's own reference implementation: sha256 over base64(contents)
// concatenated with the extension (no dot), hex, truncated to 32 characters.
func TestAssetHashMatchesCloudflareReference(t *testing.T) {
	for _, tc := range []struct {
		asset Asset
		want  string
	}{
		{assetHTML, hashHTML},
		{assetJS, hashJS},
		{assetCSS, hashCSS},
	} {
		if got := hashOf(tc.asset); got != tc.want {
			t.Errorf("hashOf(%s) = %s, want %s", tc.asset.Path, got, tc.want)
		}
	}
}

// TestAssetHashSeparatesIdenticalBytesByExtension: the extension is part of the
// preimage precisely so two files with the same bytes but different types do
// not collide onto one content-address and get served with one Content-Type.
func TestAssetHashSeparatesIdenticalBytesByExtension(t *testing.T) {
	js := hashOf(Asset{Path: "/a.js", Body: []byte("x")})
	css := hashOf(Asset{Path: "/a.css", Body: []byte("x")})
	if js == css {
		t.Errorf("identical bytes with different extensions share a hash %s", js)
	}
}

// --------------------------------------------------------------------- Deploy

// deployServer is the scripted happy path: an upload session that asks for two
// buckets, the uploads themselves, and the script PUT.
func deployServer(t *testing.T, buckets [][]string, onScript func(w http.ResponseWriter, parts []part)) *fixture {
	t.Helper()
	uploads := 0
	return newFixture(t, func(w http.ResponseWriter, r *http.Request, body []byte) {
		switch {
		case strings.HasSuffix(r.URL.Path, "/assets-upload-session"):
			writeEnvelope(t, w, http.StatusOK, map[string]any{
				"jwt":     "session-jwt",
				"buckets": buckets,
			})
		case strings.HasSuffix(r.URL.Path, "/workers/assets/upload"):
			uploads++
			// Cloudflare returns the completion token only once every file in
			// the manifest has landed.
			if uploads == len(buckets) {
				writeEnvelope(t, w, http.StatusCreated, map[string]any{"jwt": "completion-token"})
			} else {
				writeEnvelope(t, w, http.StatusOK, map[string]any{})
			}
		case r.Method == http.MethodPut:
			onScript(w, parseParts(t, r.Header.Get("Content-Type"), body))
		default:
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
			http.Error(w, "unexpected", http.StatusTeapot)
		}
	})
}

func TestDeployUploadsAssetsThenPutsTheScript(t *testing.T) {
	buckets := [][]string{{hashHTML, hashJS}, {hashCSS}}
	f := deployServer(t, buckets, func(w http.ResponseWriter, parts []part) {
		writeEnvelope(t, w, http.StatusOK, map[string]any{"id": "flue-relay"})
	})

	if err := f.client().Deploy(context.Background(), deployFixture()); err != nil {
		t.Fatalf("Deploy: %v", err)
	}

	reqs := f.requests()
	if len(reqs) != 5 {
		t.Fatalf("got %d requests (%s), want 5: the migration-tag read, the session, 2 uploads, the script PUT", len(reqs), f.paths())
	}

	// --- the migration tag is read first ----------------------------------
	// Before anything is uploaded, because it decides what the script upload
	// at the end of this list will carry.
	if tagRead := reqs[0]; tagRead.Method != http.MethodGet || tagRead.Path != scriptListPath {
		t.Errorf("first request = %s %s, want GET %s", tagRead.Method, tagRead.Path, scriptListPath)
	}

	// --- the upload session carries the manifest -------------------------
	session := reqs[1]
	if session.Method != http.MethodPost {
		t.Errorf("session method = %s, want POST", session.Method)
	}
	if want := "/accounts/acct-123/workers/scripts/flue-relay/assets-upload-session"; session.Path != want {
		t.Errorf("session path = %s, want %s", session.Path, want)
	}
	if want := "Bearer " + testToken; session.Auth != want {
		t.Errorf("session Authorization = %q, want %q", session.Auth, want)
	}
	var manifestBody struct {
		Manifest map[string]struct {
			Hash string `json:"hash"`
			Size int    `json:"size"`
		} `json:"manifest"`
	}
	if err := json.Unmarshal(session.Body, &manifestBody); err != nil {
		t.Fatalf("decoding manifest: %v (body %s)", err, session.Body)
	}
	wantManifest := map[string]struct {
		Hash string `json:"hash"`
		Size int    `json:"size"`
	}{
		"/index.html":              {hashHTML, len(assetHTML.Body)},
		"/assets/app-DEADBEEF.js":  {hashJS, len(assetJS.Body)},
		"/assets/app-DEADBEEF.css": {hashCSS, len(assetCSS.Body)},
	}
	if !reflect.DeepEqual(manifestBody.Manifest, wantManifest) {
		t.Errorf("manifest = %+v, want %+v", manifestBody.Manifest, wantManifest)
	}

	// --- exactly the scripted buckets are uploaded -----------------------
	wantUploads := []map[string]struct {
		body        []byte
		contentType string
	}{
		{
			hashHTML: {assetHTML.Body, "text/html; charset=utf-8"},
			hashJS:   {assetJS.Body, "text/javascript; charset=utf-8"},
		},
		{
			hashCSS: {assetCSS.Body, "text/css; charset=utf-8"},
		},
	}
	for i, up := range reqs[2:4] {
		if up.Method != http.MethodPost {
			t.Errorf("upload %d method = %s, want POST", i, up.Method)
		}
		if want := "/accounts/acct-123/workers/assets/upload"; up.Path != want {
			t.Errorf("upload %d path = %s, want %s", i, up.Path, want)
		}
		if want := "base64=true"; up.RawQuery != want {
			t.Errorf("upload %d query = %q, want %q", i, up.RawQuery, want)
		}
		// The upload leg authenticates with the session JWT, not the API token.
		if want := "Bearer session-jwt"; up.Auth != want {
			t.Errorf("upload %d Authorization = %q, want %q", i, up.Auth, want)
		}
		parts := parseParts(t, up.ContentType, up.Body)
		if len(parts) != len(wantUploads[i]) {
			t.Errorf("upload %d has %d parts, want %d", i, len(parts), len(wantUploads[i]))
		}
		for _, p := range parts {
			want, ok := wantUploads[i][p.Name]
			if !ok {
				t.Errorf("upload %d has unexpected part %q", i, p.Name)
				continue
			}
			// The field name is the hash and the body is base64 of the file.
			if got, wantB64 := string(p.Body), base64.StdEncoding.EncodeToString(want.body); got != wantB64 {
				t.Errorf("upload %d part %s body = %q, want base64 %q", i, p.Name, got, wantB64)
			}
			if p.FileName != p.Name {
				t.Errorf("upload %d part %s filename = %q, want %q", i, p.Name, p.FileName, p.Name)
			}
			if p.ContentType != want.contentType {
				t.Errorf("upload %d part %s Content-Type = %q, want %q", i, p.Name, p.ContentType, want.contentType)
			}
		}
	}

	// --- the script PUT ---------------------------------------------------
	script := reqs[4]
	if script.Method != http.MethodPut {
		t.Errorf("script method = %s, want PUT", script.Method)
	}
	if want := "/accounts/acct-123/workers/scripts/flue-relay"; script.Path != want {
		t.Errorf("script path = %s, want %s", script.Path, want)
	}
	if want := "Bearer " + testToken; script.Auth != want {
		t.Errorf("script Authorization = %q, want %q", script.Auth, want)
	}
	parts := parseParts(t, script.ContentType, script.Body)

	// The metadata part must decode to exactly the golden document.
	meta := partNamed(t, parts, "metadata")
	assertGoldenMetadata(t, meta.Body)
	// Called out separately because the golden would let this regress under a
	// diff nobody reads closely: the assets binding is what creates env.ASSETS.
	// The completion token above only makes Cloudflare's router serve the
	// files — a Worker that calls env.ASSETS.fetch() itself, as the relay does
	// to fall through to the SPA, needs this binding or that call is on
	// undefined and every unmatched request 500s.
	assertAssetsBinding(t, meta.Body, "ASSETS")

	// The module part must arrive byte-identical, named as main_module, and
	// typed as an ES module.
	mod := partNamed(t, parts, "index.js")
	if !reflect.DeepEqual(mod.Body, deployFixture().Module) {
		t.Errorf("module part = %q, want %q", mod.Body, deployFixture().Module)
	}
	if want := "application/javascript+module"; mod.ContentType != want {
		t.Errorf("module Content-Type = %q, want %q", mod.ContentType, want)
	}
	if mod.FileName != "index.js" {
		t.Errorf("module filename = %q, want index.js", mod.FileName)
	}
}

// assertGoldenMetadata compares the metadata part against
// testdata/deploy_metadata.json as decoded JSON, so key order does not matter
// but every key and value does.
func assertGoldenMetadata(t *testing.T, body []byte) {
	t.Helper()
	goldenPath := filepath.Join("testdata", "deploy_metadata.json")
	goldenRaw, err := os.ReadFile(goldenPath)
	if err != nil {
		t.Fatalf("reading %s: %v", goldenPath, err)
	}
	var got, want any
	if err := json.Unmarshal(body, &got); err != nil {
		t.Fatalf("decoding metadata part: %v (body %s)", err, body)
	}
	if err := json.Unmarshal(goldenRaw, &want); err != nil {
		t.Fatalf("decoding %s: %v", goldenPath, err)
	}
	if !reflect.DeepEqual(got, want) {
		gotPretty, _ := json.MarshalIndent(got, "", "  ")
		wantPretty, _ := json.MarshalIndent(want, "", "  ")
		t.Errorf("metadata does not match %s\n--- got ---\n%s\n--- want ---\n%s", goldenPath, gotPretty, wantPretty)
	}
}

// bindingsOf decodes metadata.bindings.
func bindingsOf(t *testing.T, metadata []byte) []map[string]any {
	t.Helper()
	var m struct {
		Bindings []map[string]any `json:"bindings"`
	}
	if err := json.Unmarshal(metadata, &m); err != nil {
		t.Fatalf("decoding metadata: %v (%s)", err, metadata)
	}
	return m.Bindings
}

// assertAssetsBinding fails unless metadata.bindings carries exactly one
// {"type":"assets","name":name} and no stray class_name on it.
func assertAssetsBinding(t *testing.T, metadata []byte, name string) {
	t.Helper()
	var found []map[string]any
	for _, b := range bindingsOf(t, metadata) {
		if b["type"] == "assets" {
			found = append(found, b)
		}
	}
	if len(found) != 1 {
		t.Fatalf("got %d assets bindings, want 1: %s", len(found), metadata)
	}
	if got := found[0]["name"]; got != name {
		t.Errorf("assets binding name = %v, want %q", got, name)
	}
	// class_name belongs to durable_object_namespace bindings; an empty one
	// here would be a field the API has no meaning for.
	if _, ok := found[0]["class_name"]; ok {
		t.Errorf("assets binding carries a class_name: %v", found[0])
	}
}

// TestDeployKeepsTheDeployedSecretBindings: a script upload replaces the
// binding set outright, and DAEMON_SECRET is stored as a `secret_text`
// binding — so an upload that does not ask for secrets to be kept unbinds the
// only credential the relay's daemon leg authenticates with, and reports
// success while doing it. Both PUTs are checked, because the second one is the
// re-run path: that is the deploy that lands on a live relay with a live
// secret, and the first attempt failing on an already-applied migration is
// what a real re-run meets.
//
// Asserted on the decoded request body rather than on any state a fake keeps,
// so nothing here can pass because the fake happens not to model the drop.
func TestDeployKeepsTheDeployedSecretBindings(t *testing.T) {
	var metadatas [][]byte
	puts := 0
	f := newFixture(t, func(w http.ResponseWriter, r *http.Request, body []byte) {
		if strings.HasSuffix(r.URL.Path, "/assets-upload-session") {
			writeEnvelope(t, w, http.StatusOK, map[string]any{"jwt": "session-jwt", "buckets": [][]string{}})
			return
		}
		puts++
		metadatas = append(metadatas, partNamed(t, parseParts(t, r.Header.Get("Content-Type"), body), "metadata").Body)
		if puts == 1 {
			writeAPIError(w, http.StatusBadRequest, 10061,
				"Cannot apply new-sqlite-class migration to class DaemonHub that is already depended on by existing Durable Objects")
			return
		}
		writeEnvelope(t, w, http.StatusOK, map[string]any{"id": "flue-relay"})
	})

	if err := f.client().Deploy(context.Background(), deployFixture()); err != nil {
		t.Fatalf("Deploy: %v", err)
	}
	if len(metadatas) != 2 {
		t.Fatalf("script PUTs = %d, want 2 (the refused deploy and the retry)", len(metadatas))
	}
	for i, raw := range metadatas {
		var m struct {
			KeepBindings []string `json:"keep_bindings"`
		}
		if err := json.Unmarshal(raw, &m); err != nil {
			t.Fatalf("decoding metadata of PUT %d: %v (%s)", i+1, err, raw)
		}
		if !reflect.DeepEqual(m.KeepBindings, []string{"secret_text"}) {
			t.Errorf("PUT %d keep_bindings = %v, want [secret_text]; this upload would unbind DAEMON_SECRET: %s", i+1, m.KeepBindings, raw)
		}
	}
}

// TestDeployOmitsTheAssetsBindingWhenUnset: a Worker that only needs its files
// served by the router does not need env.<name>, and inventing a binding it
// never asked for would put a name in its environment out of nowhere.
func TestDeployOmitsTheAssetsBindingWhenUnset(t *testing.T) {
	in := deployFixture()
	in.AssetsBinding = ""

	f := deployServer(t, nil, func(w http.ResponseWriter, parts []part) {
		meta := partNamed(t, parts, "metadata")
		for _, b := range bindingsOf(t, meta.Body) {
			if b["type"] == "assets" {
				t.Errorf("metadata carries an assets binding that was not asked for: %s", meta.Body)
			}
		}
		writeEnvelope(t, w, http.StatusOK, map[string]any{"id": "flue-relay"})
	})

	if err := f.client().Deploy(context.Background(), in); err != nil {
		t.Fatalf("Deploy: %v", err)
	}
}

// TestDeployOmitsTheAssetsBindingWithNoAssets: binding a name to an asset store
// that was never uploaded would hand the Worker a Fetcher over nothing.
func TestDeployOmitsTheAssetsBindingWithNoAssets(t *testing.T) {
	in := deployFixture()
	in.Assets = nil

	f := newFixture(t, func(w http.ResponseWriter, r *http.Request, body []byte) {
		meta := partNamed(t, parseParts(t, r.Header.Get("Content-Type"), body), "metadata")
		for _, b := range bindingsOf(t, meta.Body) {
			if b["type"] == "assets" {
				t.Errorf("metadata binds assets with none to bind: %s", meta.Body)
			}
		}
		writeEnvelope(t, w, http.StatusOK, map[string]any{"id": "flue-relay"})
	})

	if err := f.client().Deploy(context.Background(), in); err != nil {
		t.Fatalf("Deploy: %v", err)
	}
}

// TestDeployOmitsObservabilityWhenOff: the field is a policy the caller sets,
// not something this client decides for every Worker it deploys.
func TestDeployOmitsObservabilityWhenOff(t *testing.T) {
	in := deployFixture()
	in.Observability = false

	f := deployServer(t, nil, func(w http.ResponseWriter, parts []part) {
		meta := partNamed(t, parts, "metadata")
		var m map[string]any
		if err := json.Unmarshal(meta.Body, &m); err != nil {
			t.Fatalf("decoding metadata: %v", err)
		}
		if _, ok := m["observability"]; ok {
			t.Errorf("metadata carries observability with it turned off: %s", meta.Body)
		}
		writeEnvelope(t, w, http.StatusOK, map[string]any{"id": "flue-relay"})
	})

	if err := f.client().Deploy(context.Background(), in); err != nil {
		t.Fatalf("Deploy: %v", err)
	}
}

// TestDeployCarriesTheAssetHeadersVerbatim: a `_headers` document is a file
// format, so the bytes have to arrive as written — newlines, two-space
// indentation and all. It is also the only route there is: dropping the same
// file into the assets directory publishes it at /_headers and configures
// nothing.
func TestDeployCarriesTheAssetHeadersVerbatim(t *testing.T) {
	in := deployFixture()
	in.AssetHeaders = "/*\n  Content-Security-Policy: default-src 'self'\n  Referrer-Policy: no-referrer\n"

	f := deployServer(t, nil, func(w http.ResponseWriter, parts []part) {
		meta := partNamed(t, parts, "metadata")
		var m struct {
			Assets struct {
				Config struct {
					Headers string `json:"_headers"`
				} `json:"config"`
			} `json:"assets"`
		}
		if err := json.Unmarshal(meta.Body, &m); err != nil {
			t.Fatalf("decoding metadata: %v", err)
		}
		if got := m.Assets.Config.Headers; got != in.AssetHeaders {
			t.Errorf("assets.config._headers = %q, want %q", got, in.AssetHeaders)
		}
		writeEnvelope(t, w, http.StatusOK, map[string]any{"id": "flue-relay"})
	})

	if err := f.client().Deploy(context.Background(), in); err != nil {
		t.Fatalf("Deploy: %v", err)
	}
}

// TestDeployOmitsAssetHeadersWhenUnset: the field is undocumented in
// Cloudflare's multipart-metadata reference, so a deploy with nothing to say
// says nothing rather than sending an empty document at a server whose
// validation we cannot read.
func TestDeployOmitsAssetHeadersWhenUnset(t *testing.T) {
	in := deployFixture()
	in.AssetHeaders = ""

	f := deployServer(t, nil, func(w http.ResponseWriter, parts []part) {
		meta := partNamed(t, parts, "metadata")
		var m struct {
			Assets struct {
				Config map[string]any `json:"config"`
			} `json:"assets"`
		}
		if err := json.Unmarshal(meta.Body, &m); err != nil {
			t.Fatalf("decoding metadata: %v", err)
		}
		if _, ok := m.Assets.Config["_headers"]; ok {
			t.Errorf("metadata carries _headers with none set: %s", meta.Body)
		}
		writeEnvelope(t, w, http.StatusOK, map[string]any{"id": "flue-relay"})
	})

	if err := f.client().Deploy(context.Background(), in); err != nil {
		t.Fatalf("Deploy: %v", err)
	}
}

// TestDeployRejectsARelativeAssetPath: manifest keys are the URL paths the
// files are served at and Cloudflare requires them absolute. Failing here names
// the offending file; failing at the session names only the API's own rule.
func TestDeployRejectsARelativeAssetPath(t *testing.T) {
	in := deployFixture()
	in.Assets = []Asset{assetHTML, {Path: "assets/app.js", Body: []byte("x")}}

	f := newFixture(t, func(w http.ResponseWriter, r *http.Request, body []byte) {
		t.Errorf("sent %s %s despite a malformed asset path", r.Method, r.URL.Path)
		writeEnvelope(t, w, http.StatusOK, map[string]any{"jwt": "session-jwt", "buckets": [][]string{}})
	})

	err := f.client().Deploy(context.Background(), in)
	if err == nil {
		t.Fatal("Deploy with a relative asset path = nil, want an error")
	}
	if !strings.Contains(err.Error(), "assets/app.js") {
		t.Errorf("error %q does not name the offending asset", err)
	}
}

// TestDeployMetadataIsDeterministic: DOBindings is a map, and a map ranged in
// Go's randomised order would produce a different bindings array on every
// deploy. The golden comparison above would only catch that intermittently.
func TestDeployMetadataIsDeterministic(t *testing.T) {
	in := deployFixture()
	in.DOBindings = map[string]string{"HUB": "DaemonHub", "ROOM": "Room", "AUX": "Aux"}

	var first []byte
	for i := 0; i < 20; i++ {
		f := deployServer(t, nil, func(w http.ResponseWriter, parts []part) {
			writeEnvelope(t, w, http.StatusOK, map[string]any{"id": "flue-relay"})
		})
		if err := f.client().Deploy(context.Background(), in); err != nil {
			t.Fatalf("Deploy: %v", err)
		}
		put := scriptPut(t, f)
		meta := partNamed(t, parseParts(t, put.ContentType, put.Body), "metadata")
		if first == nil {
			first = meta.Body
			continue
		}
		if string(meta.Body) != string(first) {
			t.Fatalf("metadata differs between deploys of the same input:\n%s\nvs\n%s", first, meta.Body)
		}
	}
}

// TestDeploySkipsUploadWhenBucketsAreEmpty: when Cloudflare already holds every
// asset it returns no buckets and the session JWT is itself the completion
// token. Uploading anything then would be wasted work.
func TestDeploySkipsUploadWhenBucketsAreEmpty(t *testing.T) {
	f := deployServer(t, nil, func(w http.ResponseWriter, parts []part) {
		meta := partNamed(t, parts, "metadata")
		var m struct {
			Assets struct {
				JWT string `json:"jwt"`
			} `json:"assets"`
		}
		if err := json.Unmarshal(meta.Body, &m); err != nil {
			t.Errorf("decoding metadata: %v", err)
		}
		if m.Assets.JWT != "session-jwt" {
			t.Errorf("assets.jwt = %q, want the session jwt %q", m.Assets.JWT, "session-jwt")
		}
		writeEnvelope(t, w, http.StatusOK, map[string]any{"id": "flue-relay"})
	})

	if err := f.client().Deploy(context.Background(), deployFixture()); err != nil {
		t.Fatalf("Deploy: %v", err)
	}
	for _, r := range f.requests() {
		if strings.HasSuffix(r.Path, "/workers/assets/upload") {
			t.Errorf("uploaded a bucket even though the session returned none: %s", f.paths())
		}
	}
}

// TestDeployWithoutAssetsSkipsTheSessionEntirely.
func TestDeployWithoutAssetsSkipsTheSessionEntirely(t *testing.T) {
	in := deployFixture()
	in.Assets = nil

	f := newFixture(t, func(w http.ResponseWriter, r *http.Request, body []byte) {
		if r.Method != http.MethodPut {
			t.Errorf("unexpected request %s %s for an asset-less deploy", r.Method, r.URL.Path)
		}
		meta := partNamed(t, parseParts(t, r.Header.Get("Content-Type"), body), "metadata")
		var m map[string]any
		if err := json.Unmarshal(meta.Body, &m); err != nil {
			t.Fatalf("decoding metadata: %v", err)
		}
		if _, ok := m["assets"]; ok {
			t.Errorf("metadata carries an assets key with no assets to deploy: %s", meta.Body)
		}
		writeEnvelope(t, w, http.StatusOK, map[string]any{"id": "flue-relay"})
	})

	if err := f.client().Deploy(context.Background(), in); err != nil {
		t.Fatalf("Deploy: %v", err)
	}
}

// TestDeployOmitsMigrationsWhenTheScriptIsUpToDate: a relay already carrying
// the last tag in the history has nothing to migrate, and sending a migration
// then is the refusal this client used to spend a whole extra script upload
// recovering from.
func TestDeployOmitsMigrationsWhenTheScriptIsUpToDate(t *testing.T) {
	f := deployServer(t, nil, func(w http.ResponseWriter, parts []part) {
		meta := partNamed(t, parts, "metadata")
		var m map[string]any
		if err := json.Unmarshal(meta.Body, &m); err != nil {
			t.Fatalf("decoding metadata: %v", err)
		}
		if _, ok := m["migrations"]; ok {
			t.Errorf("metadata carries migrations for a script already at the last tag: %s", meta.Body)
		}
		// The durable object bindings must survive: the classes still exist, it
		// is only the migration that has already been applied.
		if _, ok := m["bindings"]; !ok {
			t.Errorf("metadata dropped the durable object bindings: %s", meta.Body)
		}
		writeEnvelope(t, w, http.StatusOK, map[string]any{"id": "flue-relay"})
	})
	f.deployedTag = "v2"

	if err := f.client().Deploy(context.Background(), deployFixture()); err != nil {
		t.Fatalf("Deploy: %v", err)
	}
}

// TestDeployMigratesAnExistingRelayForward is the upgrade this whole mechanism
// exists for: a relay deployed before the fleet directory sits at v1, and the
// deploy that adds FleetDirectory has to apply v2 *and only* v2, against the
// precondition that the script is still at v1.
//
// The failure it guards is not subtle but it is invisible from here: a client
// that re-sent v1's step would be refused on the tag precondition, and the
// retry that drops migrations would then upload a script whose DIRECTORY
// binding names a class no migration ever created — which Cloudflare also
// refuses, leaving every existing relay unable to take the update.
func TestDeployMigratesAnExistingRelayForward(t *testing.T) {
	var got struct {
		Migrations *struct {
			OldTag string `json:"old_tag"`
			NewTag string `json:"new_tag"`
			Steps  []struct {
				NewSQLiteClasses []string `json:"new_sqlite_classes"`
			} `json:"steps"`
		} `json:"migrations"`
	}
	f := deployServer(t, nil, func(w http.ResponseWriter, parts []part) {
		if err := json.Unmarshal(partNamed(t, parts, "metadata").Body, &got); err != nil {
			t.Fatalf("decoding metadata: %v", err)
		}
		writeEnvelope(t, w, http.StatusOK, map[string]any{"id": "flue-relay"})
	})
	f.deployedTag = "v1"

	if err := f.client().Deploy(context.Background(), deployFixture()); err != nil {
		t.Fatalf("Deploy: %v", err)
	}
	if got.Migrations == nil {
		t.Fatal("a v1 script was sent no migration; FleetDirectory would never exist")
	}
	if got.Migrations.OldTag != "v1" || got.Migrations.NewTag != "v2" {
		t.Errorf("migration tags = %q -> %q, want v1 -> v2", got.Migrations.OldTag, got.Migrations.NewTag)
	}
	if len(got.Migrations.Steps) != 1 ||
		!reflect.DeepEqual(got.Migrations.Steps[0].NewSQLiteClasses, []string{"FleetDirectory"}) {
		t.Errorf("steps = %+v, want exactly the v2 step introducing FleetDirectory", got.Migrations.Steps)
	}
}

// TestDeployReadsTheDeployedTagFromTheAccount pins where the tag comes from.
// It is the account's script list — the same fact wrangler reads, from the same
// endpoint — because a migration precondition can only be computed from what
// the account actually carries.
func TestDeployReadsTheDeployedTagFromTheAccount(t *testing.T) {
	f := deployServer(t, nil, func(w http.ResponseWriter, _ []part) {
		writeEnvelope(t, w, http.StatusOK, map[string]any{"id": "flue-relay"})
	})
	f.deployedTag = "v1"
	if err := f.client().Deploy(context.Background(), deployFixture()); err != nil {
		t.Fatalf("Deploy: %v", err)
	}
	var asked int
	for _, r := range f.requests() {
		if r.Method == http.MethodGet && r.Path == scriptListPath {
			asked++
		}
	}
	if asked != 1 {
		t.Errorf("script-list reads = %d, want exactly 1: %s", asked, f.paths())
	}
}

// TestDeployFallsBackToTheWholeHistoryWhenTheTagIsUnreadable: the pre-flight
// read is a convenience, not a gate. A token that cannot list scripts, or an
// endpoint having a bad minute, must leave the deploy exactly as capable as it
// was before this client could ask — the whole history, and the already-applied
// retry behind it — rather than refusing to deploy over a read-only call.
func TestDeployFallsBackToTheWholeHistoryWhenTheTagIsUnreadable(t *testing.T) {
	var sentSteps int
	f := newFixture(t, func(w http.ResponseWriter, r *http.Request, body []byte) {
		switch {
		case r.Method == http.MethodGet && r.URL.Path == scriptListPath:
			writeAPIError(w, http.StatusForbidden, 10000, "Authentication error")
		case strings.HasSuffix(r.URL.Path, "/assets-upload-session"):
			writeEnvelope(t, w, http.StatusOK, map[string]any{"jwt": "session-jwt", "buckets": [][]string{}})
		default:
			var m struct {
				Migrations *struct {
					OldTag string `json:"old_tag"`
					Steps  []any  `json:"steps"`
				} `json:"migrations"`
			}
			if err := json.Unmarshal(partNamed(t, parseParts(t, r.Header.Get("Content-Type"), body), "metadata").Body, &m); err != nil {
				t.Fatalf("decoding metadata: %v", err)
			}
			if m.Migrations == nil {
				t.Fatal("no migration sent when the tag could not be read")
			}
			if m.Migrations.OldTag != "" {
				t.Errorf("old_tag = %q, want none: an unreadable tag cannot claim a precondition", m.Migrations.OldTag)
			}
			sentSteps = len(m.Migrations.Steps)
			writeEnvelope(t, w, http.StatusOK, map[string]any{"id": "flue-relay"})
		}
	})
	f.noScriptList = true

	if err := f.client().Deploy(context.Background(), deployFixture()); err != nil {
		t.Fatalf("Deploy: %v", err)
	}
	if sentSteps != 2 {
		t.Errorf("steps sent = %d, want the whole history (2)", sentSteps)
	}
}

// sentMigrations decodes the migration object out of one script upload's
// metadata part, or nil when the upload carried none.
type sentMigrations struct {
	OldTag string `json:"old_tag"`
	NewTag string `json:"new_tag"`
	Steps  []struct {
		NewSQLiteClasses []string `json:"new_sqlite_classes"`
	} `json:"steps"`
}

func migrationsIn(t *testing.T, r recorded) *sentMigrations {
	t.Helper()
	var m struct {
		Migrations *sentMigrations `json:"migrations"`
	}
	body := partNamed(t, parseParts(t, r.ContentType, r.Body), "metadata").Body
	if err := json.Unmarshal(body, &m); err != nil {
		t.Fatalf("decoding metadata: %v", err)
	}
	return m.Migrations
}

func scriptPuts(f *fixture) []recorded {
	var out []recorded
	for _, r := range f.requests() {
		if r.Method == http.MethodPut && r.Path == "/accounts/acct-123/workers/scripts/flue-relay" {
			out = append(out, r)
		}
	}
	return out
}

// TestDeployRecoversTheUpgradeWhenTheTagReadFailed is the v1 → v2 upgrade
// surviving a five-second network blip, which is the deploy this whole release
// requires an existing relay to take.
//
// The chain it guards: the pre-flight script-list read times out, so the deploy
// has no tag and sends the whole history with no old_tag; Cloudflare refuses
// that on the precondition (10079) and *names the tag the script really
// carries*. The recovery has to read that name and retry with `old_tag: v1` and
// v2's step alone. Answering the refusal by dropping migrations instead — which
// is what a blanket already-applied recovery does — uploads a script whose
// DIRECTORY binding names a class no migration ever created, is refused again,
// and leaves `flue relay update` dead on every relay whose pre-flight read had
// a bad second.
func TestDeployRecoversTheUpgradeWhenTheTagReadFailed(t *testing.T) {
	f := newFixture(t, func(w http.ResponseWriter, r *http.Request, body []byte) {
		switch {
		case r.Method == http.MethodGet && r.URL.Path == scriptListPath:
			// The transient failure: a read-only pre-flight call having a bad
			// minute. The deploy has no tag to work from.
			writeAPIError(w, http.StatusGatewayTimeout, 10000, "internal error")
		case strings.HasSuffix(r.URL.Path, "/assets-upload-session"):
			writeEnvelope(t, w, http.StatusOK, map[string]any{"jwt": "session-jwt", "buckets": [][]string{}})
		default:
			var m struct {
				Migrations *sentMigrations `json:"migrations"`
			}
			if err := json.Unmarshal(partNamed(t, parseParts(t, r.Header.Get("Content-Type"), body), "metadata").Body, &m); err != nil {
				t.Fatalf("decoding metadata: %v", err)
			}
			switch {
			case m.Migrations != nil && m.Migrations.OldTag == "v1":
				// The correct upload for a script at v1.
				writeEnvelope(t, w, http.StatusOK, map[string]any{"id": "flue-relay"})
			case m.Migrations == nil:
				// What a blanket already-applied recovery sends, and what
				// Cloudflare does with it: the script binds DIRECTORY to a
				// class no migration created.
				writeAPIError(w, http.StatusBadRequest, 10061,
					"Uncaught TypeError: Cannot read properties of undefined; binding DIRECTORY refers to class FleetDirectory which is not exported by the script")
			default:
				// The first attempt: the whole history with no old_tag, which
				// this script — already at v1 — refuses on the precondition.
				// The message is Cloudflare's own, and naming the expected tag
				// is the fact the client is missing.
				writeAPIError(w, http.StatusBadRequest, 10079,
					"Actor migration tag precondition failed, got tag '' when expected tag is 'v1'")
			}
		}
	})
	f.noScriptList = true

	if err := f.client().Deploy(context.Background(), deployFixture()); err != nil {
		t.Fatalf("Deploy after an unreadable tag and a precondition refusal: %v", err)
	}

	puts := scriptPuts(f)
	if len(puts) != 2 {
		t.Fatalf("script PUTs = %d, want 2 (the guess and the correction): %s", len(puts), f.paths())
	}
	first := migrationsIn(t, puts[0])
	if first == nil || first.OldTag != "" || len(first.Steps) != 2 {
		t.Errorf("first upload = %+v, want the whole history with no old_tag", first)
	}
	got := migrationsIn(t, puts[1])
	if got == nil {
		t.Fatal("the retry dropped migrations; FleetDirectory would never be created")
	}
	if got.OldTag != "v1" || got.NewTag != "v2" {
		t.Errorf("retry tags = %q -> %q, want v1 -> v2 read out of Cloudflare's own message", got.OldTag, got.NewTag)
	}
	if len(got.Steps) != 1 || !reflect.DeepEqual(got.Steps[0].NewSQLiteClasses, []string{"FleetDirectory"}) {
		t.Errorf("retry steps = %+v, want exactly the v2 step", got.Steps)
	}
}

// TestDeployFailsClosedOnAnUnreadablePrecondition: a tag precondition whose
// message does not name the expected tag leaves nothing to compute a correct
// migration from. wrangler fails closed there and so does this — the one
// alternative, retrying with no migrations, is exactly the move that turns one
// clear refusal into a second, more confusing one.
func TestDeployFailsClosedOnAnUnreadablePrecondition(t *testing.T) {
	f := newFixture(t, func(w http.ResponseWriter, r *http.Request, _ []byte) {
		switch {
		case r.Method == http.MethodGet && r.URL.Path == scriptListPath:
			writeAPIError(w, http.StatusForbidden, 10000, "Authentication error")
		case strings.HasSuffix(r.URL.Path, "/assets-upload-session"):
			writeEnvelope(t, w, http.StatusOK, map[string]any{"jwt": "session-jwt", "buckets": [][]string{}})
		default:
			writeAPIError(w, http.StatusBadRequest, 10079, "Actor migration tag precondition failed")
		}
	})
	f.noScriptList = true

	err := f.client().Deploy(context.Background(), deployFixture())
	if err == nil {
		t.Fatal("Deploy succeeded on a precondition it could not repair")
	}
	// The refusal reaches the user intact rather than as whatever a blind
	// second attempt would have produced.
	if !strings.Contains(err.Error(), "precondition") {
		t.Errorf("the error lost the precondition refusal: %v", err)
	}
	if puts := scriptPuts(f); len(puts) != 1 {
		t.Errorf("script PUTs = %d, want 1: a refusal with nothing to learn from is not retried", len(puts))
	}
}

// TestDeployDoesNotRetryATagItAlreadyClaimed: Cloudflare naming the very tag
// this upload sent means the refusal was about something else, and a byte-
// identical second attempt would bury the real error behind a copy of itself.
func TestDeployDoesNotRetryATagItAlreadyClaimed(t *testing.T) {
	f := newFixture(t, func(w http.ResponseWriter, r *http.Request, _ []byte) {
		switch {
		case strings.HasSuffix(r.URL.Path, "/assets-upload-session"):
			writeEnvelope(t, w, http.StatusOK, map[string]any{"jwt": "session-jwt", "buckets": [][]string{}})
		default:
			writeAPIError(w, http.StatusBadRequest, 10079,
				"Actor migration tag precondition failed, got tag 'v1' when expected tag is 'v1'")
		}
	})
	f.deployedTag = "v1"

	if err := f.client().Deploy(context.Background(), deployFixture()); err == nil {
		t.Fatal("Deploy succeeded against a relay that refused every upload")
	}
	if puts := scriptPuts(f); len(puts) != 1 {
		t.Errorf("script PUTs = %d, want 1: the retry would have been identical", len(puts))
	}
}

// TestDeployLeavesANewerScriptAlone: a script carrying a tag this binary has
// never heard of was deployed by a newer flue, and replaying this binary's
// older history over it would undo a migration it does not know about.
func TestDeployLeavesANewerScriptAlone(t *testing.T) {
	f := deployServer(t, nil, func(w http.ResponseWriter, parts []part) {
		var m map[string]any
		if err := json.Unmarshal(partNamed(t, parts, "metadata").Body, &m); err != nil {
			t.Fatalf("decoding metadata: %v", err)
		}
		if _, ok := m["migrations"]; ok {
			t.Errorf("metadata carries a migration for a script from a newer flue: %v", m["migrations"])
		}
		writeEnvelope(t, w, http.StatusOK, map[string]any{"id": "flue-relay"})
	})
	f.deployedTag = "v7"

	if err := f.client().Deploy(context.Background(), deployFixture()); err != nil {
		t.Fatalf("Deploy: %v", err)
	}
}

// TestDeploySaysWhenTheRelayIsFromANewerFlue: leaving a newer script's
// migrations alone is right, and it used to be indistinguishable from nothing
// happening. If that newer Worker carried a Durable Object class this module
// does not, the upload is refused with a 10061 naming the class — and nothing
// anywhere connected that to "you are running an older flue than the one that
// deployed this relay".
func TestDeploySaysWhenTheRelayIsFromANewerFlue(t *testing.T) {
	var notes []string
	in := deployFixture()
	in.OnNote = func(line string) { notes = append(notes, line) }

	f := deployServer(t, nil, func(w http.ResponseWriter, _ []part) {
		writeEnvelope(t, w, http.StatusOK, map[string]any{"id": "flue-relay"})
	})
	f.deployedTag = "v7"

	if err := f.client().Deploy(context.Background(), in); err != nil {
		t.Fatalf("Deploy: %v", err)
	}
	if len(notes) != 1 {
		t.Fatalf("notes = %v, want exactly one about the unknown tag", notes)
	}
	// The tag is in the line: it is the one fact the user can act on, and
	// "newer flue" without it is a claim they cannot check.
	if !strings.Contains(notes[0], "v7") {
		t.Errorf("the note does not name the tag: %q", notes[0])
	}
	if !strings.Contains(notes[0], "newer flue") {
		t.Errorf("the note does not say what an unknown tag means: %q", notes[0])
	}
}

// TestDeploySaysNothingWhenThereIsNothingToSay: a note is not progress, and a
// deploy that goes to plan must not produce one — an ordinary run, and an
// upgrade from a tag this binary does know.
func TestDeploySaysNothingWhenThereIsNothingToSay(t *testing.T) {
	for _, tag := range []string{"", "v1", "v2"} {
		t.Run("tag="+tag, func(t *testing.T) {
			var notes []string
			in := deployFixture()
			in.OnNote = func(line string) { notes = append(notes, line) }

			f := deployServer(t, nil, func(w http.ResponseWriter, _ []part) {
				writeEnvelope(t, w, http.StatusOK, map[string]any{"id": "flue-relay"})
			})
			f.deployedTag = tag

			if err := f.client().Deploy(context.Background(), in); err != nil {
				t.Fatalf("Deploy: %v", err)
			}
			if len(notes) != 0 {
				t.Errorf("notes on an ordinary deploy: %v", notes)
			}
		})
	}
}

// TestDeployOmitsMigrationsWithNoHistory: a caller with nothing to migrate
// sends no migration object at all, and asks the account nothing.
func TestDeployOmitsMigrationsWithNoHistory(t *testing.T) {
	in := deployFixture()
	in.Migrations = nil

	f := deployServer(t, nil, func(w http.ResponseWriter, parts []part) {
		var m map[string]any
		if err := json.Unmarshal(partNamed(t, parts, "metadata").Body, &m); err != nil {
			t.Fatalf("decoding metadata: %v", err)
		}
		if _, ok := m["migrations"]; ok {
			t.Errorf("metadata carries migrations with no history: %v", m["migrations"])
		}
		writeEnvelope(t, w, http.StatusOK, map[string]any{"id": "flue-relay"})
	})

	if err := f.client().Deploy(context.Background(), in); err != nil {
		t.Fatalf("Deploy: %v", err)
	}
	for _, r := range f.requests() {
		if r.Path == scriptListPath {
			t.Errorf("read the deployed migration tag with nothing to migrate: %s", f.paths())
		}
	}
}

// TestDeployRetriesWithoutMigrationsWhenAlreadyApplied: re-running setup against
// an account that already has the Worker must succeed rather than fail on a
// migration Cloudflare has already applied.
func TestDeployRetriesWithoutMigrationsWhenAlreadyApplied(t *testing.T) {
	var metadatas [][]byte
	puts := 0
	f := newFixture(t, func(w http.ResponseWriter, r *http.Request, body []byte) {
		if strings.HasSuffix(r.URL.Path, "/assets-upload-session") {
			writeEnvelope(t, w, http.StatusOK, map[string]any{"jwt": "session-jwt", "buckets": [][]string{}})
			return
		}
		puts++
		metadatas = append(metadatas, partNamed(t, parseParts(t, r.Header.Get("Content-Type"), body), "metadata").Body)
		if puts == 1 {
			writeAPIError(w, http.StatusBadRequest, 10061,
				"Cannot apply new-sqlite-class migration to class DaemonHub that is already depended on by existing Durable Objects")
			return
		}
		writeEnvelope(t, w, http.StatusOK, map[string]any{"id": "flue-relay"})
	})

	if err := f.client().Deploy(context.Background(), deployFixture()); err != nil {
		t.Fatalf("Deploy: %v", err)
	}
	if puts != 2 {
		t.Fatalf("script PUTs = %d, want 2 (one with migrations, one without)", puts)
	}

	var withMigrations, without map[string]any
	if err := json.Unmarshal(metadatas[0], &withMigrations); err != nil {
		t.Fatalf("decoding first metadata: %v", err)
	}
	if err := json.Unmarshal(metadatas[1], &without); err != nil {
		t.Fatalf("decoding retry metadata: %v", err)
	}
	if _, ok := withMigrations["migrations"]; !ok {
		t.Errorf("first attempt did not send migrations: %s", metadatas[0])
	}
	if _, ok := without["migrations"]; ok {
		t.Errorf("retry still sends migrations: %s", metadatas[1])
	}
	// Everything else about the retry must be identical.
	delete(withMigrations, "migrations")
	if !reflect.DeepEqual(withMigrations, without) {
		t.Errorf("the retry changed more than migrations:\n%s\nvs\n%s", metadatas[0], metadatas[1])
	}
}

// TestDeployRefreshesTheAssetTokenBeforeRetrying: the completion token was
// spent on the PUT that just failed, and Cloudflare does not document whether
// it survives a rejected upload. Since the retry is the *normal* path for a
// re-run of `flue relay setup`, it opens a fresh upload session rather than
// betting the whole re-run flow on a token that may be single-use.
func TestDeployRefreshesTheAssetTokenBeforeRetrying(t *testing.T) {
	var jwts []string
	sessions, puts := 0, 0
	f := newFixture(t, func(w http.ResponseWriter, r *http.Request, body []byte) {
		if strings.HasSuffix(r.URL.Path, "/assets-upload-session") {
			sessions++
			// Cloudflare already holds every file by the second session, so it
			// answers with no buckets and a token of its own.
			writeEnvelope(t, w, http.StatusOK, map[string]any{
				"jwt":     fmt.Sprintf("session-jwt-%d", sessions),
				"buckets": [][]string{},
			})
			return
		}
		puts++
		var m struct {
			Assets struct {
				JWT string `json:"jwt"`
			} `json:"assets"`
		}
		meta := partNamed(t, parseParts(t, r.Header.Get("Content-Type"), body), "metadata")
		if err := json.Unmarshal(meta.Body, &m); err != nil {
			t.Fatalf("decoding metadata: %v", err)
		}
		jwts = append(jwts, m.Assets.JWT)
		if puts == 1 {
			writeAPIError(w, http.StatusBadRequest, 10061,
				"Cannot apply new-sqlite-class migration to class DaemonHub that is already depended on by existing Durable Objects")
			return
		}
		writeEnvelope(t, w, http.StatusOK, map[string]any{"id": "flue-relay"})
	})

	if err := f.client().Deploy(context.Background(), deployFixture()); err != nil {
		t.Fatalf("Deploy: %v", err)
	}
	if sessions != 2 {
		t.Errorf("asset upload sessions = %d, want 2 (one per script PUT)", sessions)
	}
	want := []string{"session-jwt-1", "session-jwt-2"}
	if !reflect.DeepEqual(jwts, want) {
		t.Errorf("assets.jwt per PUT = %v, want %v", jwts, want)
	}
}

// TestDeployReportsAFailedAssetRefreshOnRetry: if the fresh session cannot be
// opened there is no token to attach, and PUTting anyway would deploy a Worker
// with no UI. The error has to say the retry was where it happened.
func TestDeployReportsAFailedAssetRefreshOnRetry(t *testing.T) {
	sessions, puts := 0, 0
	f := newFixture(t, func(w http.ResponseWriter, r *http.Request, body []byte) {
		if strings.HasSuffix(r.URL.Path, "/assets-upload-session") {
			sessions++
			if sessions == 1 {
				writeEnvelope(t, w, http.StatusOK, map[string]any{"jwt": "session-jwt", "buckets": [][]string{}})
			} else {
				writeAPIError(w, http.StatusInternalServerError, 10000, "Internal error")
			}
			return
		}
		puts++
		writeAPIError(w, http.StatusBadRequest, 10061,
			"Cannot apply new-sqlite-class migration to class DaemonHub that is already depended on by existing Durable Objects")
	})

	err := f.client().Deploy(context.Background(), deployFixture())
	if err == nil {
		t.Fatal("Deploy = nil, want the failed asset refresh surfaced")
	}
	if !strings.Contains(err.Error(), "10000") {
		t.Errorf("error %q drops the Cloudflare code from the failed session", err)
	}
	// The refresh failure is what stopped the retry, but the migration conflict
	// is why a retry happened at all and is the thing the user can act on.
	// Reporting only the session error sends them after the wrong problem.
	if !strings.Contains(err.Error(), "10061") {
		t.Errorf("error %q drops the Cloudflare code from the deploy that triggered the retry", err)
	}
	if puts != 1 {
		t.Errorf("script PUTs = %d, want 1: the retry must not go out without a token", puts)
	}
}

// TestDeployDoesNotRetryOtherErrors: the retry is only licensed for the
// already-applied migration. Anything else must surface on the first attempt.
func TestDeployDoesNotRetryOtherErrors(t *testing.T) {
	puts := 0
	f := newFixture(t, func(w http.ResponseWriter, r *http.Request, body []byte) {
		if strings.HasSuffix(r.URL.Path, "/assets-upload-session") {
			writeEnvelope(t, w, http.StatusOK, map[string]any{"jwt": "session-jwt", "buckets": [][]string{}})
			return
		}
		puts++
		writeAPIError(w, http.StatusBadRequest, 10021, "Uncaught SyntaxError: Unexpected token")
	})

	err := f.client().Deploy(context.Background(), deployFixture())
	if err == nil {
		t.Fatal("Deploy against a script error = nil, want an error")
	}
	if !strings.Contains(err.Error(), "10021") {
		t.Errorf("error %q drops the Cloudflare code", err)
	}
	if puts != 1 {
		t.Errorf("script PUTs = %d, want 1 (no retry for a non-migration error)", puts)
	}
}

// TestDeployDoesNotRetryOtherMigrationErrors: dropping the migration is only
// the right move when Cloudflare has already applied it. For any other
// migration failure — a tag that does not line up, a class that is not there —
// a retry without migrations could *succeed*, deploying a Worker whose Durable
// Object was never actually migrated and burying the real error.
func TestDeployDoesNotRetryOtherMigrationErrors(t *testing.T) {
	for _, message := range []string{
		"Worker script migration tag does not match latest tag",
		"Migration contains a class that does not exist in the script",
	} {
		t.Run(message, func(t *testing.T) {
			puts := 0
			f := newFixture(t, func(w http.ResponseWriter, r *http.Request, body []byte) {
				if strings.HasSuffix(r.URL.Path, "/assets-upload-session") {
					writeEnvelope(t, w, http.StatusOK, map[string]any{"jwt": "session-jwt", "buckets": [][]string{}})
					return
				}
				puts++
				writeAPIError(w, http.StatusBadRequest, 10061, message)
			})

			err := f.client().Deploy(context.Background(), deployFixture())
			if err == nil {
				t.Fatal("Deploy = nil, want the migration error surfaced")
			}
			if !strings.Contains(err.Error(), message) {
				t.Errorf("error %q does not carry Cloudflare's message", err)
			}
			if puts != 1 {
				t.Errorf("script PUTs = %d, want 1: this is not an already-applied migration", puts)
			}
		})
	}
}

// TestDeployRejectsAnEmptySessionToken: an upload session with no JWT leaves
// nothing to authenticate the upload with. The danger is specific — an empty
// bearer falls back to the account API token — so the deploy must stop rather
// than send the user's API token to the asset endpoint.
func TestDeployRejectsAnEmptySessionToken(t *testing.T) {
	f := newFixture(t, func(w http.ResponseWriter, r *http.Request, body []byte) {
		if strings.HasSuffix(r.URL.Path, "/assets-upload-session") {
			writeEnvelope(t, w, http.StatusOK, map[string]any{
				"jwt": "", "buckets": [][]string{{hashHTML, hashJS, hashCSS}},
			})
			return
		}
		writeEnvelope(t, w, http.StatusOK, map[string]any{"jwt": "completion-token"})
	})

	err := f.client().Deploy(context.Background(), deployFixture())
	if err == nil {
		t.Fatal("Deploy with an empty session token = nil, want an error")
	}
	for _, r := range f.requests() {
		if strings.HasSuffix(r.Path, "/workers/assets/upload") {
			t.Errorf("uploaded with Authorization %q despite having no session token", r.Auth)
		}
	}
}

// TestDeployRejectsAnEmptyCompletionTokenFromAnEmptyBucketSession: the same
// hazard on the other branch — no buckets and no JWT would otherwise attach
// `"jwt": ""` to the script and deploy a Worker with no assets.
func TestDeployRejectsAnEmptyCompletionTokenFromAnEmptyBucketSession(t *testing.T) {
	f := newFixture(t, func(w http.ResponseWriter, r *http.Request, body []byte) {
		if strings.HasSuffix(r.URL.Path, "/assets-upload-session") {
			writeEnvelope(t, w, http.StatusOK, map[string]any{"jwt": "", "buckets": [][]string{}})
			return
		}
		t.Errorf("script was PUT with no asset token: %s %s", r.Method, r.URL.Path)
		writeEnvelope(t, w, http.StatusOK, map[string]any{"id": "flue-relay"})
	})

	if err := f.client().Deploy(context.Background(), deployFixture()); err == nil {
		t.Fatal("Deploy with an empty session token and no buckets = nil, want an error")
	}
}

// TestDeployReportsAMissingCompletionToken: uploading every bucket without ever
// being handed a completion token means the assets cannot be attached, and
// PUTting the script anyway would deploy a Worker with no UI.
func TestDeployReportsAMissingCompletionToken(t *testing.T) {
	f := newFixture(t, func(w http.ResponseWriter, r *http.Request, body []byte) {
		switch {
		case strings.HasSuffix(r.URL.Path, "/assets-upload-session"):
			writeEnvelope(t, w, http.StatusOK, map[string]any{
				"jwt": "session-jwt", "buckets": [][]string{{hashHTML, hashJS, hashCSS}},
			})
		case strings.HasSuffix(r.URL.Path, "/workers/assets/upload"):
			writeEnvelope(t, w, http.StatusOK, map[string]any{})
		default:
			t.Errorf("script was PUT despite no completion token: %s %s", r.Method, r.URL.Path)
			writeEnvelope(t, w, http.StatusOK, map[string]any{"id": "flue-relay"})
		}
	})

	err := f.client().Deploy(context.Background(), deployFixture())
	if err == nil {
		t.Fatal("Deploy without a completion token = nil, want an error")
	}
	if !strings.Contains(err.Error(), "completion") {
		t.Errorf("error %q does not explain the missing completion token", err)
	}
}

// TestDeployReportsAnUnknownBucketHash: a bucket naming a hash that is not in
// the manifest cannot be satisfied, and silently skipping it would produce a
// deploy that is missing a file.
func TestDeployReportsAnUnknownBucketHash(t *testing.T) {
	f := deployServer(t, [][]string{{"0000000000000000000000000000dead"}}, func(w http.ResponseWriter, parts []part) {
		t.Error("script was PUT despite an unsatisfiable bucket")
		writeEnvelope(t, w, http.StatusOK, map[string]any{"id": "flue-relay"})
	})

	err := f.client().Deploy(context.Background(), deployFixture())
	if err == nil {
		t.Fatal("Deploy with an unknown bucket hash = nil, want an error")
	}
	if !strings.Contains(err.Error(), "0000000000000000000000000000dead") {
		t.Errorf("error %q does not name the unknown hash", err)
	}
}

// TestDeployHonoursContextCancellation.
func TestDeployHonoursContextCancellation(t *testing.T) {
	f := deployServer(t, nil, func(w http.ResponseWriter, parts []part) {
		writeEnvelope(t, w, http.StatusOK, map[string]any{"id": "flue-relay"})
	})
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	if err := f.client().Deploy(ctx, deployFixture()); err == nil {
		t.Fatal("Deploy with a cancelled context = nil, want an error")
	}
}

// ------------------------------------------------------------------ SetSecret

func TestSetSecretPutsASecretTextBinding(t *testing.T) {
	f := newFixture(t, func(w http.ResponseWriter, r *http.Request, _ []byte) {
		writeEnvelope(t, w, http.StatusOK, map[string]any{"name": "DAEMON_SECRET", "type": "secret_text"})
	})

	err := f.client().SetSecret(context.Background(), "acct-123", "flue-relay", "DAEMON_SECRET", "hunter2")
	if err != nil {
		t.Fatalf("SetSecret: %v", err)
	}

	req := f.only("/accounts/acct-123/workers/scripts/flue-relay/secrets")
	if req.Method != http.MethodPut {
		t.Errorf("method = %s, want PUT", req.Method)
	}
	if want := "Bearer " + testToken; req.Auth != want {
		t.Errorf("Authorization = %q, want %q", req.Auth, want)
	}
	var got map[string]any
	if err := json.Unmarshal(req.Body, &got); err != nil {
		t.Fatalf("decoding body: %v (%s)", err, req.Body)
	}
	want := map[string]any{"name": "DAEMON_SECRET", "text": "hunter2", "type": "secret_text"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("body = %+v, want %+v", got, want)
	}
}

// TestSetSecretNeverEchoesTheSecret: this is the one request in the package
// whose body is a credential, and Cloudflare's validation errors quote what
// they rejected. The error goes to the user's terminal verbatim, so a message
// carrying the secret — whole, or the fragment a truncating server would quote
// — must not survive the call.
func TestSetSecretNeverEchoesTheSecret(t *testing.T) {
	const secret = "Zm91cnRlZW4tY2hhcnMtb2YtZGFlbW9uLXNlY3JldA"

	for name, message := range map[string]string{
		"the whole secret":  fmt.Sprintf("invalid value %q for text", secret),
		"a quoted fragment": "invalid value " + secret[:20] + "… for text",
		"a bare fragment":   secret[10:30],
	} {
		t.Run(name, func(t *testing.T) {
			f := newFixture(t, func(w http.ResponseWriter, r *http.Request, _ []byte) {
				writeAPIError(w, http.StatusBadRequest, 10021, message)
			})

			err := f.client().SetSecret(context.Background(), "acct-123", "flue-relay", "DAEMON_SECRET", secret)
			if err == nil {
				t.Fatal("SetSecret = nil, want the rejection")
			}
			// Every run of the secret, not just the whole string: the point is
			// that no usable piece of it reaches a screen.
			for i := 0; i+8 <= len(secret); i++ {
				if strings.Contains(err.Error(), secret[i:i+8]) {
					t.Fatalf("error carries %q, a run of the secret: %v", secret[i:i+8], err)
				}
			}
			// The code survives, because it is the part a user can act on.
			var apiErr *APIError
			if !errors.As(err, &apiErr) || apiErr.Code != 10021 {
				t.Errorf("error = %#v, want an *APIError still carrying code 10021", err)
			}
		})
	}
}

// TestSetSecretKeepsAnUnrelatedMessage is the other half: withholding is for
// the message that quoted the secret, not for every failure of this endpoint.
func TestSetSecretKeepsAnUnrelatedMessage(t *testing.T) {
	f := newFixture(t, func(w http.ResponseWriter, r *http.Request, _ []byte) {
		writeAPIError(w, http.StatusNotFound, 10007, "workers.api.error.script_not_found")
	})

	err := f.client().SetSecret(context.Background(), "acct-123", "flue-relay", "DAEMON_SECRET", "hunter2hunter2hunter2")
	if err == nil {
		t.Fatal("SetSecret = nil, want the rejection")
	}
	if !strings.Contains(err.Error(), "script_not_found") {
		t.Errorf("error %q dropped a message that never mentioned the secret", err)
	}
}

// TestCallBoundsTheResponseBody: a wrong endpoint, a captive portal or a broken
// edge must not be read into memory without limit — and the refusal must name
// the size rather than quoting bytes the server chose.
func TestCallBoundsTheResponseBody(t *testing.T) {
	f := newFixture(t, func(w http.ResponseWriter, r *http.Request, _ []byte) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		// Valid JSON that never ends inside the cap, so a client that read it
		// all would succeed and one that truncated blindly would report a
		// parse failure instead of a size one.
		_, _ = io.WriteString(w, `{"success":true,"result":"`)
		chunk := strings.Repeat("A", 64<<10)
		for written := 0; written < maxResponseBytes+(1<<20); written += len(chunk) {
			_, _ = io.WriteString(w, chunk)
		}
		_, _ = io.WriteString(w, `"}`)
	})

	_, err := f.client().Accounts(context.Background())
	if err == nil {
		t.Fatal("Accounts against an endless body = nil, want an error")
	}
	if !strings.Contains(err.Error(), "ran past") {
		t.Errorf("error %q does not report the body running past the cap", err)
	}
	if strings.Contains(err.Error(), "AAAA") {
		t.Errorf("error quotes the body back: %v", err)
	}
}

// TestAPIErrorMessageIsBounded: the message reaches a terminal and every byte
// of it was chosen by the server.
func TestAPIErrorMessageIsBounded(t *testing.T) {
	f := newFixture(t, func(w http.ResponseWriter, r *http.Request, _ []byte) {
		writeAPIError(w, http.StatusBadRequest, 1000, strings.Repeat("x", 4<<20))
	})

	err := f.client().VerifyToken(context.Background())
	if err == nil {
		t.Fatal("VerifyToken = nil, want the rejection")
	}
	if len(err.Error()) > maxAPIMessageChars+200 {
		t.Errorf("error is %d bytes; the server's message was not bounded", len(err.Error()))
	}
}

// ------------------------------------------------------------ EnableSubdomain

func TestEnableSubdomainComposesTheHost(t *testing.T) {
	f := newFixture(t, func(w http.ResponseWriter, r *http.Request, body []byte) {
		switch r.URL.Path {
		case "/accounts/acct-123/workers/subdomain":
			writeEnvelope(t, w, http.StatusOK, map[string]any{"subdomain": "karn"})
		case "/accounts/acct-123/workers/scripts/flue-relay/subdomain":
			var got map[string]any
			if err := json.Unmarshal(body, &got); err != nil {
				t.Errorf("decoding subdomain body: %v (%s)", err, body)
			}
			if got["enabled"] != true {
				t.Errorf("subdomain body = %+v, want enabled true", got)
			}
			writeEnvelope(t, w, http.StatusOK, map[string]any{"enabled": true, "previews_enabled": true})
		default:
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
		}
	})

	host, err := f.client().EnableSubdomain(context.Background(), "acct-123", "flue-relay")
	if err != nil {
		t.Fatalf("EnableSubdomain: %v", err)
	}
	if want := "flue-relay.karn.workers.dev"; host != want {
		t.Errorf("host = %q, want %q", host, want)
	}

	enable := f.only("/accounts/acct-123/workers/scripts/flue-relay/subdomain")
	if enable.Method != http.MethodPost {
		t.Errorf("enable method = %s, want POST", enable.Method)
	}
	// This endpoint is versioned by date. Without the header the meaning of the
	// request is whatever vintage the account defaults to.
	if got, want := enable.Header.Get("Cloudflare-Workers-Script-Api-Date"), "2025-08-01"; got != want {
		t.Errorf("Cloudflare-Workers-Script-Api-Date = %q, want %q", got, want)
	}
	read := f.only("/accounts/acct-123/workers/subdomain")
	if read.Method != http.MethodGet {
		t.Errorf("subdomain read method = %s, want GET", read.Method)
	}
}

// TestEnableSubdomainFailsWhenTheAccountHasNone: an account that never
// registered a workers.dev subdomain has nowhere to serve the relay, and
// returning "flue-relay..workers.dev" would be worse than an error.
func TestEnableSubdomainFailsWhenTheAccountHasNone(t *testing.T) {
	f := newFixture(t, func(w http.ResponseWriter, r *http.Request, body []byte) {
		if r.URL.Path == "/accounts/acct-123/workers/subdomain" {
			writeEnvelope(t, w, http.StatusOK, map[string]any{"subdomain": ""})
			return
		}
		writeEnvelope(t, w, http.StatusOK, map[string]any{"enabled": true})
	})

	host, err := f.client().EnableSubdomain(context.Background(), "acct-123", "flue-relay")
	if err == nil {
		t.Fatalf("EnableSubdomain with no registered subdomain = %q, want an error", host)
	}
	if !strings.Contains(err.Error(), "workers.dev") {
		t.Errorf("error %q does not explain that the account has no workers.dev subdomain", err)
	}
}

// ----------------------------------------------------------------------- Base

// TestZeroValueClientTargetsTheRealAPI: Base is a test seam, and a zero value
// must mean production rather than an empty URL.
func TestZeroValueClientTargetsTheRealAPI(t *testing.T) {
	c := &Client{Token: testToken}
	if got, want := c.baseURL(), "https://api.cloudflare.com/client/v4"; got != want {
		t.Errorf("baseURL() = %q, want %q", got, want)
	}
}
