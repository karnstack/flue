package daemon

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/karnstack/flue/internal/crypto"
	"github.com/karnstack/flue/internal/fleet"
	"github.com/karnstack/flue/internal/session"
	"github.com/karnstack/flue/internal/transport/local"
	"github.com/karnstack/flue/internal/wire"
)

// The loopback fleet surface: the directory this daemon fetches for its own
// UI, because the browser on 127.0.0.1 cannot fetch it for itself, and the
// enrolment that gives that same browser a fleet identity.

// getFleet is a GET from this daemon's own origin, authenticated the way the
// browser is: the session cookie, and same-origin fetch metadata.
func getFleet(t *testing.T, ts *httptest.Server, path string) *http.Response {
	t.Helper()
	req, err := http.NewRequest(http.MethodGet, ts.URL+path, nil)
	if err != nil {
		t.Fatal(err)
	}
	req.AddCookie(&http.Cookie{Name: tsCookie(ts), Value: tok})
	req.Header.Set("Sec-Fetch-Site", "same-origin")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("GET %s: %v", path, err)
	}
	t.Cleanup(func() { resp.Body.Close() })
	return resp
}

// TestFleetDirectoryIsNotThereWithoutARelayLeg: a daemon that is not reading a
// directory says so, rather than answering an empty one.
//
// The difference is the whole value of the endpoint to a browser. "No fleet
// here" lets the UI keep the machines it already knows about; "here is a fleet
// with nothing in it" would tell it, wrongly, that every sibling had gone.
func TestFleetDirectoryIsNotThereWithoutARelayLeg(t *testing.T) {
	ts, _ := newPairServer(t)
	resp := getFleet(t, ts, FleetDirectoryPath)
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("GET %s = %d on a daemon with no relay, want 404", FleetDirectoryPath, resp.StatusCode)
	}
}

// TestFleetDirectoryServesTheRelaysBytesUnchanged is the whole contract: what
// the relay said, byte for byte.
//
// Asserted on the bytes rather than on a decoded document, deliberately. The
// browser verifies every blob under the fleet public key it pinned, and it can
// only do that if the blob it verifies is the blob the fleet key signed — so a
// daemon that re-encoded this document, however faithfully, would be a daemon
// that could break every signature in it. Transport, not opinion.
func TestFleetDirectoryServesTheRelaysBytesUnchanged(t *testing.T) {
	ts, srv := newPairServer(t)
	// Deliberately not canonical JSON: odd spacing, a field this daemon has
	// never heard of, no trailing newline. All of it has to survive.
	const body = `{"v":1,  "entries":[{"key":"abc","blob":"AAEC"}],"somethingNew":true}`
	srv.SetDirectorySnapshot(func(context.Context) ([]byte, error) { return []byte(body), nil })

	resp := getFleet(t, ts, FleetDirectoryPath)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("GET %s = %d, want 200", FleetDirectoryPath, resp.StatusCode)
	}
	got, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("reading the answer: %v", err)
	}
	if string(got) != body {
		t.Errorf("body = %q, want the relay's bytes unchanged %q", got, body)
	}
	if ct := resp.Header.Get("Content-Type"); ct != "application/json" {
		t.Errorf("Content-Type = %q, want application/json", ct)
	}
	// The directory is how a browser learns of a revocation. A cached copy is
	// a revocation served late, which is the one staleness this design cannot
	// afford — the relay says no-store and so does this.
	if cc := resp.Header.Get("Cache-Control"); cc != "no-store" {
		t.Errorf("Cache-Control = %q, want no-store", cc)
	}
}

// TestFleetDirectoryReportsARelayItCouldNotRead: a leg that is installed and
// failing is a 502, not a 404 and not an empty document.
//
// The caller needs to tell "this machine has no fleet" from "this machine has
// a fleet it cannot reach right now", because only the second is worth
// retrying and only the first should change what the UI shows.
func TestFleetDirectoryReportsARelayItCouldNotRead(t *testing.T) {
	ts, srv := newPairServer(t)
	srv.SetDirectorySnapshot(func(context.Context) ([]byte, error) {
		return nil, errors.New("dial tcp 203.0.113.7:443: connection refused")
	})

	resp := getFleet(t, ts, FleetDirectoryPath)
	if resp.StatusCode != http.StatusBadGateway {
		t.Fatalf("GET %s = %d with an unreachable relay, want 502", FleetDirectoryPath, resp.StatusCode)
	}
	// The failure text names the relay's address and the transport error.
	// Neither is the caller's business, and one of them is an address.
	body, _ := io.ReadAll(resp.Body)
	if strings.Contains(string(body), "203.0.113.7") {
		t.Errorf("body = %q, want the transport error kept out of it", body)
	}
}

