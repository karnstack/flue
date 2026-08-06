package relay

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/flynn/noise"
	"github.com/karnstack/flue/internal/daemon"
	"github.com/karnstack/flue/internal/relaywire"
)

// stubServer stands in for *daemon.Server. Nothing in this task reaches
// ServeConn — channels arrive in Task 8 — so it only has to satisfy the
// interface, and a call to it is a bug this stub records rather than hides.
type stubServer struct {
	mu    sync.Mutex
	calls int
}

func (s *stubServer) ServeConn(context.Context, daemon.MessageConn, daemon.ConnMeta) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.calls++
}

func (s *stubServer) served() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.calls
}

// syncBuffer is a log sink a test can read while the transport's goroutines are
// still writing to it.
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

// newTestTransport builds an adapter pointed at r. The identity and the device
// store are the zero values: this task never runs a handshake, and a test that
// does (Task 8) passes real ones.
func newTestTransport(t *testing.T, r *fakeRelay, secret string, log *slog.Logger) (*Transport, *stubServer) {
	t.Helper()
	srv := &stubServer{}
	if log == nil {
		log = slog.New(slog.DiscardHandler)
	}
	tr := New(Config{
		URL:    r.URL(),
		Secret: secret,
		Origin: "https://relay.example",
	}, srv, noise.DHKey{}, nil, log)
	return tr, srv
}

// runTransport starts Run in the background and stops it — waiting for the loop
// to return — when the test ends or the returned func is called.
func runTransport(t *testing.T, tr *Transport) func() {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- tr.Run(ctx) }()

	var once sync.Once
	stop := func() {
		once.Do(func() {
			cancel()
			select {
			case err := <-done:
				// Being asked to stop, and stopping, is not an error the
				// caller has to filter out — the same contract
				// daemon.ListenAndServe keeps.
				if err != nil {
					t.Errorf("Run returned %v after its context was cancelled, want nil", err)
				}
			case <-time.After(waitFor):
				t.Errorf("Run did not return within %s of its context being cancelled", waitFor)
			}
		})
	}
	t.Cleanup(stop)
	return stop
}

func TestTransportDialsTheRelayWithBearerAuth(t *testing.T) {
	t.Parallel()
	r := newFakeRelay(t, "s3cr3t")
	tr, srv := newTestTransport(t, r, "s3cr3t", nil)
	runTransport(t, tr)

	r.accept(t)
	if got, want := r.lastAuth(t), "Bearer s3cr3t"; got != want {
		t.Errorf("Authorization header = %q, want %q", got, want)
	}
	if n := srv.served(); n != 0 {
		t.Errorf("ServeConn was called %d times before any channel opened", n)
	}
}

func TestTransportRetriesWhenTheRelayRefusesTheSecret(t *testing.T) {
	t.Parallel()
	r := newFakeRelay(t, "right")
	tr, _ := newTestTransport(t, r, "wrong", nil)
	runTransport(t, tr)

	// A 401 is not a reason to give up: the operator may be rotating the
	// secret, and a daemon that stopped dialling would never come back.
	r.waitAttempts(t, 2)
	r.noConn(t)
}

func TestTransportKeepsTheSocketAlive(t *testing.T) {
	t.Parallel()
	r := newFakeRelay(t, "s")
	tr, _ := newTestTransport(t, r, "s", nil)
	tr.keepalive = 50 * time.Millisecond
	runTransport(t, tr)

	c := r.accept(t)
	c.expectPing(t)
	// The relay answered flue-pong where the edge would. A second ping proves
	// the adapter dropped that pong silently rather than treating a text frame
	// it did not expect as a protocol error.
	c.expectPing(t)
}

func TestTransportReconnectsWhenTheRelayDropsTheSocket(t *testing.T) {
	t.Parallel()
	r := newFakeRelay(t, "s")
	tr, _ := newTestTransport(t, r, "s", nil)
	runTransport(t, tr)

	first := r.accept(t)
	first.kill()

	second := r.accept(t)
	if second == first {
		t.Fatal("the relay handed back the socket it had just dropped")
	}
	if n := r.attempts(); n < 2 {
		t.Errorf("the relay saw %d upgrade attempts, want at least 2", n)
	}
}

