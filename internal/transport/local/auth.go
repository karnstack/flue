// Package local implements the loopback transport: a listener bound to
// 127.0.0.1 and authenticated by a token file, an Origin allowlist, and a
// Host check.
//
// # How a credential reaches the browser
//
// The session token — the contents of $XDG_CONFIG_HOME/flue/token — is the
// permanent credential, and it is never put in a URL. A URL is argv the moment
// it is handed to open(1) or xdg-open(1), and argv is readable by any local
// user at Linux's default hidepid=0 and by ps(1) on macOS. So flue open asks
// the daemon to Mint a one-time handoff token, puts *that* in the URL, and the
// first load exchanges it here for the HttpOnly session cookie. The handoff
// token is single-use, expires in HandoffTTL, and buys nothing on a second
// presentation.
//
// Three credential carriers, three different meanings:
//
//   - The flue_token cookie authenticates the browser after the exchange. It is
//     attached automatically, which is exactly why it must not be sufficient
//     for anything privileged: SameSite is blind to the port, so a co-resident
//     untrusted origin on another loopback port can cause the victim's browser
//     to send it.
//   - The X-Flue-Token header authenticates a non-browser local client — the
//     flue CLI — that can read the token file. A browser cannot be induced to
//     send it cross-origin without a CORS preflight, and the daemon answers
//     every OPTIONS with 405, so the preflight can never succeed.
//   - The handoff query parameter authenticates exactly one first-load
//     navigation and is then gone.
package local

import (
	"crypto/subtle"
	"errors"
	"fmt"
	"net/http"
	"sync"
	"time"
)

// CookieName is where the session token lives after the first load, so it
// never stays in the URL where history and referrers would leak it.
const CookieName = "flue_token"

// HeaderName is the request header a non-browser local client presents the
// session token in. It is the only way to authenticate a mint, and one of two
// ways (with the cookie) to authenticate an ordinary request.
const HeaderName = "X-Flue-Token"

var (
	ErrNoToken      = errors.New("local: missing or invalid token")
	ErrBadOrigin    = errors.New("local: origin not allowed")
	ErrBadHost      = errors.New("local: host not allowed")
	ErrBadFetchSite = errors.New("local: fetch metadata not allowed")

	// ErrBadHandoff is deliberately indistinguishable between "never existed",
	// "expired" and "already spent": all three mean the same thing to the
	// caller — run flue open again — and telling them apart would confirm to
	// whoever presented it that a token they guessed or found had once been
	// real.
	ErrBadHandoff = errors.New("local: handoff token is invalid, expired, or already used — run flue open again")

	// ErrNotLocalClient rejects a mint attempt from anything that looks like a
	// browser. Only a local process that can read the token file may mint.
	ErrNotLocalClient = errors.New("local: minting is not available to browsers")
)

// Auth enforces loopback authentication. All three checks are required:
// a valid token, an allowed Origin, and an allowed Host. The Host check
// defends against DNS rebinding, where a name the attacker controls
// resolves to 127.0.0.1.
//
// It also owns the handoff token store; see handoff.go.
type Auth struct {
	token   string
	hosts   map[string]struct{}
	origins map[string]struct{}

	now func() time.Time

	mu       sync.Mutex
	handoffs []handoff
}

func NewAuth(token string, port int) *Auth {
	return NewAuthWithClock(token, port, time.Now)
}

// NewAuthWithClock is NewAuth with the clock the handoff TTL is measured
// against supplied explicitly. It exists so a test can drive expiry without
// sleeping; production code calls NewAuth.
func NewAuthWithClock(token string, port int, now func() time.Time) *Auth {
	h1 := fmt.Sprintf("127.0.0.1:%d", port)
	h2 := fmt.Sprintf("localhost:%d", port)
	if now == nil {
		now = time.Now
	}
	return &Auth{
		token: token,
		hosts: map[string]struct{}{h1: {}, h2: {}},
		origins: map[string]struct{}{
			"http://" + h1: {},
			"http://" + h2: {},
		},
		now: now,
	}
}