// TestFleetDirectoryIsBehindAuth: the endpoint is a read of the relay
// performed with this machine's credential, so it takes this daemon's.
//
// Not because the directory is secret — it is signed rather than secret, and
// `GET /directory` on the relay takes no credential at all — but because an
// unauthenticated route here would let a page on any other loopback port make
// this daemon dial its relay, and would map the API surface by status code for
// anyone who asked.
func TestFleetDirectoryIsBehindAuth(t *testing.T) {
	ts, srv := newPairServer(t)
	called := false
	srv.SetDirectorySnapshot(func(context.Context) ([]byte, error) {
		called = true
		return []byte(`{"v":1,"entries":[]}`), nil
	})

	// No cookie, no header.
	resp, err := http.Get(ts.URL + FleetDirectoryPath)
	if err != nil {
		t.Fatalf("GET %s: %v", FleetDirectoryPath, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("unauthenticated GET %s = %d, want 401", FleetDirectoryPath, resp.StatusCode)
	}
	if called {
		t.Error("the daemon read its relay for an unauthenticated caller")
	}

	// A page on another loopback port is same-site, not same-origin, and its
	// Origin is not one of this daemon's. Either check alone refuses it.
	req, err := http.NewRequest(http.MethodGet, ts.URL+FleetDirectoryPath, nil)
	if err != nil {
		t.Fatal(err)
	}
	req.AddCookie(&http.Cookie{Name: tsCookie(ts), Value: tok})
	req.Header.Set("Origin", "http://127.0.0.1:3000")
	req.Header.Set("Sec-Fetch-Site", "same-site")
	resp2, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("GET %s: %v", FleetDirectoryPath, err)
	}
	defer resp2.Body.Close()
	if resp2.StatusCode != http.StatusForbidden {
		t.Errorf("cross-origin GET %s = %d, want 403", FleetDirectoryPath, resp2.StatusCode)
	}
	if called {
		t.Error("the daemon read its relay for a cross-origin caller")
	}
}

// TestFleetDirectoryTakesNoPOST: it is a read, and this surface's rule is that
// every mutation is a POST and every POST is on methodPolicy's allowlist. This
// path is not on it and must not become postable by accident.
func TestFleetDirectoryTakesNoPOST(t *testing.T) {
	ts, srv := newPairServer(t)
	srv.SetDirectorySnapshot(func(context.Context) ([]byte, error) { return []byte(`{}`), nil })

	req, err := http.NewRequest(http.MethodPost, ts.URL+FleetDirectoryPath, nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set(local.HeaderName, tok)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("POST %s: %v", FleetDirectoryPath, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusMethodNotAllowed {
		t.Errorf("POST %s = %d, want 405", FleetDirectoryPath, resp.StatusCode)
	}
}

// --- loopback self-enrolment ---

// newEnrolServer is a daemon on an httptest listener with a fleet key and a
// place on the relay: the shape a joined machine has, which is the only shape
// enrolment does anything in. machineID of "" is the half-configured machine
// that holds a key and no id.
func newEnrolServer(t *testing.T, machineID string) (*httptest.Server, *Server, fleet.Key) {
	t.Helper()
	dir := t.TempDir()
	key, err := crypto.LoadOrCreateStaticKey(dir)
	if err != nil {
		t.Fatalf("LoadOrCreateStaticKey: %v", err)
	}
	fk, err := fleet.Mint(rand.Reader)
	if err != nil {
		t.Fatalf("fleet.Mint: %v", err)
	}
	srv := New(session.NewRegistry(time.Now), nil, http.NotFoundHandler(), "test",
		Identity{Key: key, Devices: crypto.NewDeviceStore(dir), Fleet: StaticFleet(fk, machineID)})
	t.Cleanup(srv.Shutdown)
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)
	srv.SetAuth(local.NewAuth(tok, portOf(t, ts)))
	if machineID != "" {
		srv.SetRelayMachine(machineID, "Karn's MacBook Pro")
	}
	return ts, srv, fk
}

// postEnrol is the request the loopback UI makes: a POST from this daemon's
// own origin, authenticated by the session cookie, carrying one key.
func postEnrol(t *testing.T, ts *httptest.Server, publicKey []byte) *http.Response {
	t.Helper()
	body, err := json.Marshal(map[string]string{
		"publicKey": base64.StdEncoding.EncodeToString(publicKey),
	})
	if err != nil {
		t.Fatal(err)
	}
	req, err := http.NewRequest(http.MethodPost, ts.URL+EnrolPath, bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.AddCookie(&http.Cookie{Name: tsCookie(ts), Value: tok})
	req.Header.Set("Origin", ts.URL)
	req.Header.Set("Sec-Fetch-Site", "same-origin")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("POST %s: %v", EnrolPath, err)
	}
	t.Cleanup(func() { resp.Body.Close() })
	return resp
}

// enrolOK posts and decodes a successful answer.
func enrolOK(t *testing.T, ts *httptest.Server, publicKey []byte) enrolAnswer {
	t.Helper()
	resp := postEnrol(t, ts, publicKey)
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("POST %s = %d (%s), want 200", EnrolPath, resp.StatusCode, body)
	}
	var out enrolAnswer
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		t.Fatalf("decoding the enrolment answer: %v", err)
	}
	return out
}

