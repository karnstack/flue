package service

import (
	"errors"
	"os/exec"
)

// Runner executes one service-manager command and returns its combined
// output. It exists so the command flows are testable against a fake and so
// CI never touches a real launchd or systemd.
type Runner interface {
	Run(name string, args ...string) ([]byte, error)
}

// ExecRunner is the production Runner.
type ExecRunner struct{}

func (ExecRunner) Run(name string, args ...string) ([]byte, error) {
	return exec.Command(name, args...).CombinedOutput()
}

// Status reports the login service's two independent facts.
type Status struct {
	Installed bool // the unit file is on disk
	Running   bool // the service manager reports it alive
}

// Manager installs, removes, and inspects the flue login service.
//
//   - Enable converges: it rewrites the unit if it drifted, loads it if it is
//     not loaded, and starts it if it is dead — without restarting a healthy
//     daemon, whose sessions must survive a re-run of flue enable.
//   - Disable is idempotent: disabling what is not enabled is nil.
type Manager interface {
	Enable() error
	Disable() error
	Status() (Status, error)
}

// Warner is optionally implemented by a Manager whose Enable can succeed
// while still owing the user a fact. Warnings reports advisories from the
// most recent Enable — true and unfortunate but not failures, like
// loginctl enable-linger being refused in a container, where the service
// works while logged in and dies at the last logout. Launchd never warns,
// so it does not implement this; the CLI upgrades with a type assertion.
type Warner interface {
	Warnings() []string
}

// ErrUnsupported reports a platform with no login-service support. flue
// ships darwin and linux; WSL is linux with, usually, no user manager —
// which is ErrNoUserManager at Enable time, not this.
var ErrUnsupported = errors.New("service: no login-service support on this platform")

// ForPlatform picks the implementation for goos. It takes goos as a
// parameter rather than reading runtime.GOOS so both arms are testable on
// any host.
func ForPlatform(goos, exe, home string, uid int, r Runner) (Manager, error) {
	switch goos {
	case "darwin":
		return NewLaunchd(exe, home, uid, r), nil
	case "linux":
		return NewSystemd(exe, home, r), nil
	}
	return nil, ErrUnsupported
}
