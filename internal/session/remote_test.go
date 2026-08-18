package session_test

import (
	"os"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/karnstack/flue/internal/holder"
	"github.com/karnstack/flue/internal/session"
)

// TestMain doubles as the holder executable: SpawnRemote execs this very
// test binary with "_holder" as its first argument, which keeps these tests
// from having to build the real flue binary (and its embedded web assets)
// just to get a holder on the other side of a socket.
func TestMain(m *testing.M) {
	if len(os.Args) > 1 && os.Args[1] == "_holder" {
		if err := holder.Main("remote-test", os.Args[2:]); err != nil {
			os.Exit(1)
		}
		os.Exit(0)
	}
	os.Exit(m.Run())
}

func holderDir(t *testing.T) string {
	t.Helper()
	dir, err := os.MkdirTemp("", "fluer")
	if err != nil {
		t.Fatalf("MkdirTemp: %v", err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	return dir
}

func spawnCat(t *testing.T, dir string) *session.Remote {
	t.Helper()
	exe, err := os.Executable()
	if err != nil {
		t.Fatalf("os.Executable: %v", err)
	}
	cfg := session.ChildConfig{
		ID:   "cafebabe22222222",
		Run:  []string{"/bin/sh", "-c", "printf remote-ready; exec cat"},
		Argv: []string{"cat"},
		Env:  []string{"TERM=xterm-256color", "PATH=/usr/bin:/bin"},
		Cwd:  "/",
		Cols: 80, Rows: 24,
	}
	r, err := session.SpawnRemote(exe, dir, cfg, nil)
	if err != nil {
		t.Fatalf("SpawnRemote: %v", err)
	}
	t.Cleanup(func() { _ = r.Close() })
	return r
}

func waitRemote(t *testing.T, sub *session.Sub, want string, timeout time.Duration) {
	t.Helper()
	var got strings.Builder
	got.Write(sub.Backlog)
	deadline := time.After(timeout)
	for !strings.Contains(got.String(), want) {
		select {
		case chunk, ok := <-sub.C:
			if !ok {
				t.Fatalf("stream closed before %q; have %q", want, got.String())
			}
			got.Write(chunk)
		case <-deadline:
			t.Fatalf("no %q within %s; have %q", want, timeout, got.String())
		}
	}
}

func TestRemoteSpawnWriteSubscribeTail(t *testing.T) {
	dir := holderDir(t)
	r := spawnCat(t, dir)

	if r.ID() != "cafebabe22222222" {
		t.Fatalf("ID = %q", r.ID())
	}
	info := r.Info()
	if info.State != "running" || len(info.Cmd) != 1 || info.Cmd[0] != "cat" {
		t.Fatalf("Info = %+v", info)
	}

	sub := r.Subscribe(0)
	defer r.Unsubscribe(sub)
	waitRemote(t, sub, "remote-ready", 5*time.Second)

	if err := r.Write([]byte("over-the-wire\n")); err != nil {
		t.Fatalf("Write: %v", err)
	}
	waitRemote(t, sub, "over-the-wire", 5*time.Second)

	data, cols, rows := r.Tail(4096)
	if !strings.Contains(string(data), "remote-ready") || cols != 80 || rows != 24 {
		t.Fatalf("Tail = %q %dx%d", data, cols, rows)
	}
}

func TestRemoteResizeAndMeta(t *testing.T) {
	dir := holderDir(t)
	r := spawnCat(t, dir)
	if err := r.Resize(120, 40); err != nil {
		t.Fatalf("Resize: %v", err)
	}
	if info := r.Info(); info.Cols != 120 || info.Rows != 40 {
		t.Fatalf("size = %dx%d", info.Cols, info.Rows)
	}
	name := "named remotely"
	info := r.ApplyMeta(session.MetaPatch{Name: &name})
	if info.Name != name {
		t.Fatalf("ApplyMeta Name = %q", info.Name)
	}
	if r.Info().Name != name {
		t.Fatal("ApplyMeta did not stick")
	}
}

func TestRemoteSignalAndExit(t *testing.T) {
	dir := holderDir(t)
	r := spawnCat(t, dir)
	if err := r.Signal(syscall.SIGTERM); err != nil {
		t.Fatalf("Signal: %v", err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for r.Info().State != "exited" {
		if time.Now().After(deadline) {
			t.Fatalf("state = %q after SIGTERM, want exited", r.Info().State)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// The reattach story in one process: a second Remote dialing the same
// holder sees the same session, scrollback intact, and can keep writing.
func TestRemoteDialRebuildsFromTheSocket(t *testing.T) {
	dir := holderDir(t)
	first := spawnCat(t, dir)
	sub := first.Subscribe(0)
	waitRemote(t, sub, "remote-ready", 5*time.Second)
	first.Unsubscribe(sub)
	created := first.Info().CreatedAt

	rec := session.IdentityRecord{
		V: 1, ID: first.ID(), Cmd: []string{"cat"}, CreatedAt: created,
	}
	if err := session.SaveIdentity(dir, rec); err != nil {
		t.Fatalf("SaveIdentity: %v", err)
	}
	loaded, err := session.LoadIdentity(dir)
	if err != nil || loaded.ID != rec.ID {
		t.Fatalf("LoadIdentity = %+v, %v", loaded, err)
	}

	second, err := session.DialRemote(dir, loaded, nil)
	if err != nil {
		t.Fatalf("DialRemote: %v", err)
	}
	if second.ID() != first.ID() {
		t.Fatalf("reattached ID = %q, want %q", second.ID(), first.ID())
	}
	if got := second.Info().CreatedAt; !got.Equal(created) {
		t.Fatalf("CreatedAt = %v, want %v", got, created)
	}
	sub2 := second.Subscribe(0)
	defer second.Unsubscribe(sub2)
	if !strings.Contains(string(sub2.Backlog), "remote-ready") {
		t.Fatalf("reattached backlog = %q", sub2.Backlog)
	}
	if err := second.Write([]byte("after-reattach\n")); err != nil {
		t.Fatalf("Write after reattach: %v", err)
	}
	waitRemote(t, sub2, "after-reattach", 5*time.Second)
	_ = second.Close()
}

func TestRemoteCloseRemovesTheHolderDir(t *testing.T) {
	dir := holderDir(t)
	r := spawnCat(t, dir)
	if err := r.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for {
		if _, err := os.Stat(dir); os.IsNotExist(err) {
			return
		}
		if time.Now().After(deadline) {
			t.Fatal("holder dir survived Close")
		}
		time.Sleep(10 * time.Millisecond)
	}
}
