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
	if err := writeSecretAtomically(dir, path, []byte(tok)); err != nil {
		return "", err
	}
	return tok, nil
}

// writeSecretAtomically replaces path's contents with b without ever
// writing through path's existing inode. It is the one write path for every
// secret this package persists — the loopback token and the relay
// configuration — so neither can drift from the guarantees below.
//
// Two reasons:
//
//  1. Unix permission checks happen at open, not at read. If path already
//     existed at a loose mode (blank content, or the exposed-secret case
//     readExistingToken just rejected) and some other local process had
//     already opened it and kept the descriptor open, an in-place
//     truncate+write would hand that process the brand-new secret on its
//     next read through the retained descriptor — regardless of when the
//     regeneration happened. Landing the replacement on a fresh inode and
//     renaming it over path leaves any such retained descriptor pointing
//     at the old (now-unlinked) file instead.
//  2. os.WriteFile only applies its mode argument when it creates a file;
//     truncating an existing one in place would leave the new secret at
//     the old file's mode until a separate chmod call catches up — a real
//     window where the secret sits on disk world- or group-readable.
//     os.CreateTemp creates its file at 0600 from the start, so there's
//     no window at all.
//
// The rename is also atomic, so a crash mid-write can't leave a truncated
// or empty file where a complete one was.
//
// The temp file is named after its destination so a crash between create and
// rename leaves something whoever finds it can identify.
func writeSecretAtomically(dir, path string, b []byte) error {
	tmp, err := os.CreateTemp(dir, filepath.Base(path)+"-*.tmp")
	if err != nil {
		return err
	}
	tmpPath := tmp.Name()
	defer os.Remove(tmpPath) // no-op once the rename below has succeeded

	if _, err := tmp.Write(b); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmpPath, path)
}

// readExistingToken returns the token stored at path, but only if it's
// safe to trust: non-blank content, and — where the platform's permission
// bits are meaningful — no group or other access bit set. A mode with any
// of those bits (0644, 0640, 0666, ...) is treated exactly like blank
// content: not fixed in place, but discarded. A loose mode is positive
// evidence the secret may already have been readable by another local
// user or process (a stray chmod, a backup/sync tool, a migration from an
// older version); silently tightening the mode and continuing to trust
// the same token would make the daemon look secure while it kept using a
// known-exposed credential, and it would erase the only signal a user
// could ever have noticed. Regenerating costs one invalidated browser
// session.
//
// A mode stricter than 0600 (0400, 0000, ...) is not evidence of anything
// and must be accepted as-is: it's a plausible deliberate hardening (a
// config-management rule, a manual chmod), and rejecting it would send
// the caller into the regeneration path, which then fails outright trying
// to overwrite a file the owner can't even open for writing.
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
		if err != nil || info.Mode().Perm()&0o077 != 0 {
			return "", false
		}
	}
	return tok, true
}
