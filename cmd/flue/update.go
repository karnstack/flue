package main

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/karnstack/flue/internal/daemon"
	"github.com/karnstack/flue/internal/service"
	"github.com/karnstack/flue/internal/transport/local"
)

// flue update is the loop the sidebar's advisory never closed: find the
// newest release, put its binary where this one is, and restart the daemon so
// the machine actually runs it. Before this command the update story ended at
// a card naming a brew line — and even a user who ran it was left with an old
// daemon serving their sessions, because nothing anywhere restarted it (flue
// enable deliberately never restarts a healthy daemon).

const (
	// releaseDownloadBase is where a release's assets live, keyed by the raw
	// tag. The contract is shared verbatim with .goreleaser.yaml and
	// scripts/install.sh: archive flue_{version}_{os}_{arch}.tar.gz, the
	// binary as a regular file named flue at the archive root, and
	// checksums.txt in goreleaser's `sha256  filename` lines.
	releaseDownloadBase = "https://github.com/karnstack/flue/releases/download/"

	// downloadTimeout bounds the archive download. releaseTimeout is sized
	// for one small JSON document and would abandon a ~15MB archive on a
	// slow link.
	downloadTimeout = 5 * time.Minute

	// updateRestartWait is how long the restarted daemon gets to come back
	// and identify itself before the update reports the restart as not
	// having landed. Same figure as flue enable, for the same reason: the
	// service manager has to fork, exec, and bind first.
	updateRestartWait = enableWait

	// The download bounds. Backstops against a wedged or lying server in the
	// same spirit as maxMintBytes: GitHub has been identified only by its
	// hostname, and a checksum has not been verified yet while these apply.
	maxChecksumsBytes = 1 << 20
	maxArchiveBytes   = 256 << 20
	maxBinaryBytes    = 512 << 20
)

// brewUpgradeCommand is the exact line the web sidebar's update card
// advertises; when brew owns the install, this command defers to it.
const brewUpgradeCommand = "brew upgrade karnstack/tap/flue"

// updateTarget names the file flue update must replace: the running binary's
// real path, symlinks resolved. Deliberately the opposite of
// defaultServiceManager, which records the unresolved name so the plist
// survives upgrades — a service execs *through* a symlink, but a file swap
// has to land on the file itself. Renaming a new binary over the symlink
// would orphan the real file and quietly convert a managed install into an
// unmanaged one; resolving first means the swap replaces the bytes and every
// name that pointed at them still does. A package variable so the tests can
// point the updater at a temp-dir binary — under `go test` os.Executable is
// the test binary, which must never be swapped.
var updateTarget = func() (string, error) {
	exe, err := os.Executable()
	if err != nil {
		return "", err
	}
	return filepath.EvalSymlinks(exe)
}

// brewOnPath and runBrewUpgrade are the brew leg's seams: CI must never run a
// real brew, and most CI machines do not have one.
var brewOnPath = func() bool {
	_, err := exec.LookPath("brew")
	return err == nil
}

var runBrewUpgrade = func(w io.Writer) error {
	cmd := exec.Command("brew", "upgrade", "karnstack/tap/flue")
	// brew's own transcript is the progress report; hide none of it.
	cmd.Stdout = w
	cmd.Stderr = w
	return cmd.Run()
}

func cmdUpdate() error {
	return runUpdate(os.Stdout, version, newReleaseChecker(version))
}

