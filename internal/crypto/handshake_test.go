package crypto

import (
	"bytes"
	"context"
	"crypto/rand"
	"testing"
	"time"
)

// pipe wires two handshake parties together in-memory.
type pipe struct{ a2b, b2a chan []byte }

func newPipe() *pipe { return &pipe{a2b: make(chan []byte, 4), b2a: make(chan []byte, 4)} }

func (p *pipe) aSend(b []byte) error   { p.a2b <- b; return nil }
func (p *pipe) aRecv() ([]byte, error) { return <-p.b2a, nil }
func (p *pipe) bSend(b []byte) error   { p.b2a <- b; return nil }
func (p *pipe) bRecv() ([]byte, error) { return <-p.a2b, nil }

func handshakePair(t *testing.T) (initiator, responder *Channel, deviceStatic []byte) {
	t.Helper()
	daemonKey, err := Suite().GenerateKeypair(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	deviceKey, err := Suite().GenerateKeypair(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	p := newPipe()
	type res struct {
		ch   *Channel
		peer []byte
		err  error
	}
	done := make(chan res, 1)
	go func() {
		ch, peer, err := ResponderHandshake(daemonKey, nil, p.bRecv, p.bSend)
		done <- res{ch, peer, err}
	}()
	ich, err := InitiatorHandshake(deviceKey, daemonKey.Public, nil, p.aRecv, p.aSend)
	if err != nil {
		t.Fatalf("initiator: %v", err)
	}
	r := <-done
	if r.err != nil {
		t.Fatalf("responder: %v", r.err)
	}
	if !bytes.Equal(r.peer, deviceKey.Public) {
		t.Fatal("responder saw the wrong initiator static key")
	}
	return ich, r.ch, deviceKey.Public
}

func TestHandshakeAndBothDirections(t *testing.T) {
	i, r, _ := handshakePair(t)

	ct, err := i.Seal([]byte("from device"))
	if err != nil {
		t.Fatal(err)
	}
	pt, err := r.Open(ct)
	if err != nil || string(pt) != "from device" {
		t.Fatalf("i->r round trip: %q, %v", pt, err)
	}

	ct, err = r.Seal([]byte("from daemon"))
	if err != nil {
		t.Fatal(err)
	}
	pt, err = i.Open(ct)
	if err != nil || string(pt) != "from daemon" {
		t.Fatalf("r->i round trip: %q, %v", pt, err)
	}
}

func TestWrongPinnedStaticKeyFailsTheHandshake(t *testing.T) {
	daemonKey, _ := Suite().GenerateKeypair(rand.Reader)
	deviceKey, _ := Suite().GenerateKeypair(rand.Reader)
	imposter, _ := Suite().GenerateKeypair(rand.Reader)

	p := newPipe()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	// Wrap the pipe callbacks with timeout to prevent deadlock if one side fails.
	recvWithTimeout := func(recv func() ([]byte, error)) func() ([]byte, error) {
		return func() ([]byte, error) {
			done := make(chan []byte, 1)
			go func() {
				b, _ := recv()
				done <- b
			}()
			select {
			case b := <-done:
				return b, nil
			case <-ctx.Done():
				return nil, ctx.Err()
			}
		}
	}
	sendWithTimeout := func(send func([]byte) error) func([]byte) error {
		return func(b []byte) error {
			done := make(chan error, 1)
			go func() {
				done <- send(b)
			}()
			select {
			case err := <-done:
				return err
			case <-ctx.Done():
				return ctx.Err()
			}
		}
	}

	errCh := make(chan error, 1)
	go func() {
		_, _, err := ResponderHandshake(daemonKey, nil, recvWithTimeout(p.bRecv), sendWithTimeout(p.bSend))
		errCh <- err
	}()
	// The initiator pins the imposter's key; IK's first message encrypts to
	// the pinned key, so the real daemon must fail to read it.
	if _, err := InitiatorHandshake(deviceKey, imposter.Public, nil, recvWithTimeout(p.aRecv), sendWithTimeout(p.aSend)); err == nil {
		// The initiator may or may not detect it first depending on where
		// decryption fails; the responder must.
		if err := <-errCh; err == nil {
			t.Fatal("handshake against a wrong pinned key succeeded")
		}
	}
}

func TestTamperAndReplayAreFatal(t *testing.T) {
	i, r, _ := handshakePair(t)

	ct, _ := i.Seal([]byte("payload"))
	tampered := append([]byte{}, ct...)
	tampered[len(tampered)-1] ^= 0x01
	if _, err := r.Open(tampered); err == nil {
		t.Fatal("tampered ciphertext opened")
	}

	// Fresh pair: replaying a ciphertext must fail, because the receive
	// nonce has already advanced past it.
	i2, r2, _ := handshakePair(t)
	ct1, _ := i2.Seal([]byte("one"))
	if _, err := r2.Open(ct1); err != nil {
		t.Fatal(err)
	}
	if _, err := r2.Open(ct1); err == nil {
		t.Fatal("replayed ciphertext opened")
	}
}
