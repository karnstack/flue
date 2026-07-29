# flue ships as one binary with the UI compiled into it, so almost everything
# here depends on `web`: `//go:embed all:dist` in web/embed.go will not compile
# until web/dist exists, and that is true of `go build`, `go test` and `go vet`
# alike. Encoding the ordering here is what keeps "I only ran go test" from
# meaning "I could not build at all".
#
# web/dist is gitignored on purpose and must stay that way — see web/embed.go.

.PHONY: all web build test test-go test-web lint clean

all: build

web:
	cd web && pnpm install --frozen-lockfile && pnpm build

build: web
	mkdir -p bin
	go build -o bin/flue ./cmd/flue

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
