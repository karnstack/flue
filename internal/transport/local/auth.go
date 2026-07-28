// Package local implements the loopback transport: a listener bound to
// 127.0.0.1 and authenticated by a token file, an Origin allowlist, and a
// Host check.
package local

import (
	"crypto/subtle"
	"errors"
	"fmt"
	"net/http"
)

// CookieName is where the token lives after the first request, so it never
// stays in the URL where history and referrers would leak it.
const CookieName = "flue_token"

var (
	ErrNoToken      = errors.New("local: missing or invalid token")
	ErrBadOrigin    = errors.New("local: origin not allowed")
	ErrBadHost      = errors.New("local: host not allowed")
	ErrBadFetchSite = errors.New("local: fetch metadata not allowed")
)

// Auth enforces loopback authentication. All three checks are required:
// a valid token, an allowed Origin, and an allowed Host. The Host check
// defends against DNS rebinding, where a name the attacker controls
// resolves to 127.0.0.1.
type Auth struct {
	token   string
	hosts   map[string]struct{}
	origins map[string]struct{}
}

func NewAuth(token string, port int) *Auth {
	h1 := fmt.Sprintf("127.0.0.1:%d", port)
	h2 := fmt.Sprintf("localhost:%d", port)
	return &Auth{
		token: token,
		hosts: map[string]struct{}{h1: {}, h2: {}},
		origins: map[string]struct{}{
			"http://" + h1: {},
			"http://" + h2: {},
		},
	}
}

// Check reports whether r is authenticated.
func (a *Auth) Check(r *http.Request) error {
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

	if !a.validToken(r) {
		return ErrNoToken
	}
	return nil
}

func (a *Auth) validToken(r *http.Request) bool {
	if c, err := r.Cookie(CookieName); err == nil && constantEqual(c.Value, a.token) {
		return true
	}
	return constantEqual(r.URL.Query().Get("t"), a.token)
}

// constantEqual reports whether got matches the configured secret want, in
// time independent of got's content. An empty want never matches: with a
// zero-length token, ConstantTimeCompare would treat two empty strings as
// equal, so a request with no token at all (no cookie, no "t" query param)
// would pass. want should never be empty in practice — LoadOrCreateToken
// never persists or returns an empty token — but Check must not rely on
// that; it has to fail closed on its own.
func constantEqual(got, want string) bool {
	if want == "" {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(got), []byte(want)) == 1
}

// Middleware enforces Check, exchanges a URL token for a cookie, and sets
// the response headers every flue response needs.
func (a *Auth) Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Referrer-Policy", "no-referrer")

		if err := a.Check(r); err != nil {
			status := http.StatusForbidden
			if errors.Is(err, ErrNoToken) {
				status = http.StatusUnauthorized
			}
			http.Error(w, err.Error(), status)
			return
		}

		// First load carries the token in the URL. Move it into an
		// HttpOnly cookie so it stops appearing in history and referrers;
		// the client then strips it from the URL with replaceState.
		if r.URL.Query().Get("t") != "" {
			http.SetCookie(w, &http.Cookie{
				Name:     CookieName,
				Value:    a.token,
				Path:     "/",
				HttpOnly: true,
				SameSite: http.SameSiteStrictMode,
			})
		}

		next.ServeHTTP(w, r)
	})
}
