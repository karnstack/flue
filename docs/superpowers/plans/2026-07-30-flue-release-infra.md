# flue release infra Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up flue's entire release pipeline — a build-time-stamped version reported by `flue status`, a goreleaser v2 config, CI and release GitHub Actions workflows, a checksum-verifying `install.sh` with its own test script, the `karnstack/tap` Homebrew tap, and a public-facing README — so that the user's first `git push origin v0.1.0` produces binaries, `checksums.txt`, a grouped changelog, and a live brew formula with no further setup. No tag is pushed as part of this work.

**Architecture:** `cmd/flue` gains `var version = "dev"`, stamped by goreleaser via `-ldflags "-s -w -X main.version={{.Version}}"` and printed as the first line of `flue status` (no new CLI command — the four-command surface is a spec commitment). goreleaser's `before` hook runs `make web` so `web/dist` exists before any `go build` (the `//go:embed all:dist` in `web/embed.go` will not compile without it). `release.yml` drives goreleaser on `v*` tags and pushes the formula to `karnstack/tap` authenticated by the user-provided `TAP_GITHUB_TOKEN` secret. `scripts/install.sh` (canonical here; the site lane copies it into `site/` assets and serves it at `https://flue.sh/install.sh`) resolves the latest release from the GitHub API, verifies sha256 before touching the filesystem, and installs. The release asset naming contract shared by goreleaser, install.sh, and the site lane is verbatim: **`flue_{version}_{os}_{arch}.tar.gz`** plus **`checksums.txt`**, where `{version}` has no leading `v`, `{os}` ∈ `darwin|linux`, `{arch}` ∈ `amd64|arm64`.

**Tech Stack:** Go 1.26.1; goreleaser v2 schema (installed locally via Homebrew, ≥ v2.16); GitHub Actions with `jdx/mise-action@v4`, `goreleaser/goreleaser-action@v7`, `actions/checkout@v6`, `actions/cache@v4`; POSIX `sh` + shellcheck for the installer; `actionlint` for workflow validation; `gh` CLI for the tap repo; pnpm 11.9.0 / node 24.18.0 via mise.

## Global Constraints

- Go is **1.26.1**; node **24.18.0**; pnpm **11.9.0** — all via mise (`mise.toml` is the source of truth). **NEVER `npm` or `npx`**; one-off tools run through `pnpm dlx`.
- `web/dist` must exist before any `go build` / `go test` / `go vet` (`//go:embed all:dist`). Always go through the Makefile targets (`make web`, `make build`, `make test`, `make lint`) — goreleaser and the workflows depend on Makefile targets, never on inline copies of build steps.
- goreleaser config is **v2 schema** (`version: 2`). The `brews` section is deliberately used despite its v2.16 deprecation in favor of `homebrew_casks` (the ship spec commits to a `Formula/` tap layout); `brews` is not removed until goreleaser v3. Consequence: `goreleaser check` exits **2** ("configuration is valid, but uses deprecated properties") — that exact outcome is expected and acceptable; exit **1** means invalid config and is a hard stop. Migrating to `homebrew_casks` (with a `tap_migrations.json` in the tap) is a recorded follow-up before goreleaser v3.
- **No tag is pushed — infrastructure only.** `release.yml` fires only on `v*` tags; the user tags `v0.1.0` when ready. `TAP_GITHUB_TOKEN` is a user-provided repo secret — the only manual step.
- Release asset naming contract, verbatim everywhere: `flue_{version}_{os}_{arch}.tar.gz` and `checksums.txt`. Secret names, verbatim: `GITHUB_TOKEN`, `TAP_GITHUB_TOKEN`.
- Action majors deviate deliberately from the lane brief (`mise-action@v2` → **@v4**, `goreleaser-action@v6` → **@v7**): verified against upstream on 2026-07-30, v2/v6 are superseded majors; inputs are unchanged across the bump.
- Commit style = repo history: conventional commits with definite articles (e.g. `feat: embed the built UI in the daemon binary`). Every commit ends with the trailer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- TDD where applicable: the version variable lands test-first (`cmd/flue/main_test.go`), and `scripts/install_test.sh` is written before `scripts/install.sh`.
- The product lane edits `cmd/flue/main.go` in parallel (adds `enable`/`disable`). Task 2 keeps its diff minimal (the version declaration and `cmdStatus` only) to keep merges trivial.

---

### Task 1: Toolchain setup — goreleaser, shellcheck, actionlint

**Files:**
- None (host tooling only; no repo changes, no commit).

**Interfaces:**
- Consumes: Homebrew (`brew` 6.x present on the host).
- Produces: `goreleaser` (v2.16+), `shellcheck`, `actionlint` on `$PATH`. CI never uses these host installs — it uses `goreleaser/goreleaser-action@v7` and apt shellcheck instead.

- [ ] **Step 1: Install the three tools** (all verified absent on this host on 2026-07-30):

```bash
brew install goreleaser shellcheck actionlint
```

- [ ] **Step 2: Verify.**

```bash
goreleaser --version
shellcheck --version
actionlint --version
```

Expected: goreleaser reports a `2.x` GitVersion (≥ 2.16 — this matters for the `goreleaser check` exit-code expectation in Task 3); shellcheck and actionlint each print a version banner. If `brew install actionlint` fails for any reason, proceed without it and replace the actionlint verification steps in Tasks 4–6 with a careful line-by-line review of the workflow YAML.

No commit (nothing in the repo changed).

---

