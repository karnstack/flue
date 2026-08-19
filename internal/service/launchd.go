package service

import (
	"bytes"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"time"
)

// Launchd manages the login service through launchctl on darwin.
type Launchd struct {
	exe  string
	home string
	uid  int
	run  Runner
	// sleep is time.Sleep, held as a field so awaitBootout's polling is
	// testable without the test actually waiting.
	sleep func(time.Duration)
}

func NewLaunchd(exe, home string, uid int, r Runner) *Launchd {
	return &Launchd{exe: exe, home: home, uid: uid, run: r, sleep: time.Sleep}
}

func (l *Launchd) unitPath() string {
	return filepath.Join(l.home, "Library", "LaunchAgents", LaunchdLabel+".plist")
}

// RefreshUnit converges the plist on disk and nothing else; see
// UnitRefresher. Restart's bootstrap reads the file fresh, so a refresh
// followed by Restart is how a plist change reaches an existing install.
func (l *Launchd) RefreshUnit() error {
	if err := os.MkdirAll(filepath.Dir(l.unitPath()), 0o755); err != nil {
		return err
	}
	return os.WriteFile(l.unitPath(), LaunchdPlist(l.exe), 0o644)
}

func (l *Launchd) domainTarget() string { return fmt.Sprintf("gui/%d", l.uid) }
func (l *Launchd) serviceTarget() string {
	return fmt.Sprintf("gui/%d/%s", l.uid, LaunchdLabel)
}

// awaitBootout waits for a booted-out label to actually leave the domain.
//
// bootout is asynchronous: it starts the teardown — SIGTERM, then launchd's
// exit timeout — and returns without waiting for the process to die, so the
// label stays registered for as long as the daemon takes to exit. flue's
// daemon takes real time on purpose (SIGTERM is the path that saves session
// snapshots), and a bootstrap issued while the label is still draining is
// refused with the famously unhelpful "Bootstrap failed: 5: Input/output
// error". That is exactly what `flue disable && flue enable` used to hit:
// disable's bootout was still draining when enable's bootstrap arrived.
//
// So: poll `launchctl print` until the label is gone — an error from print is
// the success condition — and give up after bootoutWait rather than hang a
// CLI on a daemon that will not die; launchd's own exit timeout SIGKILLs
// stragglers, and if even that has not happened the following bootstrap
// fails with an error worth reporting.
func (l *Launchd) awaitBootout() {
	for i := 0; i < int(bootoutWait/bootoutPoll); i++ {
		if _, err := l.run.Run("launchctl", "print", l.serviceTarget()); err != nil {
			return
		}
		l.sleep(bootoutPoll)
	}
}

const (
	// bootoutWait is how long awaitBootout is willing to watch a label drain.
	// Long enough for a graceful exit that is busy writing snapshots, and
	// comfortably past launchd's default exit timeout, after which nothing
	// more is coming.
	bootoutWait = 20 * time.Second
	bootoutPoll = 100 * time.Millisecond
)

// Enable writes the plist and bootstraps it — the modern spelling, not
// `launchctl load`. When the label is already bootstrapped, bootstrap
// refuses; whether that is convergence depends on whether the plist just
// changed. launchd reads a plist only at bootstrap, so a loaded job keeps
// its old definition no matter what Enable writes to disk: when the render
// differs from what was there (a new binary path after an upgrade), Enable
// must bootout the stale job and bootstrap the fresh plist — restarting the
// daemon on purpose, because the old job would exec a path that may no
// longer exist. When the plist is byte-identical, the loaded job already
// matches, so Enable only verifies the label is loaded (print) and
// kickstarts it in case it is dead. kickstart without -k never restarts a
// running service, which is what keeps a no-op re-run of flue enable from
// killing live sessions.
func (l *Launchd) Enable() error {
	if err := os.MkdirAll(filepath.Dir(l.unitPath()), 0o755); err != nil {
		return err
	}
	rendered := LaunchdPlist(l.exe)
	prev, readErr := os.ReadFile(l.unitPath())
	changed := readErr != nil || !bytes.Equal(prev, rendered)
	if err := os.WriteFile(l.unitPath(), rendered, 0o644); err != nil {
		return err
	}
	out, err := l.run.Run("launchctl", "bootstrap", l.domainTarget(), l.unitPath())
	if err == nil {
		return nil
	}
	if _, perr := l.run.Run("launchctl", "print", l.serviceTarget()); perr == nil {
		if !changed {
			_, _ = l.run.Run("launchctl", "kickstart", l.serviceTarget())
			return nil
		}
		// The loaded job predates the plist on disk. Bootout errors are
		// tolerated — if the label somehow unloaded itself between print and
		// here, the re-bootstrap is the call that matters and its error is
		// the one worth reporting. The wait between the two is load-bearing:
		// see awaitBootout. This branch is also where `flue disable && flue
		// enable` lands — disable's own bootout may still be draining when
		// enable runs, in which case the print above finds the label loaded
		// and the bootout here is a no-op against a teardown already in
		// flight.
		_, _ = l.run.Run("launchctl", "bootout", l.serviceTarget())
		l.awaitBootout()
		if bout, berr := l.run.Run("launchctl", "bootstrap", l.domainTarget(), l.unitPath()); berr != nil {
			return fmt.Errorf("launchctl bootstrap after bootout: %v: %s", berr, bout)
		}
		return nil
	}
	return fmt.Errorf("launchctl bootstrap: %v: %s", err, out)
}

// Restart stops the loaded job and bootstraps the plist on disk — the same
// bootout+bootstrap sequence Enable uses when the plist has drifted, chosen
// over `launchctl kickstart -k` on purpose: bootout tears the job down the
// graceful way (SIGTERM, then launchd's exit timeout), which is the signal
// cmdServe saves session snapshots on, while kickstart -k kills. A restart
// after an upgrade exists to carry live sessions onto the new build, so the
// graceful spelling is the only right one.
//
// The bootout error is tolerated for the reason Enable tolerates it: an
// unloaded label is not a failure to stop it, and the bootstrap — which reads
// the plist fresh, so it also converges any drift — is the call whose error
// matters. awaitBootout between the two is what makes the sequence work at
// all: bootout only starts the teardown, and bootstrapping the same label
// while it drains is refused with EIO.
func (l *Launchd) Restart() error {
	_, _ = l.run.Run("launchctl", "bootout", l.serviceTarget())
	l.awaitBootout()
	if out, err := l.run.Run("launchctl", "bootstrap", l.domainTarget(), l.unitPath()); err != nil {
		return fmt.Errorf("launchctl bootstrap: %v: %s", err, out)
	}
	return nil
}

// Disable boots the agent out and removes the plist. Both halves tolerate
// absence: a bootout of an unloaded label and a remove of a missing file are
// what "already disabled" looks like, and that is a success.
func (l *Launchd) Disable() error {
	_, _ = l.run.Run("launchctl", "bootout", l.serviceTarget())
	if err := os.Remove(l.unitPath()); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	return nil
}

func (l *Launchd) Status() (Status, error) {
	var st Status
	if _, err := os.Stat(l.unitPath()); err == nil {
		st.Installed = true
	}
	if _, err := l.run.Run("launchctl", "print", l.serviceTarget()); err == nil {
		st.Running = true
	}
	return st, nil
}
