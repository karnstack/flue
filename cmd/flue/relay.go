package main

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/karnstack/flue/internal/cloudflare"
	"github.com/karnstack/flue/internal/config"
	"github.com/karnstack/flue/internal/daemon"
	relaybundle "github.com/karnstack/flue/relay"
	"github.com/karnstack/flue/web"
)

// The deploy's shape. Every constant here has a twin in relay/wrangler.jsonc,
// which is how the same Worker gets deployed by `wrangler deploy` during
// development — the two must agree or a developer and a user end up running
// different relays. The migration tag lives in internal/cloudflare, for the
// same reason and with the same obligation.
const (
	relayScriptName        = "flue-relay"
	relayCompatibilityDate = "2026-08-01"
	relayDOClass           = "DaemonHub"
	relayDOBinding         = "HUB"
	relayAssetsBinding     = "ASSETS"
)

// relayRunWorkerFirst are the paths the Worker handles itself rather than
// letting the asset router answer from the bundle: the two WebSocket legs and
// the pairing API. The bare entries matter alongside the globs — "/daemon/*"
// alone would let the asset router answer a bare /daemon with the SPA before
// the Worker's "no such machine" could. relay/wrangler.jsonc carries the same
// list for `pnpm dev` and the vitest pool; edit both or neither.
var relayRunWorkerFirst = []string{"/daemon", "/daemon/*", "/client", "/client/*", "/api/*"}

// relayAssetHeaders is the `_headers` document the relay serves its static
// assets with — the same security headers the daemon wraps its own responses in
// (internal/daemon.securityHeaders), so the one origin of the two that is
// reachable from the internet is not the one without them.
//
// `daemon.RelayCSP` rather than the daemon's own policy: the loopback WebSocket
// entries in `connect-src` are wildcard ports and mean nothing on an https
// origin whose socket is same-origin `wss://`. The constant says the rest.
//
// It travels in the script upload's metadata, not as a file among the assets.
// Dropping a `_headers` file into the bundle would publish it at `/_headers`
// and change nothing — see cloudflare.assetsConfig.Headers. Its twin for
// `wrangler dev` is relay/public/_headers, which is a real file because that is
// the only form wrangler reads; TestRelayAssetHeadersMatchTheWranglerCopy keeps
// the two identical.
var relayAssetHeaders = "/*\n" +
	"  Referrer-Policy: no-referrer\n" +
	"  Content-Security-Policy: " + daemon.RelayCSP + "\n"

const (
	// daemonSecretName is the Worker secret the daemon authenticates its
	// outbound leg with (relay/src/index.ts, authorizeDaemon).
	daemonSecretName = "DAEMON_SECRET"
	// daemonSecretBytes is how much entropy that secret carries. It is the only
	// thing standing between the internet and the daemon leg of a relay, and it
	// is machine-generated and machine-stored, so there is no reason to be
	// frugal with it.
	daemonSecretBytes = 32
)

const (
	// relayStepTimeout bounds one ordinary API call. Each step gets its own
	// deadline rather than the whole flow sharing one, because the flow contains
	// a prompt: a clock started before the account question would be counting
	// while the user reads it, and would kill a setup that was doing nothing
	// wrong.
	relayStepTimeout = time.Minute
	// relayDeployTimeout bounds the deploy, which uploads the whole web bundle
	// over whatever link the user has.
	relayDeployTimeout = 10 * time.Minute
)

// accountPromptAttempts is how many times setup will re-ask which account to
// deploy into before giving up. Re-asking is worth it — a typo should not cost
// a re-run — but it must terminate on input that is never going to become a
// number, and EOF alone is not enough of a guarantee to rely on.
const accountPromptAttempts = 3

const relayUsage = "usage: flue relay <setup|status>"

