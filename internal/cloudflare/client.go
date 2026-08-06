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
	Success bool            `json:"success"`
	Errors  []envelopeError `json:"errors"`
	Result  json.RawMessage `json:"result"`
}

type envelopeError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
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
	var body io.Reader
	if a.body != nil {
		body = bytes.NewReader(a.body)
	}
	req, err := http.NewRequestWithContext(ctx, a.method, c.baseURL()+a.path, body)
	if err != nil {
		return nil, fmt.Errorf("cloudflare: building %s %s: %w", a.method, a.path, err)
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
		return nil, fmt.Errorf("cloudflare: %s %s: %w", a.method, a.path, err)
	}
	defer resp.Body.Close()

	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("cloudflare: reading %s %s: %w", a.method, a.path, err)
	}

	var env envelope
	if err := json.Unmarshal(raw, &env); err != nil {
		// Cloudflare's edge answers some failures with HTML. Report the status,
		// not the body: the body is unbounded and can echo the request.
		return nil, fmt.Errorf("cloudflare: %s %s: unexpected response (HTTP %d)", a.method, a.path, resp.StatusCode)
	}
	if !env.Success {
		if len(env.Errors) > 0 {
			return nil, &APIError{Code: env.Errors[0].Code, Message: env.Errors[0].Message}
		}
		return nil, fmt.Errorf("cloudflare: %s %s failed without an error message (HTTP %d)", a.method, a.path, resp.StatusCode)
	}
	return env.Result, nil
}

// VerifyToken checks the token is real, active, and usable, so that setup can
// fail on a bad token before it has created anything.
func (c *Client) VerifyToken(ctx context.Context) error {
	raw, err := c.call(ctx, apiCall{method: http.MethodGet, path: "/user/tokens/verify"})
	if err != nil {
		// Naming the token matters: the underlying message is "Invalid API
		// Token", which reads like a Cloudflare-side fault unless we say whose
		// token it is and where it came from.
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

// Accounts lists the accounts the token can act on, so setup can ask which one
// the relay should live in.
func (c *Client) Accounts(ctx context.Context) ([]Account, error) {
	raw, err := c.call(ctx, apiCall{method: http.MethodGet, path: "/accounts"})
	if err != nil {
		return nil, err
	}
	var accounts []Account
	if err := json.Unmarshal(raw, &accounts); err != nil {
		return nil, fmt.Errorf("cloudflare: could not read the account list: %w", err)
	}
	return accounts, nil
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
}

// scriptMetadata is the `metadata` part of the multipart script upload. Field
// order here is the byte order on the wire, and it is fixed so that two deploys
// of the same input produce the same request.
type scriptMetadata struct {
	MainModule        string          `json:"main_module"`
	CompatibilityDate string          `json:"compatibility_date,omitempty"`
	Bindings          []binding       `json:"bindings,omitempty"`
	Migrations        *migrations     `json:"migrations,omitempty"`
	Assets            *assetsMetadata `json:"assets,omitempty"`
}

type binding struct {
	Type      string `json:"type"`
	Name      string `json:"name"`
	ClassName string `json:"class_name"`
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
	NotFoundHandling string   `json:"not_found_handling"`
	RunWorkerFirst   []string `json:"run_worker_first,omitempty"`
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

	if len(in.NewSQLiteClasses) > 0 {
		meta.Migrations = &migrations{
			NewTag: migrationTag,
			Steps:  []migrationStep{{NewSQLiteClasses: in.NewSQLiteClasses}},
		}
	}

	if len(in.Assets) > 0 {
		jwt, err := c.uploadAssets(ctx, in.AccountID, in.ScriptName, in.Assets)
		if err != nil {
			return err
		}
		meta.Assets = &assetsMetadata{
			JWT: jwt,
			Config: assetsConfig{
				NotFoundHandling: notFoundHandling,
				RunWorkerFirst:   in.AssetsRunWorkerFirst,
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
		err = c.putScript(ctx, in, meta)
	}
	return err
}

// putScript sends the multipart script upload: the metadata part and the
// module it names.
func (c *Client) putScript(ctx context.Context, in DeployInput, meta scriptMetadata) error {
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
