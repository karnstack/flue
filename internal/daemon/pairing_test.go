package daemon

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/karnstack/flue/internal/crypto"
	"github.com/karnstack/flue/internal/session"
	"github.com/karnstack/flue/internal/transport/local"
	"github.com/karnstack/flue/internal/wire"
)

// --- the pairing window ---

func TestPairingTokenRedeemsExactlyOnce(t *testing.T) {
	var p pairingState
	now := time.Now()
	token, _ := p.start(now)

	if !p.redeem(token, now) {
		t.Fatal("first redeem of a live token failed, want success")
	}
	if p.redeem(token, now) {
		t.Fatal("second redeem of the same token succeeded; the token is single-use")
	}
}

func TestPairingTokenIsURLSafeUnpaddedBase64(t *testing.T) {
	var p pairingState
	token, _ := p.start(time.Now())

	raw, err := base64.RawURLEncoding.DecodeString(token)
	if err != nil {
		t.Fatalf("token %q is not unpadded URL-safe base64: %v", token, err)
	}
	if len(raw) != 32 {
		t.Fatalf("token decodes to %d bytes, want 32", len(raw))
	}
	// The token is spliced into ?t= raw, so anything that would have to be
	// percent-encoded on the way there is a defect rather than a nuisance.
	if strings.ContainsAny(token, "+/=") {
		t.Fatalf("token %q carries characters that are not URL-safe", token)
	}
}

func TestPairingTokenExpires(t *testing.T) {
	now := time.Now()

	var live pairingState
	token, expires := live.start(now)
	if want := now.Add(PairingTTL); !expires.Equal(want) {
		t.Fatalf("expires = %v, want %v", expires, want)
	}
	if !live.redeem(token, expires.Add(-time.Nanosecond)) {
		t.Fatal("redeem an instant before the deadline failed, want success")
	}

	var dead pairingState
	token, expires = dead.start(now)
	if dead.redeem(token, expires) {
		t.Fatal("redeem at the deadline succeeded, want failure")
	}

	var later pairingState
	token, expires = later.start(now)
	if later.redeem(token, expires.Add(time.Second)) {
		t.Fatal("redeem after the deadline succeeded, want failure")
	}
}

// TestPairingWrongTokenBurnsTheWindow pins the find-and-delete discipline: the
// active window is cleared by any presentation, so a guess costs the window
// rather than buying another attempt.
func TestPairingWrongTokenBurnsTheWindow(t *testing.T) {
	var p pairingState
	now := time.Now()
	token, _ := p.start(now)

	if p.redeem("not-the-token", now) {
		t.Fatal("redeem of a wrong token succeeded")
	}
	if p.redeem(token, now) {
		t.Fatal("the real token still redeemed after a wrong guess; a guess must burn the window")
	}
}

func TestPairingStartTwiceOnlySecondRedeems(t *testing.T) {
	now := time.Now()

	var p pairingState
	first, _ := p.start(now)
	second, _ := p.start(now)
	if first == second {
		t.Fatal("two starts produced the same token")
	}
	if !p.redeem(second, now) {
		t.Fatal("the second token did not redeem, want success")
	}

	var q pairingState
	first, _ = q.start(now)
	q.start(now)
	if q.redeem(first, now) {
		t.Fatal("the superseded token redeemed, want failure")
	}
}

func TestPairingCancelClearsTheWindow(t *testing.T) {
	var p pairingState
	now := time.Now()
	token, _ := p.start(now)
	p.cancel()

	if p.redeem(token, now) {
		t.Fatal("a cancelled token redeemed, want failure")
	}
}

func TestPairingRedeemWithNoWindowFails(t *testing.T) {
	var p pairingState
	if p.redeem("anything", time.Now()) {
		t.Fatal("redeem with no active window succeeded")
	}
	if p.redeem("", time.Now()) {
		t.Fatal("redeem of an empty token with no active window succeeded")
	}
}

// --- POST /api/pair ---

func newPairServer(t *testing.T) (*httptest.Server, *Server) {
	t.Helper()
	dir := t.TempDir()
	key, err := crypto.LoadOrCreateStaticKey(dir)
	if err != nil {
		t.Fatalf("LoadOrCreateStaticKey: %v", err)
	}
	srv := New(session.NewRegistry(time.Now), nil, http.NotFoundHandler(), "test",
		Identity{Key: key, Devices: crypto.NewDeviceStore(dir)})
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)
	srv.SetAuth(local.NewAuth(tok, portOf(t, ts)))
	return ts, srv
}