func cmdRelay(args []string) error {
	if len(args) == 0 {
		return errors.New(relayUsage)
	}
	switch args[0] {
	case "setup":
		// A fresh client with no token: runRelaySetup is what puts the pasted
		// one on it, and it goes no further than this process.
		return runRelaySetup(os.Stdout, os.Stdin, &cloudflare.Client{})
	case "status":
		return runRelayStatus(os.Stdout)
	default:
		return fmt.Errorf("unknown relay subcommand %q; %s", args[0], relayUsage)
	}
}

// relayTokenPrompt is what setup says before it asks for a credential. It names
// the exact template to use, because "Edit Cloudflare Workers" is a preset on
// the token page and the alternative is a user hand-picking permissions and
// meeting the gaps one failed step at a time.
const relayTokenPrompt = `flue needs a Cloudflare API token to deploy your relay.
Create one at https://dash.cloudflare.com/profile/api-tokens with the
"Edit Cloudflare Workers" template, then paste it here.
Token: `

// relaySetupDone is the closing note. It says the token is not stored because
// that is the one thing a user cannot check for themselves, and because the
// safest thing they can do next — delete it — is something they will only do if
// they know nothing here depends on it.
const relaySetupDone = `
relay configured. restart the daemon (flue disable && flue enable, or
restart flue serve) to connect. you can delete the API token now — flue
does not store it.
`