// Check reports whether r is authenticated.
//
// It never redeems a handoff token. This is the path handleWS takes, and a
// handoff token must not be able to authenticate a WebSocket upgrade — the one
// GET that leads to every state change flue has. A handoff token buys the
// session cookie through Middleware and nothing else.
func (a *Auth) Check(r *http.Request) error {
	if err := a.checkProvenance(r); err != nil {
		return err
	}
	if !a.validToken(r) {
		return ErrNoToken
	}
	return nil
}

// checkProvenance runs every check that is about where the request came from,
// as opposed to what credential it carries: Host, Origin and fetch metadata.
//
// It is separate from the token check because the handoff exchange has to run
// between the two. A request whose provenance is wrong must be refused before
// the handoff store is touched: not only must it not be issued a cookie, it
// must not be able to *burn* a live handoff token, which would be a free denial
// of service on the legitimate flue open from any page that can guess the URL
// shape.
func (a *Auth) checkProvenance(r *http.Request) error {
	// An absolute-form request target ("GET http://x/y HTTP/1.1", used by
	// proxies) is parsed by net/http with r.Host set from the request
	// line; the two fields only diverge if that invariant is ever broken
	// between the socket and here. Don't depend on net/http always
	// getting that right — reject any divergence outright.
	if r.URL.Host != "" && r.URL.Host != r.Host {
		return ErrBadHost
	}
	if _, ok := a.hosts[r.Host]; !ok {
		return ErrBadHost
	}

	// A missing Origin is allowed: non-browser clients (curl, the flue CLI)
	// do not send one, and only browsers can be induced into cross-origin
	// requests. A present-but-unlisted Origin is always rejected.
	// http.Header.Get silently returns only the first value of a repeated
	// header, so a second, smuggled Origin must be rejected outright
	// rather than left unexamined behind an allowed first one.
	if len(r.Header.Values("Origin")) > 1 {
		return ErrBadOrigin
	}
	if origin := r.Header.Get("Origin"); origin != "" {
		if _, ok := a.origins[origin]; !ok {
			return ErrBadOrigin
		}
	}

	// Origin alone isn't enough: SameSite=Strict scopes "site" to
	// scheme+host, not scheme+host+port, so a page on another loopback
	// port (an unrelated dev server at 127.0.0.1:3000, say) is same-site
	// with this daemon. Its plain, Origin-less GETs — an <img> tag, a
	// top-level navigation — still carry the flue_token cookie, because
	// SameSite doesn't see the port difference. Sec-Fetch-Site does: a
	// browser sends "same-site" (not "same-origin") for exactly that
	// request shape, and "cross-site" for a request from an unrelated
	// site. Every modern browser sends this header on every request;
	// curl and net/http clients never do, so its absence is treated the
	// same as a missing Origin — not evidence of an attack, just evidence
	// of a non-browser client.
	if sfs := r.Header.Get("Sec-Fetch-Site"); sfs != "" && sfs != "same-origin" && sfs != "none" {
		return ErrBadFetchSite
	}
	return nil
}

// validToken reports whether r carries the session token.
//
// The query string is not consulted, by design and permanently. Accepting the
// session token from a URL is what put it in the browser opener's argv; there
// is no parameter name under which it may come back.
func (a *Auth) validToken(r *http.Request) bool {
	// Repeated headers are refused rather than read through Header.Get, which
	// would silently examine only the first.
	if len(r.Header.Values(HeaderName)) > 1 {
		return false
	}
	if constantEqual(r.Header.Get(HeaderName), a.token) {
		return true
	}
	if c, err := r.Cookie(CookieName); err == nil && constantEqual(c.Value, a.token) {
		return true
	}
	return false
}

