// Package cloudflare is a small client for the parts of the Cloudflare v4 REST
// API that `flue relay setup` needs: verifying a user's API token, listing the
// accounts it can reach, and deploying the relay Worker — script, Durable
// Object, static assets and all — into the account they choose.
//
// It is deliberately not a general Cloudflare SDK. Every endpoint here exists
// because one step of the setup flow needs it, and the request shapes are
// pinned by fixtures in client_test.go rather than inferred, because the parts
// of this API that matter most (the asset upload session, the multipart script
// metadata) are the parts the published documentation describes least
// precisely. Where the docs and Cloudflare's own clients disagreed, the
// fixtures follow the clients — see the notes on hashOf and on migrations.
//
// The API token is a field on Client and is never logged: it goes into an
// Authorization header and nowhere else. Client.String redacts it so that a
// stray %v cannot undo that.
package cloudflare

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/textproto"
	"sort"
	"strings"
)

// defaultBase is the production API root. Client.Base overrides it in tests.
const defaultBase = "https://api.cloudflare.com/client/v4"

// mainModule is the part name the Worker's entry point is uploaded under, and
// the value of metadata.main_module that points at it. The relay is a single
// ESM bundle, so one name serves both.
const mainModule = "index.js"

// migrationTag is the Durable Object migration tag this client applies. It
// matches the `"tag": "v1"` in relay/wrangler.jsonc: a Worker deployed by
// `flue relay setup` and one deployed by wrangler must agree on the tag, or
// Cloudflare sees two different migration histories for the same class.
const migrationTag = "v1"

// notFoundHandling makes the asset router serve index.html for unmatched
// paths, which is what a single-page app needs and what relay/wrangler.jsonc
// configures.
const notFoundHandling = "single-page-application"

// htmlHandling is sent explicitly even though it is Cloudflare's default,
// because "the default" is a server-side decision that can move underneath a
// deployed Worker. wrangler.jsonc does not set it, so this is the value a
// wrangler deploy would produce today — pinning it keeps the two tools
// producing the same router, and keeps a future change to the default from
// silently altering how /foo, /foo/ and /foo.html resolve for existing users.
const htmlHandling = "auto-trailing-slash"

// keptBindingTypes are the binding types a script upload preserves from the
// already-deployed version rather than replacing.
//
// A script PUT does not merge bindings: metadata.bindings *is* the new binding
// set, and anything the deployed script had that the upload does not name is
// gone. Secrets are bindings — Cloudflare stores DAEMON_SECRET as a
// `secret_text` binding — so without this, every deploy of an existing relay
// unbinds the one credential its daemon authenticates with. That is invisible:
// the deploy succeeds, and the Worker only starts refusing the daemon later.
//
// This is sent on every upload rather than being a DeployInput field, because a
// field would be a knob with exactly one safe setting whose zero value is the
// dangerous one — the first caller to forget it takes a working relay down and
// gets a green deploy for it. It is also what wrangler does: `wrangler deploy`
// keeps secrets across a redeploy by sending this same key, which is why a
// Worker deployed from the repo does not lose its secrets either.
//
// Only `secret_text` is named. flue creates no other kind of secret, and
// keeping the list to the types this tool actually depends on means a binding
// type added here later has to opt in deliberately instead of quietly
// surviving an upload that meant to replace it.
var keptBindingTypes = []string{"secret_text"}

// maxResponseBytes bounds one API response before anything parses it. Four
// mebibytes is orders of magnitude past the largest thing this client asks for
// and is a bound rather than a budget.
const maxResponseBytes = 4 << 20

// maxAPIMessageChars bounds a Cloudflare error message on its way to the user's
// terminal. Long enough that migrationAlreadyApplied still sees the wording it
// matches on, short enough that a hostile or broken response cannot write four
// mebibytes into a screen.
const maxAPIMessageChars = 512

// scriptAPIDate pins the Worker subdomain endpoint's contract. Cloudflare
// versions that endpoint by date and current wrangler sends this same value;
// without it the meaning of previews_enabled is whatever the account's default
// vintage says it is.
const scriptAPIDate = "2025-08-01"

// Client talks to the Cloudflare v4 REST API with a user-supplied token.
// The zero value is usable and targets the real API.
type Client struct {
	HTTP  *http.Client
	Token string
	Base  string // default https://api.cloudflare.com/client/v4
}

