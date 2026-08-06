package config

import (
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestSaveRelayRoundTrips(t *testing.T) {
	base := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", base)

	want := Relay{
		URL:    "wss://flue-relay.karn.workers.dev/daemon",
		Secret: "s3cr3t-daemon-secret",
		Origin: "https://flue-relay.karn.workers.dev",
	}
	if err := SaveRelay(want); err != nil {
		t.Fatalf("SaveRelay: %v", err)
	}

	got, ok, err := LoadRelay()
	if err != nil {
		t.Fatalf("LoadRelay: %v", err)
	}
	if !ok {
		t.Fatal("LoadRelay ok = false after SaveRelay, want true")
	}
	if got != want {
		t.Fatalf("LoadRelay = %+v, want %+v", got, want)
	}
}

// TestSaveRelayWritesOwnerOnly: the file holds the daemon secret, which is the
// whole credential for the relay leg. A mode any other local user can read
// would hand it over.
func TestSaveRelayWritesOwnerOnly(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("unix permission bits only")
	}
	base := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", base)

	if err := SaveRelay(Relay{URL: "wss://r.example/daemon", Secret: "s", Origin: "https://r.example"}); err != nil {
		t.Fatalf("SaveRelay: %v", err)
	}

	info, err := os.Stat(filepath.Join(base, "flue", "relay.json"))
	if err != nil {
		t.Fatalf("Stat relay.json: %v", err)
	}
	if mode := info.Mode().Perm(); mode != 0o600 {
		t.Errorf("relay.json mode = %o, want 0600", mode)
	}
}

// TestSaveRelayTightensAPreExistingLooseMode: os.WriteFile only applies its
// mode when it creates the file, so overwriting a relay.json somebody left at
// 0644 in place would persist a fresh secret at the old, readable mode. The
// CreateTemp+rename pattern lands it on a file that was 0600 from the start.
func TestSaveRelayTightensAPreExistingLooseMode(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("unix permission bits only")
	}
	base := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", base)

	dir := filepath.Join(base, "flue")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	path := filepath.Join(dir, "relay.json")
	if err := os.WriteFile(path, []byte(`{"url":"","secret":"old","origin":""}`), 0o644); err != nil {
		t.Fatalf("pre-create relay.json: %v", err)
	}

	if err := SaveRelay(Relay{URL: "wss://r.example/daemon", Secret: "new", Origin: "https://r.example"}); err != nil {
		t.Fatalf("SaveRelay: %v", err)
	}

	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("Stat: %v", err)
	}
	if mode := info.Mode().Perm(); mode != 0o600 {
		t.Errorf("relay.json mode = %o, want 0600 (a pre-existing loose mode must not survive a save)", mode)
	}
}

// TestSaveRelayDoesNotWriteThroughARetainedDescriptor is the token file's
// argument applied to the relay secret: unix permission checks happen at open,
// not at read, so a process that opened a world-readable relay.json and kept
// the descriptor would read the *new* secret through it if the save wrote in
// place. Replacing the inode leaves that descriptor on the old file.
func TestSaveRelayDoesNotWriteThroughARetainedDescriptor(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("unix permission bits only")
	}
	base := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", base)

	dir := filepath.Join(base, "flue")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	path := filepath.Join(dir, "relay.json")
	if err := os.WriteFile(path, []byte(`{"url":"","secret":"old","origin":""}`), 0o644); err != nil {
		t.Fatalf("pre-create relay.json: %v", err)
	}
	retained, err := os.Open(path)
	if err != nil {
		t.Fatalf("open retained fd: %v", err)
	}
	defer retained.Close()

	const fresh = "brand-new-daemon-secret"
	if err := SaveRelay(Relay{URL: "wss://r.example/daemon", Secret: fresh, Origin: "https://r.example"}); err != nil {
		t.Fatalf("SaveRelay: %v", err)
	}

	if _, err := retained.Seek(0, 0); err != nil {
		t.Fatalf("seek retained fd: %v", err)
	}
	b, err := io.ReadAll(retained)
	if err != nil {
		t.Fatalf("read through retained fd: %v", err)
	}
	if strings.Contains(string(b), fresh) {
		t.Fatalf("a descriptor opened while relay.json was world-readable observed the new secret; SaveRelay must replace the inode (write-temp-then-rename) rather than write through it")
	}
}