### Task 2: Build-time version stamp, reported by `flue status` (TDD)

**Files:**
- Modify: `cmd/flue/main.go`
- Test: `cmd/flue/main_test.go`

**Interfaces:**
- Consumes: `daemon.ReadRuntimeRecord()`, `ourDaemon()`, `loadToken`, `fetchSessions()` (all existing, unchanged).
- Produces: `var version = "dev"` in package `main` — the ldflags target is exactly `main.version`, stamped by Task 3 via `-ldflags "-s -w -X main.version={{.Version}}"`; `statusTo(w io.Writer) error` (the testable body of `cmdStatus`); status output whose first line is `version:  <version>` (two spaces after the colon — column-aligned with `sessions:`). Consumed by the brew formula test block in Task 3 (`assert_match version.to_s` against `flue status` output).

- [ ] **Step 1: Write the failing test.** In `cmd/flue/main_test.go`, add `"bytes"` to the import block (`"strings"` is already imported) and append:

```go
// TestStatusReportsTheStampedVersion pins the contract the release pipeline
// and the brew formula test depend on: the first line of flue status is the
// version, and an unstamped from-source build reports "dev". goreleaser
// stamps main.version via -ldflags at release time; if this variable is
// renamed or the line dropped, the formula's assert_match goes with it.
func TestStatusReportsTheStampedVersion(t *testing.T) {
	// An empty config dir means no runtime record: the "not running" branch,
	// which must still open with the version line.
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())

	var buf bytes.Buffer
	if err := statusTo(&buf); err != nil {
		t.Fatalf("statusTo: %v", err)
	}
	out := buf.String()
	if !strings.HasPrefix(out, "version:  dev\n") {
		t.Fatalf("status output does not open with the version line:\n%s", out)
	}
	if !strings.Contains(out, "daemon:   not running") {
		t.Fatalf("status output is missing the daemon line:\n%s", out)
	}
}
```

- [ ] **Step 2: See it fail.**

```bash
cd /Users/karn/code/karnstack/flue
make web
go test ./cmd/flue/ -run TestStatusReportsTheStampedVersion
```

Expected: compile failure — `undefined: statusTo`. That is the red state; `version` is currently an untestable `const "0.1.0"` and `cmdStatus` writes straight to `os.Stdout`.

- [ ] **Step 3: Implement.** In `cmd/flue/main.go`, replace the constant (line 30):

```go
const version = "0.1.0"
```

with:

```go
// version is stamped at release time by goreleaser via
// -ldflags "-s -w -X main.version={{.Version}}". A from-source build
// reports "dev", which is the honest answer: it corresponds to no release.
// It must stay a package-level var named exactly "version" — the ldflags
// target is the string "main.version".
var version = "dev"
```

and replace the whole of `cmdStatus` with a thin wrapper plus a writer-taking body (the writer is the seam — same pattern as `loadToken` and `openBrowser`, so the test reads the report without capturing `os.Stdout`). The body is the existing code with `fmt.Print*` swapped for `fmt.Fprint*` on `w`, a version line first, and the two "not running" lines re-aligned to the same column as `sessions:`:

```go
func cmdStatus() error {
	return statusTo(os.Stdout)
}

// statusTo writes the status report. The first line is always the version —
// "dev" from source, the release version when stamped — because status is
// the CLI's only diagnostics surface and the four-command surface is a spec
// commitment: there is deliberately no version subcommand to put it on.
func statusTo(w io.Writer) error {
	fmt.Fprintf(w, "version:  %s\n", version)
	recorded, _, ok := daemon.ReadRuntimeRecord()
	if !ok {
		fmt.Fprintln(w, "daemon:   not running")
		return nil
	}
	// A record naming a process that is gone, or one this user cannot signal,
	// is as stale as a record naming a port nothing answers on: either way
	// the daemon it describes is not this user's to talk to.
	port, ok := ourDaemon()
	if !ok {
		fmt.Fprintf(w, "daemon:   not running (stale runtime record for port %d)\n", recorded)
		return nil
	}
	token, err := loadToken()
	if err != nil {
		return fmt.Errorf("load auth token: %w", err)
	}

	infos, err := fetchSessions(port, token)
	if err != nil {
		return err
	}

	fmt.Fprintf(w, "daemon:   running on 127.0.0.1:%d\n", port)
	fmt.Fprintf(w, "sessions: %d\n", len(infos))
	for _, s := range infos {
		fmt.Fprintf(w, "  %s  %-8s %s\n", s.ID, s.State, s.Cwd)
	}
	return nil
}
```

Nothing else in the file changes (`daemon.New(reg, auth, uiHandler(), version)` keeps compiling — a `var` satisfies it exactly as the `const` did).

- [ ] **Step 4: Green, then the ldflags smoke test.**

```bash
go test ./cmd/flue/ -run TestStatusReportsTheStampedVersion -v
go build -ldflags "-s -w -X main.version=9.9.9-test" -o bin/flue-stamped ./cmd/flue
./bin/flue-stamped status | head -n 1
rm bin/flue-stamped
```

Expected: the test passes; the stamped binary's first status line is exactly `version:  9.9.9-test`. (`bin/` is gitignored.)

- [ ] **Step 5: Full suite.**

```bash
make test
```

Expected: all Go and web tests pass.

- [ ] **Step 6: Commit.**

