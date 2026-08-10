# Developing flue

Everything about working on flue, in one place: the daily loop, how dev and
an installed flue coexist on one machine, and the three ways to work on the
relay. The README covers what flue is; this covers how to change it.

## Prerequisites

```sh
mise install   # go, node, pnpm, pinned in mise.toml
```

Use pnpm, never npm. The web workspace pins it, and CI runs the exact
versions mise installs.

## The daily loop

Two terminals:

```sh
make run       # terminal 1: the dev daemon on 127.0.0.1:7719
make web-dev   # terminal 2: Vite with hot reload on 127.0.0.1:5173
```

`make run` compiles with the `dev` build tag: the embedded UI becomes a
redirect to Vite, the embedded relay Worker is left out entirely, and no
web or relay build is needed. It opens the browser itself via a one-time
link that plants the auth cookie. Stick to `127.0.0.1`, not `localhost`;
the cookie is set for that host exactly.

A production-like run, with the real embedded UI, is:

```sh
make build && bin/flue serve
```

### Dev and an installed flue on one machine

The dev daemon is deliberately kept apart from an installed flue. Nothing
about one can clobber the other:

|              | installed flue        | dev loop (`make run`)      |
|--------------|-----------------------|----------------------------|
| port         | 7717                  | 7719                       |
| config dir   | `~/.config/flue`      | `~/.config/flue-dev`       |
| cookie       | `flue_token_7717`     | `flue_token_7719`          |
| relay worker | `flue-relay`          | `flue-relay-dev` (yours to choose) |

The config dir holds the auth token, `runtime.json` and `relay.json`, so
the separation is what stops the two daemons fighting over discovery and
stops a dev relay join from rewriting the installed relay's config. The
cookie name carries the port because cookies are blind to it; without that,
logging into one UI would log you out of the other.

`FLUE_DEV_PORT` and `FLUE_DEV_CONFIG` in the Makefile move both knobs.

Any flue command aimed at the dev daemon needs the dev environment, or it
talks to the installed one:

```sh
XDG_CONFIG_HOME=~/.config/flue-dev go run -tags dev ./cmd/flue status
```

## Tests and lint

```sh
make test        # all three suites: Go, web, relay Worker
make test-go     # builds web/dist and relay/dist first; //go:embed needs both
make test-web
make test-relay
make lint        # go vet (with and without the dev tag) + typecheck each package
make e2e         # the end-to-end suite; not part of make test, not in CI
```

A bare `go build ./cmd/flue` or `go test ./...` fails until `web/dist` and
`relay/dist` exist. `make build` sequences all of it.

