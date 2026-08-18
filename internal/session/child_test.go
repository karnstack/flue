package session

import (
	"strings"
	"testing"
	"time"
)

// StartChild is the engine's raw constructor: everything ResolveSpawn
// decides arrives already decided. The holder calls it with a wire-borne
// config; registry.start calls it with a locally resolved one. This test
// pins the contract both lean on.
func TestStartChildRunsAResolvedSpawn(t *testing.T) {
	created := time.Now().Add(-time.Hour).Truncate(time.Second)
	cfg := ChildConfig{
		ID:   "cafebabe00000001",
		Run:  []string{"sh", "-c", "echo child-here; sleep 5"},
		Argv: []string{"custom-tool"},
		Env:  append(sessionEnv(nil, "/bin/sh"), "CHILD_TEST=1"),
		Cwd:  t.TempDir(),
		Cols: 91, Rows: 33,
		Preload: []byte("restored-bytes\r\n"),
		Restore: Info{Title: "old title", Name: "kept name", CreatedAt: created},
		Group:   "cafebabe00000000",
	}
	s, err := StartChild(cfg)
	if err != nil {
		t.Fatalf("StartChild: %v", err)
	}
	t.Cleanup(func() { _ = s.Close() })

	sub := s.Subscribe(0)
	defer s.Unsubscribe(sub)
	waitFor(t, sub, "child-here", 5*time.Second)
	if got := string(sub.Backlog); !strings.HasPrefix(got, "restored-bytes") {
		t.Errorf("preload did not precede live output; backlog starts %q", got[:min(len(got), 40)])
	}

	info := s.Info()
	if info.ID != cfg.ID {
		t.Errorf("ID = %q, want %q", info.ID, cfg.ID)
	}
	if got := info.Cmd; len(got) != 1 || got[0] != "custom-tool" {
		t.Errorf("Info.Cmd = %v, want the display argv, not the run argv", got)
	}
	if info.Cols != 91 || info.Rows != 33 {
		t.Errorf("size = %dx%d, want 91x33", info.Cols, info.Rows)
	}
	if info.Title != "old title" || info.Name != "kept name" {
		t.Errorf("restore fields lost: title %q name %q", info.Title, info.Name)
	}
	if !info.CreatedAt.Equal(created) {
		t.Errorf("CreatedAt = %v, want the restored %v", info.CreatedAt, created)
	}
	if info.Group != "cafebabe00000000" {
		t.Errorf("Group = %q, want the config's", info.Group)
	}
	if info.State != "running" {
		t.Errorf("State = %q, want running", info.State)
	}
}

// ResolveSpawn owns every default StartChild refuses to guess at.
func TestResolveSpawnFillsDefaults(t *testing.T) {
	cfg := ResolveSpawn(SpawnOpts{})
	if len(cfg.Run) == 0 || len(cfg.Argv) == 0 {
		t.Fatal("empty Cmd did not resolve to the login shell")
	}
	if cfg.Cols != 80 || cfg.Rows != 24 {
		t.Errorf("default size = %dx%d, want 80x24", cfg.Cols, cfg.Rows)
	}
	if cfg.RingSize != DefaultRingSize {
		t.Errorf("RingSize = %d, want DefaultRingSize", cfg.RingSize)
	}
	if cfg.Cwd == "" {
		t.Error("Cwd empty: home fallback did not apply")
	}
	foundTerm := false
	for _, kv := range cfg.Env {
		if kv == "TERM=xterm-256color" {
			foundTerm = true
		}
	}
	if !foundTerm {
		t.Error("Env lacks the pinned TERM")
	}
}
