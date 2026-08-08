package wire

import (
	"encoding/json"
	"fmt"

	"github.com/karnstack/flue/internal/session"
)

// Client -> server control messages.

type Hello struct {
	Ver  string   `json:"ver"`
	Caps []string `json:"caps,omitempty"`
}

type List struct{}

type Spawn struct {
	Cwd  string   `json:"cwd,omitempty"`
	Cmd  []string `json:"cmd,omitempty"`
	Cols uint16   `json:"cols"`
	Rows uint16   `json:"rows"`
	// ReqID correlates this request with the attached or error answering it.
	// Client-chosen; zero means the client asked for no correlation.
	ReqID uint64 `json:"reqId,omitempty"`
}

type Attach struct {
	ID      string `json:"id"`
	LastSeq uint64 `json:"lastSeq"`
	// ReqID correlates this request with the attached or error answering it.
	ReqID uint64 `json:"reqId,omitempty"`
}

type Detach struct {
	Ref uint32 `json:"ref"`
}

type Resize struct {
	Ref     uint32 `json:"ref"`
	Cols    uint16 `json:"cols"`
	Rows    uint16 `json:"rows"`
	Primary bool   `json:"primary"`
}

type Signal struct {
	Ref uint32 `json:"ref"`
	Sig string `json:"sig"`
}

type CloseSession struct {
	Ref uint32 `json:"ref"`
}

// Update edits the metadata a human owns on a session — its name, its tags,
// whether it is pinned. Nothing the program inside the session says can reach
// these fields, and nothing here touches what that program says.
//
// Partial, and partial by construction: a field this message does not carry is
// a field the edit leaves alone. Two views on one session is the ordinary case,
// so a message that had to restate every field would undo whatever the other
// view changed since this one last read.
//
// Tags is a pointer to a slice for the one distinction a plain []string cannot
// keep: "the user removed the last tag" arrives as `[]` and "this edit is not
// about tags" arrives as nothing, and both decode to a nil slice. The shape
// mirrors session.MetaPatch field for field, so the daemon can hand the patch
// straight to the registry rather than rebuild it — a translation being exactly
// where that distinction would go missing.
//
// Answered by a fresh sessions to every connection, or by error{not_found}.
type Update struct {
	ID     string    `json:"id"`
	Name   *string   `json:"name,omitempty"`
	Tags   *[]string `json:"tags,omitempty"`
	Pinned *bool     `json:"pinned,omitempty"`
}

// Devices asks for the paired-device list.
type Devices struct{}

// Revoke removes a paired device. The daemon answers the requester with a
// fresh deviceList, and the revoked device's own connections with revoked.
type Revoke struct {
	DeviceID string `json:"deviceId"`
}

// PairStart enters pairing mode and is answered by pairing.
type PairStart struct{}

// PairCancel leaves pairing mode, invalidating any outstanding token.
type PairCancel struct{}

// Server -> client control messages.

type Welcome struct {
	DaemonID string   `json:"daemonId"`
	Host     string   `json:"host"`
	Ver      string   `json:"ver"`
	Caps     []string `json:"caps,omitempty"`
	// Relay is how this daemon is reachable from outside the machine, or nil
	// when it is not configured for a relay at all. See RelayInfo.
	Relay *RelayInfo `json:"relay,omitempty"`
}

// RelayInfo is the state of the daemon's relay leg, as of the moment the
// connection carrying it was accepted.
//
// It rides the welcome rather than a message of its own because it is not a
// stream: a client needs it to decide what to render — a QR that names an
// address a phone can reach, an honest "remote access is down" — and the
// connection's own opening frame is when it needs it. A daemon whose relay
// changes state does not push an update; the next connection carries the truth.
//
// A pointer on Welcome, so "no relay configured" is an absent field rather than
// an object saying "off". The client's type is a union of the three statuses,
// and a fourth state — present but empty — is one neither side has a meaning
// for.
type RelayInfo struct {
	// Status is "connecting" while the daemon is dialling and "connected" once
	// the socket is up. "off" is what a daemon with no relay would say and is
	// never sent: it is expressed by omitting Relay entirely.
	Status string `json:"status"`
	// Origin is the https origin the relay serves browsers on — the address a
	// pairing URL names while the relay is up. Empty unless Status is
	// "connected", because a socket that is not up carries nothing.
	Origin string `json:"origin,omitempty"`
	// MachineID is the slot this daemon holds on the relay — the <id> in the
	// /client/<id> URL a browser opens to reach this machine. It comes from
	// relay.json rather than from the socket, so it is present whenever the
	// relay is configured, connecting and connected alike.
	MachineID string `json:"machineId,omitempty"`
	// MachineName is the machine's human label, free text from the same file.
	// For lists and titles, never for URLs — that is what MachineID is for.
	MachineName string `json:"machineName,omitempty"`
}

