package relay

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/flynn/noise"
	"github.com/karnstack/flue/internal/crypto"
	"github.com/karnstack/flue/internal/daemon"
	"github.com/karnstack/flue/internal/relaywire"
	"github.com/karnstack/flue/internal/session"
	"github.com/karnstack/flue/internal/transport/local"
	"github.com/karnstack/flue/internal/wire"
)

// testOrigin is the origin the fake relay announces and the adapter is
// configured with. A channel that announces anything else is a relay lying
// about who it is, and every test that uses a different string is testing that.
const testOrigin = "https://relay.example"

// localToken is the session token the daemon's own loopback transport admits,
// for the one test that drives a local client and a relayed one at once.
const localToken = "0123456789abcdef"

// --- fixtures ---

// identity is a daemon's static key, its paired-device registry, and one
// device already in it: the state a browser can actually attach against.
type identity struct {
	key       noise.DHKey
	devices   *crypto.DeviceStore
	device    crypto.Device
	deviceKey noise.DHKey
}

func newIdentity(t *testing.T) *identity {
	t.Helper()
	dir := t.TempDir()
	key, err := crypto.LoadOrCreateStaticKey(dir)
	if err != nil {
		t.Fatalf("LoadOrCreateStaticKey: %v", err)
	}
	devKey, err := crypto.Suite().GenerateKeypair(nil)
	if err != nil {
		t.Fatalf("GenerateKeypair: %v", err)
	}
	store := crypto.NewDeviceStore(dir)
	dev, err := store.Add("phone", devKey.Public)
	if err != nil {
		t.Fatalf("Add: %v", err)
	}
	// Backdated, so "the daemon stamped last-seen" is an assertion about the
	// daemon's write rather than about two calls to time.Now landing in
	// different nanoseconds.
	if ok, err := store.UpdateLastSeen(dev.ID, time.Now().Add(-time.Hour)); err != nil || !ok {
		t.Fatalf("backdating the device: %v, %v", ok, err)
	}
	return &identity{key: key, devices: store, device: dev, deviceKey: devKey}
}

// unpairedKey is a browser key this daemon has never seen.
func unpairedKey(t *testing.T) noise.DHKey {
	t.Helper()
	k, err := crypto.Suite().GenerateKeypair(nil)
	if err != nil {
		t.Fatalf("GenerateKeypair: %v", err)
	}
	return k
}

// newChannelTransport builds an adapter with a real identity in front of srv.
func newChannelTransport(t *testing.T, r *fakeRelay, srv Server, id *identity, log *slog.Logger) *Transport {
	t.Helper()
	if log == nil {
		log = slog.New(slog.DiscardHandler)
	}
	tr, err := New(Config{URL: r.URL(), Secret: "s", Origin: testOrigin, MachineID: testMachineID}, srv, id.key, id.devices, log)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	return tr
}

// newDaemonServer is the real thing: the daemon this relay leg serves for,
// with its own loopback origin up as well — pairing is started and devices are
// revoked from a client on that origin, which is the ceremony as the user
// performs it.
func newDaemonServer(t *testing.T, id *identity) (*daemon.Server, *httptest.Server) {
	t.Helper()
	srv := daemon.New(session.NewRegistry(time.Now), nil, nil, "test",
		daemon.Identity{Key: id.key, Devices: id.devices})
	t.Cleanup(srv.Shutdown)
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)
	srv.SetAuth(local.NewAuth(localToken, portOf(t, ts)))
	return srv, ts
}

// readingServer is a Server that reads each connection until it ends, so a
// test can watch what the channel layer handed it and when it went away.
//
// block, when non-nil, is what ServeConn waits on instead of reading: a
// connection nobody drains, which is how the inbox is made to overflow.
type readingServer struct {
	block chan struct{}

	mu     sync.Mutex
	metas  []daemon.ConnMeta
	ended  int
	pairs  []pairCall
	answer func(body []byte, peer string) daemon.PairOutcome
}

type pairCall struct {
	body []byte
	peer string
}

