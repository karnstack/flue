package relay

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/karnstack/flue/internal/relaywire"
)

// waitFor bounds every "has the adapter done X yet" wait in this package. It is
// long enough that a loaded CI box does not fail a healthy adapter and short
// enough that a wedged one fails the test rather than the ten-minute suite
// timeout.
const waitFor = 3 * time.Second

// fakeRelay is the Worker's daemon leg, in process: an httptest.Server that
// checks the bearer token, upgrades, and hands each accepted socket to the
// test. It speaks only what spec/relay-protocol.md says the relay speaks —
// channel-framed binary messages and the two keepalive text frames — so a test
// against it is a test against the protocol rather than against the adapter's
// own idea of it.
//
// It answers flue-ping with flue-pong inline, which is what the Cloudflare edge
// does from the Durable Object's auto-response. From the daemon's side of the
// socket the two are indistinguishable, which is the point.
type fakeRelay struct {
	ts     *httptest.Server
	secret string

	// admits replaces the constant-secret compare, for the SaaS tests: there
	// the credential is a short-lived channel token the daemon minted, so which
	// strings are acceptable is the test's business rather than one value's.
	// Set before the transport is started, and read-only after.
	admits func(auth string) bool

	// conns carries every socket the relay accepted, oldest first. It is
	// buffered because the adapter reconnects on its own schedule and a test
	// that is between accepts must not stall the handler.
	conns chan *relayConn

	// replaceOnConnect makes the relay hand the leg to the newcomer and close
	// what it just accepted with 4000 "replaced", which is what a Durable
	// Object already holding a daemon socket does (relay/src/hub.ts) — and what
	// two daemons sharing one relay do to each other, forever.
	replaceOnConnect bool

	// deaf makes the relay read the daemon's keepalives and answer nothing, the
	// way a socket that is open on this end only behaves: the bytes leave, the
	// edge is not there to answer them, and nothing ever comes back.
	deaf bool

	mu sync.Mutex
	// upgrades counts upgrade requests, including the ones refused for a bad
	// token: it is what "the adapter retried" is measured in, and when each
	// arrived is what the escalation between them is measured in.
	upgrades int
	at       []time.Time
	auths    []string
	paths    []string
	live     []*relayConn
}

// newFakeRelay starts a relay that admits exactly "Bearer <secret>".
func newFakeRelay(t *testing.T, secret string) *fakeRelay {
	t.Helper()
	r := &fakeRelay{secret: secret, conns: make(chan *relayConn, 32)}
	mux := http.NewServeMux()
	// The subtree, the way the Worker routes it: the daemon leg dials
	// /daemon/<machine id>, and which id it presented is recorded for the test
	// to assert on. The bare path is registered too so a transport that lost
	// the id dials *something* — and the recorded path is what convicts it.
	mux.HandleFunc("/daemon", r.serveDaemon)
	mux.HandleFunc("/daemon/", r.serveDaemon)
	r.ts = httptest.NewServer(mux)
	// Registered before any transport's cleanup, so it runs after it: the
	// handler holds the hijacked socket for its lifetime, and httptest.Server
	// Close blocks on outstanding requests. The adapter's own shutdown is what
	// ends them.
	t.Cleanup(func() {
		r.killAll()
		r.ts.Close()
	})
	return r
}

// URL is the address the daemon leg is configured with — the bare host, the
// shape relay.json stores; the transport appends /daemon/<machine id> itself.
// ws:// rather than wss:// because httptest serves plain HTTP. The scheme is
// the only difference that matters here: the handshake, the header and the
// framing are the deployed ones.
func (r *fakeRelay) URL() string {
	return "ws" + strings.TrimPrefix(r.ts.URL, "http")
}

// admit is the relay's authorization: the shared secret unless a test said
// otherwise.
func (r *fakeRelay) admit(auth string) bool {
	if r.admits != nil {
		return r.admits(auth)
	}
	return auth == "Bearer "+r.secret
}

