package main

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/karnstack/flue/internal/config"
	"github.com/karnstack/flue/internal/daemon"
	"github.com/karnstack/flue/internal/service"
	"github.com/karnstack/flue/internal/session"
	"github.com/karnstack/flue/internal/transport/local"
)

// --- fakes and fixtures ---

// flueArchive builds the release archive exactly as the contract promises:
// gzip over tar, one regular file named flue at the root.
func flueArchive(t *testing.T, bin []byte) []byte {
	t.Helper()
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	if err := tw.WriteHeader(&tar.Header{
		Name:     "flue",
		Mode:     0o755,
		Size:     int64(len(bin)),
		Typeflag: tar.TypeReg,
	}); err != nil {
		t.Fatalf("tar header: %v", err)
	}
	if _, err := tw.Write(bin); err != nil {
		t.Fatalf("tar write: %v", err)
	}
	if err := tw.Close(); err != nil {
		t.Fatalf("tar close: %v", err)
	}
	if err := gz.Close(); err != nil {
		t.Fatalf("gzip close: %v", err)
	}
	return buf.Bytes()
}

// fakeGitHub answers from a map of full URL to body — the latest-release
// JSON and the download assets through the one seam production uses.
//
// The etag argument is ignored rather than honoured: these are the updater's
// tests, and `flue update` asks unconditionally. What a replayed etag buys is
// pinned in release_test.go, where the daemon's repeated check lives.
func fakeGitHub(files map[string][]byte) func(context.Context, string, string) (*http.Response, error) {
	return func(_ context.Context, url, _ string) (*http.Response, error) {
		if b, ok := files[url]; ok {
			return &http.Response{StatusCode: 200, Body: io.NopCloser(bytes.NewReader(b))}, nil
		}
		return &http.Response{StatusCode: 404, Body: io.NopCloser(strings.NewReader("not found"))}, nil
	}
}

func releaseJSON(tag string) []byte {
	return fmt.Appendf(nil, `{"tag_name":%q,"html_url":"https://github.com/karnstack/flue/releases/tag/%s"}`, tag, tag)
}

// releaseFixture is a complete, verifiable fake release: the API answer plus
// this platform's archive and a checksums.txt that matches it.
func releaseFixture(t *testing.T, tag string, bin []byte) map[string][]byte {
	t.Helper()
	version := strings.TrimPrefix(tag, "v")
	asset := fmt.Sprintf("flue_%s_%s_%s.tar.gz", version, runtime.GOOS, runtime.GOARCH)
	archive := flueArchive(t, bin)
	digest := sha256.Sum256(archive)
	return map[string][]byte{
		releaseAPI:                                   releaseJSON(tag),
		releaseDownloadBase + tag + "/" + asset:      archive,
		releaseDownloadBase + tag + "/checksums.txt": fmt.Appendf(nil, "%s  %s\n", hex.EncodeToString(digest[:]), asset),
	}
}

func updateChecker(current string, files map[string][]byte) *releaseChecker {
	c := newReleaseChecker(current)
	c.get = fakeGitHub(files)
	return c
}

func swapUpdateTarget(t *testing.T, fn func() (string, error)) {
	t.Helper()
	orig := updateTarget
	updateTarget = fn
	t.Cleanup(func() { updateTarget = orig })
}

func swapBrew(t *testing.T, onPath bool, run func(io.Writer) error) {
	t.Helper()
	origLook, origRun := brewOnPath, runBrewUpgrade
	brewOnPath = func() bool { return onPath }
	runBrewUpgrade = run
	t.Cleanup(func() { brewOnPath, runBrewUpgrade = origLook, origRun })
}

// oldBinary writes a stand-in installed flue and points the updater at it.
func oldBinary(t *testing.T, mode os.FileMode) (dir, target string) {
	t.Helper()
	dir = t.TempDir()
	target = filepath.Join(dir, "flue")
	if err := os.WriteFile(target, []byte("the old build"), mode); err != nil {
		t.Fatalf("write old binary: %v", err)
	}
	swapUpdateTarget(t, func() (string, error) { return target, nil })
	return dir, target
}

// newVersionedDaemon is newTestDaemon with a version of the test's choosing,
// wired the way cmdServe wires a real one: the release checker is what
// serves ReleasePath's Current field, which is where flue update reads the
// restarted daemon's version from. Its get fails so no test asks GitHub.
func newVersionedDaemon(t *testing.T, token, ver string) int {
	t.Helper()
	srv := daemon.New(session.NewRegistry(time.Now), local.NewAuth(token, 0), uiHandler(), ver, daemon.Identity{})
	rc := newReleaseChecker(ver)
	rc.get = func(context.Context, string, string) (*http.Response, error) {
		return nil, errors.New("no network in tests")
	}
	srv.SetReleaseChecker(rc)
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)
	t.Cleanup(srv.Shutdown)

	u, err := url.Parse(ts.URL)
	if err != nil {
		t.Fatalf("parse test server URL %q: %v", ts.URL, err)
	}
	port, err := strconv.Atoi(u.Port())
	if err != nil {
		t.Fatalf("parse port from %q: %v", ts.URL, err)
	}
	srv.SetAuth(local.NewAuth(token, port))
	return port
}

