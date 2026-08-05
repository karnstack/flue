package crypto

import (
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
	for _, d := range devices {
		if d.ID == id {
			return Device{}, fmt.Errorf("crypto: device %s is already paired", id)
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

func (s *DeviceStore) FindByKey(publicKey []byte) (Device, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	devices, err := s.load()
	if err != nil {
		return Device{}, false, err
	}
	id := DeviceID(publicKey)
	for _, d := range devices {
		if d.ID == id {
			return d, true, nil
		}
	}
	return Device{}, false, nil
}