// runUpdate resolves the newest release, replaces this binary with it (or
// hands the replacement to brew when brew owns the install), and restarts
// the daemon so the new build is the one serving.
//
// The checker is release.go's: the same fetch, the same semver comparison,
// and the same HTTP seam the daemon's ten-minute check uses — no second
// GitHub client.
func runUpdate(w io.Writer, current string, c *releaseChecker) error {
	if current == "dev" {
		return errors.New("this is a from-source build, which corresponds to no release; update it with git pull && make build")
	}

	ctx, cancel := context.WithTimeout(context.Background(), releaseTimeout)
	// Unconditional, with no etag: this is a command someone typed, and it
	// needs the tag itself to build a download URL from. A 304 would be the
	// right answer to "has it changed" and no answer at all to "what is it".
	tag, _, _, err := c.fetch(ctx, "")
	cancel()
	if err != nil {
		return fmt.Errorf("look up the latest release: %w", err)
	}
	latest := strings.TrimPrefix(tag, "v")
	if !newer(latest, current) {
		fmt.Fprintf(w, "flue %s is already the newest release; nothing to do\n", current)
		return nil
	}

	target, err := updateTarget()
	if err != nil {
		return fmt.Errorf("locate the running binary: %w", err)
	}

	if brewOwned(target) {
		// Swapping a file under brew's roots would leave brew's bookkeeping
		// believing the old version is installed — the next `brew upgrade`
		// would clobber ours, and `brew uninstall` would half-work. brew is
		// the owner, so brew does the swap; when it is somehow not on PATH,
		// the command to run is the whole answer.
		if !brewOnPath() {
			return fmt.Errorf("this flue is Homebrew's (%s) but brew is not on PATH; upgrade it with: %s", target, brewUpgradeCommand)
		}
		fmt.Fprintf(w, "\n  this install is Homebrew's, so brew does the swap:\n\n")
		if err := runBrewUpgrade(w); err != nil {
			return fmt.Errorf("%s: %w", brewUpgradeCommand, err)
		}
		fmt.Fprintf(w, "\n  ✓ %s\n", brewUpgradeCommand)
	} else {
		// Adapted rather than threaded through: a download is never
		// conditional. If-None-Match is the release check's business — asking
		// "has the tag moved" — and an archive is either fetched or it is not.
		// Still the one client, which is what the seam is for.
		download := func(ctx context.Context, url string) (*http.Response, error) {
			return c.get(ctx, url, "")
		}
		if err := selfUpdate(w, download, tag, latest, target); err != nil {
			return err
		}
	}

	return restartForUpdate(w, latest)
}

// brewOwned reports whether path is a file Homebrew installed and owns. A
// cask install puts the binary at <prefix>/Caskroom/flue/<version>/flue and
// links <prefix>/bin/flue at it; the caller has already resolved symlinks,
// so the one substring covers both the Caskroom file and the bin link.
// Cellar is checked too so a formula install — should one ever exist —
// fails safe into brew's hands rather than getting its files swapped.
func brewOwned(path string) bool {
	return strings.Contains(path, "/Caskroom/") || strings.Contains(path, "/Cellar/")
}

// getter is releaseChecker.get with the conditional-request argument already
// answered: one HTTP seam for everything the updater downloads, so the tests
// fake one function and no second GitHub client ever grows here.
type getter func(context.Context, string) (*http.Response, error)

// selfUpdate downloads the release archive for this OS and architecture,
// verifies it against checksums.txt, and renames the extracted binary over
// target — the script/manual install path, mirroring install.sh's decisions.
//
// The order is deliberate. The staging file is created first, in target's own
// directory: that is the writability check (refuse before spending anyone's
// bandwidth) and it is what makes the final rename an atomic same-filesystem
// move, so no failure can leave target half-written. Renaming over a running
// executable is fine on unix — the running process keeps its inode — which
// is why this is a rename and never an in-place write: opening the running
// binary for writing is ETXTBSY on Linux and corruption anywhere it is not.
func selfUpdate(w io.Writer, get getter, tag, latest, target string) error {
	info, err := os.Stat(target)
	if err != nil {
		return err
	}
	staged, err := os.CreateTemp(filepath.Dir(target), ".flue-update-")
	if err != nil {
		return permissionHint(err, target)
	}
	installed := false
	defer func() {
		if !installed {
			staged.Close()
			os.Remove(staged.Name())
		}
	}()

	asset := fmt.Sprintf("flue_%s_%s_%s.tar.gz", latest, runtime.GOOS, runtime.GOARCH)
	base := releaseDownloadBase + tag + "/"
	ctx, cancel := context.WithTimeout(context.Background(), downloadTimeout)
	defer cancel()

	archive, err := fetchAsset(ctx, get, base+asset, maxArchiveBytes)
	if err != nil {
		return fmt.Errorf("download %s: %w", asset, err)
	}
	sums, err := fetchAsset(ctx, get, base+"checksums.txt", maxChecksumsBytes)
	if err != nil {
		return fmt.Errorf("download checksums.txt: %w", err)
	}
	expected, err := checksumFor(sums, asset)
	if err != nil {
		return err
	}
	digest := sha256.Sum256(archive)
	if got := hex.EncodeToString(digest[:]); got != expected {
		return fmt.Errorf("sha256 mismatch for %s (expected %s, got %s); aborting before install", asset, expected, got)
	}
	fmt.Fprintf(w, "\n  ✓ flue %s downloaded and verified\n", latest)

	bin, err := extractFlue(archive)
	if err != nil {
		return fmt.Errorf("extract flue from %s: %w", asset, err)
	}
	if _, err := staged.Write(bin); err != nil {
		return err
	}
	// The mode the user (or install.sh, or sudo) gave the binary survives
	// the swap; CreateTemp's 0600 is a staging mode, not an answer.
	if err := staged.Chmod(info.Mode().Perm()); err != nil {
		return err
	}
	if err := staged.Close(); err != nil {
		return err
	}
	if err := os.Rename(staged.Name(), target); err != nil {
		return permissionHint(err, target)
	}
	installed = true
	fmt.Fprintf(w, "  ✓ installed to %s\n", target)
	return nil
}

