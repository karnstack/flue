package daemon

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/karnstack/flue/internal/crypto"
	"github.com/karnstack/flue/internal/session"
	"github.com/karnstack/flue/internal/transport/local"
	"github.com/karnstack/flue/internal/wire"
	"github.com/karnstack/flue/web"
)

const tok = "0123456789abcdef"

func newTestServer(t *testing.T) (*httptest.Server, *session.Registry) {
	t.Helper()
	ts, reg, _ := newTestServerUI(t, http.NotFoundHandler())
	return ts, reg
}

// newTestServerShippedUI is newTestServer with the UI the binary actually
// ships — the embedded Vite build — rather than a stub.
//
// It exists because http.NotFoundHandler() is not a neutral stand-in for the
// UI. It 404s every path no route claimed, which is the answer some of the
// assertions here are looking for, so a test that injects it can pass without
// the daemon doing anything at all. web.Handler serves index.html for unknown
// paths, so it is the handler that can turn "no such endpoint" into 200
// text/html — and it is the one that ships.
func newTestServerShippedUI(t *testing.T) (*httptest.Server, *session.Registry) {
	t.Helper()
	ts, reg, _ := newTestServerUI(t, web.Handler())
	return ts, reg
}

// newTestServerUI is newTestServer with the UI handler and the *Server exposed,
// for the tests that need to observe what the app shell actually served or to
// drive the server directly.
func newTestServerUI(t *testing.T, ui http.Handler) (*httptest.Server, *session.Registry, *Server) {
	t.Helper()
	reg := session.NewRegistry(time.Now)
	srv := New(reg, nil, ui, "test", Identity{})

	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)

	// Rebuild auth against the port httptest actually chose.
	srv.SetAuth(local.NewAuth(tok, tsPort(ts)))
	return ts, reg, srv
}

// tsPort is the port httptest actually chose.
func tsPort(ts *httptest.Server) int {
	port := 0
	if _, p, ok := strings.Cut(strings.TrimPrefix(ts.URL, "http://"), ":"); ok {
		for _, c := range p {
			port = port*10 + int(c-'0')
		}
	}
	return port
}

// tsCookie is the session cookie's name for that port; the name carries the
// port (local.CookieNameFor), so a test that speaks cookies derives it from
// the server it is talking to.
func tsCookie(ts *httptest.Server) string {
	return local.CookieNameFor(tsPort(ts))
}

func dial(t *testing.T, ts *httptest.Server) *websocket.Conn {
	t.Helper()
	return dialWith(t, ts, nil)
}

// dialWith opens a WebSocket authenticated the way a non-browser client now
// has to: the session token in a request header. The query string is no longer
// a credential carrier anywhere on this daemon.
func dialWith(t *testing.T, ts *httptest.Server, header http.Header) *websocket.Conn {
	t.Helper()
	url := "ws" + strings.TrimPrefix(ts.URL, "http") + "/ws"
	if header == nil {
		header = http.Header{}
	} else {
		header = header.Clone()
	}
	header.Set(local.HeaderName, tok)
	c, _, err := websocket.Dial(context.Background(), url, &websocket.DialOptions{HTTPHeader: header})
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	t.Cleanup(func() { c.Close(websocket.StatusNormalClosure, "") })
	return c
}

func writeControl(t *testing.T, c *websocket.Conn, msg any) {
	t.Helper()
	b, err := wire.EncodeControl(msg)
	if err != nil {
		t.Fatalf("EncodeControl: %v", err)
	}
	if err := c.Write(context.Background(), websocket.MessageText, b); err != nil {
		t.Fatalf("write: %v", err)
	}
}

// readUntil reads frames until pred returns true or the deadline passes.
// Binary payloads are accumulated so callers can assert on output.
func readUntil(t *testing.T, c *websocket.Conn, pred func(msg any, out []byte) bool) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	var out []byte
	for {
		typ, data, err := c.Read(ctx)
		if err != nil {
			t.Fatalf("read: %v (output so far %q)", err, out)
		}
		if typ == websocket.MessageBinary {
			_, _, payload, err := wire.DecodeBinary(data)
			if err != nil {
				t.Fatalf("DecodeBinary: %v", err)
			}
			out = append(out, payload...)
			if pred(nil, out) {
				return
			}
			continue
		}
		msg, err := wire.DecodeControl(data)
		if err != nil {
			t.Fatalf("DecodeControl: %v", err)
		}
		if pred(msg, out) {
			return
		}
	}
}

// attach dials, says hello, attaches to s and returns the ref the daemon
// assigned.
func attach(t *testing.T, ts *httptest.Server, id string) (*websocket.Conn, uint32) {
	t.Helper()
	c := dial(t, ts)
	writeControl(t, c, wire.Hello{Ver: "test"})
	writeControl(t, c, wire.Attach{ID: id, LastSeq: 0})
	var ref uint32
	readUntil(t, c, func(msg any, _ []byte) bool {
		a, ok := msg.(wire.Attached)
		if ok {
			ref = a.Ref
		}
		return ok
	})
	return c, ref
}

func TestWebSocketRejectsUnauthenticated(t *testing.T) {
	ts, _ := newTestServer(t)
	url := "ws" + strings.TrimPrefix(ts.URL, "http") + "/ws"
	if _, _, err := websocket.Dial(context.Background(), url, nil); err == nil {
		t.Fatal("dial without a token succeeded, want failure")
	}
}

func TestHelloReturnsWelcome(t *testing.T) {
	ts, _ := newTestServer(t)
	c := dial(t, ts)
	writeControl(t, c, wire.Hello{Ver: "test"})
	readUntil(t, c, func(msg any, _ []byte) bool {
		_, ok := msg.(wire.Welcome)
		return ok
	})
}

func TestSpawnAttachAndOutput(t *testing.T) {
	ts, _ := newTestServer(t)
	c := dial(t, ts)

	writeControl(t, c, wire.Hello{Ver: "test"})
	writeControl(t, c, wire.Spawn{Cmd: []string{"sh", "-c", "echo spawned-ok; sleep 2"}, Cols: 80, Rows: 24})

	readUntil(t, c, func(msg any, out []byte) bool {
		return bytes.Contains(out, []byte("spawned-ok"))
	})
}

func TestAttachedCarriesRefAndSeq(t *testing.T) {
	ts, reg := newTestServer(t)
	s, err := reg.Spawn(session.SpawnOpts{Cmd: []string{"sleep", "2"}, Cols: 80, Rows: 24})
	if err != nil {
		t.Fatalf("Spawn: %v", err)
	}
	defer s.Close()

	c := dial(t, ts)
	writeControl(t, c, wire.Hello{Ver: "test"})
	writeControl(t, c, wire.Attach{ID: s.ID(), LastSeq: 0})

	readUntil(t, c, func(msg any, _ []byte) bool {
		a, ok := msg.(wire.Attached)
		if !ok {
			return false
		}
		if a.ID != s.ID() {
			t.Fatalf("Attached.ID = %q, want %q", a.ID, s.ID())
		}
		if !a.Primary {
			t.Fatal("first attacher Primary = false, want true")
		}
		return true
	})
}

func TestInputReachesPTYAndMirrorsToBothClients(t *testing.T) {
	ts, reg := newTestServer(t)
	s, err := reg.Spawn(session.SpawnOpts{Cmd: []string{"cat"}, Cols: 80, Rows: 24})
	if err != nil {
		t.Fatalf("Spawn: %v", err)
	}
	defer s.Close()

	var refs [2]uint32
	conns := [2]*websocket.Conn{dial(t, ts), dial(t, ts)}
	for i, c := range conns {
		writeControl(t, c, wire.Hello{Ver: "test"})
		writeControl(t, c, wire.Attach{ID: s.ID(), LastSeq: 0})
		idx := i
		readUntil(t, c, func(msg any, _ []byte) bool {
			a, ok := msg.(wire.Attached)
			if ok {
				refs[idx] = a.Ref
			}
			return ok
		})
	}

	frame := wire.EncodeBinary(wire.FrameInput, refs[0], []byte("mirrored\n"))
	if err := conns[0].Write(context.Background(), websocket.MessageBinary, frame); err != nil {
		t.Fatalf("write input: %v", err)
	}

	for _, c := range conns {
		readUntil(t, c, func(_ any, out []byte) bool {
			return bytes.Contains(out, []byte("mirrored"))
		})
	}
}

func TestSecondAttacherIsNotPrimary(t *testing.T) {
	ts, reg := newTestServer(t)
	s, err := reg.Spawn(session.SpawnOpts{Cmd: []string{"sleep", "2"}, Cols: 80, Rows: 24})
	if err != nil {
		t.Fatalf("Spawn: %v", err)
	}
	defer s.Close()

	first := dial(t, ts)
	writeControl(t, first, wire.Hello{Ver: "test"})
	writeControl(t, first, wire.Attach{ID: s.ID(), LastSeq: 0})
	readUntil(t, first, func(msg any, _ []byte) bool { _, ok := msg.(wire.Attached); return ok })

	second := dial(t, ts)
	writeControl(t, second, wire.Hello{Ver: "test"})
	writeControl(t, second, wire.Attach{ID: s.ID(), LastSeq: 0})
	readUntil(t, second, func(msg any, _ []byte) bool {
		a, ok := msg.(wire.Attached)
		if ok && a.Primary {
			t.Fatal("second attacher Primary = true, want false")
		}
		return ok
	})
}

// TestPtySizeFollowsTheActiveView pins the sizing policy: the PTY wears the
// fitted size of the most recently active view — attaching, reporting a size,
// typing and signalling all count as activity. A phone that attaches beside a
// laptop gets a phone-sized terminal the moment it reports, and the laptop
// takes the size back with its first keystroke, no re-report needed.
//
// The session ignores SIGINT rather than sleeping plainly, because the signal
// step below is asserting that a signal is *activity* and nothing else: every
// signal a client may send ends the process group, and a session that died
// mid-test would tear both attachments down and race the assertions that
// follow. An ignored disposition survives exec, so the `sleep` inherits it and
// the whole group shrugs the interrupt off.
func TestPtySizeFollowsTheActiveView(t *testing.T) {
	ts, reg := newTestServer(t)
	s, err := reg.Spawn(session.SpawnOpts{
		Cmd: []string{"sh", "-c", "trap '' INT; sleep 30"}, Cols: 80, Rows: 24,
	})
	if err != nil {
		t.Fatalf("Spawn: %v", err)
	}
	defer s.Close()

	laptop := dial(t, ts)
	writeControl(t, laptop, wire.Hello{Ver: "test"})
	writeControl(t, laptop, wire.Attach{ID: s.ID(), LastSeq: 0})
	var laptopRef uint32
	readUntil(t, laptop, func(msg any, _ []byte) bool {
		a, ok := msg.(wire.Attached)
		if ok {
			laptopRef = a.Ref
		}
		return ok
	})
	writeControl(t, laptop, wire.Resize{Ref: laptopRef, Cols: 120, Rows: 40, Primary: true})
	waitFor(t, func() bool { return s.Info().Cols == 120 && s.Info().Rows == 40 })

	phone := dial(t, ts)
	writeControl(t, phone, wire.Hello{Ver: "test"})
	writeControl(t, phone, wire.Attach{ID: s.ID(), LastSeq: 0})
	var phoneRef uint32
	readUntil(t, phone, func(msg any, _ []byte) bool {
		a, ok := msg.(wire.Attached)
		if ok {
			phoneRef = a.Ref
		}
		return ok
	})

	// The phone just attached and reported, which makes it the active view:
	// the PTY reshapes to the phone rather than staying with the largest.
	writeControl(t, phone, wire.Resize{Ref: phoneRef, Cols: 40, Rows: 10, Primary: false})
	waitFor(t, func() bool { return s.Info().Cols == 40 && s.Info().Rows == 10 })

	// A keystroke on the laptop moves the activity back; its recorded desire
	// is applied without the laptop re-reporting anything.
	frame := wire.EncodeBinary(wire.FrameInput, laptopRef, []byte("k"))
	if err := laptop.Write(context.Background(), websocket.MessageBinary, frame); err != nil {
		t.Fatalf("write input: %v", err)
	}
	waitFor(t, func() bool { return s.Info().Cols == 120 && s.Info().Rows == 40 })

	// A signal is activity too — the phone reaching for Ctrl-C is a hand on
	// the phone — so it takes the size back on its recorded desire alone,
	// having neither typed nor reported anything since.
	writeControl(t, phone, wire.Signal{Ref: phoneRef, Sig: "SIGINT"})
	waitFor(t, func() bool { return s.Info().Cols == 40 && s.Info().Rows == 10 })

	// The phone's keyboard opening is a fresh report, and a report is
	// activity: the size follows the phone again.
	writeControl(t, phone, wire.Resize{Ref: phoneRef, Cols: 40, Rows: 15, Primary: false})
	waitFor(t, func() bool { return s.Info().Cols == 40 && s.Info().Rows == 15 })

	// The phone leaves; the laptop is what remains, and its desire returns
	// without anyone asking again.
	writeControl(t, phone, wire.Detach{Ref: phoneRef})
	waitFor(t, func() bool { return s.Info().Cols == 120 && s.Info().Rows == 40 })
}

// waitFor polls cond briefly; the daemon's side of these flows is
// asynchronous but fast.
func waitFor(t *testing.T, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("condition never became true")
}

func TestPrimarySeizureResizesPTY(t *testing.T) {
	ts, reg := newTestServer(t)
	s, err := reg.Spawn(session.SpawnOpts{Cmd: []string{"sleep", "2"}, Cols: 80, Rows: 24})
	if err != nil {
		t.Fatalf("Spawn: %v", err)
	}
	defer s.Close()

	c := dial(t, ts)
	writeControl(t, c, wire.Hello{Ver: "test"})
	writeControl(t, c, wire.Attach{ID: s.ID(), LastSeq: 0})
	var ref uint32
	readUntil(t, c, func(msg any, _ []byte) bool {
		a, ok := msg.(wire.Attached)
		if ok {
			ref = a.Ref
		}
		return ok
	})

	writeControl(t, c, wire.Resize{Ref: ref, Cols: 120, Rows: 40, Primary: true})

	deadline := time.After(3 * time.Second)
	for s.Info().Cols != 120 {
		select {
		case <-deadline:
			t.Fatalf("Cols = %d, want 120", s.Info().Cols)
		case <-time.After(10 * time.Millisecond):
		}
	}
}

