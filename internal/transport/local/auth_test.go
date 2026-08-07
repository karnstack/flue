package local

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
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
		r.AddCookie(&http.Cookie{Name: CookieNameFor(7717), Value: cookie})
	}
	return r
}

// tokenReq is req with the session token where non-browser clients now carry
// it: a request header, never the URL.
func tokenReq(t *testing.T, host, origin, query, token string) *http.Request {
	t.Helper()
	r := req(t, host, origin, query, "")
	if token != "" {
		r.Header.Set(HeaderName, token)
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
		header  string
		wantErr bool
	}{
		{name: "token in header", host: "127.0.0.1:7717", origin: "http://127.0.0.1:7717", header: testToken},
		{name: "token in cookie", host: "127.0.0.1:7717", origin: "http://127.0.0.1:7717", cookie: testToken},
		{name: "localhost host and origin", host: "localhost:7717", origin: "http://localhost:7717", cookie: testToken},
		{name: "no token", host: "127.0.0.1:7717", origin: "http://127.0.0.1:7717", wantErr: true},
		{name: "wrong token in header", host: "127.0.0.1:7717", origin: "http://127.0.0.1:7717", header: "nope", wantErr: true},
		{name: "session token in query", host: "127.0.0.1:7717", origin: "http://127.0.0.1:7717", query: "?t=" + testToken, wantErr: true},
		{name: "foreign origin", host: "127.0.0.1:7717", origin: "https://evil.example.com", cookie: testToken, wantErr: true},
		{name: "rebound host", host: "evil.example.com:7717", origin: "http://127.0.0.1:7717", cookie: testToken, wantErr: true},
		{name: "wrong port in host", host: "127.0.0.1:9999", origin: "http://127.0.0.1:7717", cookie: testToken, wantErr: true},
		{name: "wrong port in origin", host: "127.0.0.1:7717", origin: "http://127.0.0.1:9999", cookie: testToken, wantErr: true},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			r := req(t, c.host, c.origin, c.query, c.cookie)
			if c.header != "" {
				r.Header.Set(HeaderName, c.header)
			}
			err := a.Check(r)
			if c.wantErr && err == nil {
				t.Fatal("Check err = nil, want an error")
			}
			if !c.wantErr && err != nil {
				t.Fatalf("Check err = %v, want nil", err)
			}
		})
	}
}

// TestAuthNeverAcceptsASessionTokenFromTheURL is the point of task 7b stated
// as an invariant of the authenticator. The session token is the permanent
// credential; anything that puts it in a URL puts it in the browser opener's
// argv, in shell history, and in whatever a user pastes into a bug report. No
// query parameter name may be a way in.
func TestAuthNeverAcceptsASessionTokenFromTheURL(t *testing.T) {
	a := NewAuth(testToken, 7717)
	for _, q := range []string{
		"?t=" + testToken,
		"?token=" + testToken,
		"?" + HandoffParam + "=" + testToken,
	} {
		if err := a.Check(req(t, "127.0.0.1:7717", "http://127.0.0.1:7717", q, "")); err == nil {
			t.Errorf("Check err = nil for %q, want a rejection", q)
		}
	}
}

// TestAuthNeverAcceptsAHandoffTokenDirectly: a handoff token buys a cookie
// through Middleware and nothing else. Check is what handleWS calls, so a
// handoff token must never authenticate a WebSocket upgrade — the one GET that
// leads to every state change flue has.
func TestAuthNeverAcceptsAHandoffTokenDirectly(t *testing.T) {
	a := NewAuth(testToken, 7717)
	h, err := a.Mint()
	if err != nil {
		t.Fatalf("Mint: %v", err)
	}

	r := req(t, "127.0.0.1:7717", "http://127.0.0.1:7717", "?"+HandoffParam+"="+h, "")
	if err := a.Check(r); err == nil {
		t.Fatal("Check err = nil for a handoff token in the URL, want a rejection")
	}

	r = req(t, "127.0.0.1:7717", "http://127.0.0.1:7717", "", h)
	if err := a.Check(r); err == nil {
		t.Fatal("Check err = nil for a handoff token in the session cookie, want a rejection")
	}

	r = tokenReq(t, "127.0.0.1:7717", "http://127.0.0.1:7717", "", h)
	if err := a.Check(r); err == nil {
		t.Fatal("Check err = nil for a handoff token in the session-token header, want a rejection")
	}

	// None of the above may have spent it, either.
	if !a.Redeem(h) {
		t.Fatal("a rejected Check spent the handoff token; only Middleware may redeem")
	}
}

