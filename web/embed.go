//go:build !dev

// Package web serves the built flue UI from the daemon binary, so there is
// no runtime dependency on Node or on any files beside the executable.
//
// The directory this package lives in is also the web app's source tree. The
// Go files here are this one and its `dev`-tagged counterpart; everything
// else is Vite's input and output.
package web

import (
	"bytes"
	"embed"
	"io/fs"
	"net/http"
	"path"
	"strings"
	"time"
)

// dist is the built app. `all:` is deliberate: it keeps files whose names
// begin with "." or "_" — which the bare form drops — so a bundler that ever
// emits one does not silently ship an app missing a file.
//
// The build fails outright when web/dist is absent, which is the intended
// ordering: `make build` runs `make web` first. dist is gitignored and must
// stay that way; a committed build output would be scanned by Tailwind on the
// next build and is the exact staleness web/src/styles.build.test.ts guards
// against.
//
//go:embed all:dist
var dist embed.FS

// assetPrefix is where Vite emits content-hashed build output.
const assetPrefix = "assets/"

// shellName is the app shell. The name is passed to http.ServeContent, which
// derives Content-Type from its extension — and that Content-Type is
// load-bearing: the service worker refuses to cache a navigation response as
// the shell unless it is text/html, which is what makes the offline load work.
const shellName = "index.html"

// contentTypes overrides what http.FileServer would otherwise derive from the
// file extension.
//
// Go's mime table has no entry for .webmanifest, so the manifest would go out
// as text/plain — which today's Chromium still parses (verified: an installed
// daemon answers Page.getAppManifest with no errors and getInstallabilityErrors
// empty), but which is not what the spec says a manifest is, and "the browser
// is lenient about it" is not a property to build installability on. The dev
// server already sets this type by hand in vite.config.ts; this is the same
// answer from the daemon.
//
// Set on the ResponseWriter before dispatching, because http.ServeContent uses
// an already-present Content-Type in preference to sniffing or the extension.
var contentTypes = map[string]string{
	"manifest.webmanifest": "application/manifest+json",
}

// Dist is the built app as a filesystem rooted where the app is served from:
// index.html at the top, not under a "dist/" prefix.
//
// It is exported for `flue relay setup`, which uploads these exact files to the
// user's own Cloudflare account as the relay's static assets. Same build, same
// bytes, one app — a relay serving a UI assembled some other way would be a
// second frontend to keep in step with the daemon's wire protocol.
func Dist() (fs.FS, error) {
	return fs.Sub(dist, "dist")
}

// Handler serves the built app. Unknown paths fall back to index.html so
// client-side routes such as /d/local/s/<id> resolve — a bookmarked session
// tab must open, not 404.
func Handler() http.Handler {
	sub, err := Dist()
	if err != nil {
		return brokenBuild("flue: UI not built; run `make web`")
	}
	shell, err := fs.ReadFile(sub, shellName)
	if err != nil {
		// Unreachable from a real build — //go:embed all:dist fails to compile
		// without the directory, and Vite always emits index.html into it — but
		// a daemon serving a directory listing of its own asset folder because
		// the shell went missing is a worse way to find that out.
		return brokenBuild("flue: UI not built; run `make web`")
	}
	fileServer := http.FileServer(http.FS(sub))

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		name := path.Clean(strings.TrimPrefix(r.URL.Path, "/"))
		if name == "." {
			name = shellName
		}
		// Directories are not served. http.FileServer would answer one with a
		// generated listing of the build output, and neither /assets nor
		// /icons is a page anybody asked for.
		if info, err := fs.Stat(sub, name); err == nil && !info.IsDir() {
			if ct, ok := contentTypes[name]; ok {
				w.Header().Set("Content-Type", ct)
			}
			fileServer.ServeHTTP(w, r)
			return
		}

		// A missing hash-stamped asset is a 404, never the shell. The service
		// worker caches /assets/* cache-first, so answering a missing bundle
		// with 200 text/html would put the shell in the cache under a .js URL
		// and keep serving it there — an error that outlives the request that
		// caused it. A stale shell asking for a bundle that no longer exists is
		// exactly the case, and it wants a clean failure.
		if strings.HasPrefix(name, assetPrefix) {
			http.NotFound(w, r)
			return
		}

		// Everything else is a client-side route. Served from memory rather
		// than by rewriting the request into the file server, so the response
		// cannot pick up a Content-Type from the URL's extension: /d/local/s/x
		// has none, but a session id ending in ".css" would otherwise decide
		// what the shell claims to be.
		//
		// The zero modtime tells ServeContent to emit no Last-Modified, so
		// nothing revalidates against a timestamp embed.FS does not have.
		http.ServeContent(w, r, shellName, time.Time{}, bytes.NewReader(shell))
	})
}

func brokenBuild(msg string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, msg, http.StatusInternalServerError)
	})
}
