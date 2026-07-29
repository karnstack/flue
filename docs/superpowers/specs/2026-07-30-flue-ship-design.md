# flue ship: enable/disable, release infra, flue.sh landing

Date: 2026-07-30
Status: approved
Parent spec: [2026-07-28-flue-design.md](2026-07-28-flue-design.md)

## Goal

Take flue from "local terminal works" to shippable: implement the `enable`/
`disable` commands the parent spec already defines, land the follow-ups carried
out of the local-terminal build, stand up the full release pipeline (goreleaser,
GitHub Actions, Homebrew tap, install script), and launch flue.sh — a landing
page that also serves the installer — deployed to Cloudflare with wrangler.

Decisions made with the user up front:

- **Scope**: implement `enable`/`disable` per the parent spec, plus all four
  items in `docs/FOLLOW-UPS.md`.
- **Release**: infrastructure only. No tag is pushed as part of this work; the
  user tags `v0.1.0` when ready. Everything must work on first tag.
- **Windows**: WSL only. No native windows binary — the PTY layer is Unix.
  `install.sh` treats WSL as linux; marketing says "macOS · Linux · WSL".
- **Landing direction**: manifesto-minimal. Text-led, strong typography, one
  page, install command front and center.

## 1. `flue enable` / `flue disable`

New package `internal/service`, one implementation per platform behind a small
interface:

- **darwin**: a launchd agent plist at
  `~/Library/LaunchAgents/sh.flue.daemon.plist`, loaded with
  `launchctl bootstrap gui/$UID` (modern spelling, not `load`).
- **linux**: a systemd user unit at `~/.config/systemd/user/flue.service`,
  enabled with `systemctl --user enable --now flue`.

Behavior:

- `enable`: write the unit, start it, poll the daemon's health endpoint until
  it answers (bounded wait), then open the UI in the default browser. Output
  matches the parent spec's transcript (checkmarks per step).
- `disable`: stop the service, remove the unit file. Idempotent — disabling
  when not enabled reports that plainly and exits 0.
- `status`: gains a line for the login service — installed/not installed,
  running/not running — alongside its existing daemon diagnostics.
- Re-running `enable` when already enabled is not an error: it converges
  (rewrites the unit if it drifted, restarts if dead, opens the UI).
- **WSL / no systemd**: if `systemctl --user` is unavailable (common in WSL),
  `enable` explains why and points at `flue serve` for manual operation. Not
  silent, not a stack trace.

The unit runs `flue serve` (the existing daemon entrypoint). The binary's own
path — `os.Executable()`, resolved — goes into the unit, so a brew-installed
and a hand-built flue both point at themselves.

Testing: unit-file generation is table-driven and asserted byte-for-byte
(paths, escaping, the resolved executable). Command flow (enable → write +
start + wait + open) is tested against a fake runner interface; CI never talks
to real launchd/systemd.

## 2. Follow-ups (docs/FOLLOW-UPS.md, all four)

1. **`reqId` correlation** — `attach` carries a client-chosen `reqId`, echoed
   on `wire.Attached` and on `wire.Error` (the error case is mandatory:
   `not_found` arrives as an error). Collapses the four ordering heuristics:
   the client's `owed` counter, the sessions route's `refuseNext` and counter,
   and the terminal's `not_found` heuristic. Lands in one commit with the Go
   wire fixture, the TypeScript types, and `spec/protocol.md` — the round-trip
   test fails on any untagged field, which is the point.
