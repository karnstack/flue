// Package fleet is the fleet key and the certificates it signs
// (spec/fleet-trust.md): one Ed25519 keypair per relay, held by every machine
// and never by the Worker, whose signatures are what let a device paired on
// one machine be trusted by every other.
//
// Three certificate kinds exist and no more: a machine cert (a machine
// naming itself and its Noise static key), a device cert (a pairing ceremony
// naming the device key it admitted), and a revocation (the operator naming
// a device key that is dead). All three are detached Ed25519 signatures over
// a canonical encoding of the named fields; the signed blob — canonical
// bytes then the 64-byte signature — is the one wire form, carried in the
// IK handshake's first message today and by the relay's fleet directory in
// the stage that follows. testdata/fleet/certs.json pins the bytes for every
// implementation.
package fleet

import (
	"crypto/ed25519"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"unicode/utf8"
)

// Canonical encoding.
//
// The spec allows canonical CBOR or a length-prefixed encoding, pinned by
// test vectors either way. This package is length-prefixed, deliberately:
// canonical CBOR buys nothing for three record shapes with fixed field sets,
// and costs either a dependency (Go's standard library has no CBOR) or a
// hand-rolled subset whose canonicity rules — definite lengths, sorted map
// keys, shortest-form integers — are exactly the ambiguity a canonical
// encoding exists to rule out. A fixed field order with explicit lengths has
// no map to order and no integer forms to choose between: two
// implementations either produce the same bytes or fail the fixture.
//
// The layout, byte for byte:
//
//	"flue-fleet-cert/"          16 ASCII bytes — domain separation, the same
//	                            style as the machine-id MAC's prefix, so a
//	                            fleet signature can never be confused with
//	                            anything else the fleet key might one day sign
//	u8  v                       1
//	u8  kind                    1 machine, 2 device, 3 revoke
//	then the spec's fields for that kind, in the spec's order:
//	  machine:  str(id)  str(name)  key32(noise)   u64(iat)
//	  device:   key32(device)  str(name)  str(pairedOn)  u64(iat)
//	  revoke:   key32(device)  u64(iat)
//
//	str    = u16 big-endian byte length, then that many bytes of UTF-8
//	key32  = exactly 32 raw bytes, no length prefix
//	u64    = 8 bytes big-endian (iat is unix seconds and never negative)
//
// The signature is Ed25519 over exactly the canonical bytes, and the signed
// blob is canonical || signature. The canonical part is self-delimiting —
// fixed layout per kind, explicit string lengths — so the blob parses
// unambiguously: whatever remains after the fields must be exactly the 64
// signature bytes, and a blob with anything more or less is refused.
const (
	// certPrefix is the domain separator every canonical encoding opens with.
	certPrefix = "flue-fleet-cert/"

	// certVersion is the one version this package writes and accepts.
	certVersion = 1

	// kind bytes, in the order the spec lists the kinds.
	kindMachine = 1
	kindDevice  = 2
	kindRevoke  = 3

	// maxStringBytes bounds every string field, on encode and on decode. The
	// fields are bounded upstream anyway — machine ids are at most 63
	// characters, display names at most 64 runes — but a decoder that reads a
	// length from an unauthenticated blob must impose its own ceiling rather
	// than inherit one.
	maxStringBytes = 512

	// maxIAT is the ceiling on iat, on encode and on decode both — one
	// constant, because a value the encoder accepts and the decoder refuses
	// is a cert this package would sign and then fail to verify. Unix
	// seconds do not reach 2^62 (that is some 146 billion years out), so
	// anything at or above it is not a time; refusing it here is what keeps
	// every decoded iat safe to hand to time.Unix.
	maxIAT = 1 << 62

	// keyBytes is an X25519 public key, the only kind of key a cert names.
	keyBytes = 32

	// SeedEncodedLen is how long an encoded fleet seed is: 32 bytes of
	// Ed25519 seed in unpadded base64url, as the join line carries it.
	SeedEncodedLen = 43
)

// Kind names, as the spec writes them and as fixtures carry them.
const (
	KindMachine = "machine"
	KindDevice  = "device"
	KindRevoke  = "revoke"
)

var (
	// ErrBadCert is any blob that does not parse as a signed certificate:
	// wrong prefix, wrong version, truncated fields, trailing bytes.
	ErrBadCert = errors.New("fleet: not a certificate")

	// ErrBadSignature is a well-formed blob whose signature does not verify
	// under the given fleet public key.
	ErrBadSignature = errors.New("fleet: the signature does not verify")

	// ErrNoKey is a signing or seed operation asked of a zero Key.
	ErrNoKey = errors.New("fleet: no fleet key")
)

