package session

import (
	"fmt"
	"os"
)

// processCwd reports the current working directory of the process pid.
//
// On Linux the kernel keeps the answer as a magic symlink, and reading it
// asks the process nothing: the target comes out of the task's fs_struct, so
// a shell wedged in uninterruptible I/O still answers, and answers with the
// resolved path — /proc/pid/cwd never reports the alias the process typed,
// which is why every consumer comparing directories resolves its own side
// too. A pid that has exited (or was never ours) is an ENOENT from Readlink,
// and Info treats any error here as "keep the last known value".
func processCwd(pid int) (string, error) {
	return os.Readlink(fmt.Sprintf("/proc/%d/cwd", pid))
}
