package service

import (
	"bytes"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
)

// Launchd manages the login service through launchctl on darwin.
type Launchd struct {
	exe  string
	home string
	uid  int
	run  Runner
}

func NewLaunchd(exe, home string, uid int, r Runner) *Launchd {
	return &Launchd{exe: exe, home: home, uid: uid, run: r}
}

func (l *Launchd) unitPath() string {
	return filepath.Join(l.home, "Library", "LaunchAgents", LaunchdLabel+".plist")
}

func (l *Launchd) domainTarget() string { return fmt.Sprintf("gui/%d", l.uid) }
func (l *Launchd) serviceTarget() string {
	return fmt.Sprintf("gui/%d/%s", l.uid, LaunchdLabel)
}

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
		// the one worth reporting.
		_, _ = l.run.Run("launchctl", "bootout", l.serviceTarget())
		if bout, berr := l.run.Run("launchctl", "bootstrap", l.domainTarget(), l.unitPath()); berr != nil {
			return fmt.Errorf("launchctl bootstrap after bootout: %v: %s", berr, bout)
		}
		return nil
	}
	return fmt.Errorf("launchctl bootstrap: %v: %s", err, out)
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
