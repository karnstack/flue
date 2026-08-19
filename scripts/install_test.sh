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

# --- an existing install makes the next step a restart, not enable -----------
# The same script serves first installs and updates. When a flue binary is
# already at the install path, the daemon keeps running the old build until
# restarted, so the closing hint must say restart.
utmp=$(mktemp -d)
trap 'rm -rf "$tmp" "$utmp"' EXIT
printf '#!/bin/sh\n' >"${utmp}/flue"
chmod +x "${utmp}/flue"

out=$(bash -c '
  FLUE_INSTALL_SOURCED=1
  . ./install.sh
  fetch_latest() { printf "%s" "{\"tag_name\": \"v0.1.0\"}" >"$1"; printf "%s" 200; }
  FLUE_OS=Darwin FLUE_ARCH=arm64 FLUE_INSTALL_DIR="$1" main --dry-run
' _ "$utmp" 2>&1)
rc=$?
assert_eq "update dry-run exits 0" 0 "$rc"
assert_contains "update ends with restart, not enable" "next: flue restart" "$out"
case "$out" in
  *"next: flue enable"*)
    echo "FAIL update dry-run must not suggest flue enable"
    printf '%s\n' "$out" | sed 's/^/     | /'
    failures=$((failures + 1))
    ;;
  *) echo "ok   update dry-run does not suggest flue enable" ;;
esac

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

# --- a checksum mismatch aborts before any install action --------------------
# --dry-run returns before verify_checksum ever runs, so this drives it
# directly: a real archive file plus a checksums.txt that names the wrong
# sha256 for it, same as a tampered or corrupted download would produce.
ctmp=$(mktemp -d)
trap 'rm -rf "$tmp" "$utmp" "$ctmp"' EXIT
printf 'not the real archive bytes' >"${ctmp}/flue_0.1.0_darwin_arm64.tar.gz"
printf 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef  flue_0.1.0_darwin_arm64.tar.gz\n' \
  >"${ctmp}/checksums.txt"

out=$(bash -c '
  FLUE_INSTALL_SOURCED=1
  . ./install.sh
  tmp="$1"
  asset="flue_0.1.0_darwin_arm64.tar.gz"
  OS=darwin
  verify_checksum
' _ "$ctmp" 2>&1)
rc=$?
assert_eq "checksum mismatch exits 1" 1 "$rc"
assert_contains "checksum mismatch names the failure" "sha256 mismatch for flue_0.1.0_darwin_arm64.tar.gz" "$out"
assert_contains "checksum mismatch aborts before install" "aborting before install" "$out"

echo
if [ "$failures" -gt 0 ]; then
  echo "$failures failure(s)"
  exit 1
fi
echo "all install.sh tests passed"
