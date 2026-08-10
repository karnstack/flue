package daemon

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/karnstack/flue/internal/crypto"
	"github.com/karnstack/flue/internal/fleet"
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

// TestWelcomeCarriesTheDevicesFleetCert is the re-supply path, and the reason a
// device certificate no longer has to live in the relay's credential-less
// directory.
//
// The ceremony hands one over in its answer; every connection after that offers
// the same blob again, inside Noise, to a device that has just proved it holds
// the key the certificate names. A browser that never stored one, or lost it,
// or was paired before this machine had a fleet key, picks one up from any
// machine it can still reach — and without it, that browser can reach only the
// machines it paired with by hand.
func TestWelcomeCarriesTheDevicesFleetCert(t *testing.T) {
	dir := t.TempDir()
	key, err := crypto.LoadOrCreateStaticKey(dir)
	if err != nil {
		t.Fatalf("LoadOrCreateStaticKey: %v", err)
	}
	fk, err := fleet.Mint(rand.Reader)
	if err != nil {
		t.Fatalf("fleet.Mint: %v", err)
	}
	devices := crypto.NewDeviceStore(dir)
	srv := New(session.NewRegistry(time.Now), local.NewAuth("tok", 0), nil, "test",
		Identity{Key: key, Devices: devices, Fleet: StaticFleet(fk, "karns-mbp-a1b2-0f9a12cd")})
	t.Cleanup(srv.Shutdown)
	srv.SetRelayMachine("karns-mbp-a1b2-0f9a12cd", "Karn's MacBook Pro")

	// A device paired the ordinary way, so the registry holds the cert the
	// ceremony minted.
	token, _ := srv.pairing.start(time.Now())
	devPub := deviceKey(0x2a)
	out := srv.PairDevice(pairBody(t, token, base64.StdEncoding.EncodeToString(devPub), "phone"), "relay")
	if out.Status != http.StatusOK {
		t.Fatalf("PairDevice = %d (%s), want 200", out.Status, out.Body)
	}

	// A connection that authenticated as that device — which is what the relay
	// transport hands over after a handshake: the id for the log lines and the
	// key the handshake proved, which is what the certificate is looked up on.
	p := newPipeConn()
	go srv.ServeConn(context.Background(), p, ConnMeta{
		Peer: "relay", DeviceID: crypto.DeviceID(devPub), DeviceKey: devPub,
	})
	t.Cleanup(func() { _ = p.Close() })

	w, ok := expectControl(t, p).(wire.Welcome)
	if !ok {
		t.Fatal("first frame was not a welcome")
	}
	if len(w.FleetCert) == 0 {
		t.Fatal("the welcome carried no fleet cert; this device could reach no machine it had not paired with")
	}
	cert, err := fleet.VerifyDevice(fk.Public(), w.FleetCert)
	if err != nil {
		t.Fatalf("the welcome's cert does not verify under this fleet key: %v", err)
	}
	if !bytes.Equal(cert.Device, devPub) {
		t.Error("the welcome offered a certificate for another device's key")
	}

	// And a connection with no device identity — every loopback one — is
	// offered nothing: a certificate is a statement about a device key, and a
	// session-token connection has not named one.
	local := newPipeConn()
	go srv.ServeConn(context.Background(), local, ConnMeta{Peer: "test"})
	t.Cleanup(func() { _ = local.Close() })
	lw, ok := expectControl(t, local).(wire.Welcome)
	if !ok {
		t.Fatal("first frame on the loopback conn was not a welcome")
	}
	if len(lw.FleetCert) != 0 {
		t.Errorf("a loopback welcome carried a fleet cert: %x", lw.FleetCert)
	}

	// And the lookup is on the key, not on the id. The id is
	// hex(sha256(key))[:12] — 48 bits — and crypto.Add deliberately permits two
	// devices to hold colliding ones, so a welcome resolved by id would hand
	// the wrong device's certificate to whichever of them connected. Here the
	// id is the paired device's and the key is not, which is exactly what a
	// collision looks like from this function's side.
	other := newPipeConn()
	go srv.ServeConn(context.Background(), other, ConnMeta{
		Peer: "relay", DeviceID: crypto.DeviceID(devPub), DeviceKey: deviceKey(0x5b),
	})
	t.Cleanup(func() { _ = other.Close() })
	ow, ok := expectControl(t, other).(wire.Welcome)
	if !ok {
		t.Fatal("first frame on the colliding-id conn was not a welcome")
	}
	if len(ow.FleetCert) != 0 {
		t.Errorf("a welcome offered another device's certificate to a key it does not name: %x", ow.FleetCert)
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
	dev, err := store.Add("phone", bytes.Repeat([]byte{0x2a}, 32), nil)
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
	dev, err := store.Add("phone", bytes.Repeat([]byte{0x2a}, 32), nil)
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

// TestWelcomeBackFillsACertificateADevicePairedWithout is the repair path for
// everyone the restart trap already caught.
//
// A device paired while this machine held no fleet key has an entry with no
// certificate, and nothing used to fill it in: the ceremony writes the cert
// exactly once, and the other door into the registry (AddFromFleetCert) wants
// a certificate the device already holds. So that browser reached this machine
// and no other, permanently, and the re-supply path every welcome documents
// had nothing to supply.
//
// Now the machine mints one the first time that device connects after the
// fleet key arrives — which is also the first moment it could. No re-pairing,
// no restart, and the browser is on the fleet from that welcome onward.
func TestWelcomeBackFillsACertificateADevicePairedWithout(t *testing.T) {
	const machineID = "karns-mbp-a1b2-0f9a12cd"
	dir := t.TempDir()
	key, err := crypto.LoadOrCreateStaticKey(dir)
	if err != nil {
		t.Fatalf("LoadOrCreateStaticKey: %v", err)
	}
	devices := crypto.NewDeviceStore(dir)

	// What relay.json says, as the daemon reads it at the moment it signs:
	// nothing at all, to begin with.
	var live FleetIdentity
	srv := New(session.NewRegistry(time.Now), local.NewAuth("tok", 0), nil, "test",
		Identity{Key: key, Devices: devices, Fleet: func() FleetIdentity { return live }})
	t.Cleanup(srv.Shutdown)

	// The ceremony, on a machine with no fleet: a paired device and no cert.
	token, _ := srv.pairing.start(time.Now())
	devPub := deviceKey(0x2a)
	if out := srv.PairDevice(pairBody(t, token, base64.StdEncoding.EncodeToString(devPub), "phone"), "relay"); out.Status != http.StatusOK {
		t.Fatalf("PairDevice = %d (%s), want 200", out.Status, out.Body)
	}
	paired, ok, err := devices.FindByKey(devPub)
	if err != nil || !ok {
		t.Fatalf("FindByKey after pairing = %v, %v", ok, err)
	}
	if len(paired.Cert) != 0 {
		t.Fatal("a daemon with no fleet key minted a certificate it could not have signed")
	}

	// `flue relay setup`, later, from another process.
	fk, err := fleet.Mint(rand.Reader)
	if err != nil {
		t.Fatalf("fleet.Mint: %v", err)
	}
	live = FleetIdentity{Key: fk, MachineID: machineID}

	p := newPipeConn()
	go srv.ServeConn(context.Background(), p, ConnMeta{
		Peer: "relay", DeviceID: crypto.DeviceID(devPub), DeviceKey: devPub,
	})
	t.Cleanup(func() { _ = p.Close() })
	w, ok := expectControl(t, p).(wire.Welcome)
	if !ok {
		t.Fatal("first frame was not a welcome")
	}
	if len(w.FleetCert) == 0 {
		t.Fatal("the welcome carried no certificate, so a device paired before its machine had a fleet key stays stuck on that machine forever")
	}
	cert, err := fleet.VerifyDevice(fk.Public(), w.FleetCert)
	if err != nil {
		t.Fatalf("the back-filled cert does not verify under this fleet key: %v", err)
	}
	if !bytes.Equal(cert.Device, devPub) {
		t.Error("the back-filled cert names another device's key")
	}
	if cert.PairedOn != machineID {
		t.Errorf("cert names pairedOn %q, want this machine %q", cert.PairedOn, machineID)
	}
	// The ceremony's own time, not this moment: `iat` is when the device joined
	// the fleet, and it is what every other machine's Devices screen shows
	// (crypto.AddFromFleetCert takes pairedAt from here).
	if cert.IAT != paired.PairedAt.Unix() {
		t.Errorf("cert iat = %d, want the pairing's own time %d", cert.IAT, paired.PairedAt.Unix())
	}

	// Persisted, so this is one mint per device rather than one per
	// connection — and so the Devices screen and any later welcome agree.
	stored, ok, err := devices.FindByKey(devPub)
	if err != nil || !ok {
		t.Fatalf("FindByKey after the back-fill = %v, %v", ok, err)
	}
	if !bytes.Equal(stored.Cert, w.FleetCert) {
		t.Error("the registry did not keep the certificate the welcome handed over")
	}

	// A second connection offers the same bytes: a certificate is one artifact
	// for the life of a pairing, which is what lets a browser compare what it
	// holds against what it is offered.
	again := newPipeConn()
	go srv.ServeConn(context.Background(), again, ConnMeta{
		Peer: "relay", DeviceID: crypto.DeviceID(devPub), DeviceKey: devPub,
	})
	t.Cleanup(func() { _ = again.Close() })
	w2, ok := expectControl(t, again).(wire.Welcome)
	if !ok {
		t.Fatal("first frame on the second conn was not a welcome")
	}
	if !bytes.Equal(w2.FleetCert, w.FleetCert) {
		t.Error("the second welcome offered different bytes; a re-mint per connection is not a certificate")
	}
}

// TestWelcomeBackFillsNothingWithoutAPlaceOnTheRelay: a fleet key and no
// machine id mints nothing, here as at the ceremony. `pairedOn` is what a
// reader attributes a certificate to, and a cert naming the empty machine is
// one nothing can line up against the machine certs beside it.
func TestWelcomeBackFillsNothingWithoutAPlaceOnTheRelay(t *testing.T) {
	dir := t.TempDir()
	key, err := crypto.LoadOrCreateStaticKey(dir)
	if err != nil {
		t.Fatalf("LoadOrCreateStaticKey: %v", err)
	}
	fk, err := fleet.Mint(rand.Reader)
	if err != nil {
		t.Fatalf("fleet.Mint: %v", err)
	}
	devices := crypto.NewDeviceStore(dir)
	srv := New(session.NewRegistry(time.Now), local.NewAuth("tok", 0), nil, "test",
		Identity{Key: key, Devices: devices, Fleet: StaticFleet(fk, "")})
	t.Cleanup(srv.Shutdown)

	devPub := deviceKey(0x2a)
	if _, err := devices.Add("phone", devPub, nil); err != nil {
		t.Fatalf("Add: %v", err)
	}

	p := newPipeConn()
	go srv.ServeConn(context.Background(), p, ConnMeta{
		Peer: "relay", DeviceID: crypto.DeviceID(devPub), DeviceKey: devPub,
	})
	t.Cleanup(func() { _ = p.Close() })
	w, ok := expectControl(t, p).(wire.Welcome)
	if !ok {
		t.Fatal("first frame was not a welcome")
	}
	if len(w.FleetCert) != 0 {
		t.Errorf("a machine with no id on the relay minted a certificate naming nobody: %x", w.FleetCert)
	}
}

// TestWelcomeSaysWhenThisDaemonCannotSignForItsFleet: the backstop behind the
// Devices screen's second gate.
//
// A daemon on a relay that holds no fleet key can still draw a pairing QR, and
// a device that completes that ceremony pins no fleet key and is minted no
// certificate — it reaches this machine and nothing else, for the life of the
// pairing, silently. The welcome carries the fact so the screen can refuse
// instead, the way it refuses a QR that could only name loopback.
func TestWelcomeSaysWhenThisDaemonCannotSignForItsFleet(t *testing.T) {
	dir := t.TempDir()
	key, err := crypto.LoadOrCreateStaticKey(dir)
	if err != nil {
		t.Fatalf("LoadOrCreateStaticKey: %v", err)
	}
	fk, err := fleet.Mint(rand.Reader)
	if err != nil {
		t.Fatalf("fleet.Mint: %v", err)
	}
	var live FleetIdentity
	srv := New(session.NewRegistry(time.Now), local.NewAuth("tok", 0), nil, "test",
		Identity{Key: key, Devices: crypto.NewDeviceStore(dir), Fleet: func() FleetIdentity { return live }})
	t.Cleanup(srv.Shutdown)
	srv.SetRelayStatus(RelayConnected, "https://flue-relay.example")

	welcome := func() wire.Welcome {
		t.Helper()
		p := newPipeConn()
		go srv.ServeConn(context.Background(), p, ConnMeta{Peer: "test"})
		t.Cleanup(func() { _ = p.Close() })
		w, ok := expectControl(t, p).(wire.Welcome)
		if !ok {
			t.Fatal("first frame was not a welcome")
		}
		return w
	}

	w := welcome()
	if w.Relay == nil || !w.Relay.NoFleetKey {
		t.Fatalf("relay = %+v; a daemon on a relay with no fleet key must say so", w.Relay)
	}

	// A fleet key and no place on the relay is the same answer: `pairedOn` is
	// what makes a certificate attributable, and one naming the empty machine
	// is one no reader can line up against the machine certs beside it.
	live = FleetIdentity{Key: fk}
	if w := welcome(); w.Relay == nil || !w.Relay.NoFleetKey {
		t.Fatalf("relay = %+v; a daemon with no machine id mints no cert and must say so", w.Relay)
	}

	// And a machine that can sign says nothing at all — the field is the
	// fault, not the capability, so silence is what an older daemon says too.
	live = FleetIdentity{Key: fk, MachineID: "karns-mbp-a1b2-0f9a12cd"}
	if w := welcome(); w.Relay == nil || w.Relay.NoFleetKey {
		t.Fatalf("relay = %+v; a daemon that can sign must not report the fault", w.Relay)
	}
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
