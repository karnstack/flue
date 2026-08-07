# flue ships as one binary with the UI *and* the relay Worker compiled into it,
# so almost everything here depends on `web` and `relay`: the `//go:embed`
# directives in web/embed.go and relay/embed.go will not compile until web/dist
# and relay/dist exist, and that is true of `go build`, `go test` and `go vet`
# alike. Encoding the ordering here is what keeps "I only ran go test" from
# meaning "I could not build at all".
#
# Both dist directories are gitignored on purpose and must stay that way — see
# web/embed.go and relay/embed.go.

.PHONY: all web relay build run run-release web-dev test test-go test-web test-relay lint clean site-dev site-deploy

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

lint: web relay
	go vet ./...
	# The dev-tagged build (make run) has no CI job of its own; vetting it
	# here is what keeps web/dev.go from drifting out of compilability.
	go vet -tags dev ./...
	cd web && pnpm lint
	cd relay && pnpm lint

clean:
	rm -rf bin web/dist relay/dist

# The landing site (site/) has no build step; these targets exist for the
# one moving part: install.sh's canonical source is scripts/install.sh (the
# release infra owns it), and site/public/install.sh is a deploy-time copy,
# gitignored, so the installer cannot drift between two committed copies.

site-dev:
	@if [ -f scripts/install.sh ]; then cp scripts/install.sh site/public/install.sh; fi
	cd site && pnpm dlx wrangler@4 dev

site-deploy:
	@test -f scripts/install.sh || { \
		echo "site-deploy: scripts/install.sh not found — the infra lane creates it;" >&2; \
		echo "refusing to deploy flue.sh without the installer it advertises" >&2; \
		exit 1; }
	cp scripts/install.sh site/public/install.sh
	cd site && pnpm dlx wrangler@4 deploy
