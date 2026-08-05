package crypto

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"sync"
	"time"
)

type Device struct {
	ID        string    `json:"id"`
	Label     string    `json:"label"`
	PublicKey []byte    `json:"publicKey"`
	PairedAt  time.Time `json:"pairedAt"`
	LastSeen  time.Time `json:"lastSeen"`
}

// DeviceID derives the identity from the key itself, so an entry cannot
// claim to be a key it does not hold.
func DeviceID(publicKey []byte) string {
	sum := sha256.Sum256(publicKey)
	return hex.EncodeToString(sum[:])[:12]
}

// DeviceStore is the paired-device registry: devices.json in the config
// dir, 0600, re-read under the lock on every call so concurrent daemon
// paths (pairing, revocation, the devices op) serialize on the file's truth.
type DeviceStore struct {
	mu   sync.Mutex
	path string
}

func NewDeviceStore(configDir string) *DeviceStore {
	return &DeviceStore{path: filepath.Join(configDir, "devices.json")}
}

func (s *DeviceStore) load() ([]Device, error) {
	raw, err := os.ReadFile(s.path)
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var out []Device
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, fmt.Errorf("crypto: %s is not a device registry: %w", s.path, err)
	}
	return out, nil
}

func (s *DeviceStore) save(devices []Device) error {
	blob, err := json.MarshalIndent(devices, "", "  ")
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(s.path), "devices.json.*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if err := tmp.Chmod(0o600); err != nil {
		tmp.Close()
		return err
	}
	if _, err := tmp.Write(blob); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), s.path)
}

func (s *DeviceStore) List() ([]Device, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.load()
}

func (s *DeviceStore) Add(label string, publicKey []byte) (Device, error) {
	if len(publicKey) != 32 {
		return Device{}, fmt.Errorf("crypto: device key must be 32 bytes, got %d", len(publicKey))
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	devices, err := s.load()
	if err != nil {
		return Device{}, err
	}
	id := DeviceID(publicKey)
	// On the bytes, not on the id. The id is a 48-bit digest of the key — a
	// label for people and for URLs — so deciding "already paired" from it
	// would refuse a genuinely new device that happened to collide, and would
	// tell whoever ground the collision out that they had found one.
	for _, d := range devices {
		if bytes.Equal(d.PublicKey, publicKey) {
			return Device{}, fmt.Errorf("crypto: device %s is already paired", d.ID)
		}
	}
	now := time.Now().UTC()
	d := Device{ID: id, Label: label, PublicKey: slices.Clone(publicKey), PairedAt: now, LastSeen: now}
	if err := s.save(append(devices, d)); err != nil {
		return Device{}, err
	}
	return d, nil
}

func (s *DeviceStore) Remove(id string) (Device, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	devices, err := s.load()
	if err != nil {
		return Device{}, false, err
	}
	for i, d := range devices {
		if d.ID == id {
			if err := s.save(slices.Delete(devices, i, i+1)); err != nil {
				return Device{}, false, err
			}
			return d, true, nil
		}
	}
	return Device{}, false, nil
}

// UpdateLastSeen stamps the device's LastSeen to now, reporting whether the
// device exists. Missing devices are not an error: a connection may race its
// own revocation, and the registry is the truth either way — a device that was
// unpaired a moment ago is not brought back by having connected.
//
// The whole file is rewritten, like every other mutation here, because that is
// what makes a concurrent revoke and a concurrent stamp serialise on the same
// lock rather than on two partial views of the same JSON.
func (s *DeviceStore) UpdateLastSeen(id string, now time.Time) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	devices, err := s.load()
	if err != nil {
		return false, err
	}
	for i := range devices {
		if devices[i].ID != id {
			continue
		}
		devices[i].LastSeen = now.UTC()
		// True with the error: the device is there, and the caller's own
		// question — "was there one to stamp" — is answered whether or not the
		// write landed.
		return true, s.save(devices)
	}
	return false, nil
}

func (s *DeviceStore) FindByKey(publicKey []byte) (Device, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	devices, err := s.load()
	if err != nil {
		return Device{}, false, err
	}
	id := DeviceID(publicKey)
	// Both halves, and the bytes are the load-bearing one. DeviceID is
	// hex(sha256(key))[:12] — 48 bits — so a lookup that matched on it alone
	// would accept any key ground out to collide with a paired device's digest,
	// which is offline work against a fixed target with nothing to rate-limit
	// it. That key would then pass as the paired device at every caller of this
	// function, including the handshake. The id is compared first because it is
	// a cheap reject, not because it decides anything.
	for _, d := range devices {
		if d.ID == id && bytes.Equal(d.PublicKey, publicKey) {
			return d, true, nil
		}
	}
	return Device{}, false, nil
}