// String redacts the token. Client is carried through the setup flow next to
// things that do get logged, and the token must never be one of them.
//
// The receiver is a value, not a pointer, because a pointer receiver would
// leave `%v` on a Client value printing the token verbatim — and a Client is
// small enough to be passed around by value. GoString covers `%#v`, which
// ignores Stringer entirely and would otherwise dump every field.
func (c Client) String() string {
	return fmt.Sprintf("cloudflare.Client{Base: %q, Token: [redacted]}", c.baseURL())
}

// GoString redacts the token under %#v.
func (c Client) GoString() string { return c.String() }

func (c Client) baseURL() string {
	if c.Base == "" {
		return defaultBase
	}
	return strings.TrimSuffix(c.Base, "/")
}

func (c *Client) httpClient() *http.Client {
	if c.HTTP != nil {
		return c.HTTP
	}
	return http.DefaultClient
}

// Account is one Cloudflare account the token can act on.
type Account struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// APIError is a failure Cloudflare reported inside its own envelope, as
// opposed to a transport failure. It carries the first error's code and
// message, which are what the setup flow shows the user.
type APIError struct {
	Code    int
	Message string
}

func (e *APIError) Error() string {
	return fmt.Sprintf("cloudflare: %d %s", e.Code, e.Message)
}

// envelope is the shape every v4 response arrives in.
type envelope struct {
	Success    bool            `json:"success"`
	Errors     []envelopeError `json:"errors"`
	Result     json.RawMessage `json:"result"`
	ResultInfo *resultInfo     `json:"result_info"`
}

type envelopeError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

// resultInfo is the pagination block list endpoints carry. It is absent on
// everything else, so callers get a nil.
type resultInfo struct {
	Page       int `json:"page"`
	PerPage    int `json:"per_page"`
	Count      int `json:"count"`
	TotalCount int `json:"total_count"`
	TotalPages int `json:"total_pages"`
}

// apiCall is one request. Most fields are optional; bearer defaults to the
// client's API token, which is what every endpoint but the asset upload wants.
type apiCall struct {
	method      string
	path        string
	bearer      string
	contentType string
	body        []byte
	headers     map[string]string
}

// call sends one request and unwraps the Cloudflare envelope, returning the
// raw result for the caller to decode.
//
// Everything is bounded by ctx and nothing is retried here: the only retry in
// this package is Deploy's migration re-run, which is a semantic decision the
// transport layer has no business making.
func (c *Client) call(ctx context.Context, a apiCall) (json.RawMessage, error) {
	raw, _, err := c.callWithInfo(ctx, a)
	return raw, err
}

// callWithInfo is call, plus the pagination block for the endpoints that
// return one.
func (c *Client) callWithInfo(ctx context.Context, a apiCall) (json.RawMessage, *resultInfo, error) {
	var body io.Reader
	if a.body != nil {
		body = bytes.NewReader(a.body)
	}
	req, err := http.NewRequestWithContext(ctx, a.method, c.baseURL()+a.path, body)
	if err != nil {
		return nil, nil, fmt.Errorf("cloudflare: building %s %s: %w", a.method, a.path, err)
	}
	bearer := a.bearer
	if bearer == "" {
		bearer = c.Token
	}
	req.Header.Set("Authorization", "Bearer "+bearer)
	if a.contentType != "" {
		req.Header.Set("Content-Type", a.contentType)
	}
	for k, v := range a.headers {
		req.Header.Set(k, v)
	}

	resp, err := c.httpClient().Do(req)
	if err != nil {
		return nil, nil, fmt.Errorf("cloudflare: %s %s: %w", a.method, a.path, err)
	}
	defer resp.Body.Close()

	// One byte past the cap, so a body that is exactly at it still parses and
	// anything longer is detectable rather than silently truncated into
	// unparseable JSON. Nothing this client asks for is large — the biggest is
	// an upload session's list of content hashes — so the cap is far above any
	// real answer and exists to stop a wrong endpoint, a captive portal or a
	// broken edge from being read into memory without limit.
	raw, err := io.ReadAll(io.LimitReader(resp.Body, maxResponseBytes+1))
	if err != nil {
		return nil, nil, fmt.Errorf("cloudflare: reading %s %s: %w", a.method, a.path, err)
	}
	if len(raw) > maxResponseBytes {
		return nil, nil, fmt.Errorf("cloudflare: %s %s: response ran past %d bytes (HTTP %d)", a.method, a.path, maxResponseBytes, resp.StatusCode)
	}

	var env envelope
	if err := json.Unmarshal(raw, &env); err != nil {
		// Cloudflare's edge answers some failures with HTML. Report the status,
		// not the body: it is bounded now but it is still the server's own bytes
		// and can echo the request.
		return nil, nil, fmt.Errorf("cloudflare: %s %s: unexpected response (HTTP %d)", a.method, a.path, resp.StatusCode)
	}
	if !env.Success {
		if len(env.Errors) > 0 {
			// Bounded for the reason the body is: this string reaches the user's
			// terminal through APIError.Error, and every byte of it was chosen by
			// the server. The bound is generous enough to leave
			// migrationAlreadyApplied's two words in place.
			return nil, nil, &APIError{
				Code:    env.Errors[0].Code,
				Message: bounded(env.Errors[0].Message, maxAPIMessageChars),
			}
		}
		return nil, nil, fmt.Errorf("cloudflare: %s %s failed without an error message (HTTP %d)", a.method, a.path, resp.StatusCode)
	}
	return env.Result, env.ResultInfo, nil
}

