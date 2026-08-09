package main

import (
	"context"
	"encoding/json"
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
// The interval is long because the fact is: releases are days apart, and a
// daemon left running for a week should ask a handful of times, not hundreds.
// Unauthenticated api.github.com allows sixty requests an hour per address —
// this spends two a day, which leaves the budget to whatever else the
// machine's operator is doing.
const (
	releaseAPI      = "https://api.github.com/repos/karnstack/flue/releases/latest"
	releaseInterval = 12 * time.Hour
	releaseTimeout  = 10 * time.Second
)

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
	get func(ctx context.Context, url string) (*http.Response, error)

	mu      sync.Mutex
	latest  string
	url     string
	checked time.Time
	// asking guards against a second refresh while one is in flight — a
	// screenful of tabs reloading at once is one request, not twenty.
	asking bool
}

func newReleaseChecker(current string) *releaseChecker {
	return &releaseChecker{
		current: current,
		now:     time.Now,
		get: func(ctx context.Context, url string) (*http.Response, error) {
			req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
			if err != nil {
				return nil, err
			}
			// The documented media type, and a User-Agent because api.github.com
			// answers 403 to a request without one.
			req.Header.Set("Accept", "application/vnd.github+json")
			req.Header.Set("User-Agent", "flue")
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

	tag, url, err := c.fetch(ctx)

	c.mu.Lock()
	defer c.mu.Unlock()
	c.asking = false
	// The stamp moves on failure too, which is the point of stamping the
	// attempt rather than the success: a machine that cannot reach GitHub
	// would otherwise be permanently stale and would try again on every
	// single page load, forever.
	c.checked = c.now()
	if err != nil {
		return
	}
	c.latest, c.url = tag, url
}

func (c *releaseChecker) fetch(ctx context.Context) (tag, url string, err error) {
	res, err := c.get(ctx, releaseAPI)
	if err != nil {
		return "", "", err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return "", "", fmt.Errorf("github answered %d", res.StatusCode)
	}
	var body struct {
		TagName string `json:"tag_name"`
		HTMLURL string `json:"html_url"`
		Draft   bool   `json:"draft"`
		Pre     bool   `json:"prerelease"`
	}
	if err := json.NewDecoder(res.Body).Decode(&body); err != nil {
		return "", "", err
	}
	if body.Draft || body.Pre {
		return "", "", fmt.Errorf("latest release is not a stable one")
	}
	return strings.TrimPrefix(body.TagName, "v"), body.HTMLURL, nil
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