// runRelaySetup deploys the relay Worker and the web app into the user's own
// Cloudflare account, then writes the relay.json the daemon dials.
//
// The writer and reader are the seam: tests drive the whole flow against a fake
// API with the token arriving on a pipe, which is the only place the "the token
// is never echoed and never persisted" requirement can be checked end to end.
// api arrives without a token and leaves with one — it is a local value, and
// the token's entire lifetime is this function call.
//
// Note on echo: the token is read from stdin without switching the terminal out
// of canonical mode, so a pasted token is visible in the user's own scrollback
// the way any pasted line is. Suppressing that needs a termios dance (or
// golang.org/x/term, a dependency flue does not carry) and would buy little:
// the exposure is the user's own screen, which they can clear, and the token
// they were told to delete afterwards anyway. What this function guarantees is
// narrower and more useful: flue itself never writes it — not to the transcript,
// not into an error, not to any file.
func runRelaySetup(w io.Writer, r io.Reader, api *cloudflare.Client) error {
	// Both of these are checked before a credential is asked for. A binary that
	// cannot deploy anything must not be the reason a user pastes an API token
	// into a terminal.
	module := relaybundle.Module()
	if len(module) == 0 {
		return errors.New("this build carries no relay worker; build a release binary with `make build` (a dev build leaves it out)")
	}
	assets, err := webAssets()
	if err != nil {
		return err
	}

	in := bufio.NewReader(r)
	token, err := readAPIToken(w, in)
	if err != nil {
		return err
	}
	api.Token = token

	if err := withTimeout(relayStepTimeout, api.VerifyToken); err != nil {
		return err
	}
	fmt.Fprintln(w, "  ✓ token verified")

	var accounts []cloudflare.Account
	if err := withTimeout(relayStepTimeout, func(ctx context.Context) error {
		var err error
		accounts, err = api.Accounts(ctx)
		return err
	}); err != nil {
		return fmt.Errorf("list the Cloudflare accounts this token can reach: %w", err)
	}
	account, err := pickAccount(w, in, accounts)
	if err != nil {
		return err
	}
	fmt.Fprintf(w, "  ✓ account: %s (%s)\n", account.Name, shortID(account.ID))

	if err := withTimeout(relayDeployTimeout, func(ctx context.Context) error {
		return api.Deploy(ctx, cloudflare.DeployInput{
			AccountID:         account.ID,
			ScriptName:        relayScriptName,
			Module:            module,
			CompatibilityDate: relayCompatibilityDate,
			// Sent on every run, including re-runs of an account that already
			// has the class. Cloudflare refuses a migration it has already
			// applied and the client recovers from exactly that (see Deploy);
			// the alternative — asking the account what it has already migrated
			// — is a request that can only tell us something we can handle
			// without asking.
			NewSQLiteClasses:     []string{relayDOClass},
			DOBindings:           map[string]string{relayDOBinding: relayDOClass},
			Assets:               assets,
			AssetsRunWorkerFirst: relayRunWorkerFirst,
			// Without this the relay serves the same bundle the daemon does,
			// from the internet, with none of the daemon's security headers —
			// including the `script-src 'self'` that web/src/crypto/keys.ts
			// names as the reason it is willing to keep a raw private key in
			// IndexedDB.
			AssetHeaders: relayAssetHeaders,
			// Not optional, and its absence is invisible until the Worker is
			// live: the relay calls env.ASSETS.fetch itself for everything that
			// is not one of the run-worker-first paths, and without this binding
			// that call is on undefined.
			AssetsBinding: relayAssetsBinding,
			// A self-hosted relay has no operator but its user; Workers Logs is
			// the only way they will ever see why it did something.
			Observability: true,
		})
	}); err != nil {
		return fmt.Errorf("deploy the relay worker: %w", err)
	}
	fmt.Fprintf(w, "  ✓ worker deployed: %s\n", relayScriptName)
	fmt.Fprintf(w, "  ✓ web app uploaded (%d files)\n", len(assets))

	// Before the secret, deliberately. Setting the secret is the step that
	// changes what credential the deployed Worker accepts, and from that moment
	// until relay.json is written the two can disagree — a daemon presenting the
	// old secret to a Worker that now wants the new one gets 401s with nothing
	// to say why. Every remote call that can fail is therefore moved in front of
	// it, so the only thing left after the secret is set is a local file write.
	var host string
	if err := withTimeout(relayStepTimeout, func(ctx context.Context) error {
		var err error
		host, err = api.EnableSubdomain(ctx, account.ID, relayScriptName)
		return err
	}); err != nil {
		return fmt.Errorf("make the relay reachable on workers.dev: %w", err)
	}
	origin := "https://" + host
	fmt.Fprintf(w, "  ✓ reachable at %s\n", origin)

	// Fresh on every run, never reused from an existing relay.json. Setup is
	// also the recovery path for a leaked or half-configured relay, and one that
	// preserved the old secret would be unable to rotate the one credential the
	// relay has.
	secret, err := newDaemonSecret()
	if err != nil {
		return fmt.Errorf("generate the relay secret: %w", err)
	}
	if err := withTimeout(relayStepTimeout, func(ctx context.Context) error {
		return api.SetSecret(ctx, account.ID, relayScriptName, daemonSecretName, secret)
	}); err != nil {
		return fmt.Errorf("set %s on the relay worker: %w", daemonSecretName, err)
	}
	fmt.Fprintln(w, "  ✓ secret set")

	// Last, deliberately. relay.json is what makes the daemon dial, and every
	// step above can fail; writing it earlier would leave a daemon dialling a
	// relay that was never finished. Re-running setup is the fix for anything
	// that failed before this line, and it is safe: the deploy and the secret
	// are both upserts, and the deploy keeps the secret already bound to the
	// Worker (see keptBindingTypes in internal/cloudflare), so a run that dies
	// part-way leaves an existing relay working rather than credential-less.
	if err := config.SaveRelay(config.Relay{
		URL:    "wss://" + host + "/daemon",
		Secret: secret,
		Origin: origin,
	}); err != nil {
		return fmt.Errorf("save the relay configuration: %w", err)
	}

	fmt.Fprint(w, relaySetupDone)
	return nil
}

// runRelayStatus prints what is configured, which is the same line flue status
// carries — one answer, one place it is decided.
func runRelayStatus(w io.Writer) error {
	fmt.Fprintln(w, relayLine())
	return nil
}

// readAPIToken prompts for and reads the Cloudflare API token.
//
// EOF with content is not an error: a token piped in without a trailing newline
// arrives that way, and refusing it would break every non-interactive use of
// this command for no benefit.
func readAPIToken(w io.Writer, r *bufio.Reader) (string, error) {
	fmt.Fprint(w, relayTokenPrompt)
	line, err := r.ReadString('\n')
	if err != nil && !errors.Is(err, io.EOF) {
		return "", fmt.Errorf("read the API token: %w", err)
	}
	token := strings.TrimSpace(line)
	if token == "" {
		return "", errors.New("no API token was given; nothing was deployed")
	}
	return token, nil
}

