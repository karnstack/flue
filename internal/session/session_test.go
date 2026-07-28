package session

import (
	"bytes"
	"errors"
	"strconv"
	"strings"
	"syscall"
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

// parseChildPID extracts the number following "child-pid=" in out, as
// printed by a shell's `echo child-pid=$!` right after backgrounding a job.
func parseChildPID(t *testing.T, out []byte) int {
	t.Helper()
	i := bytes.Index(out, []byte("child-pid="))
	if i < 0 {
		t.Fatalf("output %q does not contain %q", out, "child-pid=")
	}
	rest := out[i+len("child-pid="):]
	end := 0
	for end < len(rest) && rest[end] >= '0' && rest[end] <= '9' {
		end++
	}
	pid, err := strconv.Atoi(string(rest[:end]))
	if err != nil {
		t.Fatalf("parse child pid from %q: %v", rest[:end], err)
	}
	return pid
}

// waitGone polls (rather than sleeping a fixed interval) until pid no longer
// exists, or fails the test once timeout elapses.
func waitGone(t *testing.T, pid int, timeout time.Duration) {
	t.Helper()
	deadline := time.After(timeout)
	for {
		err := syscall.Kill(pid, 0)
		if errors.Is(err, syscall.ESRCH) {
			return
		}
		select {
		case <-deadline:
			t.Fatalf("pid %d still alive after %s", pid, timeout)
		case <-time.After(10 * time.Millisecond):
		}
	}
}

// TestSubscribeAfterCloseReturnsClosedChannel guards against a subscriber
// registered on an already-closed session sitting on an open channel
// forever: Close only runs its drop loop once, at the open-to-closed
// transition, so a Sub created afterward would never be told to stop and a
// consumer (e.g. a WebSocket handler) reading <-sub.C would block forever.
func TestSubscribeAfterCloseReturnsClosedChannel(t *testing.T) {
	r := NewRegistry(time.Now)
	s, err := r.Spawn(SpawnOpts{Cmd: []string{"cat"}, Cols: 80, Rows: 24})
	if err != nil {
		t.Fatalf("Spawn: %v", err)
	}
	if err := s.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	// Wait for the pump goroutine to actually finish and run markExited's
	// one-time drop sweep before subscribing. markExited sets State and
	// runs its drop loop inside the same locked section, so once State is
	// observably "exited" that sweep is over and gone for good — this is
	// the state the described bug depends on: a subscriber registered well
	// after teardown has finished, with nothing left that will ever visit
	// it again. Subscribing immediately after Close (without this wait)
	// races with that sweep and can pass for the wrong reason.
	deadline := time.After(5 * time.Second)
	for s.Info().State != "exited" {
		select {
		case <-deadline:
			t.Fatal(`session never reached "exited" after Close`)
		case <-time.After(10 * time.Millisecond):
		}
	}

	sub := s.Subscribe(0)
	defer s.Unsubscribe(sub)
	select {
	case _, ok := <-sub.C:
		if ok {
			t.Fatal("C delivered a value for a subscriber created after Close")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("C never closed for a subscriber created after Close; a reader would block forever")
	}
}

// TestCloseTerminatesBackgroundChildren guards against Close killing only
// the shell and leaving a background job (which inherits the shell's
// stdout/stderr on the pty slave) running: that job would keep the slave
// open, so the pump's master Read would never see a hangup, State would
// never become "exited", and the child itself would be leaked.
//
// The child sets its SIGHUP disposition to ignore (an empty shell trap
// body, inherited across its fork+exec the same way nohup works) so it does
// not incidentally die from the kernel's own hangup-on-session-leader-death
// or hangup-on-master-close delivery — both of those are SIGHUP-based and
// would otherwise mask whether Close's own kill is leader-only or
// whole-group.
func TestCloseTerminatesBackgroundChildren(t *testing.T) {
	r := NewRegistry(time.Now)
	s, err := r.Spawn(SpawnOpts{
		Cmd:  []string{"sh", "-c", "trap '' HUP; sleep 1000 & echo child-pid=$!"},
		Cols: 80, Rows: 24,
	})
	if err != nil {
		t.Fatalf("Spawn: %v", err)
	}

	sub := s.Subscribe(0)
	out := waitFor(t, sub, "child-pid=", 5*time.Second)
	s.Unsubscribe(sub)

	childPID := parseChildPID(t, out)
	if err := syscall.Kill(childPID, 0); err != nil {
		t.Fatalf("background child pid %d not running before Close: %v", childPID, err)
	}

	if err := s.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	deadline := time.After(5 * time.Second)
	for s.Info().State != "exited" {
		select {
		case <-deadline:
			t.Fatal(`session never reached "exited"; a lingering background child likely kept the pty slave open`)
		case <-time.After(10 * time.Millisecond):
		}
	}

	waitGone(t, childPID, 2*time.Second)
}

// TestSignalReachesChildProcess guards against Signal only reaching the
// session's leader process: a background child shares the leader's process
// group (pty.StartWithSize sets Setsid, so pgid == the leader's pid), and
// Signal must deliver to the whole group, the way closing a real terminal
// takes its job tree down with it.
//
// As in TestCloseTerminatesBackgroundChildren, the child ignores SIGHUP so
// the kernel's own hangup-on-session-leader-death delivery (triggered the
// instant SIGKILL reaches the shell) can't incidentally kill it too and
// mask a leader-only Signal implementation.
func TestSignalReachesChildProcess(t *testing.T) {
	r := NewRegistry(time.Now)
	s, err := r.Spawn(SpawnOpts{
		Cmd:  []string{"sh", "-c", "trap '' HUP; sleep 1000 & echo child-pid=$!; wait"},
		Cols: 80, Rows: 24,
	})
	if err != nil {
		t.Fatalf("Spawn: %v", err)
	}
	defer s.Close()

	sub := s.Subscribe(0)
	out := waitFor(t, sub, "child-pid=", 5*time.Second)
	s.Unsubscribe(sub)

	childPID := parseChildPID(t, out)
	if err := syscall.Kill(childPID, 0); err != nil {
		t.Fatalf("background child pid %d not running before Signal: %v", childPID, err)
	}

	if err := s.Signal(syscall.SIGKILL); err != nil {
		t.Fatalf("Signal: %v", err)
	}

	waitGone(t, childPID, 2*time.Second)
}

// spyKillGroup substitutes killGroup with a spy that records every pid
// signalled and delegates to the real syscall, so tests can assert on
// whether a group signal was issued at all — a property that can't be
// observed reliably from wall-clock timing or from watching a process
// disappear, especially when the point of the test is that nothing should
// be signalled. It is restored via t.Cleanup regardless of how the test
// ends.
func spyKillGroup(t *testing.T) *[]int {
	t.Helper()
	var calls []int
	orig := killGroup
	killGroup = func(pid int, sig syscall.Signal) error {
		calls = append(calls, pid)
		return orig(pid, sig)
	}
	t.Cleanup(func() { killGroup = orig })
	return &calls
}

// waitExited polls (rather than sleeping a fixed interval) until s reaches
// the "exited" state. Once observed, markExited's cmd.Wait() and its
// s.reaped update have both already completed — both happen inside the
// same locked section that sets State, before it is released.
func waitExited(t *testing.T, s *Session, timeout time.Duration) {
	t.Helper()
	deadline := time.After(timeout)
	for s.Info().State != "exited" {
		select {
		case <-deadline:
			t.Fatalf("session did not reach \"exited\" within %s", timeout)
		case <-time.After(10 * time.Millisecond):
		}
	}
}

// TestSignalOnReapedSessionIssuesNoSyscall guards against the pid-reuse
// hazard of signalling a session after cmd.Wait() has already reaped it:
// once reaped, the kernel is free to recycle that pid for an unrelated
// process (plausibly another session's leader, since Setsid makes every
// leader its own process-group leader too), so signalGroup's negated-pid
// kill must never be issued again. Signal must also not surface this as an
// error the caller has to special-case — there is simply nothing left to
// signal.
func TestSignalOnReapedSessionIssuesNoSyscall(t *testing.T) {
	calls := spyKillGroup(t)

	r := NewRegistry(time.Now)
	s, err := r.Spawn(SpawnOpts{Cmd: []string{"sh", "-c", "exit 0"}, Cols: 80, Rows: 24})
	if err != nil {
		t.Fatalf("Spawn: %v", err)
	}
	defer s.Close()

	waitExited(t, s, 5*time.Second)
	*calls = nil // natural exit alone must not have signalled anything either

	if err := s.Signal(syscall.SIGTERM); err != nil {
		t.Fatalf("Signal on an already-exited session returned an error the caller must handle: %v", err)
	}
	if len(*calls) != 0 {
		t.Fatalf("Signal on an already-exited (reaped) session issued %d group-kill syscall(s), want 0 — this would risk signalling a recycled pid", len(*calls))
	}
}

// TestCloseOnReapedSessionIssuesNoSyscallButStillTearsDown guards against
// the same pid-reuse hazard on the Close path — Registry.Reap calls Close
// on every naturally-exited session it collects, which is exactly this
// case — while confirming Close still does its other job: releasing the
// pty and closing out any subscriber that's still attached.
func TestCloseOnReapedSessionIssuesNoSyscallButStillTearsDown(t *testing.T) {
	calls := spyKillGroup(t)

	r := NewRegistry(time.Now)
	s, err := r.Spawn(SpawnOpts{Cmd: []string{"sh", "-c", "exit 0"}, Cols: 80, Rows: 24})
	if err != nil {
		t.Fatalf("Spawn: %v", err)
	}

	waitExited(t, s, 5*time.Second)
	*calls = nil

	sub := s.Subscribe(0)
	if err := s.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	if len(*calls) != 0 {
		t.Fatalf("Close on an already-exited (reaped) session issued %d group-kill syscall(s), want 0 — this would risk signalling a recycled pid", len(*calls))
	}

	select {
	case _, ok := <-sub.C:
		if ok {
			t.Fatal("C delivered a value after Close")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Close did not close an already-attached subscriber's channel")
	}

	if _, err := s.pty.Write([]byte("x")); err == nil {
		t.Fatal("pty.Write succeeded after Close; want Close to have released the pty even when it skipped signalling")
	}
}