func TestTransportClosesOnAProtocolError(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name string
		send func(t *testing.T, c *relayConn)
	}{
		{
			// Apart from the keepalives, a text frame is not this protocol.
			name: "an unexpected text frame",
			send: func(t *testing.T, c *relayConn) { c.sendText(t, "hello") },
		},
		{
			// A frame with no room for the channel header is malformed.
			name: "a frame shorter than the channel header",
			send: func(t *testing.T, c *relayConn) {
				c.sendRaw(t, websocket.MessageBinary, []byte{0, 0, 1})
			},
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			r := newFakeRelay(t, "s")
			tr, _ := newTestTransport(t, r, "s", nil)
			runTransport(t, tr)

			c := r.accept(t)
			tc.send(t, c)

			if got, want := c.waitClosed(t), websocket.StatusProtocolError; got != want {
				t.Errorf("close code = %v, want %v", got, want)
			}
			// And it comes back: a relay that speaks nonsense once is still the
			// only way home.
			r.accept(t)
		})
	}
}

func TestTransportDropsFramesTheChannelLayerWillOwn(t *testing.T) {
	t.Parallel()
	r := newFakeRelay(t, "s")
	tr, _ := newTestTransport(t, r, "s", nil)
	tr.keepalive = 50 * time.Millisecond
	runTransport(t, tr)

	c := r.accept(t)
	c.sendControl(t, relaywire.Open{Channel: 1, Origin: "https://relay.example"})
	c.sendControl(t, relaywire.Pair{ID: 7, Origin: "https://relay.example", Body: json.RawMessage(`{"token":"t"}`)})
	c.sendControl(t, relaywire.Closed{Channel: 1})
	c.send(t, 1, []byte("ciphertext the channel layer will decrypt"))

	// Task 8 gives all four a home. Until then they are logged and dropped, and
	// dropping them must not cost the socket.
	c.expectPing(t)
	if !c.stillOpen() {
		t.Fatal("the adapter closed the socket over frames it is meant to drop")
	}
}

func TestTransportNeverLogsTheSecret(t *testing.T) {
	t.Parallel()
	const secret = "sup3r-s3cret-token"
	var sink syncBuffer
	log := slog.New(slog.NewTextHandler(&sink, &slog.HandlerOptions{Level: slog.LevelDebug}))

	// A relay that refuses the token, then one that takes it and is fed a
	// protocol error: every log line this adapter writes, on every path.
	r := newFakeRelay(t, "other")
	tr, _ := newTestTransport(t, r, secret, log)
	tr.keepalive = 50 * time.Millisecond
	stop := runTransport(t, tr)
	r.waitAttempts(t, 2)
	stop()

	r2 := newFakeRelay(t, secret)
	tr2, _ := newTestTransport(t, r2, secret, log)
	tr2.keepalive = 50 * time.Millisecond
	runTransport(t, tr2)
	c := r2.accept(t)
	c.sendText(t, "not this protocol")
	c.waitClosed(t)
	r2.accept(t)

	if out := sink.String(); strings.Contains(out, secret) {
		t.Errorf("the relay secret reached the log:\n%s", out)
	}
}

func TestBackoffIsExponentialWithEqualJitter(t *testing.T) {
	t.Parallel()
	for attempt := range 40 {
		ceiling := min(backoffBase<<min(attempt, backoffMaxAttempt), backoffCap)
		for range 50 {
			got := backoffDelay(attempt)
			if got < ceiling/2 || got > ceiling {
				t.Fatalf("backoffDelay(%d) = %v, want within [%v, %v]", attempt, got, ceiling/2, ceiling)
			}
		}
	}
	if got := backoffDelay(0); got > backoffBase {
		t.Errorf("the first retry waits %v, want at most the %v base", got, backoffBase)
	}
	if got := backoffDelay(64); got > backoffCap {
		t.Errorf("a long outage waits %v, want at most the %v cap", got, backoffCap)
	}
}
