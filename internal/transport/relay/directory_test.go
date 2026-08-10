package relay

import (
	"context"
	"crypto/rand"
	"log/slog"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/flynn/noise"
	"github.com/karnstack/flue/internal/crypto"
	"github.com/karnstack/flue/internal/fleet"
)

// The fleet directory leg, from the daemon's side.
//
// Every test here is really one assertion: what the relay says is bytes, and
// only a signature under the fleet key turns bytes into a fact. So the fake
// directory is allowed to lie in every way a real one could — wrong signer,
// edited blob, truncated set, empty set, 507, 413 — and the daemon's answer to
// all of them has to be the same: drop it, keep serving, converge when it can.

// contextWithTimeout is the fake directory's helper, here because it is the
// only file in the package that needs one.
func contextWithTimeout(d time.Duration) (context.Context, context.CancelFunc) {
	return context.WithTimeout(context.Background(), d)
}

// fakeSink records the revocations that made it past verification. It is the
// seam the daemon sits behind (daemon.Server implements FleetSink), so a test
// can assert on exactly what a hostile directory managed to get through.
type fakeSink struct {
	mu      sync.Mutex
	applied [][]byte // device keys, in order
	fail    error    // when set, every apply fails
}

func (s *fakeSink) ApplyFleetRevocation(deviceKey, blob []byte) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.fail != nil {
		return s.fail
	}
	s.applied = append(s.applied, append([]byte(nil), deviceKey...))
	return nil
}

func (s *fakeSink) count() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.applied)
}

func (s *fakeSink) applies() [][]byte {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([][]byte(nil), s.applied...)
}