// VerifyToken checks the token is real, active, and usable, so that setup can
// fail on a bad token before it has created anything.
func (c *Client) VerifyToken(ctx context.Context) error {
	raw, err := c.call(ctx, apiCall{method: http.MethodGet, path: "/user/tokens/verify"})
	if err != nil {
		// Only reword a failure Cloudflare itself reported. An *APIError from
		// this endpoint means Cloudflare looked at the token and said no, and
		// naming the token matters there: the underlying message is "Invalid API
		// Token", which reads like a Cloudflare-side fault unless we say whose
		// token it is.
		//
		// A transport failure — no DNS, no route, TLS refused, a cancelled
		// context — says nothing whatsoever about the token, and calling it a
		// rejection would send the user off to reissue a credential that was
		// fine while the actual problem (their network) went unmentioned.
		var apiErr *APIError
		if !errors.As(err, &apiErr) {
			return err
		}
		return fmt.Errorf("cloudflare: the API token was rejected: %w", err)
	}
	var result struct {
		ID     string `json:"id"`
		Status string `json:"status"`
	}
	if err := json.Unmarshal(raw, &result); err != nil {
		return fmt.Errorf("cloudflare: could not read the token verification: %w", err)
	}
	// A token that exists but is expired or disabled verifies with HTTP 200.
	// Treating that as success would hand the user a deploy that cannot work.
	if result.Status != "active" {
		return fmt.Errorf("cloudflare: the API token is %s, not active", result.Status)
	}
	return nil
}

// accountsPerPage is how many accounts one page asks for. Cloudflare's default
// is 20, and a user with more accounts than that would simply not see the rest
// — with no error and nothing to suggest the list was cut off, which is the
// worst way for setup to fail.
const accountsPerPage = 50

// maxAccountPages bounds the pagination loop. At 50 per page this is 1000
// accounts, far past anything real; it exists so that a server that keeps
// claiming there is another page cannot spin here forever.
const maxAccountPages = 20

// Accounts lists the accounts the token can act on, so setup can ask which one
// the relay should live in. It follows pagination to the last page.
func (c *Client) Accounts(ctx context.Context) ([]Account, error) {
	var all []Account
	for page := 1; page <= maxAccountPages; page++ {
		raw, info, err := c.callWithInfo(ctx, apiCall{
			method: http.MethodGet,
			path:   fmt.Sprintf("/accounts?per_page=%d&page=%d", accountsPerPage, page),
		})
		if err != nil {
			return nil, err
		}
		var accounts []Account
		if err := json.Unmarshal(raw, &accounts); err != nil {
			return nil, fmt.Errorf("cloudflare: could not read the account list: %w", err)
		}
		all = append(all, accounts...)

		// Termination has to hold when the pagination block is partial or
		// missing. Cloudflare documents this endpoint's result_info as
		// {count, page, per_page, total_count} — with no total_pages — and
		// cloudflare-go pages this endpoint by stopping on an empty result,
		// reading neither count. So the page in hand is the primary signal and
		// the block may only ever add a reason to keep going, never supply the
		// only reason to stop. Making total_pages load-bearing would drop every
		// account past the first page against the documented shape.

		// An empty page ends the list whatever the block claims. This is also
		// what stops a server that insists there is always another page.
		if len(accounts) == 0 {
			break
		}
		// A full page means there is plausibly another one behind it. "Full" is
		// measured against the size the server says it used, when it says:
		// a server free to cap per_page below what was asked would otherwise
		// make every page look short and truncate the list at the first one.
		perPage := accountsPerPage
		if info != nil && info.PerPage > 0 {
			perPage = info.PerPage
		}
		if len(accounts) >= perPage {
			continue
		}
		// A short page is the last one unless the block explicitly says
		// otherwise. total_count is deliberately not used to stop early: it is
		// a number the server can get wrong, and preferring it to the page in
		// hand is how a list gets silently truncated. The cost of not trusting
		// it is one extra request when the account count is an exact multiple
		// of the page size, and maxAccountPages bounds the rest.
		if info == nil || info.TotalPages <= page {
			break
		}
	}
	return all, nil
}