// --- the refusals ---

// TestRunUpdateRefusesADevBuild: a from-source build corresponds to no
// release, so there is nothing it could be updated *to* — and it must not
// even ask GitHub, because the answer could not change the refusal.
func TestRunUpdateRefusesADevBuild(t *testing.T) {
	c := newReleaseChecker("dev")
	var asked atomic.Bool
	c.get = func(context.Context, string, string) (*http.Response, error) {
		asked.Store(true)
		return nil, errors.New("no network in tests")
	}

	err := runUpdate(io.Discard, "dev", c)
	if err == nil {
		t.Fatal("runUpdate = nil for a dev build, want a refusal")
	}
	if !strings.Contains(err.Error(), "git pull") || !strings.Contains(err.Error(), "make build") {
		t.Fatalf("refusal %q does not say how a from-source build updates", err)
	}
	if asked.Load() {
		t.Fatal("a dev build asked GitHub about releases; the answer could not have mattered")
	}
}

// TestRunUpdateSaysAlreadyNewest: up to date is exit 0 and one line, and the
// binary is never located, let alone touched.
func TestRunUpdateSaysAlreadyNewest(t *testing.T) {
	for _, current := range []string{"0.6.0", "0.7.0"} { // the tag, and ahead of it
		t.Run(current, func(t *testing.T) {
			c := updateChecker(current, map[string][]byte{releaseAPI: releaseJSON("v0.6.0")})
			swapUpdateTarget(t, func() (string, error) {
				t.Error("an up-to-date flue went looking for the binary to replace")
				return "", errors.New("refused by the test")
			})

			var out bytes.Buffer
			if err := runUpdate(&out, current, c); err != nil {
				t.Fatalf("runUpdate: %v", err)
			}
			if !strings.Contains(out.String(), "already the newest release") {
				t.Fatalf("output does not say it is up to date:\n%s", out.String())
			}
		})
	}
}

// TestRunUpdateRefusesAChecksumMismatch is the security half of the download
// contract: an archive that does not match checksums.txt installs nothing,
// the old binary keeps its bytes, and no staging litter is left beside it.
func TestRunUpdateRefusesAChecksumMismatch(t *testing.T) {
	dir, target := oldBinary(t, 0o755)

	files := releaseFixture(t, "v0.6.0", []byte("the new build"))
	files[releaseDownloadBase+"v0.6.0/checksums.txt"] = fmt.Appendf(nil,
		"%s  flue_0.6.0_%s_%s.tar.gz\n", strings.Repeat("ab", 32), runtime.GOOS, runtime.GOARCH)
	c := updateChecker("0.5.0", files)

	err := runUpdate(io.Discard, "0.5.0", c)
	if err == nil {
		t.Fatal("runUpdate = nil for a checksum mismatch, want a refusal")
	}
	if !strings.Contains(err.Error(), "sha256 mismatch") {
		t.Fatalf("error %q does not name the mismatch", err)
	}
	got, rerr := os.ReadFile(target)
	if rerr != nil || string(got) != "the old build" {
		t.Fatalf("the installed binary changed on a refused update: %q, %v", got, rerr)
	}
	entries, rerr := os.ReadDir(dir)
	if rerr != nil || len(entries) != 1 {
		t.Fatalf("staging litter left behind: %v (want only the binary)", entries)
	}
}

// TestRunUpdateRefusesChecksumsWithoutOurEntry: a checksums.txt that has no
// line for this platform's asset proves nothing, so nothing installs.
func TestRunUpdateRefusesChecksumsWithoutOurEntry(t *testing.T) {
	_, target := oldBinary(t, 0o755)

	files := releaseFixture(t, "v0.6.0", []byte("the new build"))
	files[releaseDownloadBase+"v0.6.0/checksums.txt"] = []byte("deadbeef  flue_0.6.0_plan9_mips.tar.gz\n")
	c := updateChecker("0.5.0", files)

	err := runUpdate(io.Discard, "0.5.0", c)
	if err == nil || !strings.Contains(err.Error(), "no entry") {
		t.Fatalf("runUpdate error = %v, want the missing-entry refusal", err)
	}
	if got, _ := os.ReadFile(target); string(got) != "the old build" {
		t.Fatalf("the installed binary changed on a refused update: %q", got)
	}
}