type Sessions struct {
	Sessions []session.Info `json:"sessions"`
}

// MarshalJSON writes an empty list as [] rather than null, for the reason
// DeviceList does below.
//
// "The daemon is running nothing" is reached by building the zero value — the
// one path a nil slice takes to the wire. The field is not optional and the
// client declares it `SessionInfo[]`, so null would throw in every consumer
// that ranges over the list, and would do it on a fresh machine, which is the
// first list anyone sees.
func (s Sessions) MarshalJSON() ([]byte, error) {
	// The alias sheds this method, so json.Marshal below does not recurse.
	type alias Sessions
	if s.Sessions == nil {
		s.Sessions = []session.Info{}
	}
	return json.Marshal(alias(s))
}

type Attached struct {
	Ref       uint32 `json:"ref"`
	ID        string `json:"id"`
	Cols      uint16 `json:"cols"`
	Rows      uint16 `json:"rows"`
	Title     string `json:"title"`
	Seq       uint64 `json:"seq"`
	Truncated bool   `json:"truncated"`
	// Head is the offset one past the replayed backlog: bytes below Head are
	// history, bytes at or after it are live. Head == Seq means no backlog.
	Head    uint64 `json:"head"`
	Primary bool   `json:"primary"`
	// ReqID echoes the reqId of the attach or spawn this answers.
	ReqID uint64 `json:"reqId,omitempty"`
}

type Exit struct {
	Ref  uint32 `json:"ref"`
	Code int    `json:"code"`
}

type SizeChanged struct {
	Ref     uint32 `json:"ref"`
	Cols    uint16 `json:"cols"`
	Rows    uint16 `json:"rows"`
	Primary bool   `json:"primary"`
}

type Error struct {
	Code string `json:"code"`
	Msg  string `json:"msg"`
	// ReqID echoes the reqId of the request this error answers, when it
	// answers one — not_found and spawn_failed do; a lagged stream does not.
	ReqID uint64 `json:"reqId,omitempty"`
}

// DeviceInfo is one paired device as the wire reports it. Timestamps are unix
// seconds rather than the registry's time.Time, so a client reads them without
// parsing RFC 3339.
type DeviceInfo struct {
	ID       string `json:"id"`
	Label    string `json:"label"`
	PairedAt int64  `json:"pairedAt"`
	LastSeen int64  `json:"lastSeen"`
}

// DeviceList answers devices, and follows a revoke that succeeded.
type DeviceList struct {
	Devices []DeviceInfo `json:"devices"`
}

// MarshalJSON writes an empty list as [] rather than null.
//
// A nil slice marshals to null by default, and "no devices are paired" is the
// one state a caller reaches by building the zero value — precisely the path
// that would ship null. The field is not optional and the client declares it
// `DeviceInfo[]`, so null would throw in every consumer that ranges over it.
// Normalising here rather than at each call site means no producer can get it
// wrong.
func (d DeviceList) MarshalJSON() ([]byte, error) {
	// The alias sheds this method, so json.Marshal below does not recurse.
	type alias DeviceList
	if d.Devices == nil {
		d.Devices = []DeviceInfo{}
	}
	return json.Marshal(alias(d))
}

// Pairing answers pairStart with the credentials the second device needs.
type Pairing struct {
	Token string `json:"token"`
	// URL is absolute: the /pair page on this origin, carrying the token.
	URL string `json:"url"`
	// DaemonPub is the daemon's static public key, base64.
	DaemonPub string `json:"daemonPub"`
	// ExpiresAt is unix seconds. The token is single-use and short-lived.
	ExpiresAt int64 `json:"expiresAt"`
}

// Revoked goes to the revoked device's own connections just before the daemon
// closes them, so the tab can say why rather than showing a bare disconnect.
type Revoked struct {
	Reason string `json:"reason"`
}

