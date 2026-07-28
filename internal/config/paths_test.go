package config

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestDirCreatesConfigDirWithRestrictedMode(t *testing.T) {
	base := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", base)

	dir, err := Dir()
	if err != nil {
		t.Fatalf("Dir: %v", err)
	}
	if want := filepath.Join(base, "flue"); dir != want {
		t.Fatalf("Dir = %q, want %q", dir, want)
	}

	info, err := os.Stat(dir)
	if err != nil {
		t.Fatalf("Stat: %v", err)
	}
	if !info.IsDir() {
		t.Fatal("Dir did not create a directory")
	}
	if runtime.GOOS != "windows" {
		if mode := info.Mode().Perm(); mode != 0o700 {
			t.Errorf("dir mode = %o, want 0700", mode)
		}
	}
}

func TestDirTightensPreExistingLoosePermissions(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("unix permission bits only")
	}
	base := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", base)

	dir := filepath.Join(base, "flue")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("pre-create dir: %v", err)
	}

	if _, err := Dir(); err != nil {
		t.Fatalf("Dir: %v", err)
	}

	info, err := os.Stat(dir)
	if err != nil {
		t.Fatalf("Stat: %v", err)
	}
	if mode := info.Mode().Perm(); mode != 0o700 {
		t.Errorf("dir mode = %o, want 0700 (Dir must tighten pre-existing loose permissions)", mode)
	}
}

func TestLoadOrCreateTokenGeneratesAndPersists(t *testing.T) {
	base := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", base)

	tok1, err := LoadOrCreateToken()
	if err != nil {
		t.Fatalf("LoadOrCreateToken: %v", err)
	}
	if len(tok1) != 64 { // 32 random bytes, hex-encoded
		t.Errorf("len(token) = %d, want 64", len(tok1))
	}

	path := filepath.Join(base, "flue", "token")
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("Stat token file: %v", err)
	}
	if runtime.GOOS != "windows" {
		if mode := info.Mode().Perm(); mode != 0o600 {
			t.Errorf("token file mode = %o, want 0600", mode)
		}
	}

	tok2, err := LoadOrCreateToken()
	if err != nil {
		t.Fatalf("LoadOrCreateToken (second call): %v", err)
	}
	if tok1 != tok2 {
		t.Errorf("token changed across calls: %q != %q, want persisted", tok1, tok2)
	}
}

func TestLoadOrCreateTokenRegeneratesWhenFileIsEmpty(t *testing.T) {
	base := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", base)

	dir := filepath.Join(base, "flue")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	path := filepath.Join(dir, "token")
	// Pre-created at 0644, not 0600: os.WriteFile only applies its mode
	// argument when it creates a file. The empty-content regeneration
	// path below truncates and rewrites this file in place, so without an
	// explicit chmod after that write, the freshly generated secret would
	// be persisted at this looser, pre-existing mode.
	if err := os.WriteFile(path, []byte("  \n"), 0o644); err != nil {
		t.Fatalf("write empty token file: %v", err)
	}

	tok, err := LoadOrCreateToken()
	if err != nil {
		t.Fatalf("LoadOrCreateToken: %v", err)
	}
	if tok == "" {
		t.Fatal("LoadOrCreateToken returned empty token for a blank token file")
	}
	if len(tok) != 64 {
		t.Errorf("len(token) = %d, want 64", len(tok))
	}

	if runtime.GOOS != "windows" {
		info, err := os.Stat(path)
		if err != nil {
			t.Fatalf("Stat: %v", err)
		}
		if mode := info.Mode().Perm(); mode != 0o600 {
			t.Errorf("token file mode = %o, want 0600 (regenerating over a pre-existing file must not leave its old, looser mode in place)", mode)
		}
	}
}

func TestLoadOrCreateTokenRegeneratesOnLoosePreExistingPermissions(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("unix permission bits only")
	}
	base := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", base)

	dir := filepath.Join(base, "flue")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	path := filepath.Join(dir, "token")
	const stale = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef"
	if err := os.WriteFile(path, []byte(stale), 0o644); err != nil {
		t.Fatalf("pre-create token file: %v", err)
	}

	tok, err := LoadOrCreateToken()
	if err != nil {
		t.Fatalf("LoadOrCreateToken: %v", err)
	}
	// A loose mode is evidence the old secret may already have been
	// exposed to another local user or process. LoadOrCreateToken must
	// not keep trusting it — it must discard it and mint a new one, not
	// just tighten the mode on an already-exposed value.
	if tok == stale {
		t.Fatal("LoadOrCreateToken returned the pre-existing token unchanged despite its loose permissions, want a freshly generated token")
	}
	if len(tok) != 64 {
		t.Errorf("len(token) = %d, want 64", len(tok))
	}

	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("Stat: %v", err)
	}
	if mode := info.Mode().Perm(); mode != 0o600 {
		t.Errorf("token file mode = %o, want 0600", mode)
	}

	tok2, err := LoadOrCreateToken()
	if err != nil {
		t.Fatalf("LoadOrCreateToken (second call): %v", err)
	}
	if tok2 != tok {
		t.Errorf("token changed across calls after regeneration: %q != %q, want persisted", tok, tok2)
	}
}

func TestDirFallsBackToHomeConfig(t *testing.T) {
	home := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", "")
	t.Setenv("HOME", home)

	dir, err := Dir()
	if err != nil {
		t.Fatalf("Dir: %v", err)
	}
	if want := filepath.Join(home, ".config", "flue"); dir != want {
		t.Fatalf("Dir = %q, want %q", dir, want)
	}
}