func TestListReturnsSessions(t *testing.T) {
	ts, reg := newTestServer(t)
	s, err := reg.Spawn(session.SpawnOpts{Cmd: []string{"sleep", "2"}, Cols: 80, Rows: 24})
	if err != nil {
		t.Fatalf("Spawn: %v", err)
	}
	defer s.Close()

	c := dial(t, ts)
	writeControl(t, c, wire.Hello{Ver: "test"})
	writeControl(t, c, wire.List{})
	readUntil(t, c, func(msg any, _ []byte) bool {
		l, ok := msg.(wire.Sessions)
		if !ok {
			return false
		}
		for _, info := range l.Sessions {
			if info.ID == s.ID() {
				return true
			}
		}
		return false
	})
}

func TestAttachUnknownSessionReturnsError(t *testing.T) {
	ts, _ := newTestServer(t)
	c := dial(t, ts)
	writeControl(t, c, wire.Hello{Ver: "test"})
	writeControl(t, c, wire.Attach{ID: "does-not-exist"})
	readUntil(t, c, func(msg any, _ []byte) bool {
		e, ok := msg.(wire.Error)
		return ok && e.Code == "not_found"
	})
}

func TestHTTPSessionsEndpointRequiresAuth(t *testing.T) {
	ts, _ := newTestServer(t)
	resp, err := http.Get(ts.URL + "/api/sessions")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusOK {
		t.Fatal("status = 200 without a token, want a rejection")
	}
}

func TestHTTPSessionsEndpointWithAuth(t *testing.T) {
	ts, reg := newTestServer(t)
	s, err := reg.Spawn(session.SpawnOpts{Cmd: []string{"sleep", "2"}, Cols: 80, Rows: 24})
	if err != nil {
		t.Fatalf("Spawn: %v", err)
	}
	defer s.Close()

	resp := get(t, ts, "/api/sessions", "same-origin")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}
	var got struct {
		Sessions []session.Info `json:"sessions"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(got.Sessions) == 0 {
		t.Fatal("sessions is empty, want at least one")
	}
}

// --- carried constraint 1: no mutation reachable by GET ---

// get issues an authenticated GET the way a redirect-laundered navigation
// would: valid cookie, correct Host, no Origin, and Sec-Fetch-Site: none.
// Task 5's Check passes every one of those, which is precisely why the
// endpoint policy — not the token check — has to be what stops it.
func get(t *testing.T, ts *httptest.Server, path, fetchSite string) *http.Response {
	t.Helper()
	req, err := http.NewRequest(http.MethodGet, ts.URL+path, nil)
	if err != nil {
		t.Fatalf("NewRequest: %v", err)
	}
	req.AddCookie(&http.Cookie{Name: tsCookie(ts), Value: tok})
	if fetchSite != "" {
		req.Header.Set("Sec-Fetch-Site", fetchSite)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("do %s: %v", path, err)
	}
	t.Cleanup(func() { resp.Body.Close() })
	return resp
}

// TestNoStateChangeIsReachableByGET is the structural half of the
// redirect-laundered-Sec-Fetch-Site defence. A co-resident untrusted origin
// (an unrelated dev server on another loopback port) can answer a
// user-initiated navigation with 302 -> http://127.0.0.1:<flue>/<path>, and
// the redirected request arrives carrying Sec-Fetch-Site: none, no Origin, a
// correct Host and the flue_token cookie — every check in Task 5 passes. The
// only durable answer is that no URL, GET-fetchable or otherwise, changes any
// state: every mutation lives behind an established WebSocket.
//
// It runs against the shipped UI. With http.NotFoundHandler() standing in, the
// absentAPI block below passes because the stub 404s everything, and proves
// nothing about a binary whose UI answers unknown paths with the app shell.
func TestNoStateChangeIsReachableByGET(t *testing.T) {
	ts, reg := newTestServerShippedUI(t)
	s, err := reg.Spawn(session.SpawnOpts{Cmd: []string{"sleep", "5"}, Cols: 80, Rows: 24})
	if err != nil {
		t.Fatalf("Spawn: %v", err)
	}
	defer s.Close()

	// No such API endpoint may exist at all: a 2xx would mean something
	// answered. The assertion is scoped to /api/ on purpose, and the daemon
	// reserves that namespace for exactly this reason: everything under it that
	// no route claimed is refused on the mux, so the SPA fallback never gets to
	// turn an absent endpoint into 200 text/html. Outside /api/ an unknown URL
	// legitimately answers with the shell — asserting otherwise there would
	// leave a trap that fails for a reason unrelated to what this test guards.
	absentAPI := []string{
		"/api/spawn",
		"/api/spawn?cmd=sh",
		"/api/sessions/" + s.ID() + "/kill",
		"/api/sessions/" + s.ID() + "/signal?sig=SIGKILL",
		"/api/sessions/" + s.ID() + "?method=delete",
		"/api/sessions/" + s.ID() + "/resize?cols=1&rows=1",
	}
	for _, p := range absentAPI {
		resp := get(t, ts, p, "none")
		if resp.StatusCode >= 200 && resp.StatusCode < 300 {
			t.Errorf("GET %s = %d; no mutating URL may answer 2xx", p, resp.StatusCode)
		}
	}

	// Whatever these answer — the app shell for the three outside /api/, a
	// session listing for the two that carry an ignored query — none of them may
	// change anything. That assertion is independent of what the UI handler
	// does, which is what makes it the durable one.
	outside := []string{
		"/spawn",
		"/kill?id=" + s.ID(),
		"/api/sessions?spawn=1",
		"/api/sessions?kill=" + s.ID(),
		"/?spawn=1",
	}
	for _, p := range outside {
		get(t, ts, p, "none")
	}

	if n := len(reg.List()); n != 1 {
		t.Fatalf("session count = %d after %d authenticated GETs, want 1", n, len(absentAPI)+len(outside))
	}
	if got := reg.List()[0].Info(); got.State != "running" {
		t.Fatalf("session state = %q after authenticated GETs, want %q", got.State, "running")
	}
	if got := s.Info().Cols; got != 80 {
		t.Fatalf("Cols = %d after authenticated GETs, want 80", got)
	}
}

// TestCookieExchangeNeverStoresAClientSuppliedToken covers the one piece of
// state a GET on this daemon really can change: the browser's stored
// credential. The exchange must only ever write the daemon's own session token
// into the cookie. If it echoed anything from the request instead, a
// redirect-laundered navigation could overwrite a working credential with
// garbage and lock the user out of their own terminal — or, far worse, fix the
// victim's browser onto a value the attacker chose. The value is a constant
// picked by the daemon, which is what makes session fixation structurally
// impossible here.
func TestCookieExchangeNeverStoresAClientSuppliedToken(t *testing.T) {
	ts, _, srv := newTestServerUI(t, http.NotFoundHandler())

	for _, path := range []string{"/?h=not-a-handoff", "/?t=" + tok, "/?h=" + tok} {
		resp := get(t, ts, path, "none")
		for _, c := range resp.Cookies() {
			if c.Name == tsCookie(ts) && c.Value != tok {
				t.Fatalf("GET %s set %s to the client-supplied %q, want the daemon's own token",
					path, tsCookie(ts), c.Value)
			}
		}
	}

	// The negative above is satisfied by setting no cookie at all, so pin the
	// positive too: the first-load flow must still hand the token to the
	// browser, or the app works once and never again.
	h, err := srv.currentAuth().Mint()
	if err != nil {
		t.Fatalf("Mint: %v", err)
	}
	resp := get(t, ts, "/?"+local.HandoffParam+"="+h, "none")
	var found *http.Cookie
	for _, c := range resp.Cookies() {
		if c.Name == tsCookie(ts) {
			found = c
		}
	}
	if found == nil {
		t.Fatalf("first load with a handoff token set no %s cookie", tsCookie(ts))
	}
	if found.Value != tok {
		t.Fatalf("%s cookie = %q, want the daemon's token", tsCookie(ts), found.Value)
	}
	if !found.HttpOnly {
		t.Error("cookie HttpOnly = false, want true")
	}
}

// TestOnlySafeMethodsAreRouted pins the invariant the test above depends on:
// flue's HTTP surface is read-only apart from two explicitly allowlisted POST
// paths — the mint and the pairing ceremony — so a mutation cannot be bolted
// onto it by a later task without this failing first.
//
// OPTIONS is in the list for every path including those two, and that is
// load-bearing rather than tidy: a CORS preflight that never succeeds is what
// stops a browser from ever sending a cross-origin request carrying the
// X-Flue-Token header that authenticates a mint.
func TestOnlySafeMethodsAreRouted(t *testing.T) {
	ts, _ := newTestServer(t)
	// PairPagePath and uiAssetPrefix are in the list because they are the two
	// paths served without a session token: an exemption from the credential
	// must not become an exemption from the method policy as well.
	for _, path := range []string{"/", "/api/sessions", "/ws", MintPath, PairPath, PairPagePath, uiAssetPrefix} {
		for _, method := range []string{http.MethodPost, http.MethodPut, http.MethodPatch, http.MethodDelete, http.MethodOptions} {
			if (path == MintPath || path == PairPath) && method == http.MethodPost {
				continue // the allowlisted exceptions; see TestPOSTIsRoutedOnlyToTheMintPath
			}
			req, err := http.NewRequest(method, ts.URL+path, nil)
			if err != nil {
				t.Fatalf("NewRequest: %v", err)
			}
			req.Header.Set("Sec-Fetch-Site", "same-origin")
			resp, err := http.DefaultClient.Do(req)
			if err != nil {
				t.Fatalf("%s %s: %v", method, path, err)
			}
			resp.Body.Close()
			if resp.StatusCode != http.StatusMethodNotAllowed {
				t.Errorf("%s %s = %d, want 405", method, path, resp.StatusCode)
			}
		}
	}
}

// TestPOSTIsRoutedOnlyToTheMintPath pins the width of the exception, which is
// exactly two paths wide: MintPath and PairPath. A POST to any other path —
// including one that only differs by path normalisation, which http.ServeMux
// would clean before matching — must be refused before it reaches a handler.
func TestPOSTIsRoutedOnlyToTheMintPath(t *testing.T) {
	ts, _ := newTestServer(t)
	for _, path := range []string{
		"/",
		"/api/sessions",
		"/ws",
		"/api/handoff/",
		"/api/handoff/x",
		"/api/./handoff",
		"//api/handoff",
		"/api/pair/",
		"/api/pair/x",
		"/api/./pair",
		"//api/pair",
		"/api/spawn",
	} {
		req, err := http.NewRequest(http.MethodPost, ts.URL+path, nil)
		if err != nil {
			t.Fatalf("NewRequest: %v", err)
		}
		req.Header.Set(local.HeaderName, tok)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatalf("POST %s: %v", path, err)
		}
		resp.Body.Close()
		if resp.StatusCode == http.StatusOK {
			t.Errorf("POST %s = 200; only %s and %s may answer a POST", path, MintPath, PairPath)
		}
	}
}

// --- the one-time handoff token ---

// mintReq builds the request flue open makes: POST, no Origin, no
// Sec-Fetch-Site, session token in a header.
func mintReq(t *testing.T, ts *httptest.Server, token string) *http.Request {
	t.Helper()
	req, err := http.NewRequest(http.MethodPost, ts.URL+MintPath, nil)
	if err != nil {
		t.Fatalf("NewRequest: %v", err)
	}
	if token != "" {
		req.Header.Set(local.HeaderName, token)
	}
	return req
}

// mint runs the real mint round trip and returns the handoff token.
func mint(t *testing.T, ts *httptest.Server) string {
	t.Helper()
	resp, err := http.DefaultClient.Do(mintReq(t, ts, tok))
	if err != nil {
		t.Fatalf("mint: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("mint status = %d, want 200", resp.StatusCode)
	}
	if got := resp.Header.Get("Cache-Control"); got != "no-store" {
		t.Errorf("mint Cache-Control = %q, want no-store — a handoff token must not be cached", got)
	}
	var body struct {
		Handoff string `json:"handoff"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatalf("decode mint response: %v", err)
	}
	if body.Handoff == "" {
		t.Fatal("mint returned an empty handoff token")
	}
	if body.Handoff == tok {
		t.Fatal("mint returned the session token as a handoff token")
	}
	return body.Handoff
}

// firstLoad is the request a browser launched by flue open makes: no cookie
// yet, no Origin, Sec-Fetch-Site: none, and a handoff token in the URL.
func firstLoad(t *testing.T, ts *httptest.Server, handoff string) *http.Response {
	t.Helper()
	req, err := http.NewRequest(http.MethodGet, ts.URL+"/?"+local.HandoffParam+"="+handoff, nil)
	if err != nil {
		t.Fatalf("NewRequest: %v", err)
	}
	req.Header.Set("Sec-Fetch-Site", "none")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("first load: %v", err)
	}
	t.Cleanup(func() { resp.Body.Close() })
	return resp
}

// TestMintRequiresAuthentication is the requirement stated end to end over
// HTTP: anyone who cannot read $XDG_CONFIG_HOME/flue/token cannot mint a
// handoff token, and therefore cannot get a session cookie out of this daemon.
func TestMintRequiresAuthentication(t *testing.T) {
	ts, _ := newTestServer(t)

	for name, req := range map[string]*http.Request{
		"no credential":    mintReq(t, ts, ""),
		"wrong token":      mintReq(t, ts, "not-the-token"),
		"empty token":      mintReq(t, ts, ""),
		"token in query":   mintReqQuery(t, ts, "?t="+tok),
		"token in cookie":  mintReqCookie(t, ts, tok),
		"handoff in query": mintReqQuery(t, ts, "?"+local.HandoffParam+"="+tok),
	} {
		t.Run(name, func(t *testing.T) {
			resp, err := http.DefaultClient.Do(req)
			if err != nil {
				t.Fatalf("do: %v", err)
			}
			defer resp.Body.Close()
			if resp.StatusCode == http.StatusOK {
				t.Fatalf("mint with %s = 200, want a rejection", name)
			}
		})
	}
}

