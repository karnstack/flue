# flue ships as one binary with the UI compiled into it, so almost everything
# here depends on `web`: `//go:embed all:dist` in web/embed.go will not compile
# until web/dist exists, and that is true of `go build`, `go test` and `go vet`
# alike. Encoding the ordering here is what keeps "I only ran go test" from
# meaning "I could not build at all".
#
# web/dist is gitignored on purpose and must stay that way — see web/embed.go.

.PHONY: all web build run web-dev test test-go test-web lint clean site-dev site-deploy

all: build

web:
	cd web && pnpm install --frozen-lockfile && pnpm build

build: web
	mkdir -p bin
	go build -o bin/flue ./cmd/flue

# The developer loop: `make run` in one terminal, `make web-dev` in another.
# `go run` needs web/dist like any other Go build — the web prerequisite
# guarantees it. Iterating on Go only? `go run ./cmd/flue serve` directly
# skips the web rebuild once dist exists.

run: web
	go run ./cmd/flue serve

web-dev:
	cd web && pnpm install --frozen-lockfile && pnpm dev

test: test-go test-web

test-go: web
	go test ./...

test-web:
	cd web && pnpm test

lint: web
	go vet ./...
	cd web && pnpm lint

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
