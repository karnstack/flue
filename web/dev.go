//go:build dev

// A dev-tagged daemon (`make run`) compiles without web/dist and without
// Node having run at all: every UI path answers with a redirect to the Vite
// dev server, which owns the app and its hot reloading. /api and /ws are
// untouched — Vite proxies them back to this daemon — and the auth flow
// still works, because the one-time URL's handoff exchange happens in the
// middleware before this handler runs, and the cookie it sets is for the
// host, which ignores the port.
//
// Production and CI never see this file: the release path is `make build`,
// untagged, which embeds dist.
package web

import (
	"errors"
	"io/fs"
	"net/http"
	"os"
)

// devOrigin is where `make web-dev` serves the app. FLUE_WEB_DEV overrides
// it when Vite is on a non-default port.
func devOrigin() string {
	if o := os.Getenv("FLUE_WEB_DEV"); o != "" {
		return o
	}
	return "http://127.0.0.1:5173"
}

// Dist reports that there is no built app in this binary. A dev build carries
// none — Vite owns the app — so `flue relay setup` from `make run` has nothing
// to upload, and says so rather than deploying a relay with no UI on it.
func Dist() (fs.FS, error) {
	return nil, errors.New("web: this is a dev build; the UI is not compiled in — build with `make build` and run the release binary")
}

// Handler redirects to the Vite dev server, keeping path and query — ?cwd=
// from `flue open` must survive the hop. 307, not 301: nothing about a dev
// port is permanent, and a cached redirect would outlive the session.
func Handler() http.Handler {
	origin := devOrigin()
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		target := origin + r.URL.Path
		if r.URL.RawQuery != "" {
			target += "?" + r.URL.RawQuery
		}
		http.Redirect(w, r, target, http.StatusTemporaryRedirect)
	})
}
