package crypto

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
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

	// Cert is the fleet device certificate for this key — the signed blob
	// exactly as internal/fleet produces it — when there is one: minted by
	// this machine's own pairing ceremony, or presented by the device in
	// its handshake after pairing elsewhere (spec/fleet-trust.md). Opaque
	// to this package, kept so the machine can hand the cert onward — the
	// fleet directory will publish it — and empty for devices paired
	// before the fleet key existed.
	Cert []byte `json:"cert,omitempty"`
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
	return s.writeFileLocked(s.path, blob)
}

// writeFileLocked writes one registry file atomically at 0600. Callers hold
// s.mu; the name says so.
func (s *DeviceStore) writeFileLocked(path string, blob []byte) error {
	tmp, err := os.CreateTemp(filepath.Dir(path), filepath.Base(path)+".*")
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
	// Flushed to the disk before the rename publishes it. A rename is atomic
	// with respect to other processes, but not with respect to power loss: the
	// directory entry can reach the disk before the data blocks it points at,
	// which leaves a zero-length file where a complete one used to be.
	//
	// A zero-length devices.json is not an empty registry: load rejects it as
	// unparseable, so every relayed device is refused as unpaired while the
	// record of who was paired is unreadable.
	//
	// The directory entry itself is deliberately not fsynced, matching
	// config.writeSecretAtomically. Losing the rename is the acceptable
	// failure — the registry simply still holds what it held before this
	// mutation.
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), path)
}

func (s *DeviceStore) List() ([]Device, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.load()
}

// Add registers a freshly paired device. cert is its fleet device
// certificate — nil on a daemon with no fleet key, which pairs exactly as it
// always did.
func (s *DeviceStore) Add(label string, publicKey, cert []byte) (Device, error) {
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
	d := Device{ID: id, Label: label, PublicKey: slices.Clone(publicKey), PairedAt: now, LastSeen: now, Cert: slices.Clone(cert)}
	if err := s.save(append(devices, d)); err != nil {
		return Device{}, err
	}
	return d, nil
}

// ErrDeviceRevoked is AddFromFleetCert refusing a key on the revocation
// list. A revocation permanently outranks a device cert for the same key,
// whatever either one's timestamp says (spec/fleet-trust.md): the check is
// membership, never a time comparison, and it happens in the same critical
// section as the add so a concurrent revoke cannot slip between them.
var ErrDeviceRevoked = errors.New("crypto: this device key is revoked")