// CheckMint reports whether r may mint a handoff token.
//
// Minting converts "I can read the token file" into "here is a fresh
// credential", so the set of principals allowed to do it must be exactly the
// set that can read $XDG_CONFIG_HOME/flue/token — mode 0600 in a 0700
// directory. Two rules get there:
//
//   - The session token must arrive in HeaderName. Not the cookie, which the
//     browser attaches by itself and which a co-resident untrusted origin can
//     therefore cause the victim's browser to send; and not the query string,
//     which is the exposure this whole mechanism exists to remove. A browser
//     cannot send a custom header cross-origin without a CORS preflight, and
//     the daemon answers every OPTIONS with 405.
//
//   - The request must carry no Sec-Fetch-Site header at all, with any value —
//     including "none", the one value a redirect can launder. Every modern
//     browser sends that header on every request and the flue CLI never does,
//     so requiring its absence states the actual policy (only a non-browser
//     local process may mint) rather than enumerating browser cases to block.
//     A local process can forge its absence, but a local process that can forge
//     it still needs the session token, which is the thing being protected.
func (a *Auth) CheckMint(r *http.Request) error {
	if err := a.checkProvenance(r); err != nil {
		return err
	}
	if len(r.Header.Values("Sec-Fetch-Site")) > 0 {
		return ErrNotLocalClient
	}
	vals := r.Header.Values(HeaderName)
	if len(vals) != 1 || !constantEqual(vals[0], a.token) {
		return ErrNoToken
	}
	return nil
}

// constantEqual reports whether got matches the configured secret want, in
// time independent of got's content. An empty want never matches: with a
// zero-length token, ConstantTimeCompare would treat two empty strings as
// equal, so a request with no token at all (no cookie, no header) would pass.
// want should never be empty in practice — LoadOrCreateToken never persists or
// returns an empty token — but Check must not rely on that; it has to fail
// closed on its own.
func constantEqual(got, want string) bool {
	if want == "" {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(got), []byte(want)) == 1
}

// Middleware enforces the request checks, exchanges a one-time handoff token
// for the session cookie, and sets the response headers every flue response
// needs.
//
// The order is load-bearing:
//
//  1. Provenance first, so a request from a disallowed Host, Origin or fetch
//     site can neither be issued a cookie nor spend a handoff token.
//  2. Then the handoff exchange, because a first load has no cookie yet and
//     would fail the token check it has not reached.
//  3. Then the ordinary token check.
//
// There is no fallback in either direction. A handoff token that is unknown,
// expired or already spent fails the request outright — it does not fall
// through to the cookie, and it certainly does not fall back to accepting a
// session token from the URL, which would put the exposure straight back where
// it started. Failing loudly also makes "a second presentation fails" a
// property of this endpoint rather than a property of the client's cookie jar.
func (a *Auth) Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Referrer-Policy", "no-referrer")

		if err := a.checkProvenance(r); err != nil {
			http.Error(w, err.Error(), http.StatusForbidden)
			return
		}

		if h := r.URL.Query().Get(HandoffParam); h != "" {
			if !a.Redeem(h) {
				http.Error(w, ErrBadHandoff.Error(), http.StatusUnauthorized)
				return
			}
			// Never stored, by anything. This is the only response flue ever
			// sends that carries the permanent session token in a Set-Cookie,
			// and it is also precisely the response the service worker is
			// instructed to keep: GET /?h=… is a navigation, so web/src/sw.ts
			// routes it to its network-first strategy and, being an ok, basic,
			// text/html answer, writes it into CacheStorage as the app shell.
			// Only the very first load of all escapes that, since no worker is
			// registered yet; every flue open afterwards is intercepted.
			//
			// Whether a stored response replays its Set-Cookie is browser
			// behaviour — the same open question for CacheStorage and for the
			// ordinary HTTP cache — and this is not a thing to hold an opinion
			// about when one header settles both. Matches handleMint.
			w.Header().Set("Cache-Control", "no-store")
			// Move the session token into an HttpOnly cookie so it stops
			// appearing in the URL; the client then strips the spent handoff
			// parameter from the URL with replaceState.
			http.SetCookie(w, &http.Cookie{
				Name:     CookieName,
				Value:    a.token,
				Path:     "/",
				HttpOnly: true,
				SameSite: http.SameSiteStrictMode,
			})
			next.ServeHTTP(w, r)
			return
		}

		if !a.validToken(r) {
			http.Error(w, ErrNoToken.Error(), http.StatusUnauthorized)
			return
		}
		next.ServeHTTP(w, r)
	})
}