// TestEnrolMintsACertificateThatVerifies is the endpoint's whole purpose: the
// loopback browser comes away holding a fleet identity that every other
// machine will admit it on.
//
// The certificate is checked under the fleet public key *from the same answer*,
// because that pair is what the browser will pin and present — a certificate
// that verified under some other key would be one no sibling could check.
func TestEnrolMintsACertificateThatVerifies(t *testing.T) {
	const machineID = "karns-mbp-a1b2-0f9a12cd"
	ts, srv, fk := newEnrolServer(t, machineID)
	key := deviceKey(0x51)

	out := enrolOK(t, ts, key)

	if !bytes.Equal(out.FleetPub, fk.Public()) {
		t.Fatal("the answer's fleetPub is not this machine's fleet public key")
	}
	cert, err := fleet.VerifyDevice(out.FleetPub, out.DeviceCert)
	if err != nil {
		t.Fatalf("the certificate does not verify under the fleet key in the same answer: %v", err)
	}
	if !bytes.Equal(cert.Device, key) {
		t.Error("the certificate names a device key other than the one enrolled")
	}
	if cert.PairedOn != machineID {
		t.Errorf("cert pairedOn = %q, want this machine's relay id %q", cert.PairedOn, machineID)
	}
	if out.MachineID != machineID {
		t.Errorf("machineId = %q, want %q", out.MachineID, machineID)
	}
	if out.DeviceID != crypto.DeviceID(key) {
		t.Errorf("deviceId = %q, want the digest of the key %q", out.DeviceID, crypto.DeviceID(key))
	}

	// The stored blob and the handed-over blob are the same artifact: the
	// browser compares what it holds against what a welcome offers it, and two
	// spellings of one certificate would fail that comparison.
	list := devices(t, srv)
	if len(list) != 1 {
		t.Fatalf("registry = %+v, want the one enrolled browser", list)
	}
	if !bytes.Equal(list[0].Cert, out.DeviceCert) {
		t.Error("the certificate on file is not the one handed to the browser")
	}
}

// TestEnrolNeverHandsOverTheFleetSeed. The public half is a thing to pin; the
// seed mints certificates for the whole fleet. The argument that this endpoint
// grants no new authority is about what a shell could already read off disk —
// it is not a licence to write a fleet-wide signing key into every tab's
// IndexedDB.
func TestEnrolNeverHandsOverTheFleetSeed(t *testing.T) {
	ts, _, fk := newEnrolServer(t, "karns-mbp-a1b2-0f9a12cd")
	resp := postEnrol(t, ts, deviceKey(0x52))
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	// The seed as the join line and relay.json spell it: unpadded URL-safe
	// base64 of the 32 seed bytes.
	if strings.Contains(string(body), fk.Seed()) {
		t.Fatal("the enrolment answer carries the fleet seed")
	}
	// The same bytes in the encoding this answer uses for every key it does
	// carry, so a re-encoding cannot smuggle them past the check above.
	seed, err := base64.RawURLEncoding.DecodeString(fk.Seed())
	if err != nil {
		t.Fatalf("decoding the seed: %v", err)
	}
	if strings.Contains(string(body), base64.StdEncoding.EncodeToString(seed)) {
		t.Fatal("the enrolment answer carries the fleet seed in the answer's own encoding")
	}
	// And what it does carry is a public key's worth of bytes, not a private
	// key's: ed25519's private half is 64 and its public half is 32.
	var out enrolAnswer
	if err := json.Unmarshal(body, &out); err != nil {
		t.Fatalf("decoding the enrolment answer: %v", err)
	}
	if len(out.FleetPub) != ed25519.PublicKeySize {
		t.Errorf("fleetPub is %d bytes, want an ed25519 public key's %d", len(out.FleetPub), ed25519.PublicKeySize)
	}
}

