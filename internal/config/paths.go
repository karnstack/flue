// Package config locates and manages flue's on-disk configuration,
// including the loopback authentication token.
package config

import (
	"crypto/rand"
	"encoding/hex"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

// Dir returns the flue config directory, creating it if needed.
func Dir() (string, error) {
	base := os.Getenv("XDG_CONFIG_HOME")
	if base == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", err
		}
		base = filepath.Join(home, ".config")
	}
	dir := filepath.Join(base, "flue")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", err
	}
	// MkdirAll only applies the mode to directories it creates; it leaves
	// a pre-existing directory's permissions untouched. Enforce 0700
	// unconditionally so a looser mode left behind by an old version, a
	// backup/restore tool, or a manual mkdir can't widen access to the
	// token file this directory holds.
	if err := os.Chmod(dir, 0o700); err != nil {
		return "", err
	}
	return dir, nil
}

// LoadOrCreateToken returns the daemon's loopback token, generating and
// persisting one at mode 0600 on first use.
func LoadOrCreateToken() (string, error) {
	dir, err := Dir()
	if err != nil {
		return "", err
	}
	path := filepath.Join(dir, "token")

	if tok, ok := readExistingToken(path); ok {
		return tok, nil
	}

	var raw [32]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return "", err
	}
	tok := hex.EncodeToString(raw[:])
	if err := os.WriteFile(path, []byte(tok), 0o600); err != nil {
		return "", err
	}
	// os.WriteFile only applies its mode argument when it creates the
	// file; if path already existed (blank content, or the loose-mode
	// case readExistingToken just rejected) it truncates in place and
	// leaves whatever mode was already there. Chmod explicitly so a
	// freshly generated secret is never persisted at a looser mode than
	// the one it's replacing.
	if err := os.Chmod(path, 0o600); err != nil {
		return "", err
	}
	return tok, nil
}

// readExistingToken returns the token stored at path, but only if it's
// safe to trust: non-blank content, and — where the platform's permission
// bits are meaningful — stored at exactly 0600. A looser mode is treated
// exactly like blank content: not fixed in place, but discarded. A loose
// mode is positive evidence the secret may already have been readable by
// another local user or process (a stray chmod, a backup/sync tool, a
// migration from an older version); silently tightening the mode and
// continuing to trust the same token would make the daemon look secure
// while it kept using a known-exposed credential, and it would erase the
// only signal a user could ever have noticed. Regenerating costs one
// invalidated browser session.
func readExistingToken(path string) (tok string, ok bool) {
	b, err := os.ReadFile(path)
	if err != nil {
		return "", false
	}
	tok = strings.TrimSpace(string(b))
	if tok == "" {
		return "", false
	}
	if runtime.GOOS != "windows" {
		info, err := os.Stat(path)
		if err != nil || info.Mode().Perm() != 0o600 {
			return "", false
		}
	}
	return tok, true
}
