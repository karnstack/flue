package local

import (
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// TestMintProducesDistinctUnguessableTokens: two mints must never collide, and
// a handoff token must not be the session token wearing a different name.
func TestMintProducesDistinctUnguessableTokens(t *testing.T) {
	a := NewAuth(testToken, 7717)

	seen := map[string]bool{}
	for i := 0; i < 64; i++ {
		h, err := a.Mint()
		if err != nil {
			t.Fatalf("Mint: %v", err)
		}
		if h == "" {
			t.Fatal("Mint returned an empty handoff token")
		}
		if h == testToken {
			t.Fatal("Mint returned the session token as a handoff token")
		}
		if len(h) < 32 {
			t.Fatalf("handoff token is %d characters, want a high-entropy value", len(h))
		}
		if seen[h] {
			t.Fatalf("Mint returned a duplicate handoff token %q", h)
		}
		seen[h] = true
	}
}

// TestRedeemAcceptsAHandoffTokenExactlyOnce is the core property: the whole
// point of moving off the session token is that what lands in the browser
// opener's argv is worth nothing on a second use.
func TestRedeemAcceptsAHandoffTokenExactlyOnce(t *testing.T) {
	a := NewAuth(testToken, 7717)

	h, err := a.Mint()
	if err != nil {
		t.Fatalf("Mint: %v", err)
	}
	if !a.Redeem(h) {
		t.Fatal("Redeem = false on first presentation, want true")
	}
	if a.Redeem(h) {
		t.Fatal("Redeem = true on second presentation, want false — the token must be single-use")
	}
}

func TestRedeemRejectsUnknownAndEmptyTokens(t *testing.T) {
	a := NewAuth(testToken, 7717)
	if _, err := a.Mint(); err != nil {
		t.Fatalf("Mint: %v", err)
	}

	for _, tok := range []string{"", "nope", testToken} {
		if a.Redeem(tok) {
			t.Errorf("Redeem(%q) = true, want false", tok)
		}
	}
}

// TestRedeemRejectsAnExpiredToken. The TTL is seconds because flue open
// launches the browser immediately; a token found later must be inert.
func TestRedeemRejectsAnExpiredToken(t *testing.T) {
	now := time.Now()
	a := NewAuthWithClock(testToken, 7717, func() time.Time { return now })

	h, err := a.Mint()
	if err != nil {
		t.Fatalf("Mint: %v", err)
	}
	now = now.Add(HandoffTTL - time.Millisecond)
	if !a.Redeem(h) {
		t.Fatal("Redeem = false just inside the TTL, want true")
	}

	h2, err := a.Mint()
	if err != nil {
		t.Fatalf("Mint: %v", err)
	}
	now = now.Add(HandoffTTL + time.Millisecond)
	if a.Redeem(h2) {
		t.Fatal("Redeem = true past the TTL, want false")
	}
}

// TestRedeemSpendsAnExpiredTokenAnyway guards a subtle version of the
// single-use rule: a presentation must remove the token whether or not it was
// still valid. If an expired token were left in the store, "presented once"
// would stop implying "gone", and a clock that moved backwards — a manual
// date(1), an NTP step — would make it live again.
func TestRedeemSpendsAnExpiredTokenAnyway(t *testing.T) {
	now := time.Now()
	a := NewAuthWithClock(testToken, 7717, func() time.Time { return now })

	h, err := a.Mint()
	if err != nil {
		t.Fatalf("Mint: %v", err)
	}
	expiredAt := now.Add(2 * HandoffTTL)
	now = expiredAt
	if a.Redeem(h) {
		t.Fatal("Redeem = true past the TTL, want false")
	}

	now = expiredAt.Add(-2 * HandoffTTL) // the clock went backwards
	if a.Redeem(h) {
		t.Fatal("an expired token was redeemable after the clock moved back; a presented token must be removed regardless of validity")
	}
}

// TestConcurrentRedeemYieldsExactlyOneWinner. Two browsers, or a browser and
// whoever read the token, presenting the same handoff token at the same
// instant must not both be admitted. Run under -race.
func TestConcurrentRedeemYieldsExactlyOneWinner(t *testing.T) {
	for round := 0; round < 50; round++ {
		a := NewAuth(testToken, 7717)
		h, err := a.Mint()
		if err != nil {
			t.Fatalf("Mint: %v", err)
		}

		const racers = 16
		var wins atomic.Int64
		var start sync.WaitGroup
		var done sync.WaitGroup
		start.Add(1)
		done.Add(racers)
		for i := 0; i < racers; i++ {
			go func() {
				defer done.Done()
				start.Wait()
				if a.Redeem(h) {
					wins.Add(1)
				}
			}()
		}
		start.Done()
		done.Wait()

		if got := wins.Load(); got != 1 {
			t.Fatalf("round %d: %d concurrent redemptions succeeded, want exactly 1", round, got)
		}
	}
}

// TestConcurrentMintAndRedeemAreIndependent: minting while redemptions are in
// flight must not lose or duplicate tokens.
func TestConcurrentMintAndRedeemAreIndependent(t *testing.T) {
	a := NewAuth(testToken, 7717)

	const n = 32
	minted := make(chan string, n)
	var wg sync.WaitGroup
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			h, err := a.Mint()
			if err != nil {
				t.Errorf("Mint: %v", err)
				return
			}
			minted <- h
		}()
	}
	wg.Wait()
	close(minted)

	var wins atomic.Int64
	for h := range minted {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if a.Redeem(h) {
				wins.Add(1)
			}
		}()
	}
	wg.Wait()

	if got := wins.Load(); got != n {
		t.Fatalf("%d of %d concurrently minted tokens redeemed, want all of them", got, n)
	}
}

