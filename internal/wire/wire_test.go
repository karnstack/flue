package wire

import (
	"bytes"
	"encoding/json"
	"os"
	"testing"
)

func TestBinaryRoundTrip(t *testing.T) {
	enc := EncodeBinary(FrameOutput, 7, []byte("payload"))
	if len(enc) != 5+len("payload") {
		t.Fatalf("len = %d, want %d", len(enc), 5+len("payload"))
	}
	if enc[0] != FrameOutput {
		t.Fatalf("type byte = %#x, want %#x", enc[0], FrameOutput)
	}

	typ, ref, payload, err := DecodeBinary(enc)
	if err != nil {
		t.Fatalf("DecodeBinary: %v", err)
	}
	if typ != FrameOutput || ref != 7 || !bytes.Equal(payload, []byte("payload")) {
		t.Fatalf("got (%#x, %d, %q), want (%#x, 7, %q)", typ, ref, payload, FrameOutput, "payload")
	}
}

func TestBinaryRefIsBigEndian(t *testing.T) {
	enc := EncodeBinary(FrameInput, 0x01020304, nil)
	want := []byte{FrameInput, 0x01, 0x02, 0x03, 0x04}
	if !bytes.Equal(enc, want) {
		t.Fatalf("enc = % x, want % x", enc, want)
	}
}

func TestDecodeBinaryRejectsShortFrame(t *testing.T) {
	for _, b := range [][]byte{nil, {}, {0x00}, {0x00, 1, 2, 3}} {
		if _, _, _, err := DecodeBinary(b); err == nil {
			t.Fatalf("DecodeBinary(% x) err = nil, want an error", b)
		}
	}
}

func TestDecodeBinaryRejectsUnknownType(t *testing.T) {
	if _, _, _, err := DecodeBinary([]byte{0x7f, 0, 0, 0, 0}); err == nil {
		t.Fatal("DecodeBinary with type 0x7f err = nil, want an error")
	}
}

func TestDecodeControlDispatchesByType(t *testing.T) {
	msg, err := DecodeControl([]byte(`{"type":"attach","id":"abc","lastSeq":42}`))
	if err != nil {
		t.Fatalf("DecodeControl: %v", err)
	}
	a, ok := msg.(Attach)
	if !ok {
		t.Fatalf("msg is %T, want wire.Attach", msg)
	}
	if a.ID != "abc" || a.LastSeq != 42 {
		t.Fatalf("got %+v, want {ID:abc LastSeq:42}", a)
	}
}

func TestDecodeControlRejectsUnknownType(t *testing.T) {
	if _, err := DecodeControl([]byte(`{"type":"nope"}`)); err == nil {
		t.Fatal("DecodeControl of an unknown type err = nil, want an error")
	}
}

func TestEncodeControlSetsTypeField(t *testing.T) {
	b, err := EncodeControl(Attached{Ref: 3, ID: "s1", Cols: 80, Rows: 24, Seq: 9})
	if err != nil {
		t.Fatalf("EncodeControl: %v", err)
	}
	var got map[string]any
	if err := json.Unmarshal(b, &got); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}
	if got["type"] != "attached" {
		t.Fatalf("type = %v, want \"attached\"", got["type"])
	}
}

// TestGoldenControlMessages pins the wire format so the Go and TypeScript
// implementations cannot drift. web/src/client decodes this same file.
func TestGoldenControlMessages(t *testing.T) {
	raw, err := os.ReadFile("../../testdata/wire/control.json")
	if err != nil {
		t.Fatalf("read golden: %v", err)
	}
	var cases []struct {
		Name string          `json:"name"`
		JSON json.RawMessage `json:"json"`
	}
	if err := json.Unmarshal(raw, &cases); err != nil {
		t.Fatalf("parse golden: %v", err)
	}
	if len(cases) == 0 {
		t.Fatal("golden file has no cases")
	}
	for _, c := range cases {
		if _, err := DecodeControl(c.JSON); err != nil {
			t.Errorf("%s: DecodeControl: %v", c.Name, err)
		}
	}
}
