package wire

import (
	"bytes"
	"encoding/json"
	"os"
	"reflect"
	"strings"
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

// TestFileFramesRoundTrip pins the third frame type. Content rides the binary
// half rather than a base64 field on a control message: a 32 KiB chunk costs
// 43 KiB as base64 inside JSON, and the client already has a decoder for this
// layout.
func TestFileFramesRoundTrip(t *testing.T) {
	payload := []byte("package main\n")
	frame := EncodeBinary(FrameFile, 9, payload)

	typ, ref, got, err := DecodeBinary(frame)
	if err != nil {
		t.Fatalf("DecodeBinary: %v", err)
	}
	if typ != FrameFile {
		t.Errorf("type = %#x, want %#x", typ, FrameFile)
	}
	if ref != 9 {
		t.Errorf("ref = %d, want 9", ref)
	}
	if string(got) != string(payload) {
		t.Errorf("payload = %q, want %q", got, payload)
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
			URL:       "https://macbook.local:7717/pair?t=Zm91cnRlZW4tY2hhcnM&k=3p7bfXt9wbTTW2HC7OQ1Nz-DQ8hG6YwjhyZxaYQpb8k",
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

// TestWelcomeCarriesRelayStatus pins the field a client reads to know whether
// this daemon is reachable from outside the machine, and in particular that a
// daemon with no relay sends no `relay` key at all rather than an object
// claiming to be off. The TypeScript type declares it optional; a value that is
// present but empty is a third state neither side has a meaning for.
func TestWelcomeCarriesRelayStatus(t *testing.T) {
	b, err := EncodeControl(Welcome{
		DaemonID: "local", Host: "macbook", Ver: "0.1.0",
		Relay: &RelayInfo{
			Status: "connected", Origin: "https://flue-relay.example",
			MachineID: "karns-macbook-pro-a1b2", MachineName: "Karn's MacBook Pro",
		},
	})
	if err != nil {
		t.Fatalf("EncodeControl: %v", err)
	}
	var got map[string]any
	if err := json.Unmarshal(b, &got); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}
	relay, ok := got["relay"].(map[string]any)
	if !ok {
		t.Fatalf("welcome carried no relay object: %s", b)
	}
	if relay["status"] != "connected" || relay["origin"] != "https://flue-relay.example" {
		t.Fatalf("relay = %v, want {status:connected origin:https://flue-relay.example}", relay)
	}
	// The machine's identity on the relay, for the client that builds
	// /client/<id> URLs out of it: camelCase on the wire like every other
	// field, whatever relay.json spells them.
	if relay["machineId"] != "karns-macbook-pro-a1b2" || relay["machineName"] != "Karn's MacBook Pro" {
		t.Fatalf("relay = %v, want machineId karns-macbook-pro-a1b2 and machineName Karn's MacBook Pro", relay)
	}

	msg, err := DecodeControl(b)
	if err != nil {
		t.Fatalf("DecodeControl: %v", err)
	}
	w, ok := msg.(Welcome)
	if !ok {
		t.Fatalf("msg is %T, want wire.Welcome", msg)
	}
	if w.Relay == nil {
		t.Fatal("decoded welcome dropped the relay field")
	}
	if w.Relay.Status != "connected" || w.Relay.Origin != "https://flue-relay.example" {
		t.Fatalf("decoded relay = %+v, want {connected https://flue-relay.example}", *w.Relay)
	}
	if w.Relay.MachineID != "karns-macbook-pro-a1b2" || w.Relay.MachineName != "Karn's MacBook Pro" {
		t.Fatalf("decoded relay = %+v, want the machine id and name to round-trip", *w.Relay)
	}

	// A relay that is merely dialling has no origin to name, and the field is
	// omitted rather than sent empty.
	b, err = EncodeControl(Welcome{DaemonID: "local", Relay: &RelayInfo{Status: "connecting"}})
	if err != nil {
		t.Fatalf("EncodeControl: %v", err)
	}
	got = nil
	if err := json.Unmarshal(b, &got); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}
	// Asserted before it is probed: a missing relay object reads as a nil map,
	// and every "the origin is absent" check on a nil map passes for the wrong
	// reason — including one run against an encoder that dropped the field
	// altogether.
	relay, ok = got["relay"].(map[string]any)
	if !ok {
		t.Fatalf("a connecting relay carried no relay object: %s", b)
	}
	if _, present := relay["origin"]; present {
		t.Fatalf("a connecting relay carried an origin: %s", b)
	}
	if relay["status"] != "connecting" {
		t.Fatalf("relay status = %v, want connecting", relay["status"])
	}

	// And a daemon with no relay at all sends no relay key.
	b, err = EncodeControl(Welcome{DaemonID: "local", Host: "macbook", Ver: "0.1.0"})
	if err != nil {
		t.Fatalf("EncodeControl: %v", err)
	}
	got = nil
	if err := json.Unmarshal(b, &got); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}
	if _, present := got["relay"]; present {
		t.Fatalf("a daemon with no relay encoded one: %s", b)
	}
}

