package daemon

import (
	"bytes"
	"context"
	"errors"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/karnstack/flue/internal/crypto"
	"github.com/karnstack/flue/internal/session"
	"github.com/karnstack/flue/internal/transport/local"
	"github.com/karnstack/flue/internal/wire"
)

// pipeConn is an in-memory MessageConn for tests: what the test writes to
// `in`, ServeConn reads; what the daemon writes lands on `out`.
type pipeConn struct {
	in     chan pipeMsg
	out    chan pipeMsg
	closed chan struct{}
	once   sync.Once
}

type pipeMsg struct {
	text bool
	data []byte
}

func newPipeConn() *pipeConn {
	return &pipeConn{in: make(chan pipeMsg, 16), out: make(chan pipeMsg, 64), closed: make(chan struct{})}
}

func (p *pipeConn) Read(ctx context.Context) (bool, []byte, error) {
	select {
	case m, ok := <-p.in:
		if !ok {
			return false, nil, io.EOF
		}
		return m.text, m.data, nil
	case <-p.closed:
		return false, nil, io.EOF
	case <-ctx.Done():
		return false, nil, ctx.Err()
	}
}

func (p *pipeConn) Write(ctx context.Context, text bool, data []byte) error {
	select {
	case p.out <- pipeMsg{text, append([]byte(nil), data...)}:
		return nil
	case <-p.closed:
		return errors.New("closed")
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (p *pipeConn) Close() error { p.once.Do(func() { close(p.closed) }); return nil }

// expectControl reads frames off p.out until a text frame arrives, decodes it,
// and returns it; it fails the test after a timeout.
func expectControl(t *testing.T, p *pipeConn) any {
	t.Helper()
	deadline := time.After(2 * time.Second)
	for {
		select {
		case m := <-p.out:
			if !m.text {
				continue
			}
			msg, err := wire.DecodeControl(m.data)
			if err != nil {
				t.Fatalf("undecodable control frame: %v", err)
			}
			return msg
		case <-deadline:
			t.Fatal("no control frame arrived")
		}
	}
}

func TestServeConnSpeaksTheWireProtocol(t *testing.T) {
	srv := New(session.NewRegistry(time.Now), local.NewAuth("tok", 0), nil, "test", Identity{})
	p := newPipeConn()
	done := make(chan struct{})
	go func() { srv.ServeConn(context.Background(), p, ConnMeta{Peer: "test"}); close(done) }()

	// The daemon speaks first: Welcome.
	if w, ok := expectControl(t, p).(wire.Welcome); !ok {
		t.Fatalf("first frame was not a welcome: %#v", w)
	}
	// And answers a list.
	b, _ := wire.EncodeControl(wire.List{})
	p.in <- pipeMsg{text: true, data: b}
	if _, ok := expectControl(t, p).(wire.Sessions); !ok {
		t.Fatal("list was not answered with sessions")
	}
	// Closing the conn ends ServeConn.
	p.Close()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("ServeConn did not return after the conn closed")
	}
}

// panicConn is a MessageConn whose read panics, standing in for any unhandled
// failure on the serve path. It writes and closes like the pipe it embeds.
type panicConn struct{ *pipeConn }

func (panicConn) Read(context.Context) (bool, []byte, error) { panic("boom") }

// TestServeConnClosesTheTransportOnTheWayOutOfAPanic: the close is what returns
// the transport's own resources — for the relay, a multiplexed channel over a
// socket shared with every other device — so it cannot be the one step that a
// panic in the connection state machine skips.
func TestServeConnClosesTheTransportOnTheWayOutOfAPanic(t *testing.T) {
	srv := New(session.NewRegistry(time.Now), local.NewAuth("tok", 0), nil, "test", Identity{})
	p := newPipeConn()

	func() {
		defer func() {
			if recover() == nil {
				t.Error("the panic was swallowed rather than propagated")
			}
		}()
		srv.ServeConn(context.Background(), panicConn{p}, ConnMeta{Peer: "relay"})
	}()

	select {
	case <-p.closed:
	default:
		t.Fatal("ServeConn left the transport open")
	}
	if len(srv.allConns()) != 0 {
		t.Fatal("ServeConn left the connection registered")
	}
}

// TestServeConnStampsTheDeviceLastSeen: "last seen" is what the devices screen
// shows, and a connection is the only event that can move it. Nothing on the
// local transport carries a device, so this is the seam that makes the column
// true once the relay arrives.
func TestServeConnStampsTheDeviceLastSeen(t *testing.T) {
	store := crypto.NewDeviceStore(t.TempDir())
	dev, err := store.Add("phone", bytes.Repeat([]byte{0x2a}, 32))
	if err != nil {
		t.Fatalf("Add: %v", err)
	}
	// Backdated, so the assertion is about the daemon's write rather than about
	// two calls to time.Now landing in different nanoseconds.
	stale := time.Now().Add(-time.Hour)
	if ok, err := store.UpdateLastSeen(dev.ID, stale); err != nil || !ok {
		t.Fatalf("backdating the device: %v, %v", ok, err)
	}

	srv := New(session.NewRegistry(time.Now), local.NewAuth("tok", 0), nil, "test",
		Identity{Devices: store})
	p := newPipeConn()
	defer p.Close()
	go srv.ServeConn(context.Background(), p, ConnMeta{Peer: "relay", DeviceID: dev.ID})
	expectControl(t, p) // welcome: the stamp happens before the conn is served

	list, err := store.List()
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(list) != 1 {
		t.Fatalf("registry = %+v, want the one device", list)
	}
	if !list[0].LastSeen.After(stale) {
		t.Fatalf("LastSeen = %v, want something later than %v", list[0].LastSeen, stale)
	}
}

// TestServeConnRefusesADeviceTheRegistryNoLongerHolds: the interleaving where
// a whole revocation lands between the handshake and the connection joining the
// registries.
//
// Revocation is two steps — remove the device, then close its connections — and
// a handshake that authenticated against the registry a moment before the first
// step can arrive here after the second. The revoke walked an empty bucket and
// returned; nothing is left that will ever look at this connection again. Every
// step is written out below in the order it would have happened, so the state
// ServeConn is entered in is exactly the state the race produces, with nothing
// timing-dependent about reaching it. What must not happen is what happened
// before this check existed: a revoked credential joining both registries and
// being served a shell indefinitely.
func TestServeConnRefusesADeviceTheRegistryNoLongerHolds(t *testing.T) {
	store := crypto.NewDeviceStore(t.TempDir())
	dev, err := store.Add("phone", bytes.Repeat([]byte{0x2a}, 32))
	if err != nil {
		t.Fatalf("Add: %v", err)
	}
	srv := New(session.NewRegistry(time.Now), local.NewAuth("tok", 0), nil, "test",
		Identity{Devices: store})
	buf := &syncBuffer{}
	srv.SetLogger(slog.New(slog.NewTextHandler(buf, nil)))

	// The revoke, both halves, while the connection is still in its handshake.
	if _, ok, err := srv.removeDevice(dev.ID); err != nil || !ok {
		t.Fatalf("removeDevice = %v, %v", ok, err)
	}
	// Zero is the premise of the test rather than an incidental: the revoke
	// found nothing to close, so it is done, and this connection is past
	// everything that would have ended it.
	if n := srv.disconnectDevice(dev.ID, "revoked"); n != 0 {
		t.Fatalf("the revoke closed %d connections, want 0 — the race is not staged", n)
	}

	p := newPipeConn()
	defer p.Close()
	done := make(chan struct{})
	go func() { srv.ServeConn(context.Background(), p, ConnMeta{Peer: "relay", DeviceID: dev.ID}); close(done) }()

	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("ServeConn served a device the registry no longer holds")
	}

	// Told why, in the same frame a revocation that had caught it would have
	// sent: from the client's side the two are the same event.
	switch m := expectControl(t, p).(type) {
	case wire.Revoked:
		if m.Reason != "revoked" {
			t.Fatalf("Revoked.Reason = %q, want %q", m.Reason, "revoked")
		}
	default:
		t.Fatalf("the refused connection was sent %#v, want a revoked", m)
	}

	select {
	case <-p.closed:
	default:
		t.Fatal("the refused connection left the transport open")
	}
	if len(srv.allConns()) != 0 {
		t.Fatal("the refused connection is still registered")
	}
	srv.connMu.Lock()
	defer srv.connMu.Unlock()
	if len(srv.deviceConns) != 0 {
		t.Fatalf("the revoked device's bucket was re-created: %+v", srv.deviceConns)
	}
	// A device that is simply gone is not a bookkeeping failure, and must not
	// be logged as one: that line means "the registry is broken", which this is
	// not, and an operator would have to rule it out on every revocation.
	if strings.Contains(buf.String(), "could not record") {
		t.Fatalf("a revoked device was logged as a stamp failure:\n%s", buf.String())
	}
	if !strings.Contains(buf.String(), "no longer paired") {
		t.Fatalf("the refusal was not logged:\n%s", buf.String())
	}
}

