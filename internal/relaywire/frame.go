// Package relaywire defines the framing that crosses the daemon↔relay socket.
//
// It is the one place the relay's byte layout is written down for Go; the
// Cloudflare Worker and the web client implement the same layout and are held
// to it by the shared fixtures in testdata/relay/frames.json. Nothing here
// knows about WebSockets, Noise, or the wire protocol carried inside — it is
// framing only, so all three implementations can be compared byte for byte.
//
// Two layers stack:
//
//	[4-byte big-endian channel][payload]   the daemon↔relay socket
//	[1-byte kind][wire bytes]              inside a decrypted channel payload
//
// See spec/relay-protocol.md for the protocol these frames carry.
package relaywire

import (
	"encoding/binary"
	"errors"
	"fmt"
)

// ControlChannel is the channel id reserved for the JSON control messages in
// control.go. Every other channel carries one browser's Noise session.
const ControlChannel uint32 = 0

// Ping and Pong are the keepalive text frames. They are never channel-framed:
// either leg may send Ping, the edge answers Pong through the Durable Object's
// auto-response, and a receiver drops Pong silently.
const (
	Ping = "flue-ping"
	Pong = "flue-pong"
)

// headerLen is the width of the channel header.
const headerLen = 4

// ErrShortFrame is returned by Decode for a frame with no room for the header.
var ErrShortFrame = errors.New("relaywire: frame shorter than the channel header")

// ErrEmptyPayload is returned by DecodePlain for a payload with no kind byte.
var ErrEmptyPayload = errors.New("relaywire: plain payload has no kind byte")

// Kind bytes for the text/binary distinction the wire protocol depends on.
const (
	kindText   byte = 0
	kindBinary byte = 1
)

// Frame is one message on the daemon↔relay socket: a channel id and the bytes
// carried on it. On channel 0 the payload is a control message; on any other
// channel it is a Noise handshake message or transport ciphertext, which this
// package never inspects.
type Frame struct {
	Channel uint32
	Payload []byte
}

// Encode lays a frame out as [4-byte big-endian channel][payload]. The result
// is freshly allocated, so a caller may keep mutating the payload it passed.
func Encode(f Frame) []byte {
	out := make([]byte, headerLen+len(f.Payload))
	binary.BigEndian.PutUint32(out[:headerLen], f.Channel)
	copy(out[headerLen:], f.Payload)
	return out
}

// Decode parses a framed message. The returned payload aliases b, so a caller
// that retains it past the read buffer's lifetime must copy it.
//
// A frame that is exactly a header is well formed and carries no payload; only
// a frame too short to hold the header is an error.
func Decode(b []byte) (Frame, error) {
	if len(b) < headerLen {
		return Frame{}, ErrShortFrame
	}
	return Frame{
		Channel: binary.BigEndian.Uint32(b[:headerLen]),
		Payload: b[headerLen:],
	}, nil
}

// EncodePlain prefixes the kind byte that survives the trip through Noise.
//
// The wire protocol distinguishes text frames (JSON control) from binary ones
// (terminal data), a distinction the WebSocket gives us locally and encryption
// erases: through the relay every frame is one binary WebSocket message of
// ciphertext. This byte carries it, so the layer above the relay reads the same
// (text, data) pair it reads locally.
func EncodePlain(text bool, data []byte) []byte {
	out := make([]byte, 1+len(data))
	if text {
		out[0] = kindText
	} else {
		out[0] = kindBinary
	}
	copy(out[1:], data)
	return out
}

// DecodePlain splits a decrypted channel payload into its kind and its bytes.
// The returned data aliases b. An empty payload, or a kind byte other than 0
// or 1, is a protocol error: the peer is not speaking this protocol, and
// guessing would hand the layer above a frame of the wrong sort.
func DecodePlain(b []byte) (text bool, data []byte, err error) {
	if len(b) == 0 {
		return false, nil, ErrEmptyPayload
	}
	switch b[0] {
	case kindText:
		return true, b[1:], nil
	case kindBinary:
		return false, b[1:], nil
	}
	return false, nil, fmt.Errorf("relaywire: unknown kind byte %#x", b[0])
}