func (r *fakeRelay) serveDaemon(w http.ResponseWriter, req *http.Request) {
	auth := req.Header.Get("Authorization")
	r.mu.Lock()
	r.upgrades++
	r.at = append(r.at, time.Now())
	r.auths = append(r.auths, auth)
	r.paths = append(r.paths, req.URL.Path)
	r.mu.Unlock()

	if !r.admit(auth) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}

	ws, err := websocket.Accept(w, req, &websocket.AcceptOptions{
		// A Go dialer sends no Origin, so the library's host comparison has
		// nothing to check; the real Worker authenticates with the bearer
		// token, which this handler has already done.
		InsecureSkipVerify: true,
	})
	if err != nil {
		return
	}
	// The handler owns the hijacked connection for its whole life, so it must
	// not return until the socket is finished with; this is the backstop for
	// however it ends.
	defer ws.CloseNow()

	c := &relayConn{
		ws:   ws,
		msgs: make(chan relayMsg, 64),
		done: make(chan struct{}),
		deaf: r.deaf,
	}
	r.mu.Lock()
	r.live = append(r.live, c)
	r.mu.Unlock()

	if r.replaceOnConnect {
		_ = ws.Close(4000, "replaced")
		c.finish(4000)
		return
	}

	select {
	case r.conns <- c:
	default:
		// A test that never accepted this one still gets a socket that behaves:
		// it stays up until the adapter drops it, which is what ends the pump.
	}
	c.pump()
}

// accept waits for the relay's next daemon socket.
func (r *fakeRelay) accept(t *testing.T) *relayConn {
	t.Helper()
	select {
	case c := <-r.conns:
		return c
	case <-time.After(waitFor):
		t.Fatalf("the adapter did not connect within %s (%d upgrade attempts)", waitFor, r.attempts())
		return nil
	}
}

// noConn asserts that nothing connected while the test was looking away, which
// is how "the relay refused it" is told from "the relay let it in".
func (r *fakeRelay) noConn(t *testing.T) {
	t.Helper()
	select {
	case <-r.conns:
		t.Fatal("the relay accepted a socket it should have refused")
	default:
	}
}

// attempts is how many upgrade requests the relay has answered, refusals
// included.
func (r *fakeRelay) attempts() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.upgrades
}

// lastAuth is the Authorization header of the most recent upgrade request.
func (r *fakeRelay) lastAuth(t *testing.T) string {
	t.Helper()
	r.mu.Lock()
	defer r.mu.Unlock()
	if len(r.auths) == 0 {
		t.Fatal("no upgrade request reached the relay")
	}
	return r.auths[len(r.auths)-1]
}

// lastPath is the URL path of the most recent upgrade request — where the
// machine id travels, and the only place it does.
func (r *fakeRelay) lastPath(t *testing.T) string {
	t.Helper()
	r.mu.Lock()
	defer r.mu.Unlock()
	if len(r.paths) == 0 {
		t.Fatal("no upgrade request reached the relay")
	}
	return r.paths[len(r.paths)-1]
}

// longestGap is the widest interval between two consecutive upgrade requests,
// which is where a backoff that escalated shows up and a backoff that keeps
// resetting does not.
func (r *fakeRelay) longestGap() time.Duration {
	r.mu.Lock()
	defer r.mu.Unlock()
	var widest time.Duration
	for i := 1; i < len(r.at); i++ {
		if gap := r.at[i].Sub(r.at[i-1]); gap > widest {
			widest = gap
		}
	}
	return widest
}

// waitAttempts blocks until the relay has seen n upgrade requests.
func (r *fakeRelay) waitAttempts(t *testing.T, n int) {
	t.Helper()
	r.waitAttemptsWithin(t, n, waitFor)
}

