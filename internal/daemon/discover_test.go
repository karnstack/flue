package daemon

import (
	"encoding/json"
	"os"
	"testing"
)

func TestRuntimeRoundTrip(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())

	if _, ok := ReadRuntime(); ok {
		t.Fatal("ReadRuntime ok = true with no runtime file, want false")
	}
	if err := WriteRuntime(7717); err != nil {
		t.Fatalf("WriteRuntime: %v", err)
	}
	port, ok := ReadRuntime()
	if !ok || port != 7717 {
		t.Fatalf("ReadRuntime = %d, %v; want 7717, true", port, ok)
	}
}

func TestRuntimeOverwrites(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	if err := WriteRuntime(1111); err != nil {
		t.Fatalf("WriteRuntime: %v", err)
	}
	if err := WriteRuntime(2222); err != nil {
		t.Fatalf("WriteRuntime: %v", err)
	}
	port, ok := ReadRuntime()
	if !ok || port != 2222 {
		t.Fatalf("ReadRuntime = %d, %v; want 2222, true", port, ok)
	}
}

// TestReadRuntimeRecordReportsTheWriterPID: the PID is what a reader uses to
// tell its own daemon from another user's, so it has to survive the round
// trip rather than being written and forgotten.
func TestReadRuntimeRecordReportsTheWriterPID(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())

	if err := WriteRuntime(7717); err != nil {
		t.Fatalf("WriteRuntime: %v", err)
	}
	port, pid, ok := ReadRuntimeRecord()
	if !ok || port != 7717 {
		t.Fatalf("ReadRuntimeRecord = %d, %d, %v; want 7717, %d, true", port, pid, ok, os.Getpid())
	}
	if pid != os.Getpid() {
		t.Fatalf("ReadRuntimeRecord pid = %d, want the writing process %d", pid, os.Getpid())
	}
}

// TestClearRuntimeRemovesOurOwnRecord: a daemon that shuts down cleanly must
// take its runtime record with it, so a later flue open or flue status reports
// "not running" outright instead of falling back to probing a port that may by
// then belong to something else entirely.
func TestClearRuntimeRemovesOurOwnRecord(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())

	if err := WriteRuntime(7717); err != nil {
		t.Fatalf("WriteRuntime: %v", err)
	}
	if err := ClearRuntime(); err != nil {
		t.Fatalf("ClearRuntime: %v", err)
	}
	if port, ok := ReadRuntime(); ok {
		t.Fatalf("ReadRuntime = %d, true after ClearRuntime; want ok = false", port)
	}
}

// TestClearRuntimeKeepsAnotherProcessRecord: a second daemon (flue serve
// --port N started by hand) overwrites the record while the first is still
// running. When the first one exits it must not delete the survivor's record
// and make a live daemon undiscoverable.
func TestClearRuntimeKeepsAnotherProcessRecord(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())

	path, err := runtimePath()
	if err != nil {
		t.Fatalf("runtimePath: %v", err)
	}
	b, err := json.Marshal(runtimeFile{Port: 7718, PID: os.Getpid() + 1})
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	if err := os.WriteFile(path, b, 0o600); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}

	if err := ClearRuntime(); err != nil {
		t.Fatalf("ClearRuntime: %v", err)
	}
	port, ok := ReadRuntime()
	if !ok || port != 7718 {
		t.Fatalf("ReadRuntime = %d, %v after ClearRuntime on another process's record; want 7718, true", port, ok)
	}
}

// TestClearRuntimeWithNoRecord: shutting down without ever having written a
// record (a bind failure, say) is not an error.
func TestClearRuntimeWithNoRecord(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	if err := ClearRuntime(); err != nil {
		t.Fatalf("ClearRuntime with no runtime file: %v", err)
	}
}
