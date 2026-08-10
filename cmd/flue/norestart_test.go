package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/karnstack/flue/internal/config"
	"github.com/karnstack/flue/internal/crypto"
	"github.com/karnstack/flue/internal/daemon"
	"github.com/karnstack/flue/internal/fleet"
	"github.com/karnstack/flue/internal/session"
	"github.com/karnstack/flue/internal/transport/local"
	"github.com/karnstack/flue/internal/wire"
)

// This file holds one test, and it is the one that would have caught the bug.
//
// The shape of that bug: a daemon that was already running when its fleet was
// created stayed on the relay and silently stopped being able to sign for it.
// Every piece of it was covered — the ceremony mints a cert, the URL carries
// `f=`, the relay leg re-reads relay.json — and the seam between the pieces was
// not, because every test built its daemon *after* the file it would read.
// Real machines are the other way round: the daemon starts at login and the
// relay is set up in a terminal an hour later.
//
// So this one runs in that order, across the same two processes the user has:
// a daemon serving, and the CLI writing relay.json beside it.

// pairPipe is a MessageConn over two channels — the smallest thing a daemon
// will serve. The relay transport hands it a socket; a test hands it this.
type pairPipe struct {
	in     chan []byte
	out    chan []byte
	closed chan struct{}
	once   sync.Once
}

func newPairPipe() *pairPipe {
	return &pairPipe{in: make(chan []byte, 8), out: make(chan []byte, 32), closed: make(chan struct{})}
}

func (p *pairPipe) Read(ctx context.Context) (bool, []byte, error) {
	select {
	case m := <-p.in:
		return true, m, nil
	case <-p.closed:
		return false, nil, io.EOF
	case <-ctx.Done():
		return false, nil, ctx.Err()
	}
}

