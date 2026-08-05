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

## Developing

The daemon embeds the web build (`//go:embed` in `web/embed.go`), so nothing
on the Go side — not even `go vet` — compiles until `web/dist` exists. The
Makefile encodes that ordering; let it do the sequencing:

```sh
make build       # web UI first, then the binary
bin/flue serve   # run the daemon in the foreground; prints a one-time UI URL
```

`make test` runs both suites (Go and Vitest), `make lint` is `go vet` plus a
TypeScript typecheck. Use pnpm, never npm — the web workspace pins it.

For frontend work, run Vite against a real daemon:

```sh
bin/flue serve       # terminal 1: the daemon on 127.0.0.1:7717
cd web && pnpm dev   # terminal 2: Vite on 127.0.0.1:5173
```

Open the one-time URL `flue serve` printed once — that sets the auth cookie —
then develop at `http://127.0.0.1:5173`. Vite proxies `/api` and `/ws` to the
daemon and rewrites the Origin so its checks pass; the cookie rides along
because cookies ignore the port. Stick to `127.0.0.1`, not `localhost`: the
cookie is set for that host exactly.

Layout, briefly: `cmd/flue` is the CLI, `internal/daemon` the HTTP/WebSocket
server, `internal/session` the PTYs and scrollback, `internal/service` the
launchd/systemd integration, `web/` the React app, `site/` the flue.sh page,
and `docs/FOLLOW-UPS.md` the known rough edges — worth reading before
touching the code.

## License

[MIT](LICENSE)