```bash
cd /Users/karn/code/karnstack/flue
git add cmd/flue/main.go cmd/flue/main_test.go
git commit -m "feat: stamp the version at build time and report it from status" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: `.goreleaser.yaml` — builds, archives, checksums, changelog, brew formula

**Files:**
- Create: `.goreleaser.yaml`
- Modify: `.gitignore` (goreleaser writes to a top-level `dist/`, which is not yet ignored — only `web/dist/` is)

**Interfaces:**
- Consumes: Makefile target `web`; `main.version` (Task 2); module `github.com/karnstack/flue`; `LICENSE` and `README.md` (goreleaser's default archive file globs include them); the `karnstack/tap` repo with a `Formula/` directory (Task 7 — already exists).
- Produces: release assets named verbatim `flue_{version}_{os}_{arch}.tar.gz` (binary member named `flue` at the archive root) for darwin/amd64, darwin/arm64, linux/amd64, linux/arm64; `checksums.txt`; a changelog grouped feat/fix/docs/other; `Formula/flue.rb` pushed to `karnstack/tap` authenticated by env var `TAP_GITHUB_TOKEN`. The site lane and `scripts/install.sh` (Task 6) both depend on that exact asset pattern.

- [ ] **Step 1: Write `.goreleaser.yaml`:**

```yaml
# goreleaser v2 config. Local validation (see the release-infra plan):
#   goreleaser check                        -> exit 2, brews deprecation only
#   goreleaser release --snapshot --clean   -> must fully succeed
version: 2

project_name: flue

before:
  hooks:
    # web/dist must exist before any go build: //go:embed all:dist in
    # web/embed.go does not compile without it. Depend on the Makefile
    # target, never an inline copy of its steps.
    - make web

builds:
  - id: flue
    main: ./cmd/flue
    binary: flue
    env:
      - CGO_ENABLED=0
    goos:
      - darwin
      - linux
    goarch:
      - amd64
      - arm64
    ldflags:
      - -s -w -X main.version={{.Version}}

archives:
  - formats: [tar.gz]
    # The asset-name contract shared with scripts/install.sh and the site
    # lane, verbatim: flue_{version}_{os}_{arch}.tar.gz. {{ .Version }} has
    # no leading v; Os is darwin|linux; Arch is amd64|arm64.
    name_template: "flue_{{ .Version }}_{{ .Os }}_{{ .Arch }}"

checksum:
  name_template: checksums.txt

changelog:
  sort: asc
  groups:
    - title: Features
      regexp: '^feat(\(.*\))?!?:'
      order: 0
    - title: Fixes
      regexp: '^fix(\(.*\))?!?:'
      order: 1
    - title: Docs
      regexp: '^docs(\(.*\))?!?:'
      order: 2
    - title: Other
      order: 999

# brews is deprecated since goreleaser v2.16 in favor of homebrew_casks, but
# is not removed until v3 and is used deliberately: the ship spec commits to
# a Formula/ layout in karnstack/tap. Follow-up before goreleaser v3:
# migrate to homebrew_casks with a tap_migrations.json in the tap root.
brews:
  - name: flue
    repository:
      owner: karnstack
      name: tap
      # User-provided repo secret — the one manual setup step. The default
      # GITHUB_TOKEN cannot push to another repository.
      token: "{{ .Env.TAP_GITHUB_TOKEN }}"
    directory: Formula
    homepage: https://flue.sh
    description: "Your terminal, as a browser tab."
    license: MIT
    test: |
      # With no daemon in the brew sandbox, `flue status` prints the stamped
      # version and "not running". `|| true` makes the assertion about the
      # output, tolerating any exit status, so the formula test can never
      # start depending on daemon state inside the sandbox. (Homebrew's
      # shell_output runs the string through a shell and asserts exit 0 by
      # default; its second argument pins one exact code, which is the
      # conventional idiom when the code is deterministic — this one is
      # deliberately not pinned.)
      assert_match version.to_s, shell_output("#{bin}/flue status 2>&1 || true")
```

No `skip_upload` guard is needed: the formula push only happens on a real (non-snapshot) release, snapshots skip publishing entirely, and `goreleaser check` never evaluates the token template.

- [ ] **Step 2: Ignore goreleaser's output directory.** In `.gitignore`, after the `/bin/` entry, add:

```gitignore
# goreleaser writes snapshot and release output here.
/dist/
```

- [ ] **Step 3: Validate the config.**

```bash
cd /Users/karn/code/karnstack/flue
goreleaser check; echo "exit: $?"
```

Expected: `exit: 2`, with output flagging exactly one deprecation — `brews` (deprecated since v2.16) — and the line "configuration is valid, but uses deprecated properties". Any other deprecation named, or `exit: 1` (invalid config), is a hard stop: fix the config before proceeding.

- [ ] **Step 4: Full local snapshot release** (this runs `make web` first, which needs pnpm via mise — both verified present):

```bash
goreleaser release --snapshot --clean
ls dist/*.tar.gz dist/checksums.txt
```

Expected: success, and `dist/` contains exactly four archives plus the checksum file, named on the contract (with no tags in the repo, goreleaser's default snapshot version is `0.0.0-SNAPSHOT-<shortsha>`):

```
dist/flue_0.0.0-SNAPSHOT-<shortsha>_darwin_amd64.tar.gz
dist/flue_0.0.0-SNAPSHOT-<shortsha>_darwin_arm64.tar.gz
dist/flue_0.0.0-SNAPSHOT-<shortsha>_linux_amd64.tar.gz
dist/flue_0.0.0-SNAPSHOT-<shortsha>_linux_arm64.tar.gz
dist/checksums.txt
```

- [ ] **Step 5: Verify the stamp, the checksums, and the archive shape.**

```bash
./dist/flue_darwin_arm64*/flue status | head -n 1
(cd dist && shasum -a 256 -c checksums.txt)
tar -tzf dist/flue_*_darwin_arm64.tar.gz
```

Expected: first line `version:  0.0.0-SNAPSHOT-<shortsha>` (anything but `dev` proves the ldflags stamp reached `main.version`); four `: OK` lines from shasum; the archive listing contains `flue` at the root (this exact member name is what `scripts/install.sh` extracts) alongside `LICENSE` and `README.md`.

- [ ] **Step 6: Commit.**

```bash
git add .goreleaser.yaml .gitignore
git commit -m "build: add the goreleaser config for the release pipeline" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: `.github/workflows/ci.yml` — lint and tests on every push and PR

