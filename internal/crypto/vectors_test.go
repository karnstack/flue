package crypto

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"flag"
	"os"
	"path/filepath"
	"testing"

	"github.com/flynn/noise"
)

var update = flag.Bool("update", false, "regenerate testdata/noise vectors")

// detReader yields a deterministic byte stream: sha256(label||counter),
// concatenated. Good enough to make GenerateKeypair reproducible; never used
// outside tests.
type detReader struct {
	label []byte
	block []byte
	ctr   uint8
}

func (d *detReader) Read(p []byte) (int, error) {
	n := 0
	for n < len(p) {
		if len(d.block) == 0 {
			sum := sha256.Sum256(append(d.label, d.ctr))
			d.ctr++
			d.block = sum[:]
		}
		c := copy(p[n:], d.block)
		d.block = d.block[c:]
		n += c
	}
	return n, nil
}

type vectorFile struct {
	Protocol               string          `json:"protocol"`
	InitiatorStaticPriv    string          `json:"initiatorStaticPriv"`
	InitiatorStaticPub     string          `json:"initiatorStaticPub"`
	ResponderStaticPriv    string          `json:"responderStaticPriv"`
	ResponderStaticPub     string          `json:"responderStaticPub"`
	InitiatorEphemeralPriv string          `json:"initiatorEphemeralPriv"`
	ResponderEphemeralPriv string          `json:"responderEphemeralPriv"`
	Msg1                   string          `json:"msg1"`
	Msg2                   string          `json:"msg2"`
	Transport              []vectorMessage `json:"transport"`
}

type vectorMessage struct {
	Dir        string `json:"dir"` // "i2r" | "r2i"
	Plaintext  string `json:"plaintext"`
	Ciphertext string `json:"ciphertext"`
}

const vectorPath = "../../testdata/noise/ik.json"

// payloadVectorPath is ik.json's sibling with a certificate riding message
// A's encrypted payload: the same protocol, the same deterministic statics
// and ephemerals, and one new field — msg1Payload, the fleet device cert
// blob out of testdata/fleet/certs.json, verbatim. ik.json itself is
// deliberately untouched (its msg1 carries the empty payload every
// pre-fleet initiator sends, and the TS suites replay it as committed);
// this file is what pins the payload-bearing shape for the TS initiator
// that will send one. Regenerate testdata/fleet/certs.json first — this
// file embeds its bytes.
const payloadVectorPath = "../../testdata/noise/ik-payload.json"

// fleetCertsPath is where the payload bytes come from. Read as data, not
// imported: the cert blob is opaque to this layer, which is the point.
const fleetCertsPath = "../../testdata/fleet/certs.json"

type payloadVectorFile struct {
	vectorFile
	// Msg1Payload is the plaintext the initiator sealed into message A —
	// hex, like every other byte string here. It equals the "device" case's
	// signedHex in testdata/fleet/certs.json, and the assertion run checks
	// that too, so the two fixtures cannot drift apart.
	Msg1Payload string `json:"msg1Payload"`
}

// fixtureDeviceCert reads the signed device-cert blob the payload vectors
// carry.
func fixtureDeviceCert(t *testing.T) []byte {
	t.Helper()
	raw, err := os.ReadFile(fleetCertsPath)
	if err != nil {
		t.Fatalf("reading %s (generate with `go test ./internal/fleet/ -update`): %v", fleetCertsPath, err)
	}
	var f struct {
		Cases []struct {
			Name      string `json:"name"`
			SignedHex string `json:"signedHex"`
		} `json:"cases"`
	}
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatal(err)
	}
	for _, c := range f.Cases {
		if c.Name == "device" {
			b, err := hex.DecodeString(c.SignedHex)
			if err != nil {
				t.Fatal(err)
			}
			return b
		}
	}
	t.Fatalf("%s carries no \"device\" case", fleetCertsPath)
	return nil
}

// capture records every frame either side sends, while still delivering it.
type capture struct {
	pipe *pipe
	msgs [][]byte
}

// generateVectors runs one deterministic handshake — msg-A payload included,
// nil for none — and returns everything a replay needs.
func generateVectors(t *testing.T, payload []byte) vectorFile {
	t.Helper()
	// Static keys from their own deterministic streams; ephemerals from the
	// streams handed to the handshakes. GenerateKeypair reads exactly 32
	// bytes, so the ephemeral private key is the first 32 bytes of that
	// stream — recorded so the TS side can reproduce the exact messages.
	iStaticRNG := &detReader{label: []byte("initiator-static")}
	rStaticRNG := &detReader{label: []byte("responder-static")}
	iStatic, err := Suite().GenerateKeypair(iStaticRNG)
	if err != nil {
		t.Fatal(err)
	}
	rStatic, err := Suite().GenerateKeypair(rStaticRNG)
	if err != nil {
		t.Fatal(err)
	}
	iEphStream := &detReader{label: []byte("initiator-ephemeral")}
	rEphStream := &detReader{label: []byte("responder-ephemeral")}
	iEphPriv := make([]byte, 32)
	rEphPriv := make([]byte, 32)
	iEphStream.Read(iEphPriv)
	rEphStream.Read(rEphPriv)

	p := newPipe()
	var msg1, msg2 []byte
	type rres struct {
		ch  *Channel
		err error
	}
	done := make(chan rres, 1)
	go func() {
		ch, _, _, err := ResponderHandshake(rStatic, &detReader{label: []byte("responder-ephemeral")},
			func() ([]byte, error) { b := <-p.a2b; msg1 = b; return b, nil },
			func(b []byte) error { msg2 = b; p.b2a <- b; return nil })
		done <- rres{ch, err}
	}()
	iCh, err := InitiatorHandshake(iStatic, rStatic.Public, payload, &detReader{label: []byte("initiator-ephemeral")}, p.aRecv, p.aSend)
	if err != nil {
		t.Fatal(err)
	}
	r := <-done
	if r.err != nil {
		t.Fatal(r.err)
	}

	var transport []vectorMessage
	seal := func(dir string, from, to *Channel, pt []byte) {
		ct, err := from.Seal(pt)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := to.Open(ct); err != nil {
			t.Fatal(err)
		}
		transport = append(transport, vectorMessage{Dir: dir, Plaintext: hex.EncodeToString(pt), Ciphertext: hex.EncodeToString(ct)})
	}
	seal("i2r", iCh, r.ch, []byte("hello daemon"))
	seal("r2i", r.ch, iCh, []byte("hello browser"))
	seal("i2r", iCh, r.ch, nil)

	return vectorFile{
		Protocol:               "Noise_IK_25519_ChaChaPoly_SHA256",
		InitiatorStaticPriv:    hex.EncodeToString(iStatic.Private),
		InitiatorStaticPub:     hex.EncodeToString(iStatic.Public),
		ResponderStaticPriv:    hex.EncodeToString(rStatic.Private),
		ResponderStaticPub:     hex.EncodeToString(rStatic.Public),
		InitiatorEphemeralPriv: hex.EncodeToString(iEphPriv),
		ResponderEphemeralPriv: hex.EncodeToString(rEphPriv),
		Msg1:                   hex.EncodeToString(msg1),
		Msg2:                   hex.EncodeToString(msg2),
		Transport:              transport,
	}
}