func portOf(t *testing.T, ts *httptest.Server) int {
	t.Helper()
	u, err := url.Parse(ts.URL)
	if err != nil {
		t.Fatalf("parse %s: %v", ts.URL, err)
	}
	port, err := strconv.Atoi(u.Port())
	if err != nil {
		t.Fatalf("port of %s: %v", ts.URL, err)
	}
	return port
}

// deviceKey is a stand-in for a browser's static public key: 32 bytes, and
// different for each fill byte, so two devices are two identities.
func deviceKey(fill byte) []byte {
	k := make([]byte, 32)
	for i := range k {
		k[i] = fill
	}
	return k
}

// pairPost posts a pairing request the way the /pair page does: JSON body,
// the token as the only credential, and the daemon's own origin. An empty
// origin sends no Origin header at all, which is what a non-browser client
// does.
func pairPost(t *testing.T, ts *httptest.Server, origin, token, publicKey, label string) *http.Response {
	t.Helper()
	body, err := json.Marshal(map[string]string{
		"token":     token,
		"publicKey": publicKey,
		"label":     label,
	})
	if err != nil {
		t.Fatalf("marshal pairing request: %v", err)
	}
	req, err := http.NewRequest(http.MethodPost, ts.URL+PairPath, bytes.NewReader(body))
	if err != nil {
		t.Fatalf("NewRequest: %v", err)
	}
	req.Header.Set("Content-Type", "application/json")
	if origin != "" {
		req.Header.Set("Origin", origin)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("POST %s: %v", PairPath, err)
	}
	t.Cleanup(func() { resp.Body.Close() })
	return resp
}

func devices(t *testing.T, srv *Server) []crypto.Device {
	t.Helper()
	list, err := srv.identity.Devices.List()
	if err != nil {
		t.Fatalf("DeviceStore.List: %v", err)
	}
	return list
}

