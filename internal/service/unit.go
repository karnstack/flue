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
</dict>
</plist>
`)
}

// SystemdUnit renders the systemd user unit that runs `exe serve` at login.
// The path is double-quoted for systemd's ExecStart lexer, and % is doubled
// because ExecStart expands specifiers.
func SystemdUnit(exe string) []byte {
	return []byte(`[Unit]
Description=flue daemon

[Service]
ExecStart=` + systemdQuote(exe) + ` serve
Restart=on-failure

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
