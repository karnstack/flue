package daemon

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/karnstack/flue/internal/transport/local"
)

// The loopback fleet surface: the directory this daemon fetches for its own
// UI, because the browser on 127.0.0.1 cannot fetch it for itself.

// getFleet is a GET from this daemon's own origin, authenticated the way the
// browser is: the session cookie, and same-origin fetch metadata.
func getFleet(t *testing.T, ts *httptest.Server, path string) *http.Response {
	t.Helper()
	req, err := http.NewRequest(http.MethodGet, ts.URL+path, nil)
	if err != nil {
		t.Fatal(err)
	}
	req.AddCookie(&http.Cookie{Name: tsCookie(ts), Value: tok})
	req.Header.Set("Sec-Fetch-Site", "same-origin")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("GET %s: %v", path, err)
	}
	t.Cleanup(func() { resp.Body.Close() })
	return resp
}

// TestFleetDirectoryIsNotThereWithoutARelayLeg: a daemon that is not reading a
// directory says so, rather than answering an empty one.
//
// The difference is the whole value of the endpoint to a browser. "No fleet
// here" lets the UI keep the machines it already knows about; "here is a fleet
// with nothing in it" would tell it, wrongly, that every sibling had gone.
func TestFleetDirectoryIsNotThereWithoutARelayLeg(t *testing.T) {
	ts, _ := newPairServer(t)
	resp := getFleet(t, ts, FleetDirectoryPath)
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("GET %s = %d on a daemon with no relay, want 404", FleetDirectoryPath, resp.StatusCode)
	}
}

// TestFleetDirectoryServesTheRelaysBytesUnchanged is the whole contract: what
// the relay said, byte for byte.
//
// Asserted on the bytes rather than on a decoded document, deliberately. The
// browser verifies every blob under the fleet public key it pinned, and it can
// only do that if the blob it verifies is the blob the fleet key signed — so a
// daemon that re-encoded this document, however faithfully, would be a daemon
// that could break every signature in it. Transport, not opinion.
func TestFleetDirectoryServesTheRelaysBytesUnchanged(t *testing.T) {
	ts, srv := newPairServer(t)
	// Deliberately not canonical JSON: odd spacing, a field this daemon has
	// never heard of, no trailing newline. All of it has to survive.
	const body = `{"v":1,  "entries":[{"key":"abc","blob":"AAEC"}],"somethingNew":true}`
	srv.SetDirectorySnapshot(func(context.Context) ([]byte, error) { return []byte(body), nil })

	resp := getFleet(t, ts, FleetDirectoryPath)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("GET %s = %d, want 200", FleetDirectoryPath, resp.StatusCode)
	}
	got, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("reading the answer: %v", err)
	}
	if string(got) != body {
		t.Errorf("body = %q, want the relay's bytes unchanged %q", got, body)
	}
	if ct := resp.Header.Get("Content-Type"); ct != "application/json" {
		t.Errorf("Content-Type = %q, want application/json", ct)
	}
	// The directory is how a browser learns of a revocation. A cached copy is
	// a revocation served late, which is the one staleness this design cannot
	// afford — the relay says no-store and so does this.
	if cc := resp.Header.Get("Cache-Control"); cc != "no-store" {
		t.Errorf("Cache-Control = %q, want no-store", cc)
	}
}

// TestFleetDirectoryReportsARelayItCouldNotRead: a leg that is installed and
// failing is a 502, not a 404 and not an empty document.
//
// The caller needs to tell "this machine has no fleet" from "this machine has
// a fleet it cannot reach right now", because only the second is worth
// retrying and only the first should change what the UI shows.
func TestFleetDirectoryReportsARelayItCouldNotRead(t *testing.T) {
	ts, srv := newPairServer(t)
	srv.SetDirectorySnapshot(func(context.Context) ([]byte, error) {
		return nil, errors.New("dial tcp 203.0.113.7:443: connection refused")
	})

	resp := getFleet(t, ts, FleetDirectoryPath)
	if resp.StatusCode != http.StatusBadGateway {
		t.Fatalf("GET %s = %d with an unreachable relay, want 502", FleetDirectoryPath, resp.StatusCode)
	}
	// The failure text names the relay's address and the transport error.
	// Neither is the caller's business, and one of them is an address.
	body, _ := io.ReadAll(resp.Body)
	if strings.Contains(string(body), "203.0.113.7") {
		t.Errorf("body = %q, want the transport error kept out of it", body)
	}
}

// TestFleetDirectoryIsBehindAuth: the endpoint is a read of the relay
// performed with this machine's credential, so it takes this daemon's.
//
// Not because the directory is secret — it is signed rather than secret, and
// `GET /directory` on the relay takes no credential at all — but because an
// unauthenticated route here would let a page on any other loopback port make
// this daemon dial its relay, and would map the API surface by status code for
// anyone who asked.
func TestFleetDirectoryIsBehindAuth(t *testing.T) {
	ts, srv := newPairServer(t)
	called := false
	srv.SetDirectorySnapshot(func(context.Context) ([]byte, error) {
		called = true
		return []byte(`{"v":1,"entries":[]}`), nil
	})

	// No cookie, no header.
	resp, err := http.Get(ts.URL + FleetDirectoryPath)
	if err != nil {
		t.Fatalf("GET %s: %v", FleetDirectoryPath, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("unauthenticated GET %s = %d, want 401", FleetDirectoryPath, resp.StatusCode)
	}
	if called {
		t.Error("the daemon read its relay for an unauthenticated caller")
	}

	// A page on another loopback port is same-site, not same-origin, and its
	// Origin is not one of this daemon's. Either check alone refuses it.
	req, err := http.NewRequest(http.MethodGet, ts.URL+FleetDirectoryPath, nil)
	if err != nil {
		t.Fatal(err)
	}
	req.AddCookie(&http.Cookie{Name: tsCookie(ts), Value: tok})
	req.Header.Set("Origin", "http://127.0.0.1:3000")
	req.Header.Set("Sec-Fetch-Site", "same-site")
	resp2, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("GET %s: %v", FleetDirectoryPath, err)
	}
	defer resp2.Body.Close()
	if resp2.StatusCode != http.StatusForbidden {
		t.Errorf("cross-origin GET %s = %d, want 403", FleetDirectoryPath, resp2.StatusCode)
	}
	if called {
		t.Error("the daemon read its relay for a cross-origin caller")
	}
}

// TestFleetDirectoryTakesNoPOST: it is a read, and this surface's rule is that
// every mutation is a POST and every POST is on methodPolicy's allowlist. This
// path is not on it and must not become postable by accident.
func TestFleetDirectoryTakesNoPOST(t *testing.T) {
	ts, srv := newPairServer(t)
	srv.SetDirectorySnapshot(func(context.Context) ([]byte, error) { return []byte(`{}`), nil })

	req, err := http.NewRequest(http.MethodPost, ts.URL+FleetDirectoryPath, nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set(local.HeaderName, tok)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("POST %s: %v", FleetDirectoryPath, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusMethodNotAllowed {
		t.Errorf("POST %s = %d, want 405", FleetDirectoryPath, resp.StatusCode)
	}
}