// TestServeConnServesADeviceTheRegistryCannotStamp: the stamp is bookkeeping,
// and bookkeeping does not get to refuse a connection the transport has already
// authenticated. A registry that cannot be read or written is the operator's
// problem, and goes to the log.
func TestServeConnServesADeviceTheRegistryCannotStamp(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "not-a-directory")
	if err := os.WriteFile(dir, []byte("not a directory"), 0o600); err != nil {
		t.Fatal(err)
	}
	srv := New(session.NewRegistry(time.Now), local.NewAuth("tok", 0), nil, "test",
		Identity{Devices: crypto.NewDeviceStore(dir)})
	buf := &syncBuffer{}
	srv.SetLogger(slog.New(slog.NewTextHandler(buf, nil)))

	p := newPipeConn()
	defer p.Close()
	go srv.ServeConn(context.Background(), p, ConnMeta{Peer: "relay", DeviceID: "abcdefabcdef"})
	if _, ok := expectControl(t, p).(wire.Welcome); !ok {
		t.Fatal("a device whose last-seen could not be written was not served")
	}
	waitForLog(t, buf, "could not record")
}

func TestServeConnRegistersTheDevice(t *testing.T) {
	srv := New(session.NewRegistry(time.Now), local.NewAuth("tok", 0), nil, "test", Identity{})
	p := newPipeConn()
	defer p.Close() // ServeConn is parked in Read until the conn ends.
	go srv.ServeConn(context.Background(), p, ConnMeta{Peer: "relay", DeviceID: "abcdefabcdef"})
	expectControl(t, p) // welcome — the conn is up and registered

	srv.connMu.Lock()
	n := len(srv.deviceConns["abcdefabcdef"])
	srv.connMu.Unlock()
	if n != 1 {
		t.Fatalf("device bucket holds %d conns, want 1", n)
	}
}
