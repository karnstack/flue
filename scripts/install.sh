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
UPDATING=0
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
      die "no release published yet. There is nothing to install; watch https://github.com/${REPO}/releases"
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

# next_step_hint closes with what to run next. A first install needs the
# login service set up, so: flue enable. An update overwrote a binary that
# was already there, and a running daemon keeps executing the old build
# until it is restarted, so: flue restart. UPDATING is decided before the
# new binary lands, otherwise every install would look like an update.
next_step_hint() {
  if [ "$UPDATING" = 1 ]; then
    say "next: flue restart"
  else
    say "next: flue enable"
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
  if [ -x "${INSTALL_DIR}/flue" ]; then
    UPDATING=1
  fi

  if [ "$DRY_RUN" = 1 ]; then
    say "dry-run: would download ${base_url}/${asset}"
    say "dry-run: would verify its sha256 against ${base_url}/checksums.txt"
    say "dry-run: would install to ${INSTALL_DIR}/flue"
    next_step_hint
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
  next_step_hint
}

# When sourced by the test suite (FLUE_INSTALL_SOURCED=1) nothing runs; the
# tests call the functions directly.
if [ "${FLUE_INSTALL_SOURCED:-0}" != "1" ]; then
  main "$@"
fi