func (s *readingServer) ServeConn(ctx context.Context, mc daemon.MessageConn, meta daemon.ConnMeta) {
	s.mu.Lock()
	s.metas = append(s.metas, meta)
	s.mu.Unlock()
	defer func() {
		_ = mc.Close()
		s.mu.Lock()
		s.ended++
		s.mu.Unlock()
	}()

	if s.block != nil {
		<-s.block
		return
	}
	for {
		if _, _, err := mc.Read(ctx); err != nil {
			return
		}
	}
}

func (s *readingServer) PairDevice(body []byte, peer string) daemon.PairOutcome {
	s.mu.Lock()
	s.pairs = append(s.pairs, pairCall{body: body, peer: peer})
	answer := s.answer
	s.mu.Unlock()
	if answer != nil {
		return answer(body, peer)
	}
	return daemon.PairRefusal()
}

// SetRelayStatus is nothing to these tests: they drive the channel layer
// directly rather than through a dial, so no status transition ever happens.
func (s *readingServer) SetRelayStatus(string, string) {}

func (s *readingServer) served() []daemon.ConnMeta {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]daemon.ConnMeta(nil), s.metas...)
}

// waitServed blocks until n connections have been handed over.
func (s *readingServer) waitServed(t *testing.T, n int) {
	t.Helper()
	deadline := time.Now().Add(waitFor)
	for {
		if len(s.served()) >= n {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("%d connections were served within %s, want %d", len(s.served()), waitFor, n)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func (s *readingServer) finished() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.ended
}

func (s *readingServer) pairings() []pairCall {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]pairCall(nil), s.pairs...)
}

