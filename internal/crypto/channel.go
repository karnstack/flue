package crypto

import "github.com/flynn/noise"

// Channel is one authenticated, ordered, end-to-end encrypted pipe. Nonces
// are the CipherStates' own strictly incrementing counters; the transport
// underneath is a WebSocket, which is ordered and reliable, so any Open
// failure means tampering or replay and the caller must tear the connection
// down — there is no recovery path by design.
type Channel struct {
	send *noise.CipherState
	recv *noise.CipherState
}

// Seal encrypts one frame.
func (c *Channel) Seal(plaintext []byte) ([]byte, error) {
	return c.send.Encrypt(nil, nil, plaintext)
}

// Open decrypts one frame. An error is fatal to the connection.
func (c *Channel) Open(ciphertext []byte) ([]byte, error) {
	return c.recv.Decrypt(nil, nil, ciphertext)
}
