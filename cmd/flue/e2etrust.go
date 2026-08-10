//go:build e2e

package main

// e2etrust.go exists for exactly one build, `go build -tags e2e`, and exactly
// one caller: the end-to-end harness in web/e2e, which runs the real relay
// Worker under `wrangler dev` on 127.0.0.1 with a certificate it minted a
// second earlier.
//
// # Why this file has to exist at all
//
// `flue relay join` refuses anything but wss:// or https:// (relayHost), and
// that refusal is deliberate — the daemon secret rides an Authorization header
// on every dial, so a ws:// affordance "just for localhost" would be a
// downgrade path in the one place that must not have one. The harness
// therefore serves the local relay over real TLS, and the daemon then has to
// be willing to verify a certificate no public CA signed.
//
// SSL_CERT_FILE would be the obvious answer and is not available: crypto/x509
// honours it on every unix except darwin (root_unix.go's build constraint
// excludes darwin, and root_darwin.go verifies through Security.framework),
// and darwin is where this repo is developed. The alternative — adding the
// harness's CA to the login keychain — needs an interactive password on macOS
// and would leave state behind on a developer's machine after a test run.
//
// # Why it is safe
//
// It is not in the shipped binary. `.goreleaser.yaml` sets no build tags, so
// every released flue is compiled without this file and behaves exactly as it
// does today; `make build`, `go test ./...` and `go vet ./...` are untagged
// too. The only way to get this code is to ask for it by name.
//
// And it only ever *adds* a root. FLUE_E2E_CA unset leaves the process
// untouched, an unreadable or unparseable file is fatal rather than silently
// permissive, and nothing here turns verification off: a daemon built this way
// still refuses a certificate it cannot chain to something, which is what keeps
// the harness honest about the handshake it is exercising.

import (
	"crypto/tls"
	"crypto/x509"
	"fmt"
	"net/http"
	"os"
)

// e2eCAEnv names a PEM file of extra roots to trust for outbound TLS.
const e2eCAEnv = "FLUE_E2E_CA"

func init() {
	path := os.Getenv(e2eCAEnv)
	if path == "" {
		return
	}
	pem, err := os.ReadFile(path)
	if err != nil {
		fatal(fmt.Errorf("%s: %w", e2eCAEnv, err))
	}
	// The system roots, plus ours. Starting from the system pool rather than an
	// empty one keeps a tagged binary able to reach the internet — `flue relay
	// setup` and the release check both do — so the tag changes what is
	// additionally trusted and nothing else.
	pool, err := x509.SystemCertPool()
	if err != nil {
		pool = x509.NewCertPool()
	}
	if !pool.AppendCertsFromPEM(pem) {
		fatal(fmt.Errorf("%s: %s holds no PEM certificate", e2eCAEnv, path))
	}
	// The daemon's every outbound leg — the relay socket, the directory socket,
	// the directory's GET and PUT, `flue relay status` — goes through a client
	// with a nil Transport or through noRedirects, which is another one. All of
	// them land on http.DefaultTransport, so this is the single seam.
	//
	// Only RootCAs is set: ForceAttemptHTTP2 stays as the default transport has
	// it, so ALPN negotiates exactly what it negotiates in production and the
	// harness cannot pass because it quietly took a different protocol.
	tr, ok := http.DefaultTransport.(*http.Transport)
	if !ok {
		fatal(fmt.Errorf("%s: http.DefaultTransport is not an *http.Transport", e2eCAEnv))
	}
	tr.TLSClientConfig = &tls.Config{RootCAs: pool}
}

// fatal ends the process rather than returning an error, because this runs in
// init() where there is no caller to hand one to — and because a harness whose
// CA did not load would otherwise watch every dial fail with a certificate
// error and go looking for the fault in the relay.
func fatal(err error) {
	fmt.Fprintln(os.Stderr, "flue:", err)
	os.Exit(1)
}
