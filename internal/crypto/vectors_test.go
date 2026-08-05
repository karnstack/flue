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

// capture records every frame either side sends, while still delivering it.
type capture struct {
	pipe *pipe
	msgs [][]byte
}

func TestGenerateVectors(t *testing.T) {
	if !*update {
		t.Skip("run with -update to regenerate")
	}
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
		ch, _, err := ResponderHandshake(rStatic, &detReader{label: []byte("responder-ephemeral")},
			func() ([]byte, error) { b := <-p.a2b; msg1 = b; return b, nil },
			func(b []byte) error { msg2 = b; p.b2a <- b; return nil })
		done <- rres{ch, err}
	}()
	iCh, err := InitiatorHandshake(iStatic, rStatic.Public, &detReader{label: []byte("initiator-ephemeral")}, p.aRecv, p.aSend)
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

	out, err := json.MarshalIndent(vectorFile{
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
	}, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Dir(vectorPath), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(vectorPath, append(out, '\n'), 0o644); err != nil {
		t.Fatal(err)
	}
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
	unhex := func(s string) []byte {
		b, err := hex.DecodeString(s)
		if err != nil {
			t.Fatal(err)
		}
		return b
	}

	// Replay the responder side against the recorded msg1 and assert every
	// byte it produces matches the file.
	rStatic := noiseKey(unhex(v.ResponderStaticPriv), unhex(v.ResponderStaticPub))
	var gotMsg2 []byte
	ch, peer, err := ResponderHandshake(rStatic, &detReader{label: []byte("responder-ephemeral")},
		func() ([]byte, error) { return unhex(v.Msg1), nil },
		func(b []byte) error { gotMsg2 = b; return nil })
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(gotMsg2, unhex(v.Msg2)) {
		t.Fatal("responder produced a different msg2 than the vector file")
	}
	if !bytes.Equal(peer, unhex(v.InitiatorStaticPub)) {
		t.Fatal("responder resolved a different initiator identity")
	}
	for _, m := range v.Transport {
		switch m.Dir {
		case "i2r":
			pt, err := ch.Open(unhex(m.Ciphertext))
			if err != nil || !bytes.Equal(pt, unhex(m.Plaintext)) {
				t.Fatalf("i2r transport message: %v", err)
			}
		case "r2i":
			ct, err := ch.Seal(unhex(m.Plaintext))
			if err != nil || !bytes.Equal(ct, unhex(m.Ciphertext)) {
				t.Fatalf("r2i transport message: %v", err)
			}
		}
	}
}

func noiseKey(priv, pub []byte) noise.DHKey { return noise.DHKey{Private: priv, Public: pub} }
