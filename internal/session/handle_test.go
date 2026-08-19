package session

// The compile-time assertions live in handle.go beside the interfaces; this
// test exists so `go test` names the contract when someone breaks it rather
// than failing as a stray build error in whatever package noticed first.

import "testing"

func TestSessionSatisfiesHandle(t *testing.T) {
	var h Handle = (*Session)(nil)
	if _, ok := h.(interface{ ID() string }); !ok {
		t.Fatal("Session lost Handle's surface")
	}
}
