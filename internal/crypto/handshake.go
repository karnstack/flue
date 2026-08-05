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
//   -> e, es, s, ss
//   <- e, ee, se
// Two messages, then both sides hold a pair of CipherStates.

// InitiatorHandshake runs the browser side of the handshake. It exists in Go
// for tests and the vector generator; production initiators are TypeScript.
// rng == nil means crypto/rand.
func InitiatorHandshake(static noise.DHKey, peerStatic []byte, rng io.Reader, recv func() ([]byte, error), send func([]byte) error) (*Channel, error) {
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
	msg1, _, _, err := hs.WriteMessage(nil, nil)
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
// device store. Callers must treat an error as fatal to the connection and
// process no frames before the handshake completes.
func ResponderHandshake(static noise.DHKey, rng io.Reader, recv func() ([]byte, error), send func([]byte) error) (*Channel, []byte, error) {
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
		return nil, nil, err
	}
	msg1, err := recv()
	if err != nil {
		return nil, nil, err
	}
	if _, _, _, err := hs.ReadMessage(nil, msg1); err != nil {
		return nil, nil, fmt.Errorf("crypto: handshake message 1: %w", err)
	}
	msg2, csI2R, csR2I, err := hs.WriteMessage(nil, nil)
	if err != nil {
		return nil, nil, fmt.Errorf("crypto: handshake message 2: %w", err)
	}
	if err := send(msg2); err != nil {
		return nil, nil, err
	}
	return &Channel{send: csR2I, recv: csI2R}, hs.PeerStatic(), nil
}
