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

// TestWrapInLoginShell pins the argv a shell-resolved command execs: the
// user's login shell, interactive so rc files run and build the PATH the
// user actually has, -c an exec of the original command with every word
// single-quoted. The quoting cases are the ones that would corrupt the
// command line if the join were naive: a space would split one argument in
// two, an embedded quote would end the quoting early, and an empty argument
// would vanish outright.
func TestWrapInLoginShell(t *testing.T) {
	cases := []struct {
		name string
		argv []string
		want string
	}{
		{"plain", []string{"claude", "--resume", "abc123"}, `exec 'claude' '--resume' 'abc123'`},
		{"space", []string{"claude", "a b"}, `exec 'claude' 'a b'`},
		{"quote", []string{"claude", "it's"}, `exec 'claude' 'it'\''s'`},
		{"empty arg", []string{"claude", ""}, `exec 'claude' ''`},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := wrapInLoginShell("/bin/zsh", c.argv)
			want := []string{"/bin/zsh", "-l", "-i", "-c", c.want}
			if len(got) != len(want) {
				t.Fatalf("wrapInLoginShell(%v) = %v, want %v", c.argv, got, want)
			}
			for i := range want {
				if got[i] != want[i] {
					t.Fatalf("wrapInLoginShell(%v) = %v, want %v", c.argv, got, want)
				}
			}
		})
	}
}

// TestSpawnWrapsUnfindableCmdInLoginShell is the launchd bug: a
// service-started daemon carries the bare system PATH, so "claude" — living
// in a directory only the user's shell config knows about — failed LookPath
// and the spawn died with "executable file not found in $PATH" before a
// terminal ever opened. A bare name the daemon cannot find now goes to the
// user's login shell to resolve, exactly as it would had the user typed it,
// while the recorded Cmd stays the caller's own — the wrapper is how the
// session starts, not what it is.
func TestSpawnWrapsUnfindableCmdInLoginShell(t *testing.T) {
	t.Setenv("SHELL", "/bin/sh")
	r := NewRegistry(nil)
	argv := []string{"flue-test-no-such-tool", "--resume", "abc123"}
	s, err := r.Spawn(SpawnOpts{Cmd: argv, Cols: 80, Rows: 24})
	if err != nil {
		t.Fatalf("Spawn: %v", err)
	}
	t.Cleanup(func() { _ = s.Close() })

	want := []string{"/bin/sh", "-l", "-i", "-c", `exec 'flue-test-no-such-tool' '--resume' 'abc123'`}
	if len(s.cmd.Args) != len(want) {
		t.Fatalf("exec argv = %v, want %v", s.cmd.Args, want)
	}
	for i := range want {
		if s.cmd.Args[i] != want[i] {
			t.Fatalf("exec argv = %v, want %v", s.cmd.Args, want)
		}
	}

	s.mu.Lock()
	recorded := s.info.Cmd
	s.mu.Unlock()
	if len(recorded) != 3 || recorded[0] != argv[0] || recorded[1] != argv[1] || recorded[2] != argv[2] {
		t.Fatalf("recorded Cmd = %v, want the caller's %v", recorded, argv)
	}
}

// TestSpawnExecsFindableCmdDirectly is the other half: a command the daemon
// can already resolve execs as given, with no shell between it and the pty.
// The wrapper is a fallback for a PATH the daemon does not have, never a
// reinterpretation of commands it can run fine.
func TestSpawnExecsFindableCmdDirectly(t *testing.T) {
	r := NewRegistry(nil)
	s, err := r.Spawn(SpawnOpts{Cmd: []string{"sleep", "5"}, Cols: 80, Rows: 24})
	if err != nil {
		t.Fatalf("Spawn: %v", err)
	}
	t.Cleanup(func() { _ = s.Close() })
	if len(s.cmd.Args) != 2 || s.cmd.Args[0] != "sleep" || s.cmd.Args[1] != "5" {
		t.Fatalf("exec argv = %v, want [sleep 5]", s.cmd.Args)
	}
}

// TestSpawnExecsPathedCmdDirectly: an argv[0] with a slash names a file, not
// a PATH search, so there is nothing for a login shell to resolve — and a
// path that does not exist should fail the spawn loudly rather than
// detour through a shell that would fail it the same way.
func TestSpawnExecsPathedCmdDirectly(t *testing.T) {
	r := NewRegistry(nil)
	s, err := r.Spawn(SpawnOpts{Cmd: []string{"/bin/sleep", "5"}, Cols: 80, Rows: 24})
	if err != nil {
		t.Fatalf("Spawn: %v", err)
	}
	t.Cleanup(func() { _ = s.Close() })
	if len(s.cmd.Args) != 2 || s.cmd.Args[0] != "/bin/sleep" {
		t.Fatalf("exec argv = %v, want [/bin/sleep 5]", s.cmd.Args)
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