func mintReqQuery(t *testing.T, ts *httptest.Server, query string) *http.Request {
	t.Helper()
	req, err := http.NewRequest(http.MethodPost, ts.URL+MintPath+query, nil)
	if err != nil {
		t.Fatalf("NewRequest: %v", err)
	}
	return req
}

func mintReqCookie(t *testing.T, ts *httptest.Server, token string) *http.Request {
	t.Helper()
	req := mintReq(t, ts, "")
	req.AddCookie(&http.Cookie{Name: tsCookie(ts), Value: token})
	return req
}

// TestMintRejectsEveryBrowserShapedRequest. The cookie is the credential a
// browser volunteers, and SameSite is port-blind, so a page on another loopback
// port can cause the victim's browser to send it. Minting on the strength of a
// volunteered credential would hand that page a fresh one. Every modern browser
// also sends Sec-Fetch-Site on every request, so its presence — at any value,
// including the "none" a redirect can launder — is enough to refuse.
func TestMintRejectsEveryBrowserShapedRequest(t *testing.T) {
	ts, _ := newTestServer(t)
	for _, sfs := range []string{"none", "same-origin", "same-site", "cross-site"} {
		req := mintReq(t, ts, tok)
		req.Header.Set("Sec-Fetch-Site", sfs)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatalf("do: %v", err)
		}
		resp.Body.Close()
		if resp.StatusCode != http.StatusForbidden {
			t.Errorf("mint with Sec-Fetch-Site: %s = %d, want 403", sfs, resp.StatusCode)
		}
	}
}

// TestMintIsNotReachableByGET closes the obvious way back into the laundering
// surface: a GET can be produced by a redirected navigation, a POST cannot.
func TestMintIsNotReachableByGET(t *testing.T) {
	ts, _ := newTestServer(t)
	req, err := http.NewRequest(http.MethodGet, ts.URL+MintPath, nil)
	if err != nil {
		t.Fatalf("NewRequest: %v", err)
	}
	req.Header.Set(local.HeaderName, tok)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("do: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusMethodNotAllowed {
		t.Fatalf("GET %s = %d, want 405", MintPath, resp.StatusCode)
	}
}

// TestHandoffIsRedeemableExactlyOnceOverHTTP is the whole mechanism end to
// end: mint, first load succeeds and yields the session cookie, second
// presentation of the same token fails. Whoever read the URL out of the browser
// opener's argv arrives second.
func TestHandoffIsRedeemableExactlyOnceOverHTTP(t *testing.T) {
	ui := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte("app shell"))
	})
	ts, _, _ := newTestServerUI(t, ui)

	h := mint(t, ts)

	first := firstLoad(t, ts, h)
	if first.StatusCode != http.StatusOK {
		t.Fatalf("first load = %d, want 200", first.StatusCode)
	}
	var cookie *http.Cookie
	for _, c := range first.Cookies() {
		if c.Name == tsCookie(ts) {
			cookie = c
		}
	}
	if cookie == nil {
		t.Fatal("first load set no session cookie")
	}
	if cookie.Value != tok {
		t.Fatalf("session cookie = %q, want the daemon's token", cookie.Value)
	}
	if !cookie.HttpOnly {
		t.Error("session cookie HttpOnly = false, want true")
	}
	if cookie.SameSite != http.SameSiteStrictMode {
		t.Errorf("session cookie SameSite = %v, want Strict", cookie.SameSite)
	}

	second := firstLoad(t, ts, h)
	if second.StatusCode != http.StatusUnauthorized {
		t.Fatalf("second presentation = %d, want 401", second.StatusCode)
	}
	for _, c := range second.Cookies() {
		if c.Name == tsCookie(ts) {
			t.Fatal("a spent handoff token still yielded a session cookie")
		}
	}
}

// TestConcurrentHandoffExchangesYieldExactlyOneSuccess checks that the whole
// HTTP path — not just the store — hands out one cookie for one token when
// several clients present it together.
//
// It is a smoke test and must not be read as proof of atomicity. It does not
// reliably race: TCP connect and HTTP round-trip jitter serialise the callers
// well enough that splitting Redeem's critical section still passes here. The
// test that actually pins single-use under contention is
// local.TestConcurrentRedeemYieldsExactlyOneWinner, which races the store
// directly with no I/O in the way. What this one adds is that nothing above the
// store — the middleware ordering, the cookie write — turns one winner into two.
func TestConcurrentHandoffExchangesYieldExactlyOneSuccess(t *testing.T) {
	ts, _, _ := newTestServerUI(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))

	for round := 0; round < 10; round++ {
		h := mint(t, ts)

		const racers = 8
		var start sync.WaitGroup
		var done sync.WaitGroup
		var ok, cookies atomic.Int64
		start.Add(1)
		done.Add(racers)
		for i := 0; i < racers; i++ {
			go func() {
				defer done.Done()
				req, err := http.NewRequest(http.MethodGet, ts.URL+"/?"+local.HandoffParam+"="+h, nil)
				if err != nil {
					t.Errorf("NewRequest: %v", err)
					return
				}
				req.Header.Set("Sec-Fetch-Site", "none")
				start.Wait()
				resp, err := http.DefaultClient.Do(req)
				if err != nil {
					t.Errorf("do: %v", err)
					return
				}
				defer resp.Body.Close()
				if resp.StatusCode == http.StatusOK {
					ok.Add(1)
				}
				for _, c := range resp.Cookies() {
					if c.Name == tsCookie(ts) {
						cookies.Add(1)
					}
				}
			}()
		}
		start.Done()
		done.Wait()

		if got := ok.Load(); got != 1 {
			t.Fatalf("round %d: %d concurrent exchanges succeeded, want exactly 1", round, got)
		}
		if got := cookies.Load(); got != 1 {
			t.Fatalf("round %d: %d session cookies handed out, want exactly 1", round, got)
		}
	}
}

// TestExpiredHandoffIsRefusedOverHTTP. flue open launches the browser
// immediately, so a token that turns up later has no business working.
func TestExpiredHandoffIsRefusedOverHTTP(t *testing.T) {
	reg := session.NewRegistry(time.Now)
	srv := New(reg, nil, http.NotFoundHandler(), "test", Identity{})
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)
	t.Cleanup(srv.Shutdown)

	u, err := url.Parse(ts.URL)
	if err != nil {
		t.Fatalf("parse %q: %v", ts.URL, err)
	}
	port, err := strconv.Atoi(u.Port())
	if err != nil {
		t.Fatalf("parse port from %q: %v", ts.URL, err)
	}

	var mu sync.Mutex
	now := time.Now()
	clock := func() time.Time {
		mu.Lock()
		defer mu.Unlock()
		return now
	}
	srv.SetAuth(local.NewAuthWithClock(tok, port, clock))

	h := mint(t, ts)

	mu.Lock()
	now = now.Add(local.HandoffTTL + time.Second)
	mu.Unlock()

	resp := firstLoad(t, ts, h)
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("expired handoff = %d, want 401", resp.StatusCode)
	}
	for _, c := range resp.Cookies() {
		if c.Name == tsCookie(ts) {
			t.Fatal("an expired handoff token still yielded a session cookie")
		}
	}
}

// TestHandoffTokenCannotAuthenticateAWebSocketUpgrade. The upgrade is the one
// GET that leads to every state change flue has — spawn, signal, close — and it
// is reached through Auth.Check, which does not redeem. A handoff token buys the
// session cookie on a read-only route and nothing else; if it could open a
// socket, a token read out of a URL would be a shell rather than a page load.
func TestHandoffTokenCannotAuthenticateAWebSocketUpgrade(t *testing.T) {
	ts, _, srv := newTestServerUI(t, http.NotFoundHandler())
	h := mint(t, ts)

	wsURL := "ws" + strings.TrimPrefix(ts.URL, "http") + "/ws?" + local.HandoffParam + "=" + h
	c, resp, err := websocket.Dial(context.Background(), wsURL, &websocket.DialOptions{
		HTTPHeader: http.Header{"Sec-Fetch-Site": []string{"same-origin"}},
	})
	if err == nil {
		c.Close(websocket.StatusNormalClosure, "")
		t.Fatal("upgrade authenticated by a handoff token succeeded, want rejection")
	}
	if resp != nil && resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", resp.StatusCode)
	}

	// And the rejected upgrade must not have spent it either.
	if !srv.currentAuth().Redeem(h) {
		t.Fatal("the rejected upgrade spent the handoff token")
	}
}

// TestSessionTokenIsNeverAcceptedFromAURL is the no-fallback requirement. If a
// failed handoff exchange — or anything else — fell back to accepting the
// session token from the query string, the exposure this task removes would be
// straight back, and every other control here would be theatre.
func TestSessionTokenIsNeverAcceptedFromAURL(t *testing.T) {
	ui := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte("app shell"))
	})
	ts, _, _ := newTestServerUI(t, ui)

	// A live handoff token, so the "spent handoff plus session token" case is
	// exercised against a store that is not simply empty.
	live := mint(t, ts)
	spent := mint(t, ts)
	firstLoad(t, ts, spent)

	for _, path := range []string{
		"/?t=" + tok,
		"/api/sessions?t=" + tok,
		"/?" + local.HandoffParam + "=" + tok,
		"/?" + local.HandoffParam + "=" + spent + "&t=" + tok,
		"/?" + local.HandoffParam + "=unknown&t=" + tok,
	} {
		req, err := http.NewRequest(http.MethodGet, ts.URL+path, nil)
		if err != nil {
			t.Fatalf("NewRequest: %v", err)
		}
		req.Header.Set("Sec-Fetch-Site", "none")
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatalf("do %s: %v", path, err)
		}
		resp.Body.Close()
		if resp.StatusCode == http.StatusOK {
			t.Errorf("GET %s = 200; the session token must never authenticate from a URL", path)
		}
		for _, c := range resp.Cookies() {
			if c.Name == tsCookie(ts) {
				t.Errorf("GET %s handed out a session cookie", path)
			}
		}
	}

	// None of the above may have burned the live token either.
	if resp := firstLoad(t, ts, live); resp.StatusCode != http.StatusOK {
		t.Fatalf("the live handoff token stopped working after the rejected requests: %d", resp.StatusCode)
	}
}

// TestWebSocketUpgradeRejectsFetchSiteNone is the endpoint-policy half of the
// same defence. The upgrade is the one GET that leads to state changes —
// spawn, signal and close all ride an established socket — so it must not
// admit the one Sec-Fetch-Site value a redirect can launder. No browser can
// produce a WebSocket handshake carrying "none": a handshake is always
// page-initiated (same-origin / same-site / cross-site), never a user
// navigation, and handshake responses are not redirect-followed. So rejecting
// "none" here costs a real client nothing.
func TestWebSocketUpgradeRejectsFetchSiteNone(t *testing.T) {
	ts, _ := newTestServer(t)
	url := "ws" + strings.TrimPrefix(ts.URL, "http") + "/ws"
	c, resp, err := websocket.Dial(context.Background(), url, &websocket.DialOptions{
		HTTPHeader: http.Header{
			"Sec-Fetch-Site": []string{"none"},
			local.HeaderName: []string{tok},
		},
	})
	if err == nil {
		c.Close(websocket.StatusNormalClosure, "")
		t.Fatal("upgrade with Sec-Fetch-Site: none succeeded, want rejection")
	}
	if resp != nil && resp.StatusCode != http.StatusForbidden {
		t.Fatalf("status = %d, want 403", resp.StatusCode)
	}
}

// TestWebSocketRejectsForeignOrigin covers the check that
// AcceptOptions.InsecureSkipVerify makes load-bearing. Disabling the
// library's own origin comparison is only safe because Auth.Check enforces a
// stricter scheme+host+port allowlist first; if that ever stopped running,
// nothing else would notice. The co-resident loopback port is the case that
// matters — it is same-site with this daemon, so the cookie rides along.
func TestWebSocketRejectsForeignOrigin(t *testing.T) {
	ts, _ := newTestServer(t)
	url := "ws" + strings.TrimPrefix(ts.URL, "http") + "/ws"

	for _, origin := range []string{
		"http://127.0.0.1:3000", // an unrelated dev server on this machine
		"https://evil.example.com",
		"null", // an opaque origin: a sandboxed iframe, a data: URL
	} {
		c, resp, err := websocket.Dial(context.Background(), url, &websocket.DialOptions{
			HTTPHeader: http.Header{
				"Origin":         []string{origin},
				local.HeaderName: []string{tok},
			},
		})
		if err == nil {
			c.Close(websocket.StatusNormalClosure, "")
			t.Errorf("upgrade with Origin %q succeeded, want rejection", origin)
			continue
		}
		if resp != nil && resp.StatusCode != http.StatusForbidden {
			t.Errorf("Origin %q: status = %d, want 403", origin, resp.StatusCode)
		}
	}
}

// TestWebSocketUpgradeAcceptsSameOrigin is the positive control: the flue web
// app's own socket, which a browser labels same-origin, must still connect.
func TestWebSocketUpgradeAcceptsSameOrigin(t *testing.T) {
	ts, _ := newTestServer(t)
	c := dialWith(t, ts, http.Header{"Sec-Fetch-Site": []string{"same-origin"}})
	writeControl(t, c, wire.Hello{Ver: "test"})
	readUntil(t, c, func(msg any, _ []byte) bool { _, ok := msg.(wire.Welcome); return ok })
}