// TestHandoffStoreIsBounded: the store must not grow without limit. Minting is
// authenticated so this is a bound on accident rather than on attack, but an
// unbounded in-memory store fed by a scripted loop is still a defect.
func TestHandoffStoreIsBounded(t *testing.T) {
	a := NewAuth(testToken, 7717)
	for i := 0; i < maxOutstandingHandoffs*4; i++ {
		if _, err := a.Mint(); err != nil {
			t.Fatalf("Mint: %v", err)
		}
	}
	if got := a.outstanding(); got > maxOutstandingHandoffs {
		t.Fatalf("outstanding handoff tokens = %d, want at most %d", got, maxOutstandingHandoffs)
	}
}

// TestExpiredTokensArePruned: a store that only ever removed redeemed tokens
// would hold every abandoned one until the capacity bound evicted it.
func TestExpiredTokensArePruned(t *testing.T) {
	now := time.Now()
	a := NewAuthWithClock(testToken, 7717, func() time.Time { return now })

	for i := 0; i < 5; i++ {
		if _, err := a.Mint(); err != nil {
			t.Fatalf("Mint: %v", err)
		}
	}
	now = now.Add(2 * HandoffTTL)
	if _, err := a.Mint(); err != nil {
		t.Fatalf("Mint: %v", err)
	}
	if got := a.outstanding(); got != 1 {
		t.Fatalf("outstanding = %d after the earlier tokens expired, want 1", got)
	}
}

// TestHandoffTokensAreNotSharedBetweenAuths: the store belongs to one daemon's
// authenticator. A token minted by one must be worthless to another.
func TestHandoffTokensAreNotSharedBetweenAuths(t *testing.T) {
	a := NewAuth(testToken, 7717)
	b := NewAuth(testToken, 7717)

	h, err := a.Mint()
	if err != nil {
		t.Fatalf("Mint: %v", err)
	}
	if b.Redeem(h) {
		t.Fatal("a handoff token minted by one Auth was redeemable by another")
	}
}

// TestHandoffTTLIsSeconds pins the requirement rather than the number: flue
// open launches the browser on the next line, so the token's life is measured
// against browser startup, not against a human's attention span.
func TestHandoffTTLIsSeconds(t *testing.T) {
	if HandoffTTL < time.Second || HandoffTTL > time.Minute {
		t.Fatalf("HandoffTTL = %s, want seconds — long enough for a browser to start, short enough to be worthless if found", HandoffTTL)
	}
}

// --- CheckMint ---

// mintReq builds the request the flue CLI makes: no Origin, no
// Sec-Fetch-Site, session token in a header a browser cannot be induced to
// send cross-origin.
func mintReq(t *testing.T, token string) *http.Request {
	t.Helper()
	r := httptest.NewRequest(http.MethodPost, "http://127.0.0.1:7717/api/handoff", nil)
	r.Host = "127.0.0.1:7717"
	if token != "" {
		r.Header.Set(HeaderName, token)
	}
	return r
}