// TestEnrolIsIdempotent: a browser calls this on every load, because it has no
// way to know whether this daemon has seen it before. The second call must
// answer the first call's device, with the first call's certificate, and leave
// one row behind.
//
// Devices.Add is deliberately not idempotent — it records a ceremony — so the
// lookup is what carries this, and losing it would turn an ordinary page load
// into "device is already paired".
func TestEnrolIsIdempotent(t *testing.T) {
	ts, srv, _ := newEnrolServer(t, "karns-mbp-a1b2-0f9a12cd")
	key := deviceKey(0x53)

	first := enrolOK(t, ts, key)
	second := enrolOK(t, ts, key)

	if first.DeviceID != second.DeviceID {
		t.Errorf("deviceId = %q then %q, want the same device", first.DeviceID, second.DeviceID)
	}
	if !bytes.Equal(first.DeviceCert, second.DeviceCert) {
		t.Error("the second enrolment re-minted the certificate; a certificate is one artifact for the life of a pairing")
	}
	if list := devices(t, srv); len(list) != 1 {
		t.Errorf("registry = %+v after two enrolments, want one row", list)
	}
}

// TestEnrolShowsUpOnTheDevicesScreen, labelled as what it is.
//
// The label matters more than it looks, and it has to survive travelling. This
// row appears on *other* machines' Devices screens the moment this browser
// reaches them and they admit it on its certificate (AddFromFleetCert) — and
// the name they render comes out of that signed certificate, so it is written
// here and read there. It must name the machine, so the row is not an
// unexplained device on a machine that never saw it, and it must say nothing
// relative: "this machine's browser", read on the sibling, is a claim about the
// sibling.
func TestEnrolShowsUpOnTheDevicesScreen(t *testing.T) {
	ts, srv, _ := newEnrolServer(t, "karns-mbp-a1b2-0f9a12cd")
	enrolOK(t, ts, deviceKey(0x54))

	list := devices(t, srv)
	if len(list) != 1 {
		t.Fatalf("registry = %+v, want the one enrolled browser", list)
	}
	if want := enrolLabel(srv.hostname); list[0].Label != want {
		t.Errorf("label = %q, want %q", list[0].Label, want)
	}
	if !strings.Contains(list[0].Label, srv.hostname) {
		t.Errorf("label = %q, want it to name the machine the browser is on", list[0].Label)
	}
	if strings.Contains(list[0].Label, "this machine") {
		t.Errorf("label = %q, want nothing relative: it is rendered on other machines too", list[0].Label)
	}

	// And the name the certificate carries is the same one, so a sibling
	// machine writes the same label into its own registry.
	cert, err := fleet.VerifyDevice(srv.fleetIdentity().Key.Public(), list[0].Cert)
	if err != nil {
		t.Fatalf("VerifyDevice: %v", err)
	}
	if cert.Name != list[0].Label {
		t.Errorf("cert name = %q, want the registry's label %q", cert.Name, list[0].Label)
	}
}

// TestEnrolRefusesADaemonWithNoFleetKey: honest, and a refusal rather than a
// half-enrolment.
//
// Registering the key with no certificate would put a row on the Devices screen
// that admits this browser to exactly the machine it could already reach, and
// leave the browser believing it holds a fleet identity it does not.
func TestEnrolRefusesADaemonWithNoFleetKey(t *testing.T) {
	ts, srv := newPairServer(t) // no fleet key at all
	resp := postEnrol(t, ts, deviceKey(0x55))
	if resp.StatusCode != http.StatusConflict {
		t.Fatalf("POST %s = %d on a daemon with no fleet key, want 409", EnrolPath, resp.StatusCode)
	}
	if list := devices(t, srv); len(list) != 0 {
		t.Errorf("registry = %+v, want nothing written by a refused enrolment", list)
	}
}