// Key is the fleet key: the Ed25519 keypair `flue relay setup` mints, whose
// seed rides the join line and lands in relay.json on every machine. The
// zero value is "no fleet key" — Valid reports it, Sign refuses it — so a
// daemon on a relay from before the key existed carries exactly that.
type Key struct {
	priv ed25519.PrivateKey
}

// Mint makes a fresh fleet key from r, which is crypto/rand.Reader
// everywhere but tests.
func Mint(r io.Reader) (Key, error) {
	seed := make([]byte, ed25519.SeedSize)
	if _, err := io.ReadFull(r, seed); err != nil {
		return Key{}, fmt.Errorf("fleet: reading randomness for a fleet key: %w", err)
	}
	return Key{priv: ed25519.NewKeyFromSeed(seed)}, nil
}

// Parse reads a seed as the join line spells it: 32 bytes in unpadded
// base64url. It is strict — padded, standard-alphabet or wrong-length input
// is refused rather than guessed at, because the value arrives pasted across
// machines and a mangled seed that half-parsed would join a machine to a
// fleet whose signatures it can never verify.
func Parse(seed string) (Key, error) {
	raw, err := base64.RawURLEncoding.DecodeString(seed)
	if err != nil {
		return Key{}, fmt.Errorf("fleet: the fleet key is not unpadded base64url: %w", err)
	}
	if len(raw) != ed25519.SeedSize {
		return Key{}, fmt.Errorf("fleet: the fleet key must be %d bytes, got %d", ed25519.SeedSize, len(raw))
	}
	return Key{priv: ed25519.NewKeyFromSeed(raw)}, nil
}

// Valid reports whether this is a real key rather than the zero value.
func (k Key) Valid() bool { return len(k.priv) == ed25519.PrivateKeySize }

// Seed is the key as the join line and relay.json carry it: the 32-byte
// Ed25519 seed, unpadded base64url. Empty for the zero Key.
func (k Key) Seed() string {
	if !k.Valid() {
		return ""
	}
	return base64.RawURLEncoding.EncodeToString(k.priv.Seed())
}

// Public is the fleet public key — what every machine and every paired
// device verifies certs under. Nil for the zero Key.
func (k Key) Public() ed25519.PublicKey {
	if !k.Valid() {
		return nil
	}
	return k.priv.Public().(ed25519.PublicKey)
}

// Sign encodes c canonically and returns the signed blob: the canonical
// bytes followed by the 64-byte Ed25519 signature over them.
func (k Key) Sign(c Cert) ([]byte, error) {
	if !k.Valid() {
		return nil, ErrNoKey
	}
	canonical, err := Encode(c)
	if err != nil {
		return nil, err
	}
	return append(canonical, ed25519.Sign(k.priv, canonical)...), nil
}

// Cert is one of the three certificate kinds. It is a sealed interface —
// the encoding has exactly three layouts, and a fourth implementer would be
// bytes no verifier recognises.
type Cert interface {
	// Kind is the spec's name for this certificate's kind.
	Kind() string

	kindByte() byte
	encodeBody(b []byte) ([]byte, error)
}

// MachineCert is a machine naming itself: minted by the machine, for
// itself, at join or setup time. Browsers verify it to learn which Noise
// static key to pin for the machine; nothing daemon-side consumes it yet
// (the fleet directory that distributes it is the stage after this one).
type MachineCert struct {
	ID    string // the machine id, as minted by config.MintMachineID
	Name  string // the machine's display name
	Noise []byte // the daemon's static X25519 public key, 32 bytes
	IAT   int64  // unix seconds, for display; certs deliberately never expire
}

func (MachineCert) Kind() string   { return KindMachine }
func (MachineCert) kindByte() byte { return kindMachine }

func (c MachineCert) encodeBody(b []byte) ([]byte, error) {
	b, err := appendString(b, "id", c.ID)
	if err != nil {
		return nil, err
	}
	if b, err = appendString(b, "name", c.Name); err != nil {
		return nil, err
	}
	if b, err = appendKey(b, "noise", c.Noise); err != nil {
		return nil, err
	}
	return appendIAT(b, c.IAT)
}

