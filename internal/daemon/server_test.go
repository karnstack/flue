package daemon

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"
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
	srv := New(reg, nil, ui, "test")

	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)

	// Rebuild auth against the port httptest actually chose.
	port := 0
	if _, p, ok := strings.Cut(strings.TrimPrefix(ts.URL, "http://"), ":"); ok {
		for _, c := range p {
			port = port*10 + int(c-'0')
		}
	}
	srv.SetAuth(local.NewAuth(tok, port))
	return ts, reg, srv
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

func TestNonPrimaryResizeDoesNotChangePTY(t *testing.T) {
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
	var ref uint32
	readUntil(t, second, func(msg any, _ []byte) bool {
		a, ok := msg.(wire.Attached)
		if ok {
			ref = a.Ref
		}
		return ok
	})

	writeControl(t, second, wire.Resize{Ref: ref, Cols: 40, Rows: 10, Primary: false})
	time.Sleep(200 * time.Millisecond)

	if got := s.Info().Cols; got != 80 {
		t.Fatalf("Cols = %d after a non-primary resize, want 80", got)
	}
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
	req.AddCookie(&http.Cookie{Name: local.CookieName, Value: tok})
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
			if c.Name == local.CookieName && c.Value != tok {
				t.Fatalf("GET %s set %s to the client-supplied %q, want the daemon's own token",
					path, local.CookieName, c.Value)
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
		if c.Name == local.CookieName {
			found = c
		}
	}
	if found == nil {
		t.Fatalf("first load with a handoff token set no %s cookie", local.CookieName)
	}
	if found.Value != tok {
		t.Fatalf("%s cookie = %q, want the daemon's token", local.CookieName, found.Value)
	}
	if !found.HttpOnly {
		t.Error("cookie HttpOnly = false, want true")
	}
}

// TestOnlySafeMethodsAreRouted pins the invariant the test above depends on:
// flue's HTTP surface is read-only apart from one explicitly allowlisted mint
// path, so a mutation cannot be bolted onto it by a later task without this
// failing first.
//
// OPTIONS is in the list for every path including the mint path, and that is
// load-bearing rather than tidy: a CORS preflight that never succeeds is what
// stops a browser from ever sending a cross-origin request carrying the
// X-Flue-Token header that authenticates a mint.
func TestOnlySafeMethodsAreRouted(t *testing.T) {
	ts, _ := newTestServer(t)
	for _, path := range []string{"/", "/api/sessions", "/ws", MintPath} {
		for _, method := range []string{http.MethodPost, http.MethodPut, http.MethodPatch, http.MethodDelete, http.MethodOptions} {
			if path == MintPath && method == http.MethodPost {
				continue // the one allowlisted exception; see TestPOSTIsRoutedOnlyToTheMintPath
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

// TestPOSTIsRoutedOnlyToTheMintPath pins the width of the exception. A POST to
// any other path — including one that only differs by path normalisation, which
// http.ServeMux would clean before matching — must be refused before it reaches
// a handler.
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
			t.Errorf("POST %s = 200; only %s may answer a POST", path, MintPath)
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
	req.AddCookie(&http.Cookie{Name: local.CookieName, Value: token})
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
		if c.Name == local.CookieName {
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
		if c.Name == local.CookieName {
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
					if c.Name == local.CookieName {
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
	srv := New(reg, nil, http.NotFoundHandler(), "test")
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
		if c.Name == local.CookieName {
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
			if c.Name == local.CookieName {
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
	srv := New(reg, nil, http.NotFoundHandler(), "test")
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
	srv := New(reg, local.NewAuth(tok, port), http.NotFoundHandler(), "test")

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
	srv := New(reg, local.NewAuth(tok, port), http.NotFoundHandler(), "test")

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
	srv := New(reg, local.NewAuth(tok, port), http.NotFoundHandler(), "test")

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
	c := newConn(ctx, cancel, nil, nil)

	// Fill the outbox with no writer draining it, i.e. a client that has
	// stopped reading its socket.
	for i := 0; i < outboxDepth; i++ {
		if err := c.enqueue(frame{websocket.MessageText, []byte("x")}); err != nil {
			t.Fatalf("enqueue %d: %v", i, err)
		}
	}

	done := make(chan error, 1)
	go func() { done <- c.enqueue(frame{websocket.MessageText, []byte("overflow")}) }()

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
	srv := New(reg, nil, nil, "test")

	newPeer := func() *conn {
		ctx, cancel := context.WithCancel(context.Background())
		t.Cleanup(cancel)
		c := newConn(ctx, cancel, nil, srv)
		c.attach[1] = &attachment{ref: 1, s: s, sub: s.Subscribe(0), done: make(chan struct{})}
		srv.claimPrimaryIfUnset(s.ID(), c)
		return c
	}

	wedged := newPeer()
	healthy := newPeer()
	for i := 0; i < outboxDepth; i++ {
		if err := wedged.enqueue(frame{websocket.MessageText, []byte("x")}); err != nil {
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
