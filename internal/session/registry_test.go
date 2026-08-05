package session

import (
	"strings"
	"testing"
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

func contains(env []string, kv string) bool {
	for _, e := range env {
		if e == kv {
			return true
		}
	}
	return false
}
