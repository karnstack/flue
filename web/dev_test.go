//go:build dev

package web

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

// Run with the tag the code needs: go test -tags dev ./web

func TestDevHandlerRedirectsToVite(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/d/local/s/abc?cwd=%2Ftmp", nil)
	rec := httptest.NewRecorder()
	Handler().ServeHTTP(rec, req)

	if rec.Code != http.StatusTemporaryRedirect {
		t.Fatalf("status = %d, want 307", rec.Code)
	}
	want := "http://127.0.0.1:5173/d/local/s/abc?cwd=%2Ftmp"
	if got := rec.Header().Get("Location"); got != want {
		t.Fatalf("Location = %q, want %q", got, want)
	}
}

func TestDevHandlerHonoursTheOriginOverride(t *testing.T) {
	t.Setenv("FLUE_WEB_DEV", "http://127.0.0.1:9999")
	rec := httptest.NewRecorder()
	Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/", nil))

	if got := rec.Header().Get("Location"); got != "http://127.0.0.1:9999/" {
		t.Fatalf("Location = %q, want the FLUE_WEB_DEV origin", got)
	}
}
