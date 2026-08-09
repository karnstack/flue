package fleet

import (
	"bytes"
	"crypto/ed25519"
	"crypto/sha256"
	"errors"
	"strings"
	"testing"
)

// testKey is a deterministic fleet key so failures print stable bytes.
func testKey(t *testing.T) Key {
	t.Helper()
	seed := sha256.Sum256([]byte("fleet-test-key"))
	k, err := Mint(bytes.NewReader(seed[:]))
	if err != nil {
		t.Fatalf("Mint: %v", err)
	}
	return k
}

func key32(fill byte) []byte { return bytes.Repeat([]byte{fill}, 32) }

func testCerts() []Cert {
	return []Cert{
		MachineCert{ID: "karns-mbp-a1b2-8ac6565b", Name: "Karn's MacBook Pro", Noise: key32(0x11), IAT: 1754700000},
		DeviceCert{Device: key32(0x22), Name: "relayed phone", PairedOn: "karns-mbp-a1b2-8ac6565b", IAT: 1754700001},
		Revocation{Device: key32(0x22), IAT: 1754700002},
	}
}

// TestSignVerifyRoundTrip: every kind signs, verifies under the right key,
// and comes back field for field.
func TestSignVerifyRoundTrip(t *testing.T) {
	k := testKey(t)
	for _, c := range testCerts() {
		blob, err := k.Sign(c)
		if err != nil {
			t.Fatalf("Sign(%s): %v", c.Kind(), err)
		}
		got, err := Verify(k.Public(), blob)
		if err != nil {
			t.Fatalf("Verify(%s): %v", c.Kind(), err)
		}
		switch want := c.(type) {
		case MachineCert:
			g, ok := got.(MachineCert)
			if !ok || g.ID != want.ID || g.Name != want.Name || !bytes.Equal(g.Noise, want.Noise) || g.IAT != want.IAT {
				t.Errorf("machine cert round-tripped to %#v, want %#v", got, want)
			}
		case DeviceCert:
			g, ok := got.(DeviceCert)
			if !ok || !bytes.Equal(g.Device, want.Device) || g.Name != want.Name || g.PairedOn != want.PairedOn || g.IAT != want.IAT {
				t.Errorf("device cert round-tripped to %#v, want %#v", got, want)
			}
		case Revocation:
			g, ok := got.(Revocation)
			if !ok || !bytes.Equal(g.Device, want.Device) || g.IAT != want.IAT {
				t.Errorf("revocation round-tripped to %#v, want %#v", got, want)
			}
		}
	}
}

// TestVerifyRefusesTheWrongKey: a cert signed by one fleet must not verify
// under another's public key.
func TestVerifyRefusesTheWrongKey(t *testing.T) {
	k := testKey(t)
	otherSeed := sha256.Sum256([]byte("some-other-fleet"))
	other, err := Mint(bytes.NewReader(otherSeed[:]))
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range testCerts() {
		blob, err := k.Sign(c)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := Verify(other.Public(), blob); !errors.Is(err, ErrBadSignature) {
			t.Errorf("Verify(%s) under a foreign key = %v, want ErrBadSignature", c.Kind(), err)
		}
	}
}

// TestVerifyRefusesTampering: every flipped bit — in the fields or in the
// signature — is a refusal, and so is anything appended or truncated.
func TestVerifyRefusesTampering(t *testing.T) {
	k := testKey(t)
	blob, err := k.Sign(testCerts()[1])
	if err != nil {
		t.Fatal(err)
	}
	for i := range blob {
		bad := bytes.Clone(blob)
		bad[i] ^= 0x01
		if _, err := Verify(k.Public(), bad); err == nil {
			t.Fatalf("a blob with byte %d flipped verified", i)
		}
	}
	if _, err := Verify(k.Public(), append(bytes.Clone(blob), 0x00)); !errors.Is(err, ErrBadCert) {
		t.Errorf("a blob with a trailing byte = %v, want ErrBadCert", err)
	}
	if _, err := Verify(k.Public(), blob[:len(blob)-1]); !errors.Is(err, ErrBadCert) {
		t.Errorf("a truncated blob = %v, want ErrBadCert", err)
	}
	if _, err := Verify(k.Public(), nil); !errors.Is(err, ErrBadCert) {
		t.Errorf("an empty blob = %v, want ErrBadCert", err)
	}
}

