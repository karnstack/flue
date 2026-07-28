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
// It verifies field-level fidelity via round-trip: decode the fixture,
// re-encode it, and ensure the JSON round-trips cleanly. This catches
// wrong tags, missing fields, and wrong discriminators.
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
		// Decode the fixture JSON to a concrete message type.
		msg, err := DecodeControl(c.JSON)
		if err != nil {
			t.Errorf("%s: DecodeControl: %v", c.Name, err)
			continue
		}
		// Re-encode the decoded message.
		reenc, err := EncodeControl(msg)
		if err != nil {
			t.Errorf("%s: EncodeControl: %v", c.Name, err)
			continue
		}
		// Compare fixture and re-encoded as maps. This catches wrong tags,
		// dropped fields, and wrong discriminators. Omitempty fields stay
		// absent on both sides, so they do not cause false failures.
		var fixtureMap, reencMap map[string]any
		if err := json.Unmarshal(c.JSON, &fixtureMap); err != nil {
			t.Errorf("%s: unmarshal fixture: %v", c.Name, err)
			continue
		}
		if err := json.Unmarshal(reenc, &reencMap); err != nil {
			t.Errorf("%s: unmarshal re-encoded: %v", c.Name, err)
			continue
		}
		if !deepEqual(fixtureMap, reencMap) {
			t.Errorf("%s: fixture and re-encoded do not match\nfixture: %v\nre-encoded: %v",
				c.Name, fixtureMap, reencMap)
		}
	}
}

// deepEqual recursively compares two any values for equality, handling
// nested maps and slices. Used by TestGoldenControlMessages to verify
// round-trip fidelity while tolerating type differences between JSON
// numbers (int vs float64) and nested structures.
func deepEqual(a, b any) bool {
	switch av := a.(type) {
	case map[string]any:
		bv, ok := b.(map[string]any)
		if !ok {
			return false
		}
		if len(av) != len(bv) {
			return false
		}
		for k, v := range av {
			bv2, ok := bv[k]
			if !ok || !deepEqual(v, bv2) {
				return false
			}
		}
		return true
	case []any:
		bv, ok := b.([]any)
		if !ok {
			return false
		}
		if len(av) != len(bv) {
			return false
		}
		for i := range av {
			if !deepEqual(av[i], bv[i]) {
				return false
			}
		}
		return true
	case float64:
		// JSON unmarshals numbers as float64. Compare with tolerance for
		// integers encoded as JSON numbers.
		bv, ok := b.(float64)
		if !ok {
			return false
		}
		return av == bv
	case string, bool, nil:
		return av == b
	default:
		return av == b
	}
}
