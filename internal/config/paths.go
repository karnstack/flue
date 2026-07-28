// Package config locates and manages flue's on-disk configuration,
// including the loopback authentication token.
package config

import (
	"crypto/rand"
	"encoding/hex"
	"os"
	"path/filepath"
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

	if b, err := os.ReadFile(path); err == nil {
		if tok := strings.TrimSpace(string(b)); tok != "" {
			// Same reasoning as Dir: an existing file's permissions are
			// not something we control, so re-assert 0600 before trusting
			// its contents as a secret.
			if err := os.Chmod(path, 0o600); err != nil {
				return "", err
			}
			return tok, nil
		}
	}

	var raw [32]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return "", err
	}
	tok := hex.EncodeToString(raw[:])
	if err := os.WriteFile(path, []byte(tok), 0o600); err != nil {
		return "", err
	}
	return tok, nil
}
