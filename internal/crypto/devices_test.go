package crypto

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"testing"
	"time"
)

func testKey(t *testing.T) []byte {
	t.Helper()
	k := make([]byte, 32)
	if _, err := rand.Read(k); err != nil {
		t.Fatal(err)
	}
	return k
}

// writeRegistry plants a devices.json of the test's own choosing.
//
// It exists to build the one state the store's own API cannot: an entry whose
// `id` names one key while its `publicKey` holds another. That is exactly what
// a device would look like to a lookup if someone ground out a second key with
// the same DeviceID — a 48-bit hex prefix of sha256, so ~2^48 work offline —
// and grinding one for real is not something a unit test can do. Writing the
// file is the same situation from the lookup's side, and it is the side under
// test: id matches, bytes do not.
func writeRegistry(t *testing.T, dir string, devices []Device) {
	t.Helper()
	blob, err := json.MarshalIndent(devices, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "devices.json"), blob, 0o600); err != nil {
		t.Fatal(err)
	}
}

// planted is a registry entry that claims `id` while holding `key`.
func planted(id string, key []byte) Device {
	now := time.Now().UTC()
	return Device{ID: id, Label: "planted", PublicKey: slices.Clone(key), PairedAt: now, LastSeen: now}
}

func TestDeviceStoreRoundTrip(t *testing.T) {
	dir := t.TempDir()
	s := NewDeviceStore(dir)

	key := testKey(t)
	d, err := s.Add("karn's phone", key, nil)
	if err != nil {
		t.Fatal(err)
	}
	if d.ID == "" || len(d.ID) != 12 {
		t.Fatalf("device id = %q, want 12 hex chars", d.ID)
	}

	// A fresh store over the same dir sees the same device: persistence.
	list, err := NewDeviceStore(dir).List()
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 1 || list[0].Label != "karn's phone" || !bytes.Equal(list[0].PublicKey, key) {
		t.Fatalf("persisted device = %+v", list)
	}

	got, ok, err := s.FindByKey(key)
	if err != nil || !ok || got.ID != d.ID {
		t.Fatalf("FindByKey = %+v, %v, %v", got, ok, err)
	}

	if info, err := os.Stat(filepath.Join(dir, "devices.json")); err != nil {
		t.Fatal(err)
	} else if info.Mode().Perm() != 0o600 {
		t.Fatalf("devices.json mode = %o, want 600", info.Mode().Perm())
	}
}

