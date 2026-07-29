package daemon

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/karnstack/flue/web"
)

func TestEmbeddedUIServesIndex(t *testing.T) {
	ts := httptest.NewServer(web.Handler())
	defer ts.Close()

	resp, err := http.Get(ts.URL + "/")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}
	if ct := resp.Header.Get("Content-Type"); !strings.Contains(ct, "text/html") {
		t.Fatalf("Content-Type = %q, want text/html", ct)
	}
}

func TestEmbeddedUIFallsBackForClientRoutes(t *testing.T) {
	// /d/local/s/<id> is a TanStack Router route; the server must return
	// index.html rather than 404, or a bookmarked session tab breaks.
	ts := httptest.NewServer(web.Handler())
	defer ts.Close()

	resp, err := http.Get(ts.URL + "/d/local/s/abc123")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}
	// The Content-Type is load-bearing, and this is the request that can lose
	// it: the fallback is chosen by a URL with no extension for the file server
	// to read one from. Without text/html the service worker declines to cache
	// the navigation as the app shell, and the offline load silently stops
	// working — a failure nobody meets until the daemon is already down.
	if ct := resp.Header.Get("Content-Type"); !strings.Contains(ct, "text/html") {
		t.Fatalf("Content-Type = %q, want text/html", ct)
	}
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("read body: %v", err)
	}
	if !strings.Contains(string(body), `id="root"`) {
		t.Fatalf("fallback body is not the app shell: %.200q", body)
	}
}

// TestEmbeddedUIFallbackIgnoresAnExtensionInAClientRoute pins the reason the
// shell is served from memory rather than by rewriting the request into the
// file server. A session id is an opaque string from the daemon; if one ever
// ends in something http.FileServer reads as an extension, the shell must
// still be announced as HTML.
func TestEmbeddedUIFallbackIgnoresAnExtensionInAClientRoute(t *testing.T) {
	ts := httptest.NewServer(web.Handler())
	defer ts.Close()

	resp, err := http.Get(ts.URL + "/d/local/s/abc.css")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}
	if ct := resp.Header.Get("Content-Type"); !strings.Contains(ct, "text/html") {
		t.Fatalf("Content-Type = %q, want text/html", ct)
	}
}

// TestEmbeddedUIServesHashedAssets is the other half of "the shell loads": the
// document names content-hashed bundles, and a shell served without them is a
// blank page.
func TestEmbeddedUIServesHashedAssets(t *testing.T) {
	ts := httptest.NewServer(web.Handler())
	defer ts.Close()

	resp, err := http.Get(ts.URL + "/")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	body, err := io.ReadAll(resp.Body)
	resp.Body.Close()
	if err != nil {
		t.Fatalf("read shell: %v", err)
	}

	src := scriptSrc(string(body))
	if src == "" {
		t.Fatalf("no module script in the shell: %.400q", body)
	}
	if !strings.HasPrefix(src, "/assets/") {
		t.Fatalf("script src = %q, want a hashed /assets/ path", src)
	}

	assetResp, err := http.Get(ts.URL + src)
	if err != nil {
		t.Fatalf("get %s: %v", src, err)
	}
	defer assetResp.Body.Close()
	if assetResp.StatusCode != http.StatusOK {
		t.Fatalf("GET %s = %d, want 200", src, assetResp.StatusCode)
	}
	if ct := assetResp.Header.Get("Content-Type"); !strings.Contains(ct, "javascript") {
		t.Fatalf("Content-Type for %s = %q, want JavaScript", src, ct)
	}
}

// TestEmbeddedUIRefusesAMissingAsset keeps a missing bundle from being answered
// with the shell. The service worker caches /assets/* cache-first, so a 200
// text/html under a .js URL would be stored and re-served — an error that
// outlives the request that caused it.
func TestEmbeddedUIRefusesAMissingAsset(t *testing.T) {
	ts := httptest.NewServer(web.Handler())
	defer ts.Close()

	resp, err := http.Get(ts.URL + "/assets/index-DEADBEEF.js")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", resp.StatusCode)
	}
}