// DeviceCert is a pairing ceremony's outcome: minted by whichever machine
// ran the ceremony, at the moment it completed, naming the device key it
// admitted. A daemon that has never seen the key admits it on this cert
// alone — which is the whole point of the fleet key.
type DeviceCert struct {
	Device   []byte // the device's static X25519 public key, 32 bytes
	Name     string // the device's display name, as the ceremony recorded it
	PairedOn string // the machine id the ceremony ran on
	IAT      int64
}

func (DeviceCert) Kind() string   { return KindDevice }
func (DeviceCert) kindByte() byte { return kindDevice }

func (c DeviceCert) encodeBody(b []byte) ([]byte, error) {
	b, err := appendKey(b, "device", c.Device)
	if err != nil {
		return nil, err
	}
	if b, err = appendString(b, "name", c.Name); err != nil {
		return nil, err
	}
	if b, err = appendString(b, "pairedOn", c.PairedOn); err != nil {
		return nil, err
	}
	return appendIAT(b, c.IAT)
}

// Revocation is the operator killing a device key, minted by whichever
// machine the revoke ran on. It permanently outranks any device cert for
// the same key, whatever either one's timestamp says: iat is display, not
// precedence, and un-revoking is pairing again under a fresh key. Verifiers
// must implement it that way — check the revocation set before honouring a
// device cert, and never compare the two by time.
type Revocation struct {
	Device []byte // the revoked device key, 32 bytes
	IAT    int64
}

func (Revocation) Kind() string   { return KindRevoke }
func (Revocation) kindByte() byte { return kindRevoke }

func (c Revocation) encodeBody(b []byte) ([]byte, error) {
	b, err := appendKey(b, "device", c.Device)
	if err != nil {
		return nil, err
	}
	return appendIAT(b, c.IAT)
}

// Encode is the canonical encoding of c — the exact bytes a signature
// covers. Exported for the fixture generator; everything else wants Sign
// and Verify, which carry the signature with the bytes.
func Encode(c Cert) ([]byte, error) {
	b := make([]byte, 0, 128)
	b = append(b, certPrefix...)
	b = append(b, certVersion, c.kindByte())
	return c.encodeBody(b)
}

// Verify parses a signed blob, checks its signature under the fleet public
// key, and returns the typed certificate. Every fault is an error: a blob
// that is not a cert, trailing bytes, a signature that does not verify.
// Callers must treat the returned cert as meaningful only for the checks
// they then perform themselves — above all that a revocation for the same
// key outranks a device cert regardless of either iat.
func Verify(pub ed25519.PublicKey, blob []byte) (Cert, error) {
	if len(pub) != ed25519.PublicKeySize {
		return nil, fmt.Errorf("%w: the fleet public key must be %d bytes, got %d", ErrBadSignature, ed25519.PublicKeySize, len(pub))
	}
	cert, canonicalLen, err := decode(blob)
	if err != nil {
		return nil, err
	}
	if len(blob)-canonicalLen != ed25519.SignatureSize {
		return nil, fmt.Errorf("%w: %d bytes after the fields, want a %d-byte signature",
			ErrBadCert, len(blob)-canonicalLen, ed25519.SignatureSize)
	}
	if !ed25519.Verify(pub, blob[:canonicalLen], blob[canonicalLen:]) {
		return nil, ErrBadSignature
	}
	return cert, nil
}

// VerifyDevice is Verify for the one place that only a device cert will do:
// the daemon's handshake payload. A machine cert or a revocation in that
// position is well-signed and still refused.
func VerifyDevice(pub ed25519.PublicKey, blob []byte) (DeviceCert, error) {
	c, err := Verify(pub, blob)
	if err != nil {
		return DeviceCert{}, err
	}
	dc, ok := c.(DeviceCert)
	if !ok {
		return DeviceCert{}, fmt.Errorf("%w: a %s certificate where a device certificate belongs", ErrBadCert, c.Kind())
	}
	return dc, nil
}

// --- encoding primitives ---

func appendString(b []byte, field, s string) ([]byte, error) {
	if len(s) > maxStringBytes {
		return nil, fmt.Errorf("fleet: %s is %d bytes, the ceiling is %d", field, len(s), maxStringBytes)
	}
	if !utf8.ValidString(s) {
		// The encoding says UTF-8 and means it: a Go string can carry any
		// bytes, and two implementations that disagreed about what a string
		// field may hold would disagree about which blobs verify.
		return nil, fmt.Errorf("fleet: %s is not valid UTF-8", field)
	}
	b = binary.BigEndian.AppendUint16(b, uint16(len(s)))
	return append(b, s...), nil
}