func TestDeviceStoreRejectsBadAndDuplicateKeys(t *testing.T) {
	s := NewDeviceStore(t.TempDir())
	if _, err := s.Add("short", []byte{1, 2, 3}, nil); err == nil {
		t.Fatal("accepted a non-32-byte key")
	}
	key := testKey(t)
	if _, err := s.Add("first", key, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Add("second", key, nil); err == nil {
		t.Fatal("accepted the same key twice")
	}
}

// TestDeviceIDVector pins the derivation — `hex(sha256(pubkey))[:12]` — to a
// known value. A device is addressed by this id everywhere it has a name (the
// web client's pinned-key records, log lines, revocation), so the derivation
// changing silently would rename every paired device at once.
//
// The key is the initiator static from testdata/noise/ik.json, so the same
// bytes already have a name elsewhere in the tree.
func TestDeviceIDVector(t *testing.T) {
	pub, err := hex.DecodeString("07c49831ace851c4c861ad4fa8bc850e18c6128731bdf5631076920bc1e89411")
	if err != nil {
		t.Fatal(err)
	}
	if got := DeviceID(pub); got != "b5d05f15398a" {
		t.Fatalf("DeviceID(ik.json initiator static) = %q, want %q", got, "b5d05f15398a")
	}
}

// TestFindByKeyComparesTheWholeKey: a device's identity is its 32 bytes, not
// the 48-bit digest they are labelled with.
//
// DeviceID is hex(sha256(key))[:12]. Matching a lookup on that alone means a
// second key with the same twelve hex characters — about 2^48 offline work,
// no interaction with the daemon, no rate limit — is accepted as the device
// that was actually paired, and in part 2 opens its handshake. So the store
// must compare the bytes, and the id must be a label rather than a credential.
func TestFindByKeyComparesTheWholeKey(t *testing.T) {
	dir := t.TempDir()
	s := NewDeviceStore(dir)

	paired := testKey(t)
	forged := testKey(t)
	// The collision, staged: the registry holds the paired device's key under
	// the id the forged key derives. A lookup that stops at the id finds it.
	writeRegistry(t, dir, []Device{planted(DeviceID(forged), paired)})

	got, ok, err := s.FindByKey(forged)
	if err != nil {
		t.Fatal(err)
	}
	if ok {
		t.Fatalf("FindByKey matched on the id alone, returning %+v", got)
	}

	// And the ordinary near-miss: a key that shares every byte but the last is
	// a different device, whatever its digest happens to be.
	near := slices.Clone(paired)
	near[len(near)-1] ^= 0xff
	if _, ok, err := s.FindByKey(near); err != nil {
		t.Fatal(err)
	} else if ok {
		t.Fatal("FindByKey matched a key that differs in its last byte")
	}

	// The positive, so none of the above passes by refusing everything: the
	// entry is found when the bytes are the ones it holds.
	writeRegistry(t, dir, []Device{planted(DeviceID(paired), paired)})
	if _, ok, err := s.FindByKey(paired); err != nil {
		t.Fatal(err)
	} else if !ok {
		t.Fatal("FindByKey missed the key the registry holds")
	}
}

// TestAddDecidesDuplicatesOnTheWholeKey: "already paired" is a claim about the
// key, so a fresh key that merely collides on the id is a new device.
func TestAddDecidesDuplicatesOnTheWholeKey(t *testing.T) {
	dir := t.TempDir()
	s := NewDeviceStore(dir)

	paired := testKey(t)
	fresh := testKey(t)
	writeRegistry(t, dir, []Device{planted(DeviceID(fresh), paired)})

	d, err := s.Add("second phone", fresh, nil)
	if err != nil {
		t.Fatalf("Add refused a key the registry does not hold: %v", err)
	}
	if !bytes.Equal(d.PublicKey, fresh) {
		t.Fatalf("Add stored %x, want the key it was given", d.PublicKey)
	}

	// The true duplicate is still refused, on the bytes.
	if _, err := s.Add("again", fresh, nil); err == nil {
		t.Fatal("Add accepted the same key twice")
	}
}

// TestUpdateLastSeen: the column the devices screen shows is only as truthful
// as the write behind it, and a device that is not there is not a failure —
// a connection may be stamping itself at the moment it is revoked.
func TestUpdateLastSeen(t *testing.T) {
	s := NewDeviceStore(t.TempDir())
	dev, err := s.Add("phone", testKey(t), nil)
	if err != nil {
		t.Fatal(err)
	}

	later := time.Now().Add(time.Hour).Truncate(time.Second)
	ok, err := s.UpdateLastSeen(dev.ID, later)
	if err != nil || !ok {
		t.Fatalf("UpdateLastSeen = %v, %v", ok, err)
	}

	list, err := s.List()
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 1 {
		t.Fatalf("registry = %+v, want the one device", list)
	}
	if !list[0].LastSeen.Equal(later) {
		t.Fatalf("LastSeen = %v, want %v", list[0].LastSeen, later)
	}
	// The stamp is the only thing that moved.
	if !list[0].PairedAt.Equal(dev.PairedAt) || !bytes.Equal(list[0].PublicKey, dev.PublicKey) {
		t.Fatalf("UpdateLastSeen rewrote the device: %+v, want %+v", list[0], dev)
	}

	if ok, err := s.UpdateLastSeen("000000000000", later); ok || err != nil {
		t.Fatalf("UpdateLastSeen of an unknown device = %v, %v, want false and no error", ok, err)
	}
}

// TestAddFromFleetCert: the fleet-admission write is idempotent — two
// channels racing the same new device both succeed on one entry — and the
// entry carries the cert, the cert's pairing time, and a fresh LastSeen.
func TestAddFromFleetCert(t *testing.T) {
	s := NewDeviceStore(t.TempDir())
	key := testKey(t)
	cert := []byte("a signed blob, opaque to this package")
	pairedAt := time.Now().Add(-24 * time.Hour).Truncate(time.Second)

	d, err := s.AddFromFleetCert("attic phone", key, cert, pairedAt)
	if err != nil {
		t.Fatal(err)
	}
	if d.Label != "attic phone" || !bytes.Equal(d.Cert, cert) || !d.PairedAt.Equal(pairedAt) {
		t.Fatalf("admitted device = %+v", d)
	}
	if !d.LastSeen.After(pairedAt) {
		t.Fatalf("LastSeen = %v, want now rather than the cert's iat", d.LastSeen)
	}

	// Again, with a different label: the existing entry wins, untouched.
	again, err := s.AddFromFleetCert("someone renamed it", key, []byte("another blob"), time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if again.Label != "attic phone" || !bytes.Equal(again.Cert, cert) {
		t.Fatalf("a second admission rewrote the entry: %+v", again)
	}
	if list, _ := s.List(); len(list) != 1 {
		t.Fatalf("registry holds %d entries, want 1", len(list))
	}
}

// TestRevocationOutranksTheCert is the spec's precedence rule at the store:
// a revoked key is refused by AddFromFleetCert however fresh the cert that
// presents it, because the check is set membership and never a timestamp.
func TestRevocationOutranksTheCert(t *testing.T) {
	s := NewDeviceStore(t.TempDir())
	key := testKey(t)

	if err := s.AddRevocation(key, []byte("signed revocation")); err != nil {
		t.Fatal(err)
	}
	if revoked, err := s.IsRevoked(key); err != nil || !revoked {
		t.Fatalf("IsRevoked = %v, %v", revoked, err)
	}
	if _, err := s.AddFromFleetCert("it's back", key, []byte("a newer cert"), time.Now()); !errors.Is(err, ErrDeviceRevoked) {
		t.Fatalf("AddFromFleetCert on a revoked key = %v, want ErrDeviceRevoked", err)
	}
	if list, _ := s.List(); len(list) != 0 {
		t.Fatalf("the revoked key reached the registry: %+v", list)
	}

	// A different key is unaffected, and Add — this machine's own ceremony —
	// deliberately is too: rule 1 of the acceptance order is "pairing on this
	// machine works as before". What that leaves is not free, and the old
	// note here claimed otherwise ("a fresh ceremony mints a fresh key
	// anyway" — it does not; web/src/crypto/keys.ts reuses the key in
	// IndexedDB across pairings). So an operator who revokes a device and
	// then re-pairs the same browser gets an entry FindByKey refuses: paired
	// on the screen, closed on the wire. Deciding that — Add refusing, or a
	// deliberate re-pairing clearing the revocation — is a design call about
	// what un-revoking means, and it is open.
	other := testKey(t)
	if revoked, err := s.IsRevoked(other); err != nil || revoked {
		t.Fatalf("IsRevoked(other) = %v, %v", revoked, err)
	}

	// Recording the same key again is one entry, and the set survives a
	// fresh store over the same directory.
	if err := s.AddRevocation(key, []byte("recorded twice")); err != nil {
		t.Fatal(err)
	}
	revs, err := NewDeviceStore(filepath.Dir(s.revocationsPath())).Revocations()
	if err != nil {
		t.Fatal(err)
	}
	if len(revs) != 1 || !bytes.Equal(revs[0].PublicKey, key) || string(revs[0].Cert) != "signed revocation" {
		t.Fatalf("revocations = %+v, want the one original entry", revs)
	}
}

// TestFindByKeyRefusesARevokedKey: the store's answer to "is this key one we
// paired" has to account for the revocation list, because the two files are
// written in a fixed order and the window between them is real. Revoking
// records the signed revocation first and removes the registry entry second
// (daemon.removeDevice), on the grounds that the first write is what kills
// the key — and that only holds if every acceptance path reads it.
//
// The error direction matters as much as the answer: an unreadable
// revocation list is a refusal, not a shrug, because a caller that cannot
// know must not admit.
func TestFindByKeyRefusesARevokedKey(t *testing.T) {
	s := NewDeviceStore(t.TempDir())
	key := testKey(t)
	d, err := s.Add("phone", key, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok, err := s.FindByKey(key); err != nil || !ok {
		t.Fatalf("FindByKey before the revoke = %v, %v", ok, err)
	}

	// Exactly the state a revoke leaves when its second write fails: the
	// revocation is on file and the entry is still listed.
	if err := s.AddRevocation(key, []byte("signed revocation")); err != nil {
		t.Fatal(err)
	}
	if list, _ := s.List(); len(list) != 1 || list[0].ID != d.ID {
		t.Fatalf("registry = %+v; this test needs the entry still there", list)
	}
	if got, ok, err := s.FindByKey(key); err != nil || ok {
		t.Fatalf("FindByKey on a revoked but still-listed key = %+v, %v, %v; want no match", got, ok, err)
	}

	// An unreadable list refuses rather than falls back to the registry.
	if err := os.WriteFile(s.revocationsPath(), []byte("{not a list"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, ok, err := s.FindByKey(key); err == nil || ok {
		t.Fatalf("FindByKey with an unreadable revocation list = %v, %v; want an error and no match", ok, err)
	}
}

func TestFindByID(t *testing.T) {
	s := NewDeviceStore(t.TempDir())
	d, err := s.Add("phone", testKey(t), nil)
	if err != nil {
		t.Fatal(err)
	}
	got, ok, err := s.FindByID(d.ID)
	if err != nil || !ok || got.ID != d.ID {
		t.Fatalf("FindByID = %+v, %v, %v", got, ok, err)
	}
	if _, ok, err := s.FindByID("000000000000"); err != nil || ok {
		t.Fatalf("FindByID of an unknown id = %v, %v, want false and no error", ok, err)
	}
}

func TestDeviceStoreRemove(t *testing.T) {
	s := NewDeviceStore(t.TempDir())
	d, err := s.Add("phone", testKey(t), nil)
	if err != nil {
		t.Fatal(err)
	}
	removed, ok, err := s.Remove(d.ID)
	if err != nil || !ok || removed.ID != d.ID {
		t.Fatalf("Remove = %+v, %v, %v", removed, ok, err)
	}
	if _, ok, _ := s.FindByKey(d.PublicKey); ok {
		t.Fatal("removed device still findable")
	}
	if _, ok, _ = s.Remove(d.ID); ok {
		t.Fatal("second remove reported success")
	}
}

// TestRemoveByKeyComparesTheWholeKey is FindByKey's argument applied to the
// other direction. RemoveByKey is what a fleet revocation reaches — the caller
// holds 32 bytes off a signed blob — and matching on the id would let a key
// ground out to collide with a paired device's digest unpair *that* device.
//
// The blob is signed, so this is not an attack any stranger can mount; it is
// an attack one fleet member can mount on another's registry, and the whole
// point of the fleet key is that its holders are the operator's own machines
// rather than the operator's own devices.
func TestRemoveByKeyComparesTheWholeKey(t *testing.T) {
	dir := t.TempDir()
	s := NewDeviceStore(dir)

	paired := testKey(t)
	forged := testKey(t)
	// The registry holds the paired device's key under the id the forged key
	// derives: a removal that stops at the id would take it.
	writeRegistry(t, dir, []Device{planted(DeviceID(forged), paired)})

	if got, ok, err := s.RemoveByKey(forged); err != nil {
		t.Fatal(err)
	} else if ok {
		t.Fatalf("RemoveByKey unpaired a device on an id collision: %+v", got)
	}
	if list, err := s.List(); err != nil || len(list) != 1 {
		t.Fatalf("registry = %+v, %v after a refused removal, want the device untouched", list, err)
	}

	// The positive, so the above is not passing by refusing everything.
	got, ok, err := s.RemoveByKey(paired)
	if err != nil || !ok {
		t.Fatalf("RemoveByKey(paired) = %+v, %v, %v; want the entry it holds", got, ok, err)
	}
	if list, err := s.List(); err != nil || len(list) != 0 {
		t.Fatalf("registry = %+v, %v after the removal, want empty", list, err)
	}

	// And missing is not an error: a revocation for a device this machine
	// never paired is the common case in a fleet, and it arrives again on
	// every reconnect.
	if _, ok, err := s.RemoveByKey(paired); err != nil || ok {
		t.Fatalf("RemoveByKey of an absent key = %v, %v; want false and no error", ok, err)
	}
}