// typeName maps a message value to its wire discriminator.
func typeName(msg any) (string, bool) {
	switch msg.(type) {
	case Hello:
		return "hello", true
	case List:
		return "list", true
	case Spawn:
		return "spawn", true
	case Attach:
		return "attach", true
	case Detach:
		return "detach", true
	case Resize:
		return "resize", true
	case Signal:
		return "signal", true
	case CloseSession:
		return "close", true
	case Update:
		return "update", true
	case Devices:
		return "devices", true
	case Revoke:
		return "revoke", true
	case PairStart:
		return "pairStart", true
	case PairCancel:
		return "pairCancel", true
	case Welcome:
		return "welcome", true
	case Sessions:
		return "sessions", true
	case Attached:
		return "attached", true
	case Exit:
		return "exit", true
	case SizeChanged:
		return "sizeChanged", true
	case Error:
		return "error", true
	case DeviceList:
		return "deviceList", true
	case Pairing:
		return "pairing", true
	case Revoked:
		return "revoked", true
	}
	return "", false
}

// EncodeControl marshals msg and injects its "type" discriminator.
func EncodeControl(msg any) ([]byte, error) {
	name, ok := typeName(msg)
	if !ok {
		return nil, fmt.Errorf("wire: %T is not a control message", msg)
	}
	body, err := json.Marshal(msg)
	if err != nil {
		return nil, err
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(body, &fields); err != nil {
		return nil, err
	}
	fields["type"] = json.RawMessage(`"` + name + `"`)
	return json.Marshal(fields)
}

// DecodeControl parses a control message into its concrete type.
func DecodeControl(b []byte) (any, error) {
	var probe struct {
		Type string `json:"type"`
	}
	if err := json.Unmarshal(b, &probe); err != nil {
		return nil, err
	}

	into := func(v any) (any, error) {
		if err := json.Unmarshal(b, v); err != nil {
			return nil, err
		}
		return v, nil
	}
	deref := func(v any, err error) (any, error) {
		if err != nil {
			return nil, err
		}
		switch t := v.(type) {
		case *Hello:
			return *t, nil
		case *List:
			return *t, nil
		case *Spawn:
			return *t, nil
		case *Attach:
			return *t, nil
		case *Detach:
			return *t, nil
		case *Resize:
			return *t, nil
		case *Signal:
			return *t, nil
		case *CloseSession:
			return *t, nil
		case *Update:
			return *t, nil
		case *Devices:
			return *t, nil
		case *Revoke:
			return *t, nil
		case *PairStart:
			return *t, nil
		case *PairCancel:
			return *t, nil
		case *Welcome:
			return *t, nil
		case *Sessions:
			return *t, nil
		case *Attached:
			return *t, nil
		case *Exit:
			return *t, nil
		case *SizeChanged:
			return *t, nil
		case *Error:
			return *t, nil
		case *DeviceList:
			return *t, nil
		case *Pairing:
			return *t, nil
		case *Revoked:
			return *t, nil
		}
		return nil, fmt.Errorf("wire: unhandled message %T", v)
	}

	switch probe.Type {
	case "hello":
		return deref(into(&Hello{}))
	case "list":
		return deref(into(&List{}))
	case "spawn":
		return deref(into(&Spawn{}))
	case "attach":
		return deref(into(&Attach{}))
	case "detach":
		return deref(into(&Detach{}))
	case "resize":
		return deref(into(&Resize{}))
	case "signal":
		return deref(into(&Signal{}))
	case "close":
		return deref(into(&CloseSession{}))
	case "update":
		return deref(into(&Update{}))
	case "devices":
		return deref(into(&Devices{}))
	case "revoke":
		return deref(into(&Revoke{}))
	case "pairStart":
		return deref(into(&PairStart{}))
	case "pairCancel":
		return deref(into(&PairCancel{}))
	case "welcome":
		return deref(into(&Welcome{}))
	case "sessions":
		return deref(into(&Sessions{}))
	case "attached":
		return deref(into(&Attached{}))
	case "exit":
		return deref(into(&Exit{}))
	case "sizeChanged":
		return deref(into(&SizeChanged{}))
	case "error":
		return deref(into(&Error{}))
	case "deviceList":
		return deref(into(&DeviceList{}))
	case "pairing":
		return deref(into(&Pairing{}))
	case "revoked":
		return deref(into(&Revoked{}))
	}
	return nil, fmt.Errorf("wire: unknown control message type %q", probe.Type)
}