**Files:**
- Create: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: `mise.toml` (go 1.26.1, node 24.18.0, pnpm 11.9.0), Makefile targets `lint` and `test`, `web/pnpm-lock.yaml` (cache key).
- Produces: workflow file `ci.yml` with workflow `name: ci` — the README badge (Task 8) references the path `ci.yml` and branch `main`; Task 6 appends install-script steps to this same job.

- [ ] **Step 1: Write `.github/workflows/ci.yml`:**

```yaml
name: ci

on:
  push:
    branches: [main]
  pull_request:

permissions:
  contents: read

jobs:
  checks:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6

      - name: Install the toolchain from mise.toml
        uses: jdx/mise-action@v4

      # mise-action caches the tools it installs, but not the pnpm store;
      # cache it separately, keyed on the lockfile.
      - name: Locate the pnpm store
        id: pnpm-store
        run: echo "path=$(pnpm store path --silent)" >> "$GITHUB_OUTPUT"

      - name: Cache the pnpm store
        uses: actions/cache@v4
        with:
          path: ${{ steps.pnpm-store.outputs.path }}
          key: pnpm-store-${{ runner.os }}-${{ hashFiles('web/pnpm-lock.yaml') }}
          restore-keys: |
            pnpm-store-${{ runner.os }}-

      - name: Lint
        run: make lint

      - name: Test
        run: make test
```

- [ ] **Step 2: Validate.**

```bash
cd /Users/karn/code/karnstack/flue
actionlint
```