// TestAppShellAllowsFetchSiteNone is the other positive control: a typed URL,
// a bookmark, and the browser flue open launches are all exactly the "none"
// case, and the handoff exchange depends on it. Only safe, side-effect-free
// reads may accept it.
func TestAppShellAllowsFetchSiteNone(t *testing.T) {
	ui := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte("app shell"))
	})
	ts, _, _ := newTestServerUI(t, ui)

	resp := get(t, ts, "/", "none")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("GET / with Sec-Fetch-Site: none = %d, want 200", resp.StatusCode)
	}

	resp = get(t, ts, "/api/sessions", "none")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("GET /api/sessions with Sec-Fetch-Site: none = %d, want 200", resp.StatusCode)
	}
}

func TestSecurityHeaders(t *testing.T) {
	ts, _ := newTestServer(t)
	resp := get(t, ts, "/api/sessions", "same-origin")

	if got := resp.Header.Get("Referrer-Policy"); got != "no-referrer" {
		t.Errorf("Referrer-Policy = %q, want %q", got, "no-referrer")
	}
	csp := resp.Header.Get("Content-Security-Policy")
	for _, want := range []string{
		"default-src 'self'",
		"script-src 'self'",
		"object-src 'none'",
		"base-uri 'none'",
		"frame-ancestors 'none'",
	} {
		if !strings.Contains(csp, want) {
			t.Errorf("CSP %q is missing %q", csp, want)
		}
	}
	if got := resp.Header.Get("Access-Control-Allow-Origin"); got != "" {
		t.Errorf("Access-Control-Allow-Origin = %q, want none", got)
	}
}

// --- the pairing page, served to a device that holds no token ---

// getAnon issues the GET the device being paired makes: no cookie, no header,
// nothing this daemon ever issued. A scanned QR code is a user-initiated
// navigation, so it arrives with Sec-Fetch-Site: none; whatever that document
// then asks for arrives same-origin.
func getAnon(t *testing.T, ts *httptest.Server, path, fetchSite string) *http.Response {
	t.Helper()
	req, err := http.NewRequest(http.MethodGet, ts.URL+path, nil)
	if err != nil {
		t.Fatalf("NewRequest: %v", err)
	}
	if fetchSite != "" {
		req.Header.Set("Sec-Fetch-Site", fetchSite)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("do %s: %v", path, err)
	}
	t.Cleanup(func() { resp.Body.Close() })
	return resp
}

// TestPairPageIsServedWithoutASessionToken is the whole reason the exemption
// exists. The device that opens the pairing URL has nothing to authenticate
// with — acquiring a credential is what it is doing — so a 401 here is a
// ceremony that can never start, and the QR code is a link to an error page.
//
// It runs against the shipped UI: with a stub in place the assertion would
// measure the stub's answer rather than the app shell the binary serves.
func TestPairPageIsServedWithoutASessionToken(t *testing.T) {
	ts, _ := newTestServerShippedUI(t)

	for _, p := range []string{PairPagePath, PairPagePath + "?t=" + strings.Repeat("A", 43)} {
		resp := getAnon(t, ts, p, "none")
		body, _ := io.ReadAll(resp.Body)
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("GET %s without a token = %d, want 200", p, resp.StatusCode)
		}
		if ct := resp.Header.Get("Content-Type"); !strings.Contains(ct, "text/html") {
			t.Errorf("GET %s Content-Type = %q, want text/html", p, ct)
		}
		if !strings.Contains(string(body), `id="root"`) {
			t.Errorf("GET %s served %.200q, want the app shell", p, body)
		}
	}
}

// TestPairPageAssetsAreServedWithoutASessionToken is the other half of "the
// page loads": a shell without the module it names is a blank document, and
// the device fetching that module still has no token.
//
// The asset is read out of the shell rather than named here. Its filename
// carries a content hash and changes on every build, so the stable reference is
// the one the document itself makes.
func TestPairPageAssetsAreServedWithoutASessionToken(t *testing.T) {
	ts, _ := newTestServerShippedUI(t)

	shell, err := io.ReadAll(get(t, ts, "/", "same-origin").Body)
	if err != nil {
		t.Fatalf("read shell: %v", err)
	}
	src := scriptSrc(string(shell))
	if !strings.HasPrefix(src, uiAssetPrefix) {
		t.Fatalf("script src = %q, want a path under %s", src, uiAssetPrefix)
	}

	resp := getAnon(t, ts, src, "same-origin")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("GET %s without a token = %d, want 200", src, resp.StatusCode)
	}
	if ct := resp.Header.Get("Content-Type"); !strings.Contains(ct, "javascript") {
		t.Errorf("Content-Type for %s = %q, want JavaScript", src, ct)
	}
}

// TestNothingBeyondThePairingPageIsExemptFromTheToken measures the width of the
// exemption rather than its existence. Every path here answered 401 without a
// session token before the pairing page was carved out and must still, because
// "the shell is public at /pair" and "the shell is public" are very different
// daemons.
func TestNothingBeyondThePairingPageIsExemptFromTheToken(t *testing.T) {
	ts, _ := newTestServerShippedUI(t)

	for _, p := range []string{
		"/",                        // the app shell everywhere else
		"/sessions",                // another client-side route
		"/devices",                 // the screen a pairing is started from
		PairPagePath + "/",         // registered without a trailing slash...
		PairPagePath + "/anything", // ...so nothing under it is exempt either
		"/pairing",                 // nor is a path that merely begins with it
		uiAssetPrefix,              // the asset directory names no file
		"/api/sessions",
		"/manifest.webmanifest",
		"/sw.js",
	} {
		resp := getAnon(t, ts, p, "none")
		if resp.StatusCode != http.StatusUnauthorized {
			t.Errorf("GET %s without a token = %d, want 401", p, resp.StatusCode)
		}
	}

	// The upgrade is the one GET that leads to every state change flue has.
	// Nothing about serving a static page may reach it.
	if _, _, err := websocket.Dial(context.Background(),
		"ws"+strings.TrimPrefix(ts.URL, "http")+"/ws", nil); err == nil {
		t.Error("upgrade without a token succeeded, want failure")
	}
}

// getAnonRaw is getAnon with the request target left exactly as spelled, so a
// percent-encoded path reaches the daemon percent-encoded.
//
// net/url keeps the raw form in URL.RawPath and RequestURI writes that, and the
// assertion below is what makes sure of it. A client that quietly normalised
// the target would send /sw.js, which is refused for an entirely different
// reason — and every case in the traversal test would pass while measuring
// nothing.
func getAnonRaw(t *testing.T, ts *httptest.Server, target string) *http.Response {
	t.Helper()
	req, err := http.NewRequest(http.MethodGet, ts.URL+target, nil)
	if err != nil {
		t.Fatalf("NewRequest %s: %v", target, err)
	}
	if got := req.URL.RequestURI(); got != target {
		t.Fatalf("request target = %q, want %q on the wire as spelled", got, target)
	}
	req.Header.Set("Sec-Fetch-Site", "none")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("do %s: %v", target, err)
	}
	t.Cleanup(func() { resp.Body.Close() })
	return resp
}

// TestTheAssetExemptionCannotBeSpelledOutOfItsOwnPrefix is a regression rather
// than a hypothetical: every target here answered 200 before exemptStaticPath
// existed, while its plain spelling answered 401.
//
// http.ServeMux unescapes each segment of the target after cleaning the escaped
// form, so %2e%2e never trips the redirect that would normalise it, still
// matches the /assets/ subtree, and arrives at the UI handler as ".." — which
// path.Clean then walks back out of the prefix. The prefix was never the
// boundary; the check on the resolved path is.
func TestTheAssetExemptionCannotBeSpelledOutOfItsOwnPrefix(t *testing.T) {
	ts, _ := newTestServerShippedUI(t)

	for _, target := range []string{
		"/assets/",                            // the directory itself: names no file, and the file server answers it with the shell
		"/assets/%2e%2e/sw.js",                // the service worker, which is 401 spelled plainly
		"/assets/..%2fsw.js",                  // the same, with the separator encoded instead
		"/assets/%2e%2e/manifest.webmanifest", // any other root file
		"/assets/%2e%2e/%2e%2e/etc/passwd",    // and out of the build entirely, which answers with the shell
		"/assets/%2e%2e/",
		"/pair/%2e%2e/sw.js",
	} {
		resp := getAnonRaw(t, ts, target)
		body, _ := io.ReadAll(resp.Body)
		if resp.StatusCode != http.StatusUnauthorized {
			t.Errorf("GET %s without a token = %d, want 401 (body %.80q)", target, resp.StatusCode, body)
		}
	}

	// The positive control: the exemption still serves what it is for, or this
	// test is satisfied by a daemon that refuses every asset.
	shell, err := io.ReadAll(get(t, ts, "/", "same-origin").Body)
	if err != nil {
		t.Fatalf("read shell: %v", err)
	}
	src := scriptSrc(string(shell))
	if resp := getAnonRaw(t, ts, src); resp.StatusCode != http.StatusOK {
		t.Fatalf("GET %s without a token = %d, want 200", src, resp.StatusCode)
	}
}

// TestThePairingPageCannotSpendAHandoffToken pins what the exemption skips as
// well as what it allows.
//
// withProvenance does not run the transport's middleware, so the handoff
// exchange never happens on these paths. That is deliberate: a navigation to
// /pair?h=… is one any page can cause, and it must neither burn the one-time
// credential flue open is carrying nor be answered with a session cookie for
// asking. A page that needs no credential must not be able to spend one.
func TestThePairingPageCannotSpendAHandoffToken(t *testing.T) {
	ts, _ := newTestServerShippedUI(t)
	h := mint(t, ts)

	resp := getAnon(t, ts, PairPagePath+"?"+local.HandoffParam+"="+h, "none")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("GET the pairing page carrying a handoff token = %d, want 200", resp.StatusCode)
	}
	for _, c := range resp.Cookies() {
		if c.Name == tsCookie(ts) {
			t.Fatalf("the pairing page set %s; it authenticates nobody", tsCookie(ts))
		}
	}

	// Still unspent, so the browser flue open opened gets the cookie it was
	// sent for. Without this the test passes on a daemon that simply refuses
	// every handoff.
	exchange := getAnon(t, ts, "/?"+local.HandoffParam+"="+h, "none")
	if exchange.StatusCode != http.StatusOK {
		t.Fatalf("first load with the same handoff token = %d, want 200", exchange.StatusCode)
	}
	var cookie *http.Cookie
	for _, c := range exchange.Cookies() {
		if c.Name == tsCookie(ts) {
			cookie = c
		}
	}
	if cookie == nil {
		t.Fatalf("the handoff token was spent by the pairing page: no %s cookie on the exchange",
			tsCookie(ts))
	}
}

// --- carried constraint 2: an exited session must not park the handler ---

func waitForExit(t *testing.T, s *session.Session) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if s.Info().State == "exited" {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("session did not reach state \"exited\" within 10s")
}

// TestAttachToExitedSessionReportsExitPromptly guards the trap carried out of
// Task 3. Session.Subscribe on a session that has exited but has not yet been
// Closed hands back an open channel that nothing closes: markExited only drops
// the subscribers that existed when the child was reaped, and nothing revisits
// the set until Close, which Registry.Reap does not call for ExitedRetention —
// ten minutes. A handler that treats channel closure as its end-of-stream
// signal parks for those ten minutes and the client never learns the session
// is over. The exit has to be read from the session's own state instead.
func TestAttachToExitedSessionReportsExitPromptly(t *testing.T) {
	ts, reg := newTestServer(t)
	s, err := reg.Spawn(session.SpawnOpts{Cmd: []string{"sh", "-c", "echo bye; exit 3"}, Cols: 80, Rows: 24})
	if err != nil {
		t.Fatalf("Spawn: %v", err)
	}
	defer s.Close()
	waitForExit(t, s)

	c := dial(t, ts)
	writeControl(t, c, wire.Hello{Ver: "test"})
	writeControl(t, c, wire.Attach{ID: s.ID(), LastSeq: 0})

	var sawBacklog bool
	readUntil(t, c, func(msg any, out []byte) bool {
		if bytes.Contains(out, []byte("bye")) {
			sawBacklog = true
		}
		e, ok := msg.(wire.Exit)
		if ok && e.Code != 3 {
			t.Fatalf("Exit.Code = %d, want 3", e.Code)
		}
		return ok
	})
	if !sawBacklog {
		t.Error("attaching to an exited session delivered no scrollback")
	}
}

// TestCloseSessionReportsExit covers the sibling case: Session.Close drops
// every subscriber while State is still "running" — it only becomes "exited"
// once the supervisor has killed and reaped the group a few milliseconds
// later. A handler that reads the state at the instant the channel closes
// sees "running", concludes nothing, and leaves the client waiting forever
// for an exit that already happened.
func TestCloseSessionReportsExit(t *testing.T) {
	ts, reg := newTestServer(t)
	s, err := reg.Spawn(session.SpawnOpts{Cmd: []string{"sleep", "30"}, Cols: 80, Rows: 24})
	if err != nil {
		t.Fatalf("Spawn: %v", err)
	}
	defer s.Close()

	c, ref := attach(t, ts, s.ID())
	writeControl(t, c, wire.CloseSession{Ref: ref})

	readUntil(t, c, func(msg any, _ []byte) bool {
		e, ok := msg.(wire.Exit)
		if ok && e.Ref != ref {
			t.Fatalf("Exit.Ref = %d, want %d", e.Ref, ref)
		}
		return ok
	})
}

// --- carried constraint 3: refuse to serve without an authenticator ---

