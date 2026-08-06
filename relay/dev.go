//go:build dev

// A dev-tagged daemon (`make run`) compiles without relay/dist and without
// Node having run at all — the same trade web/dev.go makes for the UI. The dev
// loop is the local daemon and Vite; deploying a relay is a release-shaped
// action, and requiring an esbuild run before every `make run` would tax the
// inner loop for something it never does.
//
// Production and CI never see this file: the release path is `make build`,
// untagged, which embeds the bundle.
package relaybundle

// Module returns no bundle at all, and `flue relay setup` refuses to deploy
// rather than uploading an empty Worker — see cmd/flue/relay.go, which checks
// this before it so much as asks for an API token.
func Module() []byte { return nil }
