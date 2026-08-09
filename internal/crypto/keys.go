// Package crypto owns flue's Noise IK handshake, the secure channel framing,
// and the key material on the daemon side. Pure: no HTTP, no WebSockets, no
// knowledge of sessions or transports.
package crypto

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"

	"github.com/flynn/noise"
)

// Suite is the one cipher suite flue speaks: Noise_IK_25519_ChaChaPoly_SHA256.
func Suite() noise.CipherSuite {
	return noise.NewCipherSuite(noise.DH25519, noise.CipherChaChaPoly, noise.HashSHA256)
}

type keyFile struct {
	Public  string `json:"public"`
	Private string `json:"private"`
}

// LoadOrCreateStaticKey returns the daemon's static keypair, creating it on
// first run. A file that exists but cannot be parsed is an error, never a
// regenerate: a fresh key would silently invalidate every pairing.
func LoadOrCreateStaticKey(configDir string) (noise.DHKey, error) {
	dir := filepath.Join(configDir, "keys")
	path := filepath.Join(dir, "static.key")

	if raw, err := os.ReadFile(path); err == nil {
		var kf keyFile
		if err := json.Unmarshal(raw, &kf); err != nil {
			return noise.DHKey{}, fmt.Errorf("crypto: %s is not a key file: %w", path, err)
		}
		pub, err := base64.StdEncoding.DecodeString(kf.Public)
		if err != nil {
			return noise.DHKey{}, fmt.Errorf("crypto: %s public key: %w", path, err)
		}
		priv, err := base64.StdEncoding.DecodeString(kf.Private)
		if err != nil {
			return noise.DHKey{}, fmt.Errorf("crypto: %s private key: %w", path, err)
		}
		if len(pub) != 32 || len(priv) != 32 {
			return noise.DHKey{}, fmt.Errorf("crypto: %s holds a malformed key", path)
		}
		return noise.DHKey{Public: pub, Private: priv}, nil
	} else if !os.IsNotExist(err) {
		return noise.DHKey{}, err
	}

	key, err := Suite().GenerateKeypair(rand.Reader)
	if err != nil {
		return noise.DHKey{}, err
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return noise.DHKey{}, err
	}
	blob, err := json.Marshal(keyFile{
		Public:  base64.StdEncoding.EncodeToString(key.Public),
		Private: base64.StdEncoding.EncodeToString(key.Private),
	})
	if err != nil {
		return noise.DHKey{}, err
	}
	// CreateTemp+rename in the same directory, so a crash never leaves a
	// half-written key. Same shape as config.writeSecretAtomically; a third
	// copy of the pattern — FOLLOW-UPS item 6 already tracks the dedupe.
	tmp, err := os.CreateTemp(dir, "static.key.*")
	if err != nil {
		return noise.DHKey{}, err
	}
	defer os.Remove(tmp.Name())
	if err := tmp.Chmod(0o600); err != nil {
		tmp.Close()
		return noise.DHKey{}, err
	}
	if _, err := tmp.Write(blob); err != nil {
		tmp.Close()
		return noise.DHKey{}, err
	}
	// Flushed to the disk before the rename publishes it. A rename is atomic
	// with respect to other processes, but not with respect to power loss: the
	// directory entry can reach the disk before the data blocks it points at,
	// which leaves a zero-length file where a complete one used to be.
	//
	// For this file that is the worst state there is: a zero-length static.key
	// is unparseable, unparseable is a refusal to start (never a regenerate —
	// see above), and the daemon stays down until someone deletes the file by
	// hand, after which every paired device must re-pair.
	//
	// The directory entry itself is deliberately not fsynced, matching
	// config.writeSecretAtomically. Losing the rename is the acceptable
	// failure — the next start finds no file and generates a fresh key on its
	// own, so the daemon comes up without help.
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return noise.DHKey{}, err
	}
	if err := tmp.Close(); err != nil {
		return noise.DHKey{}, err
	}
	if err := os.Rename(tmp.Name(), path); err != nil {
		return noise.DHKey{}, err
	}
	return key, nil
}
