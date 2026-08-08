package session

import (
	"bytes"
	"errors"
	"syscall"
	"unsafe"
)

// Darwin has no /proc; the kernel's answer to "where is pid's cwd" is the
// proc_info syscall with the PIDVNODEPATHINFO flavor, which libproc wraps as
// proc_pidinfo. The wrapper is C, and cgo for one struct read is a poor
// trade, so this calls the syscall raw and carries the ABI as constants —
// every one of them read off this machine's SDK rather than remembered, and
// all of them proven together by TestProcessCwdReportsSpawnDir, which asks a
// real child in a known directory and checks the answer.
//
// Citations, from MacOSX.sdk/usr/include (xcrun --show-sdk-path):
//
//   - SYS_proc_info = 336                    sys/syscall.h:376
//   - PROC_PIDVNODEPATHINFO = 9              sys/proc_info.h:741
//   - struct proc_vnodepathinfo             sys/proc_info.h:342-345
//     { vnode_info_path pvi_cdir; vnode_info_path pvi_rdir; }
//   - struct vnode_info_path                sys/proc_info.h:316-319
//     { vnode_info vip_vi; char vip_path[MAXPATHLEN]; }
//   - MAXPATHLEN = PATH_MAX = 1024           sys/param.h:196, sys/syslimits.h
//
// The offsets below were computed with clang against those headers
// (offsetof/sizeof, arm64): sizeof(proc_vnodepathinfo) = 2352, and vip_path
// sits 152 bytes in — behind a vnode_info that is a 136-byte vinfo_stat plus
// vi_type, vi_pad and an 8-byte fsid_t. The cwd is pvi_cdir, the first
// member, so its path begins at offset 152 of the whole struct.
//
// The one number the SDK does not publish is the callnum: proc_info
// multiplexes on its first argument, and PROC_INFO_CALL_PIDINFO = 0x2 lives
// in xnu's bsd/sys/proc_info_private.h, which Apple does not ship. It is the
// number libproc itself passes, verified here empirically — with it, the
// syscall on a live pid returns exactly 2352 bytes and the directory the
// child was spawned in; the test keeps proving it on every run.
const (
	sysProcInfo          = 336
	procInfoCallPidinfo  = 0x2
	procPidVnodePathInfo = 9
	vnodePathInfoSize    = 2352
	cdirPathOffset       = 152
	maxPathLen           = 1024
)

// processCwd reports the current working directory of the process pid.
//
// The syscall does not block on the target process — the kernel reads the
// proc structure directly, so a wedged child still answers — but Info keeps
// it outside s.mu anyway; the read needs nothing the lock guards. A pid that
// has exited is an ESRCH, and any failure here means "keep the last known
// value" to the caller, so the errors carry no policy, only diagnosis.
func processCwd(pid int) (string, error) {
	var buf [vnodePathInfoSize]byte
	n, _, errno := syscall.Syscall6(sysProcInfo,
		procInfoCallPidinfo,
		uintptr(pid),
		procPidVnodePathInfo,
		0,
		uintptr(unsafe.Pointer(&buf[0])),
		uintptr(len(buf)))
	if errno != 0 {
		return "", errno
	}
	// proc_info answers with the byte count it filled in. A short answer
	// would mean the ABI above is wrong for this kernel, and a truncated
	// struct is not something to go quietly parsing.
	if int(n) < cdirPathOffset+maxPathLen {
		return "", errors.New("session: proc_info returned a short proc_vnodepathinfo")
	}
	path := buf[cdirPathOffset : cdirPathOffset+maxPathLen]
	if i := bytes.IndexByte(path, 0); i >= 0 {
		path = path[:i]
	}
	// An empty path is a success errno wrapped around no answer. Report it
	// as the failure it is, so Info keeps the previous value rather than
	// blanking the field.
	if len(path) == 0 {
		return "", errors.New("session: proc_info reported an empty cwd")
	}
	return string(path), nil
}
