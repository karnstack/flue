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

	// warnings from the most recent Enable: true, unfortunate, not fatal.
	// See Warner in service.go.
	warnings []string
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
	s.warnings = nil
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
	// Lingering is what keeps the daemon alive past the last logout. Without
	// it, logind stops the per-user systemd instance — this unit, the
	// daemon, every session — when the user's last login session ends, which
	// inverts the whole promise on a headless box: SSH in, enable, start a
	// build, log out, and everything dies. enable-linger with no argument
	// targets the calling user and is idempotent, so it runs on every
	// enable. Some containers and hardened distros refuse it; the unit still
	// works while a login exists, so a refusal is a warning, never a failed
	// enable.
	if out, err := s.run.Run("loginctl", "enable-linger"); err != nil {
		s.warnings = append(s.warnings, fmt.Sprintf(
			"loginctl enable-linger failed (%v: %s) — without lingering, your last logout stops the daemon and every flue session; run \"loginctl enable-linger\" yourself to fix this",
			err, strings.TrimSpace(string(out))))
	}
	return nil
}

// Warnings reports the advisories from the most recent Enable.
func (s *Systemd) Warnings() []string { return s.warnings }

// Restart is systemd's own word for it: systemctl --user restart flue. The
// unit is stopped with SIGTERM — the graceful path cmdServe saves session
// snapshots on — and started from the unit file on disk, so a binary swapped
// since the last start is the one that execs. restart also starts a unit
// that happens to be dead, which is the convergence an update wants: the
// point is that the next running daemon is the new build.
func (s *Systemd) Restart() error {
	if out, err := s.run.Run("systemctl", "--user", "restart", "flue"); err != nil {
		return fmt.Errorf("systemctl --user restart flue: %v: %s", err, out)
	}
	return nil
}

// Disable stops and disables the unit, removes the file, and reloads. Every
// systemctl failure is tolerated: on a machine with no user manager the file
// removal is the whole operation, and "already disabled" is a success.
//
// Lingering is deliberately left as Enable set it. It is a per-user fact,
// not a per-service one — the user may linger for reasons that have nothing
// to do with flue — and disable-linger here would stop their other user
// services at logout. Removing the unit already means flue no longer runs.
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