// TestServerWithoutAuthFailsClosed pins the fail-closed default. A daemon
// whose token could not be loaded must not serve a shell-spawning port to
// anyone who asks; a nil authenticator is a misconfiguration, never a
// permission.
func TestServerWithoutAuthFailsClosed(t *testing.T) {
	reg := session.NewRegistry(time.Now)
	srv := New(reg, nil, http.NotFoundHandler(), "test", Identity{})
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	for _, path := range []string{"/", "/api/sessions", "/ws"} {
		req, err := http.NewRequest(http.MethodGet, ts.URL+path, nil)
		if err != nil {
			t.Fatalf("NewRequest: %v", err)
		}
		req.Header.Set(local.HeaderName, tok)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatalf("get %s: %v", path, err)
		}
		resp.Body.Close()
		if resp.StatusCode == http.StatusOK {
			t.Errorf("GET %s = 200 with no authenticator configured, want a rejection", path)
		}
	}

	// The mint endpoint carries its own authentication rather than sitting
	// behind withAuth, so its fail-closed behaviour has to be pinned
	// separately: a daemon with no authenticator must not hand out handoff
	// tokens either.
	req, err := http.NewRequest(http.MethodPost, ts.URL+MintPath, nil)
	if err != nil {
		t.Fatalf("NewRequest: %v", err)
	}
	req.Header.Set(local.HeaderName, tok)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("post %s: %v", MintPath, err)
	}
	resp.Body.Close()
	if resp.StatusCode == http.StatusOK {
		t.Errorf("POST %s = 200 with no authenticator configured, want a rejection", MintPath)
	}

	if err := srv.ListenAndServe(context.Background(), 0); err == nil {
		t.Fatal("ListenAndServe err = nil with no authenticator configured, want an error")
	}
}

// --- bind, resize policy, and protocol hygiene ---

func TestListenAddrIsLoopbackOnly(t *testing.T) {
	if got := listenAddr(7717); got != "127.0.0.1:7717" {
		t.Fatalf("listenAddr(7717) = %q, want %q", got, "127.0.0.1:7717")
	}
}

// TestListenAndServeBindsLoopbackOnly dials the daemon on a non-loopback
// address of this host. Binding 0.0.0.0 would expose a shell-spawning port on
// every network the machine joins, so the connection must be refused.
func TestListenAndServeBindsLoopbackOnly(t *testing.T) {
	external := externalIP(t)

	probe, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("probe listen: %v", err)
	}
	port := probe.Addr().(*net.TCPAddr).Port
	probe.Close()

	reg := session.NewRegistry(time.Now)
	srv := New(reg, local.NewAuth(tok, port), http.NotFoundHandler(), "test", Identity{})

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	errc := make(chan error, 1)
	go func() { errc <- srv.ListenAndServe(ctx, port) }()

	loopback := fmt.Sprintf("127.0.0.1:%d", port)
	deadline := time.Now().Add(5 * time.Second)
	for {
		c, err := net.DialTimeout("tcp", loopback, 200*time.Millisecond)
		if err == nil {
			c.Close()
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("daemon never accepted on %s: %v", loopback, err)
		}
		select {
		case err := <-errc:
			t.Fatalf("ListenAndServe returned early: %v", err)
		case <-time.After(20 * time.Millisecond):
		}
	}

	if c, err := net.DialTimeout("tcp", fmt.Sprintf("%s:%d", external, port), time.Second); err == nil {
		c.Close()
		t.Fatalf("daemon accepted a connection on %s:%d; it must bind 127.0.0.1 only", external, port)
	}
}

// TestEndToEndOverRealListener drives the production path the httptest
// harness bypasses: the real ListenAndServe, on a real loopback port, with
// the header shape a browser actually sends — an Origin, and Sec-Fetch-Site:
// same-origin — through to a real PTY and its exit code.
func TestEndToEndOverRealListener(t *testing.T) {
	probe, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("probe listen: %v", err)
	}
	port := probe.Addr().(*net.TCPAddr).Port
	probe.Close()

	reg := session.NewRegistry(time.Now)
	srv := New(reg, local.NewAuth(tok, port), http.NotFoundHandler(), "test", Identity{})

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() { _ = srv.ListenAndServe(ctx, port) }()

	origin := fmt.Sprintf("http://127.0.0.1:%d", port)
	url := fmt.Sprintf("ws://127.0.0.1:%d/ws", port)

	var c *websocket.Conn
	deadline := time.Now().Add(5 * time.Second)
	for {
		dctx, dcancel := context.WithTimeout(context.Background(), time.Second)
		conn, _, err := websocket.Dial(dctx, url, &websocket.DialOptions{HTTPHeader: http.Header{
			"Origin":         []string{origin},
			"Sec-Fetch-Site": []string{"same-origin"},
			local.HeaderName: []string{tok},
		}})
		dcancel()
		if err == nil {
			c = conn
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("dial %s: %v", url, err)
		}
		time.Sleep(20 * time.Millisecond)
	}
	defer c.Close(websocket.StatusNormalClosure, "")

	writeControl(t, c, wire.Hello{Ver: "test"})
	writeControl(t, c, wire.Spawn{Cmd: []string{"sh", "-c", "echo real-listener-ok; exit 7"}, Cols: 100, Rows: 30})

	var sawOutput bool
	readUntil(t, c, func(msg any, out []byte) bool {
		if bytes.Contains(out, []byte("real-listener-ok")) {
			sawOutput = true
		}
		e, ok := msg.(wire.Exit)
		if ok && e.Code != 7 {
			t.Fatalf("Exit.Code = %d, want 7", e.Code)
		}
		return ok
	})
	if !sawOutput {
		t.Error("no PTY output reached the client over the real listener")
	}
	if n := len(reg.List()); n != 1 {
		t.Fatalf("session count = %d, want 1", n)
	}
	if got := reg.List()[0].Info().Cols; got != 100 {
		t.Fatalf("Cols = %d, want the 100 the spawning client asked for", got)
	}
}

// TestShutdownClosesEstablishedWebSockets covers a connection net/http cannot
// close for us. websocket.Accept hijacks the connection, at which point the
// server untracks it — so Server.Close, which only closes what it is still
// tracking, leaves every established socket running. Without a server-owned
// context the handler never returns, its stream goroutines keep going, and a
// client can keep spawning shells on a daemon that was asked to stop.
func TestShutdownClosesEstablishedWebSockets(t *testing.T) {
	probe, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("probe listen: %v", err)
	}
	port := probe.Addr().(*net.TCPAddr).Port
	probe.Close()

	reg := session.NewRegistry(time.Now)
	srv := New(reg, local.NewAuth(tok, port), http.NotFoundHandler(), "test", Identity{})

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	served := make(chan error, 1)
	go func() { served <- srv.ListenAndServe(ctx, port) }()

	url := fmt.Sprintf("ws://127.0.0.1:%d/ws", port)
	var c *websocket.Conn
	deadline := time.Now().Add(5 * time.Second)
	for {
		dctx, dcancel := context.WithTimeout(context.Background(), time.Second)
		conn, _, err := websocket.Dial(dctx, url, &websocket.DialOptions{
			HTTPHeader: http.Header{local.HeaderName: []string{tok}},
		})
		dcancel()
		if err == nil {
			c = conn
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("dial: %v", err)
		}
		time.Sleep(20 * time.Millisecond)
	}
	defer c.Close(websocket.StatusNormalClosure, "")

	// Establish the connection properly, and attach to a live session so the
	// teardown has a stream goroutine to unwind as well.
	writeControl(t, c, wire.Hello{Ver: "test"})
	writeControl(t, c, wire.Spawn{Cmd: []string{"sleep", "30"}, Cols: 80, Rows: 24})
	readUntil(t, c, func(msg any, _ []byte) bool { _, ok := msg.(wire.Attached); return ok })

	cancel()

	// The socket must die on its own, without the client writing anything.
	rctx, rcancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer rcancel()
	for {
		if _, _, err := c.Read(rctx); err != nil {
			if rctx.Err() != nil {
				t.Fatal("established WebSocket outlived the daemon's shutdown")
			}
			break
		}
	}

	select {
	case err := <-served:
		if err != nil {
			t.Fatalf("ListenAndServe on a cancelled context returned %v, want nil", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("ListenAndServe did not return after its context was cancelled")
	}
}

// TestEnqueueNeverBlocksAndDropsABackloggedClient tests the outbox directly.
// A mutex around the socket would bound each write but not the wait for one:
// a peer parked in a ten-second write holds the mutex for all ten, so anyone
// queued behind it waits that long before its own deadline even starts. The
// queue has to remove the wait, not shorten it.
func TestEnqueueNeverBlocksAndDropsABackloggedClient(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	c := newConn(ctx, cancel, nil, nil, "", "")

	// Fill the outbox with no writer draining it, i.e. a client that has
	// stopped reading its socket.
	for i := 0; i < outboxDepth; i++ {
		if err := c.enqueue(frame{text: true, b: []byte("x")}); err != nil {
			t.Fatalf("enqueue %d: %v", i, err)
		}
	}

	done := make(chan error, 1)
	go func() { done <- c.enqueue(frame{text: true, b: []byte("overflow")}) }()

	select {
	case err := <-done:
		if !errors.Is(err, errConnBacklogged) {
			t.Fatalf("enqueue on a full outbox = %v, want errConnBacklogged", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("enqueue blocked on a full outbox; it must never wait")
	}

	if ctx.Err() == nil {
		t.Fatal("a backlogged client was not dropped")
	}
}

// TestBroadcastDoesNotWaitOnABackloggedPeer is the property that matters at
// the server level: walking a session's clients to tell them the terminal
// resized must not put the resizing client's read loop at the mercy of a peer
// that stopped reading. The wedged peer is dropped; the healthy one still
// gets its frame.
func TestBroadcastDoesNotWaitOnABackloggedPeer(t *testing.T) {
	reg := session.NewRegistry(time.Now)
	s, err := reg.Spawn(session.SpawnOpts{Cmd: []string{"sleep", "10"}, Cols: 80, Rows: 24})
	if err != nil {
		t.Fatalf("Spawn: %v", err)
	}
	defer s.Close()
	srv := New(reg, nil, nil, "test", Identity{})

	newPeer := func() *conn {
		ctx, cancel := context.WithCancel(context.Background())
		t.Cleanup(cancel)
		c := newConn(ctx, cancel, nil, srv, "", "")
		c.attach[1] = &attachment{ref: 1, s: s, sub: s.Subscribe(0), done: make(chan struct{})}
		srv.claimPrimaryIfUnset(s.ID(), c)
		return c
	}

	wedged := newPeer()
	healthy := newPeer()
	for i := 0; i < outboxDepth; i++ {
		if err := wedged.enqueue(frame{text: true, b: []byte("x")}); err != nil {
			t.Fatalf("filling the wedged peer: %v", err)
		}
	}

	done := make(chan struct{})
	go func() { srv.broadcastSize(s.ID(), 100, 30); close(done) }()

	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("broadcastSize waited on a peer that had stopped reading")
	}

	if wedged.ctx.Err() == nil {
		t.Error("the wedged peer was not dropped")
	}
	select {
	case <-healthy.out:
	default:
		t.Error("the healthy peer was not told about the resize")
	}
}

func externalIP(t *testing.T) string {
	t.Helper()
	addrs, err := net.InterfaceAddrs()
	if err != nil {
		t.Skipf("InterfaceAddrs: %v", err)
	}
	for _, a := range addrs {
		n, ok := a.(*net.IPNet)
		if !ok || n.IP.IsLoopback() || n.IP.To4() == nil {
			continue
		}
		return n.IP.String()
	}
	t.Skip("no non-loopback IPv4 address on this host")
	return ""
}

// TestPrimaryPromotionOnDetach covers the half of the resize policy the brief
// states but does not test: when the primary leaves, someone else has to own
// the PTY dimensions, and has to be told so.
func TestPrimaryPromotionOnDetach(t *testing.T) {
	ts, reg := newTestServer(t)
	s, err := reg.Spawn(session.SpawnOpts{Cmd: []string{"sleep", "10"}, Cols: 80, Rows: 24})
	if err != nil {
		t.Fatalf("Spawn: %v", err)
	}
	defer s.Close()

	first, firstRef := attach(t, ts, s.ID())
	second, secondRef := attach(t, ts, s.ID())

	writeControl(t, first, wire.Detach{Ref: firstRef})

	readUntil(t, second, func(msg any, _ []byte) bool {
		sc, ok := msg.(wire.SizeChanged)
		return ok && sc.Ref == secondRef && sc.Primary
	})

	// A plain resize from the promoted client — no seizure flag — must now
	// reach the PTY.
	writeControl(t, second, wire.Resize{Ref: secondRef, Cols: 100, Rows: 30, Primary: false})
	deadline := time.After(3 * time.Second)
	for s.Info().Cols != 100 {
		select {
		case <-deadline:
			t.Fatalf("Cols = %d after the promoted client resized, want 100", s.Info().Cols)
		case <-time.After(10 * time.Millisecond):
		}
	}
}

// TestPrimarySeizureDemotesTheOldPrimary checks the notification the seizure
// path owes the client that just lost the dimensions.
func TestPrimarySeizureDemotesTheOldPrimary(t *testing.T) {
	ts, reg := newTestServer(t)
	s, err := reg.Spawn(session.SpawnOpts{Cmd: []string{"sleep", "10"}, Cols: 80, Rows: 24})
	if err != nil {
		t.Fatalf("Spawn: %v", err)
	}
	defer s.Close()

	first, firstRef := attach(t, ts, s.ID())
	second, secondRef := attach(t, ts, s.ID())

	writeControl(t, second, wire.Resize{Ref: secondRef, Cols: 60, Rows: 20, Primary: true})

	readUntil(t, first, func(msg any, _ []byte) bool {
		sc, ok := msg.(wire.SizeChanged)
		if !ok || sc.Ref != firstRef {
			return false
		}
		if sc.Primary {
			t.Fatal("the demoted client was told Primary = true")
		}
		if sc.Cols != 60 || sc.Rows != 20 {
			t.Fatalf("SizeChanged = %dx%d, want 60x20", sc.Cols, sc.Rows)
		}
		return true
	})
}

func TestUnknownSignalIsRejected(t *testing.T) {
	ts, reg := newTestServer(t)
	s, err := reg.Spawn(session.SpawnOpts{Cmd: []string{"sleep", "10"}, Cols: 80, Rows: 24})
	if err != nil {
		t.Fatalf("Spawn: %v", err)
	}
	defer s.Close()

	c, ref := attach(t, ts, s.ID())
	writeControl(t, c, wire.Signal{Ref: ref, Sig: "SIGSTOP"})
	readUntil(t, c, func(msg any, _ []byte) bool {
		e, ok := msg.(wire.Error)
		return ok && e.Code == "bad_signal"
	})

	if got := s.Info().State; got != "running" {
		t.Fatalf("state = %q after an unknown signal, want %q", got, "running")
	}
}

func TestSignalReachesTheSession(t *testing.T) {
	ts, reg := newTestServer(t)
	s, err := reg.Spawn(session.SpawnOpts{Cmd: []string{"sleep", "30"}, Cols: 80, Rows: 24})
	if err != nil {
		t.Fatalf("Spawn: %v", err)
	}
	defer s.Close()

	c, ref := attach(t, ts, s.ID())
	writeControl(t, c, wire.Signal{Ref: ref, Sig: "SIGKILL"})
	readUntil(t, c, func(msg any, _ []byte) bool { _, ok := msg.(wire.Exit); return ok })
}

func TestUnknownRefIsRejected(t *testing.T) {
	ts, _ := newTestServer(t)
	c := dial(t, ts)
	writeControl(t, c, wire.Hello{Ver: "test"})
	writeControl(t, c, wire.Resize{Ref: 99, Cols: 10, Rows: 10, Primary: true})
	readUntil(t, c, func(msg any, _ []byte) bool {
		e, ok := msg.(wire.Error)
		return ok && e.Code == "bad_ref"
	})
}

// TestClientsMayNotSendOutputFrames stops a client from injecting bytes into
// its own scrollback as though the PTY had produced them.
func TestClientsMayNotSendOutputFrames(t *testing.T) {
	ts, reg := newTestServer(t)
	s, err := reg.Spawn(session.SpawnOpts{Cmd: []string{"cat"}, Cols: 80, Rows: 24})
	if err != nil {
		t.Fatalf("Spawn: %v", err)
	}
	defer s.Close()

	c, ref := attach(t, ts, s.ID())
	frame := wire.EncodeBinary(wire.FrameOutput, ref, []byte("forged"))
	if err := c.Write(context.Background(), websocket.MessageBinary, frame); err != nil {
		t.Fatalf("write: %v", err)
	}
	readUntil(t, c, func(msg any, _ []byte) bool {
		e, ok := msg.(wire.Error)
		return ok && e.Code == "bad_frame"
	})
}

func TestMalformedControlMessageIsRejected(t *testing.T) {
	ts, _ := newTestServer(t)
	c := dial(t, ts)
	if err := c.Write(context.Background(), websocket.MessageText, []byte(`{"type":"nope"}`)); err != nil {
		t.Fatalf("write: %v", err)
	}
	readUntil(t, c, func(msg any, _ []byte) bool {
		e, ok := msg.(wire.Error)
		return ok && e.Code == "bad_message"
	})
}

// --- reqId correlation ---

func TestAttachedEchoesReqID(t *testing.T) {
	ts, reg := newTestServer(t)
	s, err := reg.Spawn(session.SpawnOpts{Cmd: []string{"sleep", "2"}, Cols: 80, Rows: 24})
	if err != nil {
		t.Fatalf("Spawn: %v", err)
	}
	defer s.Close()

	c := dial(t, ts)
	writeControl(t, c, wire.Hello{Ver: "test"})
	writeControl(t, c, wire.Attach{ID: s.ID(), LastSeq: 0, ReqID: 42})
	readUntil(t, c, func(msg any, _ []byte) bool {
		a, ok := msg.(wire.Attached)
		if ok && a.ReqID != 42 {
			t.Fatalf("Attached.ReqID = %d, want 42", a.ReqID)
		}
		return ok
	})
}

func TestSpawnAttachedEchoesReqID(t *testing.T) {
	ts, _ := newTestServer(t)
	c := dial(t, ts)
	writeControl(t, c, wire.Hello{Ver: "test"})
	writeControl(t, c, wire.Spawn{Cmd: []string{"sleep", "2"}, Cols: 80, Rows: 24, ReqID: 5})
	readUntil(t, c, func(msg any, _ []byte) bool {
		a, ok := msg.(wire.Attached)
		if ok && a.ReqID != 5 {
			t.Fatalf("Attached.ReqID = %d, want 5", a.ReqID)
		}
		return ok
	})
}

// TestNotFoundEchoesReqID is the mandatory error half: not_found arrives as
// an error, so the field has to ride wire.Error or the fourth consumer stays
// a heuristic.
func TestNotFoundEchoesReqID(t *testing.T) {
	ts, _ := newTestServer(t)
	c := dial(t, ts)
	writeControl(t, c, wire.Hello{Ver: "test"})
	writeControl(t, c, wire.Attach{ID: "does-not-exist", ReqID: 7})
	readUntil(t, c, func(msg any, _ []byte) bool {
		e, ok := msg.(wire.Error)
		if !ok || e.Code != "not_found" {
			return false
		}
		if e.ReqID != 7 {
			t.Fatalf("Error.ReqID = %d, want 7", e.ReqID)
		}
		return true
	})
}

func TestSpawnFailedEchoesReqID(t *testing.T) {
	ts, _ := newTestServer(t)
	c := dial(t, ts)
	writeControl(t, c, wire.Hello{Ver: "test"})
	writeControl(t, c, wire.Spawn{Cwd: "/definitely/not/a/directory", Cmd: []string{"true"}, Cols: 80, Rows: 24, ReqID: 9})
	readUntil(t, c, func(msg any, _ []byte) bool {
		e, ok := msg.(wire.Error)
		if !ok || e.Code != "spawn_failed" {
			return false
		}
		if e.ReqID != 9 {
			t.Fatalf("Error.ReqID = %d, want 9", e.ReqID)
		}
		return true
	})
}

// --- head: where the replayed backlog ends ---

// TestAttachedHeadCoversTheBacklog: attach to a session whose entire output
// is already in the ring. head must equal seq plus every backlog byte the
// client is about to receive — the offset at which live output begins.
func TestAttachedHeadCoversTheBacklog(t *testing.T) {
	ts, reg := newTestServer(t)
	s, err := reg.Spawn(session.SpawnOpts{Cmd: []string{"sh", "-c", "echo replayed"}, Cols: 80, Rows: 24})
	if err != nil {
		t.Fatalf("Spawn: %v", err)
	}
	defer s.Close()
	waitForExit(t, s)

	c := dial(t, ts)
	writeControl(t, c, wire.Hello{Ver: "test"})
	writeControl(t, c, wire.Attach{ID: s.ID(), LastSeq: 0})

	var att wire.Attached
	readUntil(t, c, func(msg any, _ []byte) bool {
		a, ok := msg.(wire.Attached)
		if ok {
			att = a
		}
		return ok
	})

	var backlog []byte
	readUntil(t, c, func(msg any, out []byte) bool {
		_, done := msg.(wire.Exit)
		if done {
			backlog = append([]byte(nil), out...)
		}
		return done
	})

	if att.Head != att.Seq+uint64(len(backlog)) {
		t.Fatalf("Head = %d, want Seq %d + backlog %d", att.Head, att.Seq, len(backlog))
	}
	if att.Head == att.Seq {
		t.Fatal("Head == Seq for a session with output in the ring; the gate would never arm")
	}
}

// TestAttachedHeadEqualsSeqOnAFreshSpawn: an empty backlog omits the output
// frame entirely, which is why gating on "the first output frame" was wrong.
// head == seq is what lets the client open the gate immediately.
func TestAttachedHeadEqualsSeqOnAFreshSpawn(t *testing.T) {
	ts, reg := newTestServer(t)
	s, err := reg.Spawn(session.SpawnOpts{Cmd: []string{"cat"}, Cols: 80, Rows: 24})
	if err != nil {
		t.Fatalf("Spawn: %v", err)
	}
	defer s.Close()

	c := dial(t, ts)
	writeControl(t, c, wire.Hello{Ver: "test"})
	writeControl(t, c, wire.Attach{ID: s.ID(), LastSeq: 0})
	readUntil(t, c, func(msg any, _ []byte) bool {
		a, ok := msg.(wire.Attached)
		if !ok {
			return false
		}
		if a.Head != a.Seq {
			t.Fatalf("Head = %d, Seq = %d; want equal on an empty backlog", a.Head, a.Seq)
		}
		return true
	})
}

// --- the audit log ---

// syncBuffer is a bytes.Buffer safe for the conn goroutines that log from
// off the test's own goroutine.
type syncBuffer struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (s *syncBuffer) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.Write(p)
}

func (s *syncBuffer) String() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.String()
}

