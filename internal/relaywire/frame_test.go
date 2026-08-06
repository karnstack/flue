package relaywire

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"flag"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

var update = flag.Bool("update", false, "regenerate testdata/relay/frames.json")

const fixturePath = "../../testdata/relay/frames.json"

// The fixture file is the cross-language contract: the Worker (relay/) and the
// web client both walk this same JSON, so its shape is fixed and its base64 is
// generated from this package.
type fixtureFile struct {
	ChannelFrames []channelFixture `json:"channelFrames"`
	PlainFrames   []plainFixture   `json:"plainFrames"`
}

type channelFixture struct {
	Name       string `json:"name"`
	Channel    uint32 `json:"channel"`
	PayloadB64 string `json:"payloadB64"`
	EncodedB64 string `json:"encodedB64"`
}

type plainFixture struct {
	Name       string `json:"name"`
	Text       bool   `json:"text"`
	DataB64    string `json:"dataB64"`
	EncodedB64 string `json:"encodedB64"`
}

func TestEncodeDecodeRoundTrip(t *testing.T) {
	cases := []Frame{
		{Channel: 0, Payload: []byte(`{"type":"open","channel":1}`)},
		{Channel: 1, Payload: []byte{0xde, 0xad, 0xbe, 0xef}},
		{Channel: 0xffffffff, Payload: []byte("last channel")},
		{Channel: 3, Payload: nil},
	}
	for _, f := range cases {
		got, err := Decode(Encode(f))
		if err != nil {
			t.Fatalf("Decode(Encode(%v)): %v", f.Channel, err)
		}
		if got.Channel != f.Channel {
			t.Fatalf("channel = %d, want %d", got.Channel, f.Channel)
		}
		if !bytes.Equal(got.Payload, f.Payload) {
			t.Fatalf("payload = % x, want % x", got.Payload, f.Payload)
		}
	}
}

func TestEncodeChannelIsBigEndian(t *testing.T) {
	got := Encode(Frame{Channel: 0x01020304, Payload: []byte{0xaa}})
	want := []byte{0x01, 0x02, 0x03, 0x04, 0xaa}
	if !bytes.Equal(got, want) {
		t.Fatalf("Encode = % x, want % x", got, want)
	}
}

func TestEncodeDoesNotAliasPayload(t *testing.T) {
	payload := []byte{1, 2, 3}
	enc := Encode(Frame{Channel: 1, Payload: payload})
	payload[0] = 9
	if enc[4] != 1 {
		t.Fatalf("mutating the caller's payload changed the encoded frame: % x", enc)
	}
}

func TestDecodeRejectsShortFrame(t *testing.T) {
	for _, b := range [][]byte{nil, {}, {0x00}, {0x00, 0x00, 0x00}} {
		if _, err := Decode(b); err == nil {
			t.Fatalf("Decode(% x) err = nil, want an error", b)
		}
	}
}

// A header with nothing after it is a well-formed frame carrying no payload:
// the length check is < 4, not <= 4, so the TypeScript side must not throw on
// one either.
func TestDecodeAcceptsHeaderOnlyFrame(t *testing.T) {
	f, err := Decode([]byte{0x00, 0x00, 0x00, 0x05})
	if err != nil {
		t.Fatalf("Decode: %v", err)
	}
	if f.Channel != 5 || len(f.Payload) != 0 {
		t.Fatalf("got {%d, % x}, want {5, empty}", f.Channel, f.Payload)
	}
}

func TestPlainRoundTrip(t *testing.T) {
	cases := []struct {
		text bool
		data []byte
	}{
		{true, []byte(`{"type":"list"}`)},
		{false, []byte{0x00, 0x01, 0x02}},
		{true, nil},
		{false, nil},
	}
	for _, c := range cases {
		text, data, err := DecodePlain(EncodePlain(c.text, c.data))
		if err != nil {
			t.Fatalf("DecodePlain(EncodePlain(%v, % x)): %v", c.text, c.data, err)
		}
		if text != c.text {
			t.Fatalf("text = %v, want %v", text, c.text)
		}
		if !bytes.Equal(data, c.data) {
			t.Fatalf("data = % x, want % x", data, c.data)
		}
	}
}

func TestEncodePlainKindByte(t *testing.T) {
	if got := EncodePlain(true, []byte("hi")); !bytes.Equal(got, []byte{0x00, 'h', 'i'}) {
		t.Fatalf("text frame = % x, want 00 68 69", got)
	}
	if got := EncodePlain(false, []byte("hi")); !bytes.Equal(got, []byte{0x01, 'h', 'i'}) {
		t.Fatalf("binary frame = % x, want 01 68 69", got)
	}
}

