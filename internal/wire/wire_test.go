package wire

import (
	"bytes"
	"encoding/json"
	"os"
	"reflect"
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

// TestErrorCarriesReqID pins the half FOLLOW-UPS calls mandatory: not_found
// arrives as an error, so a correlation id on attached alone leaves that
// consumer a heuristic.
func TestErrorCarriesReqID(t *testing.T) {
	b, err := EncodeControl(Error{Code: "not_found", Msg: "no such session", ReqID: 7})
	if err != nil {
		t.Fatalf("EncodeControl: %v", err)
	}
	var got map[string]any
	if err := json.Unmarshal(b, &got); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}
	if got["reqId"] != float64(7) {
		t.Fatalf("reqId = %v, want 7", got["reqId"])
	}

	// And a zero reqId is absent, not zero: a request that asked for no
	// correlation is answered exactly as before.
	b, err = EncodeControl(Error{Code: "lagged", Msg: "fell behind"})
	if err != nil {
		t.Fatalf("EncodeControl: %v", err)
	}
	got = nil
	if err := json.Unmarshal(b, &got); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}
	if _, present := got["reqId"]; present {
		t.Fatalf("zero reqId was encoded: %s", b)
	}
}

func TestAttachRoundTripsReqID(t *testing.T) {
	msg, err := DecodeControl([]byte(`{"type":"attach","id":"abc","lastSeq":42,"reqId":9}`))
	if err != nil {
		t.Fatalf("DecodeControl: %v", err)
	}
	a, ok := msg.(Attach)
	if !ok {
		t.Fatalf("msg is %T, want wire.Attach", msg)
	}
	if a.ReqID != 9 {
		t.Fatalf("ReqID = %d, want 9", a.ReqID)
	}
}

// TestControlRoundTripsDeviceAndPairingMessages pins the device and pairing
// messages the way Spawn and Attached are pinned above: encode, read back the
// discriminator, decode, and compare the value whole. A missing tag, a struct
// left out of typeName, or a decoder that returns the wrong concrete type all
// fail here rather than at the daemon.
func TestControlRoundTripsDeviceAndPairingMessages(t *testing.T) {
	cases := []struct {
		name string
		typ  string
		msg  any
	}{
		{"devices", "devices", Devices{}},
		{"revoke", "revoke", Revoke{DeviceID: "d1b2c3d4e5f60718"}},
		{"pairStart", "pairStart", PairStart{}},
		{"pairCancel", "pairCancel", PairCancel{}},
		{"deviceList", "deviceList", DeviceList{Devices: []DeviceInfo{
			{ID: "d1b2c3d4e5f60718", Label: "iPhone", PairedAt: 1754380800, LastSeen: 1754384400},
			{ID: "d9a8b7c6d5e4f302", Label: "iPad", PairedAt: 1754294400, LastSeen: 1754298000},
		}}},
		{"pairing", "pairing", Pairing{
			Token:     "Zm91cnRlZW4tY2hhcnM",
			URL:       "https://macbook.local:7717/pair?t=Zm91cnRlZW4tY2hhcnM",
			DaemonPub: "3p7bfXt9wbTTW2HC7OQ1Nz+DQ8hG6YwjhyZxaYQpb8k=",
			ExpiresAt: 1754384520,
		}},
		{"revoked", "revoked", Revoked{Reason: "revoked by another device"}},
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