// TestPairRegistersTheDeviceExactlyOnce is the ceremony end to end over HTTP:
// an open window, a token, a key, and then nothing more from that token.
func TestPairRegistersTheDeviceExactlyOnce(t *testing.T) {
	ts, srv := newPairServer(t)
	token, _ := srv.pairing.start(time.Now())

	key := deviceKey(0x2a)
	encoded := base64.StdEncoding.EncodeToString(key)

	resp := pairPost(t, ts, ts.URL, token, encoded, "phone")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("pair = %d, want 200", resp.StatusCode)
	}
	var body struct {
		DeviceID  string `json:"deviceId"`
		DaemonPub string `json:"daemonPub"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatalf("decode pairing response: %v", err)
	}
	if want := crypto.DeviceID(key); body.DeviceID != want {
		t.Errorf("deviceId = %q, want %q", body.DeviceID, want)
	}
	if want := base64.StdEncoding.EncodeToString(srv.identity.Key.Public); body.DaemonPub != want {
		t.Errorf("daemonPub = %q, want the daemon's static public key %q", body.DaemonPub, want)
	}

	list := devices(t, srv)
	if len(list) != 1 {
		t.Fatalf("device count = %d, want 1", len(list))
	}
	if list[0].Label != "phone" {
		t.Errorf("label = %q, want %q", list[0].Label, "phone")
	}

	// The same token again buys nothing, and the second device is not paired.
	again := pairPost(t, ts, ts.URL, token, base64.StdEncoding.EncodeToString(deviceKey(0x3b)), "laptop")
	if again.StatusCode != http.StatusForbidden {
		t.Fatalf("replayed pairing = %d, want 403", again.StatusCode)
	}
	if n := len(devices(t, srv)); n != 1 {
		t.Fatalf("device count = %d after a replay, want 1", n)
	}
}

// TestPairRefusals covers every way in, other than the right one. None of them
// may register a device, and none of them may say more than "no".
func TestPairRefusals(t *testing.T) {
	good := base64.StdEncoding.EncodeToString(deviceKey(0x2a))

	cases := map[string]struct {
		open   bool // open a pairing window first
		origin func(ts *httptest.Server) string
		token  func(live string) string
		key    string
	}{
		"no active window": {
			open:   false,
			origin: func(ts *httptest.Server) string { return ts.URL },
			token:  func(string) string { return "Zm91cnRlZW4tY2hhcnM" },
			key:    good,
		},
		"unknown token": {
			open:   true,
			origin: func(ts *httptest.Server) string { return ts.URL },
			token:  func(string) string { return "Zm91cnRlZW4tY2hhcnM" },
			key:    good,
		},
		"foreign origin": {
			open:   true,
			origin: func(*httptest.Server) string { return "http://127.0.0.1:3000" },
			token:  func(live string) string { return live },
			key:    good,
		},
		"key is not base64": {
			open:   true,
			origin: func(ts *httptest.Server) string { return ts.URL },
			token:  func(live string) string { return live },
			key:    "not base64 at all!!",
		},
		"key is the wrong length": {
			open:   true,
			origin: func(ts *httptest.Server) string { return ts.URL },
			token:  func(live string) string { return live },
			key:    base64.StdEncoding.EncodeToString([]byte("too short")),
		},
		"no key at all": {
			open:   true,
			origin: func(ts *httptest.Server) string { return ts.URL },
			token:  func(live string) string { return live },
			key:    "",
		},
		"empty token": {
			open:   true,
			origin: func(ts *httptest.Server) string { return ts.URL },
			token:  func(string) string { return "" },
			key:    good,
		},
	}

	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			ts, srv := newPairServer(t)
			live := ""
			if tc.open {
				live, _ = srv.pairing.start(time.Now())
			}
			resp := pairPost(t, ts, tc.origin(ts), tc.token(live), tc.key, "phone")
			if resp.StatusCode != http.StatusForbidden {
				t.Errorf("pair = %d, want 403", resp.StatusCode)
			}
			if n := len(devices(t, srv)); n != 0 {
				t.Errorf("device count = %d, want 0", n)
			}
		})
	}
}

// TestPairRefusesAnExpiredToken drives the deadline through the handler rather
// than the state, so the wiring of the clock is covered too.
func TestPairRefusesAnExpiredToken(t *testing.T) {
	ts, srv := newPairServer(t)
	// Started two minutes and a second ago: the window opened, and closed.
	token, _ := srv.pairing.start(time.Now().Add(-PairingTTL - time.Second))

	resp := pairPost(t, ts, ts.URL, token, base64.StdEncoding.EncodeToString(deviceKey(0x2a)), "phone")
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("pair with an expired token = %d, want 403", resp.StatusCode)
	}
	if n := len(devices(t, srv)); n != 0 {
		t.Fatalf("device count = %d, want 0", n)
	}
}

// TestForeignOriginDoesNotBurnTheWindow is the reason the origin check runs
// before the token is ever compared: a drive-by page that can guess the URL
// shape must not be able to cancel the user's pairing from across the origin
// boundary.
func TestForeignOriginDoesNotBurnTheWindow(t *testing.T) {
	ts, srv := newPairServer(t)
	token, _ := srv.pairing.start(time.Now())

	key := base64.StdEncoding.EncodeToString(deviceKey(0x2a))
	if resp := pairPost(t, ts, "http://127.0.0.1:3000", token, key, "drive-by"); resp.StatusCode != http.StatusForbidden {
		t.Fatalf("cross-origin pair = %d, want 403", resp.StatusCode)
	}
	if resp := pairPost(t, ts, ts.URL, token, key, "phone"); resp.StatusCode != http.StatusOK {
		t.Fatalf("pair after a refused cross-origin attempt = %d, want 200", resp.StatusCode)
	}
}

// TestMalformedRequestDoesNotBurnTheWindow: the token is spent only by a
// request that is otherwise ready to succeed, so a client that fumbles its own
// key does not cost the user the pairing window.
func TestMalformedRequestDoesNotBurnTheWindow(t *testing.T) {
	ts, srv := newPairServer(t)
	token, _ := srv.pairing.start(time.Now())

	if resp := pairPost(t, ts, ts.URL, token, "not base64 at all!!", "phone"); resp.StatusCode != http.StatusForbidden {
		t.Fatalf("pair with a malformed key = %d, want 403", resp.StatusCode)
	}
	key := base64.StdEncoding.EncodeToString(deviceKey(0x2a))
	if resp := pairPost(t, ts, ts.URL, token, key, "phone"); resp.StatusCode != http.StatusOK {
		t.Fatalf("pair after a malformed attempt = %d, want 200", resp.StatusCode)
	}
}

// TestPairIsNotReachableByGET. Every GET on this daemon is read-only, and
// pairing is the one state change that lives outside the WebSocket — so it has
// to refuse the method a redirect can launder, in its own handler.
func TestPairIsNotReachableByGET(t *testing.T) {
	ts, srv := newPairServer(t)
	token, _ := srv.pairing.start(time.Now())

	req, err := http.NewRequest(http.MethodGet,
		ts.URL+PairPath+"?token="+token+"&publicKey="+url.QueryEscape(base64.StdEncoding.EncodeToString(deviceKey(0x2a))), nil)
	if err != nil {
		t.Fatalf("NewRequest: %v", err)
	}
	req.Header.Set("Sec-Fetch-Site", "none")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("GET %s: %v", PairPath, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusMethodNotAllowed {
		t.Errorf("GET %s = %d, want 405", PairPath, resp.StatusCode)
	}
	if n := len(devices(t, srv)); n != 0 {
		t.Errorf("device count = %d after a GET, want 0", n)
	}
}

// TestPairWithoutAnIdentityIsRefused: a daemon with no static key and no
// device registry cannot pair, and must say so by refusing rather than by
// panicking or by pretending to have paired something.
func TestPairWithoutAnIdentityIsRefused(t *testing.T) {
	ts, _ := newTestServer(t)
	resp := pairPost(t, ts, ts.URL, "Zm91cnRlZW4tY2hhcnM",
		base64.StdEncoding.EncodeToString(deviceKey(0x2a)), "phone")
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("pair on a daemon with no identity = %d, want 403", resp.StatusCode)
	}
}

// --- pairStart / pairCancel over the WebSocket ---

// TestPairStartAnswersPairing walks the whole ceremony: an authenticated
// client opens the window, and the URL it is handed is the one the second
// device can actually post to.
func TestPairStartAnswersPairing(t *testing.T) {
	ts, srv := newPairServer(t)
	c := dial(t, ts)
	writeControl(t, c, wire.Hello{Ver: "test"})
	writeControl(t, c, wire.PairStart{})

	var got wire.Pairing
	readUntil(t, c, func(msg any, _ []byte) bool {
		p, ok := msg.(wire.Pairing)
		if ok {
			got = p
		}
		return ok
	})

	if got.Token == "" {
		t.Fatal("pairing carried no token")
	}
	if want := ts.URL + "/pair?t=" + got.Token; got.URL != want {
		t.Errorf("url = %q, want %q", got.URL, want)
	}
	if want := base64.StdEncoding.EncodeToString(srv.identity.Key.Public); got.DaemonPub != want {
		t.Errorf("daemonPub = %q, want %q", got.DaemonPub, want)
	}
	if delta := time.Until(time.Unix(got.ExpiresAt, 0)); delta > PairingTTL+time.Second || delta < PairingTTL-time.Minute {
		t.Errorf("expiresAt is %v away, want about %v", delta, PairingTTL)
	}

	resp := pairPost(t, ts, ts.URL, got.Token, base64.StdEncoding.EncodeToString(deviceKey(0x2a)), "phone")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("pair with the token pairStart handed out = %d, want 200", resp.StatusCode)
	}
	if n := len(devices(t, srv)); n != 1 {
		t.Fatalf("device count = %d, want 1", n)
	}
}

func TestPairCancelInvalidatesTheToken(t *testing.T) {
	ts, srv := newPairServer(t)
	c := dial(t, ts)
	writeControl(t, c, wire.Hello{Ver: "test"})
	writeControl(t, c, wire.PairStart{})

	var got wire.Pairing
	readUntil(t, c, func(msg any, _ []byte) bool {
		p, ok := msg.(wire.Pairing)
		if ok {
			got = p
		}
		return ok
	})

	writeControl(t, c, wire.PairCancel{})
	// pairCancel has no reply, so bounce a list off the daemon to know the
	// cancel has been processed before the POST goes out.
	writeControl(t, c, wire.List{})
	readUntil(t, c, func(msg any, _ []byte) bool {
		_, ok := msg.(wire.Sessions)
		return ok
	})

	resp := pairPost(t, ts, ts.URL, got.Token, base64.StdEncoding.EncodeToString(deviceKey(0x2a)), "phone")
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("pair after pairCancel = %d, want 403", resp.StatusCode)
	}
	if n := len(devices(t, srv)); n != 0 {
		t.Fatalf("device count = %d, want 0", n)
	}
}

// TestPairStartWithoutAnIdentityErrors: pairing is refused rather than
// answered with a token no device could ever complete the handshake against.
func TestPairStartWithoutAnIdentityErrors(t *testing.T) {
	ts, _ := newTestServer(t)
	c := dial(t, ts)
	writeControl(t, c, wire.Hello{Ver: "test"})
	writeControl(t, c, wire.PairStart{})

	readUntil(t, c, func(msg any, _ []byte) bool {
		switch m := msg.(type) {
		case wire.Pairing:
			t.Fatalf("a daemon with no static key answered pairStart with %+v", m)
		case wire.Error:
			return true
		}
		return false
	})
}
