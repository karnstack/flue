package crypto

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestLoadOrCreateStaticKey(t *testing.T) {
	dir := t.TempDir()

	k1, err := LoadOrCreateStaticKey(dir)
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if len(k1.Public) != 32 || len(k1.Private) != 32 {
		t.Fatalf("key lengths = %d/%d, want 32/32", len(k1.Public), len(k1.Private))
	}

	info, err := os.Stat(filepath.Join(dir, "keys", "static.key"))
	if err != nil {
		t.Fatalf("stat: %v", err)
	}
	if got := info.Mode().Perm(); got != 0o600 {
		t.Fatalf("key file mode = %o, want 600", got)
	}

	// A second load returns the same key, not a fresh one.
	k2, err := LoadOrCreateStaticKey(dir)
	if err != nil {
		t.Fatalf("reload: %v", err)
	}
	if string(k2.Private) != string(k1.Private) || string(k2.Public) != string(k1.Public) {
		t.Fatal("reload returned a different key")
	}
}

func TestCorruptKeyFileIsAnErrorNotARegenerate(t *testing.T) {
	// Regenerating the static key would invalidate every pairing, so a
	// corrupt file must surface, never be papered over.
	dir := t.TempDir()
	if _, err := LoadOrCreateStaticKey(dir); err != nil {
		t.Fatalf("create: %v", err)
	}
	path := filepath.Join(dir, "keys", "static.key")
	if err := os.WriteFile(path, []byte("not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadOrCreateStaticKey(dir); err == nil {
		t.Fatal("corrupt key file loaded without error")
	}
	// And a structurally valid file with a wrong-length key is equally fatal.
	blob, _ := json.Marshal(map[string]string{"public": "AAAA", "private": "AAAA"})
	if err := os.WriteFile(path, blob, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadOrCreateStaticKey(dir); err == nil {
		t.Fatal("truncated key loaded without error")
	}
}
