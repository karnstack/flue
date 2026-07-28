package daemon

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"

	"github.com/karnstack/flue/internal/config"
)

type runtimeFile struct {
	Port int `json:"port"`
	PID  int `json:"pid"`
}

func runtimePath() (string, error) {
	dir, err := config.Dir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "runtime.json"), nil
}

// WriteRuntime records the port the daemon is listening on so other flue
// invocations can find it.
//
// The replacement lands on a fresh inode and is renamed into place rather
// than truncating runtime.json in place: os.Rename is atomic on the
// filesystems flue targets, but truncate-then-write is not, and this file is
// read by other flue invocations (open, status) that may run concurrently
// with the daemon that owns it. A torn read here just means one extra
// "not running" false negative, not a security issue the way it is for the
// auth token — but there's no reason to accept even that when the fix is the
// same few lines config.LoadOrCreateToken already uses.
func WriteRuntime(port int) error {
	path, err := runtimePath()
	if err != nil {
		return err
	}
	b, err := json.Marshal(runtimeFile{Port: port, PID: os.Getpid()})
	if err != nil {
		return err
	}

	dir := filepath.Dir(path)
	tmp, err := os.CreateTemp(dir, "runtime-*.tmp")
	if err != nil {
		return err
	}
	tmpPath := tmp.Name()
	defer os.Remove(tmpPath) // no-op once the rename below has succeeded

	if _, err := tmp.Write(b); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmpPath, path)
}

// ReadRuntime returns the recorded port, if any.
//
// A record is a hint, not proof: it survives a daemon that was killed, and the
// port it names may by then belong to an unrelated process. Callers must
// confirm what is actually listening before trusting it with anything —
// above all before sending it the auth token.
func ReadRuntime() (int, bool) {
	path, err := runtimePath()
	if err != nil {
		return 0, false
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return 0, false
	}
	var rf runtimeFile
	if err := json.Unmarshal(b, &rf); err != nil {
		return 0, false
	}
	if rf.Port == 0 {
		return 0, false
	}
	return rf.Port, true
}

// ClearRuntime removes this process's runtime record. A daemon calls it on the
// way out so a later flue invocation reports "not running" outright instead of
// probing a port that may have been taken over by something else in the
// meantime.
//
// It removes the record only if the record is still ours. A second daemon
// started by hand on another port overwrites the file while the first is still
// running; the first one exiting must not then delete the survivor's record
// and make a live daemon undiscoverable. This is best-effort by nature —
// nothing runs on SIGKILL — which is exactly why readers still have to
// confirm what is listening rather than trust the file.
func ClearRuntime() error {
	path, err := runtimePath()
	if err != nil {
		return err
	}
	b, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		return err
	}
	var rf runtimeFile
	if err := json.Unmarshal(b, &rf); err == nil && rf.PID != 0 && rf.PID != os.Getpid() {
		return nil
	}
	if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}