// TestEmbeddedUIServesTheServiceWorkerAtTheRoot pins the one filename that
// cannot move. A worker's scope is its own directory, so a hashed
// /assets/sw-*.js could only ever control /assets/.
func TestEmbeddedUIServesTheServiceWorkerAtTheRoot(t *testing.T) {
	ts := httptest.NewServer(web.Handler())
	defer ts.Close()

	for _, p := range []string{"/sw.js", "/manifest.webmanifest", "/icons/icon-192.png"} {
		resp, err := http.Get(ts.URL + p)
		if err != nil {
			t.Fatalf("get %s: %v", p, err)
		}
		body, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			t.Errorf("GET %s = %d, want 200", p, resp.StatusCode)
			continue
		}
		if strings.Contains(string(body), `id="root"`) {
			t.Errorf("GET %s fell back to the app shell", p)
		}
	}
}

// TestEmbeddedUIServesTheManifestAsAManifest pins the one Content-Type Go's
// mime table does not know. Chromium parses a text/plain manifest today, so
// nothing visibly breaks without this — which is exactly why it needs a test
// rather than a manual check.
func TestEmbeddedUIServesTheManifestAsAManifest(t *testing.T) {
	ts := httptest.NewServer(web.Handler())
	defer ts.Close()

	resp, err := http.Get(ts.URL + "/manifest.webmanifest")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	defer resp.Body.Close()
	if ct := resp.Header.Get("Content-Type"); ct != "application/manifest+json" {
		t.Fatalf("Content-Type = %q, want application/manifest+json", ct)
	}
}

// TestEmbeddedUIServesNoDirectoryListing keeps http.FileServer's generated
// index out of the surface. Nothing needs it, and it is a page nobody asked
// for sitting on an authenticated origin.
func TestEmbeddedUIServesNoDirectoryListing(t *testing.T) {
	ts := httptest.NewServer(web.Handler())
	defer ts.Close()

	for _, p := range []string{"/assets/", "/icons/"} {
		resp, err := http.Get(ts.URL + p)
		if err != nil {
			t.Fatalf("get %s: %v", p, err)
		}
		body, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		if !strings.Contains(string(body), `id="root"`) {
			t.Errorf("GET %s served %.200q, want the app shell rather than a listing", p, body)
		}
	}
}

// TestEmbeddedUINeverAnswersForTheAPINamespace probes the mounted shape rather
// than web.Handler on its own, because the guard is on the mux: /api is the
// daemon's namespace, and the SPA fallback must not be reachable inside it.
//
// Every path here is one a redirect-laundered navigation would try. None of
// them does anything even when the shell answers — but a surface where an
// invented endpoint replies 200 cannot be asked whether an endpoint exists, and
// TestNoStateChangeIsReachableByGET asks exactly that.
func TestEmbeddedUINeverAnswersForTheAPINamespace(t *testing.T) {
	ts, _ := newTestServerShippedUI(t)

	for _, p := range []string{
		"/api/spawn",
		"/api/spawn?cmd=sh",
		"/api/sessions/abc123/kill",
		"/api/sessions/abc123/resize?cols=1&rows=1",
	} {
		resp := get(t, ts, p, "same-origin")
		body, _ := io.ReadAll(resp.Body)
		if resp.StatusCode != http.StatusNotFound {
			t.Errorf("GET %s = %d, want 404", p, resp.StatusCode)
		}
		if strings.Contains(string(body), `id="root"`) {
			t.Errorf("GET %s answered with the app shell", p)
		}
	}

	// The positive control: the SPA fallback still has to work everywhere else,
	// or this guard has been bought by breaking bookmarked session tabs.
	resp := get(t, ts, "/d/local/s/abc123", "same-origin")
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK || !strings.Contains(string(body), `id="root"`) {
		t.Fatalf("GET /d/local/s/abc123 = %d, body %.200q; want the app shell", resp.StatusCode, body)
	}
}

// scriptSrc pulls the first <script src="..."> out of the shell.
func scriptSrc(html string) string {
	i := strings.Index(html, "<script")
	if i < 0 {
		return ""
	}
	rest := html[i:]
	j := strings.Index(rest, `src="`)
	if j < 0 {
		return ""
	}
	rest = rest[j+len(`src="`):]
	k := strings.Index(rest, `"`)
	if k < 0 {
		return ""
	}
	return rest[:k]
}