// TestVerifyDeviceRefusesOtherKinds: a well-signed machine cert or
// revocation in the handshake-payload position is still refused — kind
// confusion is exactly what the kind byte under the signature prevents.
func TestVerifyDeviceRefusesOtherKinds(t *testing.T) {
	k := testKey(t)
	for _, c := range []Cert{testCerts()[0], testCerts()[2]} {
		blob, err := k.Sign(c)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := VerifyDevice(k.Public(), blob); !errors.Is(err, ErrBadCert) {
			t.Errorf("VerifyDevice(%s) = %v, want ErrBadCert", c.Kind(), err)
		}
	}
	blob, err := k.Sign(testCerts()[1])
	if err != nil {
		t.Fatal(err)
	}
	dc, err := VerifyDevice(k.Public(), blob)
	if err != nil || !bytes.Equal(dc.Device, key32(0x22)) {
		t.Errorf("VerifyDevice on a device cert = %#v, %v", dc, err)
	}
}

// TestEncodeRefusesBadFields: the encoder is the last line before a
// signature makes bad bytes permanent.
func TestEncodeRefusesBadFields(t *testing.T) {
	cases := []struct {
		name string
		cert Cert
	}{
		{"short device key", DeviceCert{Device: key32(0x22)[:31], Name: "p", PairedOn: "m", IAT: 1}},
		{"long device key", DeviceCert{Device: bytes.Repeat([]byte{0x22}, 33), Name: "p", PairedOn: "m", IAT: 1}},
		{"nil noise key", MachineCert{ID: "m", Name: "m", Noise: nil, IAT: 1}},
		{"negative iat", Revocation{Device: key32(0x01), IAT: -1}},
		{"oversized name", DeviceCert{Device: key32(0x22), Name: strings.Repeat("a", maxStringBytes+1), PairedOn: "m", IAT: 1}},
		{"non-UTF-8 name", DeviceCert{Device: key32(0x22), Name: string([]byte{0xff, 0xfe}), PairedOn: "m", IAT: 1}},
	}
	for _, tc := range cases {
		if _, err := Encode(tc.cert); err == nil {
			t.Errorf("%s: Encode accepted it", tc.name)
		}
	}
}

// TestSeedRoundTrip: the join line's spelling of the key comes back as the
// same key, and the strict parses refuse what they should.
func TestSeedRoundTrip(t *testing.T) {
	k := testKey(t)
	seed := k.Seed()
	if len(seed) != SeedEncodedLen {
		t.Fatalf("Seed() is %d characters, want %d", len(seed), SeedEncodedLen)
	}
	back, err := Parse(seed)
	if err != nil {
		t.Fatalf("Parse(Seed()): %v", err)
	}
	if !bytes.Equal(back.Public(), k.Public()) {
		t.Fatal("the re-parsed key derives a different public key")
	}

	for _, bad := range []string{"", "not base64url!!", seed + "=", seed[:10], seed + seed} {
		if _, err := Parse(bad); err == nil {
			t.Errorf("Parse(%q) accepted it", bad)
		}
	}
}

// TestZeroKey: the zero value means "no fleet key" and behaves like it.
func TestZeroKey(t *testing.T) {
	var k Key
	if k.Valid() {
		t.Error("the zero Key claims to be valid")
	}
	if k.Seed() != "" || k.Public() != nil {
		t.Error("the zero Key has a seed or a public key")
	}
	if _, err := k.Sign(testCerts()[2]); !errors.Is(err, ErrNoKey) {
		t.Errorf("Sign on the zero Key = %v, want ErrNoKey", err)
	}
}

// TestVerifyRefusesABogusPublicKey: a verifier misconfigured with an empty
// or short key must refuse everything rather than panic or accept.
func TestVerifyRefusesABogusPublicKey(t *testing.T) {
	k := testKey(t)
	blob, err := k.Sign(testCerts()[2])
	if err != nil {
		t.Fatal(err)
	}
	for _, pub := range []ed25519.PublicKey{nil, k.Public()[:31]} {
		if _, err := Verify(pub, blob); err == nil {
			t.Errorf("Verify under a %d-byte public key accepted the blob", len(pub))
		}
	}
}
