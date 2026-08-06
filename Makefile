# flue ships as one binary with the UI *and* the relay Worker compiled into it,
# so almost everything here depends on `web` and `relay`: the `//go:embed`
# directives in web/embed.go and relay/embed.go will not compile until web/dist
# and relay/dist exist, and that is true of `go build`, `go test` and `go vet`
# alike. Encoding the ordering here is what keeps "I only ran go test" from
# meaning "I could not build at all".
#
# Both dist directories are gitignored on purpose and must stay that way — see
# web/embed.go and relay/embed.go.

.PHONY: all web relay app build run web-dev test test-go test-web test-relay test-app lint clean site-dev site-deploy

all: build

web:
	cd web && pnpm install --frozen-lockfile && pnpm build

# relay/ is a Cloudflare Worker package, bundled by esbuild into a single ESM
# file that relay/embed.go compiles into the flue binary — that is what lets
# `flue relay setup` deploy it with no Node on the user's machine.
relay:
	cd relay && pnpm install --frozen-lockfile && pnpm build

# app/ is the flue.sh control plane: a TanStack Start app deployed to Workers
# on its own. Nothing embeds it in the flue binary, so `build` does not depend
# on it — but its tests run against the built worker (dist/server), which is
# why test-app depends on this target.
app:
	cd app && pnpm install --frozen-lockfile && pnpm build

build: web relay
	mkdir -p bin
	go build -o bin/flue ./cmd/flue

# The developer loop: `make run` in one terminal, `make web-dev` in another.
# The dev tag swaps the embedded UI for a redirect to Vite (web/dev.go), so
# no web build happens and web/dist need not exist — hot reload owns the
# frontend. A production-like run is `make build && bin/flue serve`.

run:
	go run -tags dev ./cmd/flue serve --open

web-dev:
	cd web && pnpm install --frozen-lockfile && pnpm dev

test: test-go test-web test-relay test-app

test-go: web relay
	go test ./...

test-web:
	cd web && pnpm test

test-relay: relay
	cd relay && pnpm test

test-app: app
	cd app && pnpm test

lint: web relay app
	go vet ./...
	# The dev-tagged build (make run) has no CI job of its own; vetting it
	# here is what keeps web/dev.go from drifting out of compilability.
	go vet -tags dev ./...
	cd web && pnpm lint
	cd relay && pnpm lint
	cd app && pnpm lint

clean:
	rm -rf bin web/dist relay/dist app/dist

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
