package relaywire

import (
	"encoding/json"
	"fmt"
)

// Control messages travel on channel 0 as single JSON objects, one per frame,
// discriminated by "type". They are the only thing the relay and the daemon say
// to each other in the clear: everything about a browser's session is opaque
// ciphertext on its own channel.

// Wire discriminators. They are the contract with the Worker, so they live in
// one place rather than being spelled out at each call site.
const (
	typeOpen       = "open"
	typeClosed     = "closed"
	typeClose      = "close"
	typePair       = "pair"
	typePairResult = "pairResult"
)

// Open tells the daemon a browser connected and was assigned Channel. Origin is
// the Worker's own origin, which the daemon checks against the relay it dialled.
//
// relay -> daemon.
type Open struct {
	Type    string `json:"type"` // "open"
	Channel uint32 `json:"channel"`
	Origin  string `json:"origin"`
}

// Closed tells the daemon that browser went away.
//
// relay -> daemon.
type Closed struct {
	Type    string `json:"type"` // "closed"
	Channel uint32 `json:"channel"`
}

// Close asks the relay to close that browser's socket.
//
// daemon -> relay.
type Close struct {
	Type    string `json:"type"` // "close"
	Channel uint32 `json:"channel"`
}

// Pair carries an HTTP POST /api/pair the Worker received. Body is the client's
// JSON verbatim — the daemon's pairing handler parses these bytes itself, so
// the relay must not reshape them. ID correlates the answer.
//
// relay -> daemon.
type Pair struct {
	Type   string          `json:"type"` // "pair"
	ID     uint64          `json:"id"`
	Origin string          `json:"origin"`
	Body   json.RawMessage `json:"body"`
}

// PairResult answers a Pair with the HTTP status and response body the Worker
// should write back to the browser.
//
// daemon -> relay.
type PairResult struct {
	Type   string          `json:"type"` // "pairResult"
	ID     uint64          `json:"id"`
	Status int             `json:"status"`
	Body   json.RawMessage `json:"body"`
}

// EncodeControl marshals a control message, setting "type" from the concrete
// Go type. Both values and pointers are accepted, so a message DecodeControl
// returned can be handed straight back, and whatever the caller left in the
// Type field is overwritten: the concrete type is the authority.
//
// Unlike internal/wire's encoder this marshals the struct directly rather than
// round-tripping through a map, which keeps the field order the declarations
// give — "type" first — so the bytes match what the TypeScript side writes by
// hand and the shared fixtures can pin them.
func EncodeControl(msg any) ([]byte, error) {
	switch m := msg.(type) {
	case *Open:
		return EncodeControl(*m)
	case *Closed:
		return EncodeControl(*m)
	case *Close:
		return EncodeControl(*m)
	case *Pair:
		return EncodeControl(*m)
	case *PairResult:
		return EncodeControl(*m)
	case Open:
		m.Type = typeOpen
		return json.Marshal(m)
	case Closed:
		m.Type = typeClosed
		return json.Marshal(m)
	case Close:
		m.Type = typeClose
		return json.Marshal(m)
	case Pair:
		m.Type = typePair
		return json.Marshal(m)
	case PairResult:
		m.Type = typePairResult
		return json.Marshal(m)
	}
	return nil, fmt.Errorf("relaywire: %T is not a control message", msg)
}

// DecodeControl parses a control message into its concrete type, returning one
// of *Open, *Closed, *Close, *Pair or *PairResult. An unknown discriminator is
// an error rather than a silent drop: on this channel every message is one the
// two ends agreed on, so an unrecognised one means the peers disagree about
// the protocol.
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

	switch probe.Type {
	case typeOpen:
		return into(&Open{})
	case typeClosed:
		return into(&Closed{})
	case typeClose:
		return into(&Close{})
	case typePair:
		return into(&Pair{})
	case typePairResult:
		return into(&PairResult{})
	}
	return nil, fmt.Errorf("relaywire: unknown control message type %q", probe.Type)
}
