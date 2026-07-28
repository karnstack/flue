package session

import (
	"bytes"
	"strings"
	"testing"
	"time"
)

func waitFor(t *testing.T, sub *Sub, want string, timeout time.Duration) []byte {
	t.Helper()
	var acc []byte
	acc = append(acc, sub.Backlog...)
	deadline := time.After(timeout)
	for !bytes.Contains(acc, []byte(want)) {
		select {
		case b, ok := <-sub.C:
			if !ok {
				t.Fatalf("subscriber closed while waiting for %q; got %q", want, acc)
			}
			acc = append(acc, b...)
		case <-deadline:
			t.Fatalf("timed out waiting for %q; got %q", want, acc)
		}
	}
	return acc
}

func TestSpawnProducesOutput(t *testing.T) {
	r := NewRegistry(time.Now)
	s, err := r.Spawn(SpawnOpts{Cmd: []string{"sh", "-c", "echo hello-flue"}, Cols: 80, Rows: 24})
	if err != nil {
		t.Fatalf("Spawn: %v", err)
	}
	defer s.Close()

	sub := s.Subscribe(0)
	defer s.Unsubscribe(sub)
	waitFor(t, sub, "hello-flue", 5*time.Second)
}

func TestResizePropagatesToPTY(t *testing.T) {
	r := NewRegistry(time.Now)
	s, err := r.Spawn(SpawnOpts{
		Cmd:  []string{"sh", "-c", "sleep 0.3; stty size"},
		Cols: 80, Rows: 24,
	})
	if err != nil {
		t.Fatalf("Spawn: %v", err)
	}
	defer s.Close()

	sub := s.Subscribe(0)
	defer s.Unsubscribe(sub)

	if err := s.Resize(100, 40); err != nil {
		t.Fatalf("Resize: %v", err)
	}
	got := waitFor(t, sub, "40 100", 5*time.Second)
	if !strings.Contains(string(got), "40 100") {
		t.Fatalf("stty size output = %q, want it to contain %q", got, "40 100")
	}
}

func TestWriteReachesPTY(t *testing.T) {
	r := NewRegistry(time.Now)
	s, err := r.Spawn(SpawnOpts{Cmd: []string{"cat"}, Cols: 80, Rows: 24})
	if err != nil {
		t.Fatalf("Spawn: %v", err)
	}
	defer s.Close()

	sub := s.Subscribe(0)
	defer s.Unsubscribe(sub)

	if err := s.Write([]byte("ping\n")); err != nil {
		t.Fatalf("Write: %v", err)
	}
	waitFor(t, sub, "ping", 5*time.Second)
}

func TestTwoSubscribersBothReceive(t *testing.T) {
	r := NewRegistry(time.Now)
	s, err := r.Spawn(SpawnOpts{Cmd: []string{"cat"}, Cols: 80, Rows: 24})
	if err != nil {
		t.Fatalf("Spawn: %v", err)
	}
	defer s.Close()

	a := s.Subscribe(0)
	defer s.Unsubscribe(a)
	b := s.Subscribe(0)
	defer s.Unsubscribe(b)

	if err := s.Write([]byte("both\n")); err != nil {
		t.Fatalf("Write: %v", err)
	}
	waitFor(t, a, "both", 5*time.Second)
	waitFor(t, b, "both", 5*time.Second)
}

func TestSubscribeTruncatedWhenSeqEvicted(t *testing.T) {
	r := NewRegistry(time.Now)
	s, err := r.Spawn(SpawnOpts{
		Cmd:      []string{"sh", "-c", "printf 'a%.0s' $(seq 1 4096)"},
		Cols:     80,
		Rows:     24,
		RingSize: 64,
	})
	if err != nil {
		t.Fatalf("Spawn: %v", err)
	}
	defer s.Close()

	sub := s.Subscribe(0)
	waitFor(t, sub, "aaaa", 5*time.Second)
	s.Unsubscribe(sub)

	// Wait for the process to finish so the ring has definitely wrapped.
	deadline := time.After(5 * time.Second)
	for s.Info().State != "exited" {
		select {
		case <-deadline:
			t.Fatal("process did not exit")
		case <-time.After(10 * time.Millisecond):
		}
	}

	late := s.Subscribe(0)
	defer s.Unsubscribe(late)
	if !late.Truncated {
		t.Fatal("Truncated = false, want true after eviction")
	}
	if late.StartSeq == 0 {
		t.Fatal("StartSeq = 0, want the ring's advanced base")
	}
}

func TestExitedSessionsReapedAfterRetention(t *testing.T) {
	now := time.Now()
	clock := func() time.Time { return now }
	r := NewRegistry(clock)

	s, err := r.Spawn(SpawnOpts{Cmd: []string{"sh", "-c", "exit 3"}, Cols: 80, Rows: 24})
	if err != nil {
		t.Fatalf("Spawn: %v", err)
	}

	deadline := time.After(5 * time.Second)
	for s.Info().State != "exited" {
		select {
		case <-deadline:
			t.Fatal("process did not exit")
		case <-time.After(10 * time.Millisecond):
		}
	}
	if got := s.Info().ExitCode; got != 3 {
		t.Fatalf("ExitCode = %d, want 3", got)
	}

	r.Reap()
	if _, ok := r.Get(s.ID()); !ok {
		t.Fatal("session reaped before the retention window elapsed")
	}

	now = now.Add(ExitedRetention + time.Second)
	r.Reap()
	if _, ok := r.Get(s.ID()); ok {
		t.Fatal("session still present after the retention window")
	}
}

func TestTitleFromOSC(t *testing.T) {
	r := NewRegistry(time.Now)
	s, err := r.Spawn(SpawnOpts{
		Cmd:  []string{"sh", "-c", "printf '\\033]0;flue-title\\007'; sleep 0.2"},
		Cols: 80, Rows: 24,
	})
	if err != nil {
		t.Fatalf("Spawn: %v", err)
	}
	defer s.Close()

	deadline := time.After(5 * time.Second)
	for s.Info().Title != "flue-title" {
		select {
		case <-deadline:
			t.Fatalf("Title = %q, want %q", s.Info().Title, "flue-title")
		case <-time.After(10 * time.Millisecond):
		}
	}
}
