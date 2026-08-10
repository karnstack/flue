package crypto

import (
	"crypto/rand"
	"fmt"
	"io"

	"github.com/flynn/noise"
)

// IK, message by message:
//   <- s            (pre-message: the initiator knows the daemon's static key
//                    from the pairing QR — that is the pinning)
//   -> e, es, s, ss [payload]
//   <- e, ee, se
// Two messages, then both sides hold a pair of CipherStates.
//
// Message A's payload is encrypted — under keys mixed from es and ss, so
// only the pinned responder can read it and only a sender holding the static
// key it announces could have sealed it — and it is where the initiator
// presents its fleet device certificate (spec/fleet-trust.md): empty means
// none, anything else must be exactly one signed cert blob. The payload is
// carried and returned here verbatim; judging it is the transport's job
// (internal/transport/relay/channel.go), because "no cert" is a fine
// handshake and only the acceptance rule knows whether it is a fine client.
//
// One honest caveat the acceptance rule lives with: message A, bytes and
// payload, can be replayed by an observer. A replayer cannot finish the
// session — it never learns the ephemeral behind e — so what a replay buys
// is re-presenting a cert that was already presented, which re-admits a key
// that was already admitted: idempotent, and revocation is checked on every
// presentation.

// InitiatorHandshake runs the browser side of the handshake, sending payload
// in message A (nil for none). It exists in Go for tests and the vector
// generator; production initiators are TypeScript. rng == nil means
// crypto/rand.
func InitiatorHandshake(static noise.DHKey, peerStatic []byte, payload []byte, rng io.Reader, recv func() ([]byte, error), send func([]byte) error) (*Channel, error) {
	if rng == nil {
		rng = rand.Reader
	}
	hs, err := noise.NewHandshakeState(noise.Config{
		CipherSuite:   Suite(),
		Pattern:       noise.HandshakeIK,
		Initiator:     true,
		StaticKeypair: static,
		PeerStatic:    peerStatic,
		Random:        rng,
	})
	if err != nil {
		return nil, err
	}
	msg1, _, _, err := hs.WriteMessage(nil, payload)
	if err != nil {
		return nil, fmt.Errorf("crypto: handshake message 1: %w", err)
	}
	if err := send(msg1); err != nil {
		return nil, err
	}
	msg2, err := recv()
	if err != nil {
		return nil, err
	}
	// On the final message, flynn/noise hands back both cipher states; the
	// first is for initiator->responder traffic.
	_, csSend, csRecv, err := hs.ReadMessage(nil, msg2)
	if err != nil {
		return nil, fmt.Errorf("crypto: handshake message 2: %w", err)
	}
	return &Channel{send: csSend, recv: csRecv}, nil
}

// ResponderHandshake runs the daemon side. The returned public key is the
// initiator's static — the device identity the caller authorizes against the
// device store — and payload is message A's decrypted payload, empty when
// the initiator sent none. Callers must treat an error as fatal to the
// connection and process no frames before the handshake completes.
func ResponderHandshake(static noise.DHKey, rng io.Reader, recv func() ([]byte, error), send func([]byte) error) (*Channel, []byte, []byte, error) {
	if rng == nil {
		rng = rand.Reader
	}
	hs, err := noise.NewHandshakeState(noise.Config{
		CipherSuite:   Suite(),
		Pattern:       noise.HandshakeIK,
		Initiator:     false,
		StaticKeypair: static,
		Random:        rng,
	})
	if err != nil {
		return nil, nil, nil, err
	}
	msg1, err := recv()
	if err != nil {
		return nil, nil, nil, err
	}
	payload, _, _, err := hs.ReadMessage(nil, msg1)
	if err != nil {
		return nil, nil, nil, fmt.Errorf("crypto: handshake message 1: %w", err)
	}
	msg2, csI2R, csR2I, err := hs.WriteMessage(nil, nil)
	if err != nil {
		return nil, nil, nil, fmt.Errorf("crypto: handshake message 2: %w", err)
	}
	if err := send(msg2); err != nil {
		return nil, nil, nil, err
	}
	return &Channel{send: csR2I, recv: csI2R}, hs.PeerStatic(), payload, nil
}