func auditServer(t *testing.T) (*httptest.Server, *session.Registry, *syncBuffer) {
	t.Helper()
	ts, reg, srv := newTestServerUI(t, http.NotFoundHandler())
	buf := &syncBuffer{}
	srv.SetLogger(slog.New(slog.NewTextHandler(buf, nil)))
	return ts, reg, buf
}

func waitForLog(t *testing.T, buf *syncBuffer, want string) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if strings.Contains(buf.String(), want) {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("log never contained %q; log so far:\n%s", want, buf.String())
}

// logLineContains reports whether some line of buf that contains marker also
// contains want — so a record's own fields can be asserted on, rather than
// the whole log, which may hold other records carrying the same field.
func logLineContains(buf *syncBuffer, marker, want string) bool {
	for _, line := range strings.Split(buf.String(), "\n") {
		if strings.Contains(line, marker) && strings.Contains(line, want) {
			return true
		}
	}
	return false
}

// TestAuditLogsARejectedRequest covers the middleware path — the auth
// decision local.Auth.Middleware makes for every API and UI request.
func TestAuditLogsARejectedRequest(t *testing.T) {
	ts, _, buf := auditServer(t)

	resp, err := http.Get(ts.URL + "/api/sessions")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	resp.Body.Close()

	waitForLog(t, buf, "auth rejected")
	waitForLog(t, buf, "path=/api/sessions")
	if !strings.Contains(buf.String(), "peer=") {
		t.Fatalf("rejection logged without the resolved peer:\n%s", buf.String())
	}
}

func TestAuditLogsARejectedUpgrade(t *testing.T) {
	ts, _, buf := auditServer(t)

	url := "ws" + strings.TrimPrefix(ts.URL, "http") + "/ws"
	if c, _, err := websocket.Dial(context.Background(), url, nil); err == nil {
		c.Close(websocket.StatusNormalClosure, "")
		t.Fatal("dial without a token succeeded")
	}

	waitForLog(t, buf, "auth rejected")
	waitForLog(t, buf, "path=/ws")
}

// TestAuditLogsARejectedUpgradeFetchSite covers the fourth auth-decision
// site: requireSameOriginFetchSite in handleWS, which runs after checkAuth
// has already passed. A valid token is not enough to reach it — it must be
// exercised with one, or the rejection would be attributed to checkAuth
// instead and this branch would go untested.
func TestAuditLogsARejectedUpgradeFetchSite(t *testing.T) {
	ts, _, buf := auditServer(t)

	url := "ws" + strings.TrimPrefix(ts.URL, "http") + "/ws"
	c, _, err := websocket.Dial(context.Background(), url, &websocket.DialOptions{
		HTTPHeader: http.Header{
			"Sec-Fetch-Site": []string{"none"},
			local.HeaderName: []string{tok},
		},
	})
	if err == nil {
		c.Close(websocket.StatusNormalClosure, "")
		t.Fatal("dial with Sec-Fetch-Site: none succeeded")
	}

	waitForLog(t, buf, "auth rejected")
	waitForLog(t, buf, "path=/ws")
	if !strings.Contains(buf.String(), "peer=") {
		t.Fatalf("rejection logged without the resolved peer:\n%s", buf.String())
	}
}

func TestAuditLogsARejectedMint(t *testing.T) {
	ts, _, buf := auditServer(t)

	resp, err := http.DefaultClient.Do(mintReq(t, ts, "not-the-token"))
	if err != nil {
		t.Fatalf("mint: %v", err)
	}
	resp.Body.Close()

	waitForLog(t, buf, "mint rejected")
}

func TestAuditLogsAttachAndDetach(t *testing.T) {
	ts, reg, buf := auditServer(t)
	s, err := reg.Spawn(session.SpawnOpts{Cmd: []string{"sleep", "5"}, Cols: 80, Rows: 24})
	if err != nil {
		t.Fatalf("Spawn: %v", err)
	}
	defer s.Close()

	c, ref := attach(t, ts, s.ID())
	waitForLog(t, buf, "msg=attach")
	waitForLog(t, buf, "session="+s.ID())
	if !logLineContains(buf, "msg=attach", "peer=") {
		t.Fatalf("attach logged without the resolved peer:\n%s", buf.String())
	}

	writeControl(t, c, wire.Detach{Ref: ref})
	waitForLog(t, buf, "msg=detach")
	if !logLineContains(buf, "msg=detach", "peer=") {
		t.Fatalf("detach logged without the resolved peer:\n%s", buf.String())
	}
}

// TestAuditLogsAMissingAuthenticator: ErrNoAuth is the daemon's own fault,
// not the peer's — every site that can answer 503 for it says so under one
// message, and none of them dresses it up as a peer rejection.
func TestAuditLogsAMissingAuthenticator(t *testing.T) {
	ts, _, srv := newTestServerUI(t, http.NotFoundHandler())
	buf := &syncBuffer{}
	srv.SetLogger(slog.New(slog.NewTextHandler(buf, nil)))
	srv.SetAuth(nil)

	resp, err := http.Get(ts.URL + "/api/sessions")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	resp.Body.Close()

	resp, err = http.DefaultClient.Do(mintReq(t, ts, tok))
	if err != nil {
		t.Fatalf("mint: %v", err)
	}
	resp.Body.Close()

	url := "ws" + strings.TrimPrefix(ts.URL, "http") + "/ws"
	if c, _, err := websocket.Dial(context.Background(), url, nil); err == nil {
		c.Close(websocket.StatusNormalClosure, "")
		t.Fatal("dial with no authenticator succeeded")
	}

	for _, path := range []string{"/api/sessions", MintPath, "/ws"} {
		if !logLineContains(buf, "no authenticator configured", "path="+path) {
			t.Fatalf("no record for %s:\n%s", path, buf.String())
		}
	}
	if strings.Contains(buf.String(), "auth rejected") {
		t.Fatalf("a daemon fault was logged as a peer rejection:\n%s", buf.String())
	}
}

