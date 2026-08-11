package main

import (
	"context"
	"io"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"
)

// answer builds a canned api.github.com reply.
func answer(status int, body string) func(context.Context, string, string) (*http.Response, error) {
	return func(context.Context, string, string) (*http.Response, error) {
		return &http.Response{
			StatusCode: status,
			Body:       io.NopCloser(strings.NewReader(body)),
		}, nil
	}
}

const stable = `{"tag_name":"v0.5.0","html_url":"https://github.com/karnstack/flue/releases/tag/v0.5.0"}`

// TestReleaseIsAnsweredFromCacheNotFromTheNetwork is the property the whole
// split exists for: the endpoint sits behind a page load, so the first read
// must return immediately with whatever is known — which on a cold daemon is
// nothing — and leave the asking to a goroutine.
func TestReleaseIsAnsweredFromCacheNotFromTheNetwork(t *testing.T) {
	release := make(chan struct{})
	asked := make(chan struct{}, 1)
	c := newReleaseChecker("0.4.0")
	c.get = func(context.Context, string, string) (*http.Response, error) {
		asked <- struct{}{}
		<-release
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(stable))}, nil
	}

	// Returns while the fetch is still blocked, saying only what it knows.
	got := c.Release(t.Context())
	if got.Latest != "" || got.Update {
		t.Fatalf("cold read reported %+v, want nothing known", got)
	}
	if got.Current != "0.4.0" {
		t.Fatalf("current is %q, want 0.4.0", got.Current)
	}

	<-asked
	close(release)

	waitFor(t, 2*time.Second, "the check to land", func() bool {
		return c.Release(t.Context()).Latest == "0.5.0"
	})
	if got := c.Release(t.Context()); !got.Update || got.URL == "" {
		t.Fatalf("after the check: %+v, want an update and a URL", got)
	}
}

// TestReleaseAsksOnceWhileACheckIsInFlight: a screenful of tabs reloading at
// the same moment is one request to GitHub, not twenty.
func TestReleaseAsksOnceWhileACheckIsInFlight(t *testing.T) {
	release := make(chan struct{})
	var mu sync.Mutex
	calls := 0
	c := newReleaseChecker("0.4.0")
	c.get = func(context.Context, string, string) (*http.Response, error) {
		mu.Lock()
		calls++
		mu.Unlock()
		<-release
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(stable))}, nil
	}

	var wg sync.WaitGroup
	for range 20 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			c.Release(t.Context())
		}()
	}
	// Every read has returned, which is itself the first half of the claim:
	// none of them waited on the fetch that is still blocked below.
	wg.Wait()

	// The refresh runs in a goroutine of its own, so the request the reads
	// started has to be waited for rather than assumed to have happened —
	// asserting straight after wg.Wait() reads a counter that is legitimately
	// still zero.
	waitFor(t, 2*time.Second, "the one check to start", func() bool {
		mu.Lock()
		defer mu.Unlock()
		return calls >= 1
	})
	// And long enough for a second one to have shown up if the guard failed.
	time.Sleep(20 * time.Millisecond)
	close(release)

	mu.Lock()
	defer mu.Unlock()
	if calls != 1 {
		t.Fatalf("asked GitHub %d times for twenty simultaneous reads, want 1", calls)
	}
}

// TestReleaseStampsAFailedCheck pins the choice to stamp the attempt rather
// than the success. A machine that cannot reach GitHub would otherwise be
// permanently stale and would fire a request on every single page load.
func TestReleaseStampsAFailedCheck(t *testing.T) {
	var mu sync.Mutex
	calls := 0
	c := newReleaseChecker("0.4.0")
	c.get = func(context.Context, string, string) (*http.Response, error) {
		mu.Lock()
		calls++
		mu.Unlock()
		return nil, http.ErrHandlerTimeout
	}

	c.Release(t.Context())
	waitFor(t, 2*time.Second, "the first check", func() bool {
		mu.Lock()
		defer mu.Unlock()
		return calls == 1
	})
	// Long enough after the failure for any second attempt to have happened.
	for range 5 {
		c.Release(t.Context())
	}
	time.Sleep(20 * time.Millisecond)

	mu.Lock()
	defer mu.Unlock()
	if calls != 1 {
		t.Fatalf("a daemon that cannot reach GitHub asked %d times, want 1 until the interval is up", calls)
	}
}