// DeployInput is everything one deploy of the relay Worker needs.
type DeployInput struct {
	AccountID         string
	ScriptName        string // "flue-relay"
	Module            []byte // the built worker, ESM
	CompatibilityDate string // "2026-08-01"

	// NewSQLiteClasses names Durable Object classes being introduced. It is
	// set on the first deploy and empty afterwards; Deploy also recovers on its
	// own when Cloudflare says the migration is already applied.
	//
	// These must be *SQLite* classes: the free plan offers no other storage
	// backend for Durable Objects, so a key-value migration would shut free
	// accounts out of the relay entirely.
	NewSQLiteClasses []string

	DOBindings           map[string]string // name -> class: {"HUB": "DaemonHub"}
	Assets               []Asset
	AssetsRunWorkerFirst []string // ["/daemon", "/client", "/api/*"]

	// AssetHeaders is a `_headers` document — response headers for the static
	// assets, in the file format Cloudflare's asset router parses. Empty sends
	// no header config at all. See assetsConfig.Headers for why this travels in
	// the script metadata rather than as a file among the assets.
	//
	// It applies to responses the asset router produces, including the ones a
	// Worker asks for through its assets binding, and not to responses the
	// Worker constructs itself.
	AssetHeaders string

	// AssetsBinding is the name the Worker reads its static assets off env
	// under — "ASSETS" for the relay, matching `assets.binding` in
	// relay/wrangler.jsonc. It is emitted as a binding of type "assets".
	//
	// This is separate from attaching the assets at all, and the distinction is
	// easy to get wrong: the completion token in metadata.assets.jwt makes
	// Cloudflare's *router* serve the files, and that alone is enough for a
	// Worker that only ever needs static paths served for it. It does not
	// create env.<name>. A Worker that calls env.ASSETS.fetch(...) itself — as
	// the relay does, to fall through to the SPA on unmatched /api/* — needs
	// this binding too, or that call is on undefined at runtime.
	//
	// Empty means no binding, which is correct for a router-only deploy.
	AssetsBinding string

	// Observability turns on Workers Logs for the script, matching
	// `"observability": {"enabled": true}` in relay/wrangler.jsonc. Without it
	// a relay deployed by `flue relay setup` would have no logs to debug from
	// where a wrangler-deployed one would.
	Observability bool
}

// scriptMetadata is the `metadata` part of the multipart script upload. Field
// order here is the byte order on the wire, and it is fixed so that two deploys
// of the same input produce the same request.
type scriptMetadata struct {
	MainModule        string          `json:"main_module"`
	CompatibilityDate string          `json:"compatibility_date,omitempty"`
	Bindings          []binding       `json:"bindings,omitempty"`
	KeepBindings      []string        `json:"keep_bindings,omitempty"`
	Migrations        *migrations     `json:"migrations,omitempty"`
	Assets            *assetsMetadata `json:"assets,omitempty"`
	Observability     *observability  `json:"observability,omitempty"`
}

// binding is one entry of metadata.bindings. class_name is omitted when empty
// because only durable_object_namespace bindings carry one — an assets binding
// is just a type and a name.
type binding struct {
	Type      string `json:"type"`
	Name      string `json:"name"`
	ClassName string `json:"class_name,omitempty"`
}

type observability struct {
	Enabled bool `json:"enabled"`
}

// migrations is the API's migration object. Note that this is an object with a
// tag and a list of steps, not the array of tagged steps that a wrangler config
// file holds: wrangler diffs its config against the deployed tag and sends the
// result in this shape. The multipart-metadata documentation calls the field an
// "array[object]", which describes the config file rather than the wire.
type migrations struct {
	NewTag string          `json:"new_tag"`
	Steps  []migrationStep `json:"steps"`
}