// --- the swap ---

// TestRunUpdateSwapsTheBinary is the happy path end to end: download,
// verify, extract, and an atomic rename over the running binary's real path
// — with its mode preserved, the transcript in flue enable's voice, and no
// staging file left behind.
func TestRunUpdateSwapsTheBinary(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir()) // no service, no daemon
	dir, target := oldBinary(t, 0o700)       // an unusual mode, to watch it survive
	swapManager(t, &fakeManager{})           // login service not installed

	newBin := []byte("the new build, byte for byte")
	c := updateChecker("0.5.0", releaseFixture(t, "v0.6.0", newBin))

	var out bytes.Buffer
	if err := runUpdate(&out, "0.5.0", c); err != nil {
		t.Fatalf("runUpdate: %v", err)
	}

	got, err := os.ReadFile(target)
	if err != nil {
		t.Fatalf("read swapped binary: %v", err)
	}
	if !bytes.Equal(got, newBin) {
		t.Fatalf("binary after the swap = %q, want the release's bytes", got)
	}
	info, err := os.Stat(target)
	if err != nil {
		t.Fatalf("stat swapped binary: %v", err)
	}
	if info.Mode().Perm() != 0o700 {
		t.Fatalf("mode after the swap = %v, want the old binary's 0700 preserved", info.Mode().Perm())
	}
	entries, err := os.ReadDir(dir)
	if err != nil || len(entries) != 1 {
		t.Fatalf("staging litter left beside the binary: %v", entries)
	}
	for _, want := range []string{
		"✓ flue 0.6.0 downloaded and verified",
		"✓ installed to " + target,
		"no daemon running",
	} {
		if !strings.Contains(out.String(), want) {
			t.Errorf("transcript missing %q:\n%s", want, out.String())
		}
	}
}

// TestRunUpdateRefusesAnUnwritableTarget: no root-owned half-update, and the
// message says the fix. The staging file is created in the target's own
// directory precisely so this fails before any bytes are downloaded.
func TestRunUpdateRefusesAnUnwritableTarget(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("running as root: every directory is writable, so there is nothing to refuse")
	}
	dir, target := oldBinary(t, 0o755)
	if err := os.Chmod(dir, 0o555); err != nil {
		t.Fatalf("chmod: %v", err)
	}
	t.Cleanup(func() { _ = os.Chmod(dir, 0o755) })

	var downloaded atomic.Bool
	c := newReleaseChecker("0.5.0")
	c.get = func(ctx context.Context, url, _ string) (*http.Response, error) {
		if url != releaseAPI {
			downloaded.Store(true)
		}
		return fakeGitHub(map[string][]byte{releaseAPI: releaseJSON("v0.6.0")})(ctx, url, "")
	}

	err := runUpdate(io.Discard, "0.5.0", c)
	if err == nil {
		t.Fatal("runUpdate = nil over an unwritable directory, want a refusal")
	}
	if !strings.Contains(err.Error(), "sudo flue update") {
		t.Fatalf("refusal %q does not suggest sudo", err)
	}
	if downloaded.Load() {
		t.Error("the archive was downloaded before the writability check refused")
	}
	if got, _ := os.ReadFile(target); string(got) != "the old build" {
		t.Fatalf("the installed binary changed on a refused update: %q", got)
	}
}

// --- brew ---

// TestRunUpdateHandsABrewInstallToBrew: a binary resolving into the Caskroom
// is brew's to replace — swapping it ourselves would corrupt brew's
// bookkeeping — so brew runs, no archive is downloaded, and the restart leg
// still happens (here: the nothing-running report).
func TestRunUpdateHandsABrewInstallToBrew(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	swapUpdateTarget(t, func() (string, error) {
		return "/opt/homebrew/Caskroom/flue/0.5.0/flue", nil
	})
	swapManager(t, &fakeManager{})

	var brewRuns atomic.Int32
	swapBrew(t, true, func(w io.Writer) error {
		brewRuns.Add(1)
		fmt.Fprintln(w, "==> Upgrading karnstack/tap/flue")
		return nil
	})

	var downloaded atomic.Bool
	c := newReleaseChecker("0.5.0")
	c.get = func(ctx context.Context, url, _ string) (*http.Response, error) {
		if url != releaseAPI {
			downloaded.Store(true)
		}
		return fakeGitHub(map[string][]byte{releaseAPI: releaseJSON("v0.6.0")})(ctx, url, "")
	}

	var out bytes.Buffer
	if err := runUpdate(&out, "0.5.0", c); err != nil {
		t.Fatalf("runUpdate: %v", err)
	}
	if n := brewRuns.Load(); n != 1 {
		t.Fatalf("brew ran %d times, want 1", n)
	}
	if downloaded.Load() {
		t.Error("an archive was downloaded for an install brew owns")
	}
	if !strings.Contains(out.String(), "✓ brew upgrade karnstack/tap/flue") {
		t.Fatalf("transcript missing the brew checkmark:\n%s", out.String())
	}
	if strings.Contains(out.String(), "installed to") {
		t.Fatalf("transcript claims a file swap on the brew path:\n%s", out.String())
	}
}