func TestCheckMintAcceptsTheCLI(t *testing.T) {
	a := NewAuth(testToken, 7717)
	if err := a.CheckMint(mintReq(t, testToken)); err != nil {
		t.Fatalf("CheckMint err = %v, want nil", err)
	}
}

// TestCheckMintRequiresAuthentication is the requirement in one test: anyone
// who cannot read the token file cannot mint.
func TestCheckMintRejectsAnUnauthenticatedRequest(t *testing.T) {
	a := NewAuth(testToken, 7717)
	for _, tok := range []string{"", "wrong-token"} {
		if err := a.CheckMint(mintReq(t, tok)); err == nil {
			t.Errorf("CheckMint err = nil with token %q, want a rejection", tok)
		}
	}
}

// TestCheckMintRejectsTheCookie is the load-bearing one. The cookie is
// attached automatically by the browser, and SameSite is port-blind, so a
// co-resident untrusted origin can cause the victim's browser to send it. If
// the cookie could mint, that page could mint.
func TestCheckMintRejectsTheCookie(t *testing.T) {
	a := NewAuth(testToken, 7717)
	r := mintReq(t, "")
	r.AddCookie(&http.Cookie{Name: CookieName, Value: testToken})
	if err := a.CheckMint(r); err == nil {
		t.Fatal("CheckMint err = nil for a cookie-authenticated request, want a rejection")
	}
}

// TestCheckMintRejectsTheQueryString: the whole change is about keeping the
// session token out of URLs. Minting must not offer a way back in.
func TestCheckMintRejectsTheQueryString(t *testing.T) {
	a := NewAuth(testToken, 7717)
	r := httptest.NewRequest(http.MethodPost, "http://127.0.0.1:7717/api/handoff?t="+testToken, nil)
	r.Host = "127.0.0.1:7717"
	if err := a.CheckMint(r); err == nil {
		t.Fatal("CheckMint err = nil for a token in the query string, want a rejection")
	}
}

// TestCheckMintRejectsAnyBrowser. Every modern browser sends Sec-Fetch-Site on
// every request and the flue CLI never does, so requiring its absence states
// the actual policy — only a non-browser local process may mint — rather than
// enumerating the browser cases to block. "none" is included deliberately: it
// is the value a redirect can launder, and it must not be a way in here.
func TestCheckMintRejectsAnyBrowser(t *testing.T) {
	a := NewAuth(testToken, 7717)
	for _, sfs := range []string{"none", "same-origin", "same-site", "cross-site"} {
		r := mintReq(t, testToken)
		r.Header.Set("Sec-Fetch-Site", sfs)
		if err := a.CheckMint(r); err == nil {
			t.Errorf("CheckMint err = nil for Sec-Fetch-Site: %q, want a rejection", sfs)
		}
	}
}

func TestCheckMintRejectsAForeignOriginAndHost(t *testing.T) {
	a := NewAuth(testToken, 7717)

	r := mintReq(t, testToken)
	r.Header.Set("Origin", "https://evil.example.com")
	if err := a.CheckMint(r); err == nil {
		t.Error("CheckMint err = nil for a foreign Origin, want a rejection")
	}

	r = mintReq(t, testToken)
	r.Host = "evil.example.com:7717"
	if err := a.CheckMint(r); err == nil {
		t.Error("CheckMint err = nil for a rebound Host, want a rejection")
	}
}

// TestCheckMintRejectsRepeatedTokenHeaders: http.Header.Get reads only the
// first value, so a second must not ride along unexamined behind an acceptable
// first one.
func TestCheckMintRejectsRepeatedTokenHeaders(t *testing.T) {
	a := NewAuth(testToken, 7717)
	r := mintReq(t, testToken)
	r.Header.Add(HeaderName, "something-else")
	if err := a.CheckMint(r); err == nil {
		t.Fatal("CheckMint err = nil for two token headers, want a rejection")
	}
}

// TestCheckMintRejectsAnEmptyConfiguredToken is the sibling of
// TestAuthRejectsEmptyConfiguredToken: subtle.ConstantTimeCompare treats two
// empty slices as equal, so a misconfigured Auth must not let a request with
// no header at all mint credentials.
func TestCheckMintRejectsAnEmptyConfiguredToken(t *testing.T) {
	a := NewAuth("", 7717)
	if err := a.CheckMint(mintReq(t, "")); err == nil {
		t.Fatal("CheckMint err = nil for an empty configured token, want a rejection")
	}
}