2. **Replay reinjection fix** — `wire.Attached` gains `head`, computed as
   `sub.StartSeq + len(sub.Backlog)` in `conn.go`. The client mutes xterm's
   `onData` until it has consumed `head` bytes, so replayed DA/DECRQM/OSC-11
   probe replies never reach the shell's stdin. `head === seq` on a fresh
   spawn opens the gate immediately (this is why gating on "first output
   frame" is wrong — that frame is omitted when the backlog is empty).
3. **Docs made true** — README's `flue enable` section becomes true once §1
   lands. `usage()` for `flue open` is corrected, and `?cwd=` is actually
   honored: the sessions UI reads it and spawns a session in that directory
   (this is the smallest change that makes the existing flag honest, and it is
   the flag's whole purpose). The spec's local-auth description is corrected
   to name `Sec-Fetch-Site` as the load-bearing check.
4. **Minimal audit log** — `log/slog` on the daemon: every attach, detach,
   auth rejection, and (once they exist) pairing/revocation event, with the
   resolved peer identity. Satisfies the parent spec's security-section
   requirement instead of striking it. Logs go to stderr, which launchd/
   systemd already capture.

## 3. Frontend polish (web/)

A visual pass only — no new features. Driven by the design skill at
implementation time. In scope: the sessions table, empty states, the terminal
chrome, favicon/app icons, and an OG image. The bar: nothing looks like a
default component; everything looks like one product.

## 4. Release infrastructure

**goreleaser** (v2 config, `.goreleaser.yaml`):

- `before` hook: `make web` — `web/dist` must exist before any `go build`.
- Builds: darwin/amd64, darwin/arm64, linux/amd64, linux/arm64.
  `CGO_ENABLED=0` (deps are pure Go: creack/pty, coder/websocket).
- Version stamped via ldflags into a `main.version` variable; `flue status`
  reports it. No new CLI command — the four-command surface is a spec
  commitment.
- tar.gz archives, `checksums.txt`, changelog grouped from conventional
  commits.
- `brews`: formula pushed to `karnstack/tap` (repo created as part of this
  work, `Formula/` layout). Push authenticates with a `TAP_GITHUB_TOKEN`
  repo secret — **user-provided; the only manual step**. Formula includes a
  `flue status` test block.

**GitHub Actions**:

- `ci.yml` — on push to main and PRs: mise-managed toolchain (go 1.26.1,
  node 24, pnpm 11.9), pnpm store cache, `make lint test`.
- `release.yml` — on `v*` tags: same toolchain, `goreleaser release`.
  Permissions: `contents: write`; tap push uses `TAP_GITHUB_TOKEN`.

Nothing is tagged now. First `git push origin v0.1.0` produces binaries,
checksums, a changelog, and a live brew formula with no further setup.

## 5. install.sh

POSIX sh, served at `https://flue.sh/install.sh`, usable as
`curl -fsSL https://flue.sh/install.sh | sh`.

- Detects OS (`uname -s`) and arch (`uname -m`), normalizes to release asset
  names. WSL is detected (`/proc/version` mentions Microsoft) and treated as
  linux. Anything else — native Windows, unsupported arch — gets a one-line
  explanation, not a curl error.
- Resolves the latest release via the GitHub API, downloads the tar.gz and
  `checksums.txt`, verifies sha256 before touching the filesystem.
- Installs to `/usr/local/bin` when writable (sudo offered, never assumed),
  else `~/.local/bin` with a PATH hint.
- If no release exists yet: a clear "no release published yet" message and a
  pointer to the repo. This is the state until the user tags.
- Ends by printing the next step: `flue enable`.

## 6. Landing page — flue.sh

- New top-level `site/` directory: one hand-authored `index.html` + `style.css`,
  near-zero JS (a copy-to-clipboard affordance on the install command at most).
  No framework, no build step — rejected a Vite/Tailwind pipeline as YAGNI for
  one page.
- Content, in order: hero ("Your terminal, as a browser tab."), the install
  command, the why (terminal + browser, tabs/search/restore for free), the
  shape (daemon owns PTYs, tab close detaches, devices mirror), the remote
  access table (local / Tailscale / Cloudflare / your domain), the "there is
  no hosted service" principle stated plainly, GitHub link. Footer: license,
  press-free.
- Visual direction: manifesto-minimal per the user's pick, executed with the
  design skill. One restrained live-terminal visual; typography does the work.
- OG image + favicon shared with the web app's icon work (§3).
- **Deploy**: Cloudflare Worker with static assets (`site/wrangler.jsonc`,
  assets directory pointing at the static files). `install.sh` ships as one of
  those assets so the page and the installer are one deploy. Custom domain
  `flue.sh` attached to the Worker; `www` redirects to apex. Deployed with
  wrangler from the already-authenticated account.
- A `deploy-site.yml` workflow (on changes to `site/` on main) is included so
  the page stays deployable from CI as well as locally; it needs a
  `CLOUDFLARE_API_TOKEN` secret — optional, wrangler-local deploy is the
  baseline.

## 7. README

Rewrite for a public repo landing: badges (CI, release, license), the tagline,
an honest status line, install via brew and curl, the why/shape sections
tightened, remote-access table, link to flue.sh, contributing pointer, MIT.
No fabricated demo assets; a real screenshot/gif can come after the frontend
polish lands, from the real product.

## Component boundaries

- `internal/service` is new and self-contained: interface + darwin/linux
  implementations + a fake for tests. `cmd/flue` consumes it; nothing else
  does.
- Wire changes (`reqId`, `head`) touch `internal/wire`, `internal/daemon`'s
  conn handling, `web/src/client`, and `spec/protocol.md` together, by design —
  the fixture tests exist to force that.
- `site/` has no dependency on `web/` or Go; it deploys independently.
- goreleaser/workflows depend on `Makefile` targets, not on inline copies of
  build steps.

## Error handling themes

- CLI failures (`enable` without systemd, `disable` when absent) are
  one-line, actionable, exit-coded — never stack traces.
- install.sh fails closed: checksum mismatch aborts before install; unknown
  platform explains itself.
- Client mute-until-`head` must handle the socket dying mid-backlog: the gate
  resets with the attachment (it is per-attach state, not per-connection).

## Testing

- Go: service unit-file tables, fake-runner command flows, wire round-trip
  fixtures extended for `reqId`/`head`, audit-log call sites asserted where
  auth decisions are made.
- Web: existing vitest suites extended for `reqId` plumbing and the mute gate
  (fresh spawn, backlog replay, reconnect, second mirror tab).
- Infra: `goreleaser check` + `goreleaser release --snapshot --clean` run
  locally in CI-equivalent conditions before the config is called done;
  install.sh gets a shellcheck pass and a dry-run mode exercised in CI.
- Site: deployed to a workers.dev preview first; flue.sh cutover after the
  page renders correctly.

## Execution order

1. Product lane: §1 enable/disable → §2 follow-ups (reqId first, per
   FOLLOW-UPS ranking).
2. Infra lane (parallel): §4 goreleaser + workflows + tap repo, §5 install.sh.
3. Site lane (parallel): §6 landing + deploy.
4. Convergence: §3 frontend polish, §7 README (last — it describes what by
   then exists), snapshot-release rehearsal.

Lanes 1–3 are independent and suit parallel subagents; convergence is serial.

## Out of scope

Remote transports (Tailscale/Cloudflare relay), pairing, devices UI, hosted
anything, native Windows, tagging the first release.
