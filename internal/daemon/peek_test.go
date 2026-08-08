package daemon

import (
	"bytes"
	"testing"
	"time"

	"github.com/karnstack/flue/internal/session"
	"github.com/karnstack/flue/internal/wire"
)

// peekTarget spawns a session, writes a line into it, and waits for the echo
// to land in the ring — which is what a peek reads. The wait is a poll because
// a pty round trip is the kernel's business and there is nothing to wait on.
func peekTarget(t *testing.T, reg *session.Registry, say string) *session.Session {
	t.Helper()
	s, err := reg.Spawn(session.SpawnOpts{Cmd: []string{"cat"}, Cols: 80, Rows: 24})
	if err != nil {
		t.Fatalf("Spawn: %v", err)
	}
	t.Cleanup(func() { _ = s.Close() })
	if err := s.Write([]byte(say + "\n")); err != nil {
		t.Fatalf("Write: %v", err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for {
		if data, _, _ := s.Tail(4096); bytes.Contains(data, []byte(say)) {
			return s
		}
		if time.Now().After(deadline) {
			t.Fatal("the session never echoed what was written into it")
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func TestPeekAnswersWithTheTailOfTheScrollback(t *testing.T) {
	ts, reg := newTestServer(t)
	s := peekTarget(t, reg, "hello-from-the-session")

	c := dial(t, ts)
	writeControl(t, c, wire.Hello{Ver: "test"})
	writeControl(t, c, wire.Peek{ID: s.ID(), ReqID: 7})

	readUntil(t, c, func(msg any, _ []byte) bool {
		p, ok := msg.(wire.Preview)
		if !ok {
			return false
		}
		if p.ReqID != 7 {
			t.Fatalf("Preview.ReqID = %d, want 7", p.ReqID)
		}
		if p.ID != s.ID() {
			t.Fatalf("Preview.ID = %q, want %q", p.ID, s.ID())
		}
		if !bytes.Contains(p.Data, []byte("hello-from-the-session")) {
			t.Fatalf("Preview.Data = %q, want it to carry what the session drew", p.Data)
		}
		if p.Cols != 80 || p.Rows != 24 {
			t.Fatalf("Preview dimensions = %dx%d, want 80x24", p.Cols, p.Rows)
		}
		return true
	})
}

func TestPeekMintsNoRefAndLeavesNoSubscriber(t *testing.T) {
	// The whole reason peek exists rather than an attach-then-detach: a list
	// hovering rows must not leave a subscription per row behind it. A ref
	// would have arrived as an `attached`, so the absence of one is the
	// observable half; the other is that input into the session after the peek
	// reaches nobody on this connection.
	ts, reg := newTestServer(t)
	s := peekTarget(t, reg, "before-the-peek")

	c := dial(t, ts)
	writeControl(t, c, wire.Hello{Ver: "test"})
	writeControl(t, c, wire.Peek{ID: s.ID(), ReqID: 1})

	readUntil(t, c, func(msg any, _ []byte) bool {
		if _, ok := msg.(wire.Attached); ok {
			t.Fatal("peek answered with an attachment")
		}
		_, ok := msg.(wire.Preview)
		return ok
	})

	if err := s.Write([]byte("after-the-peek\n")); err != nil {
		t.Fatalf("Write: %v", err)
	}
	// A second peek is the round trip that proves no output frame overtook it:
	// this connection subscribes to nothing, so the only frames it can ever
	// receive are answers to what it asked.
	writeControl(t, c, wire.Peek{ID: s.ID(), ReqID: 2})
	readUntil(t, c, func(msg any, out []byte) bool {
		if len(out) > 0 {
			t.Fatalf("a connection that only peeked received output: %q", out)
		}
		p, ok := msg.(wire.Preview)
		return ok && p.ReqID == 2
	})
}

func TestPeekDoesNotCountAsActivityInTheSession(t *testing.T) {
	// The sessions list orders by LastActive by default, so a preview that
	// touched the stamp would sort the row under the pointer to the top of the
	// list the pointer is resting on.
	ts, reg := newTestServer(t)
	s := peekTarget(t, reg, "quiet")
	before := s.Info().LastActive

	c := dial(t, ts)
	writeControl(t, c, wire.Hello{Ver: "test"})
	writeControl(t, c, wire.Peek{ID: s.ID(), ReqID: 1})
	readUntil(t, c, func(msg any, _ []byte) bool {
		_, ok := msg.(wire.Preview)
		return ok
	})

	if got := s.Info().LastActive; !got.Equal(before) {
		t.Fatalf("LastActive moved from %v to %v", before, got)
	}
}

func TestPeekRefusesAnIdTheDaemonDoesNotHold(t *testing.T) {
	ts, _ := newTestServer(t)

	c := dial(t, ts)
	writeControl(t, c, wire.Hello{Ver: "test"})
	writeControl(t, c, wire.Peek{ID: "never-existed", ReqID: 4})

	readUntil(t, c, func(msg any, _ []byte) bool {
		e, ok := msg.(wire.Error)
		if !ok {
			return false
		}
		if e.Code != "not_found" {
			t.Fatalf("Error.Code = %q, want not_found", e.Code)
		}
		// Correlated, because a list peeks at many rows at once and the
		// refusals have to find their own askers.
		if e.ReqID != 4 {
			t.Fatalf("Error.ReqID = %d, want 4", e.ReqID)
		}
		return true
	})
}

func TestPeekClampsAnOversizedRequestRatherThanRefusingIt(t *testing.T) {
	ts, reg := newTestServer(t)
	s := peekTarget(t, reg, "clamped")

	c := dial(t, ts)
	writeControl(t, c, wire.Hello{Ver: "test"})
	writeControl(t, c, wire.Peek{ID: s.ID(), Bytes: peekMaxBytes * 4, ReqID: 1})

	readUntil(t, c, func(msg any, _ []byte) bool {
		p, ok := msg.(wire.Preview)
		if !ok {
			return false
		}
		if len(p.Data) > peekMaxBytes {
			t.Fatalf("Preview.Data is %d bytes, over the %d ceiling", len(p.Data), peekMaxBytes)
		}
		return true
	})
}

func TestPreviewCarriesAnEmptyTailAsAStringRatherThanNull(t *testing.T) {
	// A session that has drawn nothing is reached by the ordinary path, and
	// the client declares the field a string it base64-decodes.
	b, err := wire.EncodeControl(wire.Preview{ID: "s1", Cols: 80, Rows: 24})
	if err != nil {
		t.Fatalf("EncodeControl: %v", err)
	}
	if !bytes.Contains(b, []byte(`"data":""`)) {
		t.Fatalf("an empty preview marshals as %s, want \"data\":\"\"", b)
	}
}
