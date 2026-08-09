package session

import (
	"strings"
	"testing"
	"time"
)

func TestLoginShellPrefersSHELL(t *testing.T) {
	t.Setenv("SHELL", "/opt/homebrew/bin/fish")
	if got := loginShell(); got != "/opt/homebrew/bin/fish" {
		t.Fatalf("loginShell() = %q, want $SHELL", got)
	}
}

// TestLoginShellWithoutSHELL is the launchd/systemd path: no login-session
// environment, so the shell must come from the user database. The exact
// value is the machine's own; what must hold is that it is a real absolute
// path, not a hardcoded guess.
func TestLoginShellWithoutSHELL(t *testing.T) {
	t.Setenv("SHELL", "")
	got := loginShell()
	if !strings.HasPrefix(got, "/") {
		t.Fatalf("loginShell() = %q, want an absolute path", got)
	}
}

func TestShellFromDscl(t *testing.T) {
	cases := []struct {
		name, out, want string
	}{
		{"typical", "UserShell: /bin/zsh\n", "/bin/zsh"},
		{"bash user", "UserShell: /opt/homebrew/bin/bash\n", "/opt/homebrew/bin/bash"},
		{"no colon", "garbage", ""},
		{"relative path", "UserShell: zsh\n", ""},
		{"empty value", "UserShell:\n", ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := shellFromDscl(c.out); got != c.want {
				t.Fatalf("shellFromDscl(%q) = %q, want %q", c.out, got, c.want)
			}
		})
	}
}

func TestShellFromPasswd(t *testing.T) {
	cases := []struct {
		name, out, want string
	}{
		{"typical", "karn:x:1000:1000:Karn:/home/karn:/usr/bin/fish\n", "/usr/bin/fish"},
		{"no trailing newline", "karn:x:1000:1000::/home/karn:/bin/bash", "/bin/bash"},
		{"short line", "karn:x:1000\n", ""},
		{"empty shell field", "karn:x:1000:1000::/home/karn:\n", ""},
		{"relative shell", "karn:x:1000:1000::/home/karn:bash\n", ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := shellFromPasswd(c.out); got != c.want {
				t.Fatalf("shellFromPasswd(%q) = %q, want %q", c.out, got, c.want)
			}
		})
	}
}

func TestSessionEnvFillsInSHELL(t *testing.T) {
	env := sessionEnv([]string{"PATH=/usr/bin"}, "/bin/bash")
	if !contains(env, "SHELL=/bin/bash") {
		t.Fatalf("sessionEnv without SHELL = %v, want SHELL=/bin/bash appended", env)
	}
	if !contains(env, "TERM=xterm-256color") {
		t.Fatalf("sessionEnv dropped TERM: %v", env)
	}
}

func TestSessionEnvKeepsAnExistingSHELL(t *testing.T) {
	env := sessionEnv([]string{"SHELL=/usr/bin/fish"}, "/bin/bash")
	if contains(env, "SHELL=/bin/bash") {
		t.Fatalf("sessionEnv overrode the daemon's own SHELL: %v", env)
	}
	if !contains(env, "SHELL=/usr/bin/fish") {
		t.Fatalf("sessionEnv lost the daemon's own SHELL: %v", env)
	}
}

// TestSpawnDefaultsCwdToHome pins where a session with no stated directory
// opens: the user's home, like any terminal emulator or sshd. The alternative
// — inheriting the daemon's own directory — is the launchd/systemd bug: a
// service-started daemon runs at /, so every plain new session opened there.
// os.UserHomeDir answers from $HOME on every platform flue targets, so
// setting it is setting the expectation. Both the recorded cwd and the
// child's real one are checked, because the fix is one resolution feeding
// both — a seed that disagreed with the process would be the old split back
// again. The poll and the symlink resolution are cwd_test.go's, for
// cwd_test.go's reasons.
func TestSpawnDefaultsCwdToHome(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	want := resolved(t, home)

	r := NewRegistry(nil)
	s, err := r.Spawn(SpawnOpts{Cmd: []string{"sleep", "5"}, Cols: 80, Rows: 24})
	if err != nil {
		t.Fatalf("Spawn: %v", err)
	}
	t.Cleanup(func() { _ = s.Close() })

	s.mu.Lock()
	seeded := s.info.Cwd
	s.mu.Unlock()
	if seeded != home {
		t.Fatalf("recorded Cwd = %q, want the home %q", seeded, home)
	}

	deadline := time.Now().Add(5 * time.Second)
	for {
		got, err := processCwd(s.pid)
		if err == nil && resolved(t, got) == want {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("processCwd(%d) = %q, %v; want %q", s.pid, got, err, want)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// TestSpawnKeepsExplicitCwd is the other half of the default: a caller that
// states a directory gets that directory, and home never competes with it.
// The stated one is deliberately not $HOME, so a spawn that reached for home
// anyway could not pass by coincidence.
func TestSpawnKeepsExplicitCwd(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	dir := t.TempDir()
	want := resolved(t, dir)

	r := NewRegistry(nil)
	s, err := r.Spawn(SpawnOpts{Cwd: dir, Cmd: []string{"sleep", "5"}, Cols: 80, Rows: 24})
	if err != nil {
		t.Fatalf("Spawn: %v", err)
	}
	t.Cleanup(func() { _ = s.Close() })

	s.mu.Lock()
	seeded := s.info.Cwd
	s.mu.Unlock()
	if seeded != dir {
		t.Fatalf("recorded Cwd = %q, want the stated %q", seeded, dir)
	}

	deadline := time.Now().Add(5 * time.Second)
	for {
		got, err := processCwd(s.pid)
		if err == nil && resolved(t, got) == want {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("processCwd(%d) = %q, %v; want %q", s.pid, got, err, want)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func contains(env []string, kv string) bool {
	for _, e := range env {
		if e == kv {
			return true
		}
	}
	return false
}