func TestDecodePlainRejectsEmpty(t *testing.T) {
	for _, b := range [][]byte{nil, {}} {
		if _, _, err := DecodePlain(b); err == nil {
			t.Fatalf("DecodePlain(% x) err = nil, want an error", b)
		}
	}
}

func TestDecodePlainRejectsUnknownKind(t *testing.T) {
	for _, kind := range []byte{0x02, 0x7f, 0xff} {
		if _, _, err := DecodePlain([]byte{kind, 'x'}); err == nil {
			t.Fatalf("DecodePlain with kind %#x err = nil, want an error", kind)
		}
	}
}

// The keepalive strings and the control-channel id cross three languages, so
// they are pinned rather than assumed.
func TestProtocolConstants(t *testing.T) {
	if ControlChannel != 0 {
		t.Fatalf("ControlChannel = %d, want 0", ControlChannel)
	}
	if Ping != "flue-ping" || Pong != "flue-pong" {
		t.Fatalf("keepalive = (%q, %q), want (flue-ping, flue-pong)", Ping, Pong)
	}
}

// A decoded message carries its discriminator in Type, so the value survives
// encode → decode → encode unchanged.
func TestControlRoundTrip(t *testing.T) {
	cases := []struct {
		name string
		typ  string
		msg  any
	}{
		{"open", "open", &Open{Type: "open", Channel: 1, Origin: "https://r.example"}},
		{"closed", "closed", &Closed{Type: "closed", Channel: 1}},
		{"close", "close", &Close{Type: "close", Channel: 1}},
		{"pair", "pair", &Pair{Type: "pair", ID: 9, Origin: "https://r.example",
			Body: json.RawMessage(`{"token":"Zm91cnRlZW4tY2hhcnM","publicKey":"3p7bfXt9wbTTW2HC7OQ1Nz+DQ8hG6YwjhyZxaYQpb8k=","label":"iPhone"}`)}},
		{"pairResult", "pairResult", &PairResult{Type: "pairResult", ID: 9, Status: 200,
			Body: json.RawMessage(`{"deviceId":"d1b2c3d4e5f60718","daemonPub":"3p7bfXt9wbTTW2HC7OQ1Nz+DQ8hG6YwjhyZxaYQpb8k="}`)}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			b, err := EncodeControl(c.msg)
			if err != nil {
				t.Fatalf("EncodeControl: %v", err)
			}
			var probe struct {
				Type string `json:"type"`
			}
			if err := json.Unmarshal(b, &probe); err != nil {
				t.Fatalf("Unmarshal: %v", err)
			}
			if probe.Type != c.typ {
				t.Fatalf("type = %q, want %q", probe.Type, c.typ)
			}
			got, err := DecodeControl(b)
			if err != nil {
				t.Fatalf("DecodeControl: %v", err)
			}
			if !reflect.DeepEqual(got, c.msg) {
				t.Fatalf("round trip = %#v, want %#v", got, c.msg)
			}
		})
	}
}

// EncodeControl fills the discriminator in whether the caller left it blank or
// handed back a value DecodeControl produced, so encode(decode(x)) is stable.
func TestEncodeControlSetsTypeFromConcreteType(t *testing.T) {
	b, err := EncodeControl(&Open{Channel: 4, Origin: "https://r.example"})
	if err != nil {
		t.Fatalf("EncodeControl: %v", err)
	}
	want := `{"type":"open","channel":4,"origin":"https://r.example"}`
	if string(b) != want {
		t.Fatalf("EncodeControl = %s, want %s", b, want)
	}

	// A value, not a pointer, encodes identically: the daemon builds messages
	// on the stack and the decoder hands back pointers.
	bv, err := EncodeControl(Open{Channel: 4, Origin: "https://r.example"})
	if err != nil {
		t.Fatalf("EncodeControl(value): %v", err)
	}
	if string(bv) != want {
		t.Fatalf("EncodeControl(value) = %s, want %s", bv, want)
	}

	// A stale or wrong Type on the input does not survive: the concrete type
	// is the authority.
	bs, err := EncodeControl(&Open{Type: "closed", Channel: 4, Origin: "https://r.example"})
	if err != nil {
		t.Fatalf("EncodeControl(stale type): %v", err)
	}
	if string(bs) != want {
		t.Fatalf("EncodeControl(stale type) = %s, want %s", bs, want)
	}
}

func TestEncodeControlRejectsUnknownMessage(t *testing.T) {
	if _, err := EncodeControl(struct{ X int }{1}); err == nil {
		t.Fatal("EncodeControl of a non-message err = nil, want an error")
	}
}