// TestDeviceListEncodesEmptyAsArray enforces the invariant the fixture's
// deviceListEmpty case only illustrates: a daemon with nothing paired sends
// [], never null. `devices` is not optional, and the TypeScript side declares
// it `DeviceInfo[]`, so a nil slice reaching the wire would throw in every
// consumer that maps over the list — with the whole fixture suite still green,
// because a fixture pins what is written down, not what a caller may build.
func TestDeviceListEncodesEmptyAsArray(t *testing.T) {
	b, err := EncodeControl(DeviceList{})
	if err != nil {
		t.Fatalf("EncodeControl: %v", err)
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(b, &fields); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}
	if string(fields["devices"]) != "[]" {
		t.Fatalf("devices = %s, want []", fields["devices"])
	}

	// And it survives the trip back: a client decoding an empty list holds an
	// empty slice, not a nil one, so ranging over it is safe on both sides.
	msg, err := DecodeControl(b)
	if err != nil {
		t.Fatalf("DecodeControl: %v", err)
	}
	dl, ok := msg.(DeviceList)
	if !ok {
		t.Fatalf("msg is %T, want wire.DeviceList", msg)
	}
	if dl.Devices == nil {
		t.Fatal("decoded Devices is nil, want an empty slice")
	}
	if len(dl.Devices) != 0 {
		t.Fatalf("decoded Devices has %d entries, want 0", len(dl.Devices))
	}
}

// TestUpdateRoundTripsPartialFields pins what a partial edit looks like on the
// wire: the fields the message names travel, and the ones it does not are
// absent rather than sent as zeroes. An Update that encoded its whole struct
// would tell the daemon "the name is now empty" every time a client only meant
// to pin a session.
func TestUpdateRoundTripsPartialFields(t *testing.T) {
	name := "api server"
	tags := []string{"api", "feat-x"}
	cleared := []string{}
	pinned := true

	cases := []struct {
		name    string
		msg     Update
		present []string // keys the encoding must carry
		absent  []string // and keys it must not
	}{
		{
			name:    "nameOnly",
			msg:     Update{ID: "a1b2c3d4e5f60708", Name: &name},
			present: []string{"id", "name"},
			absent:  []string{"tags", "pinned"},
		},
		{
			name:    "tagsAndPinned",
			msg:     Update{ID: "a1b2c3d4e5f60708", Tags: &tags, Pinned: &pinned},
			present: []string{"id", "tags", "pinned"},
			absent:  []string{"name"},
		},
		{
			name:    "clearTags",
			msg:     Update{ID: "a1b2c3d4e5f60708", Tags: &cleared},
			present: []string{"id", "tags"},
			absent:  []string{"name", "pinned"},
		},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			b, err := EncodeControl(c.msg)
			if err != nil {
				t.Fatalf("EncodeControl: %v", err)
			}
			var fields map[string]json.RawMessage
			if err := json.Unmarshal(b, &fields); err != nil {
				t.Fatalf("Unmarshal: %v", err)
			}
			if string(fields["type"]) != `"update"` {
				t.Fatalf("type = %s, want \"update\"", fields["type"])
			}
			for _, k := range c.present {
				if _, ok := fields[k]; !ok {
					t.Errorf("encoding dropped %q: %s", k, b)
				}
			}
			for _, k := range c.absent {
				if _, ok := fields[k]; ok {
					t.Errorf("encoding carried %q, which this edit does not name: %s", k, b)
				}
			}

			got, err := DecodeControl(b)
			if err != nil {
				t.Fatalf("DecodeControl: %v", err)
			}
			u, ok := got.(Update)
			if !ok {
				t.Fatalf("msg is %T, want wire.Update", got)
			}
			// DeepEqual follows pointers, so this compares what each field
			// points at — and a nil pointer against a non-nil one fails, which
			// is the comparison that matters here.
			if !reflect.DeepEqual(u, c.msg) {
				t.Fatalf("round trip = %#v, want %#v", u, c.msg)
			}
		})
	}
}