// permissionHint turns a permission refusal into instructions. Both call
// sites run before or instead of any modification to target — the staging
// file is elsewhere-named and the rename is atomic — so "re-run with sudo"
// is advice about a clean retry, never about digging out of a half-update.
func permissionHint(err error, target string) error {
	if errors.Is(err, fs.ErrPermission) {
		return fmt.Errorf("%s is not writable by you (%v); re-run as: sudo flue update", target, err)
	}
	return err
}

// fetchAsset downloads one release asset, bounded. The get seam sends GitHub
// API headers, which the download endpoints ignore, and follows the redirect
// to the CDN that actually serves release assets.
func fetchAsset(ctx context.Context, get getter, url string, limit int64) ([]byte, error) {
	res, err := get(ctx, url)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("github answered %d", res.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(res.Body, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(body)) > limit {
		return nil, fmt.Errorf("response exceeds %d bytes", limit)
	}
	return body, nil
}

// checksumFor finds asset's digest in checksums.txt — goreleaser's
// `sha256  filename` lines, the same contract install.sh reads with
// awk '$2 == f'. Fields rather than a fixed offset, so the one-space and
// two-space spellings both parse.
func checksumFor(sums []byte, asset string) (string, error) {
	for _, line := range strings.Split(string(sums), "\n") {
		f := strings.Fields(line)
		if len(f) == 2 && f[1] == asset {
			return f[0], nil
		}
	}
	return "", fmt.Errorf("checksums.txt has no entry for %s", asset)
}

// extractFlue reads the one file the archive contract puts at the root. Only
// a regular file named flue counts; anything else in the archive — including
// anything path-shaped enough to be trying a traversal — is skipped, and the
// caller never writes any name the archive chose.
func extractFlue(archive []byte) ([]byte, error) {
	gz, err := gzip.NewReader(bytes.NewReader(archive))
	if err != nil {
		return nil, err
	}
	defer gz.Close()
	tr := tar.NewReader(gz)
	for {
		hdr, err := tr.Next()
		if errors.Is(err, io.EOF) {
			return nil, errors.New("no flue binary at the archive root")
		}
		if err != nil {
			return nil, err
		}
		if hdr.Typeflag != tar.TypeReg || filepath.Clean(hdr.Name) != "flue" {
			continue
		}
		bin, err := io.ReadAll(io.LimitReader(tr, maxBinaryBytes+1))
		if err != nil {
			return nil, err
		}
		if int64(len(bin)) > maxBinaryBytes {
			return nil, fmt.Errorf("flue in the archive exceeds %d bytes", int64(maxBinaryBytes))
		}
		return bin, nil
	}
}

// restartForUpdate is the half the old advisory story never had: a new
// binary on disk changes nothing until the process spawning shells is the
// new build.
//
//   - Login service installed: restart it through the service manager and
//     wait for a daemon that answers with the new version — the one line
//     that proves the loop actually closed.
//   - No service, daemon running: it was started by hand — flue serve in
//     some terminal, or detached by flue open — and there is no stop command
//     to bounce it cleanly from here; killing a foreground serve out from
//     under the terminal that owns it would be a surprise, not a service.
//     Say exactly what to run instead: SIGTERM is the graceful path
//     (cmdServe snapshots sessions on the way out, and the next daemon
//     revives them), so the two commands cost no session.
//   - Nothing running: nothing to restart, and whatever starts the daemon
//     next starts the new build.
func restartForUpdate(w io.Writer, latest string) error {
	if mgr, err := newServiceManager(); err == nil {
		if st, err := mgr.Status(); err == nil && st.Installed {
			// Same convergence runRestart does: the restart should boot the
			// new build under the current unit template, not whatever an
			// older flue wrote at enable time.
			if ur, ok := mgr.(service.UnitRefresher); ok {
				_ = ur.RefreshUnit()
			}
			if err := mgr.Restart(); err != nil {
				return fmt.Errorf("restart the login service: %w", err)
			}
			port, got, err := awaitVersion(updateRestartWait, latest)
			if err != nil {
				return err
			}
			fmt.Fprintf(w, "  ✓ daemon restarted, running flue %s on 127.0.0.1:%d\n", got, port)
			// Same honesty rule as runRestart: holder-backed sessions rode
			// across the bounce; only the FLUE_NO_HOLDER escape hatch still
			// pays for an update with its sessions.
			if os.Getenv("FLUE_NO_HOLDER") == "" {
				fmt.Fprintf(w, "  ✓ sessions kept running; tabs reconnect on their own\n")
			}
			return nil
		}
	}
	if port, ok := ourDaemon(); ok {
		_, pid, _ := daemon.ReadRuntimeRecord()
		fmt.Fprintf(w, "  ! the daemon on 127.0.0.1:%d still runs the old build; restart it to finish:\n", port)
		fmt.Fprintf(w, "      kill %d && flue open\n", pid)
		return nil
	}
	fmt.Fprintf(w, "  no daemon running; the next flue open or flue enable starts flue %s\n", latest)
	return nil
}

// awaitVersion polls for a daemon of ours reporting version want — the same
// identity check awaitDaemon runs, plus the one question that matters after
// a swap: which build answered. The old daemon can still be shutting down
// when polling starts, so a daemon of the wrong version is something to wait
// through, not a failure; only the deadline decides.
func awaitVersion(wait time.Duration, want string) (port int, got string, err error) {
	token, err := loadToken()
	if err != nil {
		return 0, "", fmt.Errorf("load auth token: %w", err)
	}
	deadline := time.Now().Add(wait)
	for time.Now().Before(deadline) {
		if p, ok := ourDaemon(); ok {
			if v, err := daemonVersion(p, token); err == nil {
				port, got = p, v
				if v == want {
					return port, got, nil
				}
			}
		}
		time.Sleep(50 * time.Millisecond)
	}
	if got != "" {
		return 0, "", fmt.Errorf("the daemon came back running flue %s, not %s; run \"flue status\" to see what is installed where", got, want)
	}
	return 0, "", fmt.Errorf("the service was restarted but no daemon answered within %s; run \"flue status\" to see what it is doing", wait)
}

// daemonVersion asks the daemon at port which build it is, via ReleasePath's
// Current field — the same authenticated read the sidebar's update card
// uses. Same transport habits as every other loopback read in this package:
// token in the header, status checked before decoding, response bounded.
func daemonVersion(port int, token string) (string, error) {
	u := &url.URL{
		Scheme: "http",
		Host:   fmt.Sprintf("127.0.0.1:%d", port),
		Path:   daemon.ReleasePath,
	}
	req, err := http.NewRequest(http.MethodGet, u.String(), nil)
	if err != nil {
		return "", err
	}
	req.Header.Set(local.HeaderName, token)
	resp, err := probeClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("daemon answered %s", resp.Status)
	}
	var body struct {
		Current string `json:"current"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, maxMintBytes)).Decode(&body); err != nil {
		return "", err
	}
	return body.Current, nil
}
