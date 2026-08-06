# flue ships as one binary with the UI compiled into it, so almost everything
# here depends on `web`: `//go:embed all:dist` in web/embed.go will not compile
# until web/dist exists, and that is true of `go build`, `go test` and `go vet`
# alike. Encoding the ordering here is what keeps "I only ran go test" from
# meaning "I could not build at all".
#
# web/dist is gitignored on purpose and must stay that way — see web/embed.go.

.PHONY: all web relay build run web-dev test test-go test-web test-relay lint clean site-dev site-deploy

all: build

web:
	cd web && pnpm install --frozen-lockfile && pnpm build

# relay/ is a standalone Cloudflare Worker package: nothing embeds it, so its
# tests and lint only need deps installed — no build step.
relay:
	cd relay && pnpm install --frozen-lockfile

build: web
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

test: test-go test-web test-relay

test-go: web
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
	rm -rf bin web/dist

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