// pickAccount decides which account the relay goes into: silently when the
// token can reach exactly one, and by asking otherwise.
//
// It never guesses between several. Deploying a Worker into the wrong account
// is not a mistake this command can undo, and "the first one" is a rule whose
// answer depends on the order Cloudflare happened to list them in.
func pickAccount(w io.Writer, r *bufio.Reader, accounts []cloudflare.Account) (cloudflare.Account, error) {
	switch len(accounts) {
	case 0:
		return cloudflare.Account{}, errors.New("this API token cannot reach any Cloudflare account; check that it was created with the \"Edit Cloudflare Workers\" template on an account you own")
	case 1:
		return accounts[0], nil
	}

	fmt.Fprintln(w, "\nThis token reaches more than one account. Which should the relay live in?")
	for i, a := range accounts {
		fmt.Fprintf(w, "  %d) %s (%s)\n", i+1, a.Name, shortID(a.ID))
	}
	for attempt := 0; attempt < accountPromptAttempts; attempt++ {
		fmt.Fprintf(w, "Account [1-%d]: ", len(accounts))
		line, readErr := r.ReadString('\n')
		if choice, err := strconv.Atoi(strings.TrimSpace(line)); err == nil && choice >= 1 && choice <= len(accounts) {
			return accounts[choice-1], nil
		}
		if readErr != nil {
			// The input is exhausted, so there is nothing left to re-ask into.
			break
		}
		fmt.Fprintln(w, "  that is not one of the numbers above")
	}
	return cloudflare.Account{}, fmt.Errorf("no account was chosen; run flue relay setup again and answer with a number between 1 and %d", len(accounts))
}

// shortID abbreviates an account id for display. The full one is 32 hex
// characters that say nothing to the person reading them; enough to tell two
// accounts apart is all this line is for.
func shortID(id string) string {
	const keep = 6
	if len(id) <= keep {
		return id
	}
	return id[:keep] + "…"
}

// webAssets turns the embedded web app into the asset list the deploy uploads.
// Paths are rooted at "/" because that is what they will be served at, and what
// the upload session requires.
func webAssets() ([]cloudflare.Asset, error) {
	dist, err := web.Dist()
	if err != nil {
		return nil, err
	}
	var assets []cloudflare.Asset
	err = fs.WalkDir(dist, ".", func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			return nil
		}
		// `_headers` and `_redirects` are configuration, not content:
		// Cloudflare's asset router reads them out of the script metadata
		// (relayAssetHeaders) and never from the bundle, so one that reached the
		// upload would be published at its own URL and applied to nothing.
		// Nothing in web/dist emits either today; this is here so that a
		// well-meant web/public/_headers cannot quietly become a public
		// document that also fails to do its job.
		if p == "_headers" || p == "_redirects" {
			return nil
		}
		body, err := fs.ReadFile(dist, p)
		if err != nil {
			return err
		}
		assets = append(assets, cloudflare.Asset{Path: "/" + p, Body: body})
		return nil
	})
	if err != nil {
		return nil, fmt.Errorf("read the embedded web app: %w", err)
	}
	if len(assets) == 0 {
		return nil, errors.New("the embedded web app is empty; rebuild with `make build`")
	}
	return assets, nil
}

// newDaemonSecret mints the credential the daemon presents on its outbound leg.
// base64url with no padding, so it can go into an Authorization header — which
// is exactly where the daemon puts it — without any escaping question.
func newDaemonSecret() (string, error) {
	var raw [daemonSecretBytes]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(raw[:]), nil
}

// withTimeout runs one API step under a deadline of its own.
func withTimeout(d time.Duration, fn func(context.Context) error) error {
	ctx, cancel := context.WithTimeout(context.Background(), d)
	defer cancel()
	return fn(ctx)
}