`make e2e` is described under [the end-to-end suite](#4-the-end-to-end-suite-two-daemons-and-a-real-worker)
below. It is deliberately out of `make test` and out of CI: it starts
workerd and two daemons, and a gate that goes red because a port was busy
teaches people to ignore gates.

## Working on the relay

Three tiers. Use the cheapest one that answers your question.

### 1. Unit tests (edit the Worker's code)

```sh
cd relay && pnpm test   # vitest, workers pool, in-memory Durable Object
```

This is the loop for changing `relay/src`. No network, no account.

### 2. A local Worker (protocol work, no Cloudflare account)

```sh
cd relay
echo "DAEMON_SECRET=$(openssl rand -hex 32)" > .dev.vars   # gitignored; never commit
cd ../web && pnpm build
cd ../relay && pnpm dev --assets ../web/dist               # ws://127.0.0.1:8787
```

Generate the secret; do not invent one. The moment a tunnel points at this
Worker it is on the public internet, and the secret is the whole credential
for the daemon leg.

Two things make this tier awkward, both by design elsewhere:

- The web app decides daemon-vs-relay by hostname, and loopback means
  daemon. To see relay mode against a local Worker the browser needs a
  non-loopback name for it: an `/etc/hosts` alias, or a tunnel.
- Quick tunnels (`cloudflared tunnel --url ...`) mint a new hostname every
  run (re-join, re-pair each time) and are sometimes provisioned
  IPv6-only, which a v4-only network cannot reach at all. A named tunnel
  on your own zone avoids both; its config lives in `~/.cloudflared`,
  never in this repo.

The daemon joins a tunnel like any relay:

```sh
XDG_CONFIG_HOME=~/.config/flue-dev go run -tags dev ./cmd/flue relay join \
  wss://<tunnel-host> --secret <the .dev.vars value> \
  --fleet "$(head -c 32 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=')"
```

`--fleet` is required and this tier never runs `flue relay setup`, so there
is no printed line to copy one from — mint it yourself, as above. That works
because the fleet key is just 32 random bytes in unpadded base64url and the
Worker never holds it ([`spec/fleet-trust.md`](../spec/fleet-trust.md)):
nothing at the relay has to agree with the value, only the other machines in
the same dev fleet do. So keep it if you join a second dev machine — two
machines holding different fleet keys will not honour each other's device
certificates — and do not paste in the one a real relay printed.

### 3. A deployed dev relay (using the relay path day to day)

The recommended way to exercise the real thing: deploy a relay into your
own Cloudflare account under a dev name, separate from any relay an
installed flue uses.

```sh
make build
XDG_CONFIG_HOME=~/.config/flue-dev bin/flue relay setup --worker flue-relay-dev
# restart make run; the dev daemon picks up relay.json and dials
```

The Remote screen offers the same deploy as a card (token field, Deploy
button) against the daemon's `/api/relay/*` endpoints, same code, via
`internal/relaydeploy`. Note the dev-loop wrinkle: `make run` is a dev
build, which embeds no Worker (there are no bytes it could deploy) so the
card says it cannot. When you want to deploy from the card (or exercise the
relay path at all):

```sh
make run-release   # build a release binary, run it on the dev port and config
```

`make web-dev` proxies to it the same as to `make run`, so UI hot reload
keeps working; the embedded UI at 127.0.0.1:7719 is the production-like
view of the same daemon.

Then pair a browser: Vite UI → Devices → Pair, open the QR link on the
phone. The link carries the relay's origin, so the phone talks to
`flue-relay-dev.<sub>.workers.dev` and never to your laptop directly.

Notes that save a bad afternoon:

- Setup needs a release binary. A dev build carries no Worker and refuses
  before asking for a token.
- Setup mints the secret itself, 256 bits from `crypto/rand`. There is no
  dev-secret to choose and none to commit.
- Do not re-run setup to update a relay. Every setup run deliberately
  mints a fresh secret and machine id (it is the recovery path), which
  forces every other machine to re-join and every browser to re-pair.
- To ship changed relay or web code to a deployed relay, use:

```sh
make build
XDG_CONFIG_HOME=~/.config/flue-dev bin/flue relay update
```

`update` redeploys the Worker and the web bundle this binary embeds over
the worker `relay.json` records, and changes nothing else: same secret
(the deploy preserves the binding), same machine ids, no re-pairing.
Daemons and browsers reconnect on their own.

The `--worker` name is the whole separation between dev and prod relays:
one account can hold both `flue-relay` (the default an installed flue
deploys) and `flue-relay-dev`, each with its own workers.dev hostname,
secret and hubs. Breaking the dev one cannot touch the real one.

### 4. The end-to-end suite (two daemons and a real Worker)

```sh
make e2e        # ~30 s cold, ~8 s warm; no account, no cost, no cleanup
```

The tier the other three cannot be: two real flue daemons, each with its own
config directory and port, joined to the real relay Worker running under
workerd, driven by the browser's own modules — `fleet/enrol.ts`,
`relay/directory.ts`, `crypto/cert.ts`, `relay/socket.ts`, `fleet/fleet.ts`
— imported from `web/src` and called the way the app calls them. It lives in
[`web/e2e`](../web/e2e); the header comment on `fleet.e2e.ts` says what each
assertion is for.

It exists because every unit suite in this repo stubs the seam between two
components, and the last several bugs all lived in a seam: a fleet key read
at boot on one side and live on the other, a directory route no browser could
reach, a loopback tab with no fleet identity, a certificate published where a
commit message said it no longer was. Each component was right about itself
and wrong about its neighbour.

What it drives, in order: a daemon serving with no relay; that daemon joining
one while it is already running; a browser pairing over the relay's origin; a
second machine joining with nothing else done; and then each machine's own tab
listing the other's sessions, input reaching a shell on the far machine, and a
revoke on one machine killing the device on the other.

Three things it needs, and how it fails if they are missing:

- **`openssl` on `PATH`** — it mints a throwaway certificate for the local
  relay, because `flue relay join` refuses anything but `wss://`/`https://`
  and that refusal is worth keeping. macOS's LibreSSL and Ubuntu's OpenSSL
  both do.
- **Ports 8788, 7791 and 7792 free** — checked up front, so a busy port is
  the first line of the failure rather than a timeout twenty seconds in.
- **`bin/flue-e2e`** — `make e2e` builds it. It is the ordinary binary plus
  `cmd/flue/e2etrust.go`, which is behind `-tags e2e` and adds exactly one
  root certificate authority, the one the harness just minted. No release
  build carries it; `.goreleaser.yaml` sets no tags.

There is no browser in it, and two facts are browser-enforced: CORS and CSP.
Those are asserted as the headers a browser would decide from — the relay's
absent `Access-Control-Allow-Origin` on `GET /directory`, the daemon's
`connect-src` — against live servers rather than fixtures. That pins the input
to the decision and not the decision.

## How users update a deployed relay

The relay Worker and the web bundle are embedded in the flue binary; a
relay's version is the version of the flue that deployed it. There is no
separate relay package, deliberately: a second artifact would reintroduce
the version skew the embedding exists to kill. The upgrade path is:

```sh
brew upgrade flue    # or the installer
flue relay update    # redeploys this release's relay; secret and pairings kept
```

## The release gate

The relay's automated tests all run against fakes. Before any release that
touches the relay, a human walks the end-to-end checklist in
[RELAY.md](RELAY.md): a real account, a phone on cellular, a `kill -9`
recovery, the `/client/<id>` isolation check.
