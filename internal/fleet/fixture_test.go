package fleet

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"flag"
	"os"
	"testing"
)

var update = flag.Bool("update", false, "regenerate testdata/fleet/certs.json")

// certsFixturePath is the cross-language contract for the certificate
// encoding: this package generates it and asserts every committed case on
// every run, and the TypeScript sides (browser and, one stage on, whatever
// reads the fleet directory) walk the same file — the role
// testdata/relay/machine-ids.json plays for the machine-id MAC and
// testdata/noise/ik.json for the handshake.
//
// Regeneration order matters once: testdata/noise/ik-payload.json embeds
// this file's device-cert blob as its handshake payload, so regenerate this
// file first (`go test ./internal/fleet/ -update`), then the noise vectors
// (`go test ./internal/crypto/ -update`).
const certsFixturePath = "../../testdata/fleet/certs.json"

// noiseVectorPath is where the fixture borrows its keys from. The device
// case's key is the noise vectors' initiator static and the machine case's
// noise key is their responder static, deliberately: the device cert in
// this file is then a valid handshake payload for the ik-payload vectors,
// and one replay exercises both fixtures against each other.
const noiseVectorPath = "../../testdata/noise/ik.json"

type certsFixtureFile struct {
	// Seed is the fixture fleet key, spelled the way the join line spells
	// it. Not a credential — it exists to pin arithmetic, like the secrets
	// in machine-ids.json.
	Seed string `json:"seed"`
	// PublicKeyHex is the Ed25519 public key Seed derives — what a consumer
	// verifies every signedHex under.
	PublicKeyHex string `json:"publicKeyHex"`
	Cases        []certsFixtureCase `json:"cases"`
}

type certsFixtureCase struct {
	Name string          `json:"name"`
	Cert certsFixtureDoc `json:"cert"`
	// CanonicalHex is the canonical encoding — the exact bytes the
	// signature covers. SignedHex is canonical || signature: the one wire
	// form, and byte for byte what the IK message-A payload carries.
	CanonicalHex string `json:"canonicalHex"`
	SignedHex    string `json:"signedHex"`
}

// certsFixtureDoc is the cert's fields as JSON, so a consumer builds the
// cert from named values rather than parsing canonicalHex to learn them.
type certsFixtureDoc struct {
	V         int    `json:"v"`
	Kind      string `json:"kind"`
	ID        string `json:"id,omitempty"`
	Name      string `json:"name,omitempty"`
	NoiseHex  string `json:"noiseHex,omitempty"`
	DeviceHex string `json:"deviceHex,omitempty"`
	PairedOn  string `json:"pairedOn,omitempty"`
	IAT       int64  `json:"iat"`
}

// fixtureKey is the deterministic fleet key the fixture is signed under.
func fixtureKey(t *testing.T) Key {
	t.Helper()
	seed := sha256.Sum256([]byte("flue-fleet-fixture-key"))
	k, err := Mint(bytes.NewReader(seed[:]))
	if err != nil {
		t.Fatalf("Mint: %v", err)
	}
	return k
}

// noiseFixtureKeys reads the two static public keys out of the committed
// noise vectors.
func noiseFixtureKeys(t *testing.T) (initiatorPub, responderPub []byte) {
	t.Helper()
	raw, err := os.ReadFile(noiseVectorPath)
	if err != nil {
		t.Fatalf("reading %s: %v", noiseVectorPath, err)
	}
	var v struct {
		InitiatorStaticPub string `json:"initiatorStaticPub"`
		ResponderStaticPub string `json:"responderStaticPub"`
	}
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatalf("decoding %s: %v", noiseVectorPath, err)
	}
	return unhex(t, v.InitiatorStaticPub), unhex(t, v.ResponderStaticPub)
}

func unhex(t *testing.T, s string) []byte {
	t.Helper()
	b, err := hex.DecodeString(s)
	if err != nil {
		t.Fatalf("bad hex %q: %v", s, err)
	}
	return b
}