// TestUpdateKeepsClearedTagsDistinctFromAbsent is the reason Tags is a pointer
// to a slice rather than a slice.
//
// "The user removed the last tag" and "this edit is not about tags" arrive as
// different JSON — `[]` and nothing — and a plain []string decodes both to nil,
// which would make clearing a session's tags a request the daemon silently
// drops. Decoded from raw text rather than from a value this test encoded
// first, because raw text is what a client sends.
func TestUpdateKeepsClearedTagsDistinctFromAbsent(t *testing.T) {
	msg, err := DecodeControl([]byte(`{"type":"update","id":"s1","tags":[]}`))
	if err != nil {
		t.Fatalf("DecodeControl: %v", err)
	}
	u, ok := msg.(Update)
	if !ok {
		t.Fatalf("msg is %T, want wire.Update", msg)
	}
	if u.Tags == nil {
		t.Fatal("an explicit empty tag list decoded as absent")
	}
	if *u.Tags == nil {
		t.Fatal("cleared tags decoded to a nil slice, want an empty non-nil one")
	}
	if len(*u.Tags) != 0 {
		t.Fatalf("cleared tags have %d entries, want 0", len(*u.Tags))
	}

	msg, err = DecodeControl([]byte(`{"type":"update","id":"s1","pinned":true}`))
	if err != nil {
		t.Fatalf("DecodeControl: %v", err)
	}
	u, ok = msg.(Update)
	if !ok {
		t.Fatalf("msg is %T, want wire.Update", msg)
	}
	if u.Tags != nil {
		t.Fatalf("an edit that never mentioned tags decoded Tags as %v", *u.Tags)
	}
	if u.Name != nil {
		t.Fatalf("an edit that never mentioned a name decoded Name as %q", *u.Name)
	}
	if u.Pinned == nil || !*u.Pinned {
		t.Fatalf("Pinned = %v, want a pointer to true", u.Pinned)
	}
}

