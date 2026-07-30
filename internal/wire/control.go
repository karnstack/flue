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

// Server -> client control messages.

type Welcome struct {
	DaemonID string   `json:"daemonId"`
	Host     string   `json:"host"`
	Ver      string   `json:"ver"`
	Caps     []string `json:"caps,omitempty"`
}

type Sessions struct {
	Sessions []session.Info `json:"sessions"`
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
	}
	return nil, fmt.Errorf("wire: unknown control message type %q", probe.Type)
}