func TestDecodeControlRejectsUnknownType(t *testing.T) {
	if _, err := DecodeControl([]byte(`{"type":"nope"}`)); err == nil {
		t.Fatal("DecodeControl of an unknown type err = nil, want an error")
	}
	if _, err := DecodeControl([]byte(`not json`)); err == nil {
		t.Fatal("DecodeControl of malformed JSON err = nil, want an error")
	}
}

// The pair body is the browser's JSON verbatim — the relay must not reshape it,
// because the daemon's /api/pair handler parses these bytes itself.
func TestPairBodyIsVerbatim(t *testing.T) {
	body := `{"token":"t","publicKey":"k","label":"iPhone"}`
	msg, err := DecodeControl([]byte(`{"type":"pair","id":3,"origin":"https://r.example","body":` + body + `}`))
	if err != nil {
		t.Fatalf("DecodeControl: %v", err)
	}
	p, ok := msg.(*Pair)
	if !ok {
		t.Fatalf("msg is %T, want *relaywire.Pair", msg)
	}
	if string(p.Body) != body {
		t.Fatalf("body = %s, want %s", p.Body, body)
	}
}

// A refusal body is JSON or it is nothing: PairResult.Body is written straight
// into an HTTP response by the Worker, so the encoder must reject a body that
// is not a JSON value rather than shipping a frame no parser can read. The
// daemon's own /api/pair writes the bare text "pairing refused", so the relay
// path has to wrap it — this is where that gets caught.
func TestEncodeControlRejectsNonJSONBody(t *testing.T) {
	if _, err := EncodeControl(&PairResult{ID: 1, Status: 403, Body: json.RawMessage("pairing refused")}); err == nil {
		t.Fatal("EncodeControl with a non-JSON body err = nil, want an error")
	}
	if _, err := EncodeControl(&PairResult{ID: 1, Status: 403, Body: json.RawMessage(`{"error":"pairing refused"}`)}); err != nil {
		t.Fatalf("EncodeControl with a JSON body: %v", err)
	}
}

// A nil message is a caller's bug, and one that would otherwise panic on the
// daemon's relay writer.
func TestEncodeControlRejectsNilPointer(t *testing.T) {
	if _, err := EncodeControl((*Close)(nil)); err == nil {
		t.Fatal("EncodeControl of a nil *Close err = nil, want an error")
	}
}