// TestCloseSessionCarriesOneAddress pins the two ways a close can name its
// target, and that each encoding carries only the address it was given. A ref
// is a connection-scoped attachment handle; an id is the session itself, for
// the list screen that closes without ever attaching. An encoder that wrote
// `ref: 0` beside an id would hand the daemon two addresses — one of them a
// value no attachment ever holds, since refs are numbered from 1.
func TestCloseSessionCarriesOneAddress(t *testing.T) {
	cases := []struct {
		name    string
		msg     CloseSession
		present []string
		absent  []string
	}{
		{"byRef", CloseSession{Ref: 3}, []string{"ref"}, []string{"id"}},
		{"byID", CloseSession{ID: "a1b2c3d4e5f60708"}, []string{"id"}, []string{"ref"}},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			b, err := EncodeControl(c.msg)
			if err != nil {
				t.Fatalf("EncodeControl: %v", err)
			}
			var fields map[string]json.RawMessage
			if err := json.Unmarshal(b, &fields); err != nil {
				t.Fatalf("Unmarshal: %v", err)
			}
			if string(fields["type"]) != `"close"` {
				t.Fatalf("type = %s, want \"close\"", fields["type"])
			}
			for _, k := range c.present {
				if _, ok := fields[k]; !ok {
					t.Errorf("encoding dropped %q: %s", k, b)
				}
			}
			for _, k := range c.absent {
				if _, ok := fields[k]; ok {
					t.Errorf("encoding carried %q, which this close does not name: %s", k, b)
				}
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

// TestSessionsEncodesEmptyAsArray holds `sessions` to the invariant deviceList
// already keeps: a daemon with nothing running sends [], never null. The field
// is not optional, the TypeScript side declares it `SessionInfo[]`, and the
// zero value — which is how "no sessions" is reached — is the one path that
// would put a null in front of every consumer that maps over the list.
func TestSessionsEncodesEmptyAsArray(t *testing.T) {
	b, err := EncodeControl(Sessions{})
	if err != nil {
		t.Fatalf("EncodeControl: %v", err)
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(b, &fields); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}
	if string(fields["sessions"]) != "[]" {
		t.Fatalf("sessions = %s, want []", fields["sessions"])
	}

	// And it survives the trip back, so ranging over it is safe on both sides.
	msg, err := DecodeControl(b)
	if err != nil {
		t.Fatalf("DecodeControl: %v", err)
	}
	s, ok := msg.(Sessions)
	if !ok {
		t.Fatalf("msg is %T, want wire.Sessions", msg)
	}
	if s.Sessions == nil {
		t.Fatal("decoded Sessions is nil, want an empty slice")
	}
	if len(s.Sessions) != 0 {
		t.Fatalf("decoded Sessions has %d entries, want 0", len(s.Sessions))
	}
}

// TestStatsEncodesAnEmptyListAsAList follows Sessions and DeviceList: a nil
// slice marshals to null, the client declares the field an array, and "none of
// these paths exist" is reached by building the zero value — precisely the
// path that would ship null.
func TestStatsEncodesAnEmptyListAsAList(t *testing.T) {
	b, err := EncodeControl(Stats{ReqID: 3})
	if err != nil {
		t.Fatalf("EncodeControl: %v", err)
	}
	if !strings.Contains(string(b), `"entries":[]`) {
		t.Errorf("encoded = %s, want an empty entries array", b)
	}
}

// TestFileAndReadRoundTrip pins the read half's discriminators and fields.
func TestFileAndReadRoundTrip(t *testing.T) {
	for _, msg := range []any{
		Stat{ID: "s1", Paths: []string{"internal/wire/binary.go"}, ReqID: 4},
		// Populated on purpose, and every field of the entry with it: this is
		// the only test that decodes a stats, so both of the sites that fail at
		// runtime rather than at compile time — the discriminator case and the
		// deref case — are covered here or nowhere, and every PathEntry field
		// is shown surviving the trip rather than being quietly dropped.
		//
		// What a round trip cannot catch is a tag *renamed on both sides at
		// once: encode and decode agree, and the daemon then speaks a dialect
		// no client understands. Spelling is the golden fixture's job.
		//
		// The *empty* stats cannot join this table. MarshalJSON turns a nil
		// Entries into [], which decodes back to a non-nil empty slice, so
		// DeepEqual fails on a message that is perfectly correct — the same
		// asymmetry Sessions and DeviceList have. It is pinned by
		// TestStatsEncodesAnEmptyListAsAList instead, which only encodes.
		Stats{Entries: []PathEntry{{Path: "~/notes.md", Exists: true, Kind: "file", Size: 120, Mtime: 1762800000}}, ReqID: 4},
		Read{ID: "s1", Path: "~/notes.md", ReqID: 5},
		Cancel{Ref: 9},
		File{Ref: 9, Path: "/home/karn/notes.md", Size: 120, Mime: "text/plain; charset=utf-8", Kind: "text", ReqID: 5},
		Eof{Ref: 9},
	} {
		b, err := EncodeControl(msg)
		if err != nil {
			t.Fatalf("EncodeControl(%T): %v", msg, err)
		}
		got, err := DecodeControl(b)
		if err != nil {
			t.Fatalf("DecodeControl(%T): %v", msg, err)
		}
		if !reflect.DeepEqual(got, msg) {
			t.Errorf("round trip of %T = %#v, want %#v", msg, got, msg)
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