type migrationStep struct {
	NewSQLiteClasses []string `json:"new_sqlite_classes,omitempty"`
}

type assetsMetadata struct {
	JWT    string       `json:"jwt"`
	Config assetsConfig `json:"config"`
}

type assetsConfig struct {
	HTMLHandling     string   `json:"html_handling"`
	NotFoundHandling string   `json:"not_found_handling"`
	RunWorkerFirst   []string `json:"run_worker_first,omitempty"`

	// Headers is the contents of a `_headers` file, verbatim — newlines and
	// all — and it is how response headers are attached to static assets.
	//
	// The indirection is worth stating, because the obvious thing does not
	// work. A `_headers` file placed in the assets directory is **not** an
	// asset: wrangler strips it out of the manifest and sends its bytes here
	// instead, and an uploader that skipped this field would have published a
	// public `/_headers` document that Cloudflare never reads. The field name
	// keeps the leading underscore because the API is named after the file.
	//
	// It is absent from Cloudflare's published multipart-metadata reference,
	// which documents only html_handling and not_found_handling. It is
	// nonetheless what every `wrangler deploy` of an assets directory
	// containing a `_headers` file sends (wrangler's AssetConfigMetadata), so
	// it is as well attested as this API gets — but it stays `omitempty`, so a
	// deploy with nothing to say sends nothing rather than an empty string a
	// stricter server could reject.
	Headers string `json:"_headers,omitempty"`
}

// Deploy uploads the assets, then PUTs the script with its metadata.
//
// The order is forced: the script's metadata has to name a completion token
// that only the finished asset upload can produce.
func (c *Client) Deploy(ctx context.Context, in DeployInput) error {
	meta := scriptMetadata{
		MainModule:        mainModule,
		CompatibilityDate: in.CompatibilityDate,
	}

	// Map iteration order in Go is randomised, so the bindings are sorted by
	// name. Without this the same input would produce a different request body
	// on every run, which makes deploys undiffable and this package untestable.
	names := make([]string, 0, len(in.DOBindings))
	for name := range in.DOBindings {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		meta.Bindings = append(meta.Bindings, binding{
			Type:      "durable_object_namespace",
			Name:      name,
			ClassName: in.DOBindings[name],
		})
	}

	// The assets binding goes after the Durable Object ones, which is the order
	// wrangler emits, and is only meaningful when there are assets to bind to.
	if in.AssetsBinding != "" && len(in.Assets) > 0 {
		meta.Bindings = append(meta.Bindings, binding{Type: "assets", Name: in.AssetsBinding})
	}

	if len(in.NewSQLiteClasses) > 0 {
		meta.Migrations = &migrations{
			NewTag: migrationTag,
			Steps:  []migrationStep{{NewSQLiteClasses: in.NewSQLiteClasses}},
		}
	}

	if in.Observability {
		meta.Observability = &observability{Enabled: true}
	}

	if len(in.Assets) > 0 {
		jwt, err := c.uploadAssets(ctx, in.AccountID, in.ScriptName, in.Assets)
		if err != nil {
			return err
		}
		meta.Assets = &assetsMetadata{
			JWT: jwt,
			Config: assetsConfig{
				HTMLHandling:     htmlHandling,
				NotFoundHandling: notFoundHandling,
				RunWorkerFirst:   in.AssetsRunWorkerFirst,
				Headers:          in.AssetHeaders,
			},
		}
	}

	err := c.putScript(ctx, in, meta)
	if err != nil && meta.Migrations != nil && migrationAlreadyApplied(err) {
		// Re-running setup against an account that already has the Worker is an
		// ordinary thing to do — after a failed run, or to pick up a new build.
		// Cloudflare refuses to apply a migration it has already applied, so the
		// deploy is retried once without it. The classes still exist; only the
		// migration is redundant.
		meta.Migrations = nil

		// The asset completion token was spent on the PUT that just failed, and
		// Cloudflare does not document whether it survives a rejected upload.
		// Rather than bet the whole idempotent-re-run path on it being reusable,
		// the retry opens a fresh upload session. That session costs one request
		// and no uploads in the normal case: every file is already stored, so it
		// comes back with no buckets and its own token is the completion token.
		if meta.Assets != nil {
			jwt, refreshErr := c.uploadAssets(ctx, in.AccountID, in.ScriptName, in.Assets)
			if refreshErr != nil {
				// Both halves are wrapped. The refresh failure is what stopped
				// the retry, but the deploy failure is why there was a retry at
				// all, and dropping it leaves the user with a session error and
				// no sign that a migration conflict is the thing to fix.
				return fmt.Errorf("cloudflare: re-attaching the assets to retry without the already-applied migration: %w (the deploy this retried failed with: %w)", refreshErr, err)
			}
			meta.Assets.JWT = jwt
		}
		err = c.putScript(ctx, in, meta)
	}
	return err
}