// TestGenerateFixtures writes testdata/relay/frames.json from this package.
// The committed file is the artifact; this only regenerates it, and every case
// it emits is asserted by TestFramesAgainstDisk on every ordinary run. It is
// declared before that test so a single `-update` run regenerates and then
// verifies, the order testdata/noise/ik.json's generator uses.
func TestGenerateFixtures(t *testing.T) {
	if !*update {
		t.Skip("run with -update to regenerate")
	}
	mustControl := func(msg any) []byte {
		b, err := EncodeControl(msg)
		if err != nil {
			t.Fatal(err)
		}
		return b
	}

	channels := []struct {
		name    string
		channel uint32
		payload []byte
	}{
		// Channel 0: the control channel, carrying every message of the JSON
		// protocol a Worker has to produce and parse.
		{"control", ControlChannel, mustControl(&Open{Channel: 1, Origin: "https://r.example"})},
		{"control-closed", ControlChannel, mustControl(&Closed{Channel: 1})},
		{"control-close", ControlChannel, mustControl(&Close{Channel: 1})},
		{"control-pair", ControlChannel, mustControl(&Pair{ID: 9, Origin: "https://r.example",
			Body: json.RawMessage(`{"token":"Zm91cnRlZW4tY2hhcnM","publicKey":"3p7bfXt9wbTTW2HC7OQ1Nz+DQ8hG6YwjhyZxaYQpb8k=","label":"iPhone"}`)})},
		{"control-pair-result", ControlChannel, mustControl(&PairResult{ID: 9, Status: 200,
			Body: json.RawMessage(`{"deviceId":"d1b2c3d4e5f60718","daemonPub":"3p7bfXt9wbTTW2HC7OQ1Nz+DQ8hG6YwjhyZxaYQpb8k="}`)})},
		{"control-pair-result-refused", ControlChannel, mustControl(&PairResult{ID: 10, Status: 403,
			Body: json.RawMessage(`{"error":"pairing refused"}`)})},
		// Channels >= 1 carry opaque Noise bytes.
		{"channel-7-bytes", 7, []byte{0xde, 0xad, 0xbe, 0xef}},
		{"channel-1-empty", 1, nil},
		// The high bit set: a decoder that shifts instead of reading an
		// unsigned 32-bit integer gets this one wrong.
		{"channel-max", 0xffffffff, []byte{0x00, 0xff}},
	}
	plains := []struct {
		name string
		text bool
		data []byte
	}{
		{"text", true, []byte(`{"type":"list"}`)},
		{"binary", false, []byte{0x01, 0x02, 0x03, 0x04}},
		// Multi-byte UTF-8: the kind byte is a byte, not a character, so a
		// decoder that slices a decoded string rather than the bytes fails.
		{"text-utf8", true, []byte(`{"type":"input","data":"héllo → 世界"}`)},
		{"text-empty", true, nil},
		{"binary-empty", false, nil},
	}

	var out fixtureFile
	for _, c := range channels {
		out.ChannelFrames = append(out.ChannelFrames, channelFixture{
			Name:       c.name,
			Channel:    c.channel,
			PayloadB64: base64.StdEncoding.EncodeToString(c.payload),
			EncodedB64: base64.StdEncoding.EncodeToString(Encode(Frame{Channel: c.channel, Payload: c.payload})),
		})
	}
	for _, p := range plains {
		out.PlainFrames = append(out.PlainFrames, plainFixture{
			Name:       p.name,
			Text:       p.text,
			DataB64:    base64.StdEncoding.EncodeToString(p.data),
			EncodedB64: base64.StdEncoding.EncodeToString(EncodePlain(p.text, p.data)),
		})
	}

	buf, err := json.MarshalIndent(out, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Dir(fixturePath), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(fixturePath, append(buf, '\n'), 0o644); err != nil {
		t.Fatal(err)
	}
}

// TestFramesAgainstDisk pins the framing the way testdata/noise/ik.json pins
// the handshake: the committed base64 is the contract the Worker and the web
// client are tested against, so a change to either direction fails here first.
func TestFramesAgainstDisk(t *testing.T) {
	raw, err := os.ReadFile(fixturePath)
	if err != nil {
		t.Fatalf("read fixtures (generate with -update): %v", err)
	}
	var f fixtureFile
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatal(err)
	}
	if len(f.ChannelFrames) == 0 || len(f.PlainFrames) == 0 {
		t.Fatal("fixture file has no cases")
	}

	for _, c := range f.ChannelFrames {
		t.Run("channel/"+c.Name, func(t *testing.T) {
			payload, encoded := unb64(t, c.PayloadB64), unb64(t, c.EncodedB64)
			if got := Encode(Frame{Channel: c.Channel, Payload: payload}); !bytes.Equal(got, encoded) {
				t.Fatalf("Encode = % x, want % x", got, encoded)
			}
			got, err := Decode(encoded)
			if err != nil {
				t.Fatalf("Decode: %v", err)
			}
			if got.Channel != c.Channel {
				t.Fatalf("channel = %d, want %d", got.Channel, c.Channel)
			}
			if !bytes.Equal(got.Payload, payload) {
				t.Fatalf("payload = % x, want % x", got.Payload, payload)
			}

			// Channel 0 payloads are control messages, and the fixture pins
			// their bytes for the Worker. Re-deriving them here is what makes
			// a renamed json tag, a reordered field or a changed discriminator
			// fail in Go rather than only in the TypeScript suite.
			if c.Channel != ControlChannel {
				return
			}
			msg, err := DecodeControl(payload)
			if err != nil {
				t.Fatalf("DecodeControl: %v", err)
			}
			reenc, err := EncodeControl(msg)
			if err != nil {
				t.Fatalf("EncodeControl: %v", err)
			}
			if !bytes.Equal(reenc, payload) {
				t.Fatalf("re-encoded control payload = %s, want %s", reenc, payload)
			}
		})
	}

	for _, c := range f.PlainFrames {
		t.Run("plain/"+c.Name, func(t *testing.T) {
			data, encoded := unb64(t, c.DataB64), unb64(t, c.EncodedB64)
			if got := EncodePlain(c.Text, data); !bytes.Equal(got, encoded) {
				t.Fatalf("EncodePlain = % x, want % x", got, encoded)
			}
			text, gotData, err := DecodePlain(encoded)
			if err != nil {
				t.Fatalf("DecodePlain: %v", err)
			}
			if text != c.Text {
				t.Fatalf("text = %v, want %v", text, c.Text)
			}
			if !bytes.Equal(gotData, data) {
				t.Fatalf("data = % x, want % x", gotData, data)
			}
		})
	}
}

// unb64 takes the *testing.T of the test that is running, so a corrupt fixture
// fails the subtest that read it rather than its parent.
func unb64(t *testing.T, s string) []byte {
	t.Helper()
	b, err := base64.StdEncoding.DecodeString(s)
	if err != nil {
		t.Fatalf("bad base64 %q: %v", s, err)
	}
	return b
}