func TestAuthAllowsMissingOriginForNonBrowserClients(t *testing.T) {
	// curl and the flue CLI send no Origin. A present-but-wrong Origin is
	// rejected; an absent one is not, because only browsers set it and
	// only browsers can be tricked into cross-origin requests.
	a := NewAuth(testToken, 7717)
	if err := a.Check(tokenReq(t, "127.0.0.1:7717", "", "", testToken)); err != nil {
		t.Fatalf("Check err = %v, want nil", err)
	}
}

// TestAuthRejectsRepeatedTokenHeaders: http.Header.Get returns only the first
// value of a repeated header, so a second must not ride along unexamined
// behind an acceptable first one.
func TestAuthRejectsRepeatedTokenHeaders(t *testing.T) {
	a := NewAuth(testToken, 7717)
	r := tokenReq(t, "127.0.0.1:7717", "http://127.0.0.1:7717", "", testToken)
	r.Header.Add(HeaderName, "something-else")
	if err := a.Check(r); err == nil {
		t.Fatal("Check err = nil for two token headers, want a rejection")
	}
}

// --- the handoff exchange ---

func handoffCookie(rec *httptest.ResponseRecorder) *http.Cookie {
	for _, c := range rec.Result().Cookies() {
		if c.Name == CookieNameFor(7717) {
			return c
		}
	}
	return nil
}

func okHandler(t *testing.T) http.Handler {
	t.Helper()
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})
}

func TestMiddlewareExchangesHandoffForCookie(t *testing.T) {
	a := NewAuth(testToken, 7717)
	h, err := a.Mint()
	if err != nil {
		t.Fatalf("Mint: %v", err)
	}

	rec := httptest.NewRecorder()
	a.Middleware(okHandler(t)).ServeHTTP(rec, req(t, "127.0.0.1:7717", "", "?"+HandoffParam+"="+h, ""))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if got := rec.Header().Get("Referrer-Policy"); got != "no-referrer" {
		t.Fatalf("Referrer-Policy = %q, want %q", got, "no-referrer")
	}

	found := handoffCookie(rec)
	if found == nil {
		t.Fatal("no flue_token cookie set")
	}
	if found.Value != testToken {
		t.Fatalf("cookie value = %q, want the daemon's session token", found.Value)
	}
	if !found.HttpOnly {
		t.Error("cookie HttpOnly = false, want true")
	}
	if found.SameSite != http.SameSiteStrictMode {
		t.Errorf("cookie SameSite = %v, want Strict", found.SameSite)
	}
	if found.Path != "/" {
		t.Errorf("cookie Path = %q, want /", found.Path)
	}
}

// TestMiddlewareNeverCachesTheHandoffExchange. The exchange is the only
// response flue sends that carries the session token in a Set-Cookie, and it is
// also the one the service worker is told to keep as the app shell — GET /?h=…
// is a navigation, and the answer is an ok, basic, text/html document. Whether
// a cached copy would carry the Set-Cookie back out is browser behaviour, so
// the response says not to keep it at all.
func TestMiddlewareNeverCachesTheHandoffExchange(t *testing.T) {
	a := NewAuth(testToken, 7717)
	h, err := a.Mint()
	if err != nil {
		t.Fatalf("Mint: %v", err)
	}

	rec := httptest.NewRecorder()
	a.Middleware(okHandler(t)).ServeHTTP(rec, req(t, "127.0.0.1:7717", "", "?"+HandoffParam+"="+h, ""))

	if handoffCookie(rec) == nil {
		t.Fatal("no cookie set, so this is not the response under test")
	}
	if got := rec.Header().Get("Cache-Control"); got != "no-store" {
		t.Fatalf("Cache-Control = %q on the response carrying the session cookie, want %q", got, "no-store")
	}
}

// TestMiddlewareRefusesASpentHandoff: whoever read the token out of the
// browser opener's argv — or out of anywhere else — arrives second, and second
// must fail.
func TestMiddlewareRefusesASpentHandoff(t *testing.T) {
	a := NewAuth(testToken, 7717)
	h, err := a.Mint()
	if err != nil {
		t.Fatalf("Mint: %v", err)
	}
	mw := a.Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))

	first := httptest.NewRecorder()
	mw.ServeHTTP(first, req(t, "127.0.0.1:7717", "", "?"+HandoffParam+"="+h, ""))
	if first.Code != http.StatusOK {
		t.Fatalf("first presentation status = %d, want 200", first.Code)
	}

	second := httptest.NewRecorder()
	mw.ServeHTTP(second, req(t, "127.0.0.1:7717", "", "?"+HandoffParam+"="+h, ""))
	if second.Code != http.StatusUnauthorized {
		t.Fatalf("second presentation status = %d, want 401", second.Code)
	}
	if c := handoffCookie(second); c != nil {
		t.Fatalf("a spent handoff token still yielded a %s cookie (%q)", CookieNameFor(7717), c.Value)
	}
}