// putScript sends the multipart script upload: the metadata part and the
// module it names.
func (c *Client) putScript(ctx context.Context, in DeployInput, meta scriptMetadata) error {
	// Set here, not by the caller: this is the one place a script upload is
	// built, so no path through Deploy — first attempt or migration retry — can
	// produce an upload that drops the deployed script's secrets. See
	// keptBindingTypes.
	meta.KeepBindings = keptBindingTypes

	metaJSON, err := json.Marshal(meta)
	if err != nil {
		return fmt.Errorf("cloudflare: encoding the script metadata: %w", err)
	}

	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)

	metaPart, err := mw.CreatePart(partHeader("metadata", "", "application/json"))
	if err != nil {
		return fmt.Errorf("cloudflare: building the script upload: %w", err)
	}
	if _, err := metaPart.Write(metaJSON); err != nil {
		return fmt.Errorf("cloudflare: building the script upload: %w", err)
	}

	// The module part is named for main_module above; Cloudflare resolves the
	// entry point by matching the two.
	modPart, err := mw.CreatePart(partHeader(mainModule, mainModule, "application/javascript+module"))
	if err != nil {
		return fmt.Errorf("cloudflare: building the script upload: %w", err)
	}
	if _, err := modPart.Write(in.Module); err != nil {
		return fmt.Errorf("cloudflare: building the script upload: %w", err)
	}
	if err := mw.Close(); err != nil {
		return fmt.Errorf("cloudflare: building the script upload: %w", err)
	}

	_, err = c.call(ctx, apiCall{
		method:      http.MethodPut,
		path:        fmt.Sprintf("/accounts/%s/workers/scripts/%s", in.AccountID, in.ScriptName),
		contentType: mw.FormDataContentType(),
		body:        buf.Bytes(),
	})
	return err
}

// migrationAlreadyApplied reports whether err is Cloudflare refusing a Durable
// Object migration that the account has already run.
//
// The match is on the message rather than the code because Cloudflare has
// reported this condition under more than one code, but it deliberately
// requires *both* halves of the claim: that this is about a migration, and
// that the migration is already in place. Matching "migration" alone would
// also catch a mismatched tag or a class that is not in the script — and for
// those, retrying without migrations could succeed, deploying a Worker whose
// Durable Object was never migrated and burying the real error behind a
// second request.
//
// Known residual: "…already depended on by existing Durable Objects" matches
// here, and it is the message a genuine re-run produces — but Cloudflare uses
// wording in that family for a *different* condition too, where the class is
// already in use with a non-SQLite backend. That case is not an idempotent
// re-run and dropping the migration would leave the mismatch in place. The two
// are not separable from the text alone, and closing the gap needs a live
// signal (the deployed script's migration_tag, read before deploying) that
// this client does not currently fetch. Left open deliberately: the failure
// mode is a confusing error on an account that cannot work anyway, not a
// silently wrong deploy of a fresh one.
func migrationAlreadyApplied(err error) bool {
	var apiErr *APIError
	if !errors.As(err, &apiErr) {
		return false
	}
	msg := strings.ToLower(apiErr.Message)
	return strings.Contains(msg, "migration") && strings.Contains(msg, "already")
}

// SetSecret sets a secret on the script. Cloudflare stores it as a
// `secret_text` binding, so the Worker reads it off env like any other binding
// but the value is never readable back.
func (c *Client) SetSecret(ctx context.Context, accountID, script, name, value string) error {
	body, err := json.Marshal(map[string]string{
		"name": name,
		"text": value,
		"type": "secret_text",
	})
	if err != nil {
		return fmt.Errorf("cloudflare: encoding the secret: %w", err)
	}
	_, err = c.call(ctx, apiCall{
		method:      http.MethodPut,
		path:        fmt.Sprintf("/accounts/%s/workers/scripts/%s/secrets", accountID, script),
		contentType: "application/json",
		body:        body,
	})
	// This is the one request in the package whose body *is* a credential, and
	// the one place a Cloudflare validation error could quote it back. That
	// error goes to the user's terminal verbatim (`flue relay setup` wraps and
	// prints it), so it is checked rather than trusted.
	return withoutSecret(err, value)
}