// certsFixtureCases derives every case from the fixture key and the noise
// vectors' statics. The machine id is machine-ids.json's ordinary case, so
// the three fixture families name one coherent little fleet. The
// unicode-name case is the one a byte-length/rune-length confusion gets
// wrong.
func certsFixtureCases(t *testing.T, k Key) []certsFixtureCase {
	t.Helper()
	devicePub, noisePub := noiseFixtureKeys(t)
	const machineID = "karns-macbook-pro-a1b2-8ac6565b"

	certs := []struct {
		name string
		cert Cert
	}{
		{"machine", MachineCert{ID: machineID, Name: "Karn's MacBook Pro", Noise: noisePub, IAT: 1754700000}},
		{"device", DeviceCert{Device: devicePub, Name: "relayed phone", PairedOn: machineID, IAT: 1754700001}},
		{"device-unicode-name", DeviceCert{Device: bytes.Repeat([]byte{0x2a}, 32), Name: "Karn’s téléphone 📱", PairedOn: machineID, IAT: 1754700002}},
		{"revoke", Revocation{Device: devicePub, IAT: 1754700003}},
	}

	cases := make([]certsFixtureCase, 0, len(certs))
	for _, c := range certs {
		canonical, err := Encode(c.cert)
		if err != nil {
			t.Fatalf("Encode(%s): %v", c.name, err)
		}
		signed, err := k.Sign(c.cert)
		if err != nil {
			t.Fatalf("Sign(%s): %v", c.name, err)
		}
		doc := certsFixtureDoc{V: certVersion, Kind: c.cert.Kind()}
		switch cert := c.cert.(type) {
		case MachineCert:
			doc.ID, doc.Name, doc.NoiseHex, doc.IAT = cert.ID, cert.Name, hex.EncodeToString(cert.Noise), cert.IAT
		case DeviceCert:
			doc.DeviceHex, doc.Name, doc.PairedOn, doc.IAT = hex.EncodeToString(cert.Device), cert.Name, cert.PairedOn, cert.IAT
		case Revocation:
			doc.DeviceHex, doc.IAT = hex.EncodeToString(cert.Device), cert.IAT
		}
		cases = append(cases, certsFixtureCase{
			Name:         c.name,
			Cert:         doc,
			CanonicalHex: hex.EncodeToString(canonical),
			SignedHex:    hex.EncodeToString(signed),
		})
	}
	return cases
}

// TestCertsFixture re-derives every committed case on every run — which is
// what catches a drifted prefix, field order or signature input — and, with
// -update, rewrites the file. The committed file is the artifact; the
// TypeScript suites assert against it without regenerating.
func TestCertsFixture(t *testing.T) {
	k := fixtureKey(t)
	derived := certsFixtureFile{
		Seed:         k.Seed(),
		PublicKeyHex: hex.EncodeToString(k.Public()),
		Cases:        certsFixtureCases(t, k),
	}

	if *update {
		if err := os.MkdirAll("../../testdata/fleet", 0o755); err != nil {
			t.Fatal(err)
		}
		b, err := json.MarshalIndent(derived, "", "  ")
		if err != nil {
			t.Fatalf("marshalling the fixture: %v", err)
		}
		b = append(b, '\n')
		if err := os.WriteFile(certsFixturePath, b, 0o644); err != nil {
			t.Fatalf("writing %s: %v", certsFixturePath, err)
		}
	}

	raw, err := os.ReadFile(certsFixturePath)
	if err != nil {
		t.Fatalf("reading %s (regenerate with -update): %v", certsFixturePath, err)
	}
	var committed certsFixtureFile
	if err := json.Unmarshal(raw, &committed); err != nil {
		t.Fatalf("decoding %s: %v", certsFixturePath, err)
	}

	if committed.Seed != derived.Seed || committed.PublicKeyHex != derived.PublicKeyHex {
		t.Errorf("fixture keys drifted: committed (%s, %s), derived (%s, %s); regenerate with -update if intended",
			committed.Seed, committed.PublicKeyHex, derived.Seed, derived.PublicKeyHex)
	}
	if len(committed.Cases) != len(derived.Cases) {
		t.Fatalf("%s carries %d cases, this package derives %d; regenerate with -update", certsFixturePath, len(committed.Cases), len(derived.Cases))
	}
	for i, want := range committed.Cases {
		if got := derived.Cases[i]; got != want {
			t.Errorf("case %q: this package derives %+v, the committed fixture says %+v; regenerate with -update if the change is intended", want.Name, got, want)
		}
		// And every committed blob must verify under the committed public
		// key — the assertion a consumer in another language starts from.
		cert, err := Verify(unhex(t, committed.PublicKeyHex), unhex(t, want.SignedHex))
		if err != nil {
			t.Errorf("case %q: the committed signed blob does not verify: %v", want.Name, err)
			continue
		}
		if cert.Kind() != want.Cert.Kind {
			t.Errorf("case %q: the committed blob decodes as a %s cert, the doc says %s", want.Name, cert.Kind(), want.Cert.Kind)
		}
	}
}
