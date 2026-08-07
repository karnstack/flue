package crypto

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
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
	d, err := s.Add("karn's phone", key)
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
	if _, err := s.Add("short", []byte{1, 2, 3}); err == nil {
		t.Fatal("accepted a non-32-byte key")
	}
	key := testKey(t)
	if _, err := s.Add("first", key); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Add("second", key); err == nil {
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

	d, err := s.Add("second phone", fresh)
	if err != nil {
		t.Fatalf("Add refused a key the registry does not hold: %v", err)
	}
	if !bytes.Equal(d.PublicKey, fresh) {
		t.Fatalf("Add stored %x, want the key it was given", d.PublicKey)
	}

	// The true duplicate is still refused, on the bytes.
	if _, err := s.Add("again", fresh); err == nil {
		t.Fatal("Add accepted the same key twice")
	}
}

// TestUpdateLastSeen: the column the devices screen shows is only as truthful
// as the write behind it, and a device that is not there is not a failure —
// a connection may be stamping itself at the moment it is revoked.
func TestUpdateLastSeen(t *testing.T) {
	s := NewDeviceStore(t.TempDir())
	dev, err := s.Add("phone", testKey(t))
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

func TestDeviceStoreRemove(t *testing.T) {
	s := NewDeviceStore(t.TempDir())
	d, err := s.Add("phone", testKey(t))
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
