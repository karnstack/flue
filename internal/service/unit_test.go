package service

import "testing"

// The unit files are asserted byte for byte: paths, escaping, and the resolved
// executable are exactly what a service manager parses, and "roughly right"
// XML or INI is how a login service silently fails to start.

func TestLaunchdPlist(t *testing.T) {
	cases := []struct {
		name string
		exe  string
		want string
	}{
		{
			name: "plain path",
			exe:  "/usr/local/bin/flue",
			want: `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>sh.flue.daemon</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/flue</string>
    <string>serve</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
</dict>
</plist>
`,
		},
		{
			name: "path with an ampersand is XML-escaped",
			exe:  "/Users/karn/dev & play/flue",
			want: `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>sh.flue.daemon</string>
  <key>ProgramArguments</key>
  <array>
    <string>/Users/karn/dev &amp; play/flue</string>
    <string>serve</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
</dict>
</plist>
`,
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := string(LaunchdPlist(c.exe)); got != c.want {
				t.Fatalf("LaunchdPlist(%q) =\n%s\nwant\n%s", c.exe, got, c.want)
			}
		})
	}
}

func TestSystemdUnit(t *testing.T) {
	cases := []struct {
		name string
		exe  string
		want string
	}{
		{
			name: "plain path",
			exe:  "/usr/local/bin/flue",
			want: `[Unit]
Description=flue daemon

[Service]
ExecStart="/usr/local/bin/flue" serve
Restart=on-failure

[Install]
WantedBy=default.target
`,
		},
		{
			name: "path with a space survives the quoting",
			exe:  "/home/karn/my tools/flue",
			want: `[Unit]
Description=flue daemon

[Service]
ExecStart="/home/karn/my tools/flue" serve
Restart=on-failure

[Install]
WantedBy=default.target
`,
		},
		{
			name: "percent is doubled so systemd does not read a specifier",
			exe:  "/opt/100%tools/flue",
			want: `[Unit]
Description=flue daemon

[Service]
ExecStart="/opt/100%%tools/flue" serve
Restart=on-failure

[Install]
WantedBy=default.target
`,
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := string(SystemdUnit(c.exe)); got != c.want {
				t.Fatalf("SystemdUnit(%q) =\n%s\nwant\n%s", c.exe, got, c.want)
			}
		})
	}
}
