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

// TestAuthRejectsSameSiteCrossPortViaFetchMetadata guards against a gap the
// Origin check alone leaves open. SameSite=Strict computes "site" as
// scheme+host — the port is not part of it — so a page on another loopback
// port (e.g. an unrelated dev server at 127.0.0.1:3000) is same-site with
// this daemon at 127.0.0.1:7717. Its Origin-less GETs (an <img> tag, a
// plain navigation) still carry the flue_token cookie, because SameSite
// doesn't distinguish the ports. A missing Origin plus a valid cookie plus
// a valid Host would otherwise authenticate this request. Sec-Fetch-Site is
// the signal that actually tells same-site-different-port apart from
// same-origin: a modern browser sends "same-site" (not "same-origin") for
// exactly this request shape, so Check must reject it.
func TestAuthRejectsSameSiteCrossPortViaFetchMetadata(t *testing.T) {
	a := NewAuth(testToken, 7717)
	r := req(t, "127.0.0.1:7717", "", "", testToken)
	r.Header.Set("Sec-Fetch-Site", "same-site")
	if err := a.Check(r); err == nil {
		t.Fatal("Check err = nil for Sec-Fetch-Site: same-site, want rejection")
	}
}

// TestAuthRejectsCrossSiteFetchMetadata is the more obvious sibling of the
// same-site case above: a request whose own metadata says it originated
// from a different site must not pass regardless of what Origin/Host say.
func TestAuthRejectsCrossSiteFetchMetadata(t *testing.T) {
	a := NewAuth(testToken, 7717)
	r := req(t, "127.0.0.1:7717", "", "?t="+testToken, "")
	r.Header.Set("Sec-Fetch-Site", "cross-site")
	if err := a.Check(r); err == nil {
		t.Fatal("Check err = nil for Sec-Fetch-Site: cross-site, want rejection")
	}
}

// TestAuthAllowsSameOriginAndNoneFetchMetadata is the positive control for
// the two tests above: "same-origin" (the flue web app talking to its own
// daemon) and "none" (a direct, user-typed navigation — the first-load
// token-in-URL flow) must keep working.
func TestAuthAllowsSameOriginAndNoneFetchMetadata(t *testing.T) {
	a := NewAuth(testToken, 7717)
	for _, sfs := range []string{"same-origin", "none"} {
		r := req(t, "127.0.0.1:7717", "", "?t="+testToken, "")
		r.Header.Set("Sec-Fetch-Site", sfs)
		if err := a.Check(r); err != nil {
			t.Errorf("Sec-Fetch-Site=%q: Check err = %v, want nil", sfs, err)
		}
	}
}

// TestAuthRejectsMultipleOriginHeaders guards against relying on
// http.Header.Get, which silently returns only the first value of a
// repeated header. A second Origin value must not be able to ride along
// unexamined behind a first value that happens to be allowed.
func TestAuthRejectsMultipleOriginHeaders(t *testing.T) {
	a := NewAuth(testToken, 7717)
	r := req(t, "127.0.0.1:7717", "http://127.0.0.1:7717", "?t="+testToken, "")
	r.Header.Add("Origin", "https://evil.example.com")
	if err := a.Check(r); err == nil {
		t.Fatal("Check err = nil for a request with two Origin headers, want rejection")
	}
}

// TestAuthRejectsURLHostMismatch makes the Host check independent of the
// invariant (upheld by net/http today, but not guaranteed by this package)
// that r.URL.Host and r.Host always agree. An absolute-form request target
// is the case where they could plausibly diverge; reject outright rather
// than pick one field and ignore the other.
func TestAuthRejectsURLHostMismatch(t *testing.T) {
	a := NewAuth(testToken, 7717)
	r := req(t, "127.0.0.1:7717", "http://127.0.0.1:7717", "?t="+testToken, "")
	r.URL.Host = "evil.example.com:7717"
	if err := a.Check(r); err == nil {
		t.Fatal("Check err = nil when r.URL.Host and r.Host disagree, want rejection")
	}
}

// TestMiddlewareSetsNoCookieOnRejectedRequest guards the ordering invariant
// in Middleware directly, rather than relying on reading the source: the
// cookie exchange must never run before Check has approved the request. If
// it were ever hoisted above Check, the daemon would hand its token to any
// cross-origin prober carrying a "t=" query parameter.
func TestMiddlewareSetsNoCookieOnRejectedRequest(t *testing.T) {
	a := NewAuth(testToken, 7717)
	h := a.Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Fatal("handler ran for an unauthenticated request")
	}))

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req(t, "127.0.0.1:7717", "https://evil.example.com", "?t="+testToken, ""))

	if rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403", rec.Code)
	}
	for _, c := range rec.Result().Cookies() {
		if c.Name == CookieName {
			t.Fatalf("rejected request still got a %s cookie set", CookieName)
		}
	}
}