// TestReleaseAsksAgainOnceTheIntervalIsUp — the other half of the same rule.
func TestReleaseAsksAgainOnceTheIntervalIsUp(t *testing.T) {
	var mu sync.Mutex
	calls := 0
	now := time.Unix(1_700_000_000, 0)
	c := newReleaseChecker("0.4.0")
	c.now = func() time.Time {
		mu.Lock()
		defer mu.Unlock()
		return now
	}
	c.get = func(context.Context, string, string) (*http.Response, error) {
		mu.Lock()
		calls++
		mu.Unlock()
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(stable))}, nil
	}

	c.Release(t.Context())
	waitFor(t, 2*time.Second, "the first check", func() bool {
		mu.Lock()
		defer mu.Unlock()
		return calls == 1
	})

	mu.Lock()
	now = now.Add(releaseInterval + time.Minute)
	mu.Unlock()

	c.Release(t.Context())
	waitFor(t, 2*time.Second, "the check after the interval", func() bool {
		mu.Lock()
		defer mu.Unlock()
		return calls == 2
	})
}

// TestReleaseReplaysTheETagAndKeepsWhatA304Confirms is what pays for the
// ten-minute interval. GitHub does not charge a conditional request that comes
// back 304 against the sixty-an-hour budget an unauthenticated address gets,
// so the asks between one release and the next cost nothing — but only if the
// etag is actually replayed, and only if the 304 is read as confirmation
// rather than as the empty answer its body literally is.
func TestReleaseReplaysTheETagAndKeepsWhatA304Confirms(t *testing.T) {
	var mu sync.Mutex
	var seen []string // the If-None-Match each ask carried
	now := time.Unix(1_700_000_000, 0)
	c := newReleaseChecker("0.4.0")
	c.now = func() time.Time {
		mu.Lock()
		defer mu.Unlock()
		return now
	}
	c.get = func(_ context.Context, _, etag string) (*http.Response, error) {
		mu.Lock()
		seen = append(seen, etag)
		n := len(seen)
		mu.Unlock()
		if n == 1 {
			return &http.Response{
				StatusCode: 200,
				Header:     http.Header{"Etag": {`W/"tag-v0.5.0"`}},
				Body:       io.NopCloser(strings.NewReader(stable)),
			}, nil
		}
		// What a real 304 is: a status, no body worth reading.
		return &http.Response{
			StatusCode: http.StatusNotModified,
			Header:     http.Header{},
			Body:       io.NopCloser(strings.NewReader("")),
		}, nil
	}

	c.Release(t.Context())
	waitFor(t, 2*time.Second, "the first check", func() bool {
		return c.Release(t.Context()).Latest == "0.5.0"
	})

	mu.Lock()
	now = now.Add(releaseInterval + time.Minute)
	mu.Unlock()

	c.Release(t.Context())
	waitFor(t, 2*time.Second, "the conditional check", func() bool {
		mu.Lock()
		defer mu.Unlock()
		return len(seen) == 2
	})

	mu.Lock()
	asked := append([]string(nil), seen...)
	mu.Unlock()
	if asked[0] != "" {
		t.Fatalf("the first ask carried If-None-Match %q, want none — nothing was held to be conditional about", asked[0])
	}
	if asked[1] != `W/"tag-v0.5.0"` {
		t.Fatalf("the second ask carried If-None-Match %q, want the etag GitHub minted", asked[1])
	}
	if got := c.Release(t.Context()); got.Latest != "0.5.0" || !got.Update || got.URL == "" {
		t.Fatalf("after a 304: %+v, want the answer it confirmed", got)
	}
}