// TestEnrolRefusesADaemonWithNoMachineID: a fleet key and no place on the
// relay. `pairedOn` is a machine id, and one naming the empty machine is a blob
// no reader can attribute — the same refusal the pairing ceremony makes.
func TestEnrolRefusesADaemonWithNoMachineID(t *testing.T) {
	ts, srv, _ := newEnrolServer(t, "")
	resp := postEnrol(t, ts, deviceKey(0x56))
	if resp.StatusCode != http.StatusConflict {
		t.Fatalf("POST %s = %d on a daemon with no machine id, want 409", EnrolPath, resp.StatusCode)
	}
	if list := devices(t, srv); len(list) != 0 {
		t.Errorf("registry = %+v, want nothing written by a refused enrolment", list)
	}
}

// TestEnrolNeedsTheSessionToken. It is behind withAuth like everything else on
// this surface: the argument that enrolment grants no new authority rests
// entirely on it being gated by the same credential that spawns shells, so an
// unauthenticated caller reaching it would take the argument away.
func TestEnrolNeedsTheSessionToken(t *testing.T) {
	ts, srv, _ := newEnrolServer(t, "karns-mbp-a1b2-0f9a12cd")

	body := `{"publicKey":"` + base64.StdEncoding.EncodeToString(deviceKey(0x57)) + `"}`
	resp, err := http.Post(ts.URL+EnrolPath, "application/json", strings.NewReader(body))
	if err != nil {
		t.Fatalf("POST %s: %v", EnrolPath, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("unauthenticated POST %s = %d, want 401", EnrolPath, resp.StatusCode)
	}
	if list := devices(t, srv); len(list) != 0 {
		t.Errorf("registry = %+v, want nothing enrolled without a credential", list)
	}
}

// TestEnrolRefusesACrossOriginPost is the provenance half, which is the
// transport's own (checkProvenance) and is not re-implemented here.
//
// It matters because the session cookie is attached by the browser itself and
// SameSite is blind to the port: an unrelated dev server on 127.0.0.1:3000 is
// same-site with this daemon. Sec-Fetch-Site sees the difference and the Origin
// allowlist sees it too, so either check alone refuses this.
func TestEnrolRefusesACrossOriginPost(t *testing.T) {
	ts, srv, _ := newEnrolServer(t, "karns-mbp-a1b2-0f9a12cd")

	body := `{"publicKey":"` + base64.StdEncoding.EncodeToString(deviceKey(0x58)) + `"}`
	req, err := http.NewRequest(http.MethodPost, ts.URL+EnrolPath, strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.AddCookie(&http.Cookie{Name: tsCookie(ts), Value: tok})
	req.Header.Set("Origin", "http://127.0.0.1:3000")
	req.Header.Set("Sec-Fetch-Site", "same-site")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("POST %s: %v", EnrolPath, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("cross-origin POST %s = %d, want 403", EnrolPath, resp.StatusCode)
	}
	if list := devices(t, srv); len(list) != 0 {
		t.Errorf("registry = %+v, want nothing enrolled by a cross-origin page", list)
	}
}

// TestEnrolIsNotReachableByGET. Enrolling writes to the device registry, and a
// GET is the one method a redirect can launder — the reason methodPolicy exists
// and the reason every handler on this surface repeats the check.
func TestEnrolIsNotReachableByGET(t *testing.T) {
	ts, srv, _ := newEnrolServer(t, "karns-mbp-a1b2-0f9a12cd")
	resp := getFleet(t, ts, EnrolPath)
	if resp.StatusCode != http.StatusMethodNotAllowed {
		t.Fatalf("GET %s = %d, want 405", EnrolPath, resp.StatusCode)
	}
	if list := devices(t, srv); len(list) != 0 {
		t.Errorf("registry = %+v, want nothing enrolled by a GET", list)
	}
}

// TestEnrolRefusesARevokedKey. FindByKey answers "not found" for a revoked key
// and Devices.Add does not consult the revocation list at all, so without the
// explicit check a browser the operator had just cut off would re-enrol itself
// on its next page load — a fresh row on every Devices screen for a device that
// cannot connect anywhere, because both acceptance paths still refuse the key.
//
// A revocation permanently outranks a certificate (spec/fleet-trust.md).
// Un-revoking is a new key, which for a browser means clearing its storage.
func TestEnrolRefusesARevokedKey(t *testing.T) {
	ts, srv, _ := newEnrolServer(t, "karns-mbp-a1b2-0f9a12cd")
	key := deviceKey(0x59)
	first := enrolOK(t, ts, key)

	if _, _, err := srv.removeDevice(first.DeviceID); err != nil {
		t.Fatalf("removeDevice: %v", err)
	}

	resp := postEnrol(t, ts, key)
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("POST %s = %d for a revoked key, want 403", EnrolPath, resp.StatusCode)
	}
	if list := devices(t, srv); len(list) != 0 {
		t.Errorf("registry = %+v, want a revoked key to stay revoked", list)
	}
}

// TestRevokingTheEnrolledBrowserDoesNotLockTheMachineOut is the safety property
// that makes this credential acceptable at all.
//
// Unlike the session cookie, an enrolled device survives token rotation — so it
// has to be revocable, and revoking it must not be a way to lock a user out of
// their own machine's UI. It is not, and by construction rather than by care: a
// loopback connection authenticates a machine-local session token rather than a
// device, so it carries device == "" and addConn never files it under any
// device bucket. disconnectDevice walks that bucket and finds nothing.
func TestRevokingTheEnrolledBrowserDoesNotLockTheMachineOut(t *testing.T) {
	ts, srv, _ := newEnrolServer(t, "karns-mbp-a1b2-0f9a12cd")

	// A loopback tab, connected, and enrolled — the state a user is in.
	c := dial(t, ts)
	readUntil(t, c, func(msg any, _ []byte) bool { _, ok := msg.(wire.Welcome); return ok })
	out := enrolOK(t, ts, deviceKey(0x5a))

	// The Devices screen revokes it, over the wire, exactly as the button does.
	writeControl(t, c, wire.Revoke{DeviceID: out.DeviceID})
	readUntil(t, c, func(msg any, _ []byte) bool {
		list, ok := msg.(wire.DeviceList)
		return ok && len(list.Devices) == 0
	})

	// The socket that asked for the revoke is still the socket it was: a
	// revoked-device close would have arrived instead of the list above, and
	// the connection registry still holds it.
	if got := len(srv.allConns()); got != 1 {
		t.Fatalf("live connections = %d after revoking this machine's own browser, want the loopback tab still up", got)
	}
	if closed := srv.disconnectDevice(out.DeviceID, "revoked"); closed != 0 {
		t.Errorf("disconnectDevice closed %d loopback connections, want 0 — loopback carries no device identity", closed)
	}

	// And a fresh tab still gets in on the session token, which is the
	// credential the loopback UI has always used.
	c2 := dial(t, ts)
	readUntil(t, c2, func(msg any, _ []byte) bool { _, ok := msg.(wire.Welcome); return ok })
}

// TestEnrolRefusesAMalformedKey: the shape checks, before anything is written.
func TestEnrolRefusesAMalformedKey(t *testing.T) {
	ts, srv, _ := newEnrolServer(t, "karns-mbp-a1b2-0f9a12cd")
	for _, body := range []string{
		`not json`,
		`{}`,
		`{"publicKey":""}`,
		`{"publicKey":"not base64!!"}`,
		`{"publicKey":"AAEC"}`, // three bytes, not thirty-two
	} {
		req, err := http.NewRequest(http.MethodPost, ts.URL+EnrolPath, strings.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		req.AddCookie(&http.Cookie{Name: tsCookie(ts), Value: tok})
		req.Header.Set("Sec-Fetch-Site", "same-origin")
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatalf("POST %s: %v", EnrolPath, err)
		}
		resp.Body.Close()
		if resp.StatusCode != http.StatusBadRequest {
			t.Errorf("POST %s with body %q = %d, want 400", EnrolPath, body, resp.StatusCode)
		}
	}
	if list := devices(t, srv); len(list) != 0 {
		t.Errorf("registry = %+v, want nothing written by a malformed request", list)
	}
}

// TestEnrolBackfillsACertificateADeviceHasNone. A row registered before this
// machine held a fleet key carries no certificate, and nothing repaired it but
// a connection over the relay. Enrolment is a second such moment, and it uses
// the same back-fill rather than a second mint of its own.
func TestEnrolBackfillsACertificateADeviceHasNone(t *testing.T) {
	ts, srv, fk := newEnrolServer(t, "karns-mbp-a1b2-0f9a12cd")
	key := deviceKey(0x5b)
	// The state a pre-fleet pairing left behind: a row, no cert.
	if _, err := srv.identity.Devices.Add("an older pairing", key, nil); err != nil {
		t.Fatalf("Add: %v", err)
	}

	out := enrolOK(t, ts, key)
	if len(out.DeviceCert) == 0 {
		t.Fatal("enrolment answered a registered device with no certificate")
	}
	cert, err := fleet.VerifyDevice(fk.Public(), out.DeviceCert)
	if err != nil {
		t.Fatalf("the back-filled certificate does not verify: %v", err)
	}
	if !bytes.Equal(cert.Device, key) {
		t.Error("the back-filled certificate names another key")
	}
	// The existing row keeps its own label: the registry is this machine's
	// record of a pairing, and an enrolment is not an edit of one.
	list := devices(t, srv)
	if len(list) != 1 || list[0].Label != "an older pairing" {
		t.Errorf("registry = %+v, want the existing row untouched", list)
	}
}

// TestDeviceListSaysWhichMachinePairedEachRow.
//
// A machine on a fleet admits devices two ways — the ones it paired itself, and
// the ones it took on the fleet's word when they arrived holding a certificate
// — and on the wire those two used to be indistinguishable. They are not the
// same thing to act on: revoking the second publishes a revocation the whole
// fleet honours, permanently, which is a different button from cutting a phone
// off one laptop.
//
// So the answer comes from the certificate, and only from a certificate that
// verifies. Every other case reads as this machine's own, which is the
// conservative direction: it is the one that does not offer a fleet-wide revoke
// on the strength of a blob that proved nothing.
func TestDeviceListSaysWhichMachinePairedEachRow(t *testing.T) {
	const here = "karns-mbp-a1b2-0f9a12cd"
	ts, srv, fk := newEnrolServer(t, here)

	// Paired here, by this machine's own ceremony.
	mine := deviceKey(0x51)
	enrolOK(t, ts, mine)

	// Admitted on the fleet's word: the certificate names the sibling that ran
	// the ceremony, and this machine never saw that ceremony happen.
	theirs := deviceKey(0x52)
	sibling, err := fk.Sign(fleet.DeviceCert{
		Device:   theirs,
		Name:     "Browser on mac-mini.local",
		PairedOn: "mac-mini-b3c4-1a2b3c4d",
		IAT:      time.Now().Unix(),
	})
	if err != nil {
		t.Fatalf("signing the sibling's device cert: %v", err)
	}
	if _, err := srv.identity.Devices.AddFromFleetCert("Browser on mac-mini.local", theirs, sibling, time.Now()); err != nil {
		t.Fatalf("AddFromFleetCert: %v", err)
	}

	// Paired before this machine had a fleet key: a row with no certificate at
	// all, which is what an upgrade from before fleet trust leaves behind.
	older := deviceKey(0x53)
	if _, err := srv.identity.Devices.Add("attic phone", older, nil); err != nil {
		t.Fatalf("Add: %v", err)
	}

	// A certificate from a fleet this machine is not on. It parses, it is
	// well-formed, and it is signed by the wrong key — so it says nothing, and
	// must not be read as though it did.
	stranger := deviceKey(0x55)
	other, err := fleet.Mint(rand.Reader)
	if err != nil {
		t.Fatalf("fleet.Mint: %v", err)
	}
	forged, err := other.Sign(fleet.DeviceCert{
		Device:   stranger,
		Name:     "somebody else's laptop",
		PairedOn: "elsewhere-9999-deadbeef",
		IAT:      time.Now().Unix(),
	})
	if err != nil {
		t.Fatalf("signing under the wrong fleet key: %v", err)
	}
	if _, err := srv.identity.Devices.Add("stranger", stranger, forged); err != nil {
		t.Fatalf("Add: %v", err)
	}

	list, err := srv.deviceList()
	if err != nil {
		t.Fatalf("deviceList: %v", err)
	}
	got := map[string]string{}
	for _, d := range list.Devices {
		got[d.Label] = d.PairedOn
	}
	want := map[string]string{
		enrolLabel(srv.hostname):    here,
		"Browser on mac-mini.local": "mac-mini-b3c4-1a2b3c4d",
		"attic phone":               "",
		"stranger":                  "",
	}
	for label, on := range want {
		if got[label] != on {
			t.Errorf("%q pairedOn = %q, want %q", label, got[label], on)
		}
	}
}
