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

// TestServeConnServesADeviceTheRegistryDoesNotHold: an id with no entry behind
// it raced its own revocation. There is nothing to stamp and nothing to report —
// whoever removed the device is already closing this connection — so the
// absence must not be logged as a failure, or every revocation leaves a warning
// an operator has to rule out.
func TestServeConnServesADeviceTheRegistryDoesNotHold(t *testing.T) {
	srv := New(session.NewRegistry(time.Now), local.NewAuth("tok", 0), nil, "test",
		Identity{Devices: crypto.NewDeviceStore(t.TempDir())})
	buf := &syncBuffer{}
	srv.SetLogger(slog.New(slog.NewTextHandler(buf, nil)))

	p := newPipeConn()
	defer p.Close()
	go srv.ServeConn(context.Background(), p, ConnMeta{Peer: "relay", DeviceID: "abcdefabcdef"})
	if _, ok := expectControl(t, p).(wire.Welcome); !ok {
		t.Fatal("a device the registry does not hold was not served")
	}
	if strings.Contains(buf.String(), "could not record") {
		t.Fatalf("a device that was simply gone was logged as a failure:\n%s", buf.String())
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
