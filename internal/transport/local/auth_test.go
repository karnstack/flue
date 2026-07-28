package local

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

const testToken = "0123456789abcdef"

func req(t *testing.T, host, origin, query, cookie string) *http.Request {
	t.Helper()
	r := httptest.NewRequest("GET", "http://"+host+"/"+query, nil)
	r.Host = host
	if origin != "" {
		r.Header.Set("Origin", origin)
	}
	if cookie != "" {
		r.AddCookie(&http.Cookie{Name: CookieName, Value: cookie})
	}
	return r
}

func TestAuthCheck(t *testing.T) {
	a := NewAuth(testToken, 7717)

	cases := []struct {
		name    string
		host    string
		origin  string
		query   string
		cookie  string
		wantErr bool
	}{
		{"token in query", "127.0.0.1:7717", "http://127.0.0.1:7717", "?t=" + testToken, "", false},
		{"token in cookie", "127.0.0.1:7717", "http://127.0.0.1:7717", "", testToken, false},
		{"localhost host and origin", "localhost:7717", "http://localhost:7717", "", testToken, false},
		{"no token", "127.0.0.1:7717", "http://127.0.0.1:7717", "", "", true},
		{"wrong token", "127.0.0.1:7717", "http://127.0.0.1:7717", "?t=nope", "", true},
		{"foreign origin", "127.0.0.1:7717", "https://evil.example.com", "", testToken, true},
		{"rebound host", "evil.example.com:7717", "http://127.0.0.1:7717", "", testToken, true},
		{"wrong port in host", "127.0.0.1:9999", "http://127.0.0.1:7717", "", testToken, true},
		{"wrong port in origin", "127.0.0.1:7717", "http://127.0.0.1:9999", "", testToken, true},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			err := a.Check(req(t, c.host, c.origin, c.query, c.cookie))
			if c.wantErr && err == nil {
				t.Fatal("Check err = nil, want an error")
			}
			if !c.wantErr && err != nil {
				t.Fatalf("Check err = %v, want nil", err)
			}
		})
	}
}

func TestAuthAllowsMissingOriginForNonBrowserClients(t *testing.T) {
	// curl and the flue CLI send no Origin. A present-but-wrong Origin is
	// rejected; an absent one is not, because only browsers set it and
	// only browsers can be tricked into cross-origin requests.
	a := NewAuth(testToken, 7717)
	if err := a.Check(req(t, "127.0.0.1:7717", "", "?t="+testToken, "")); err != nil {
		t.Fatalf("Check err = %v, want nil", err)
	}
}

func TestMiddlewareExchangesTokenForCookie(t *testing.T) {
	a := NewAuth(testToken, 7717)
	h := a.Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req(t, "127.0.0.1:7717", "http://127.0.0.1:7717", "?t="+testToken, ""))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if got := rec.Header().Get("Referrer-Policy"); got != "no-referrer" {
		t.Fatalf("Referrer-Policy = %q, want %q", got, "no-referrer")
	}

	var found *http.Cookie
	for _, c := range rec.Result().Cookies() {
		if c.Name == CookieName {
			found = c
		}
	}
	if found == nil {
		t.Fatal("no flue_token cookie set")
	}
	if !found.HttpOnly {
		t.Error("cookie HttpOnly = false, want true")
	}
	if found.SameSite != http.SameSiteStrictMode {
		t.Errorf("cookie SameSite = %v, want Strict", found.SameSite)
	}
}

func TestMiddlewareRejectsUnauthenticated(t *testing.T) {
	a := NewAuth(testToken, 7717)
	h := a.Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Fatal("handler ran for an unauthenticated request")
	}))

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req(t, "127.0.0.1:7717", "https://evil.example.com", "", testToken))

	if rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403", rec.Code)
	}
}

func TestMiddlewareNeverSetsWildcardCORS(t *testing.T) {
	a := NewAuth(testToken, 7717)
	h := a.Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req(t, "127.0.0.1:7717", "http://127.0.0.1:7717", "?t="+testToken, ""))
	if got := rec.Header().Get("Access-Control-Allow-Origin"); got == "*" {
		t.Fatal("Access-Control-Allow-Origin = *, which is never permitted")
	}
}

// TestAuthRejectsNullOrigin guards against treating the literal string
// "null" as if it were a missing Origin. Browsers send exactly that value
// for opaque origins — a sandboxed iframe without allow-same-origin, a
// data: URL, a redirect chain that crosses certain boundaries — so it is a
// real Origin a browser can be made to send, not a theoretical one. It must
// be checked against the allowlist like any other present Origin and
// rejected, not special-cased as "absent".
func TestAuthRejectsNullOrigin(t *testing.T) {
	a := NewAuth(testToken, 7717)
	err := a.Check(req(t, "127.0.0.1:7717", "null", "?t="+testToken, ""))
	if err == nil {
		t.Fatal("Check err = nil for Origin: null, want an error")
	}
}

// TestAuthRejectsEmptyConfiguredToken guards against a defect found while
// reviewing the reference implementation: crypto/subtle.ConstantTimeCompare
// treats two empty byte slices as equal. If Auth is ever constructed with an
// empty token (a misconfiguration LoadOrCreateToken is designed never to
// produce, but that Auth itself must not trust blindly), a request with no
// token at all — no cookie, no "t" query param — would otherwise compare
// "" == "" and authenticate. That defeats all three checks: an attacker
// wouldn't even need to know a token. Auth must fail closed instead.
func TestAuthRejectsEmptyConfiguredToken(t *testing.T) {
	a := NewAuth("", 7717)
	err := a.Check(req(t, "127.0.0.1:7717", "http://127.0.0.1:7717", "", ""))
	if err == nil {
		t.Fatal("Check err = nil for empty configured token and no supplied token, want an error")
	}
}
