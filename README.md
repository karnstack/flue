<h1 align="center">flue</h1>

<p align="center"><strong>Your terminal, as a browser tab. Reachable from any device you own.</strong></p>

<p align="center">
  <a href="https://github.com/karnstack/flue/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/karnstack/flue/ci.yml?branch=main&label=ci" alt="CI status"></a>
  <a href="https://github.com/karnstack/flue/releases/latest"><img src="https://img.shields.io/github/v/release/karnstack/flue?label=release" alt="Latest release"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT license"></a>
</p>

<p align="center">
  <a href="https://flue.sh">flue.sh</a> ·
  <a href="docs/RELAY.md">relay runbook</a> ·
  <a href="docs/faq.md">faq</a>
</p>

> Status: the local terminal works, and `flue enable` installs the login
> service. Pairing works over `local` — pair a second device from the UI, see
> it listed, revoke it — and the end-to-end crypto it pins is in place. The
> Cloudflare relay is built: `flue relay setup` deploys it to your own
> account, `flue relay join` points your other machines at the same Worker,
> and each daemon dials its own slot on it. It has not yet been through its
> manual end-to-end gate against a real account
> ([docs/RELAY.md](docs/RELAY.md)), so treat it as ready to try rather than
> ready to rely on. Tailscale is still designed, not built. No release is
> tagged yet — the pipeline is live, and the first tag ships binaries, a brew
> formula, and the installer.
>
> flue is open source and always free. There is no hosted service and none is
> planned: remote access runs through a Worker you deploy into your own
> Cloudflare account, and flue.sh is a landing page with instructions.

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
flue relay join   # point this machine at a relay another machine deployed
```

## Remote access

Remote access is opt-in and provider-agnostic. flue has no preferred option;
the UI orders them by what you already have.

| provider | what it needs | intermediary | state |
|---|---|---|---|
| local | nothing, always on | none | works |
| Cloudflare | a Cloudflare account, free tier is enough | your own Worker, ciphertext only | works — `flue relay setup` |
| Tailscale | Tailscale on each device | none, often direct peer-to-peer | designed |
| Cloudflare + your domain | a domain on Cloudflare | your own Worker | designed |

One relay fronts every machine you own, and only the first machine ever
touches the Cloudflare API:

```sh
flue relay setup     # machine 1: paste a Cloudflare API token, watch it deploy, done
```

That deploys the relay Worker **and** the web app into your own Cloudflare
account, sets a fresh daemon secret, joins this machine under a machine id of
its own, and ends by printing one line. Run that line on every other machine:

```sh
flue relay join wss://<your-relay> --secret <...>     # printed by setup, verbatim
```

`join` needs no token and deploys nothing — the Worker already exists and the
secret is the whole credential. It mints the machine an id of its own and
points its daemon at its own slot on the same Worker. Opening the relay's one
URL opens the machine this browser has paired — or a picker, once it has
paired several; pairing is per machine, once per browser, from the QR each
machine shows. The token is
never stored. What it deploys, what it costs, what bounds abuse, what one
shared secret does and does not separate, and the counters it leaves behind
are in [docs/RELAY.md](docs/RELAY.md).

Anything through an intermediary is end-to-end encrypted (Noise IK, the
daemon's key pinned at pairing), so the relay forwards ciphertext it holds no
key for and cannot read your shell **out of what crosses it**. That qualifier is
load-bearing, not throat-clearing — the browser loads its JavaScript from the
relay's origin, and no amount of end-to-end encryption fixes that. What a
hostile origin could actually do with it is spelled out plainly in the
[FAQ](docs/faq.md), along with the bundle digest you can recompute from this
source and exactly what it does and does not prove today.

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

`make test` runs all three suites (Go, the web app, the relay Worker);
`make lint` is `go vet` (with and without the dev tag) plus a TypeScript
typecheck of each package. Use pnpm, never npm —
the web workspace pins it, and `mise.toml` pins the exact go/node/pnpm
versions CI uses. One ordering rule remains for untagged Go commands:
nothing compiles until `web/dist` and `relay/dist` both exist (`//go:embed`
in `web/embed.go` and `relay/embed.go`), so a bare `go build ./cmd/flue`
wants `cd web && pnpm build` and `cd relay && pnpm build` first — or just
use `make build`, which sequences all of it for you.

Layout, briefly: `cmd/flue` is the CLI, `internal/daemon` the HTTP/WebSocket
server, `internal/session` the PTYs and scrollback, `internal/service` the
launchd/systemd integration, `web/` the React app, `site/` the flue.sh page,
`relay/` the Cloudflare Worker, `docs/RELAY.md` the relay runbook,
`docs/faq.md` the honest answers, and `docs/FOLLOW-UPS.md` the known rough
edges — worth reading before touching the code.

## License

[MIT](LICENSE)