// waitFinished blocks until n connections have ended.
func (s *readingServer) waitFinished(t *testing.T, n int) {
	t.Helper()
	deadline := time.Now().Add(waitFor)
	for {
		if s.finished() >= n {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("%d connections ended within %s, want %d", s.finished(), waitFor, n)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// --- the browser ---

// browser is the web client's relay leg, in the test: one channel's Noise
// session driven over the fake relay's daemon socket. It is a real
// crypto.InitiatorHandshake against the daemon's real static key, so what it
// proves is the handshake, not this package's idea of one.
type browser struct {
	t  *testing.T
	c  *relayConn
	id uint32
	ch *crypto.Channel
}

// attach announces a channel the way the Worker does and completes the
// handshake the browser drives.
func attach(t *testing.T, c *relayConn, chanID uint32, key noise.DHKey, daemonPub []byte) *browser {
	t.Helper()
	c.sendControl(t, relaywire.Open{Channel: chanID, Origin: testOrigin})
	return handshake(t, c, chanID, key, daemonPub)
}

// handshake drives the IK handshake on an already-announced channel.
func handshake(t *testing.T, c *relayConn, chanID uint32, key noise.DHKey, daemonPub []byte) *browser {
	t.Helper()
	b := &browser{t: t, c: c, id: chanID}
	ch, err := crypto.InitiatorHandshake(key, daemonPub, nil, b.recvRaw, b.sendRaw)
	if err != nil {
		t.Fatalf("the browser could not complete the handshake on channel %d: %v", chanID, err)
	}
	b.ch = ch
	return b
}

func (b *browser) sendRaw(msg []byte) error {
	b.c.send(b.t, b.id, msg)
	return nil
}

func (b *browser) recvRaw() ([]byte, error) {
	f := b.c.expectFrame(b.t)
	if f.Channel != b.id {
		return nil, fmt.Errorf("the daemon answered on channel %d, want %d (%q)", f.Channel, b.id, f.Payload)
	}
	return f.Payload, nil
}

// sendControl seals one wire-protocol control message onto the channel.
func (b *browser) sendControl(msg any) {
	b.t.Helper()
	raw, err := wire.EncodeControl(msg)
	if err != nil {
		b.t.Fatalf("EncodeControl: %v", err)
	}
	sealed, err := b.ch.Seal(relaywire.EncodePlain(true, raw))
	if err != nil {
		b.t.Fatalf("Seal: %v", err)
	}
	b.c.send(b.t, b.id, sealed)
}

// recvControl opens the daemon's next frame on this channel and decodes it.
func (b *browser) recvControl() any {
	b.t.Helper()
	payload, err := b.recvRaw()
	if err != nil {
		b.t.Fatal(err)
	}
	plain, err := b.ch.Open(payload)
	if err != nil {
		b.t.Fatalf("the daemon's frame did not open: %v", err)
	}
	text, data, err := relaywire.DecodePlain(plain)
	if err != nil {
		b.t.Fatalf("DecodePlain: %v", err)
	}
	if !text {
		b.t.Fatalf("expected a control frame, got %d binary bytes", len(data))
	}
	msg, err := wire.DecodeControl(data)
	if err != nil {
		b.t.Fatalf("DecodeControl: %v", err)
	}
	return msg
}

// --- assertions on the control channel ---

// expectClose waits for the daemon to ask the relay to close a channel.
func expectClose(t *testing.T, c *relayConn, want uint32) {
	t.Helper()
	msg := expectControlMsg(t, c)
	got, ok := msg.(*relaywire.Close)
	if !ok {
		t.Fatalf("the daemon sent %T, want a close for channel %d", msg, want)
	}
	if got.Channel != want {
		t.Fatalf("close named channel %d, want %d", got.Channel, want)
	}
}

// expectControlMsg returns the daemon's next channel-0 message.
func expectControlMsg(t *testing.T, c *relayConn) any {
	t.Helper()
	f := c.expectFrame(t)
	if f.Channel != relaywire.ControlChannel {
		t.Fatalf("expected a control message, got a frame on channel %d (%d bytes)", f.Channel, len(f.Payload))
	}
	msg, err := relaywire.DecodeControl(f.Payload)
	if err != nil {
		t.Fatalf("undecodable control message: %v", err)
	}
	return msg
}

// waitForLog blocks until every want has appeared in the log.
func waitForLog(t *testing.T, sink *syncBuffer, wants ...string) {
	t.Helper()
	deadline := time.Now().Add(waitFor)
	for {
		out := sink.String()
		missing := ""
		for _, w := range wants {
			if !strings.Contains(out, w) {
				missing = w
				break
			}
		}
		if missing == "" {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("nothing logged containing %q within %s; log:\n%s", missing, waitFor, out)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// --- the channel layer ---

// TestRelayChannelServesAPairedDevice is the whole path in one test: a browser
// attaches through the relay, completes the Noise handshake against the
// daemon's real static key, and gets the same wire protocol it would get on
// loopback — the daemon speaking Welcome first, and answering a list.
//
// The device is a paired one, so the daemon also stamps its last-seen: a
// connection is the only event that moves that column, and the relay is the
// only transport that carries a device.
func TestRelayChannelServesAPairedDevice(t *testing.T) {
	t.Parallel()
	r := newFakeRelay(t, "s")
	id := newIdentity(t)
	srv, _ := newDaemonServer(t, id)
	tr := newChannelTransport(t, r, srv, id, nil)
	runTransport(t, tr)

	c := r.accept(t)
	b := attach(t, c, 1, id.deviceKey, id.key.Public)

	if w, ok := b.recvControl().(wire.Welcome); !ok {
		t.Fatalf("the daemon's first frame was %#v, want a welcome", w)
	}
	b.sendControl(wire.List{})
	if s, ok := b.recvControl().(wire.Sessions); !ok {
		t.Fatalf("list was answered with %#v, want sessions", s)
	}

	list, err := id.devices.List()
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(list) != 1 {
		t.Fatalf("registry = %+v, want the one paired device", list)
	}
	if !list[0].LastSeen.After(list[0].PairedAt) {
		t.Errorf("LastSeen = %v, want something later than the pairing at %v — the relay did not stamp it",
			list[0].LastSeen, list[0].PairedAt)
	}
}

// TestRelayChannelCarriesTheDeviceIdentity: everything the daemon knows about a
// relayed client comes from ConnMeta, because the handshake that proved it is
// over by the time the connection is served. The device id is what revocation
// finds, the origin is what a pairing URL is built from, and the peer is what
// the audit log names.
func TestRelayChannelCarriesTheDeviceIdentity(t *testing.T) {
	t.Parallel()
	r := newFakeRelay(t, "s")
	id := newIdentity(t)
	srv := &readingServer{}
	tr := newChannelTransport(t, r, srv, id, nil)
	runTransport(t, tr)

	c := r.accept(t)
	attach(t, c, 1, id.deviceKey, id.key.Public)

	deadline := time.Now().Add(waitFor)
	for len(srv.served()) == 0 {
		if time.Now().After(deadline) {
			t.Fatalf("the channel layer did not serve the connection within %s", waitFor)
		}
		time.Sleep(5 * time.Millisecond)
	}
	got := srv.served()[0]
	want := daemon.ConnMeta{Peer: "relay:" + id.device.ID, Origin: testOrigin, DeviceID: id.device.ID}
	if got != want {
		t.Errorf("ConnMeta = %+v, want %+v", got, want)
	}
}

// TestRelayChannelRefusesAnUnknownDeviceKey: pairing first is what makes a
// browser known, and a browser that has not paired is not attached. The
// handshake itself completes — IK gives the daemon the initiator's static key
// only once it has — and the channel is closed immediately after.
func TestRelayChannelRefusesAnUnknownDeviceKey(t *testing.T) {
	t.Parallel()
	r := newFakeRelay(t, "s")
	id := newIdentity(t)
	srv := &readingServer{}
	sink := &syncBuffer{}
	tr := newChannelTransport(t, r, srv, id, slog.New(slog.NewTextHandler(sink, nil)))
	runTransport(t, tr)

	c := r.accept(t)
	stranger := unpairedKey(t)
	attach(t, c, 1, stranger, id.key.Public)

	expectClose(t, c, 1)
	waitForLog(t, sink, "unpaired device", crypto.DeviceID(stranger.Public))
	if n := len(srv.served()); n != 0 {
		t.Fatalf("the daemon served %d connections for an unpaired key, want 0", n)
	}
	if !c.stillOpen() {
		t.Fatal("refusing one channel took the whole socket down")
	}
}

// TestRelayChannelRefusesAForeignOrigin: the origin on an open is announced
// rather than assumed precisely so it can be checked. A relay announcing an
// origin this daemon did not dial is misconfigured or lying, and either way the
// channel is closed before a handshake is ever run against it.
func TestRelayChannelRefusesAForeignOrigin(t *testing.T) {
	t.Parallel()
	r := newFakeRelay(t, "s")
	id := newIdentity(t)
	srv := &readingServer{}
	sink := &syncBuffer{}
	tr := newChannelTransport(t, r, srv, id, slog.New(slog.NewTextHandler(sink, nil)))
	runTransport(t, tr)

	c := r.accept(t)
	c.sendControl(t, relaywire.Open{Channel: 1, Origin: "https://not-the-relay.example"})

	expectClose(t, c, 1)
	waitForLog(t, sink, "https://not-the-relay.example")
	if n := len(srv.served()); n != 0 {
		t.Fatalf("the daemon served %d connections on a foreign origin, want 0", n)
	}
	// And the socket is still the way home: the next honest channel works.
	attach(t, c, 2, id.deviceKey, id.key.Public)
}

// TestRelayChannelHandshakeFailureClosesTheChannel: a browser that cannot
// complete the handshake — a wrong pinned key, a replayed message, nonsense —
// is closed rather than left holding a channel the daemon will never read.
func TestRelayChannelHandshakeFailureClosesTheChannel(t *testing.T) {
	t.Parallel()
	r := newFakeRelay(t, "s")
	id := newIdentity(t)
	tr := newChannelTransport(t, r, &readingServer{}, id, nil)
	runTransport(t, tr)

	c := r.accept(t)
	c.sendControl(t, relaywire.Open{Channel: 1, Origin: testOrigin})
	c.send(t, 1, []byte("not a noise handshake message"))

	expectClose(t, c, 1)
	if !c.stillOpen() {
		t.Fatal("a failed handshake took the whole socket down")
	}
}

// TestRelayChannelClosedEndsTheConnection: the browser went away, the relay
// says so, and the connection it was holding ends — a client that closed its
// tab must not leave a live connection behind on the daemon.
func TestRelayChannelClosedEndsTheConnection(t *testing.T) {
	t.Parallel()
	r := newFakeRelay(t, "s")
	id := newIdentity(t)
	srv := &readingServer{}
	tr := newChannelTransport(t, r, srv, id, nil)
	runTransport(t, tr)

	c := r.accept(t)
	attach(t, c, 1, id.deviceKey, id.key.Public)
	c.sendControl(t, relaywire.Closed{Channel: 1})

	srv.waitFinished(t, 1)
	if !c.stillOpen() {
		t.Fatal("one browser leaving took the whole socket down")
	}
}

// TestRelaySocketLossEndsEveryChannel: the Noise state that made a channel
// readable lived in this socket's lifetime, so a socket that dies takes every
// channel with it (spec/relay-protocol.md). Every relay client sees a clean
// disconnect and reconnects through its own retry path.
func TestRelaySocketLossEndsEveryChannel(t *testing.T) {
	t.Parallel()
	r := newFakeRelay(t, "s")
	id := newIdentity(t)
	srv := &readingServer{}
	tr := newChannelTransport(t, r, srv, id, nil)
	runTransport(t, tr)

	c := r.accept(t)
	attach(t, c, 1, id.deviceKey, id.key.Public)
	attach(t, c, 2, id.deviceKey, id.key.Public)

	c.kill()
	srv.waitFinished(t, 2)
	// And the adapter is back, ready for the browsers to reconnect.
	r.accept(t)
}

// TestRelayChannelBackpressureClosesOneChannelNotTheSocket is the rule that
// makes multiplexing safe: one browser's channel is a bounded queue, and a
// client that fills it is dropped rather than allowed to stall the socket every
// other browser on this machine is sharing.
func TestRelayChannelBackpressureClosesOneChannelNotTheSocket(t *testing.T) {
	t.Parallel()
	r := newFakeRelay(t, "s")
	id := newIdentity(t)
	// A server that never reads: the connection is served and then nothing
	// drains it, which is the only way the inbox can actually fill.
	srv := &readingServer{block: make(chan struct{})}
	t.Cleanup(func() { close(srv.block) })
	sink := &syncBuffer{}
	tr := newChannelTransport(t, r, srv, id, slog.New(slog.NewTextHandler(sink, nil)))
	runTransport(t, tr)

	c := r.accept(t)
	attach(t, c, 1, id.deviceKey, id.key.Public)
	srv.waitServed(t, 1)

	for range inboxDepth + 64 {
		c.send(t, 1, []byte("ciphertext nobody is reading"))
	}

	expectClose(t, c, 1)
	waitForLog(t, sink, "not reading")
	if !c.stillOpen() {
		t.Fatal("a stalled channel took the whole socket down")
	}
	// The socket still works: another browser attaches on it.
	attach(t, c, 2, id.deviceKey, id.key.Public)
}

// panickingServer stands in for any unhandled failure on the serve path.
// daemon.ServeConn propagates a panic to its caller by design; on loopback that
// caller is net/http, which recovers per connection.
type panickingServer struct{}

func (panickingServer) ServeConn(context.Context, daemon.MessageConn, daemon.ConnMeta) {
	panic("boom")
}

func (panickingServer) PairDevice([]byte, string) daemon.PairOutcome {
	return daemon.PairRefusal()
}

func (panickingServer) SetRelayStatus(string, string) {}

// TestRelayChannelSurvivesAPanicOnTheServePath: over the relay the caller is a
// goroutine of this package's own, and a panic escaping it would end a process
// that is also holding every local terminal session on this machine. One
// browser loses its channel; nobody loses their work.
func TestRelayChannelSurvivesAPanicOnTheServePath(t *testing.T) {
	t.Parallel()
	r := newFakeRelay(t, "s")
	id := newIdentity(t)
	sink := &syncBuffer{}
	tr := newChannelTransport(t, r, panickingServer{}, id, slog.New(slog.NewTextHandler(sink, nil)))
	runTransport(t, tr)

	c := r.accept(t)
	attach(t, c, 1, id.deviceKey, id.key.Public)

	expectClose(t, c, 1)
	waitForLog(t, sink, "panic while serving a relay channel")
	if !c.stillOpen() {
		t.Fatal("a panic on one channel took the socket down")
	}
	// The socket is still serving: another browser attaches on it.
	attach(t, c, 2, id.deviceKey, id.key.Public)
}

// TestRelayChannelsAreBounded: an open costs a goroutine and an inbox before
// anything has proved anything, and opens arrive on a socket whose other end
// this daemon does not run. The relay caps its own client leg well below this,
// so what the bound actually refuses is a relay announcing browsers that are
// not there.
func TestRelayChannelsAreBounded(t *testing.T) {
	t.Parallel()
	r := newFakeRelay(t, "s")
	id := newIdentity(t)
	sink := &syncBuffer{}
	tr := newChannelTransport(t, r, &readingServer{}, id, slog.New(slog.NewTextHandler(sink, nil)))
	runTransport(t, tr)

	c := r.accept(t)
	// Announced and left silent: every one of them parks on its handshake,
	// which is the state that costs the daemon something.
	for i := range maxChannels + 1 {
		c.sendControl(t, relaywire.Open{Channel: uint32(i + 1), Origin: testOrigin})
	}

	expectClose(t, c, maxChannels+1)
	waitForLog(t, sink, "more channels at once")
	if !c.stillOpen() {
		t.Fatal("refusing one channel took the whole socket down")
	}
}

// TestRelayRevocationReachesARelayedBrowser is why ConnMeta carries the device
// id at all. A device revoked from the user's laptop has to lose its relayed
// session, and the daemon has no other handle on it: the connection is one
// channel of a socket the browser never opened.
func TestRelayRevocationReachesARelayedBrowser(t *testing.T) {
	t.Parallel()
	r := newFakeRelay(t, "s")
	id := newIdentity(t)
	srv, ts := newDaemonServer(t, id)
	tr := newChannelTransport(t, r, srv, id, nil)
	runTransport(t, tr)

	c := r.accept(t)
	b := attach(t, c, 1, id.deviceKey, id.key.Public)
	if _, ok := b.recvControl().(wire.Welcome); !ok {
		t.Fatal("the relayed browser was not welcomed")
	}

	laptop := dialLocal(t, ts)
	writeLocalControl(t, laptop, wire.Hello{Ver: "test"})
	writeLocalControl(t, laptop, wire.Revoke{DeviceID: id.device.ID})

	// The revoked device is told why before it is cut off — the same frame a
	// local client would get — and then the relay is asked to close its socket.
	for {
		switch msg := b.recvControl().(type) {
		case wire.Revoked:
			expectClose(t, c, 1)
			return
		case wire.DeviceList, wire.Sessions:
			// Broadcasts this connection is entitled to; keep reading.
		default:
			t.Fatalf("the revoked browser was sent %#v, want a revoked", msg)
		}
	}
}

// dialLocal opens a loopback client the way a non-browser client has to: the
// session token in a request header.
func dialLocal(t *testing.T, ts *httptest.Server) *websocket.Conn {
	t.Helper()
	c, _, err := websocket.Dial(context.Background(),
		"ws"+strings.TrimPrefix(ts.URL, "http")+"/ws",
		&websocket.DialOptions{HTTPHeader: http.Header{local.HeaderName: {localToken}}})
	if err != nil {
		t.Fatalf("dialling the daemon's own origin: %v", err)
	}
	t.Cleanup(func() { c.Close(websocket.StatusNormalClosure, "") })
	return c
}

func writeLocalControl(t *testing.T, c *websocket.Conn, msg any) {
	t.Helper()
	b, err := wire.EncodeControl(msg)
	if err != nil {
		t.Fatalf("EncodeControl: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), waitFor)
	defer cancel()
	if err := c.Write(ctx, websocket.MessageText, b); err != nil {
		t.Fatalf("writing to the daemon: %v", err)
	}
}

func portOf(t *testing.T, ts *httptest.Server) int {
	t.Helper()
	_, port, ok := strings.Cut(strings.TrimPrefix(ts.URL, "http://"), ":")
	if !ok {
		t.Fatalf("no port in %s", ts.URL)
	}
	n := 0
	for _, c := range port {
		n = n*10 + int(c-'0')
	}
	return n
}

// --- pairing over the relay ---

// TestRelayPairingRegistersTheDevice: pairing is the one part of the ceremony
// that is an HTTP request rather than a WebSocket message, and the relay
// carries it verbatim. The answer is the same one the daemon's own origin
// would have written.
func TestRelayPairingRegistersTheDevice(t *testing.T) {
	t.Parallel()
	r := newFakeRelay(t, "s")
	id := newIdentity(t)
	srv, ts := newDaemonServer(t, id)
	tr := newChannelTransport(t, r, srv, id, nil)
	runTransport(t, tr)

	token := startPairing(t, ts)
	newKey := unpairedKey(t)
	c := r.accept(t)
	c.sendControl(t, relaywire.Pair{ID: 7, Origin: testOrigin, Body: pairingBody(t, token, newKey.Public)})

	res := expectPairResult(t, c, 7)
	if res.Status != http.StatusOK {
		t.Fatalf("pairResult status = %d (%s), want 200", res.Status, res.Body)
	}
	var body struct {
		DeviceID  string `json:"deviceId"`
		DaemonPub string `json:"daemonPub"`
	}
	if err := json.Unmarshal(res.Body, &body); err != nil {
		t.Fatalf("pairResult body %q is not JSON: %v", res.Body, err)
	}
	if want := crypto.DeviceID(newKey.Public); body.DeviceID != want {
		t.Errorf("deviceId = %q, want %q", body.DeviceID, want)
	}

	// And the device it registered can attach.
	attach(t, c, 1, newKey, id.key.Public)
}

// TestRelayPairingRefusalTravelsAsJSON: relaywire refuses a body that is not a
// JSON value, so a refusal that travelled as the bare text the local handler
// writes would be a frame the daemon could not send at all — and a browser left
// waiting for an answer that never came.
func TestRelayPairingRefusalTravelsAsJSON(t *testing.T) {
	t.Parallel()
	r := newFakeRelay(t, "s")
	id := newIdentity(t)
	srv, ts := newDaemonServer(t, id)
	tr := newChannelTransport(t, r, srv, id, nil)
	runTransport(t, tr)

	startPairing(t, ts)
	c := r.accept(t)
	c.sendControl(t, relaywire.Pair{
		ID:     11,
		Origin: testOrigin,
		Body:   pairingBody(t, "Zm91cnRlZW4tY2hhcnM", unpairedKey(t).Public),
	})

	res := expectPairResult(t, c, 11)
	if res.Status != http.StatusForbidden {
		t.Fatalf("pairResult status = %d, want 403", res.Status)
	}
	if got, want := string(res.Body), `{"error":"pairing refused"}`; got != want {
		t.Errorf("refusal body = %q, want %q", got, want)
	}
}

// TestRelayPairingRefusesAForeignOrigin: a relay that lies about its origin
// must not be able to spend the user's pairing window. The request is answered
// — a Worker holding a parked HTTP request would otherwise wait out its own
// deadline — and the ceremony is never run, so the live token still works.
func TestRelayPairingRefusesAForeignOrigin(t *testing.T) {
	t.Parallel()
	r := newFakeRelay(t, "s")
	id := newIdentity(t)
	srv := &readingServer{}
	sink := &syncBuffer{}
	tr := newChannelTransport(t, r, srv, id, slog.New(slog.NewTextHandler(sink, nil)))
	runTransport(t, tr)

	c := r.accept(t)
	c.sendControl(t, relaywire.Pair{
		ID:     3,
		Origin: "https://not-the-relay.example",
		Body:   pairingBody(t, "a-live-token", unpairedKey(t).Public),
	})

	res := expectPairResult(t, c, 3)
	if res.Status != http.StatusForbidden {
		t.Fatalf("pairResult status = %d, want 403", res.Status)
	}
	if got, want := string(res.Body), `{"error":"pairing refused"}`; got != want {
		t.Errorf("refusal body = %q, want %q", got, want)
	}
	if n := len(srv.pairings()); n != 0 {
		t.Fatalf("the daemon ran the ceremony %d times for a foreign origin, want 0 — the window must not be spent", n)
	}
	waitForLog(t, sink, "https://not-the-relay.example")
}

// TestRelayPairingRunsOffTheReadLoop: the ceremony touches the device registry
// on disk, so running it inline would stall every other channel on this socket
// for the duration of a file write.
func TestRelayPairingRunsOffTheReadLoop(t *testing.T) {
	t.Parallel()
	r := newFakeRelay(t, "s")
	id := newIdentity(t)
	release := make(chan struct{})
	srv := &readingServer{answer: func([]byte, string) daemon.PairOutcome {
		<-release
		return daemon.PairRefusal()
	}}
	t.Cleanup(func() { close(release) })
	tr := newChannelTransport(t, r, srv, id, nil)
	runTransport(t, tr)

	c := r.accept(t)
	c.sendControl(t, relaywire.Pair{ID: 1, Origin: testOrigin, Body: pairingBody(t, "t", unpairedKey(t).Public)})

	// The pairing is parked in the daemon, and the socket carries on: a channel
	// opened behind it is served.
	attach(t, c, 1, id.deviceKey, id.key.Public)
}

// startPairing opens a window the way the user's other screen does — a
// pairStart from an already-trusted client on the daemon's own origin — and
// returns the token it handed out.
func startPairing(t *testing.T, ts *httptest.Server) string {
	t.Helper()
	c := dialLocal(t, ts)
	writeLocalControl(t, c, wire.Hello{Ver: "test"})
	writeLocalControl(t, c, wire.PairStart{})

	ctx, cancel := context.WithTimeout(context.Background(), waitFor)
	defer cancel()
	for {
		typ, data, err := c.Read(ctx)
		if err != nil {
			t.Fatalf("reading the pairing token: %v", err)
		}
		if typ != websocket.MessageText {
			continue
		}
		msg, err := wire.DecodeControl(data)
		if err != nil {
			t.Fatalf("DecodeControl: %v", err)
		}
		if p, ok := msg.(wire.Pairing); ok {
			if p.Token == "" {
				t.Fatal("the daemon opened a pairing window with no token")
			}
			return p.Token
		}
	}
}

func pairingBody(t *testing.T, token string, publicKey []byte) json.RawMessage {
	t.Helper()
	b, err := json.Marshal(map[string]string{
		"token":     token,
		"publicKey": base64.StdEncoding.EncodeToString(publicKey),
		"label":     "relayed phone",
	})
	if err != nil {
		t.Fatalf("marshal pairing body: %v", err)
	}
	return b
}

func expectPairResult(t *testing.T, c *relayConn, id uint64) *relaywire.PairResult {
	t.Helper()
	msg := expectControlMsg(t, c)
	res, ok := msg.(*relaywire.PairResult)
	if !ok {
		t.Fatalf("the daemon sent %T, want a pairResult", msg)
	}
	if res.ID != id {
		t.Fatalf("pairResult id = %d, want %d", res.ID, id)
	}
	return res
}