// TestAuditDoesNotLogAnAcceptedRequest: the audit log names decisions, not
// traffic — an accepted request is not an event.
func TestAuditDoesNotLogAnAcceptedRequest(t *testing.T) {
	ts, _, buf := auditServer(t)

	resp := get(t, ts, "/api/sessions", "same-origin")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}
	if strings.Contains(buf.String(), "auth rejected") {
		t.Fatalf("an accepted request was logged as a rejection:\n%s", buf.String())
	}
}

// --- devices and revocation ---

// addDevice pairs a device straight into the registry. The ceremony that
// normally puts one there is pairing_test's business; what these tests need is
// the state it leaves behind.
func addDevice(t *testing.T, srv *Server, label string, fill byte) crypto.Device {
	t.Helper()
	d, err := srv.identity.Devices.Add(label, deviceKey(fill))
	if err != nil {
		t.Fatalf("Add(%q): %v", label, err)
	}
	return d
}

// serverConns waits until the daemon holds n live connections and returns them
// in the order it accepted them.
//
// The wait is what makes the order usable: websocket.Dial returns as soon as
// the handshake completes, which can be before handleWS has registered the
// connection, so a test that dialled and looked immediately would sometimes
// find nothing.
func serverConns(t *testing.T, srv *Server, n int) []*conn {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		conns := srv.allConns()
		if len(conns) == n {
			return conns
		}
		if time.Now().After(deadline) {
			t.Fatalf("daemon holds %d live connections, want %d", len(conns), n)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func TestDevicesAnswersTheRegistry(t *testing.T) {
	ts, srv := newPairServer(t)
	phone := addDevice(t, srv, "phone", 0x2a)
	laptop := addDevice(t, srv, "laptop", 0x3b)

	c := dial(t, ts)
	writeControl(t, c, wire.Hello{Ver: "test"})
	writeControl(t, c, wire.Devices{})

	var got wire.DeviceList
	readUntil(t, c, func(msg any, _ []byte) bool {
		l, ok := msg.(wire.DeviceList)
		if ok {
			got = l
		}
		return ok
	})

	if len(got.Devices) != 2 {
		t.Fatalf("deviceList carried %d devices, want 2: %+v", len(got.Devices), got.Devices)
	}
	byID := map[string]wire.DeviceInfo{}
	for _, d := range got.Devices {
		byID[d.ID] = d
	}
	for _, want := range []crypto.Device{phone, laptop} {
		info, ok := byID[want.ID]
		if !ok {
			t.Fatalf("deviceList has no entry for %s (%s): %+v", want.Label, want.ID, got.Devices)
		}
		if info.Label != want.Label {
			t.Errorf("label = %q, want %q", info.Label, want.Label)
		}
		// The registry keeps time.Time and the wire carries unix seconds; a
		// conversion that never happened would ship a zero or an RFC 3339
		// string, and both are silently useless to the client.
		if info.PairedAt != want.PairedAt.Unix() {
			t.Errorf("pairedAt = %d, want the unix seconds %d", info.PairedAt, want.PairedAt.Unix())
		}
		if info.LastSeen != want.LastSeen.Unix() {
			t.Errorf("lastSeen = %d, want the unix seconds %d", info.LastSeen, want.LastSeen.Unix())
		}
	}
}

// TestDevicesOnAnEmptyRegistryAnswersAnEmptyList pins the normalisation at the
// one call site that reaches it: no devices paired is the state a client
// reaches on a fresh daemon, and it must arrive as [] rather than null.
func TestDevicesOnAnEmptyRegistryAnswersAnEmptyList(t *testing.T) {
	ts, _ := newPairServer(t)
	c := dial(t, ts)
	writeControl(t, c, wire.Hello{Ver: "test"})
	writeControl(t, c, wire.Devices{})

	readUntil(t, c, func(msg any, _ []byte) bool {
		l, ok := msg.(wire.DeviceList)
		if !ok {
			return false
		}
		if len(l.Devices) != 0 {
			t.Fatalf("deviceList = %+v, want no devices", l.Devices)
		}
		if l.Devices == nil {
			t.Fatal("devices decoded to nil, so the daemon sent null; every client that ranges over the field would throw")
		}
		return true
	})
}

// TestRevokeUnknownDeviceIsRefused: a revoke naming nothing must remove
// nothing, and must say so rather than answering with a list that looks like a
// success.
//
// The malformed cases answer identically because they are identically unknown —
// no device can hold an identity of that shape — and the oversized one is the
// reason the shape is checked at all: an id a client chose reaches the audit
// log, and a client may send a megabyte of it.
func TestRevokeUnknownDeviceIsRefused(t *testing.T) {
	for name, id := range map[string]string{
		"well-formed but absent": "ffffffffffff",
		"empty":                  "",
		"too short":              "ff",
		"not hex":                "zzzzzzzzzzzz",
		"uppercase":              "FFFFFFFFFFFF",
		"enormous":               strings.Repeat("a", 1<<16),
	} {
		t.Run(name, func(t *testing.T) {
			ts, srv := newPairServer(t)
			buf := &syncBuffer{}
			srv.SetLogger(slog.New(slog.NewTextHandler(buf, nil)))
			phone := addDevice(t, srv, "phone", 0x2a)

			c := dial(t, ts)
			writeControl(t, c, wire.Hello{Ver: "test"})
			writeControl(t, c, wire.Revoke{DeviceID: id})

			readUntil(t, c, func(msg any, _ []byte) bool {
				e, ok := msg.(wire.Error)
				if !ok {
					return false
				}
				if e.Code != "unknown_device" {
					t.Fatalf("error code = %q, want %q", e.Code, "unknown_device")
				}
				return true
			})

			list := devices(t, srv)
			if len(list) != 1 || list[0].ID != phone.ID {
				t.Fatalf("registry = %+v after a refused revoke, want just the phone", list)
			}
			waitForLog(t, buf, "revoke refused")
			// Whatever the client sent, the log stays readable.
			if len(buf.String()) > 4<<10 {
				t.Errorf("a single refused revoke wrote %d bytes of audit log", len(buf.String()))
			}
		})
	}
}

// TestRevokeClosesTheDeviceConnectionsAndUpdatesTheRest is the whole
// revocation: the entry goes, the sockets that were authenticated as it are
// told why and then ended, and everyone still connected is handed the list
// that is now true.
//
// The device's identity is supplied through registerDeviceConn because no
// loopback connection has one — a local client presents the session token,
// which is not a device — so the map revocation walks has no members until the
// relay transport arrives. The seam is what lets the behaviour be built and
// pinned now rather than shipped untested alongside that transport.
func TestRevokeClosesTheDeviceConnectionsAndUpdatesTheRest(t *testing.T) {
	ts, srv := newPairServer(t)
	buf := &syncBuffer{}
	srv.SetLogger(slog.New(slog.NewTextHandler(buf, nil)))

	phone := addDevice(t, srv, "phone", 0x2a)
	laptop := addDevice(t, srv, "laptop", 0x3b)

	device := dial(t, ts)
	writeControl(t, device, wire.Hello{Ver: "test"})
	readUntil(t, device, func(msg any, _ []byte) bool { _, ok := msg.(wire.Welcome); return ok })
	srv.registerDeviceConn(phone.ID, serverConns(t, srv, 1)[0])

	ui := dial(t, ts)
	writeControl(t, ui, wire.Hello{Ver: "test"})
	readUntil(t, ui, func(msg any, _ []byte) bool { _, ok := msg.(wire.Welcome); return ok })

	writeControl(t, ui, wire.Revoke{DeviceID: phone.ID})

	readUntil(t, device, func(msg any, _ []byte) bool {
		r, ok := msg.(wire.Revoked)
		if ok && r.Reason != "revoked" {
			t.Fatalf("revoked reason = %q, want %q", r.Reason, "revoked")
		}
		return ok
	})

	// And then the socket goes, without the client writing anything: a device
	// that keeps its connection after revocation keeps its shells.
	rctx, rcancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer rcancel()
	for {
		if _, _, err := device.Read(rctx); err != nil {
			if rctx.Err() != nil {
				t.Fatal("the revoked device's connection outlived its revocation")
			}
			break
		}
	}

	readUntil(t, ui, func(msg any, _ []byte) bool {
		l, ok := msg.(wire.DeviceList)
		if !ok {
			return false
		}
		if len(l.Devices) != 1 || l.Devices[0].ID != laptop.ID {
			t.Fatalf("deviceList = %+v, want just the laptop %s", l.Devices, laptop.ID)
		}
		return true
	})

	list := devices(t, srv)
	if len(list) != 1 || list[0].ID != laptop.ID {
		t.Fatalf("registry = %+v after the revoke, want just the laptop", list)
	}

	waitForLog(t, buf, "device revoked")
	if !logLineContains(buf, "device revoked", "device="+phone.ID) {
		t.Errorf("the revocation was logged without the device it removed:\n%s", buf.String())
	}
	if !logLineContains(buf, "device revoked", "peer=") {
		t.Errorf("the revocation was logged without the peer that asked for it:\n%s", buf.String())
	}
}

// TestDeviceListBroadcastDoesNotWaitOnABackloggedPeer is the outbox discipline
// applied to the new all-connections walk: telling every client the device list
// changed must not put the revoking client — or the pairing HTTP handler — at
// the mercy of a peer that stopped reading its socket.
func TestDeviceListBroadcastDoesNotWaitOnABackloggedPeer(t *testing.T) {
	srv := New(session.NewRegistry(time.Now), nil, nil, "test",
		Identity{Devices: crypto.NewDeviceStore(t.TempDir())})

	newPeer := func() *conn {
		ctx, cancel := context.WithCancel(context.Background())
		t.Cleanup(cancel)
		c := newConn(ctx, cancel, nil, srv, "", "")
		srv.addConn(c, "")
		return c
	}

	wedged := newPeer()
	healthy := newPeer()
	for i := 0; i < outboxDepth; i++ {
		if err := wedged.enqueue(frame{text: true, b: []byte("x")}); err != nil {
			t.Fatalf("filling the wedged peer: %v", err)
		}
	}

	done := make(chan struct{})
	go func() { srv.broadcastDeviceList(); close(done) }()

	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("broadcastDeviceList waited on a peer that had stopped reading")
	}

	if wedged.ctx.Err() == nil {
		t.Error("the wedged peer was not dropped")
	}
	select {
	case <-healthy.out:
	default:
		t.Error("the healthy peer was not sent the device list")
	}
}

// --- the connection registry ---

// TestRegisterDeviceConnRefusesAConnAlreadyGone: a connection that raced its
// own teardown must not be registered afterwards. Revocation walks the device
// bucket, so an entry for a conn that has already left is one it will close
// pointlessly — and the bucket the registration re-created outlives every
// connection in it, which is a device that can never be disconnected again.
func TestRegisterDeviceConnRefusesAConnAlreadyGone(t *testing.T) {
	srv := New(session.NewRegistry(time.Now), local.NewAuth(tok, 0), nil, "test", Identity{})
	c := &conn{}
	srv.addConn(c, "")
	srv.removeConn(c)
	srv.registerDeviceConn("abcdefabcdef", c)

	srv.connMu.Lock()
	defer srv.connMu.Unlock()
	if len(srv.deviceConns["abcdefabcdef"]) != 0 {
		t.Fatal("a removed conn was registered into the device bucket")
	}
}

// TestADeviceConnJoinsBothRegistriesAtOnce: there must be no instant at which
// a connection is live but not yet its device's.
//
// A revoke landing in that instant takes the bucket as it stands — without this
// connection — closes what it found, and returns. The registration that follows
// then re-creates the bucket the revocation just emptied, so the revoked device
// keeps a live socket, and every shell on it, in a bucket nothing will ever
// look at again. The interleaving is written out here as three calls in the
// order they would have happened: the conn is admitted, the revoke lands, and
// the late registration — which is now the only thing that could still resurrect
// it — is refused.
func TestADeviceConnJoinsBothRegistriesAtOnce(t *testing.T) {
	const device = "abcdefabcdef"
	srv := New(session.NewRegistry(time.Now), local.NewAuth(tok, 0), nil, "test", Identity{})
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	c := newConn(ctx, cancel, nil, srv, "relay", "")

	// Admission is one step, so a revoke can only observe both registries or
	// neither.
	srv.addConn(c, device)
	if n := srv.disconnectDevice(device, "revoked"); n != 1 {
		t.Fatalf("the revoke closed %d connections, want 1", n)
	}
	srv.registerDeviceConn(device, c)

	// The reason was queued for it rather than the socket simply dropped: with
	// no writer goroutine running, the queued frame is where that stops.
	select {
	case <-c.out:
	default:
		t.Fatal("the revoked connection was told nothing")
	}

	srv.connMu.Lock()
	defer srv.connMu.Unlock()
	if len(srv.conns) != 0 {
		t.Fatalf("the revoked device's connection is still live: %d", len(srv.conns))
	}
	if len(srv.deviceConns) != 0 {
		t.Fatalf("the revoked device's bucket was re-created: %+v", srv.deviceConns)
	}
}

// TestDropConnClearsTheVacatedSlot: the slice shrinks but its backing array
// does not, so the tail slot has to be cleared or the registry keeps a
// finished connection — its outbox, its attachments, its context — reachable
// for as long as the array lives.
func TestDropConnClearsTheVacatedSlot(t *testing.T) {
	a, b := &conn{}, &conn{}
	list := []*conn{a, b}

	got := dropConn(list, a)
	if len(got) != 1 || got[0] != b {
		t.Fatalf("dropConn = %v, want just the second conn", got)
	}
	if list[1] != nil {
		t.Fatal("dropConn left the dropped conn reachable through the backing array")
	}
}

// TestStoreErrorsDoNotReachClientsVerbatim: devices.json lives in the config
// directory under $HOME, so the store's own errors name that path — the local
// username with it. Any paired device can provoke one by asking for the list,
// and the socket must carry the fact rather than the filesystem. The operator
// still gets the real thing, in the log.
func TestStoreErrorsDoNotReachClientsVerbatim(t *testing.T) {
	// A store rooted in a plain file: every load fails with ENOTDIR, naming
	// the path it tried. Deterministic, and it does not depend on running as
	// a user who can be denied by mode bits.
	dir := filepath.Join(t.TempDir(), "not-a-directory")
	if err := os.WriteFile(dir, []byte("not a directory"), 0o600); err != nil {
		t.Fatal(err)
	}

	srv := New(session.NewRegistry(time.Now), nil, http.NotFoundHandler(), "test",
		Identity{Devices: crypto.NewDeviceStore(dir)})
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)
	srv.SetAuth(local.NewAuth(tok, portOf(t, ts)))
	buf := &syncBuffer{}
	srv.SetLogger(slog.New(slog.NewTextHandler(buf, nil)))

	for _, tc := range []struct {
		name string
		op   any
		code string
		log  string
	}{
		{"list", wire.Devices{}, "devices_unavailable", "device list unavailable"},
		{"revoke", wire.Revoke{DeviceID: "abcdefabcdef"}, "revoke_failed", "revoke refused"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c := dial(t, ts)
			writeControl(t, c, wire.Hello{Ver: "test"})
			writeControl(t, c, tc.op)

			readUntil(t, c, func(msg any, _ []byte) bool {
				e, ok := msg.(wire.Error)
				if !ok {
					return false
				}
				if e.Code != tc.code {
					t.Fatalf("error code = %q, want %q", e.Code, tc.code)
				}
				if strings.Contains(e.Msg, dir) {
					t.Fatalf("the error leaked the store path: %q", e.Msg)
				}
				// Nothing weaker than "no path at all": a message carrying any
				// part of a filesystem is one this assertion should catch
				// whatever the temp directory happens to be called.
				if strings.Contains(e.Msg, "/") {
					t.Fatalf("the error carries a filesystem path: %q", e.Msg)
				}
				return true
			})

			waitForLog(t, buf, tc.log)
			if !logLineContains(buf, tc.log, dir) {
				t.Fatalf("the store error never reached the log:\n%s", buf.String())
			}
		})
	}
}