// TestRunUpdatePointsAtBrewWhenBrewIsMissing: Caskroom path, no brew on PATH
// — the one command that fixes it is the whole answer, and nothing is
// swapped by hand.
func TestRunUpdatePointsAtBrewWhenBrewIsMissing(t *testing.T) {
	swapUpdateTarget(t, func() (string, error) {
		return "/opt/homebrew/Caskroom/flue/0.5.0/flue", nil
	})
	swapBrew(t, false, func(io.Writer) error {
		t.Error("brew ran despite not being on PATH")
		return nil
	})
	c := updateChecker("0.5.0", map[string][]byte{releaseAPI: releaseJSON("v0.6.0")})

	err := runUpdate(io.Discard, "0.5.0", c)
	if err == nil {
		t.Fatal("runUpdate = nil with a Caskroom binary and no brew, want a refusal")
	}
	if !strings.Contains(err.Error(), "brew upgrade karnstack/tap/flue") {
		t.Fatalf("refusal %q does not name the brew command", err)
	}
}

// --- the restart ---

// TestRunUpdateRestartsTheServiceAndReportsTheNewVersion closes the loop the
// command exists for: after the swap the service manager restarts the
// daemon, and the transcript's last line reports the version the *daemon*
// answered with — not the version this CLI hoped for.
func TestRunUpdateRestartsTheServiceAndReportsTheNewVersion(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	token, err := config.LoadOrCreateToken()
	if err != nil {
		t.Fatalf("LoadOrCreateToken: %v", err)
	}
	_, _ = oldBinary(t, 0o755)

	m := &fakeManager{st: service.Status{Installed: true, Running: true}}
	m.onRestart = func() {
		// The restarted daemon: the new build, discoverable the way a real
		// one is — a runtime record naming a live process of ours.
		port := newVersionedDaemon(t, token, "0.6.0")
		if err := daemon.WriteRuntime(port); err != nil {
			t.Errorf("WriteRuntime: %v", err)
		}
	}
	swapManager(t, m)

	c := updateChecker("0.5.0", releaseFixture(t, "v0.6.0", []byte("the new build")))

	var out bytes.Buffer
	if err := runUpdate(&out, "0.5.0", c); err != nil {
		t.Fatalf("runUpdate: %v", err)
	}
	if m.restartCalls != 1 {
		t.Fatalf("Restart called %d times, want 1", m.restartCalls)
	}
	if !strings.Contains(out.String(), "✓ daemon restarted, running flue 0.6.0 on 127.0.0.1:") {
		t.Fatalf("transcript missing the restarted-daemon line:\n%s", out.String())
	}
}

// TestRunUpdateTellsTheUserAboutAStaleDaemon: no login service, but a daemon
// is up — it keeps running the old code after the swap, and there is no stop
// command to bounce it from here, so the transcript says exactly what to run.
func TestRunUpdateTellsTheUserAboutAStaleDaemon(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	_, _ = oldBinary(t, 0o755)
	swapManager(t, &fakeManager{}) // not installed

	port := newTestDaemon(t, "tok")
	if err := daemon.WriteRuntime(port); err != nil {
		t.Fatalf("WriteRuntime: %v", err)
	}

	c := updateChecker("0.5.0", releaseFixture(t, "v0.6.0", []byte("the new build")))

	var out bytes.Buffer
	if err := runUpdate(&out, "0.5.0", c); err != nil {
		t.Fatalf("runUpdate: %v", err)
	}
	for _, want := range []string{
		"still runs the old build",
		fmt.Sprintf("kill %d && flue open", os.Getpid()),
	} {
		if !strings.Contains(out.String(), want) {
			t.Errorf("transcript missing %q:\n%s", want, out.String())
		}
	}
}

// --- surface ---

// TestUsageMentionsUpdate keeps flue update in the help text — a command
// nobody can discover may as well not exist, and the README's CLI table is
// kept in agreement with usageText by hand.
func TestUsageMentionsUpdate(t *testing.T) {
	if !strings.Contains(usageText, "flue update") {
		t.Fatalf("usage text does not mention %q:\n%s", "flue update", usageText)
	}
}
