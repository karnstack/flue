// Package relaydeploy is the one implementation of "put flue's relay into a
// Cloudflare account": the Worker module, the web bundle, the Durable Object
// migration, the secret, the workers.dev host. Two callers share it — `flue
// relay setup`/`update` in cmd/flue, and the daemon's /api/relay endpoints
// behind the Remote screen — and sharing is the point: a UI deploy and a CLI
// deploy that drifted apart would leave users running different relays
// depending on which button they pressed.
//
// The package deliberately does not read config, prompt, or print. Callers
// own the token's arrival, the account choice, relay.json and every word
// shown to a human; what lives here is only the Cloudflare choreography and
// the constants that define the deploy's shape. Those constants have twins in
// relay/wrangler.jsonc, which is how the same Worker runs under `pnpm dev`
// and the vitest pool — the two must agree or a developer and a user end up
// running different relays.
package relaydeploy

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"time"

	"github.com/karnstack/flue/internal/cloudflare"
)

const (
	// DefaultWorker is the script name `flue relay setup` deploys under when
	// --worker says nothing else. The script name is the unit of separation
	// between relays in one account: a dev relay under another name has its
	// own hostname, secret and hubs, and cannot touch this one.
	DefaultWorker     = "flue-relay"
	CompatibilityDate = "2026-08-01"
	DOClass           = "DaemonHub"
	DOBinding         = "HUB"
	AssetsBinding     = "ASSETS"

	// SecretName is the Worker secret the daemon authenticates its outbound
	// leg with (relay/src/index.ts, authorizeDaemon).
	SecretName = "DAEMON_SECRET"
	// secretBytes is how much entropy that secret carries. It is the only
	// thing standing between the internet and the daemon leg of a relay, and
	// it is machine-generated and machine-stored, so there is no reason to be
	// frugal with it.
	secretBytes = 32

	// VersionVar is the plain-text binding the deploy stamps the deploying
	// flue's version into. The Worker reports it on /api/health, which is what
	// lets a daemon (and the Remote screen's "update relay" state) see that a
	// deployed relay is older than the binary looking at it.
	VersionVar = "FLUE_VERSION"

	// RateLimitBinding is the Cloudflare rate-limiting binding the Worker
	// checks on its credential-less routes (/client/*, POST /api/pair/*),
	// keyed by connecting IP (relay/src/index.ts, allowRate). The numbers are
	// the spec's "order of 100/min per IP" (spec/fleet-trust.md, "Rate
	// rule"): 300 requests per 60 s per IP per Cloudflare location is far
	// past a fleet of tabs — even a whole office reconnecting through one NAT
	// — while a quota-burning flood, or the 2^32 id-tag guessing walk, needs
	// a botnet's worth of addresses to get anywhere. All three values have
	// twins in relay/wrangler.jsonc (`ratelimits`); edit both or neither.
	RateLimitBinding     = "CLIENT_RATE"
	rateLimitNamespaceID = "1001"
	rateLimitRequests    = 300
	rateLimitPeriodSecs  = 60

	// StepTimeout bounds one ordinary API call; DeployTimeout bounds the
	// deploy itself, which uploads the whole web bundle over whatever link the
	// user has. Each step gets its own deadline rather than the whole flow
	// sharing one, because callers put prompts between steps: a clock started
	// before an account question would be counting while the user reads it.
	StepTimeout   = time.Minute
	DeployTimeout = 10 * time.Minute
)

// ValidWorkerName refuses a name that cannot be a Cloudflare script name
// reachable on workers.dev: the script name becomes the hostname's first
// label, so the grammar is lowercase letters, digits and inner dashes, at
// most 63 characters. Callers wrap the error with where the name came from
// (a --worker flag, a form field).
func ValidWorkerName(name string) error {
	if name == "" || len(name) > 63 {
		return fmt.Errorf("a worker name is 1 to 63 characters, got %d", len(name))
	}
	for i, c := range name {
		ok := c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || c == '-' && i > 0 && i < len(name)-1
		if !ok {
			return fmt.Errorf("a worker name is lowercase letters, digits and inner dashes, because it becomes the first label of the workers.dev hostname; %q is not", name)
		}
	}
	return nil
}

// RunWorkerFirst are the paths the Worker handles itself rather than letting
// the asset router answer from the bundle: the two WebSocket legs and the
// pairing API. The bare entries matter alongside the globs — "/daemon/*"
// alone would let the asset router answer a bare /daemon with the SPA before
// the Worker's "no such machine" could.
var RunWorkerFirst = []string{"/daemon", "/daemon/*", "/client", "/client/*", "/api/*"}

// Input is one deploy's worth of decisions, all made by the caller.
type Input struct {
	// API carries the user's token. It is used for the calls below and goes
	// no further; nothing in this package stores or logs it.
	API       *cloudflare.Client
	AccountID string
	Worker    string

	// Module and Assets are the embedded relay Worker and web bundle. Callers
	// check them before asking a human for a credential — a dev build carries
	// neither, and that refusal belongs before the token prompt.
	Module []byte
	Assets []cloudflare.Asset
	// AssetHeaders is the `_headers` document the relay serves its assets
	// with. It is an input, not a constant here, because its content names
	// the daemon package's CSP and this package must not import the daemon.
	AssetHeaders string

	// Version is stamped into the Worker as VersionVar. "dev" is an honest
	// value for a from-source build.
	Version string

	// OnStep, when set, hears one line per completed step — "worker deployed:
	// x" — in the order they happen. Callers own the formatting.
	OnStep func(line string)
}