func TestLoadRelayReportsAbsence(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())

	got, ok, err := LoadRelay()
	if err != nil {
		t.Fatalf("LoadRelay with no relay.json = %v, want no error", err)
	}
	if ok {
		t.Fatalf("LoadRelay ok = true with no relay.json, want false (got %+v)", got)
	}
	if got != (Relay{}) {
		t.Errorf("LoadRelay = %+v with no relay.json, want the zero value", got)
	}
}

// TestLoadRelayRefusesMalformedJSON: a relay.json that cannot be parsed is an
// error rather than an absent relay. The two are not the same thing —
// "configured, and broken" is something whoever edited it has to be told about,
// and silently reporting "no relay" would hide it.
func TestLoadRelayRefusesMalformedJSON(t *testing.T) {
	base := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", base)

	dir := filepath.Join(base, "flue")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "relay.json"), []byte("{not json"), 0o600); err != nil {
		t.Fatalf("write relay.json: %v", err)
	}

	got, ok, err := LoadRelay()
	if err == nil {
		t.Fatalf("LoadRelay of a malformed relay.json = (%+v, %v, nil), want an error", got, ok)
	}
	if ok {
		t.Error("LoadRelay ok = true alongside an error, want false")
	}
}

// TestLoadRelayKeepsAnIncompleteFile: half a configuration is still a
// configuration. Refusing it here would turn "the relay is missing its origin"
// into "there is no relay", and the caller — which is the one that knows what a
// complete config is (relay.New) — would never get to say so.
func TestLoadRelayKeepsAnIncompleteFile(t *testing.T) {
	base := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", base)

	dir := filepath.Join(base, "flue")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "relay.json"), []byte(`{"url":"wss://r.example/daemon"}`), 0o600); err != nil {
		t.Fatalf("write relay.json: %v", err)
	}

	got, ok, err := LoadRelay()
	if err != nil {
		t.Fatalf("LoadRelay: %v", err)
	}
	if !ok {
		t.Fatal("LoadRelay ok = false for a file that exists, want true")
	}
	if got.URL != "wss://r.example/daemon" || got.Secret != "" || got.Origin != "" {
		t.Fatalf("LoadRelay = %+v, want only the URL set", got)
	}
}

// TestLoadRelayErrorNeverQuotesTheFile pins a property rather than fixing a
// bug: the error this returns is logged by `flue serve` and printed by `flue
// status`, and the file it describes holds the daemon secret.
//
// encoding/json is careful here today — an UnmarshalTypeError says "cannot
// unmarshal number into Go struct field Relay.secret of type string" and never
// the number — but that is the decoder's choice rather than a promise, and it
// is not uniform: the `,string` tag path quotes the input verbatim. A wrapper
// that started passing the body through, or a field that gained that tag, would
// put a credential in a terminal, a log file and a pasted bug report at once.
func TestLoadRelayErrorNeverQuotesTheFile(t *testing.T) {
	base := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", base)

	dir := filepath.Join(base, "flue")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	const secret = "12345678901234567890"
	body := `{"url":"wss://r.example/daemon","secret":` + secret + `,"origin":"https://r.example"}`
	if err := os.WriteFile(filepath.Join(dir, "relay.json"), []byte(body), 0o600); err != nil {
		t.Fatalf("write relay.json: %v", err)
	}

	_, ok, err := LoadRelay()
	if err == nil {
		t.Fatal("LoadRelay of a relay.json whose secret is not a string = nil error, want a refusal")
	}
	if ok {
		t.Error("LoadRelay ok = true alongside an error, want false")
	}
	if strings.Contains(err.Error(), secret) {
		t.Fatalf("the error quotes the file's contents: %q", err)
	}
	// It still has to be useful: whoever broke the file needs to know which
	// field to look at.
	if !strings.Contains(err.Error(), "secret") {
		t.Errorf("the error does not name the field that is wrong: %q", err)
	}
}