// AddFromFleetCert registers a device this machine never paired itself — it
// arrived with a fleet certificate another machine's ceremony minted — and
// is what makes the Devices screen show it and LastSeen work.
//
// It is idempotent where Add is not: two channels racing the same new
// device both succeed, the second finding the entry the first wrote. That
// is the honest semantic — "make sure this certified key is registered" —
// where Add's is "record the ceremony that just happened", which must never
// happen twice. An existing entry is returned untouched, label and cert
// included: the registry is this machine's record, and a reconnect is not
// an edit.
//
// pairedAt is the cert's iat — when the device joined the fleet, which is
// the fact the column shows — while LastSeen starts now.
func (s *DeviceStore) AddFromFleetCert(label string, publicKey, cert []byte, pairedAt time.Time) (Device, error) {
	if len(publicKey) != 32 {
		return Device{}, fmt.Errorf("crypto: device key must be 32 bytes, got %d", len(publicKey))
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if revoked, err := s.isRevokedLocked(publicKey); err != nil {
		return Device{}, err
	} else if revoked {
		return Device{}, ErrDeviceRevoked
	}
	devices, err := s.load()
	if err != nil {
		return Device{}, err
	}
	for _, d := range devices {
		if bytes.Equal(d.PublicKey, publicKey) {
			return d, nil
		}
	}
	d := Device{
		ID:        DeviceID(publicKey),
		Label:     label,
		PublicKey: slices.Clone(publicKey),
		PairedAt:  pairedAt.UTC(),
		LastSeen:  time.Now().UTC(),
		Cert:      slices.Clone(cert),
	}
	if err := s.save(append(devices, d)); err != nil {
		return Device{}, err
	}
	return d, nil
}

// RemoveByKey unpairs whichever device holds publicKey, reporting whether
// there was one. Missing is not an error: it is the ordinary answer for a
// revocation that arrived from the fleet directory naming a device this
// machine never paired, and for the second delivery of one it did.
//
// By key rather than by id, unlike Remove, because its caller holds the key
// and the id is a 48-bit digest of it (DeviceID). Removing by id would let a
// key ground out to collide with a paired device's digest unpair that device
// — the mirror of the attack FindByKey's byte comparison exists to refuse —
// and here the attacker's blob has already been checked for a fleet signature,
// so the only thing standing between a hostile *fleet member* and unpairing
// someone else's device is this comparison being on the bytes.
func (s *DeviceStore) RemoveByKey(publicKey []byte) (Device, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	devices, err := s.load()
	if err != nil {
		return Device{}, false, err
	}
	for i, d := range devices {
		if !bytes.Equal(d.PublicKey, publicKey) {
			continue
		}
		if err := s.save(slices.Delete(devices, i, i+1)); err != nil {
			return Device{}, false, err
		}
		return d, true, nil
	}
	return Device{}, false, nil
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

// FindByID looks a device up by its display identity — what the revocation
// path holds — without changing anything.
func (s *DeviceStore) FindByID(id string) (Device, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	devices, err := s.load()
	if err != nil {
		return Device{}, false, err
	}
	for _, d := range devices {
		if d.ID == id {
			return d, true, nil
		}
	}
	return Device{}, false, nil
}

// FindByKey answers the acceptance rule's first question (spec/fleet-trust.md):
// is this static key one this machine paired, and still paired?
//
// A key on the revocation list is never a yes, whatever devices.json still
// says — and the two questions are one call, under one lock, for the reason
// AddFromFleetCert checks revocation inside the same critical section as its
// write. Revoking is two writes in a fixed order (daemon.removeDevice): the
// signed revocation first, the registry entry second. A revoke that landed
// the first and failed the second leaves an entry here that must not be
// honoured, and a caller that asked the two questions separately would have a
// window between them in which it was.
//
// It also simplifies the gossip handler the next stage brings: a revocation
// arriving from the fleet directory for a device this machine never paired
// has only to be recorded (AddRevocation), and every acceptance path — this
// one and AddFromFleetCert both — is already refusing that key. Nothing has
// to remember to ask a second question.
//
// An unreadable revocation list is an error rather than a false, the same
// direction every other refusal here takes: a caller deciding whether to
// admit a key must refuse when it cannot know.
//
// One edge this leaves standing, deliberately and not comfortably: Add does
// not consult the revocation list, so re-pairing a revoked *key* — which the
// browser does whenever its IndexedDB survives the revoke, since it reuses
// its device key — writes an entry this function will then refuse. The
// ceremony reports success and the relay channel closes anyway. Making Add
// refuse, or making a deliberate re-pairing clear the revocation, is a
// design call about what "un-revoking" means (the spec says: a new key, and
// the old one stays dead) and is deliberately not decided here.
func (s *DeviceStore) FindByKey(publicKey []byte) (Device, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if revoked, err := s.isRevokedLocked(publicKey); err != nil {
		return Device{}, false, err
	} else if revoked {
		return Device{}, false, nil
	}
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

// --- the revocation set ---

// Revocations live in revocations.json beside devices.json, under the same
// lock, because the two are one fact with two signs: a device is paired, or
// its key is dead. Removing an entry from devices.json stopped being a
// complete revocation the day fleet certs existed — the cert would walk the
// device straight back in through AddFromFleetCert — so the revocation is
// recorded here, permanently. Un-revoking is pairing again under a fresh
// key (spec/fleet-trust.md); nothing ever deletes from this file.
//
// Each entry keeps the signed revocation blob the fleet key produced, so
// the record that refuses the key locally is the same artifact the fleet
// directory will publish to every other machine.

// revocationsFileName is the set's file, 0600 like devices.json — not
// because revocations are secret (they are signed, public artifacts) but
// because one loose mode in this directory would be one to explain.
const revocationsFileName = "revocations.json"

// StoredRevocation is one dead key: the key itself, and the signed
// fleet revocation for it.
type StoredRevocation struct {
	PublicKey []byte `json:"publicKey"`
	Cert      []byte `json:"cert"`
}

func (s *DeviceStore) revocationsPath() string {
	return filepath.Join(filepath.Dir(s.path), revocationsFileName)
}

func (s *DeviceStore) loadRevocations() ([]StoredRevocation, error) {
	raw, err := os.ReadFile(s.revocationsPath())
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var out []StoredRevocation
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, fmt.Errorf("crypto: %s is not a revocation list: %w", s.revocationsPath(), err)
	}
	return out, nil
}

func (s *DeviceStore) isRevokedLocked(publicKey []byte) (bool, error) {
	revs, err := s.loadRevocations()
	if err != nil {
		return false, err
	}
	for _, r := range revs {
		if bytes.Equal(r.PublicKey, publicKey) {
			return true, nil
		}
	}
	return false, nil
}

// IsRevoked reports whether publicKey is on the revocation list. An
// unreadable list is an error, not a false: the caller deciding whether to
// admit a key must refuse when it cannot know, the same direction FindByKey
// errors push.
func (s *DeviceStore) IsRevoked(publicKey []byte) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.isRevokedLocked(publicKey)
}

// AddRevocation records a dead key with its signed revocation. Idempotent
// by key — revoking twice, or hearing the same revocation again from the
// directory one stage on, is one entry — and the first blob recorded wins,
// which is safe because any verifying revocation for a key is exactly as
// dead as any other.
func (s *DeviceStore) AddRevocation(publicKey, cert []byte) error {
	if len(publicKey) != 32 {
		return fmt.Errorf("crypto: device key must be 32 bytes, got %d", len(publicKey))
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	revs, err := s.loadRevocations()
	if err != nil {
		return err
	}
	for _, r := range revs {
		if bytes.Equal(r.PublicKey, publicKey) {
			return nil
		}
	}
	revs = append(revs, StoredRevocation{PublicKey: slices.Clone(publicKey), Cert: slices.Clone(cert)})
	blob, err := json.MarshalIndent(revs, "", "  ")
	if err != nil {
		return err
	}
	return s.writeFileLocked(s.revocationsPath(), blob)
}

// Revocations is the whole set — what the directory publisher one stage on
// pushes for the machines that were not in the room when the revoke
// happened.
func (s *DeviceStore) Revocations() ([]StoredRevocation, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.loadRevocations()
}