// TestMiddlewareRefusesASpentHandoffEvenWithAValidCookie pins the strict half
// of the no-fallback rule, which is the half that is invisible unless it is
// asserted directly: a failed exchange does not fall through to the ordinary
// token check either.
//
// The lenient alternative — serve it, since the cookie alone would have been
// enough — is not a security hole (a cookie-authenticated GET on a read-only
// route is already allowed with no parameter at all). It is rejected because it
// makes the daemon's answer to "was this handoff still good?" depend on an
// unrelated credential, so single use stops being observable from outside and
// starts being a property of the client's cookie jar. Presenting a spent token
// must fail, unconditionally.
func TestMiddlewareRefusesASpentHandoffEvenWithAValidCookie(t *testing.T) {
	a := NewAuth(testToken, 7717)
	h, err := a.Mint()
	if err != nil {
		t.Fatalf("Mint: %v", err)
	}
	if !a.Redeem(h) {
		t.Fatal("Redeem = false on first presentation")
	}

	rec := httptest.NewRecorder()
	r := req(t, "127.0.0.1:7717", "", "?"+HandoffParam+"="+h, testToken) // spent handoff, valid cookie
	a.Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Error("handler ran for a request presenting a spent handoff token")
	})).ServeHTTP(rec, r)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
}

// TestMiddlewareDoesNotFallBackToTheSessionToken is the requirement that makes
// the whole change worth doing. If a failed handoff exchange fell back to
// accepting the session token from the URL, the exposure would be right back
// where it started and every other control here would be theatre.
func TestMiddlewareDoesNotFallBackToTheSessionToken(t *testing.T) {
	a := NewAuth(testToken, 7717)
	mw := a.Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Error("handler ran for a request authenticated by a session token in the URL")
	}))

	for _, q := range []string{
		"?t=" + testToken,
		"?" + HandoffParam + "=" + testToken,
		"?" + HandoffParam + "=expired-or-unknown&t=" + testToken,
	} {
		rec := httptest.NewRecorder()
		mw.ServeHTTP(rec, req(t, "127.0.0.1:7717", "", q, ""))
		if rec.Code == http.StatusOK {
			t.Errorf("%q was served, want a rejection", q)
		}
		if c := handoffCookie(rec); c != nil {
			t.Errorf("%q yielded a %s cookie, want none", q, CookieNameFor(7717))
		}
	}
}

// TestMiddlewareRefusesAnExpiredHandoff: the exchange must be as strict about
// age as it is about reuse.
func TestMiddlewareRefusesAnExpiredHandoff(t *testing.T) {
	now := time.Now()
	a := NewAuthWithClock(testToken, 7717, func() time.Time { return now })
	h, err := a.Mint()
	if err != nil {
		t.Fatalf("Mint: %v", err)
	}
	now = now.Add(HandoffTTL + time.Second)

	rec := httptest.NewRecorder()
	a.Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Error("handler ran for an expired handoff token")
	})).ServeHTTP(rec, req(t, "127.0.0.1:7717", "", "?"+HandoffParam+"="+h, ""))

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
	if c := handoffCookie(rec); c != nil {
		t.Fatal("an expired handoff token still yielded a cookie")
	}
}

// TestMiddlewareChecksProvenanceBeforeRedeeming. A request from a disallowed
// Origin must be refused before the store is touched, for two reasons: it must
// not be issued a cookie, and it must not be able to *burn* a live handoff
// token, which would be a free denial of service on the legitimate flue open
// from any page that can guess the URL shape.
func TestMiddlewareChecksProvenanceBeforeRedeeming(t *testing.T) {
	a := NewAuth(testToken, 7717)
	h, err := a.Mint()
	if err != nil {
		t.Fatalf("Mint: %v", err)
	}
	mw := a.Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Error("handler ran for a request from a disallowed origin")
	}))

	for _, bad := range []func(*http.Request){
		func(r *http.Request) { r.Header.Set("Origin", "https://evil.example.com") },
		func(r *http.Request) { r.Header.Set("Sec-Fetch-Site", "same-site") },
		func(r *http.Request) { r.Header.Set("Sec-Fetch-Site", "cross-site") },
		func(r *http.Request) { r.Host = "evil.example.com:7717" },
	} {
		rec := httptest.NewRecorder()
		r := req(t, "127.0.0.1:7717", "", "?"+HandoffParam+"="+h, "")
		bad(r)
		mw.ServeHTTP(rec, r)
		if rec.Code != http.StatusForbidden {
			t.Errorf("status = %d, want 403", rec.Code)
		}
		if c := handoffCookie(rec); c != nil {
			t.Error("a rejected request was still issued a cookie")
		}
	}

	if !a.Redeem(h) {
		t.Fatal("a rejected request spent the handoff token; provenance must be checked first")
	}
}

