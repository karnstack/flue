# flue ships as one binary with the UI *and* the relay Worker compiled into it,
# so almost everything here depends on `web` and `relay`: the `//go:embed`
# directives in web/embed.go and relay/embed.go will not compile until web/dist
# and relay/dist exist, and that is true of `go build`, `go test` and `go vet`
# alike. Encoding the ordering here is what keeps "I only ran go test" from
# meaning "I could not build at all".
#
# Both dist directories are gitignored on purpose and must stay that way — see
# web/embed.go and relay/embed.go.

.PHONY: all web relay build build-e2e run run-release web-dev test test-go test-web test-relay e2e lint clean site-dev site-build site-deploy

all: build

web:
	cd web && pnpm install --frozen-lockfile && pnpm build

# relay/ is a Cloudflare Worker package, bundled by esbuild into a single ESM
# file that relay/embed.go compiles into the flue binary — that is what lets
# `flue relay setup` deploy it with no Node on the user's machine.
relay:
	cd relay && pnpm install --frozen-lockfile && pnpm build

build: web relay
	mkdir -p bin
	go build -o bin/flue ./cmd/flue

# The developer loop: `make run` in one terminal, `make web-dev` in another.
# The dev tag swaps the embedded UI for a redirect to Vite (web/dev.go), so
# no web build happens and web/dist need not exist — hot reload owns the
# frontend. A production-like run is `make build && bin/flue serve`.
#
# The dev daemon deliberately does not share a port or a config directory
# with an installed flue: 7719 instead of 7717, and its token, runtime.json
# and relay.json live under FLUE_DEV_CONFIG so the two daemons never fight
# over runtime.json or each other's relay. The session cookie's name carries
# the port (local.CookieNameFor), so both UIs stay logged in side by side.
# To point other flue commands at the dev daemon, use the same environment:
# XDG_CONFIG_HOME=$(FLUE_DEV_CONFIG) go run -tags dev ./cmd/flue status

FLUE_DEV_PORT ?= 7719
FLUE_DEV_CONFIG ?= $(HOME)/.config/flue-dev

run:
	XDG_CONFIG_HOME=$(FLUE_DEV_CONFIG) go run -tags dev ./cmd/flue serve --open --port $(FLUE_DEV_PORT)

# The relay-capable dev daemon: a release binary (embeds the Worker and the
# web app, so it can deploy) on the same dev port and config as `make run`.
# Slower to start — it runs both node builds — and `make web-dev` still
# proxies to it, so UI hot reload keeps working on top of it.
run-release: build
	XDG_CONFIG_HOME=$(FLUE_DEV_CONFIG) bin/flue serve --open --port $(FLUE_DEV_PORT)

web-dev:
	cd web && pnpm install --frozen-lockfile && FLUE_PORT=$(FLUE_DEV_PORT) pnpm dev

test: test-go test-web test-relay

test-go: web relay
	go test ./...

test-web:
	cd web && pnpm test

test-relay: relay
	cd relay && pnpm test

# The end-to-end suite: the real relay Worker under `wrangler dev`, two real
# daemons, and the browser's own modules driving them (web/e2e). It is not part
# of `make test` and not in CI — it wants workerd, three free ports and openssl,
# and a gate that is occasionally red for none of those reasons is worse than no
# gate. Run it when the fleet, the relay or the pairing path changed.
#
# `bin/flue-e2e` is the same binary as `bin/flue` plus cmd/flue/e2etrust.go,
# which is behind `-tags e2e` and adds one root certificate authority — the one
# the harness mints for its own relay — because `flue relay join` refuses a
# ws:// address and macOS ignores SSL_CERT_FILE. No release build carries it.
build-e2e: web relay
	mkdir -p bin
	go build -tags e2e -o bin/flue-e2e ./cmd/flue

e2e: build-e2e
	cd web && pnpm install --frozen-lockfile && pnpm run e2e

lint: web relay
	go vet ./...
	# The dev-tagged build (make run) has no CI job of its own; vetting it
	# here is what keeps web/dev.go from drifting out of compilability.
	go vet -tags dev ./...
	cd web && pnpm lint
	cd relay && pnpm lint

clean:
	rm -rf bin web/dist relay/dist

# The landing site (site/) is a TanStack Start app, prerendered to static
# HTML at build time; wrangler serves dist/client and worker/index.ts only
# folds www onto the apex. install.sh's canonical source is
# scripts/install.sh (the release infra owns it), and site/public/install.sh
# is a deploy-time copy, gitignored, so the installer cannot drift between
# two committed copies.
#
# site-dev runs vite, not wrangler: the Worker has no behaviour worth
# exercising in the loop, and vite gives HMR. Use `pnpm --dir site preview`
# against a real build when the Worker itself is the thing under test.

site-dev:
	@if [ -f scripts/install.sh ]; then cp scripts/install.sh site/public/install.sh; fi
	cd site && pnpm install && pnpm dev

site-build:
	@# Build before lint: tsc needs routeTree.gen.ts, which only the router's
	@# vite plugin writes — a fresh checkout has no copy for lint to lean on.
	cd site && pnpm install && pnpm build && pnpm run lint

site-deploy: site-build
	@test -f scripts/install.sh || { \
		echo "site-deploy: scripts/install.sh not found — the infra lane creates it;" >&2; \
		echo "refusing to deploy flue.sh without the installer it advertises" >&2; \
		exit 1; }
	@# After the build, so vite's clean of dist/ cannot take the copy with it.
	cp scripts/install.sh site/dist/client/install.sh
	cd site && pnpm exec wrangler deploy