// awaitApplied waits for n revocations to have been applied.
func (s *fakeSink) awaitApplied(t *testing.T, n int, what string) {
	t.Helper()
	deadline := time.Now().Add(waitFor)
	for {
		if s.count() >= n {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("%s: %d revocations applied in %s, want %d", what, s.count(), waitFor, n)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// stayedAt asserts that nothing further was applied over a window long enough
// for it to have been. Used by every "this must be dropped" test: the absence
// of an effect is only evidence if the effect had time to happen.
func (s *fakeSink) stayedAt(t *testing.T, n int, what string) {
	t.Helper()
	deadline := time.Now().Add(300 * time.Millisecond)
	for time.Now().Before(deadline) {
		if got := s.count(); got != n {
			t.Fatalf("%s: %d revocations applied, want %d", what, got, n)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// dirFixture is one machine's directory leg: its fleet key, its device store,
// the fake relay it talks to and the sink its revocations land in.
type dirFixture struct {
	dir     *Directory
	fd      *fakeDirectory
	sink    *fakeSink
	fleet   fleet.Key
	devices *crypto.DeviceStore
	key     noise.DHKey
	log     *syncBuffer
}

const dirSecret = "s3cr3t-daemon-secret"

// newDirFixture builds a directory leg over a fresh fake directory. opts runs
// on the Config before NewDirectory sees it, which is how a test gives this
// machine a machine certificate or a fleet key it does not hold.
func newDirFixture(t *testing.T, opts ...func(*Config)) *dirFixture {
	t.Helper()
	fd := newFakeDirectory(t, dirSecret)
	return newDirFixtureOn(t, fd, opts...)
}

// newDirFixtureOn is newDirFixture against a directory that already exists —
// a second machine on the same relay, which is what "published on A, applied
// on B" needs.
func newDirFixtureOn(t *testing.T, fd *fakeDirectory, opts ...func(*Config)) *dirFixture {
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
	f := &dirFixture{
		fd:      fd,
		sink:    &fakeSink{},
		fleet:   fk,
		devices: crypto.NewDeviceStore(dir),
		key:     key,
		log:     &syncBuffer{},
	}
	cfg := Config{
		URL:       fd.URL(),
		Secret:    dirSecret,
		Origin:    testOrigin,
		MachineID: testMachineID,
		FleetPub:  fk.Public(),
	}
	for _, o := range opts {
		o(&cfg)
	}
	d, err := NewDirectory(cfg, f.sink, key, f.devices, slog.New(slog.NewTextHandler(f.log, nil)))
	if err != nil {
		t.Fatalf("NewDirectory: %v", err)
	}
	// Short enough that a keepalive test need not wait 30 s for one.
	d.keepalive = 50 * time.Millisecond
	f.dir = d
	return f
}

// run starts the leg and stops it when the test ends.
func (f *dirFixture) run(t *testing.T) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- f.dir.Run(ctx) }()
	t.Cleanup(func() {
		cancel()
		select {
		case err := <-done:
			if err != nil {
				t.Errorf("Run returned %v after cancellation, want nil", err)
			}
		case <-time.After(waitFor):
			t.Error("Run did not return within the deadline after cancellation")
		}
	})
}

// revocation signs one under this machine's fleet key.
func (f *dirFixture) revocation(t *testing.T, deviceKey []byte) []byte {
	t.Helper()
	blob, err := f.fleet.Sign(fleet.Revocation{Device: deviceKey, IAT: time.Now().Unix()})
	if err != nil {
		t.Fatalf("signing a revocation: %v", err)
	}
	return blob
}

// machineCert signs this machine's own, the way `flue relay join` does.
func (f *dirFixture) machineCert(t *testing.T) []byte {
	t.Helper()
	blob, err := f.fleet.Sign(fleet.MachineCert{
		ID: testMachineID, Name: "Karn's MacBook Pro", Noise: f.key.Public, IAT: time.Now().Unix(),
	})
	if err != nil {
		t.Fatalf("signing a machine cert: %v", err)
	}
	return blob
}

// someKey is a 32-byte device key that is nobody's in particular.
func someKey(t *testing.T, fill byte) []byte {
	t.Helper()
	k := make([]byte, 32)
	for i := range k {
		k[i] = fill
	}
	return k
}

// TestDirectoryAppliesARevocationPublishedElsewhere is the feature: machine A
// revokes a device, and machine B — which never paired it and was not asked —
// drops it. Here the publishing is the fake's `store`, which is machine A's
// PUT seen from the relay's side.
func TestDirectoryAppliesARevocationPublishedElsewhere(t *testing.T) {
	f := newDirFixture(t)
	dead := someKey(t, 0xAB)
	f.fd.store(f.revocation(t, dead))

	f.run(t)
	f.sink.awaitApplied(t, 1, "a revocation waiting in the directory at connect")
	if got := f.sink.applies()[0]; string(got) != string(dead) {
		t.Errorf("applied revocation for %x, want %x", got, dead)
	}
}

// TestDirectoryAppliesARevocationPushedWhileConnected: the same fact arriving
// on the socket rather than in the snapshot — the path that makes a revoke
// take effect on the other machines in seconds rather than on their next
// reconnect.
func TestDirectoryAppliesARevocationPushedWhileConnected(t *testing.T) {
	f := newDirFixture(t)
	f.run(t)
	// The connection is established once the snapshot has been read.
	f.fd.awaitRead(t, 1)

	dead := someKey(t, 0xCD)
	f.fd.store(f.revocation(t, dead))
	f.sink.awaitApplied(t, 1, "a revocation pushed on the socket")
}

// TestDirectoryDropsABlobSignedByTheWrongKey is the trust boundary itself. The
// relay is holding a perfectly well-formed revocation for a device this daemon
// is carrying — signed by a key that is not this fleet's. Honouring it would
// make the directory an unauthenticated kill switch for anyone who can write
// to a relay: the secret-holder, a Cloudflare account takeover, a Worker
// deployed by someone else.
func TestDirectoryDropsABlobSignedByTheWrongKey(t *testing.T) {
	f := newDirFixture(t)

	other, err := fleet.Mint(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	dead := someKey(t, 0xEF)
	forged, err := other.Sign(fleet.Revocation{Device: dead, IAT: time.Now().Unix()})
	if err != nil {
		t.Fatal(err)
	}
	f.fd.store(forged)

	f.run(t)
	f.fd.awaitRead(t, 1)
	f.sink.stayedAt(t, 0, "a revocation signed by another fleet key")
	if !strings.Contains(f.log.String(), "does not verify under the fleet key") {
		t.Errorf("the drop was not logged; log was:\n%s", f.log.String())
	}
}

// TestDirectoryDropsAMangledBlob: a blob that verified when it was signed and
// does not now. Truncation, a trailing byte, one flipped bit in the middle —
// all three are the same fault to a signature, and all three have to be the
// same answer here, because the relay is the one holding the bytes.
func TestDirectoryDropsAMangledBlob(t *testing.T) {
	f := newDirFixture(t)
	dead := someKey(t, 0x11)
	good := f.revocation(t, dead)

	for _, tc := range []struct {
		name string
		blob []byte
	}{
		{"truncated", good[:len(good)-1]},
		{"truncated to nothing but the prefix", good[:16]},
		{"extended by a byte", append(append([]byte(nil), good...), 0x00)},
		{"one bit flipped in the signature", flipLast(good)},
		{"one bit flipped in the fields", flipAt(good, 20)},
	} {
		f.fd.store(tc.blob)
	}
	// And the good one last, as the fence: if the mangled blobs had been
	// honoured this count would be six rather than one.
	f.fd.store(good)

	f.run(t)
	f.sink.awaitApplied(t, 1, "the one intact revocation")
	f.sink.stayedAt(t, 1, "five mangled revocations beside an intact one")
}

func flipLast(b []byte) []byte {
	out := append([]byte(nil), b...)
	out[len(out)-1] ^= 0x01
	return out
}

func flipAt(b []byte, i int) []byte {
	out := append([]byte(nil), b...)
	out[i] ^= 0x01
	return out
}

// TestDirectoryDropsAnOversizedBlob: the Worker caps a blob at 4 KiB, and this
// daemon does not take the Worker's word for it. Anything past the cap is
// dropped before a signature check is even attempted — the bound exists so a
// relay cannot spend this process's memory or its CPU at will.
func TestDirectoryDropsAnOversizedBlob(t *testing.T) {
	f := newDirFixture(t)
	f.fd.store(make([]byte, maxBlobBytes+1))
	f.fd.store([]byte{})

	f.run(t)
	f.fd.awaitRead(t, 1)
	f.sink.stayedAt(t, 0, "an oversized and an empty entry")
	if !strings.Contains(f.log.String(), "impossible size") {
		t.Errorf("the oversized entry was not reported; log was:\n%s", f.log.String())
	}
}

// TestDirectoryIngestIsIdempotent: the same revocation arrives on the socket
// and again in every snapshot, forever. Applying it twice must be free — the
// sink is idempotent too, but a leg that re-ran the whole fleet's history on
// every reconnect would be spending a signature check and a registry write per
// entry per reconnect.
func TestDirectoryIngestIsIdempotent(t *testing.T) {
	f := newDirFixture(t)
	dead := someKey(t, 0x22)
	blob := f.revocation(t, dead)
	f.fd.store(blob)

	f.run(t)
	f.sink.awaitApplied(t, 1, "the revocation in the snapshot")

	// The same bytes again, by both paths: a push of something already stored
	// (which the real directory would not even send) and a re-read.
	f.fd.push(blob)
	f.dir.ingestSnapshot(context.Background())
	f.sink.stayedAt(t, 1, "the same revocation delivered three times")
}

// TestDirectoryPublishesWhatThisMachineHolds: the machine cert from
// relay.json, the device certs this machine's own ceremonies minted, and every
// revocation it knows — all of it, on connect, so a machine that was switched
// off while the fleet moved catches the fleet up as well as catching up.
func TestDirectoryPublishesWhatThisMachineHolds(t *testing.T) {
	var machineCert []byte
	f := newDirFixture(t, func(c *Config) {})
	machineCert = f.machineCert(t)
	f.dir.cfg.MachineCert = machineCert

	// A device this machine paired, with the cert its ceremony minted.
	devKey := someKey(t, 0x33)
	devCert, err := f.fleet.Sign(fleet.DeviceCert{
		Device: devKey, Name: "phone", PairedOn: testMachineID, IAT: time.Now().Unix(),
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.devices.Add("phone", devKey, devCert); err != nil {
		t.Fatalf("Add: %v", err)
	}
	// And a revocation it minted for some other device.
	revoked := someKey(t, 0x44)
	rev := f.revocation(t, revoked)
	if err := f.devices.AddRevocation(revoked, rev); err != nil {
		t.Fatalf("AddRevocation: %v", err)
	}

	f.run(t)
	f.fd.awaitPublished(t, machineCert, "this machine's certificate")
	f.fd.awaitPublished(t, devCert, "a device certificate this machine minted")
	f.fd.awaitPublished(t, rev, "a revocation this machine minted")
}

// TestDirectoryPublishesAFreshlyMintedArtifact: the live path — a pairing
// ceremony or a revoke hands a blob to the publisher, which puts it on the
// wire without the caller waiting for anything.
func TestDirectoryPublishesAFreshlyMintedArtifact(t *testing.T) {
	f := newDirFixture(t)
	f.run(t)
	f.fd.awaitRead(t, 1)

	blob := f.revocation(t, someKey(t, 0x55))
	f.dir.PublishFleetBlob(blob)
	f.fd.awaitPublished(t, blob, "a revocation minted while connected")
}

// TestDirectoryRefusesToPublishAStaleMachineCert: the cert names the Noise key
// browsers will pin, so publishing one that names a key this daemon no longer
// holds would advertise a machine nothing in the fleet can handshake with —
// worse than publishing nothing, which merely leaves it undiscovered.
func TestDirectoryRefusesToPublishAStaleMachineCert(t *testing.T) {
	for _, tc := range []struct {
		name string
		make func(f *dirFixture, t *testing.T) []byte
		want string
	}{
		{
			name: "a cert for another machine's id",
			make: func(f *dirFixture, t *testing.T) []byte {
				b, err := f.fleet.Sign(fleet.MachineCert{
					ID: "someone-else-a1b2-0f9a12cd", Name: "n", Noise: f.key.Public, IAT: 1,
				})
				if err != nil {
					t.Fatal(err)
				}
				return b
			},
			want: "names another machine",
		},
		{
			name: "a cert for a static key this daemon does not hold",
			make: func(f *dirFixture, t *testing.T) []byte {
				b, err := f.fleet.Sign(fleet.MachineCert{
					ID: testMachineID, Name: "n", Noise: someKey(t, 0x66), IAT: 1,
				})
				if err != nil {
					t.Fatal(err)
				}
				return b
			},
			want: "names a static key this daemon no longer holds",
		},
		{
			name: "a cert signed by another fleet",
			make: func(f *dirFixture, t *testing.T) []byte {
				other, err := fleet.Mint(rand.Reader)
				if err != nil {
					t.Fatal(err)
				}
				b, err := other.Sign(fleet.MachineCert{
					ID: testMachineID, Name: "n", Noise: f.key.Public, IAT: 1,
				})
				if err != nil {
					t.Fatal(err)
				}
				return b
			},
			want: "does not verify under this relay's fleet key",
		},
		{
			name: "a device certificate where a machine certificate belongs",
			make: func(f *dirFixture, t *testing.T) []byte {
				b, err := f.fleet.Sign(fleet.DeviceCert{
					Device: someKey(t, 0x77), Name: "n", PairedOn: testMachineID, IAT: 1,
				})
				if err != nil {
					t.Fatal(err)
				}
				return b
			},
			want: "where a machine certificate belongs",
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newDirFixture(t)
			cert := tc.make(f, t)
			f.dir.cfg.MachineCert = cert

			f.run(t)
			f.fd.awaitRead(t, 1)
			if f.fd.published(cert) {
				t.Error("published a machine certificate that does not describe this machine")
			}
			if !strings.Contains(f.log.String(), tc.want) {
				t.Errorf("log does not say %q; it says:\n%s", tc.want, f.log.String())
			}
		})
	}
}

// TestDirectorySurvivesAFullDirectory: 507 means "your blob is fine and I will
// not keep it", and the operator has to be told — but a daemon that treated it
// as a connection fault, or retried it in a loop, would turn a full directory
// into a relay leg that is also down. The socket stays up and revocations
// already stored keep arriving.
func TestDirectorySurvivesAFullDirectory(t *testing.T) {
	f := newDirFixture(t)
	f.fd.setFull(true)
	dead := someKey(t, 0x88)
	f.fd.store(f.revocation(t, dead))
	f.dir.cfg.MachineCert = f.machineCert(t)

	f.run(t)
	// The read still happened and the revocation still applied, even though
	// nothing this daemon offered could be stored.
	f.sink.awaitApplied(t, 1, "a revocation read from a full directory")
	if !strings.Contains(f.log.String(), "the fleet directory is full") {
		t.Errorf("a full directory was not reported; log was:\n%s", f.log.String())
	}
	// And the leg is still working: a later push is still ingested.
	f.fd.setFull(false)
	f.fd.store(f.revocation(t, someKey(t, 0x89)))
	f.sink.awaitApplied(t, 2, "a revocation pushed after a 507")
}

// TestDirectorySurvivesARefusedBlob: 413 is this daemon's own bug — it minted
// something larger than a certificate can be — and it must be loud and dropped
// rather than retried forever.
func TestDirectorySurvivesARefusedBlob(t *testing.T) {
	f := newDirFixture(t)
	f.fd.setTooLarge(true)
	f.dir.cfg.MachineCert = f.machineCert(t)

	f.run(t)
	f.fd.awaitRead(t, 1)
	deadline := time.Now().Add(waitFor)
	for !strings.Contains(f.log.String(), "refused an artifact as too large") {
		if time.Now().After(deadline) {
			t.Fatalf("a 413 was not reported; log was:\n%s", f.log.String())
		}
		time.Sleep(5 * time.Millisecond)
	}
	// Still ingesting.
	f.fd.setTooLarge(false)
	f.fd.store(f.revocation(t, someKey(t, 0x8A)))
	f.sink.awaitApplied(t, 1, "a revocation pushed after a 413")
}

// TestDirectoryTruncationCostsAvailabilityOnly: a hostile relay serving a
// partial set is the one thing it can still do, and the bound on the damage is
// that it can only *withhold*. What it withholds it can withhold forever; what
// it cannot do is un-apply a revocation this daemon has already recorded, or
// invent one.
func TestDirectoryTruncationCostsAvailabilityOnly(t *testing.T) {
	f := newDirFixture(t)
	first := f.revocation(t, someKey(t, 0x99))
	second := f.revocation(t, someKey(t, 0x9A))
	f.fd.store(first)
	f.fd.store(second)
	// Only the first entry is ever served.
	f.fd.setServing(1, false)

	f.run(t)
	f.sink.awaitApplied(t, 1, "the one entry a truncating directory served")
	f.sink.stayedAt(t, 1, "a directory serving half its set")

	// The relay now hides everything. The daemon keeps running, keeps its
	// socket, and — crucially — nothing it already applied is undone: there is
	// no message in this protocol that can un-revoke, which is why withholding
	// is the whole of the relay's power.
	f.fd.setServing(1, true)
	f.dir.ingestSnapshot(context.Background())
	f.sink.stayedAt(t, 1, "a directory serving nothing at all")

	// And when it stops lying, the daemon converges.
	f.fd.setServing(0, false)
	f.dir.ingestSnapshot(context.Background())
	f.sink.awaitApplied(t, 2, "the entry the relay had been withholding")
}

// TestDirectoryDropsEntriesPastTheCeiling: the Worker will not store more than
// MAX_ENTRIES, so an answer longer than that is not a bigger fleet. The bound
// is the daemon's own — one signature check per entry is exactly the work a
// hostile relay would like to buy in bulk.
func TestDirectoryDropsEntriesPastTheCeiling(t *testing.T) {
	f := newDirFixture(t)
	// One real revocation, then far more filler than the ceiling allows. The
	// filler is stored first, so the real one falls past the cut.
	for i := 0; i < maxDirectoryEntries+8; i++ {
		f.fd.store([]byte{byte(i), byte(i >> 8), 'f', 'i', 'l', 'l'})
	}
	dead := someKey(t, 0xA1)
	f.fd.store(f.revocation(t, dead))

	f.run(t)
	f.fd.awaitRead(t, 1)
	f.sink.stayedAt(t, 0, "an entry past the directory's own ceiling")
	if !strings.Contains(f.log.String(), "more entries than it can hold") {
		t.Errorf("the over-long answer was not reported; log was:\n%s", f.log.String())
	}
}

// TestDirectoryRetriesARevocationItCouldNotApply: a registry that could not be
// written is not a reason to forget a revocation — the device stays admitted
// until it lands, so the next snapshot has to try again rather than skipping
// it as "already seen".
func TestDirectoryRetriesARevocationItCouldNotApply(t *testing.T) {
	f := newDirFixture(t)
	f.sink.fail = errTestSinkDown
	blob := f.revocation(t, someKey(t, 0xB1))
	f.fd.store(blob)

	f.run(t)
	f.fd.awaitRead(t, 1)
	f.sink.stayedAt(t, 0, "a sink that refused")

	f.sink.mu.Lock()
	f.sink.fail = nil
	f.sink.mu.Unlock()
	f.dir.ingestSnapshot(context.Background())
	f.sink.awaitApplied(t, 1, "the retried revocation")
}

var errTestSinkDown = &sinkError{}

type sinkError struct{}

func (*sinkError) Error() string { return "the registry is unreadable" }

// TestDirectoryReadsCarryTheDaemonSecret: `GET /directory` needs no
// credential, and the Worker meters exactly the callers that present none. A
// fleet of daemons re-reading on every reconnect has no business spending the
// per-IP budget that keeps browsers working.
func TestDirectoryReadsCarryTheDaemonSecret(t *testing.T) {
	f := newDirFixture(t)
	f.run(t)
	f.fd.awaitRead(t, 1)

	f.fd.mu.Lock()
	auths := append([]string(nil), f.fd.auths...)
	f.fd.mu.Unlock()
	if len(auths) == 0 {
		t.Fatal("no request reached the directory")
	}
	for i, a := range auths {
		if a != "Bearer "+dirSecret {
			t.Errorf("request %d carried Authorization %q, want the daemon secret", i, a)
		}
	}
}

// TestDirectoryReconnects: the leg is held open across a relay that drops it,
// with the transport's own backoff — and the snapshot after a reconnect is
// what closes the window a missed push leaves.
func TestDirectoryReconnects(t *testing.T) {
	f := newDirFixture(t)
	f.run(t)
	f.fd.awaitRead(t, 1)

	f.fd.closeSockets()
	f.fd.awaitRead(t, 2)

	// A revocation stored while the socket was down is picked up by the
	// reconnect's snapshot rather than lost with the push.
	f.fd.store(f.revocation(t, someKey(t, 0xC1)))
	f.sink.awaitApplied(t, 1, "a revocation the reconnect's snapshot caught")
}

// TestNewDirectoryRefusesAnIncompleteConfig: this leg is *only* signed
// artifacts, so a config without a fleet key could not honestly do anything
// with a byte of what it reads.
func TestNewDirectoryRefusesAnIncompleteConfig(t *testing.T) {
	t.Parallel()
	fk, err := fleet.Mint(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	full := Config{URL: "wss://relay.example", Secret: "s", Origin: testOrigin, MachineID: testMachineID, FleetPub: fk.Public()}
	for _, tc := range []struct {
		name string
		cfg  Config
		sink FleetSink
	}{
		{"no URL", Config{Secret: full.Secret, FleetPub: full.FleetPub}, &fakeSink{}},
		{"no secret", Config{URL: full.URL, FleetPub: full.FleetPub}, &fakeSink{}},
		{"no fleet key", Config{URL: full.URL, Secret: full.Secret}, &fakeSink{}},
		{"no sink", full, nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := NewDirectory(tc.cfg, tc.sink, noise.DHKey{}, nil, nil); err == nil {
				t.Fatal("NewDirectory accepted an incomplete config")
			}
		})
	}
}

// TestDirectoryURLsComeFromTheDialledHost: the socket and the writes have to
// reach the object the daemon leg dials. Deriving the HTTP URL from any other
// field would let a half-edited relay.json publish this fleet's certificates
// somewhere else.
func TestDirectoryURLsComeFromTheDialledHost(t *testing.T) {
	t.Parallel()
	fk, err := fleet.Mint(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	d, err := NewDirectory(Config{
		URL:      "wss://relay.example/",
		Secret:   "s",
		Origin:   "https://somewhere-else.example",
		FleetPub: fk.Public(),
	}, &fakeSink{}, noise.DHKey{}, nil, nil)
	if err != nil {
		t.Fatalf("NewDirectory: %v", err)
	}
	if want := "wss://relay.example/directory"; d.wsURL != want {
		t.Errorf("socket URL = %q, want %q", d.wsURL, want)
	}
	if want := "https://relay.example/directory"; d.httpURL != want {
		t.Errorf("http URL = %q, want %q", d.httpURL, want)
	}
}

// TestDirectoryDoesNotRegisterDeviceCerts pins the decision that shapes this
// whole leg: a verified device certificate read out of the directory is *not*
// a local registry row.
//
// The directory is a credential-less store of public blobs. Possession of a
// cert proves nothing — the IK handshake is what proves a browser holds the
// key, which is why rule 2 of the acceptance order writes the row at *that*
// moment (channel.go, admitByFleetCert) and not before. Writing it here would
// put rows in devices.json for keys nobody has demonstrated they hold, and
// those rows are honoured by rule 1 (crypto.FindByKey), which deliberately
// never looks at a certificate: the fleet's word for today would quietly
// become this machine's own pairing forever, surviving the fleet-key rotation
// that was meant to withdraw it.
//
// Verified-and-ignored, not ignored: the cert is still checked, because the
// machine and device counts a status line reports are counts of things this
// fleet key signed.
func TestDirectoryDoesNotRegisterDeviceCerts(t *testing.T) {
	f := newDirFixture(t)
	stranger := someKey(t, 0xD1)
	cert, err := f.fleet.Sign(fleet.DeviceCert{
		Device: stranger, Name: "someone else's phone", PairedOn: "sibling-mac-a1b2-0f9a12cd", IAT: time.Now().Unix(),
	})
	if err != nil {
		t.Fatal(err)
	}
	f.fd.store(cert)
	// A machine cert beside it, which has no local consequence either: daemons
	// do not dial each other, and a sibling's cert is addressed to browsers.
	f.fd.store(f.machineCert(t))

	f.run(t)
	f.fd.awaitRead(t, 1)
	// Give the ingest a moment to have done the wrong thing if it were going
	// to: an assertion of absence is only worth something after the window in
	// which the presence would have appeared.
	time.Sleep(200 * time.Millisecond)

	list, err := f.devices.List()
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(list) != 0 {
		t.Fatalf("the directory wrote %d rows into this machine's registry: %+v", len(list), list)
	}
	if _, _, err := f.devices.FindByKey(stranger); err != nil {
		t.Fatal(err)
	}
	if _, paired, _ := f.devices.FindByKey(stranger); paired {
		t.Fatal("a device certificate read from the directory made its key pair with this machine")
	}
	// But both were verified, which is what the counts report.
	if c := f.dir.Counts(); c.Verified != 2 || c.Devices != 1 || c.Machines != 1 {
		t.Errorf("counts = %+v, want 2 verified: 1 device, 1 machine", c)
	}
}
