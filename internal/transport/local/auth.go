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
	ErrNoToken   = errors.New("local: missing or invalid token")
	ErrBadOrigin = errors.New("local: origin not allowed")
	ErrBadHost   = errors.New("local: host not allowed")
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
	if _, ok := a.hosts[r.Host]; !ok {
		return ErrBadHost
	}
	// A missing Origin is allowed: non-browser clients (curl, the flue CLI)
	// do not send one, and only browsers can be induced into cross-origin
	// requests. A present-but-unlisted Origin is always rejected.
	if origin := r.Header.Get("Origin"); origin != "" {
		if _, ok := a.origins[origin]; !ok {
			return ErrBadOrigin
		}
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
