// Package service installs and removes the flue login service: a launchd
// agent on darwin, a systemd user unit on linux. It is self-contained —
// cmd/flue consumes it and nothing else does — and every interaction with a
// real service manager goes through the Runner seam so tests never touch one.
package service

import (
	"encoding/xml"
	"strings"
)

// LaunchdLabel is the launchd service label and the plist's basename.
const LaunchdLabel = "sh.flue.daemon"

// LaunchdPlist renders the launchd agent plist that runs `exe serve` at login.
// exe is the path os.Executable reports, symlinks left intact — for a brew
// cask install that is the stable /opt/homebrew/bin/flue symlink, not the
// version-pinned Caskroom target that `brew upgrade` deletes.
//
// AbandonProcessGroup is what lets sessions outlive the daemon: without it,
// launchd cleans up the job's process group when the job ends, and the
// per-session holder processes — the whole point of which is to survive the
// daemon — would be collateral. They setsid away regardless, so the key is
// belt on top of braces, but the intent belongs in the unit.
func LaunchdPlist(exe string) []byte {
	return []byte(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>` + LaunchdLabel + `</string>
  <key>ProgramArguments</key>
  <array>
    <string>` + xmlEscape(exe) + `</string>
    <string>serve</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>AbandonProcessGroup</key>
  <true/>
</dict>
</plist>
`)
}

// SystemdUnit renders the systemd user unit that runs `exe serve` at login.
// The path is double-quoted for systemd's ExecStart lexer, and % is doubled
// because ExecStart expands specifiers.
//
// KillMode=process is load-bearing for session durability: the default
// control-group mode kills every process in the unit's cgroup on stop or
// restart, holders included, which would put sessions right back to dying
// with the daemon. process scopes the stop signal to the daemon alone.
// Logout and reboot still tear the user slice down with SIGTERM, which is
// the signal a holder answers by writing its revival snapshot.
func SystemdUnit(exe string) []byte {
	return []byte(`[Unit]
Description=flue daemon

[Service]
ExecStart=` + systemdQuote(exe) + ` serve
Restart=on-failure
KillMode=process

[Install]
WantedBy=default.target
`)
}

func xmlEscape(s string) string {
	var b strings.Builder
	// EscapeText cannot fail on a strings.Builder.
	_ = xml.EscapeText(&b, []byte(s))
	return b.String()
}

func systemdQuote(s string) string {
	r := strings.NewReplacer(`\`, `\\`, `"`, `\"`, "%", "%%")
	return `"` + r.Replace(s) + `"`
}