// waitAttemptsWithin is waitAttempts for the tests that are waiting on the
// backoff itself and so need a budget the backoff's own delays fit inside.
func (r *fakeRelay) waitAttemptsWithin(t *testing.T, n int, within time.Duration) {
	t.Helper()
	deadline := time.Now().Add(within)
	for {
		if got := r.attempts(); got >= n {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("the adapter made %d upgrade attempts in %s, want at least %d", r.attempts(), within, n)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func (r *fakeRelay) killAll() {
	r.mu.Lock()
	live := append([]*relayConn(nil), r.live...)
	r.mu.Unlock()
	for _, c := range live {
		c.kill()
	}
}

// relayMsg is one message the relay read off the daemon socket.
type relayMsg struct {
	text bool
	data []byte
}

// relayConn is one accepted daemon socket, with the reader the relay runs over
// it. Everything read is queued for the test; a flue-ping is also answered
// where the edge would answer it.
type relayConn struct {
	ws   *websocket.Conn
	msgs chan relayMsg
	done chan struct{}
	deaf bool

	// status is the close code the daemon left with, readable once done is
	// closed. It is how a test asserts that a protocol error closed the socket
	// with 1002 rather than merely dropping it.
	status websocket.StatusCode
	once   sync.Once
}

func (c *relayConn) pump() {
	ctx := context.Background()
	for {
		typ, data, err := c.ws.Read(ctx)
		if err != nil {
			c.finish(websocket.CloseStatus(err))
			return
		}
		m := relayMsg{text: typ == websocket.MessageText, data: data}
		if m.text && string(data) == relaywire.Ping && !c.deaf {
			// Bounded, so a daemon that has stopped reading parks this write
			// rather than this handler: httptest.Server.Close waits on the
			// handler, and a handler that never returns costs the whole
			// package its timeout instead of one test its assertion.
			wctx, cancel := context.WithTimeout(ctx, waitFor)
			_ = c.ws.Write(wctx, websocket.MessageText, []byte(relaywire.Pong))
			cancel()
		}
		select {
		case c.msgs <- m:
		default:
		}
	}
}

// finish records how the socket ended before announcing that it did, so a
// reader that has seen done can read status without a lock.
func (c *relayConn) finish(status websocket.StatusCode) {
	c.once.Do(func() {
		c.status = status
		close(c.done)
	})
}

// expect returns the next message the daemon sent.
func (c *relayConn) expect(t *testing.T) relayMsg {
	t.Helper()
	m, ok := c.next(time.After(waitFor))
	if !ok {
		t.Fatalf("no message from the daemon within %s", waitFor)
	}
	return m
}

// next takes the next queued message, waiting until deadline fires or the
// socket ends. Anything already queued is returned first: a select between a
// ready msgs and a closed done picks uniformly, so a socket that ended a
// moment after the daemon spoke would swallow what it said half the time.
func (c *relayConn) next(deadline <-chan time.Time) (relayMsg, bool) {
	select {
	case m := <-c.msgs:
		return m, true
	default:
	}
	select {
	case m := <-c.msgs:
		return m, true
	case <-c.done:
		return relayMsg{}, false
	case <-deadline:
		return relayMsg{}, false
	}
}

// expectPing waits for the next keepalive, skipping anything else the daemon
// sent in the meantime.
func (c *relayConn) expectPing(t *testing.T) {
	t.Helper()
	deadline := time.After(waitFor)
	for {
		m, ok := c.next(deadline)
		if !ok {
			t.Fatalf("no %s within %s", relaywire.Ping, waitFor)
		}
		if m.text && string(m.data) == relaywire.Ping {
			return
		}
	}
}

// expectFrame returns the next binary message, decoded as a channel frame.
func (c *relayConn) expectFrame(t *testing.T) relaywire.Frame {
	t.Helper()
	m := c.expect(t)
	if m.text {
		t.Fatalf("expected a channel frame, got the text message %q", m.data)
	}
	f, err := relaywire.Decode(m.data)
	if err != nil {
		t.Fatalf("the daemon sent an undecodable frame: %v", err)
	}
	return f
}

// send writes one channel-framed binary message to the daemon.
func (c *relayConn) send(t *testing.T, channel uint32, payload []byte) {
	t.Helper()
	c.sendRaw(t, websocket.MessageBinary, relaywire.Encode(relaywire.Frame{Channel: channel, Payload: payload}))
}

// sendControl writes one control message on channel 0.
func (c *relayConn) sendControl(t *testing.T, msg any) {
	t.Helper()
	b, err := relaywire.EncodeControl(msg)
	if err != nil {
		t.Fatalf("encoding %T: %v", msg, err)
	}
	c.send(t, relaywire.ControlChannel, b)
}

// sendText writes a text message, which outside the keepalives is a protocol
// error the daemon must close on.
func (c *relayConn) sendText(t *testing.T, s string) {
	t.Helper()
	c.sendRaw(t, websocket.MessageText, []byte(s))
}

func (c *relayConn) sendRaw(t *testing.T, typ websocket.MessageType, b []byte) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), waitFor)
	defer cancel()
	if err := c.ws.Write(ctx, typ, b); err != nil {
		t.Fatalf("writing to the daemon socket: %v", err)
	}
}

// kill drops the socket without a close handshake, the way a relay that
// restarts or an edge that times a connection out drops it.
func (c *relayConn) kill() { _ = c.ws.CloseNow() }

// waitClosed blocks until the daemon's end of this socket is gone and returns
// the close code it left, if any.
func (c *relayConn) waitClosed(t *testing.T) websocket.StatusCode {
	t.Helper()
	select {
	case <-c.done:
		return c.status
	case <-time.After(waitFor):
		t.Fatalf("the daemon kept the socket open for %s", waitFor)
		return 0
	}
}

// stillOpen reports whether the daemon is still on the other end, for the
// assertions that a frame was dropped rather than fatal.
func (c *relayConn) stillOpen() bool {
	select {
	case <-c.done:
		return false
	default:
		return true
	}
}