func appendKey(b []byte, field string, key []byte) ([]byte, error) {
	if len(key) != keyBytes {
		return nil, fmt.Errorf("fleet: %s must be %d bytes, got %d", field, keyBytes, len(key))
	}
	return append(b, key...), nil
}

func appendIAT(b []byte, iat int64) ([]byte, error) {
	if iat < 0 {
		return nil, fmt.Errorf("fleet: iat %d is negative", iat)
	}
	if iat > maxIAT {
		// The same ceiling reader.iat holds the wire to. Without it this
		// encoder would happily sign a math.MaxInt64 iat that its own Verify
		// then refuses — a cert minted and dead in the same breath, and the
		// kind of asymmetry a fixture cannot catch because no honest caller
		// produces one.
		return nil, fmt.Errorf("fleet: iat %d is not a unix time", iat)
	}
	return binary.BigEndian.AppendUint64(b, uint64(iat)), nil
}

// decode parses the canonical part of a signed blob, returning the typed
// cert and how many bytes of blob the canonical encoding covered. It never
// looks at the signature; Verify owns that.
func decode(blob []byte) (Cert, int, error) {
	r := &reader{b: blob}
	prefix, err := r.take(len(certPrefix))
	if err != nil || string(prefix) != certPrefix {
		return nil, 0, fmt.Errorf("%w: it does not open with %q", ErrBadCert, certPrefix)
	}
	header, err := r.take(2)
	if err != nil {
		return nil, 0, fmt.Errorf("%w: truncated before the version", ErrBadCert)
	}
	if header[0] != certVersion {
		return nil, 0, fmt.Errorf("%w: version %d, this implementation speaks %d", ErrBadCert, header[0], certVersion)
	}

	var cert Cert
	switch header[1] {
	case kindMachine:
		var c MachineCert
		if c.ID, err = r.str(); err == nil {
			if c.Name, err = r.str(); err == nil {
				if c.Noise, err = r.key(); err == nil {
					c.IAT, err = r.iat()
				}
			}
		}
		cert = c
	case kindDevice:
		var c DeviceCert
		if c.Device, err = r.key(); err == nil {
			if c.Name, err = r.str(); err == nil {
				if c.PairedOn, err = r.str(); err == nil {
					c.IAT, err = r.iat()
				}
			}
		}
		cert = c
	case kindRevoke:
		var c Revocation
		if c.Device, err = r.key(); err == nil {
			c.IAT, err = r.iat()
		}
		cert = c
	default:
		return nil, 0, fmt.Errorf("%w: kind byte %d", ErrBadCert, header[1])
	}
	if err != nil {
		return nil, 0, err
	}
	return cert, r.off, nil
}

// reader walks a blob field by field. Its errors all wrap ErrBadCert.
type reader struct {
	b   []byte
	off int
}

func (r *reader) take(n int) ([]byte, error) {
	if len(r.b)-r.off < n {
		return nil, fmt.Errorf("%w: truncated at byte %d", ErrBadCert, r.off)
	}
	out := r.b[r.off : r.off+n]
	r.off += n
	return out, nil
}

func (r *reader) str() (string, error) {
	lb, err := r.take(2)
	if err != nil {
		return "", err
	}
	n := int(binary.BigEndian.Uint16(lb))
	if n > maxStringBytes {
		return "", fmt.Errorf("%w: a %d-byte string field, the ceiling is %d", ErrBadCert, n, maxStringBytes)
	}
	raw, err := r.take(n)
	if err != nil {
		return "", err
	}
	if !utf8.Valid(raw) {
		return "", fmt.Errorf("%w: a string field that is not UTF-8", ErrBadCert)
	}
	return string(raw), nil
}

func (r *reader) key() ([]byte, error) {
	raw, err := r.take(keyBytes)
	if err != nil {
		return nil, err
	}
	// Cloned: the caller's cert outlives the blob it was parsed from.
	out := make([]byte, keyBytes)
	copy(out, raw)
	return out, nil
}

func (r *reader) iat() (int64, error) {
	raw, err := r.take(8)
	if err != nil {
		return 0, err
	}
	v := binary.BigEndian.Uint64(raw)
	if v > maxIAT {
		// The same ceiling appendIAT encodes under, so this package never
		// signs bytes it would then refuse.
		return 0, fmt.Errorf("%w: iat %d is not a unix time", ErrBadCert, v)
	}
	return int64(v), nil
}
