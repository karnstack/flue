package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/karnstack/flue/internal/daemon"
)

// Where the newest release is published, and how often to ask.
//
// Ten minutes, and what makes that affordable is the conditional request
// below rather than the number itself. Unauthenticated api.github.com allows
// sixty requests an hour per address, but a request that comes back 304 does
// not count against that budget — so six asks an hour spend nothing at all
// between releases, which is every hour but one.
//
// The interval used to be twelve hours, on the reasoning that releases are
// days apart. That is true of releases and false of the thing a reader
// experiences: a release lands, and the daemon that has already checked today
// says nothing about it until tomorrow. Half a day of a sidebar quietly
// knowing the wrong answer is the cost the old number was actually paying.
const (
	releaseAPI      = "https://api.github.com/repos/karnstack/flue/releases/latest"
	releaseInterval = 10 * time.Minute
	releaseTimeout  = 10 * time.Second
)

// errNotModified is GitHub confirming the cache rather than refusing it: the
// tag has not moved since the ETag was minted. Not a failure — the one
// outcome that means what is already held is right.
var errNotModified = errors.New("release: not modified")

// releaseChecker answers "is there a newer flue?" from a cache it refreshes in
// the background.
//
// The split matters. Release() is behind a page load, so it never touches the
// network: it hands back whatever the last successful check found and starts
// another one if that is old enough. A daemon with no route to GitHub — an
// air-gapped machine, a blocked domain, an outage — therefore costs a reader
// nothing at all: the answer is simply that nothing is known, and a sidebar
// that knows nothing says nothing.
type releaseChecker struct {
	// current is this binary's version, "dev" for a source build.
	current string
	// now and get exist for the tests, which have neither a clock they can
	// wait on nor an internet connection they should depend on.
	now func() time.Time
	get func(ctx context.Context, url, etag string) (*http.Response, error)

	mu      sync.Mutex
	latest  string
	url     string
	checked time.Time
	// etag is what GitHub last labelled this answer with, replayed as
	// If-None-Match so an unchanged tag costs a 304 and no rate-limit budget.
	// Empty until a check has succeeded, which is exactly when there is
	// nothing to be conditional about.
	etag string
	// asking guards against a second refresh while one is in flight — a
	// screenful of tabs reloading at once is one request, not twenty.
	asking bool
}

func newReleaseChecker(current string) *releaseChecker {
	return &releaseChecker{
		current: current,
		now:     time.Now,
		get: func(ctx context.Context, url, etag string) (*http.Response, error) {
			req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
			if err != nil {
				return nil, err
			}
			// The documented media type, and a User-Agent because api.github.com
			// answers 403 to a request without one.
			req.Header.Set("Accept", "application/vnd.github+json")
			req.Header.Set("User-Agent", "flue")
			// What buys the ten-minute interval. Go's transport does no caching
			// of its own, so the 304 arrives here rather than being turned back
			// into the last 200 behind our backs.
			if etag != "" {
				req.Header.Set("If-None-Match", etag)
			}
			return http.DefaultClient.Do(req)
		},
	}
}

// Release implements daemon.ReleaseChecker.
func (c *releaseChecker) Release(ctx context.Context) daemon.ReleaseStatus {
	c.mu.Lock()
	latest, url := c.latest, c.url
	stale := c.now().Sub(c.checked) >= releaseInterval
	start := stale && !c.asking
	if start {
		c.asking = true
	}
	c.mu.Unlock()

	if start {
		// Detached from the request: this answer is for the *next* reader, and
		// a page load must not wait on GitHub to render a sidebar.
		go c.refresh(context.WithoutCancel(ctx))
	}

	return daemon.ReleaseStatus{
		Current: c.current,
		Latest:  latest,
		URL:     url,
		Update:  newer(latest, c.current),
	}
}

func (c *releaseChecker) refresh(ctx context.Context) {
	ctx, cancel := context.WithTimeout(ctx, releaseTimeout)
	defer cancel()

	c.mu.Lock()
	etag := c.etag
	c.mu.Unlock()

	tag, url, fresh, err := c.fetch(ctx, etag)

	c.mu.Lock()
	defer c.mu.Unlock()
	c.asking = false
	// The stamp moves on failure too, which is the point of stamping the
	// attempt rather than the success: a machine that cannot reach GitHub
	// would otherwise be permanently stale and would try again on every
	// single page load, forever.
	c.checked = c.now()
	// A 304 lands here as an error and is none: GitHub has just confirmed
	// what is already held, so the stamp above is the whole of the update.
	// Keeping the etag is what makes the next ask conditional too — dropping
	// it would turn every second check back into a full request.
	if err != nil {
		return
	}
	c.etag = fresh
	c.latest, c.url = strings.TrimPrefix(tag, "v"), url
}

// fetch asks GitHub for the latest stable release. The tag comes back raw —
// leading v and all — because it is the release's address: flue update builds
// download URLs under /releases/download/<tag>/ from it, exactly as
// install.sh does. Callers that want a version to compare or render trim the
// v themselves, as refresh does for the cache.
// etag comes back alongside, to be replayed on the next ask. It is read from
// the response rather than assumed to persist: GitHub is free to mint a new
// one for the same tag, and a client that kept the old one would send a
// condition that never matches again.
func (c *releaseChecker) fetch(ctx context.Context, etag string) (tag, url, fresh string, err error) {
	res, err := c.get(ctx, releaseAPI, etag)
	if err != nil {
		return "", "", "", err
	}
	defer res.Body.Close()
	if res.StatusCode == http.StatusNotModified {
		return "", "", "", errNotModified
	}
	if res.StatusCode != http.StatusOK {
		return "", "", "", fmt.Errorf("github answered %d", res.StatusCode)
	}
	var body struct {
		TagName string `json:"tag_name"`
		HTMLURL string `json:"html_url"`
		Draft   bool   `json:"draft"`
		Pre     bool   `json:"prerelease"`
	}
	if err := json.NewDecoder(res.Body).Decode(&body); err != nil {
		return "", "", "", err
	}
	if body.Draft || body.Pre {
		return "", "", "", fmt.Errorf("latest release is not a stable one")
	}
	return body.TagName, body.HTMLURL, res.Header.Get("ETag"), nil
}

// newer says whether `latest` is a later release than `current`.
//
// Not string inequality, which is what the relay's own update check can afford
// to use — it compares one build against the exact bytes it would deploy. This
// compares against whatever the world has published, and the two ways that
// differs both matter: a "dev" build corresponds to no release and is not
// behind one, and a build off main is routinely *ahead* of the newest tag.
// Both would be told to downgrade by an equality test.
func newer(latest, current string) bool {
	if latest == "" || current == "" || current == "dev" {
		return false
	}
	l, ok := semver(latest)
	if !ok {
		return false
	}
	c, ok := semver(current)
	if !ok {
		return false
	}
	for i := range l {
		if l[i] != c[i] {
			return l[i] > c[i]
		}
	}
	return false
}

// semver reads major.minor.patch, ignoring any -rc.1 or +build suffix. Three
// numbers or nothing: a version this cannot read is one nothing should be
// concluded from.
func semver(v string) ([3]int, bool) {
	var out [3]int
	v, _, _ = strings.Cut(v, "+")
	v, _, _ = strings.Cut(v, "-")
	parts := strings.Split(v, ".")
	if len(parts) != 3 {
		return out, false
	}
	for i, p := range parts {
		n, err := strconv.Atoi(p)
		if err != nil || n < 0 {
			return out, false
		}
		out[i] = n
	}
	return out, true
}