func (p *pairPipe) Write(ctx context.Context, text bool, data []byte) error {
	if !text {
		return nil
	}
	select {
	case p.out <- append([]byte(nil), data...):
		return nil
	case <-p.closed:
		return errors.New("closed")
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (p *pairPipe) Close() error { p.once.Do(func() { close(p.closed) }); return nil }

// openPairingWindow does what the Devices screen does: connect, say hello, ask
// to pair, and read the link the daemon answers with.
func openPairingWindow(t *testing.T, srv *daemon.Server) wire.Pairing {
	t.Helper()
	p := newPairPipe()
	go srv.ServeConn(context.Background(), p, daemon.ConnMeta{Peer: "test", Origin: "http://127.0.0.1:7717"})
	t.Cleanup(func() { _ = p.Close() })

	hello, err := wire.EncodeControl(wire.Hello{Ver: "test"})
	if err != nil {
		t.Fatalf("EncodeControl: %v", err)
	}
	p.in <- hello
	start, err := wire.EncodeControl(wire.PairStart{})
	if err != nil {
		t.Fatalf("EncodeControl: %v", err)
	}
	p.in <- start

	deadline := time.After(3 * time.Second)
	for {
		select {
		case raw := <-p.out:
			msg, err := wire.DecodeControl(raw)
			if err != nil {
				t.Fatalf("undecodable control frame: %v", err)
			}
			if pairing, ok := msg.(wire.Pairing); ok {
				return pairing
			}
		case <-deadline:
			t.Fatal("the daemon never answered pairStart")
		}
	}
}

// TestASetupInOneTerminalPairsInTheNextBreath is the whole defect, end to end.
//
// A daemon comes up on a machine with no relay. `flue relay join` then runs in
// another process — the terminal, the way a second machine is added — and the
// user pairs a phone immediately afterwards, restarting nothing. What the
// phone gets has to be a real fleet membership: a link carrying the fleet
// public key it pins, and a certificate minted under that key naming the
// machine it paired with.
//
// Before the fix this failed twice over: the link came back without `&f=`
// (fleetPubParam read a fleet key captured at construction, which was empty),
// and the ceremony minted no certificate (same key, plus a machine id that
// belonged to a relay leg this process never started). Both records are written
// once and never revisited, so that phone was permanently a one-machine phone —
// and nothing anywhere said so.
func TestASetupInOneTerminalPairsInTheNextBreath(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())

	token, err := config.LoadOrCreateToken()
	if err != nil {
		t.Fatalf("LoadOrCreateToken: %v", err)
	}

	// --- the daemon, started before any relay exists -------------------------
	//
	// Exactly what cmdServe builds, in the same order: the identity first, then
	// the server, then the relay bookkeeping and the service the /api/relay
	// endpoints run through.
	identity, err := loadIdentity(slog.New(slog.DiscardHandler))
	if err != nil {
		t.Fatalf("loadIdentity: %v", err)
	}
	srv := daemon.New(session.NewRegistry(time.Now), local.NewAuth(token, 0), uiHandler(), version, identity)
	t.Cleanup(srv.Shutdown)
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)
	u, err := url.Parse(ts.URL)
	if err != nil {
		t.Fatalf("parse %q: %v", ts.URL, err)
	}
	port, err := strconv.Atoi(u.Port())
	if err != nil {
		t.Fatalf("port of %q: %v", ts.URL, err)
	}
	srv.SetAuth(local.NewAuth(token, port))

	// The relay leg, stubbed at the one place a test cannot follow: dialling.
	// It does what startRelay does with the file — reads it, tells the daemon
	// which machine it is and where it is reachable — and reports the socket as
	// up without opening one. startRelay's own wiring is covered by
	// TestStartRelayDialsAConfiguredRelay; what this test is about is whether
	// anything at all happens when another process writes that file.
	legs := 0
	rt := &relayRuntime{start: func() (bool, func()) {
		cfg, ok, err := config.LoadRelay()
		if err != nil || !ok {
			return false, nil
		}
		legs++
		srv.SetRelayMachine(cfg.MachineID, cfg.MachineName)
		srv.SetRelayOrigin(cfg.Origin)
		srv.SetRelayStatus(daemon.RelayConnected, cfg.Origin)
		return true, func() { srv.SetRelayStatus(daemon.RelayOff, "") }
	}}
	srv.SetRelayUI(&relayUIService{runtime: rt})
	// How the CLI in the other process finds this daemon at all.
	if err := daemon.WriteRuntime(port); err != nil {
		t.Fatalf("WriteRuntime: %v", err)
	}

	// --- before: a machine on no relay pairs as it always did ----------------
	if got := openPairingWindow(t, srv); strings.Contains(got.URL, "&f=") {
		t.Fatalf("a daemon with no fleet key offered a fleet key: %s", got.URL)
	}

	// --- the other terminal ---------------------------------------------------
	var out strings.Builder
	if err := runRelayJoin(&out, []string{
		"wss://relay.example.com",
		"--secret", "s3cr3t-daemon-secret",
		"--fleet", testFleetSeed,
		"--name", "Karn's MacBook Pro",
	}); err != nil {
		t.Fatalf("runRelayJoin: %v", err)
	}
	if legs != 1 {
		t.Fatalf("relay legs started = %d; the running daemon never picked up the join", legs)
	}
	if strings.Contains(out.String(), "flue disable && flue enable") {
		t.Errorf("join told the user to restart a daemon it had just reconfigured:\n%s", out.String())
	}

	cfg, ok, err := config.LoadRelay()
	if err != nil || !ok {
		t.Fatalf("LoadRelay after the join: ok=%v err=%v", ok, err)
	}
	want, err := fleet.Parse(testFleetSeed)
	if err != nil {
		t.Fatalf("fleet.Parse: %v", err)
	}

	// --- after: no restart, and a phone that joins the fleet -----------------
	pairing := openPairingWindow(t, srv)
	// The literal spelling, because that is what a phone's camera reads and
	// what conn.go splices in by hand: a `f=` that arrived as `?f=`, or with
	// the parameter dropped, is a browser that pins nothing.
	if !strings.Contains(pairing.URL, "&f=") {
		t.Fatalf("the pairing link carries no &f= after the join, so this browser would pin no fleet key and could never be given one: %s", pairing.URL)
	}
	link, err := url.Parse(pairing.URL)
	if err != nil {
		t.Fatalf("pairing url %q does not parse: %v", pairing.URL, err)
	}
	raw, err := base64.RawURLEncoding.DecodeString(link.Query().Get("f"))
	if err != nil {
		t.Fatalf("f = %q is not unpadded URL-safe base64: %v", link.Query().Get("f"), err)
	}
	if !bytes.Equal(raw, want.Public()) {
		t.Errorf("f decodes to %x, want the fleet key the join line carried %x", raw, want.Public())
	}
	// And the QR names the relay, not loopback: the leg the join started is
	// what a phone would open.
	if !strings.HasPrefix(pairing.URL, cfg.Origin) {
		t.Errorf("the pairing link names %s, want the relay origin %s", pairing.URL, cfg.Origin)
	}

	// The ceremony itself, as the pairing page performs it.
	devKey := make([]byte, 32)
	for i := range devKey {
		devKey[i] = 0x2a
	}
	body, err := json.Marshal(map[string]string{
		"token":     pairing.Token,
		"publicKey": base64.StdEncoding.EncodeToString(devKey),
		"label":     "phone",
	})
	if err != nil {
		t.Fatalf("marshal the pairing request: %v", err)
	}
	if out := srv.PairDevice(body, "test"); out.Status != http.StatusOK {
		t.Fatalf("PairDevice = %d (%s), want 200", out.Status, out.Body)
	}

	dir, err := config.Dir()
	if err != nil {
		t.Fatalf("config.Dir: %v", err)
	}
	dev, found, err := crypto.NewDeviceStore(dir).FindByKey(devKey)
	if err != nil || !found {
		t.Fatalf("FindByKey after pairing = %v, %v", found, err)
	}
	cert, err := fleet.VerifyDevice(want.Public(), dev.Cert)
	if err != nil {
		t.Fatalf("the ceremony minted no certificate under the fleet key this machine just joined: %v", err)
	}
	if cert.PairedOn != cfg.MachineID {
		t.Errorf("cert names pairedOn %q, want the machine id the join minted %q", cert.PairedOn, cfg.MachineID)
	}
	if !bytes.Equal(cert.Device, devKey) {
		t.Error("the ceremony minted a certificate for another device's key")
	}
}
