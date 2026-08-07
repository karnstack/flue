package relay

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/flynn/noise"
	"github.com/karnstack/flue/internal/daemon"
	"github.com/karnstack/flue/internal/relaywire"
)

// stubServer stands in for *daemon.Server in the tests that are about the
// socket rather than about what it carries. It counts what reached it, so a
// test that expects nothing to be served can say so.
type stubServer struct {
	mu       sync.Mutex
	calls    int
	statuses []relayStatus
}

// relayStatus is one SetRelayStatus call, kept in order so a test can assert
// what the daemon was told and when.
type relayStatus struct {
	status string
	origin string
}

func (s *stubServer) SetRelayStatus(status, origin string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.statuses = append(s.statuses, relayStatus{status, origin})
}

// lastStatus is the most recent state the daemon was told about, or the zero
// value if it has been told nothing.
func (s *stubServer) lastStatus() relayStatus {
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.statuses) == 0 {
		return relayStatus{}
	}
	return s.statuses[len(s.statuses)-1]
}

// awaitStatus waits for the daemon to have been told want, and fails with
// everything it was told instead.
func (s *stubServer) awaitStatus(t *testing.T, want relayStatus) {
	t.Helper()
	deadline := time.Now().Add(waitFor)
	for {
		if got := s.lastStatus(); got == want {
			return
		}
		if time.Now().After(deadline) {
			s.mu.Lock()
			history := append([]relayStatus(nil), s.statuses...)
			s.mu.Unlock()
			t.Fatalf("the daemon was never told %+v within %s; it was told %+v", want, waitFor, history)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func (s *stubServer) ServeConn(context.Context, daemon.MessageConn, daemon.ConnMeta) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.calls++
}

// PairDevice refuses, because these tests have no identity to pair against and
// a refusal is the one answer that is always honest.
func (s *stubServer) PairDevice([]byte, string) daemon.PairOutcome {
	return daemon.PairRefusal()
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

// testMachineID is the id every transport in this file dials as. Distinctive
// on purpose: the dial-path assertion is only worth something if a match could
// not be a coincidence.
const testMachineID = "karns-macbook-pro-a1b2"

// newTestTransport builds an adapter pointed at r. The identity and the device
// store are the zero values: this task never runs a handshake, and a test that
// does (Task 8) passes real ones.
func newTestTransport(t *testing.T, r *fakeRelay, secret string, log *slog.Logger) (*Transport, *stubServer) {
	t.Helper()
	srv := &stubServer{}
	if log == nil {
		log = slog.New(slog.DiscardHandler)
	}
	tr, err := New(Config{
		URL:       r.URL(),
		Secret:    secret,
		Origin:    "https://relay.example",
		MachineID: testMachineID,
	}, srv, noise.DHKey{}, nil, log)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
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

func TestNewRefusesAnIncompleteConfig(t *testing.T) {
	t.Parallel()
	full := Config{URL: "wss://relay.example", Secret: "s3cr3t", Origin: "https://relay.example", MachineID: "karns-mbp-a1b2"}

	// Origin is the one worth stating a reason for. It is what every announced
	// open and every forwarded pair is checked against, so an empty one does
	// not merely omit a value — it disarms the check, since a relay announcing
	// `origin:""` then matches. It is also what ConnMeta.Origin carries into
	// the daemon, which is what pairing URLs are built from.
	//
	// The machine id is close behind: it is the path this transport dials, and
	// a transport that dialled /daemon/ with nothing after it would meet the
	// Worker's 404 forever while the config *looked* complete. The grammar
	// rows are the same fault with the field filled in — an id the Worker
	// will not route (relay/src/index.ts, MACHINE_ID) earns that 404 just as
	// forever, and only a hand-edited relay.json can produce one.
	for _, tc := range []struct {
		name string
		cfg  Config
	}{
		{"no URL", Config{Secret: full.Secret, Origin: full.Origin, MachineID: full.MachineID}},
		{"no secret", Config{URL: full.URL, Origin: full.Origin, MachineID: full.MachineID}},
		{"no origin", Config{URL: full.URL, Secret: full.Secret, MachineID: full.MachineID}},
		{"no machine id", Config{URL: full.URL, Secret: full.Secret, Origin: full.Origin}},
		{"nothing at all", Config{}},
		{"a machine id with a capital", Config{URL: full.URL, Secret: full.Secret, Origin: full.Origin, MachineID: "My-Mac"}},
		{"a machine id led by a dash", Config{URL: full.URL, Secret: full.Secret, Origin: full.Origin, MachineID: "-a1b2"}},
		{"a machine id past 63 characters", Config{URL: full.URL, Secret: full.Secret, Origin: full.Origin, MachineID: strings.Repeat("a", 64)}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			tr, err := New(tc.cfg, &stubServer{}, noise.DHKey{}, nil, nil)
			if err == nil {
				t.Fatalf("New(%+v) built a transport, want an error", tc.cfg)
			}
			if !errors.Is(err, ErrIncompleteConfig) {
				t.Errorf("New(%+v) = %v, want it to wrap ErrIncompleteConfig", tc.cfg, err)
			}
			if tr != nil {
				t.Errorf("New(%+v) returned a non-nil transport alongside %v", tc.cfg, err)
			}
		})
	}

	t.Run("complete", func(t *testing.T) {
		t.Parallel()
		tr, err := New(full, &stubServer{}, noise.DHKey{}, nil, nil)
		if err != nil {
			t.Fatalf("New(%+v) = %v, want a transport", full, err)
		}
		if tr == nil {
			t.Fatal("New returned a nil transport and a nil error")
		}
	})

	t.Run("the machine id error names the field", func(t *testing.T) {
		t.Parallel()
		_, err := New(Config{URL: full.URL, Secret: full.Secret, Origin: full.Origin},
			&stubServer{}, noise.DHKey{}, nil, nil)
		if err == nil || !strings.Contains(err.Error(), "no machine id") {
			t.Fatalf("New without a machine id = %v, want an error saying \"no machine id\"", err)
		}
	})

	t.Run("the machine id grammar error names the fault and the value", func(t *testing.T) {
		t.Parallel()
		_, err := New(Config{URL: full.URL, Secret: full.Secret, Origin: full.Origin, MachineID: "My-Mac"},
			&stubServer{}, noise.DHKey{}, nil, nil)
		if err == nil || !strings.Contains(err.Error(), "not a valid slug") || !strings.Contains(err.Error(), "My-Mac") {
			t.Fatalf("New with machine id \"My-Mac\" = %v, want an error quoting it as not a valid slug", err)
		}
	})
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
	// The machine id rides the path and nothing else — no header, no query.
	// relay.json stores the bare wss:// host; the /daemon/<id> leg is this
	// transport's to append, so the relay knows which machine's hub this
	// socket is.
	if got, want := r.lastPath(t), "/daemon/"+testMachineID; got != want {
		t.Errorf("dial path = %q, want %q", got, want)
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

func TestTransportRefusesARedirectRatherThanFollowIt(t *testing.T) {
	t.Parallel()
	// net/http re-sends Authorization to the same host or a subdomain of it,
	// and compares hosts without looking at the scheme. A relay that answered
	// the upgrade with a redirect would therefore be handed the daemon secret
	// again — over plain http, or at a subdomain someone else owns. A 3xx is
	// never a valid handshake, so refusing costs nothing.
	var followed atomic.Int64
	mux := http.NewServeMux()
	mux.HandleFunc("/daemon/", func(w http.ResponseWriter, req *http.Request) {
		http.Redirect(w, req, "/elsewhere", http.StatusFound)
	})
	mux.HandleFunc("/elsewhere", func(w http.ResponseWriter, req *http.Request) {
		if req.Header.Get("Authorization") != "" {
			followed.Add(1)
		}
		http.Error(w, "no", http.StatusNotFound)
	})
	ts := httptest.NewServer(mux)
	t.Cleanup(ts.Close)

	srv := &stubServer{}
	tr, err := New(Config{
		URL:       "ws" + strings.TrimPrefix(ts.URL, "http"),
		Secret:    "s3cr3t",
		Origin:    "https://relay.example",
		MachineID: testMachineID,
	}, srv, noise.DHKey{}, nil, slog.New(slog.DiscardHandler))
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	runTransport(t, tr)

	// Long enough for the dial to fail, be retried, and fail again.
	time.Sleep(600 * time.Millisecond)
	if n := followed.Load(); n != 0 {
		t.Errorf("the adapter carried the secret through %d redirects", n)
	}
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

	// Both keepalives are keepalives. The daemon should never see a flue-ping —
	// the edge answers those from the Durable Object's auto-response — but the
	// spec gives either leg the right to send one, so receiving one must not be
	// the protocol error that closes the socket.
	c.sendText(t, relaywire.Ping)
	c.expectPing(t)
	if !c.stillOpen() {
		t.Fatal("the adapter closed the socket over an inbound keepalive")
	}
}

func TestTransportGivesUpOnASocketNothingAnswers(t *testing.T) {
	t.Parallel()
	// A socket that is open on this end only: the daemon's keepalives leave and
	// nothing ever comes back. Nothing else would notice — a read parks
	// indefinitely, and the daemon would believe it was reachable while every
	// browser found it gone.
	r := newFakeRelay(t, "s")
	r.deaf = true
	tr, _ := newTestTransport(t, r, "s", nil)
	tr.keepalive = 50 * time.Millisecond
	runTransport(t, tr)

	c := r.accept(t)
	c.waitClosed(t)
	r.accept(t)
}

func TestTransportReconnectsWhenTheRelayDropsTheSocket(t *testing.T) {
	t.Parallel()
	r := newFakeRelay(t, "s")
	tr, _ := newTestTransport(t, r, "s", nil)
	runTransport(t, tr)

	first := r.accept(t)
	first.kill()

	r.accept(t)
	if n := r.attempts(); n < 2 {
		t.Errorf("the relay saw %d upgrade attempts, want at least 2", n)
	}
}

// TestTransportReportsItsStatusToTheDaemon: the daemon builds pairing URLs and
// answers welcomes out of this status, so it has to track the socket rather
// than the configuration. In particular the status returns to "connecting" the
// moment the socket is lost — before the backoff, not after it — because a QR
// handed out during a thirty-second wait would otherwise name a relay that is
// carrying nothing.
func TestTransportReportsItsStatusToTheDaemon(t *testing.T) {
	t.Parallel()
	r := newFakeRelay(t, "s")
	tr, srv := newTestTransport(t, r, "s", nil)
	stop := runTransport(t, tr)

	first := r.accept(t)
	srv.awaitStatus(t, relayStatus{"connected", "https://relay.example"})
	// Dialling comes first, and it never claims an origin: nothing is reachable
	// through a socket that is not up yet.
	srv.mu.Lock()
	opening := srv.statuses[0]
	srv.mu.Unlock()
	if opening != (relayStatus{"connecting", ""}) {
		t.Errorf("the first status was %+v, want {connecting }", opening)
	}

	first.kill()
	srv.awaitStatus(t, relayStatus{"connecting", ""})

	r.accept(t)
	srv.awaitStatus(t, relayStatus{"connected", "https://relay.example"})

	// And a transport that has been told to stop is off, not perpetually
	// dialling: every welcome after this would otherwise announce a relay
	// nothing is trying to reach.
	stop()
	if got := srv.lastStatus(); got != (relayStatus{"off", ""}) {
		t.Errorf("status after Run returned = %+v, want {off }", got)
	}
}

// TestTransportReportsDiallingWhileTheRelayRefusesIt: a relay answering 401 is
// a relay this daemon is not reachable through, and the retry loop must not
// leave the daemon believing otherwise.
func TestTransportReportsDiallingWhileTheRelayRefusesIt(t *testing.T) {
	t.Parallel()
	r := newFakeRelay(t, "right")
	tr, srv := newTestTransport(t, r, "wrong", nil)
	runTransport(t, tr)

	r.waitAttempts(t, 2)
	if got := srv.lastStatus(); got != (relayStatus{"connecting", ""}) {
		t.Errorf("status while the relay refuses the secret = %+v, want {connecting }", got)
	}
}

func TestTransportEscalatesWhenTheRelayKeepsReplacingIt(t *testing.T) {
	t.Parallel()
	// The Durable Object gives the daemon leg to the newcomer and closes the
	// incumbent with 4000 "replaced" (relay/src/hub.ts), so two daemons pointed
	// at one relay evict each other in a loop. A backoff that reset on every
	// connect would run that loop at four to eight upgrades a second against a
	// Worker metered by the request.
	r := newFakeRelay(t, "s")
	r.replaceOnConnect = true
	tr, _ := newTestTransport(t, r, "s", nil)
	runTransport(t, tr)

	// Four attempts is far enough in for the widest gap to be unmistakably past
	// the first delay's 250 ms ceiling — the third wait alone is 500 ms to 1 s.
	// The budget is the escalation's own worst case (250 + 500 + 1000 ms) with
	// room to spare, since this is the one test that is waiting on the backoff
	// rather than on the adapter.
	r.waitAttemptsWithin(t, 4, 8*time.Second)
	if got := r.longestGap(); got < 400*time.Millisecond {
		t.Errorf("the widest gap between dials was %v; the backoff is not escalating", got)
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

// TestTransportSurvivesFramesItCannotServe: a daemon with no pairing identity
// has nothing to answer a handshake with, and a channel for a browser it never
// held is nothing to act on. Every one of these is refused or dropped, and none
// of them costs the socket — which is the only thing that would take every
// other browser on this machine down with it.
func TestTransportSurvivesFramesItCannotServe(t *testing.T) {
	t.Parallel()
	r := newFakeRelay(t, "s")
	tr, srv := newTestTransport(t, r, "s", nil)
	tr.keepalive = 50 * time.Millisecond
	runTransport(t, tr)

	c := r.accept(t)
	c.sendControl(t, relaywire.Open{Channel: 1, Origin: "https://relay.example"})
	c.sendControl(t, relaywire.Pair{ID: 7, Origin: "https://relay.example", Body: json.RawMessage(`{"token":"t"}`)})
	c.sendControl(t, relaywire.Closed{Channel: 1})
	c.send(t, 1, []byte("ciphertext for a channel this daemon does not hold"))

	c.expectPing(t)
	if !c.stillOpen() {
		t.Fatal("the adapter closed the socket over frames it is meant to refuse")
	}
	if n := srv.served(); n != 0 {
		t.Errorf("a daemon with no identity served %d connections, want 0", n)
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
