package service

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// ErrNoUserManager reports that systemctl --user has nobody to talk to —
// the common WSL shape. The CLI turns this into a one-line pointer at
// `flue serve`; it is never a stack trace.
var ErrNoUserManager = errors.New("service: systemd user services are not available here (no user manager — common on WSL)")

// Systemd manages the login service through systemctl --user on linux.
type Systemd struct {
	exe  string
	home string
	run  Runner
}

func NewSystemd(exe, home string, r Runner) *Systemd {
	return &Systemd{exe: exe, home: home, run: r}
}

func (s *Systemd) unitPath() string {
	return filepath.Join(s.home, ".config", "systemd", "user", "flue.service")
}

// available reports whether a user manager is reachable at all.
//
// `is-system-running` answers "degraded" with a non-zero exit on perfectly
// usable systems, so a bare error is not evidence of absence. Absence looks
// like exactly two things: the binary is missing, or the output says the
// user bus is unreachable.
func (s *Systemd) available() error {
	out, err := s.run.Run("systemctl", "--user", "is-system-running")
	if err == nil {
		return nil
	}
	if errors.Is(err, exec.ErrNotFound) || strings.Contains(string(out), "Failed to connect to bus") {
		return fmt.Errorf("%w: %s", ErrNoUserManager, strings.TrimSpace(string(out)))
	}
	return nil
}

// Enable writes the unit, reloads, and runs the spec's exact command:
// `systemctl --user enable --now flue`. Rewriting the unit unconditionally is
// what converges drift; enable --now starts the service only when it is not
// already active, so a healthy daemon is never restarted.
func (s *Systemd) Enable() error {
	if err := s.available(); err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(s.unitPath()), 0o755); err != nil {
		return err
	}
	if err := os.WriteFile(s.unitPath(), SystemdUnit(s.exe), 0o644); err != nil {
		return err
	}
	if out, err := s.run.Run("systemctl", "--user", "daemon-reload"); err != nil {
		return fmt.Errorf("systemctl --user daemon-reload: %v: %s", err, out)
	}
	if out, err := s.run.Run("systemctl", "--user", "enable", "--now", "flue"); err != nil {
		return fmt.Errorf("systemctl --user enable --now flue: %v: %s", err, out)
	}
	return nil
}

// Disable stops and disables the unit, removes the file, and reloads. Every
// systemctl failure is tolerated: on a machine with no user manager the file
// removal is the whole operation, and "already disabled" is a success.
func (s *Systemd) Disable() error {
	_, _ = s.run.Run("systemctl", "--user", "disable", "--now", "flue")
	if err := os.Remove(s.unitPath()); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	_, _ = s.run.Run("systemctl", "--user", "daemon-reload")
	return nil
}

func (s *Systemd) Status() (Status, error) {
	var st Status
	if _, err := os.Stat(s.unitPath()); err == nil {
		st.Installed = true
	}
	if _, err := s.run.Run("systemctl", "--user", "is-active", "flue"); err == nil {
		st.Running = true
	}
	return st, nil
}
