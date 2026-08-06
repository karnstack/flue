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

	// conns carries every socket the relay accepted, oldest first. It is
	// buffered because the adapter reconnects on its own schedule and a test
	// that is between accepts must not stall the handler.
	conns chan *relayConn

	mu sync.Mutex
	// upgrades counts upgrade requests, including the ones refused for a bad
	// token: it is what "the adapter retried" is measured in.
	upgrades int
	auths    []string
	live     []*relayConn
}

// newFakeRelay starts a relay that admits exactly "Bearer <secret>".
func newFakeRelay(t *testing.T, secret string) *fakeRelay {
	t.Helper()
	r := &fakeRelay{secret: secret, conns: make(chan *relayConn, 32)}
	mux := http.NewServeMux()
	mux.HandleFunc("/daemon", r.serveDaemon)
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

// URL is the address the daemon leg dials, ws:// rather than wss:// because
// httptest serves plain HTTP. The scheme is the only difference that matters
// here: the handshake, the header and the framing are the deployed ones.
func (r *fakeRelay) URL() string {
	return "ws" + strings.TrimPrefix(r.ts.URL, "http") + "/daemon"
}

func (r *fakeRelay) serveDaemon(w http.ResponseWriter, req *http.Request) {
	auth := req.Header.Get("Authorization")
	r.mu.Lock()
	r.upgrades++
	r.auths = append(r.auths, auth)
	r.mu.Unlock()

	if auth != "Bearer "+r.secret {
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
	c := &relayConn{
		ws:   ws,
		msgs: make(chan relayMsg, 64),
		done: make(chan struct{}),
	}
	r.mu.Lock()
	r.live = append(r.live, c)
	r.mu.Unlock()
	select {
	case r.conns <- c:
	default:
		// A test that never accepted this one still gets a socket that behaves:
		// it stays up until the adapter drops it, which is what ends the
		// handler below.
	}

	c.pump()
	// The handler owns the hijacked connection for its whole life; returning
	// early would close it under the test's feet.
	ws.CloseNow()
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

// waitAttempts blocks until the relay has seen n upgrade requests.
func (r *fakeRelay) waitAttempts(t *testing.T, n int) {
	t.Helper()
	deadline := time.Now().Add(waitFor)
	for {
		if got := r.attempts(); got >= n {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("the adapter made %d upgrade attempts in %s, want at least %d", r.attempts(), waitFor, n)
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
		if m.text && string(data) == relaywire.Ping {
			_ = c.ws.Write(ctx, websocket.MessageText, []byte(relaywire.Pong))
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
	select {
	case m := <-c.msgs:
		return m
	case <-c.done:
		t.Fatal("the daemon socket closed while the test was waiting for a message")
		return relayMsg{}
	case <-time.After(waitFor):
		t.Fatalf("no message from the daemon within %s", waitFor)
		return relayMsg{}
	}
}

// expectPing waits for the next keepalive, skipping anything else the daemon
// sent in the meantime.
func (c *relayConn) expectPing(t *testing.T) {
	t.Helper()
	deadline := time.After(waitFor)
	for {
		select {
		case m := <-c.msgs:
			if m.text && string(m.data) == relaywire.Ping {
				return
			}
		case <-c.done:
			t.Fatal("the daemon socket closed before a keepalive arrived")
		case <-deadline:
			t.Fatalf("no %s within %s", relaywire.Ping, waitFor)
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
