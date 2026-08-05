package daemon

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"io"
	"log/slog"
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

	if got := p.redeem(token, now); got != pairAccepted {
		t.Fatalf("first redeem of a live token = %v, want accepted", got)
	}
	if got := p.redeem(token, now); got != pairNoWindow {
		t.Fatalf("second redeem of the same token = %v, want no window; the token is single-use", got)
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
	if got := live.redeem(token, expires.Add(-time.Nanosecond)); got != pairAccepted {
		t.Fatalf("redeem an instant before the deadline = %v, want accepted", got)
	}

	var dead pairingState
	token, expires = dead.start(now)
	if got := dead.redeem(token, expires); got != pairExpired {
		t.Fatalf("redeem at the deadline = %v, want expired", got)
	}

	var later pairingState
	token, expires = later.start(now)
	if got := later.redeem(token, expires.Add(time.Second)); got != pairExpired {
		t.Fatalf("redeem after the deadline = %v, want expired", got)
	}
}

// TestPairingWrongTokenBurnsTheWindow pins the find-and-delete discipline: the
// active window is cleared by any presentation, so a guess costs the window
// rather than buying another attempt.
func TestPairingWrongTokenBurnsTheWindow(t *testing.T) {
	var p pairingState
	now := time.Now()
	token, _ := p.start(now)

	if got := p.redeem("not-the-token", now); got != pairWrongToken {
		t.Fatalf("redeem of a wrong token = %v, want wrong token", got)
	}
	if got := p.redeem(token, now); got != pairNoWindow {
		t.Fatalf("the real token after a wrong guess = %v, want no window; a guess must burn it", got)
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
	if got := p.redeem(second, now); got != pairAccepted {
		t.Fatalf("the second token = %v, want accepted", got)
	}

	var q pairingState
	first, _ = q.start(now)
	q.start(now)
	if got := q.redeem(first, now); got != pairWrongToken {
		t.Fatalf("the superseded token = %v, want wrong token", got)
	}
}

func TestPairingCancelClearsTheWindow(t *testing.T) {
	var p pairingState
	now := time.Now()
	token, _ := p.start(now)
	p.cancel()

	if got := p.redeem(token, now); got != pairNoWindow {
		t.Fatalf("a cancelled token = %v, want no window", got)
	}
}

func TestPairingRedeemWithNoWindowFails(t *testing.T) {
	var p pairingState
	if got := p.redeem("anything", time.Now()); got != pairNoWindow {
		t.Fatalf("redeem with no active window = %v, want no window", got)
	}
	if got := p.redeem("", time.Now()); got != pairNoWindow {
		t.Fatalf("redeem of an empty token with no active window = %v, want no window", got)
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

// TestPairRefusalReasonsAreLoggedApart is the other half of the uniform 403.
// The caller must not be able to tell the three failures apart; whoever reads
// the daemon's log must. "Someone probed an endpoint that was inert" and
// "someone presented a wrong token against a window the user had open, and
// burned it" are the same answer over HTTP and very different events, and an
// audit trail that collapses them cannot be used to notice the second.
func TestPairRefusalReasonsAreLoggedApart(t *testing.T) {
	key := base64.StdEncoding.EncodeToString(deviceKey(0x2a))

	for name, tc := range map[string]struct {
		open  time.Duration // how long ago the window was opened; 0 for none
		token func(live string) string
		want  string
	}{
		"no window": {
			token: func(string) string { return "Zm91cnRlZW4tY2hhcnM" },
			want:  pairNoWindow.String(),
		},
		"wrong token against a live window": {
			open:  time.Second,
			token: func(string) string { return "Zm91cnRlZW4tY2hhcnM" },
			want:  pairWrongToken.String(),
		},
		"expired window": {
			open:  PairingTTL + time.Second,
			token: func(live string) string { return live },
			want:  pairExpired.String(),
		},
	} {
		t.Run(name, func(t *testing.T) {
			ts, srv := newPairServer(t)
			buf := &syncBuffer{}
			srv.SetLogger(slog.New(slog.NewTextHandler(buf, nil)))

			live := ""
			if tc.open != 0 {
				live, _ = srv.pairing.start(time.Now().Add(-tc.open))
			}
			resp := pairPost(t, ts, ts.URL, tc.token(live), key, "phone")
			if resp.StatusCode != http.StatusForbidden {
				t.Fatalf("pair = %d, want 403", resp.StatusCode)
			}

			want := "reason=" + strconv.Quote(tc.want)
			if !logLineContains(buf, "pairing refused", want) {
				t.Errorf("no refusal logged with %s; log:\n%s", want, buf.String())
			}
			// The reason belongs to the log and nowhere else.
			body, err := io.ReadAll(resp.Body)
			if err != nil {
				t.Fatalf("read body: %v", err)
			}
			if strings.Contains(string(body), tc.want) {
				t.Errorf("the response body leaked the refusal reason: %q", body)
			}
		})
	}
}

// TestEveryPairRefusalAnswersTheSameBytes is the invariant the log has to be
// specific *instead of*: however the request was wrong, and whether or not a
// token had ever existed, the answer is one status and one body. Anything that
// varies here is an oracle for the user's live pairing ceremony.
func TestEveryPairRefusalAnswersTheSameBytes(t *testing.T) {
	good := base64.StdEncoding.EncodeToString(deviceKey(0x2a))

	// Each case is (open a window?, origin, token, key) and every one of them
	// must produce byte-identical output.
	cases := []struct {
		name   string
		open   time.Duration
		origin func(ts *httptest.Server) string
		token  func(live string) string
		key    string
	}{
		{"no window", 0, func(ts *httptest.Server) string { return ts.URL }, func(string) string { return "Zm91cnRlZW4tY2hhcnM" }, good},
		{"wrong token", time.Second, func(ts *httptest.Server) string { return ts.URL }, func(string) string { return "Zm91cnRlZW4tY2hhcnM" }, good},
		{"expired", PairingTTL + time.Second, func(ts *httptest.Server) string { return ts.URL }, func(live string) string { return live }, good},
		{"foreign origin", time.Second, func(*httptest.Server) string { return "http://127.0.0.1:3000" }, func(live string) string { return live }, good},
		{"malformed key", time.Second, func(ts *httptest.Server) string { return ts.URL }, func(live string) string { return live }, "not base64 at all!!"},
		{"no token", time.Second, func(ts *httptest.Server) string { return ts.URL }, func(string) string { return "" }, good},
	}

	var first []byte
	var firstName string
	for _, tc := range cases {
		ts, srv := newPairServer(t)
		live := ""
		if tc.open != 0 {
			live, _ = srv.pairing.start(time.Now().Add(-tc.open))
		}
		resp := pairPost(t, ts, tc.origin(ts), tc.token(live), tc.key, "phone")
		if resp.StatusCode != http.StatusForbidden {
			t.Fatalf("%s: pair = %d, want 403", tc.name, resp.StatusCode)
		}
		body, err := io.ReadAll(resp.Body)
		if err != nil {
			t.Fatalf("%s: read body: %v", tc.name, err)
		}
		if first == nil {
			first, firstName = body, tc.name
			continue
		}
		if !bytes.Equal(body, first) {
			t.Errorf("%s answered %q but %s answered %q; every refusal must answer the same bytes",
				tc.name, body, firstName, first)
		}
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