func writeVectorFile(t *testing.T, path string, v any) {
	t.Helper()
	out, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, append(out, '\n'), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestGenerateVectors(t *testing.T) {
	if !*update {
		t.Skip("run with -update to regenerate")
	}
	writeVectorFile(t, vectorPath, generateVectors(t, nil))

	cert := fixtureDeviceCert(t)
	pv := payloadVectorFile{vectorFile: generateVectors(t, cert), Msg1Payload: hex.EncodeToString(cert)}
	writeVectorFile(t, payloadVectorPath, pv)
}

// replayVectorFile replays the responder side against the recorded msg1,
// asserts every byte it produces matches the file, and returns the msg-A
// payload the responder read.
func replayVectorFile(t *testing.T, path string, v vectorFile) []byte {
	t.Helper()
	unhex := func(s string) []byte {
		b, err := hex.DecodeString(s)
		if err != nil {
			t.Fatal(err)
		}
		return b
	}

	rStatic := noiseKey(unhex(v.ResponderStaticPriv), unhex(v.ResponderStaticPub))
	var gotMsg2 []byte
	ch, peer, payload, err := ResponderHandshake(rStatic, &detReader{label: []byte("responder-ephemeral")},
		func() ([]byte, error) { return unhex(v.Msg1), nil },
		func(b []byte) error { gotMsg2 = b; return nil })
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(gotMsg2, unhex(v.Msg2)) {
		t.Fatalf("%s: responder produced a different msg2 than the vector file", path)
	}
	if !bytes.Equal(peer, unhex(v.InitiatorStaticPub)) {
		t.Fatalf("%s: responder resolved a different initiator identity", path)
	}
	for _, m := range v.Transport {
		switch m.Dir {
		case "i2r":
			pt, err := ch.Open(unhex(m.Ciphertext))
			if err != nil || !bytes.Equal(pt, unhex(m.Plaintext)) {
				t.Fatalf("%s: i2r transport message: %v", path, err)
			}
		case "r2i":
			ct, err := ch.Seal(unhex(m.Plaintext))
			if err != nil || !bytes.Equal(ct, unhex(m.Ciphertext)) {
				t.Fatalf("%s: r2i transport message: %v", path, err)
			}
		}
	}
	return payload
}

func TestVectorsAgainstDisk(t *testing.T) {
	raw, err := os.ReadFile(vectorPath)
	if err != nil {
		t.Fatalf("read vectors (generate with -update): %v", err)
	}
	var v vectorFile
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatal(err)
	}
	// ik.json's msg1 is the payload-less handshake every pre-fleet initiator
	// sends, and it must stay that: the TS suites replay these bytes as the
	// ordinary client.
	if payload := replayVectorFile(t, vectorPath, v); len(payload) != 0 {
		t.Fatalf("ik.json's msg1 carries a %d-byte payload, want none", len(payload))
	}
}

// TestPayloadVectorsAgainstDisk replays ik-payload.json — message A carrying
// the fleet device cert — and holds it to testdata/fleet/certs.json: the
// payload the responder reads must be the "device" case's signed blob,
// byte for byte, so the two fixtures cannot drift apart.
func TestPayloadVectorsAgainstDisk(t *testing.T) {
	raw, err := os.ReadFile(payloadVectorPath)
	if err != nil {
		t.Fatalf("read vectors (generate with -update): %v", err)
	}
	var v payloadVectorFile
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatal(err)
	}
	payload := replayVectorFile(t, payloadVectorPath, v.vectorFile)
	want, err := hex.DecodeString(v.Msg1Payload)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(payload, want) {
		t.Fatal("the responder read a different msg1 payload than the file records")
	}
	if cert := fixtureDeviceCert(t); !bytes.Equal(payload, cert) {
		t.Fatal("ik-payload.json's payload is not testdata/fleet/certs.json's device blob; regenerate certs.json first, then these vectors")
	}
}

func noiseKey(priv, pub []byte) noise.DHKey { return noise.DHKey{Private: priv, Public: pub} }