func (in Input) step(format string, args ...any) {
	if in.OnStep != nil {
		in.OnStep(fmt.Sprintf(format, args...))
	}
}

func withTimeout(d time.Duration, fn func(context.Context) error) error {
	ctx, cancel := context.WithTimeout(context.Background(), d)
	defer cancel()
	return fn(ctx)
}

// Deploy uploads the Worker and the web bundle, and changes nothing else: no
// secret is minted or bound (the script upload preserves the existing
// secret_text binding — keptBindingTypes in internal/cloudflare), and no
// subdomain is touched. It is the whole of `flue relay update`, and the first
// half of Provision.
func Deploy(in Input) error {
	if len(in.Module) == 0 {
		return errors.New("this build carries no relay worker; build a release binary with `make build` (a dev build leaves it out)")
	}
	if err := withTimeout(DeployTimeout, func(ctx context.Context) error {
		return in.API.Deploy(ctx, cloudflare.DeployInput{
			AccountID:         in.AccountID,
			ScriptName:        in.Worker,
			Module:            in.Module,
			CompatibilityDate: CompatibilityDate,
			// Sent on every run, including re-runs of an account that already
			// has the class. Cloudflare refuses a migration it has already
			// applied and the client recovers from exactly that (see Deploy);
			// the alternative — asking the account what it has already
			// migrated — is a request that can only tell us something we can
			// handle without asking.
			NewSQLiteClasses:     []string{DOClass},
			DOBindings:           map[string]string{DOBinding: DOClass},
			Assets:               in.Assets,
			AssetsRunWorkerFirst: RunWorkerFirst,
			// Without this the relay serves the same bundle the daemon does,
			// from the internet, with none of the daemon's security headers —
			// including the `script-src 'self'` that web/src/crypto/keys.ts
			// names as the reason it is willing to keep a raw private key in
			// IndexedDB.
			AssetHeaders: in.AssetHeaders,
			// Not optional, and its absence is invisible until the Worker is
			// live: the relay calls env.ASSETS.fetch itself for everything
			// that is not one of the run-worker-first paths, and without this
			// binding that call is on undefined.
			AssetsBinding: AssetsBinding,
			PlainTextVars: map[string]string{VersionVar: in.Version},
			// The Worker reads this binding optionally (fail-open), so a
			// deploy from an older flue that never sent it leaves a working
			// relay — just one without the per-IP bound this one carries.
			RateLimits: []cloudflare.RateLimit{{
				Name:        RateLimitBinding,
				NamespaceID: rateLimitNamespaceID,
				Limit:       rateLimitRequests,
				Period:      rateLimitPeriodSecs,
			}},
			// A self-hosted relay has no operator but its user; Workers Logs
			// is the only way they will ever see why it did something.
			Observability: true,
		})
	}); err != nil {
		return fmt.Errorf("deploy the relay worker: %w", err)
	}
	in.step("worker deployed: %s", in.Worker)
	in.step("web app uploaded (%d files)", len(in.Assets))
	return nil
}

// Provision is a first deploy: Deploy, then the workers.dev host, then a
// fresh secret bound to the Worker. It returns the host the relay answers on
// and the secret the fleet shares — the caller writes relay.json and prints
// the join line, because both of those are its business, not Cloudflare's.
//
// The secret is fresh on every call, never reused: Provision is also the
// recovery path for a leaked or half-configured relay, and one that preserved
// the old secret would be unable to rotate the one credential the relay has.
func Provision(in Input) (host, secret string, err error) {
	if err := Deploy(in); err != nil {
		return "", "", err
	}

	if err := withTimeout(StepTimeout, func(ctx context.Context) error {
		var err error
		host, err = in.API.EnableSubdomain(ctx, in.AccountID, in.Worker)
		return err
	}); err != nil {
		return "", "", fmt.Errorf("make the relay reachable on workers.dev: %w", err)
	}
	in.step("reachable at https://%s", host)

	secret, err = newDaemonSecret()
	if err != nil {
		return "", "", fmt.Errorf("generate the relay secret: %w", err)
	}
	if err := withTimeout(StepTimeout, func(ctx context.Context) error {
		return in.API.SetSecret(ctx, in.AccountID, in.Worker, SecretName, secret)
	}); err != nil {
		return "", "", fmt.Errorf("set %s on the relay worker: %w", SecretName, err)
	}
	in.step("secret set")

	return host, secret, nil
}

// newDaemonSecret mints the credential the daemon presents on its outbound
// leg. base64url with no padding, so it can go into an Authorization header —
// which is exactly where the daemon puts it — without any escaping question.
func newDaemonSecret() (string, error) {
	var raw [secretBytes]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(raw[:]), nil
}