// TestMiddlewareAdmitsFetchSiteNone is the positive control for the tension
// this task had to resolve: a CLI-launched browser, a typed URL and a bookmark
// all send Sec-Fetch-Site: none, so the exchange has to accept it.
func TestMiddlewareAdmitsFetchSiteNone(t *testing.T) {
	a := NewAuth(testToken, 7717)
	h, err := a.Mint()
	if err != nil {
		t.Fatalf("Mint: %v", err)
	}
	rec := httptest.NewRecorder()
	r := req(t, "127.0.0.1:7717", "", "?"+HandoffParam+"="+h, "")
	r.Header.Set("Sec-Fetch-Site", "none")
	a.Middleware(okHandler(t)).ServeHTTP(rec, r)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if handoffCookie(rec) == nil {
		t.Fatal("no cookie set for a Sec-Fetch-Site: none first load")
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
	h.ServeHTTP(rec, tokenReq(t, "127.0.0.1:7717", "http://127.0.0.1:7717", "", testToken))
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
	err := a.Check(tokenReq(t, "127.0.0.1:7717", "null", "", testToken))
	if err == nil {
		t.Fatal("Check err = nil for Origin: null, want an error")
	}
}

// TestAuthRejectsEmptyConfiguredToken guards against a defect found while
// reviewing the reference implementation: crypto/subtle.ConstantTimeCompare
// treats two empty byte slices as equal. If Auth is ever constructed with an
// empty token (a misconfiguration LoadOrCreateToken is designed never to
// produce, but that Auth itself must not trust blindly), a request with no
// token at all — no cookie, no header — would otherwise compare "" == "" and
// authenticate. That defeats all three checks: an attacker wouldn't even need
// to know a token. Auth must fail closed instead.
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
	r := tokenReq(t, "127.0.0.1:7717", "", "", testToken)
	r.Header.Set("Sec-Fetch-Site", "cross-site")
	if err := a.Check(r); err == nil {
		t.Fatal("Check err = nil for Sec-Fetch-Site: cross-site, want rejection")
	}
}

// TestAuthAllowsSameOriginAndNoneFetchMetadata is the positive control for
// the two tests above: "same-origin" (the flue web app talking to its own
// daemon) and "none" (a direct, user-typed navigation, or the browser flue
// open launched) must keep working.
func TestAuthAllowsSameOriginAndNoneFetchMetadata(t *testing.T) {
	a := NewAuth(testToken, 7717)
	for _, sfs := range []string{"same-origin", "none"} {
		r := req(t, "127.0.0.1:7717", "", "", testToken)
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
	r := tokenReq(t, "127.0.0.1:7717", "http://127.0.0.1:7717", "", testToken)
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
	r := tokenReq(t, "127.0.0.1:7717", "http://127.0.0.1:7717", "", testToken)
	r.URL.Host = "evil.example.com:7717"
	if err := a.Check(r); err == nil {
		t.Fatal("Check err = nil when r.URL.Host and r.Host disagree, want rejection")
	}
}

// TestMiddlewareSetsNoCookieOnRejectedRequest guards the ordering invariant
// in Middleware directly, rather than relying on reading the source: the
// cookie exchange must never run before the request's provenance has been
// approved. If it were ever hoisted above that check, the daemon would hand
// its session token to any cross-origin prober carrying a handoff parameter.
func TestMiddlewareSetsNoCookieOnRejectedRequest(t *testing.T) {
	a := NewAuth(testToken, 7717)
	h, err := a.Mint()
	if err != nil {
		t.Fatalf("Mint: %v", err)
	}
	mw := a.Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Fatal("handler ran for an unauthenticated request")
	}))

	rec := httptest.NewRecorder()
	mw.ServeHTTP(rec, req(t, "127.0.0.1:7717", "https://evil.example.com", "?"+HandoffParam+"="+h, ""))

	if rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403", rec.Code)
	}
	if c := handoffCookie(rec); c != nil {
		t.Fatalf("rejected request still got a %s cookie set", CookieNameFor(7717))
	}
}
