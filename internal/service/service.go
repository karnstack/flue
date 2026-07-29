package service

import "os/exec"

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