Expected: no output, exit 0. (If actionlint is unavailable per Task 1's fallback, review the YAML by hand against the step list above: two triggers, `contents: read`, checkout → mise-action → store locate → cache → `make lint` → `make test`.)

- [ ] **Step 3: Commit.**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: add the workflow that lints and tests every push and PR" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: `.github/workflows/release.yml` — goreleaser on `v*` tags

**Files:**
- Create: `.github/workflows/release.yml`

**Interfaces:**
- Consumes: `.goreleaser.yaml` (Task 3), `mise.toml`, repo secrets `GITHUB_TOKEN` (automatic) and `TAP_GITHUB_TOKEN` (user-provided).
- Produces: a workflow that, on the first `git push origin v0.1.0`, publishes the four `flue_{version}_{os}_{arch}.tar.gz` assets, `checksums.txt`, the changelog, and the brew formula — with no further setup beyond the `TAP_GITHUB_TOKEN` secret.

**NOTE:** `TAP_GITHUB_TOKEN` is user-provided later (a fine-grained token with contents read/write on `karnstack/tap`, saved as a repo secret) — the only manual step in the whole pipeline. The workflow only fires on tags, and **nothing is tagged in this work**, so merging it is inert until the user tags.

- [ ] **Step 1: Write `.github/workflows/release.yml`:**

```yaml
name: release

on:
  push:
    tags: ["v*"]

permissions:
  contents: write

jobs:
  goreleaser:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
        with:
          # Required for the changelog: goreleaser walks the history
          # between tags.
          fetch-depth: 0

      # go, node, and pnpm from mise.toml — goreleaser's before hook runs
      # `make web`, which needs all three.
      - name: Install the toolchain from mise.toml
        uses: jdx/mise-action@v4

      - name: Release
        uses: goreleaser/goreleaser-action@v7
        with:
          distribution: goreleaser
          version: "~> v2"
          args: release --clean
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          # User-provided repo secret — the one manual setup step. It
          # authorizes the formula push to karnstack/tap; the default
          # GITHUB_TOKEN cannot write to another repository.
          TAP_GITHUB_TOKEN: ${{ secrets.TAP_GITHUB_TOKEN }}
```

- [ ] **Step 2: Validate.**

```bash
cd /Users/karn/code/karnstack/flue
actionlint
```

Expected: no output, exit 0 (both workflows are checked).

- [ ] **Step 3: Commit.**

```bash
git add .github/workflows/release.yml
git commit -m "ci: add the release workflow that ships a tag with goreleaser" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: `scripts/install.sh` and its test script (TDD)

**Files:**
- Create: `scripts/install_test.sh` (first — it is the failing test)
- Create: `scripts/install.sh`
- Modify: `.github/workflows/ci.yml` (append the shellcheck + install-test steps)

**Interfaces:**
- Consumes: `https://api.github.com/repos/karnstack/flue/releases/latest`; release assets named verbatim `flue_{version}_{os}_{arch}.tar.gz` and `checksums.txt` under `https://github.com/karnstack/flue/releases/download/{tag}/` (the Task 3 contract); the `flue` member at the archive root.
- Produces: `scripts/install.sh` — the **canonical** installer; the site lane copies this exact file into its static assets so it is served at `https://flue.sh/install.sh` (one source, two locations; the site lane must copy, never fork). Overrides/flags: env `FLUE_INSTALL_DIR`, `FLUE_OS`, `FLUE_ARCH`, `FLUE_PROC_VERSION`, `FLUE_API_URL`, `FLUE_INSTALL_SOURCED`; flag `--dry-run`. Also `scripts/install_test.sh`, run by CI and locally with plain `bash` — no framework.

- [ ] **Step 1: Write the test script first.** `scripts/install_test.sh`:

```bash
#!/usr/bin/env bash
# Tests for scripts/install.sh. Plain bash, no framework: each case runs the
# script (or sources it with FLUE_INSTALL_SOURCED=1 and calls one function)
# in a clean child shell, then asserts on the exit code and the output.
# Run locally or in CI:
#
#   bash scripts/install_test.sh
#
# Nothing here touches the network: platform failures happen before the API
# call, and the API-dependent cases stub fetch_latest.

set -u
cd "$(dirname "$0")" || exit 1

failures=0

assert_eq() { # label want got
  if [ "$2" = "$3" ]; then
    echo "ok   $1"
  else
    echo "FAIL $1: want '$2', got '$3'"
    failures=$((failures + 1))
  fi
}

assert_contains() { # label needle haystack
  case "$3" in
    *"$2"*) echo "ok   $1" ;;
    *)
      echo "FAIL $1: output does not contain '$2'"
      printf '%s\n' "$3" | sed 's/^/     | /'
      failures=$((failures + 1))
      ;;
  esac
}

# --- an unsupported OS is one line and exit 1 --------------------------------
out=$(FLUE_OS=SunOS FLUE_ARCH=amd64 sh ./install.sh --dry-run 2>&1)
rc=$?
assert_eq "unsupported OS exits 1" 1 "$rc"
assert_contains "unsupported OS names itself" "unsupported operating system: SunOS" "$out"

# --- native Windows points at WSL --------------------------------------------
out=$(FLUE_OS=MINGW64_NT-10.0 sh ./install.sh --dry-run 2>&1)
rc=$?
assert_eq "native Windows exits 1" 1 "$rc"
assert_contains "native Windows points at WSL" "WSL" "$out"

# --- an unsupported arch is one line and exit 1 ------------------------------
out=$(FLUE_OS=Linux FLUE_ARCH=riscv64 sh ./install.sh --dry-run 2>&1)
rc=$?
assert_eq "unsupported arch exits 1" 1 "$rc"
assert_contains "unsupported arch names itself" "unsupported architecture: riscv64" "$out"

# --- WSL is detected via /proc/version and treated as linux ------------------
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
echo "Linux version 5.15.153.1-microsoft-standard-WSL2" >"$tmp/proc_version"

out=$(bash -c '
  FLUE_INSTALL_SOURCED=1
  . ./install.sh
  FLUE_OS=Linux FLUE_PROC_VERSION="$1" detect_os
' _ "$tmp/proc_version" 2>&1)
rc=$?
assert_eq "WSL detection exits 0" 0 "$rc"
assert_contains "WSL is called out and treated as linux" "WSL detected" "$out"

# --- no release yet: a 404 from the API is a clear message -------------------
out=$(bash -c '
  FLUE_INSTALL_SOURCED=1
  . ./install.sh
  fetch_latest() { printf "%s" 404; }
  FLUE_OS=Linux FLUE_ARCH=amd64 main --dry-run
' 2>&1)
rc=$?
assert_eq "no-release exits 1" 1 "$rc"
assert_contains "no-release message" "no release published yet" "$out"
assert_contains "no-release points at the repo" "github.com/karnstack/flue/releases" "$out"

# --- a happy dry-run resolves the exact asset name ---------------------------
out=$(bash -c '
  FLUE_INSTALL_SOURCED=1
  . ./install.sh
  fetch_latest() { printf "%s" "{\"tag_name\": \"v0.1.0\"}" >"$1"; printf "%s" 200; }
  FLUE_OS=Darwin FLUE_ARCH=arm64 FLUE_INSTALL_DIR=/nowhere/bin main --dry-run
' 2>&1)
rc=$?
assert_eq "dry-run exits 0" 0 "$rc"
assert_contains "dry-run names the asset on the contract" "flue_0.1.0_darwin_arm64.tar.gz" "$out"
assert_contains "dry-run honours FLUE_INSTALL_DIR" "/nowhere/bin/flue" "$out"
assert_contains "dry-run ends with the next step" "next: flue enable" "$out"

# --- x86_64 normalizes to amd64 ----------------------------------------------
out=$(bash -c '
  FLUE_INSTALL_SOURCED=1
  . ./install.sh
  fetch_latest() { printf "%s" "{\"tag_name\": \"v0.1.0\"}" >"$1"; printf "%s" 200; }
  FLUE_OS=Linux FLUE_ARCH=x86_64 FLUE_INSTALL_DIR=/nowhere/bin main --dry-run
' 2>&1)
rc=$?
assert_eq "x86_64 dry-run exits 0" 0 "$rc"
assert_contains "x86_64 becomes amd64 in the asset name" "flue_0.1.0_linux_amd64.tar.gz" "$out"

echo
if [ "$failures" -gt 0 ]; then
  echo "$failures failure(s)"
  exit 1
fi
echo "all install.sh tests passed"
```

- [ ] **Step 2: See it fail.**

```bash
cd /Users/karn/code/karnstack/flue
chmod +x scripts/install_test.sh
bash scripts/install_test.sh
```

Expected: FAIL lines (install.sh does not exist yet) and a non-zero exit. That is the red state.

- [ ] **Step 3: Write `scripts/install.sh`:**

```sh
#!/bin/sh
# flue installer.
#
# Canonical copy: scripts/install.sh in https://github.com/karnstack/flue.
# The site lane copies this exact file into site/ static assets, so it is
# served at https://flue.sh/install.sh and the one-liner is:
#
#   curl -fsSL https://flue.sh/install.sh | sh
#
# Supported: macOS and Linux on amd64/arm64. WSL counts as Linux. Anything
# else gets one line of explanation, never a curl error. The sha256 of the
# downloaded archive is verified against the release's checksums.txt before
# anything is installed; a mismatch aborts.
#
# Escape hatches, all optional:
#   FLUE_INSTALL_DIR      install here instead of the /usr/local/bin chain
#   FLUE_OS, FLUE_ARCH    override uname detection (testing)
#   FLUE_PROC_VERSION     override the /proc/version path (testing WSL)
#   FLUE_API_URL          override the latest-release endpoint (testing)
#   FLUE_INSTALL_SOURCED  set to 1 to source without running (testing)
#   --dry-run             print what would happen; write nothing outside a
#                         mktemp scratch directory

set -eu

REPO="karnstack/flue"
DRY_RUN=0
OS=""
ARCH=""
TAG=""
VERSION=""
INSTALL_DIR=""
NEED_SUDO=0
PATH_HINT=0
tmp=""

say() { printf '%s\n' "$*"; }

die() {
  printf 'flue: %s\n' "$*" >&2
  exit 1
}

parse_args() {
  for arg in "$@"; do
    case "$arg" in
      --dry-run) DRY_RUN=1 ;;
      *) die "unknown argument: ${arg} (the only flag is --dry-run)" ;;
    esac
  done
}

# is_wsl reports whether this Linux is WSL: /proc/version mentioning
# Microsoft is the documented tell. The path is overridable so the test
# suite can fake it on macOS.
is_wsl() {
  grep -qi microsoft "${FLUE_PROC_VERSION:-/proc/version}" 2>/dev/null
}

detect_os() {
  os_raw="${FLUE_OS:-$(uname -s)}"
  case "$os_raw" in
    Darwin) OS=darwin ;;
    Linux)
      OS=linux
      if is_wsl; then
        say "WSL detected; installing the linux build."
      fi
      ;;
    MINGW* | MSYS* | CYGWIN* | Windows*)
      die "native Windows is not supported; install flue inside WSL instead"
      ;;
    *)
      die "unsupported operating system: ${os_raw} (flue runs on macOS, Linux, and WSL)"
      ;;
  esac
}

detect_arch() {
  arch_raw="${FLUE_ARCH:-$(uname -m)}"
  case "$arch_raw" in
    x86_64 | amd64) ARCH=amd64 ;;
    aarch64 | arm64) ARCH=arm64 ;;
    *)
      die "unsupported architecture: ${arch_raw} (flue ships amd64 and arm64 builds)"
      ;;
  esac
}

# fetch_latest DEST writes the GitHub latest-release JSON to DEST and prints
# the HTTP status code. It is a separate function so the test suite can
# replace it with a stub instead of talking to the real API.
fetch_latest() {
  curl -sSL -o "$1" -w '%{http_code}' \
    "${FLUE_API_URL:-https://api.github.com/repos/${REPO}/releases/latest}"
}

resolve_version() {
  code=$(fetch_latest "${tmp}/latest.json") \
    || die "cannot reach the GitHub API to find the latest release"
  case "$code" in
    200) ;;
    404)
      # The state until the first tag is pushed.
      die "no release published yet — there is nothing to install; watch https://github.com/${REPO}/releases"
      ;;
    *)
      die "the GitHub API answered HTTP ${code} when asked for the latest release"
      ;;
  esac
  TAG=$(sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' \
    "${tmp}/latest.json" | head -n 1)
  [ -n "$TAG" ] || die "could not read tag_name from the GitHub API response"
  VERSION=${TAG#v}
}

choose_install_dir() {
  if [ -n "${FLUE_INSTALL_DIR:-}" ]; then
    INSTALL_DIR=$FLUE_INSTALL_DIR
    return 0
  fi
  if [ -d /usr/local/bin ] && [ -w /usr/local/bin ]; then
    INSTALL_DIR=/usr/local/bin
  elif [ -t 1 ] && command -v sudo >/dev/null 2>&1; then
    # sudo is offered, never assumed: only when there is a terminal to
    # prompt on. Under `curl | sh`, stdin is the script but stdout is
    # still the terminal, and sudo prompts on /dev/tty.
    INSTALL_DIR=/usr/local/bin
    NEED_SUDO=1
  else
    INSTALL_DIR=${HOME}/.local/bin
    PATH_HINT=1
  fi
}

verify_checksum() {
  expected=$(awk -v f="$asset" '$2 == f { print $1 }' "${tmp}/checksums.txt")
  [ -n "$expected" ] || die "checksums.txt has no entry for ${asset}"
  if [ "$OS" = darwin ]; then
    actual=$(shasum -a 256 "${tmp}/${asset}" | awk '{ print $1 }')
  else
    actual=$(sha256sum "${tmp}/${asset}" | awk '{ print $1 }')
  fi
  [ "$expected" = "$actual" ] \
    || die "sha256 mismatch for ${asset} (expected ${expected}, got ${actual}); aborting before install"
}

install_binary() {
  if [ "$NEED_SUDO" = 1 ]; then
    say "installing to ${INSTALL_DIR} needs sudo; you may be asked for your password."
    sudo mkdir -p "$INSTALL_DIR"
    sudo install -m 0755 "${tmp}/flue" "${INSTALL_DIR}/flue"
  else
    mkdir -p "$INSTALL_DIR"
    install -m 0755 "${tmp}/flue" "${INSTALL_DIR}/flue"
  fi
}

path_hint() {
  [ "$PATH_HINT" = 1 ] || return 0
  case ":${PATH}:" in
    *":${INSTALL_DIR}:"*) ;;
    *)
      say "note: ${INSTALL_DIR} is not on your PATH; add it with:"
      say "  export PATH=\"${INSTALL_DIR}:\$PATH\""
      ;;
  esac
}

main() {
  parse_args "$@"
  detect_os
  detect_arch

  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' EXIT

  resolve_version

  # The release asset naming contract, shared verbatim with .goreleaser.yaml
  # and the site lane: flue_{version}_{os}_{arch}.tar.gz.
  asset="flue_${VERSION}_${OS}_${ARCH}.tar.gz"
  base_url="https://github.com/${REPO}/releases/download/${TAG}"
  choose_install_dir

  if [ "$DRY_RUN" = 1 ]; then
    say "dry-run: would download ${base_url}/${asset}"
    say "dry-run: would verify its sha256 against ${base_url}/checksums.txt"
    say "dry-run: would install to ${INSTALL_DIR}/flue"
    say "next: flue enable"
    return 0
  fi

  say "downloading flue ${VERSION} (${OS}/${ARCH})..."
  curl -fsSL -o "${tmp}/${asset}" "${base_url}/${asset}"
  curl -fsSL -o "${tmp}/checksums.txt" "${base_url}/checksums.txt"
  verify_checksum
  tar -xzf "${tmp}/${asset}" -C "$tmp" flue
  install_binary

  say "flue ${VERSION} installed to ${INSTALL_DIR}/flue"
  path_hint
  say "next: flue enable"
}

# When sourced by the test suite (FLUE_INSTALL_SOURCED=1) nothing runs; the
# tests call the functions directly.
if [ "${FLUE_INSTALL_SOURCED:-0}" != "1" ]; then
  main "$@"
fi
```

- [ ] **Step 4: Green, and shellcheck-clean.**

```bash
chmod +x scripts/install.sh
bash scripts/install_test.sh
shellcheck scripts/install.sh scripts/install_test.sh
```

Expected: every line of the test output starts with `ok`, ending `all install.sh tests passed`, exit 0; shellcheck prints nothing and exits 0 (the `#!/bin/sh` shebang makes it check POSIX compliance). Fix any finding rather than suppressing it.

- [ ] **Step 5: Wire it into CI.** In `.github/workflows/ci.yml`, append to the `checks` job, directly after the `Test` step (same indentation):

```yaml
      # ubuntu-latest images ship shellcheck; apt keeps it deterministic
      # either way.
      - name: Install shellcheck
        run: sudo apt-get update -qq && sudo apt-get install -y -qq shellcheck

      - name: Shellcheck the install script
        run: shellcheck scripts/install.sh scripts/install_test.sh

      - name: Install-script tests
        run: bash scripts/install_test.sh
```

- [ ] **Step 6: Re-validate the workflow.**

```bash
actionlint
```

Expected: no output, exit 0.

- [ ] **Step 7: Commit.**

```bash
cd /Users/karn/code/karnstack/flue
git add scripts/install.sh scripts/install_test.sh .github/workflows/ci.yml
git commit -m "feat: add the install script that flue.sh serves, with tests" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: The `karnstack/tap` repo (verify — it already exists)

**Files:**
- None in this repo. Remote: `karnstack/tap` (`README.md`, `Formula/.gitkeep`).

**Interfaces:**
- Consumes: `gh` CLI (authenticated as `karngyan` with `repo` scope — verified).
- Produces: a public `karnstack/tap` repo with a `Formula/` directory — the push target of Task 3's `brews` section (`repository: owner: karnstack, name: tap, directory: Formula`) and the install source of `brew install karnstack/tap/flue`.

**NOTE:** Verified on 2026-07-30: the repo **already exists** (the orchestrator created it) — public, default branch `main`, containing `README.md` (which already explains `brew install karnstack/tap/flue` and that formulae are published by each project's release pipeline) and `Formula/.gitkeep`. So this task is expected to be verification-only.

- [ ] **Step 1: Verify existence and shape.**

```bash
gh repo view karnstack/tap --json isPrivate,defaultBranchRef --jq '{private: .isPrivate, branch: .defaultBranchRef.name}'
gh api repos/karnstack/tap/contents --jq '.[].path'
```

Expected: `{"private":false,"branch":"main"}` and a listing containing `Formula` and `README.md`. If both hold, this task is **done — skip the remaining steps**.

- [ ] **Step 2 (contingency — only if the repo is missing): create it.**

```bash
gh repo create karnstack/tap --public --description "Homebrew formulae for karnstack tools"
```

- [ ] **Step 3 (contingency): scaffold and push.** In a scratch directory outside this repo:

````bash
git clone https://github.com/karnstack/tap.git && cd tap
mkdir -p Formula
touch Formula/.gitkeep
cat > README.md <<'EOF'
# karnstack tap

Homebrew formulae for [karnstack](https://github.com/karnstack) tools.

```
brew install karnstack/tap/flue
```

Formulae here are published automatically by each project's release
pipeline (goreleaser); do not edit them by hand — the next release
overwrites them.
EOF
git add README.md Formula/.gitkeep
git commit -m "docs: add the tap README and the empty Formula directory" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
git push origin main
````

- [ ] **Step 4 (contingency): re-run Step 1's verification** — same expected output.

No commit in the flue repo.

---

### Task 8: README rewrite — LAST

**Files:**
- Modify: `README.md` (full rewrite)

**Interfaces:**
- Consumes: workflow file name `ci.yml` on branch `main` (Task 4 — badge path), GitHub releases (badge shows the latest tag, or "no release" until one exists — honest either way), `LICENSE` (exists, MIT), `https://flue.sh` (site lane), and `flue enable` (product lane).
- Produces: the public repo landing page.

**DEPENDENCY:** the product lane's `enable`/`disable` task must be **merged first** — this README states `flue enable` as fact, and §2.3 of the spec ("docs made true") forbids shipping that claim early. The verification in Step 1 is the gate; if it fails, stop this task and wait.

- [ ] **Step 1: Verify `flue enable` exists.**

```bash
cd /Users/karn/code/karnstack/flue
make build
./bin/flue help 2>&1 | grep -i enable
```

Expected: a usage line for `flue enable` (e.g. `flue enable    install the login service...`). **If grep prints nothing (exit 1): STOP — do not write or commit this README** until the product lane's enable work is merged.

- [ ] **Step 2: Replace `README.md` wholesale with:**

````markdown
<h1 align="center">flue</h1>

<p align="center"><strong>Your terminal, as a browser tab. Reachable from any device you own.</strong></p>

<p align="center">
  <a href="https://github.com/karnstack/flue/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/karnstack/flue/ci.yml?branch=main&label=ci" alt="CI status"></a>
  <a href="https://github.com/karnstack/flue/releases/latest"><img src="https://img.shields.io/github/v/release/karnstack/flue?label=release" alt="Latest release"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT license"></a>
</p>

<p align="center">
  <a href="https://flue.sh">flue.sh</a> ·
  <a href="docs/superpowers/specs/2026-07-28-flue-design.md">design</a>
</p>

> Status: the local terminal works, and `flue enable` installs the login
> service. Remote transports and pairing are designed, not yet built. No
> release is tagged yet — the pipeline is live, and the first tag ships
> binaries, a brew formula, and the installer.

## Install

```sh
brew install karnstack/tap/flue
```

or, without Homebrew:

```sh
curl -fsSL https://flue.sh/install.sh | sh
```

then:

```sh
flue enable
```

`flue enable` installs a login service, starts the daemon, and opens the UI.
Everything after that happens in the browser. macOS · Linux · WSL. One
static binary — no Node, no Python, no toolchain, ever.

## Why

Two apps get used all day: a terminal and a browser. Browsers have tab
groups, tab search, splits, session restore, and URL addressing. Terminals
have none of it and cannot join in.

flue makes a terminal session a browser tab, so it inherits all of that for
free — and makes the same live session reachable from a phone, an iPad, or
another laptop.

## Shape

A small Go daemon owns the PTYs and their scrollback. A web app renders
them. Closing the tab detaches; the build keeps running, and reattaching
replays what you missed. Two devices on one session mirror live — typing on
the phone shows up on the laptop, and the phone's 40 columns don't shrink
the laptop.

The CLI stays at four commands on purpose:

```
flue enable       # install the login service, start the daemon, open the UI
flue disable      # remove it
flue status       # version, daemon state, session count
flue open [path]  # spawn a session here — handy from a shell prompt
```

## Reaching it from elsewhere

Remote access is opt-in and provider-agnostic (designed, not yet built — see
the status above). flue has no preferred option; the UI will order them by
what you already have installed.

| provider | what it needs | intermediary |
|---|---|---|
| local | nothing, always on | none |
| Tailscale | Tailscale on each device | none, often direct peer-to-peer |
| Cloudflare | a Cloudflare account, free tier is enough | your own Worker, ciphertext only |
| Cloudflare + your domain | a domain on Cloudflare | Cloudflare |

Anything through an intermediary is end-to-end encrypted (Noise IK, the
daemon's key pinned at pairing), so the relay forwards ciphertext and can
never read your shell.

**There is no hosted service.** No flue account, no flue server, no billing.
Every remote path runs on infrastructure you own. [flue.sh](https://flue.sh)
is docs and downloads, never part of the data path.

## Building from source

```sh
mise install   # go, node, pnpm — pinned in mise.toml
make build     # builds the web UI, embeds it, produces bin/flue
make test
```

## License

[MIT](LICENSE)
````

No fabricated demo assets: a real screenshot/gif comes after the frontend-polish lane lands, from the real product.

- [ ] **Step 3: Verify the claims against the repo.**

```bash
ls .github/workflows/ci.yml LICENSE scripts/install.sh
./bin/flue help 2>&1 | grep -ci "enable\|disable\|status\|open"
```

Expected: all three paths listed; the grep count is at least 4 (all four commands documented in the README exist in the usage text).

- [ ] **Step 4: Commit.**

```bash
git add README.md
git commit -m "docs: rewrite the README for the public landing" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```