// secretEchoRun is how much of a secret has to appear in a message for the
// message to be dropped.
//
// A whole-string match is not the bound worth setting: a server that echoes
// what it rejected may truncate, quote, or wrap it, and any of those slips past
// an equality test while still putting most of a credential on a screen. Eight
// characters is long enough that a base64 secret cannot produce one by
// coincidence and short enough that a partial echo does not get through.
const secretEchoRun = 8

// withoutSecret returns err with Cloudflare's own message removed if any run of
// the secret appears in it.
//
// All or nothing, deliberately. Substituting the matched run would leave the
// rest of the message — including whatever else of the credential the server
// chose to quote — and would report a redaction that had not actually covered
// what it claimed to. Cloudflare's error *code* survives wherever there was
// one, which is the part a user can look up; losing the sentence on the rare
// request that echoes a secret is the cheaper half of that trade.
func withoutSecret(err error, secret string) error {
	if err == nil || len(secret) < secretEchoRun {
		return err
	}
	msg := err.Error()
	for i := 0; i+secretEchoRun <= len(secret); i++ {
		if !strings.Contains(msg, secret[i:i+secretEchoRun]) {
			continue
		}
		var apiErr *APIError
		if errors.As(err, &apiErr) {
			return &APIError{Code: apiErr.Code, Message: "error message withheld: it quoted the secret being set"}
		}
		return errors.New("cloudflare: setting the secret failed, and the error message is withheld because it quoted the secret")
	}
	return err
}

// EnableSubdomain makes the script reachable on workers.dev and returns the
// full host, e.g. "flue-relay.<sub>.workers.dev".
func (c *Client) EnableSubdomain(ctx context.Context, accountID, script string) (string, error) {
	raw, err := c.call(ctx, apiCall{
		method: http.MethodGet,
		path:   fmt.Sprintf("/accounts/%s/workers/subdomain", accountID),
	})
	if err != nil {
		return "", err
	}
	var sub struct {
		Subdomain string `json:"subdomain"`
	}
	if err := json.Unmarshal(raw, &sub); err != nil {
		return "", fmt.Errorf("cloudflare: could not read the account's workers.dev subdomain: %w", err)
	}
	if sub.Subdomain == "" {
		// An account only gets one once someone registers it, and there is no
		// host to hand back until they do. Composing one anyway would produce
		// "flue-relay..workers.dev" and fail much later, somewhere less obvious.
		return "", errors.New("cloudflare: this account has no workers.dev subdomain registered; register one in the Cloudflare dashboard under Workers & Pages")
	}

	body, err := json.Marshal(map[string]bool{"enabled": true, "previews_enabled": true})
	if err != nil {
		return "", fmt.Errorf("cloudflare: encoding the subdomain request: %w", err)
	}
	if _, err := c.call(ctx, apiCall{
		method:      http.MethodPost,
		path:        fmt.Sprintf("/accounts/%s/workers/scripts/%s/subdomain", accountID, script),
		contentType: "application/json",
		body:        body,
		headers:     map[string]string{"Cloudflare-Workers-Script-Api-Date": scriptAPIDate},
	}); err != nil {
		return "", err
	}
	return fmt.Sprintf("%s.%s.workers.dev", script, sub.Subdomain), nil
}

// quoteEscaper matches the escaping mime/multipart applies to part names.
var quoteEscaper = strings.NewReplacer(`\`, `\\`, `"`, `\"`)

// partHeader builds a multipart part header. mime/multipart's own CreateFormFile
// hardcodes application/octet-stream, and every part here needs its own type:
// Cloudflare reads the module part's type to know it is an ES module, and
// serves each asset with the type its part carried.
func partHeader(name, filename, contentType string) textproto.MIMEHeader {
	h := make(textproto.MIMEHeader)
	disposition := fmt.Sprintf(`form-data; name="%s"`, quoteEscaper.Replace(name))
	if filename != "" {
		disposition += fmt.Sprintf(`; filename="%s"`, quoteEscaper.Replace(filename))
	}
	h.Set("Content-Disposition", disposition)
	h.Set("Content-Type", contentType)
	return h
}
