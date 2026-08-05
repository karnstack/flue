package crypto

import (
	"bytes"
	"crypto/rand"
	"os"
	"path/filepath"
	"testing"
)

func testKey(t *testing.T) []byte {
	t.Helper()
	k := make([]byte, 32)
	if _, err := rand.Read(k); err != nil {
		t.Fatal(err)
	}
	return k
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