// --- relay status ---

// TestPairingURLPrefersTheRelayOrigin: the QR is opened by a phone, and a URL
// naming 127.0.0.1 is one the phone cannot reach. Whenever this daemon has a
// live relay, that is the origin the second device is sent to; when the relay
// goes away the URL goes back to the origin the asking connection arrived on,
// which is the only address that is honest without one.
func TestPairingURLPrefersTheRelayOrigin(t *testing.T) {
	ts, srv := newPairServer(t)
	srv.SetRelayStatus(RelayConnected, "https://r.example")

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
	if want := "https://r.example" + PairPagePath + "?t=" + got.Token; !strings.HasPrefix(got.URL, want) {
		t.Fatalf("url = %q, want it to start with %q", got.URL, want)
	}

	// The relay drops. The next window must name the origin this connection
	// actually arrived on rather than a relay that is no longer carrying
	// anything.
	srv.SetRelayStatus(RelayOff, "")
	writeControl(t, c, wire.PairStart{})
	readUntil(t, c, func(msg any, _ []byte) bool {
		p, ok := msg.(wire.Pairing)
		if !ok || p.Token == got.Token {
			return false
		}
		if want := ts.URL + PairPagePath + "?t=" + p.Token; !strings.HasPrefix(p.URL, want) {
			t.Fatalf("url after the relay went away = %q, want it to start with %q", p.URL, want)
		}
		return true
	})
}

// TestWelcomeReportsTheRelay: the status is not broadcast, so a client learns
// it from the welcome its own connection opens with — which means the welcome
// has to carry whatever was true at the moment that connection was accepted.
func TestWelcomeReportsTheRelay(t *testing.T) {
	ts, _, srv := newTestServerUI(t, http.NotFoundHandler())

	// No relay: the field is absent, not an object saying "off".
	c := dial(t, ts)
	readUntil(t, c, func(msg any, _ []byte) bool {
		w, ok := msg.(wire.Welcome)
		if !ok {
			return false
		}
		if w.Relay != nil {
			t.Fatalf("a daemon with no relay sent relay = %+v, want nothing", *w.Relay)
		}
		return true
	})

	// The machine's identity arrives with the relay configuration, before any
	// socket is up: it comes from relay.json, not from the connection, so a
	// welcome sent while the transport is still dialling already carries it.
	srv.SetRelayMachine("karns-macbook-pro-a1b2", "Karn's MacBook Pro")
	srv.SetRelayStatus(RelayConnecting, "")
	c = dial(t, ts)
	readUntil(t, c, func(msg any, _ []byte) bool {
		w, ok := msg.(wire.Welcome)
		if !ok {
			return false
		}
		if w.Relay == nil {
			t.Fatal("welcome carried no relay while the transport was dialling")
		}
		if w.Relay.Status != RelayConnecting || w.Relay.Origin != "" {
			t.Fatalf("relay = %+v, want {connecting}", *w.Relay)
		}
		if w.Relay.MachineID != "karns-macbook-pro-a1b2" || w.Relay.MachineName != "Karn's MacBook Pro" {
			t.Fatalf("relay = %+v, want the machine id and name from the configuration", *w.Relay)
		}
		return true
	})

	srv.SetRelayStatus(RelayConnected, "https://r.example")
	c = dial(t, ts)
	readUntil(t, c, func(msg any, _ []byte) bool {
		w, ok := msg.(wire.Welcome)
		if !ok {
			return false
		}
		if w.Relay == nil {
			t.Fatal("welcome carried no relay while the transport was connected")
		}
		if w.Relay.Status != RelayConnected || w.Relay.Origin != "https://r.example" {
			t.Fatalf("relay = %+v, want {connected https://r.example}", *w.Relay)
		}
		if w.Relay.MachineID != "karns-macbook-pro-a1b2" || w.Relay.MachineName != "Karn's MacBook Pro" {
			t.Fatalf("relay = %+v, want the machine id and name from the configuration", *w.Relay)
		}
		return true
	})
}

// TestSetRelayStatusRefusesStatesItCannotMean guards the two ways a caller can
// hand this server a status that says something it does not mean.
//
// The wire field is a closed set of three strings and the TypeScript type is a
// union of the same three, so a fourth would reach a client that has no branch
// for it. And "connected" with no origin is a contradiction: the origin is the
// entire use of being connected — it is what a pairing URL is built from — so a
// connection that cannot name one is still, as far as anything downstream is
// concerned, dialling.
func TestSetRelayStatusRefusesStatesItCannotMean(t *testing.T) {
	srv := New(session.NewRegistry(time.Now), nil, http.NotFoundHandler(), "test", Identity{})

	if info := srv.relayInfo(); info != nil {
		t.Fatalf("a freshly built server reports relay = %+v, want nothing", *info)
	}
	if got := srv.pairingOrigin("http://127.0.0.1:7717"); got != "http://127.0.0.1:7717" {
		t.Fatalf("pairingOrigin = %q with no relay, want the connection's own origin", got)
	}

	srv.SetRelayStatus("hallucinating", "https://r.example")
	if info := srv.relayInfo(); info != nil {
		t.Fatalf("an unknown status was reported as %+v, want it treated as off", *info)
	}
	if got := srv.pairingOrigin("http://127.0.0.1:7717"); got != "http://127.0.0.1:7717" {
		t.Fatalf("pairingOrigin = %q under an unknown status, want the connection's own origin", got)
	}

	srv.SetRelayStatus(RelayConnected, "")
	info := srv.relayInfo()
	if info == nil {
		t.Fatal("a connected relay with no origin was reported as no relay at all")
	}
	if info.Status != RelayConnecting {
		t.Fatalf("relay status = %q for a connection with no origin, want %q", info.Status, RelayConnecting)
	}
	if got := srv.pairingOrigin("http://127.0.0.1:7717"); got != "http://127.0.0.1:7717" {
		t.Fatalf("pairingOrigin = %q for a relay with no origin, want the connection's own origin", got)
	}

	// And "connecting" never carries an origin, whatever it was handed.
	srv.SetRelayStatus(RelayConnecting, "https://r.example")
	if info := srv.relayInfo(); info == nil || info.Origin != "" {
		t.Fatalf("relay = %+v while connecting, want no origin", info)
	}
}

// --- the Remote screen's relay endpoints -------------------------------------

// TestRelayUIEndpointSurface pins the surface before any service exists: the
// mutating paths take POST and nothing else, every path wants auth, and a
// daemon nobody wired a RelayUI into answers 404 rather than pretending.
func TestRelayUIEndpointSurface(t *testing.T) {
	ts, _, _ := newTestServerUI(t, http.NotFoundHandler())

	// methodPolicy lets GET through everywhere, so the handler itself must
	// refuse a GET spelling of the mutation — even an authenticated one.
	getReq, err := http.NewRequest(http.MethodGet, ts.URL+RelayDeployPath, nil)
	if err != nil {
		t.Fatalf("NewRequest: %v", err)
	}
	getReq.AddCookie(&http.Cookie{Name: tsCookie(ts), Value: tok})
	getReq.Header.Set("Sec-Fetch-Site", "same-origin")
	resp, err := http.DefaultClient.Do(getReq)
	if err != nil {
		t.Fatalf("GET deploy: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusMethodNotAllowed {
		t.Fatalf("authenticated GET %s = %d, want 405", RelayDeployPath, resp.StatusCode)
	}

	// POST without a credential is refused.
	resp, err = http.Post(ts.URL+RelayUpdatePath, "application/json", strings.NewReader("{}"))
	if err != nil {
		t.Fatalf("POST update: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("unauthenticated POST %s = %d, want 401", RelayUpdatePath, resp.StatusCode)
	}

	// Authenticated, but no service wired: 404, the same answer an absent
	// endpoint gives.
	req, err := http.NewRequest(http.MethodPost, ts.URL+RelayDeployPath, strings.NewReader(`{"token":"x"}`))
	if err != nil {
		t.Fatalf("NewRequest: %v", err)
	}
	req.AddCookie(&http.Cookie{Name: tsCookie(ts), Value: tok})
	req.Header.Set("Origin", ts.URL)
	resp, err = http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("POST deploy: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("POST with no service = %d, want 404", resp.StatusCode)
	}

	// Info is a plain authenticated read with the same no-service answer.
	req, _ = http.NewRequest(http.MethodGet, ts.URL+RelayInfoPath, nil)
	req.AddCookie(&http.Cookie{Name: tsCookie(ts), Value: tok})
	req.Header.Set("Sec-Fetch-Site", "same-origin")
	resp, err = http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("GET info: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("GET info with no service = %d, want 404", resp.StatusCode)
	}
}

// stubRelayUI answers the join endpoint; everything else is unused by the
// test that carries it.
type stubRelayUI struct {
	join string
}

func (s *stubRelayUI) Status(context.Context) RelayUIStatus { return RelayUIStatus{} }
func (s *stubRelayUI) Provision(context.Context, RelayUIDeployRequest) (RelayUIDeployResult, error) {
	return RelayUIDeployResult{}, nil
}
func (s *stubRelayUI) Update(context.Context, RelayUIDeployRequest) (RelayUIDeployResult, error) {
	return RelayUIDeployResult{}, nil
}
func (s *stubRelayUI) JoinCommand(context.Context) (string, bool, error) {
	if s.join == "" {
		return "", false, nil
	}
	return s.join, true, nil
}
func (s *stubRelayUI) SetAddress(context.Context, string) (RelayUIDeployResult, error) {
	return RelayUIDeployResult{}, nil
}

// TestRelayUIJoinEndpoint: an authenticated GET gets the line back, and a
// daemon whose service has none answers 404 — the same shape as unconfigured.
func TestRelayUIJoinEndpoint(t *testing.T) {
	ts, _, srv := newTestServerUI(t, http.NotFoundHandler())
	srv.SetRelayUI(&stubRelayUI{join: "flue relay join wss://r --secret s"})

	req, err := http.NewRequest(http.MethodGet, ts.URL+RelayJoinPath, nil)
	if err != nil {
		t.Fatalf("NewRequest: %v", err)
	}
	req.AddCookie(&http.Cookie{Name: tsCookie(ts), Value: tok})
	req.Header.Set("Sec-Fetch-Site", "same-origin")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("GET join: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("GET join = %d, want 200", resp.StatusCode)
	}
	var body struct {
		JoinCommand string `json:"join_command"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatalf("decoding: %v", err)
	}
	if body.JoinCommand != "flue relay join wss://r --secret s" {
		t.Fatalf("join_command = %q", body.JoinCommand)
	}

	// Unauthenticated: refused before the secret-bearing line is built.
	plain, err := http.Get(ts.URL + RelayJoinPath)
	if err != nil {
		t.Fatalf("plain GET: %v", err)
	}
	plain.Body.Close()
	if plain.StatusCode != http.StatusUnauthorized {
		t.Fatalf("unauthenticated GET join = %d, want 401", plain.StatusCode)
	}

	// A service with nothing to say is a 404.
	srv.SetRelayUI(&stubRelayUI{})
	req2, _ := http.NewRequest(http.MethodGet, ts.URL+RelayJoinPath, nil)
	req2.AddCookie(&http.Cookie{Name: tsCookie(ts), Value: tok})
	req2.Header.Set("Sec-Fetch-Site", "same-origin")
	resp2, err := http.DefaultClient.Do(req2)
	if err != nil {
		t.Fatalf("GET join unconfigured: %v", err)
	}
	resp2.Body.Close()
	if resp2.StatusCode != http.StatusNotFound {
		t.Fatalf("unconfigured GET join = %d, want 404", resp2.StatusCode)
	}
}