// TestReleaseKeepsAGoodAnswerThroughAFailedCheck. Six asks an hour rather than
// two a day is six chances an hour to meet a refused request or a network that
// blinked, and a daemon runs for weeks. An answer already known must survive
// them: dropping it would take the notice off the sidebar of someone who had
// been looking at it, and put it back on the check after.
func TestReleaseKeepsAGoodAnswerThroughAFailedCheck(t *testing.T) {
	var mu sync.Mutex
	calls := 0
	now := time.Unix(1_700_000_000, 0)
	c := newReleaseChecker("0.4.0")
	c.now = func() time.Time {
		mu.Lock()
		defer mu.Unlock()
		return now
	}
	c.get = func(context.Context, string, string) (*http.Response, error) {
		mu.Lock()
		calls++
		n := calls
		mu.Unlock()
		if n == 1 {
			return &http.Response{
				StatusCode: 200,
				Header:     http.Header{},
				Body:       io.NopCloser(strings.NewReader(stable)),
			}, nil
		}
		return nil, http.ErrHandlerTimeout
	}

	c.Release(t.Context())
	waitFor(t, 2*time.Second, "the first check", func() bool {
		return c.Release(t.Context()).Latest == "0.5.0"
	})

	mu.Lock()
	now = now.Add(releaseInterval + time.Minute)
	mu.Unlock()

	c.Release(t.Context())
	waitFor(t, 2*time.Second, "the failing check", func() bool {
		mu.Lock()
		defer mu.Unlock()
		return calls == 2
	})

	if got := c.Release(t.Context()); got.Latest != "0.5.0" || !got.Update {
		t.Fatalf("after a failed check: %+v, want the last good answer kept", got)
	}
}

// TestReleaseIgnoresWhatItCannotUse: an unreachable, refusing or pre-release
// GitHub all land on the same "nothing known", which is not an error state to
// render — a version nobody could look up is not news.
func TestReleaseIgnoresWhatItCannotUse(t *testing.T) {
	for _, tc := range []struct {
		name string
		get  func(context.Context, string, string) (*http.Response, error)
	}{
		{"rate limited", answer(403, "")},
		{"a draft", answer(200, `{"tag_name":"v9.9.9","draft":true}`)},
		{"a pre-release", answer(200, `{"tag_name":"v9.9.9","prerelease":true}`)},
		{"nonsense", answer(200, `not json`)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c := newReleaseChecker("0.4.0")
			c.get = tc.get
			c.Release(t.Context())
			time.Sleep(20 * time.Millisecond)
			if got := c.Release(t.Context()); got.Latest != "" || got.Update {
				t.Fatalf("reported %+v, want nothing known", got)
			}
		})
	}
}

// TestNewerComparesVersionsRatherThanStrings is the difference between this
// check and the relay's. The relay compares one build against the exact bytes
// it would deploy, so inequality is enough; this compares against whatever the
// world has published, where a build off main is routinely ahead of the newest
// tag and a "dev" build corresponds to no release at all.
func TestNewerComparesVersionsRatherThanStrings(t *testing.T) {
	for _, tc := range []struct {
		latest, current string
		want            bool
	}{
		{"0.5.0", "0.4.9", true},
		{"0.10.0", "0.9.0", true}, // string comparison gets this one backwards
		{"1.0.0", "0.99.99", true},
		{"0.5.0", "0.5.0", false},
		{"0.4.0", "0.5.0", false}, // a build ahead of the tag is not behind it
		{"0.5.0", "dev", false},
		{"0.5.0", "dev-1149aee25f67", false},
		{"", "0.4.0", false},
		{"0.5.0", "", false},
		{"0.5", "0.4.0", false}, // unreadable: conclude nothing
		{"0.5.0-rc.1", "0.5.0", false},
	} {
		if got := newer(tc.latest, tc.current); got != tc.want {
			t.Errorf("newer(%q, %q) = %v, want %v", tc.latest, tc.current, got, tc.want)
		}
	}
}
