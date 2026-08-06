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
> service. Pairing works over `local` — pair a second device from the UI, see
> it listed, revoke it — and the end-to-end crypto it pins is in place. The
> Cloudflare relay is built: `flue relay setup` deploys it to your own
> account, and the daemon dials it. It has not yet been through its manual
> end-to-end gate against a real account
> ([docs/RELAY.md](docs/RELAY.md)), so treat it as ready to try rather than
> ready to rely on. The hosted control plane behind flue.sh is built too —
> invites, email-code sign-in, `flue link`, the device directory — and is not
> open: email delivery is still a placeholder and its own end-to-end gate
> ([docs/SAAS.md](docs/SAAS.md)) has not been run. Tailscale is still designed,
> not built. No release is tagged yet — the pipeline is live, and the first tag
> ships binaries, a brew formula, and the installer.

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

The CLI stays small on purpose:

```
flue enable       # install the login service, start the daemon, open the UI
flue disable      # remove it
flue status       # version, daemon state, session count
flue open [path]  # spawn a session here — handy from a shell prompt
flue relay setup  # deploy a relay to your own Cloudflare account (see below)
flue link         # link this machine to a flue.sh account (see below)
```

## Remote access

Remote access is opt-in and provider-agnostic. flue has no preferred option;
the UI orders them by what you already have.

| provider | what it needs | intermediary | state |
|---|---|---|---|
| local | nothing, always on | none | works |
| Cloudflare | a Cloudflare account, free tier is enough | your own Worker, ciphertext only | works — `flue relay setup` |
| flue.sh | an invite, and nothing to deploy | our Worker, ciphertext only | built, not yet open — `flue link` |
| Tailscale | Tailscale on each device | none, often direct peer-to-peer | designed |
| Cloudflare + your domain | a domain on Cloudflare | your own Worker | designed |

```sh
flue relay setup     # paste a Cloudflare API token, watch it deploy, done
```

That deploys the relay Worker **and** the web app into your own Cloudflare
account, sets a fresh daemon secret, and points the daemon at it. The token is
never stored. What it deploys, what it costs, what bounds abuse, and the
counters it leaves behind are in [docs/RELAY.md](docs/RELAY.md).

Anything through an intermediary is end-to-end encrypted (Noise IK, the
daemon's key pinned at pairing), so the relay forwards ciphertext it holds no
key for and cannot read your shell **out of what crosses it**. That qualifier is
load-bearing, not throat-clearing — the browser loads its JavaScript from the
relay's origin, and no amount of end-to-end encryption fixes that. What a
hostile origin could actually do with it is spelled out plainly in the
[FAQ](docs/faq.md), along with the bundle digest you can recompute from this
source and exactly what it does and does not prove today.

### The flue.sh path

The hosted option, for when deploying a Worker is not the part you wanted to
do. It is two Cloudflare Workers and a database: a control plane holding
accounts, invites and a directory of your machines, and a relay that bridges a
browser tab to one of them. Same daemon, same web app, same protocol —
terminal traffic across it is the same Noise ciphertext, and the hosted relay
holds no key for it either.

**It is built and not yet open.** The whole of it is in this repository (`app/`
is the control plane, `relay/` the relay) and it is deployable today, but email
delivery is still a placeholder, no invites have gone out, and it has not been
through its manual end-to-end gate — the same caveat the self-hosted relay
carries. The operator runbook, for us or for anyone who would rather run the
hosted stack themselves, is [docs/SAAS.md](docs/SAAS.md).

What it is, once it opens — four steps, and no configuration on any machine:

```sh
# 1. sign in at app.flue.sh with your invite; a login code arrives by email
# 2. on each machine you want to reach:
flue link
# 3. type the short code it prints into app.flue.sh and approve the machine
# 4. open a session on any of them from the directory — that is the terminal
```

What you trade for not deploying anything is the origin that serves your
browser its JavaScript. That is the one thing end-to-end encryption does not
fix, and it is no better for being our origin: on flue.sh the page that holds
your keys and decrypts your terminal is served by us. The [FAQ](docs/faq.md)
says so plainly rather than in a footnote, which is also why self-hosting comes
first in this README. No billing, either — there is nothing to pay for and
nothing that takes a card.

## Building from source

```sh
mise install   # go, node, pnpm — pinned in mise.toml
make build     # builds the web UI and the relay Worker, embeds both, produces bin/flue
make test
```

`cd web && pnpm hash` prints a SHA-256 over every file in `web/dist`, so you can
check for yourself that this source builds to that bundle — same source, same
lockfile, same pinned toolchain, same digest, *on the same platform*. No release
publishes a digest to compare a served bundle against yet; the
[FAQ](docs/faq.md) has both halves of that, along with why the cross-platform
caveat is real.

## Developing

Development never builds the web app — hot reload owns it:

```sh
make run       # terminal 1: the daemon on 127.0.0.1:7717, no web build
make web-dev   # terminal 2: Vite with hot reload on 127.0.0.1:5173
```

`make run` compiles with the `dev` build tag, which swaps the embedded UI
for a redirect to Vite (`web/dev.go`) and the embedded relay Worker for
nothing at all (`relay/dev.go`) — neither `web/dist` nor `relay/dist` need
exist and Node never runs. (`flue relay setup` refuses to deploy from a dev
build, since it has no Worker to deploy.) It passes `--open`, so the browser
opens itself: the one-time
link plants the auth cookie and lands you on the Vite server, no clicking
race. Vite proxies `/api` and `/ws` back to the daemon and rewrites the
Origin so its checks pass; the cookie rides along because cookies ignore
the port. Stick to `127.0.0.1`, not `localhost`: the cookie is set for that
host exactly. Restarting a lot and tired of tabs? `go run -tags dev
./cmd/flue serve` skips the auto-open; the cookie from the first open keeps
working.

A production-like run — the embedded UI, exactly what a user gets — is:

```sh
make build && bin/flue serve
```

`make test` runs all four suites (Go, the web app, the relay Worker, the
control plane); `make lint` is `go vet` (with
and without the dev tag) plus a TypeScript typecheck of each package. Use pnpm, never npm —
the web workspace pins it, and `mise.toml` pins the exact go/node/pnpm
versions CI uses. One ordering rule remains for untagged Go commands:
nothing compiles until `web/dist` and `relay/dist` both exist (`//go:embed`
in `web/embed.go` and `relay/embed.go`), so a bare `go build ./cmd/flue`
wants `cd web && pnpm build` and `cd relay && pnpm build` first — or just
use `make build`, which sequences all of it for you.

Layout, briefly: `cmd/flue` is the CLI, `internal/daemon` the HTTP/WebSocket
server, `internal/session` the PTYs and scrollback, `internal/service` the
launchd/systemd integration, `web/` the React app, `site/` the flue.sh page,
`relay/` the Cloudflare Worker, `app/` the hosted control plane (its own
package, deployed on its own — nothing embeds it in the binary),
`docs/RELAY.md` the relay runbook, `docs/SAAS.md` the hosted one,
`docs/faq.md` the honest answers, and `docs/FOLLOW-UPS.md` the known rough
edges — worth reading before touching the code.

## License

[MIT](LICENSE)
